import { randomUUID } from "node:crypto";
import { and, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, notInArray, or, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import type { PriorFeedbackComparison } from "@/lib/post-class-feedback/similarity";
import type { FeedbackFieldAnswers } from "@/lib/post-class-feedback/types";
import type { CallRecord } from "./pipeline";
import type { PostFinishState, SubmitStore } from "./submit";
import type { BillingPlan, ModelArm } from "./types";

const C = schema.feedbackAutowriterControl;
const S = schema.feedbackAutowriterSessions;

export type AutowriterControl = typeof C.$inferSelect;
export type AutowriterSessionRow = typeof S.$inferSelect;
export type AutowriterState = AutowriterSessionRow["state"];
export type AlertKind = "held" | "expired" | "no_summary" | "no_recording" | "unknown_outcome" | "verify_failed" | "rejected";

/** States a session never leaves automatically once reached (except via an owner action). */
export const TERMINAL_STATES: readonly AutowriterState[] = [
  "verified", "held", "skipped_human", "skipped_scope", "expired", "rejected", "unknown_outcome", "verify_failed",
];

const nowSql = sql`now()`;
const plusMs = (ms: number) => sql`now() + (${ms} * interval '1 millisecond')`;

// ---------------------------------------------------------------------------
// Control row
// ---------------------------------------------------------------------------

export async function readControl(db: Database): Promise<AutowriterControl> {
  const [row] = await db.select().from(C).where(eq(C.id, "default")).limit(1);
  if (row) return row;
  await db.insert(C).values({ id: "default", mode: "shadow" }).onConflictDoNothing();
  const [created] = await db.select().from(C).where(eq(C.id, "default")).limit(1);
  if (!created) throw new Error("feedback_autowriter_control row is missing");
  return created;
}

export async function updateControl(
  db: Database,
  patch: Partial<Pick<AutowriterControl, "mode" | "disabledTutors" | "haltedAt" | "haltReason">>,
  actor: string,
): Promise<void> {
  await db.update(C).set({ ...patch, updatedBy: actor, updatedAt: nowSql }).where(eq(C.id, "default"));
}

/**
 * Sets the global halt. The first halt keeps its time; later reasons are
 * appended (bounded) so a manual pause never hides an automatic halt that
 * follows it. Resuming clears everything, so read the full reason first.
 */
export async function haltAutowriter(db: Database, reason: string, actor = "system:feedback-autowriter"): Promise<void> {
  const next = reason.slice(0, 500);
  await db.update(C).set({
    haltedAt: sql`coalesce(${C.haltedAt}, now())`,
    haltReason: sql`case when ${C.haltedAt} is null or ${C.haltReason} is null then ${next}
      when position(${next} in ${C.haltReason}) > 0 then ${C.haltReason}
      else left(${C.haltReason} || ' | then: ' || ${next}, 2000) end`,
    updatedBy: actor,
    updatedAt: nowSql,
  }).where(eq(C.id, "default"));
}

/** Sweep single-flight lease on the control row, on the database clock. */
export async function acquireSweepLease(db: Database, ttlMs: number): Promise<string | null> {
  const token = randomUUID();
  const rows = await db.update(C).set({ leaseToken: token, leaseUntil: plusMs(ttlMs) })
    .where(and(eq(C.id, "default"), or(isNull(C.leaseUntil), lte(C.leaseUntil, nowSql))))
    .returning({ id: C.id });
  return rows.length > 0 ? token : null;
}

export async function releaseSweepLease(db: Database, token: string): Promise<void> {
  await db.update(C).set({ leaseUntil: nowSql }).where(and(eq(C.id, "default"), eq(C.leaseToken, token)));
}

// ---------------------------------------------------------------------------
// Session rows
// ---------------------------------------------------------------------------

export async function ensureSessionRow(db: Database, input: {
  wiseSessionId: string;
  wiseClassId: string | null;
  wiseTeacherUserId: string | null;
  scheduledEndAt: Date | null;
  deadlineAt: Date | null;
  trigger: string;
}): Promise<void> {
  await db.insert(S).values({ ...input, lastTrigger: input.trigger, state: "pending" })
    .onConflictDoUpdate({
      target: S.wiseSessionId,
      set: {
        wiseClassId: sql`coalesce(${S.wiseClassId}, excluded.wise_class_id)`,
        // Follow the latest teacher seen while nothing is in flight for the row;
        // a leased or finished row keeps the teacher it was worked on with.
        wiseTeacherUserId: sql`case when ${S.state} = 'pending' and excluded.wise_teacher_user_id is not null
          then excluded.wise_teacher_user_id else coalesce(${S.wiseTeacherUserId}, excluded.wise_teacher_user_id) end`,
        scheduledEndAt: sql`coalesce(${S.scheduledEndAt}, excluded.scheduled_end_at)`,
        deadlineAt: sql`coalesce(${S.deadlineAt}, excluded.deadline_at)`,
        lastTrigger: input.trigger,
        updatedAt: nowSql,
      },
    });
}

export async function readSessionRow(db: Database, wiseSessionId: string): Promise<AutowriterSessionRow | null> {
  const [row] = await db.select().from(S).where(eq(S.wiseSessionId, wiseSessionId)).limit(1);
  return row ?? null;
}

/**
 * States a worker may pick up when due: `pending` (fast path), and the second
 * pass's `awaiting_recording` / `transcribing` (0098).
 */
export const WAITING_STATES = ["pending", "awaiting_recording", "transcribing"] as const;

/**
 * A due waiting state or an expired `generating` lease → `generating` with a
 * fresh token. One UPDATE, so concurrent webhook and cron workers cannot both win.
 */
export async function claimGeneration(
  db: Database,
  wiseSessionId: string,
  ttlMs: number,
  options: { ignoreRetryWait?: boolean } = {},
): Promise<string | null> {
  const token = randomUUID();
  // A webhook is new information from Wise, so it may skip the retry wait.
  const waiting = inArray(S.state, [...WAITING_STATES]);
  const pendingDue = options.ignoreRetryWait
    ? waiting
    : and(waiting, or(isNull(S.nextAttemptAt), lte(S.nextAttemptAt, nowSql)));
  const rows = await db.update(S).set({ state: "generating", leaseToken: token, leaseUntil: plusMs(ttlMs), updatedAt: nowSql })
    .where(and(eq(S.wiseSessionId, wiseSessionId), or(
      pendingDue,
      and(eq(S.state, "generating"), lte(S.leaseUntil, nowSql)),
    )))
    .returning({ id: S.id });
  return rows.length > 0 ? token : null;
}

/** Leave `generating` (only while holding the lease) for any non-posting state. */
export async function releaseGeneration(db: Database, wiseSessionId: string, token: string, to: {
  state: Exclude<AutowriterState, "generating" | "posting" | "awaiting_event" | "verified">;
  reason?: string | null;
  retryInMs?: number;
  countRetry?: boolean;
  countAttempt?: boolean;
  arm?: ModelArm | null;
  fields?: FeedbackFieldAnswers | null;
  fieldsSha256?: string | null;
  billing?: BillingPlan | null;
  alertKind?: AlertKind | null;
  metadata?: Record<string, unknown>;
  evidence?: "summary" | "transcript";
  sonioxTranscriptionId?: string | null;
}): Promise<boolean> {
  const rows = await db.update(S).set({
    state: to.state,
    reason: to.reason ?? null,
    nextAttemptAt: to.retryInMs !== undefined ? plusMs(to.retryInMs) : null,
    ...(to.evidence !== undefined ? { evidence: to.evidence } : {}),
    ...(to.sonioxTranscriptionId !== undefined ? { sonioxTranscriptionId: to.sonioxTranscriptionId } : {}),
    ...(to.countRetry ? { retryCount: sql`${S.retryCount} + 1` } : {}),
    ...(to.countAttempt ? { attempts: sql`${S.attempts} + 1` } : {}),
    ...(to.arm !== undefined ? { arm: to.arm } : {}),
    ...(to.fields !== undefined ? { fields: to.fields as Record<string, string> | null } : {}),
    ...(to.fieldsSha256 !== undefined ? { fieldsSha256: to.fieldsSha256 } : {}),
    ...(to.billing !== undefined ? { billing: to.billing as Record<string, unknown> | null } : {}),
    metadata: sql`${S.metadata} || ${JSON.stringify({ ...(to.metadata ?? {}), ...(to.alertKind ? { alertKind: to.alertKind } : {}) })}::jsonb`,
    leaseToken: null,
    leaseUntil: null,
    updatedAt: nowSql,
  }).where(and(eq(S.wiseSessionId, wiseSessionId), eq(S.state, "generating"), eq(S.leaseToken, token)))
    .returning({ id: S.id });
  return rows.length > 0;
}

function isUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: unknown; cause?: { code?: unknown } } | null;
  return typeof candidate === "object" && candidate !== null &&
    (candidate.code === "23505" || candidate.cause?.code === "23505");
}

