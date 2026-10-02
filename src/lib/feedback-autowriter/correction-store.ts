import { and, asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import { POST_CLASS_FEEDBACK_FIELDS, type FeedbackFieldMapping } from "@/lib/post-class-feedback/types";
import { AUTOWRITER_EVENT_DEADLINE_MS, AUTOWRITER_STALE_POSTING_MS } from "./config";
import {
  AGENT_CORRECTION_ACTOR,
  CorrectionRefusedError,
  agentCorrectionDedupeKey,
  type CorrectionLock,
  type CorrectionPlan,
  type CorrectionSessionUpdate,
  type CorrectionSettleOutcome,
  type CorrectionStore,
} from "./correction";
import { normalizeFields, postedBilling } from "./first-shot";
import { recordIncident } from "./incidents";
import { loadFieldMappings } from "./run";
import { parseAutowriterSessionDetail, storedTeacherFields, teacherSubmissionSnapshot, type AutowriterSessionDetail } from "./session";
import { acquireSweepLease, haltAutowriter, releaseSweepLease, stuckPostInFlight } from "./store";
import {
  classifySubmitEvents,
  creditProblems,
  verifyStoredSubmission,
  type SubmitFeedbackEvent,
  type WiseFeedbackOps,
} from "./submit";
import { AUTOWRITER_DEADLINE_MARGIN_MS, type BillingPlan, type SubmissionState } from "./types";

/**
 * Postgres side of the guarded agent correction (`correction.ts`).
 *
 * The lock reuses what already stops every autowriter POST, so the production POST path needs no change:
 * - the sweep lease (`acquireSweepLease`): `runSweep` tries it before anything else and returns `skipped` while we
 *   hold it, so no backstop sweep starts (the window keeps us off its minutes anyway);
 * - a halt with a lock reason: the webhook path stops at `control.haltedAt`, and the POST claim (`claimPost`) requires
 *   `halted_at is null`. Halting writes no `feedback_autowriter_control_history` row: that trigger fires only when
 *   `mode` or `disabled_tutors` change (migration 0101), and coverage reads only those.
 * The halt is undone only by a compare-and-swap on the exact lock reason, so an owner pause or an anomaly halt added
 * on top (`haltAutowriter` appends) always survives the release. Every time the store compares is on the database
 * clock.
 */

const C = schema.feedbackAutowriterControl;
const S = schema.feedbackAutowriterSessions;
const P = schema.feedbackAutowriterPosts;

/** The lock's sweep lease: past a correction's pre-POST budget, and over before the backstop sweep after the window. */
export const CORRECTION_LOCK_LEASE_MS = 8 * 60_000;
/** A POST claim that began before our halt committed can still commit after it: wait this long, then look for one. */
export const CORRECTION_LOCK_SETTLE_MS = 2_000;
/** An agent correction still unsettled this long after its POST started is no live request any more. */
export const CORRECTION_STALE_AFTER_MS = 10 * 60_000;

const LOCK_PREFIX = "correction-lock:";
const LOCK_REASON_SUFFIX = " — auto-released; if this persists run scripts/feedback-autowriter-nightly.ts recover";
/** The halt reason of a correction lock, exactly — nothing appended (POSIX ARE, same as the JS pattern below). */
const LOCK_REASON_PATTERN = `^correction-lock:[0-9a-f-]{36} nightly agent correcting \\S+${LOCK_REASON_SUFFIX.replace(".", "\\.")}$`;
const LOCK_REASON_REGEX = new RegExp(LOCK_REASON_PATTERN, "u");

/** The halt reason that is the lock: its lease token, the class, and what to do if it lingers. */
export function correctionLockReason(token: string, wiseSessionId: string): string {
  return `${LOCK_PREFIX}${token} nightly agent correcting ${wiseSessionId}${LOCK_REASON_SUFFIX}`;
}

/** Whether a halt reason is a correction lock and nothing else (no pause or anomaly added on top). */
export function isCorrectionLockReason(reason: string | null | undefined): boolean {
  return typeof reason === "string" && LOCK_REASON_REGEX.test(reason);
}

/** A write the correction store refuses to make (`code`: why). Never carries lesson text. */
export class CorrectionStoreError extends Error {
  constructor(readonly code: string) {
    super(`correction store: ${code}`);
    this.name = "CorrectionStoreError";
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** SQL: any POST — a first post or a correction — whose outcome is not settled yet. */
const postInFlightSql = sql`(exists (select 1 from feedback_autowriter_sessions s where s.state in ('posting', 'awaiting_event'))
  or exists (select 1 from feedback_autowriter_posts p where p.outcome in ('posting', 'awaiting_event')))`;

/** SQL: an open flag the owner raised on the class. */
const ownerFlagOpenSql = (wiseSessionId: string) => sql`exists (select 1 from feedback_autowriter_flags f
  where f.wise_session_id = ${wiseSessionId} and f.source = 'owner' and f.resolved_by_verdict_id is null)`;

/** SQL: the session row still holds the base text, verified, its deadline more than the margin away. */
const sessionStillBaseSql = (plan: CorrectionPlan) => sql`exists (select 1 from feedback_autowriter_sessions s
  where s.wise_session_id = ${plan.wiseSessionId} and s.state = 'verified' and s.fields_sha256 = ${plan.base.fieldsSha256}
    and s.deadline_at > now() + (${AUTOWRITER_DEADLINE_MARGIN_MS} * interval '1 millisecond'))`;

/** Several yes/no facts in one round trip (read off the control row, which always exists). */
async function readBooleans<K extends string>(db: Database, columns: Record<K, SQL>): Promise<Record<K, boolean>> {
  const selection: Record<string, SQL<boolean>> = {};
  for (const [key, value] of Object.entries<SQL>(columns)) selection[key] = sql<boolean>`${value}`;
  const [row] = await db.select(selection).from(C).where(eq(C.id, "default")).limit(1);
  if (!row) throw new CorrectionStoreError("control_row_missing");
  return Object.fromEntries(Object.keys(columns).map((key) => [key, row[key] === true])) as Record<K, boolean>;
}

/**
 * `CorrectionStore` on Postgres for one correction at a time (the store remembers the lock it holds).
 * `now` is accepted so a caller can hand one clock to every part; the store itself compares only on the database clock.
 */
export function pgCorrectionStore(db: Database, opts: {
  actor: string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}): CorrectionStore {
  const { actor } = opts;
  const sleep = opts.sleep ?? defaultSleep;
  let held: { token: string; reason: string; wiseSessionId: string } | null = null;

  /** Un-halt first, only while the halt is exactly ours (compare-and-swap), then give the sweep lease back. */
  const release = async (): Promise<boolean> => {
    const current = held;
    if (!current) return false;
    const rows = await db.update(C).set({ haltedAt: null, haltReason: null, updatedBy: actor, updatedAt: sql`now()` })
      .where(and(eq(C.id, "default"), eq(C.haltReason, current.reason)))
      .returning({ id: C.id });
    await releaseSweepLease(db, current.token);
    held = null;
    return rows.length > 0;
  };

  return {
    async preconditions(plan, now) {
      const sid = plan.wiseSessionId;
      const [row] = await db.select({
        state: S.state,
        fieldsSha256: S.fieldsSha256,
        wiseClassId: S.wiseClassId,
        wiseTeacherUserId: S.wiseTeacherUserId,
        deadlineAt: S.deadlineAt,
        recordsRepost: sql<boolean>`${S.metadata} ?| array['corrections', 'nicknameFix', 'agentCorrection']`,
      }).from(S).where(eq(S.wiseSessionId, sid)).limit(1);
      const [firstShot] = await db.select({
        actorKind: P.actorKind, outcome: P.outcome, fieldsSha256: P.fieldsSha256, billing: P.billing, postStartedAt: P.postStartedAt,
      }).from(P).where(and(eq(P.wiseSessionId, sid), eq(P.kind, "first_shot"))).limit(1);
      const [control] = await db.select({ mode: C.mode, haltedAt: C.haltedAt, disabledTutors: C.disabledTutors })
        .from(C).where(eq(C.id, "default")).limit(1);
      const facts = await readBooleans(db, {
        // Re-posted before, by anyone: a correction or policy post, or a fix event our own re-post explains.
        alreadyCorrected: sql`exists (select 1 from feedback_autowriter_posts p where p.wise_session_id = ${sid}
            and (p.kind in ('correction', 'policy') or p.dedupe_key = ${agentCorrectionDedupeKey(sid)}))
          or exists (select 1 from feedback_autowriter_fix_events f where f.wise_session_id = ${sid}
            and f.actor_kind in ('autowriter_correction', 'autowriter_policy'))`,
        correctionInFlight: sql`exists (select 1 from feedback_autowriter_posts p
          where p.kind = 'correction' and p.outcome in ('posting', 'awaiting_event'))`,
        humanSave: sql`exists (select 1 from feedback_autowriter_fix_events f where f.wise_session_id = ${sid}
          and f.actor_kind in ('owner_web', 'tutor', 'other_staff', 'api_actor_unmatched'))`,
        ownerFlagOpen: ownerFlagOpenSql(sid),
      });
      const stuck = await stuckPostInFlight(db, AUTOWRITER_STALE_POSTING_MS);

      const problems: string[] = [];
      if (!row) {
        problems.push("row_missing");
      } else {
        if (row.state !== "verified" || row.fieldsSha256 !== plan.base.fieldsSha256) problems.push("row_changed");
        if (row.wiseClassId !== plan.wiseClassId || row.wiseTeacherUserId !== plan.wiseTeacherUserId) problems.push("row_mismatch");
        if (!row.deadlineAt) problems.push("deadline_unknown");
        else if (row.deadlineAt.getTime() <= now.getTime() + AUTOWRITER_DEADLINE_MARGIN_MS) problems.push("deadline_near");
        if (row.recordsRepost) problems.push("already_corrected");
      }
      if (!firstShot || firstShot.actorKind !== "autowriter" || firstShot.outcome !== "verified") {
        problems.push("no_first_shot");
      } else {
        // The text corrected is our first shot: the events checked since it are all there is to check.
        if (firstShot.fieldsSha256 !== plan.base.fieldsSha256) problems.push("base_not_first_shot");
        const posted = firstShot.postStartedAt?.getTime() ?? null;
        if (posted === null || plan.base.firstShotPostedAt.getTime() > posted + 60_000) problems.push("first_shot_time_mismatch");
        const billing = postedBilling(firstShot.billing);
        if (!billing || billing.sessionStatus !== plan.base.billing.sessionStatus || billing.creditsConsumed !== plan.base.billing.creditsConsumed) {
          problems.push("base_billing_mismatch");
        }
      }
      if (facts.alreadyCorrected) problems.push("already_corrected");
      if (facts.correctionInFlight) problems.push("correction_in_flight");
      if (!control || control.mode !== "live") problems.push("control:not_live");
      if (control?.haltedAt) problems.push("control:halted");
      if (control?.disabledTutors.includes(plan.wiseTeacherUserId)) problems.push("control:tutor_disabled");
      // An owner verdict (approve or needs fix) does not block: the owner asked for flagged posts to be corrected too.
      if (facts.humanSave) problems.push("human_save_since_post");
      if (facts.ownerFlagOpen) problems.push("owner_flag_open");
      if (stuck) problems.push("app_post_stuck");
      return [...new Set(problems)];
    },

    async lock(plan) {
      if (held) throw new CorrectionStoreError("lock_already_held");
      const token = await acquireSweepLease(db, CORRECTION_LOCK_LEASE_MS);
      if (!token) return { ok: false, reason: "sweep_running" };
      const reason = correctionLockReason(token, plan.wiseSessionId);
      let halted = false;
      try {
        // One statement: live, not halted, and our lease still valid.
        const rows = await db.update(C).set({ haltedAt: sql`now()`, haltReason: reason, updatedBy: actor, updatedAt: sql`now()` })
          .where(and(
            eq(C.id, "default"),
            isNull(C.haltedAt),
            eq(C.mode, "live"),
            eq(C.leaseToken, token),
            sql`${C.leaseUntil} > now()`,
          ))
          .returning({ id: C.id });
        if (rows.length === 0) {
          await releaseSweepLease(db, token);
          return { ok: false, reason: "not_live_or_halted" };
        }
        halted = true;
        held = { token, reason, wiseSessionId: plan.wiseSessionId };
        await sleep(CORRECTION_LOCK_SETTLE_MS);
        const { inFlight } = await readBooleans(db, { inFlight: postInFlightSql });
        if (inFlight) {
          await release();
          return { ok: false, reason: "post_in_flight" };
        }
        const lock: CorrectionLock = { release };
        return { ok: true, lock };
      } catch (error) {
        if (halted) await release().catch(() => false);
        else await releaseSweepLease(db, token).catch(() => undefined);
        throw error;
      }
    },

    async recordPostStart(plan, input) {
      const current = held;
      if (!current || current.wiseSessionId !== plan.wiseSessionId) throw new CorrectionRefusedError("lock:not_held");
      const sid = plan.wiseSessionId;
      // What recovery needs to read Wise back later; `verification` stays writable until the post settles.
      const verification = {
        stage: "posting",
        baseFieldsSha256: plan.base.fieldsSha256,
        submissionId: plan.base.submissionId,
        ...(input.freshReadAt ? { freshReadAt: input.freshReadAt.toISOString() } : {}),
        ...(input.studentWiseUserId ? { studentWiseUserId: input.studentWiseUserId } : {}),
        ...(input.baselineCredits ? { baselineCredits: input.baselineCredits } : {}),
      };
      const pipeline = { ...plan.pipeline, rootCauseRef: plan.rootCauseRef };
      // The claim: inserted only while the lock is still ours (an owner pause or resume, a mode change or the tutor
      // switched off since stop it), the session row still holds the base text, and nothing else is in flight. Never
      // touches the session row (its state, post_started_at, body_hash and verified_event belong to the first shot).
      const result = await db.execute(sql`
        insert into feedback_autowriter_posts (wise_session_id, wise_class_id, wise_teacher_user_id, kind, fields, fields_sha256,
          body_hash, billing, arm, evidence, pipeline, actor_kind, actor, reason, post_started_at, outcome, verification,
          provenance, dedupe_key)
        select ${sid}, ${plan.wiseClassId}, ${plan.wiseTeacherUserId}, 'correction', ${JSON.stringify(plan.fields)}::jsonb,
          ${plan.fieldsSha256}, ${input.bodyHash}, ${JSON.stringify(plan.base.billing)}::jsonb, ${plan.arm}, ${plan.evidence},
          ${JSON.stringify(pipeline)}::jsonb, 'agent', ${actor}, ${plan.reason}, now(), 'posting',
          ${JSON.stringify(verification)}::jsonb, 'live', ${agentCorrectionDedupeKey(sid)}
        where exists (select 1 from feedback_autowriter_control c where c.id = 'default' and c.mode = 'live'
            and c.halted_at is not null and c.halt_reason = ${current.reason}
            and c.lease_token = ${current.token}::uuid and c.lease_until > now()
            and not (c.disabled_tutors ? ${plan.wiseTeacherUserId}))
          and ${sessionStillBaseSql(plan)}
          and not ${ownerFlagOpenSql(sid)}
          and not ${postInFlightSql}
        returning id, post_started_at`);
      const row = result.rows[0] as { id?: unknown; post_started_at?: unknown } | undefined;
      if (row && typeof row.id === "string") {
        return { postId: row.id, postStartedAt: new Date(row.post_started_at as string | Date) };
      }
      const why = await readBooleans(db, {
        lockHeld: sql`exists (select 1 from feedback_autowriter_control c where c.id = 'default' and c.mode = 'live'
          and c.halted_at is not null and c.halt_reason = ${current.reason}
          and c.lease_token = ${current.token}::uuid and c.lease_until > now())`,
        tutorDisabled: sql`exists (select 1 from feedback_autowriter_control c where c.id = 'default'
          and c.disabled_tutors ? ${plan.wiseTeacherUserId})`,
        rowSame: sessionStillBaseSql(plan),
        ownerFlagOpen: ownerFlagOpenSql(sid),
        inFlight: postInFlightSql,
      });
      throw new CorrectionRefusedError(
        !why.lockHeld ? "lock:lost"
          : why.tutorDisabled ? "control:tutor_disabled"
            : !why.rowSame ? "row_changed"
              : why.ownerFlagOpen ? "owner_flag_open"
                : why.inFlight ? "post_in_flight"
                  : "conditions_changed",
      );
    },

    async settle(postId, input) {
      await withDatabaseTransaction(db, async (tx) => {
        const final = input.outcome !== "awaiting_event";
        const posts = await tx.update(P).set({
          outcome: input.outcome,
          verification: sql`${P.verification} || ${JSON.stringify(input.verification)}::jsonb`,
          ...(final ? { settledAt: sql`now()` } : {}),
        }).where(and(eq(P.id, postId), inArray(P.outcome, ["posting", "awaiting_event"])))
          .returning({ wiseSessionId: P.wiseSessionId });
        if (posts.length === 0) throw new CorrectionStoreError("post_not_unsettled");
        if (!input.session) return;
        const update: CorrectionSessionUpdate = input.session;
        // Never `metadata.corrections` (the one-time script's list): the review backfill would count it a second time.
        const sessions = await tx.update(S).set({
          fields: update.fields as unknown as Record<string, string>,
          fieldsSha256: update.fieldsSha256,
          metadata: sql`${S.metadata} || ${JSON.stringify({
            agentCorrection: {
              postId, at: update.at.toISOString(), fromSha256: update.fromSha256, toSha256: update.fieldsSha256, reason: update.reason,
            },
          })}::jsonb`,
          updatedAt: sql`now()`,
        }).where(and(
          eq(S.wiseSessionId, posts[0].wiseSessionId),
          eq(S.state, "verified"),
          eq(S.fieldsSha256, update.fromSha256),
        )).returning({ id: S.id });
        // Rolls the posts row back too: the post stays unsettled for recovery.
        if (sessions.length === 0) throw new CorrectionStoreError("session_row_changed");
      });
    },

    async halt(reason) {
      await haltAutowriter(db, reason, actor);
    },

    async incident(input) {
      await recordIncident(db, { ...input, kind: "correction_failed", severity: "critical" });
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function dateOf(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

function sameCredits(entries: ReadonlyArray<{ credit: number }>, baseline: readonly number[]): boolean {
  const left = entries.map((entry) => entry.credit).toSorted((a, b) => a - b);
  const right = [...baseline].toSorted((a, b) => a - b);
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export type CorrectionRecoveryResult = "verified" | "awaiting_event" | "not_sent" | "safety" | "read_failed";

export interface CorrectionRecovery {
  postId: string;
  wiseSessionId: string;
  result: CorrectionRecoveryResult;
  problems: string[];
}

/**
 * Settle agent corrections a dead or interrupted run left `posting` or `awaiting_event` (older than `olderThanMs`)
 * from what Wise shows — reads only, never a POST:
 * - the corrected text is in Wise and verifies (same submission, billing and credit entries, no stranger's or extra
 *   save in the POST window): `verified` with our event (the session takes the text if it had not yet), else
 *   `awaiting_event` until our event shows, for at most 2 h;
 * - a `posting` correction whose base text is still in Wise, untouched: `not_sent`;
 * - anything else: halt, then settle (`unknown_outcome` from `posting`, `verify_failed` from `awaiting_event`), then a
 *   critical incident. A Wise read that fails leaves the row for the next run (after 2 h: the same as anything else).
 * Pass the Wise ops without `postFeedback` (the type makes a POST impossible here).
 */
export async function recoverStaleCorrections(
  db: Database,
  ops: Pick<WiseFeedbackOps, "getSessionDetail" | "getSessionCreditEntries" | "findFeedbackEvents">,
  input: {
    apiActorId: string;
    olderThanMs?: number;
    actor?: string;
    mappings?: readonly FeedbackFieldMapping[];
    now?: () => Date;
  },
): Promise<CorrectionRecovery[]> {
  if (!input.apiActorId) throw new Error("The Wise API user id (WISE_USER_ID) is required to tell our saves apart.");
  const olderThanMs = input.olderThanMs ?? CORRECTION_STALE_AFTER_MS;
  const rows = await db.select().from(P).where(and(
    eq(P.kind, "correction"),
    eq(P.actorKind, "agent"),
    inArray(P.outcome, ["posting", "awaiting_event"]),
    sql`coalesce(${P.postStartedAt}, ${P.recordedAt}) < now() - (${olderThanMs} * interval '1 millisecond')`,
  )).orderBy(asc(P.recordedAt));
  if (rows.length === 0) return [];
  const mappings = input.mappings ?? await loadFieldMappings(db);
  const store = pgCorrectionStore(db, { actor: input.actor ?? AGENT_CORRECTION_ACTOR });
  const now = input.now ?? (() => new Date());
  const results: CorrectionRecovery[] = [];
  for (const row of rows) {
    const outcome = await recoverOne({ db, ops, store, row, mappings, apiActorId: input.apiActorId, now });
    results.push({ postId: row.id, wiseSessionId: row.wiseSessionId, ...outcome });
  }
  return results;
}

async function recoverOne(context: {
  db: Database;
  ops: Pick<WiseFeedbackOps, "getSessionDetail" | "getSessionCreditEntries" | "findFeedbackEvents">;
  store: CorrectionStore;
  row: typeof P.$inferSelect;
  mappings: readonly FeedbackFieldMapping[];
  apiActorId: string;
  now: () => Date;
}): Promise<{ result: CorrectionRecoveryResult; problems: string[] }> {
  const { db, ops, store, row, mappings, apiActorId, now } = context;
  const sid = row.wiseSessionId;
  const fromPosting = row.outcome === "posting";
  const failOutcome: CorrectionSettleOutcome = fromPosting ? "unknown_outcome" : "verify_failed";
  const recoveredAt = now();
  const fail = async (outcome: CorrectionSettleOutcome, problems: string[]) => {
    await store.halt(`agent correction on ${sid} could not be recovered (${outcome}): ${problems.join(", ")}`);
    await store.settle(row.id, { outcome, verification: { recovery: { at: recoveredAt.toISOString(), problems } } });
    await store.incident({
      dedupeKey: `correction_failed:${sid}`,
      wiseSessionId: sid,
      summary: `An agent correction could not be recovered (${outcome}: ${problems.join(", ")}). `
        + "The autowriter is halted: check the class in Wise, then resume.",
      detail: { postId: row.id, outcome, problems, recovery: true },
    });
    return { result: "safety" as const, problems };
  };

  const v = isRecord(row.verification) ? row.verification : {};
  const submissionId = stringOf(v.submissionId);
  const studentId = stringOf(v.studentWiseUserId);
  const baseSha = stringOf(v.baseFieldsSha256);
  const baselineCredits = Array.isArray(v.baselineCredits) && v.baselineCredits.every((value) => typeof value === "number")
    ? v.baselineCredits as number[]
    : null;
  const billing = postedBilling(row.billing);
  const postStartedAt = row.postStartedAt;
  if (!row.wiseClassId || !submissionId || !studentId || !baseSha || !billing || !postStartedAt) {
    return fail(failOutcome, ["row_incomplete_for_recovery"]);
  }
  const classId = row.wiseClassId;
  const overdue = recoveredAt.getTime() - postStartedAt.getTime() > AUTOWRITER_EVENT_DEADLINE_MS;
  const unreadable = (what: string) => overdue
    ? fail(failOutcome, [`${what}_unreadable_after_2h`])
    : Promise.resolve({ result: "read_failed" as const, problems: [`${what}_read_failed`] });

  let detail: AutowriterSessionDetail;
  try {
    detail = parseAutowriterSessionDetail(await ops.getSessionDetail(classId, sid));
  } catch {
    return unreadable("session");
  }
  let entries: Array<{ credit: number }>;
  try {
    entries = await ops.getSessionCreditEntries(classId, studentId, sid);
  } catch {
    return unreadable("credits");
  }
  const freshReadAt = dateOf(v.freshReadAt) ?? new Date(postStartedAt.getTime() - 60_000);
  let events: SubmitFeedbackEvent[];
  try {
    events = await ops.findFeedbackEvents(classId, sid, new Date(freshReadAt.getTime() - 5_000));
  } catch {
    return unreadable("events");
  }

  const fields = normalizeFields(row.fields);
  const billingPlan: BillingPlan = { ...billing, source: "auto_blank_reuse", expectedConsumedDelta: 0 };
  const expected: SubmissionState = { kind: "auto_blank", submissionId, ...billing };
  const creditsOk = baselineCredits ? sameCredits(entries, baselineCredits) : creditProblems(entries, billingPlan).length === 0;
  const landedProblems = [
    ...verifyStoredSubmission(detail, { fields, billing: billingPlan, expected, mappings }),
    ...(creditsOk ? [] : ["credit_entries_changed"]),
  ];
  const found = classifySubmitEvents(events, { apiActorId, freshReadAt, postStartedAt, postFinishedAt: dateOf(v.postFinishedAt) });
  const extra = events.filter((event) => event !== found.ours && event.autoSubmitted !== true && event.actorId === apiActorId &&
    event.at.getTime() >= freshReadAt.getTime() - 5_000);
  const eventProblems = [
    ...(found.foreign.length > 0 ? ["foreign_submit_event_in_post_window"] : []),
    ...(extra.length > 0 ? [`extra_api_save_in_post_window:${extra.length}`] : []),
  ];
  const recovery = { at: recoveredAt.toISOString(), from: row.outcome };

  if (landedProblems.length === 0) {
    if (eventProblems.length > 0) return fail("verify_failed", eventProblems);
    // The session row takes the corrected text when the post leaves `posting` (as the executor does).
    const session: CorrectionSessionUpdate | undefined = fromPosting
      ? { fields, fieldsSha256: row.fieldsSha256, fromSha256: baseSha, at: recoveredAt, reason: row.reason ?? "agent correction" }
      : undefined;
    const next = found.ours ? "verified" : "awaiting_event";
    if (!found.ours && overdue) return fail("verify_failed", ["no_submit_event_after_2h"]);
    if (next === "verified" || fromPosting) {
      try {
        await store.settle(row.id, {
          outcome: next,
          verification: {
            recovery,
            landed: true,
            event: found.ours ? { ...found.ours, at: found.ours.at.toISOString() } : null,
          },
          session,
        });
      } catch (error) {
        const code = error instanceof CorrectionStoreError ? error.code : error instanceof Error ? error.name : "Error";
        return fail("verify_failed", [`settle_failed:${code}`]);
      }
    }
    return { result: next, problems: [] };
  }

  // The corrected text is not in Wise. Only a `posting` correction whose base text is untouched was simply not sent.
  if (fromPosting && eventProblems.length === 0 && !found.ours && creditsOk) {
    const [sessionRow] = await db.select({ state: S.state, fields: S.fields, fieldsSha256: S.fieldsSha256 })
      .from(S).where(eq(S.wiseSessionId, sid)).limit(1);
    const snapshot = teacherSubmissionSnapshot(detail);
    const stored = storedTeacherFields(detail, mappings);
    const base = sessionRow?.fields ? normalizeFields(sessionRow.fields) : null;
    const baseIntact = sessionRow !== undefined && sessionRow.state === "verified" && sessionRow.fieldsSha256 === baseSha && base !== null &&
      stored !== null && POST_CLASS_FEEDBACK_FIELDS.every((field) => stored[field] === base[field]) &&
      snapshot.count === 1 && snapshot.submissionId === submissionId && !snapshot.autoSubmitted &&
      snapshot.sessionStatus === billing.sessionStatus && snapshot.creditsConsumed === billing.creditsConsumed;
    if (baseIntact) {
      await store.settle(row.id, { outcome: "not_sent", verification: { recovery, stillBase: true } });
      return { result: "not_sent", problems: [] };
    }
  }
  return fail(failOutcome, [...landedProblems, ...eventProblems, ...(found.ours ? ["api_save_but_text_not_landed"] : [])]);
}

/**
 * Lift a correction lock a run left behind (it died, or its release failed): only while the halt reason is exactly a
 * correction lock (no owner pause or anomaly halt on top), the run that took it no longer holds its lease, and no
 * agent correction is unsettled (run `recoverStaleCorrections` first). Returns whether it un-halted.
 */
export async function releaseStaleCorrectionLock(db: Database, opts: { actor?: string } = {}): Promise<boolean> {
  const rows = await db.update(C).set({
    haltedAt: null, haltReason: null, updatedBy: opts.actor ?? AGENT_CORRECTION_ACTOR, updatedAt: sql`now()`,
  }).where(and(
    eq(C.id, "default"),
    sql`${C.haltReason} ~ ${LOCK_REASON_PATTERN}`,
    sql`not coalesce(${C.leaseUntil} > now()
      and ${C.leaseToken}::text = substring(${C.haltReason} from '^correction-lock:([0-9a-f-]{36})'), false)`,
    sql`not exists (select 1 from feedback_autowriter_posts p where p.kind = 'correction' and p.outcome in ('posting', 'awaiting_event'))`,
  )).returning({ id: C.id });
  return rows.length > 0;
}
