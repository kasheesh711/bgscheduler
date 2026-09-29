import { randomUUID } from "node:crypto";
import { and, eq, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
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
export type AlertKind = "held" | "expired" | "no_summary" | "unknown_outcome" | "verify_failed" | "rejected";

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
export async function haltAutowriter(db: Database, reason: string): Promise<void> {
  const next = reason.slice(0, 500);
  await db.update(C).set({
    haltedAt: sql`coalesce(${C.haltedAt}, now())`,
    haltReason: sql`case when ${C.haltedAt} is null or ${C.haltReason} is null then ${next}
      when position(${next} in ${C.haltReason}) > 0 then ${C.haltReason}
      else left(${C.haltReason} || ' | then: ' || ${next}, 2000) end`,
    updatedBy: "system:feedback-autowriter",
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
        wiseTeacherUserId: sql`coalesce(${S.wiseTeacherUserId}, excluded.wise_teacher_user_id)`,
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
 * `pending` (due) or an expired `generating` lease → `generating` with a fresh
 * token. One UPDATE, so concurrent webhook and cron workers cannot both win.
 */
export async function claimGeneration(
  db: Database,
  wiseSessionId: string,
  ttlMs: number,
  options: { ignoreRetryWait?: boolean } = {},
): Promise<string | null> {
  const token = randomUUID();
  // A webhook is new information from Wise, so it may skip the retry wait.
  const pendingDue = options.ignoreRetryWait
    ? eq(S.state, "pending")
    : and(eq(S.state, "pending"), or(isNull(S.nextAttemptAt), lte(S.nextAttemptAt, nowSql)));
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
}): Promise<boolean> {
  const rows = await db.update(S).set({
    state: to.state,
    reason: to.reason ?? null,
    nextAttemptAt: to.retryInMs !== undefined ? plusMs(to.retryInMs) : null,
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

async function anotherPostInFlight(db: Database, wiseSessionId: string): Promise<boolean> {
  const [row] = await db.select({ id: S.id }).from(S)
    .where(and(eq(S.state, "posting"), sql`${S.wiseSessionId} <> ${wiseSessionId}`)).limit(1);
  return Boolean(row);
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
          // One POST in flight at a time; the partial unique index settles a race.
          sql`not exists (select 1 from feedback_autowriter_sessions p where p.state = 'posting')`,
        )).returning({ id: S.id });
      } catch (error) {
        if (isUniqueViolation(error)) return { claimed: false, reason: "post_in_flight" };
        throw error;
      }
      if (rows.length > 0) return { claimed: true };
      return { claimed: false, reason: await anotherPostInFlight(db, wiseSessionId) ? "post_in_flight" : "conditions" };
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
 * Rows the sweep should work on, most urgent deadline first: due `pending`
 * rows, and `generating` rows whose worker died (expired lease) — those are
 * taken over by `claimGeneration`.
 */
export async function listDueRows(db: Database): Promise<AutowriterSessionRow[]> {
  return db.select().from(S).where(or(
    and(eq(S.state, "pending"), or(isNull(S.nextAttemptAt), lte(S.nextAttemptAt, nowSql))),
    and(eq(S.state, "generating"), lte(S.leaseUntil, nowSql)),
  )).orderBy(sql`${S.deadlineAt} asc nulls last`);
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
    or(eq(S.state, "pending"), and(eq(S.state, "generating"), lte(S.leaseUntil, nowSql))),
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
  const rows = await db.update(S).set({ state: "pending", nextAttemptAt: null, updatedAt: nowSql })
    .where(and(eq(S.state, "would_submit"), gte(S.deadlineAt, minDeadline)))
    .returning({ id: S.id });
  return rows.length;
}

/** The autowriter's own recent posts for a tutor — post-class compares new feedback against them. */
export async function recentAutowriterPosts(db: Database, wiseTeacherUserId: string, since: Date): Promise<PriorFeedbackComparison[]> {
  const rows = await db.select({ wiseSessionId: S.wiseSessionId, fields: S.fields }).from(S).where(and(
    eq(S.wiseTeacherUserId, wiseTeacherUserId),
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