/**
 * States of a POST whose outcome is not settled yet. Only one may exist at a
 * time: `awaiting_event` can still turn into a halt (a save found inside the
 * POST window, or no event for 2 h), so it keeps the lock like `posting` does.
 * The claim's NOT EXISTS enforces it; the partial unique index on `posting`
 * settles two claims racing at the same instant.
 */
export const UNSETTLED_POST_STATES = ["posting", "awaiting_event"] as const;
const unsettledPostSql = sql`p.state in ('posting', 'awaiting_event')`;

/**
 * Why a POST claim updated nothing. When mode, halt, tutor, lease and teacher
 * all hold, the only remaining cause is another unsettled POST.
 */
async function claimRefusalReason(db: Database, wiseSessionId: string, token: string, teacherId: string): Promise<"post_in_flight" | "conditions"> {
  const control = await readControl(db);
  if (control.mode !== "live" || control.haltedAt || control.disabledTutors.includes(teacherId)) return "conditions";
  const [row] = await db.select({ id: S.id }).from(S).where(and(
    eq(S.wiseSessionId, wiseSessionId),
    eq(S.state, "generating"),
    eq(S.leaseToken, token),
    sql`${S.leaseUntil} > now()`,
    eq(S.wiseTeacherUserId, teacherId),
  )).limit(1);
  return row ? "post_in_flight" : "conditions";
}

/**
 * An unsettled POST this old is not a live request any more (the POST phase is
 * bounded by its time-outs): it waits for reads-only reconciliation by the sweep,
 * and blocks every other POST until then.
 */
export async function stuckPostInFlight(db: Database, olderThanMs: number): Promise<boolean> {
  const [row] = await db.select({ id: S.id }).from(S).where(and(
    inArray(S.state, [...UNSETTLED_POST_STATES]),
    sql`${S.postStartedAt} < now() - (${olderThanMs} * interval '1 millisecond')`,
  )).limit(1);
  return Boolean(row);
}

/**
 * Store a shadow draft (`would_submit`) — unless the owner switched to live
 * while it was being written: then the row goes back to `pending`, due now,
 * so the next run posts it (the switch's re-queue has already run by then).
 */
export async function releaseShadowDraft(db: Database, wiseSessionId: string, token: string, draft: {
  arm: ModelArm;
  fields: FeedbackFieldAnswers;
  fieldsSha256: string;
  billing: BillingPlan;
  metadata: Record<string, unknown>;
}): Promise<"would_submit" | "pending" | null> {
  // FOR SHARE: a concurrent switch to live (and its re-queue) waits for this
  // statement, so the draft is either re-queued by it or sent back to pending here.
  const live = sql`(select c.mode from feedback_autowriter_control c where c.id = 'default' for share) = 'live'`;
  const rows = await db.update(S).set({
    state: sql`case when ${live} then 'pending' else 'would_submit' end`,
    reason: sql`case when ${live} then 'mode_switched_to_live' else 'shadow' end`,
    nextAttemptAt: null,
    attempts: sql`${S.attempts} + 1`,
    arm: draft.arm,
    fields: draft.fields as unknown as Record<string, string>,
    fieldsSha256: draft.fieldsSha256,
    billing: draft.billing as unknown as Record<string, unknown>,
    metadata: sql`${S.metadata} || ${JSON.stringify(draft.metadata)}::jsonb`,
    leaseToken: null,
    leaseUntil: null,
    updatedAt: nowSql,
  }).where(and(eq(S.wiseSessionId, wiseSessionId), eq(S.state, "generating"), eq(S.leaseToken, token)))
    .returning({ state: S.state });
  const state = rows[0]?.state;
  return state === "would_submit" || state === "pending" ? state : null;
}

/** The SubmitStore used by `submitFeedbackGuarded` for one leased session. */
export function sessionSubmitStore(
  db: Database,
  wiseSessionId: string,
  token: string,
  claimMetadata: Record<string, unknown> = {},
): SubmitStore {
  return {
    async claimPost(input) {
      let rows: Array<{ id: string }>;
      try {
        rows = await db.update(S).set({
          state: "posting",
          postStartedAt: nowSql,
          bodyHash: input.bodyHash,
          fieldsSha256: input.fieldsSha256,
          fields: input.fields as unknown as Record<string, string>,
          billing: input.billing as unknown as Record<string, unknown>,
          arm: input.arm,
          metadata: sql`${S.metadata} || ${JSON.stringify({ ...claimMetadata, freshReadAt: input.freshReadAt.toISOString() })}::jsonb`,
          updatedAt: nowSql,
        }).where(and(
          eq(S.wiseSessionId, wiseSessionId),
          eq(S.state, "generating"),
          eq(S.leaseToken, token),
          sql`${S.leaseUntil} > now()`,
          // The teacher Wise showed just before the POST must be the stored one, and switched on.
          eq(S.wiseTeacherUserId, input.teacherId),
          sql`exists (select 1 from feedback_autowriter_control c where c.id = 'default' and c.mode = 'live'
            and c.halted_at is null and not (c.disabled_tutors ? ${input.teacherId}))`,
          // One unsettled POST at a time; the partial unique index settles a race.
          sql`not exists (select 1 from feedback_autowriter_sessions p where ${unsettledPostSql})`,
        )).returning({ id: S.id });
      } catch (error) {
        if (isUniqueViolation(error)) return { claimed: false, reason: "post_in_flight" };
        throw error;
      }
      if (rows.length > 0) return { claimed: true };
      return { claimed: false, reason: await claimRefusalReason(db, wiseSessionId, token, input.teacherId) };
    },
    async finish(state: PostFinishState, detail) {
      const alertKind: AlertKind | null = state === "rejected" || state === "unknown_outcome" || state === "verify_failed" ? state : null;
      await db.update(S).set({
        state,
        reason: typeof detail.reason === "string" ? detail.reason : state,
        nextAttemptAt: state === "pending" ? plusMs(10 * 60 * 1000) : null,
        ...(state === "verified" && detail.event ? { verifiedEvent: detail.event as Record<string, unknown> } : {}),
        metadata: sql`${S.metadata} || ${JSON.stringify({ post: detail, ...(alertKind ? { alertKind } : {}) })}::jsonb`,
        leaseToken: null,
        leaseUntil: null,
        updatedAt: nowSql,
      }).where(and(eq(S.wiseSessionId, wiseSessionId), eq(S.state, "posting")));
    },
    async halt(reason) {
      await haltAutowriter(db, reason);
    },
  };
}

/** Move a row out of a post-claim state after a read-only reconciliation. */
export async function reconcilePostedRow(db: Database, wiseSessionId: string, from: "posting" | "awaiting_event", to: {
  state: "awaiting_event" | "verified" | "unknown_outcome" | "verify_failed";
  detail: Record<string, unknown>;
}): Promise<boolean> {
  const alertKind: AlertKind | null = to.state === "unknown_outcome" || to.state === "verify_failed" ? to.state : null;
  const rows = await db.update(S).set({
    state: to.state,
    reason: to.state,
    ...(to.state === "verified" && to.detail.event ? { verifiedEvent: to.detail.event as Record<string, unknown> } : {}),
    metadata: sql`${S.metadata} || ${JSON.stringify({ reconcile: to.detail, ...(alertKind ? { alertKind } : {}) })}::jsonb`,
    updatedAt: nowSql,
  }).where(and(eq(S.wiseSessionId, wiseSessionId), eq(S.state, from))).returning({ id: S.id });
  return rows.length > 0;
}

export async function listRowsInState(db: Database, states: readonly AutowriterState[]): Promise<AutowriterSessionRow[]> {
  return db.select().from(S).where(inArray(S.state, [...states]));
}

/**
 * Rows the sweep should work on, most urgent deadline first: due waiting rows
 * (`pending`, `awaiting_recording`, `transcribing`), and `generating` rows whose
 * worker died (expired lease) — those are taken over by `claimGeneration`.
 */
export async function listDueRows(db: Database): Promise<AutowriterSessionRow[]> {
  return db.select().from(S).where(or(
    and(inArray(S.state, [...WAITING_STATES]), or(isNull(S.nextAttemptAt), lte(S.nextAttemptAt, nowSql))),
    and(eq(S.state, "generating"), lte(S.leaseUntil, nowSql)),
  )).orderBy(sql`${S.deadlineAt} asc nulls last`);
}

/**
 * Persist a submitted Soniox job while holding the lease, so a dead worker's
 * job can be found again. Its submit time bounds how long it may keep running.
 */
export async function setSonioxTranscription(db: Database, wiseSessionId: string, token: string, transcriptionId: string): Promise<boolean> {
  const rows = await db.update(S).set({
    sonioxTranscriptionId: transcriptionId,
    evidence: "transcript",
    // App wall clock, as an ISO string, keyed to the job: the worker only times the job it is polling.
    metadata: sql`${S.metadata} || ${JSON.stringify({ sonioxSubmittedJob: transcriptionId, sonioxSubmittedAt: new Date().toISOString() })}::jsonb`,
    updatedAt: nowSql,
  }).where(and(eq(S.wiseSessionId, wiseSessionId), eq(S.state, "generating"), eq(S.leaseToken, token)))
    .returning({ id: S.id });
  return rows.length > 0;
}

/**
 * Rows done with their Soniox job: finished rows, and shadow drafts (a judged
 * draft is stored; the writer never reads the transcript again). Their job is
 * kept only for review, then deleted by the sweep.
 */
const SONIOX_DONE_STATES: readonly AutowriterState[] = [...TERMINAL_STATES, "would_submit"];

/**
 * Rows done with their Soniox job: those above, and rows past their deadline that were never finished (mode
 * `off` skips the expiry step, so they would otherwise keep their job indefinitely) — never a POST in flight or a
 * row being worked on.
 */
const doneWithSonioxJob = () => and(
  isNotNull(S.sonioxTranscriptionId),
  or(
    inArray(S.state, [...SONIOX_DONE_STATES]),
    and(lt(S.deadlineAt, nowSql), notInArray(S.state, ["posting", "awaiting_event", "generating"])),
  ),
);

/**
 * Start the review window of rows that became done with their Soniox job since the last sweep, however they
 * got there (posted, shadow draft, a hold, an error cap, an expiry): `metadata.sonioxRetainUntil` = now +
 * `retainMs`, on the database clock. Set once; an owner retry clears it, and so does going live for a draft that
 * may transcribe again. Housekeeping only: `updated_at` is left alone.
 */
export async function stampSonioxRetention(db: Database, retainMs: number): Promise<number> {
  const retainSeconds = Math.round(retainMs / 1000);
  const rows = await db.update(S).set({
    metadata: sql`${S.metadata} || jsonb_build_object('sonioxRetainUntil', now() + make_interval(secs => ${retainSeconds}::double precision))`,
  }).where(and(doneWithSonioxJob(), sql`not ${S.metadata} ? 'sonioxRetainUntil'`)).returning({ id: S.id });
  return rows.length;
}

/**
 * Rows done with their Soniox job whose review window is over (`metadata.sonioxRetainUntil`, see above), or that
 * were triaged (`metadata.triagedAt`, stamped or not): the sweep deletes the job.
 */
export async function listSonioxCleanup(db: Database): Promise<Array<{ wiseSessionId: string; sonioxTranscriptionId: string }>> {
  const rows = await db.select({ wiseSessionId: S.wiseSessionId, sonioxTranscriptionId: S.sonioxTranscriptionId })
    .from(S).where(and(
      doneWithSonioxJob(),
      sql`(${S.metadata} ? 'triagedAt' or (${S.metadata} ->> 'sonioxRetainUntil')::timestamptz < now())`,
    ));
  return rows.flatMap((row) => row.sonioxTranscriptionId ? [{ wiseSessionId: row.wiseSessionId, sonioxTranscriptionId: row.sonioxTranscriptionId }] : []);
}

/**
 * Soniox job ids any row still records (the orphan reaper must not touch these): unfinished rows, and finished
 * rows keeping theirs for review — the cleanup above deletes those and clears the id.
 */
export async function activeSonioxJobIds(db: Database): Promise<Set<string>> {
  const rows = await db.select({ id: S.sonioxTranscriptionId }).from(S).where(isNotNull(S.sonioxTranscriptionId));
  return new Set(rows.flatMap((row) => row.id ? [row.id] : []));
}

/** The transcription's cost is recorded once per job, however often its transcript is re-fetched. */
export async function noteSonioxRecorded(db: Database, wiseSessionId: string, transcriptionId: string): Promise<void> {
  await db.update(S).set({
    metadata: sql`${S.metadata} || ${JSON.stringify({ sonioxRecordedJob: transcriptionId })}::jsonb`,
    updatedAt: nowSql,
  }).where(eq(S.wiseSessionId, wiseSessionId));
}

/**
 * Classes still waiting for (or being transcribed from) the recording long
 * after class: raise a `no_recording` alert once, instead of only at the
 * deadline. Not for a switched-off tutor's classes (theirs to write), a
 * recording waiting for its 30-min length recheck (held with its own alert
 * next), a transcript waiting briefly for Zoom's names (it goes ahead on its
 * own), or an infra retry (the recording may well be there).
 */
export async function flagNoRecording(db: Database, endedBefore: Date, disabledTutors: readonly string[] = []): Promise<number> {
  const rows = await db.update(S).set({
    metadata: sql`${S.metadata} || '{"alertKind":"no_recording"}'::jsonb`,
    updatedAt: nowSql,
  }).where(and(
    inArray(S.state, ["awaiting_recording", "transcribing"]),
    lt(S.scheduledEndAt, endedBefore),
    sql`coalesce(${S.reason}, '') not in ('recording_too_short', 'zoom_transcript_pending') and coalesce(${S.reason}, '') not like 'infra:%'`,
    disabledTutors.length > 0
      ? or(isNull(S.wiseTeacherUserId), notInArray(S.wiseTeacherUserId, [...disabledTutors]))
      : undefined,
    sql`not (${S.alertsSent} ? 'no_recording')`,
    sql`coalesce(${S.metadata} ->> 'alertKind', '') <> 'no_recording'`,
  )).returning({ id: S.id });
  return rows.length;
}

export async function clearSonioxTranscription(db: Database, wiseSessionId: string, transcriptionId: string): Promise<void> {
  // Housekeeping: `updated_at` is left alone (the dashboard dates shadow drafts by it).
  await db.update(S).set({
    sonioxTranscriptionId: null,
    metadata: sql`${S.metadata} - 'sonioxSubmittedJob' - 'sonioxSubmittedAt'`,
  }).where(and(eq(S.wiseSessionId, wiseSessionId), eq(S.sonioxTranscriptionId, transcriptionId)));
}

/** Wise now shows a different teacher: record it while holding the generation lease. */
export async function updateLeasedTeacher(db: Database, wiseSessionId: string, token: string, teacherId: string): Promise<boolean> {
  const rows = await db.update(S).set({ wiseTeacherUserId: teacherId, updatedAt: nowSql })
    .where(and(eq(S.wiseSessionId, wiseSessionId), eq(S.state, "generating"), eq(S.leaseToken, token)))
    .returning({ id: S.id });
  return rows.length > 0;
}

/**
 * Rows that can no longer land before their deadline (pending, or generating
 * with a dead worker). A switched-off tutor's class is theirs again (no
 * alert); everyone else's needs a person before the deadline (alert).
 */
export async function expireOverdueRows(db: Database, input: {
  cutoff: Date;
  disabledTutors: readonly string[];
}): Promise<{ expired: number; handedBack: number }> {
  const overdue = and(
    or(inArray(S.state, [...WAITING_STATES]), and(eq(S.state, "generating"), lte(S.leaseUntil, nowSql))),
    lt(S.deadlineAt, input.cutoff),
  );
  const off = input.disabledTutors.length > 0 ? inArray(S.wiseTeacherUserId, [...input.disabledTutors]) : sql`false`;
  const handedBack = await db.update(S).set({
    state: "skipped_scope", reason: "tutor_off_at_deadline", leaseToken: null, leaseUntil: null, updatedAt: nowSql,
  }).where(and(overdue, off)).returning({ id: S.id });
  const expired = await db.update(S).set({
    state: "expired",
    reason: "deadline_passed_or_too_close",
    leaseToken: null,
    leaseUntil: null,
    metadata: sql`${S.metadata} || '{"alertKind":"expired"}'::jsonb`,
    updatedAt: nowSql,
  }).where(overdue).returning({ id: S.id });
  return { expired: expired.length, handedBack: handedBack.length };
}

/** Shadow drafts become eligible again when the owner switches to live. */
export async function requeueShadowDrafts(db: Database, minDeadline: Date): Promise<number> {
  // Back to work. A judged transcript draft is posted as it is, never re-read: its transcript's review window
  // keeps running. Any other draft may transcribe again, so its window starts again when it is next done.
  const rows = await db.update(S).set({
    state: "pending",
    nextAttemptAt: null,
    metadata: sql`case when ${S.metadata} ->> 'draftEvidence' = 'transcript' and ${S.metadata} -> 'judge' ->> 'faithful' = 'true'
      then ${S.metadata} - 'triagedAt' else ${S.metadata} - 'sonioxRetainUntil' - 'triagedAt' end`,
    updatedAt: nowSql,
  })
    .where(and(eq(S.state, "would_submit"), gte(S.deadlineAt, minDeadline)))
    .returning({ id: S.id });
  return rows.length;
}

/**
 * Owner retry of a `held`, `expired` or `skipped_scope` class (e.g. after a
 * prompt fix, or a scope check that was wrong for it): back to `pending`, due
 * now. Its alert is re-armed, so a new hold or expiry emails again. Never a
 * class a person wrote (`skipped_human`) or anything posted; refused when the
 * deadline is inside the margin.
 */
export async function retryHeldSession(db: Database, wiseSessionId: string, input: {
  minDeadline: Date;
  actor: string;
}): Promise<boolean> {
  const rows = await db.update(S).set({
    state: "pending",
    reason: "retry_requested",
    nextAttemptAt: null,
    leaseToken: null,
    leaseUntil: null,
    // A retry starts again on the fast path; it may still hand over to the transcript pass.
    evidence: "summary",
    // A clean slate: no stale alert, error count, coverage recheck, judged draft (nor its stamp) or review
    // window carries over (a kept Soniox job, and its submit time, may be re-used).
    metadata: sql`(${S.metadata} - 'alertKind' - 'transcribeErrors' - 'genericErrors' - 'recordingShortSeenAt' - 'judge' - 'draftEvidence'
      - 'pipeline' - 'transcript' - 'handover' - 'sonioxRetainUntil' - 'triagedAt')
      || ${JSON.stringify({ retriedBy: input.actor })}::jsonb
      || jsonb_build_object('retriedAt', now()::text, 'retriedFrom', ${S.state}::text)`,
    alertsSent: sql`${S.alertsSent} - 'held' - 'expired'`,
    updatedAt: nowSql,
  }).where(and(
    eq(S.wiseSessionId, wiseSessionId),
    inArray(S.state, ["held", "expired", "skipped_scope"]),
    gt(S.deadlineAt, input.minDeadline),
  )).returning({ id: S.id });
  return rows.length > 0;
}

/** The autowriter's own recent posts for a tutor (all their accounts) — post-class compares new feedback against them. */
export async function recentAutowriterPosts(db: Database, wiseTeacherUserIds: readonly string[], since: Date): Promise<PriorFeedbackComparison[]> {
  if (wiseTeacherUserIds.length === 0) return [];
  const rows = await db.select({ wiseSessionId: S.wiseSessionId, fields: S.fields }).from(S).where(and(
    inArray(S.wiseTeacherUserId, [...wiseTeacherUserIds]),
    inArray(S.state, ["posting", "awaiting_event", "verified"]),
    isNotNull(S.fields),
    gte(S.updatedAt, since),
  ));
  return rows.map((row) => ({ key: row.wiseSessionId, fields: row.fields as Partial<FeedbackFieldAnswers> }));
}

// ---------------------------------------------------------------------------
// Calls and alerts
// ---------------------------------------------------------------------------

export async function recordCall(db: Database, record: CallRecord): Promise<void> {
  const usage = record.call.usage;
  await db.insert(schema.feedbackAutowriterCalls).values({
    wiseSessionId: record.wiseSessionId,
    role: record.role,
    arm: record.arm,
    requestedModel: record.requestedModel,
    resolvedModel: record.call.model,
    provider: record.call.provider,
    ok: record.call.ok,
    error: record.call.ok ? null : record.call.error.slice(0, 300),
    finishReason: record.call.finishReason,
    promptTokens: usage?.promptTokens ?? null,
    completionTokens: usage?.completionTokens ?? null,
    reasoningTokens: usage?.reasoningTokens ?? null,
    cachedTokens: usage?.cachedTokens ?? null,
    costUsd: usage?.costUsd !== null && usage?.costUsd !== undefined ? usage.costUsd.toFixed(8) : null,
    latencyMs: record.call.latencyMs,
    result: record.result,
    promptVersion: record.promptVersion,
  });
}

/** One Soniox transcription as a billed call (role `transcriber`, list-price cost). */
export async function recordTranscriptionCall(db: Database, input: {
  wiseSessionId: string;
  ok: boolean;
  audioDurationMs: number | null;
  latencyMs: number;
  costUsd: number | null;
  error?: string | null;
  result?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(schema.feedbackAutowriterCalls).values({
    wiseSessionId: input.wiseSessionId,
    role: "transcriber",
    arm: "soniox",
    requestedModel: "stt-async-v5",
    resolvedModel: "stt-async-v5",
    provider: "Soniox",
    ok: input.ok,
    error: input.error ? input.error.slice(0, 300) : null,
    costUsd: input.costUsd !== null ? input.costUsd.toFixed(8) : null,
    latencyMs: input.latencyMs,
    result: { audioDurationMs: input.audioDurationMs, ...(input.result ?? {}) },
    promptVersion: 0,
  });
}

export interface PendingAlert {
  id: string;
  wiseSessionId: string;
  wiseClassId: string | null;
  wiseTeacherUserId: string | null;
  kind: AlertKind;
  state: AutowriterState;
  reason: string | null;
  deadlineAt: Date | null;
}

/** Rows asking for an alert kind they have not been alerted for yet. */
export async function listPendingAlerts(db: Database): Promise<PendingAlert[]> {
  const rows = await db.select({
    id: S.id,
    wiseSessionId: S.wiseSessionId,
    wiseClassId: S.wiseClassId,
    wiseTeacherUserId: S.wiseTeacherUserId,
    kind: sql<string>`${S.metadata} ->> 'alertKind'`,
    state: S.state,
    reason: S.reason,
    deadlineAt: S.deadlineAt,
  }).from(S).where(and(
    sql`${S.metadata} ? 'alertKind'`,
    sql`not (${S.alertsSent} ? (${S.metadata} ->> 'alertKind'))`,
  ));
  return rows.map((row) => ({ ...row, kind: row.kind as AlertKind }));
}

/**
 * Record alerts as handled so they are never listed again. `note` replaces
 * the send time, e.g. `suppressed:shadow` for alerts deliberately not emailed.
 */
export async function markAlertsSent(db: Database, alerts: readonly PendingAlert[], note?: string): Promise<void> {
  for (const alert of alerts) {
    await db.update(S).set({
      alertsSent: note
        ? sql`${S.alertsSent} || jsonb_build_object(${alert.kind}::text, ${note}::text)`
        : sql`${S.alertsSent} || jsonb_build_object(${alert.kind}::text, now()::text)`,
      updatedAt: nowSql,
    }).where(eq(S.id, alert.id));
  }
}
