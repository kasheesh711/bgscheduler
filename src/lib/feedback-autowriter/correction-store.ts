import { and, asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import { POST_CLASS_FEEDBACK_FIELDS, type FeedbackFieldMapping } from "@/lib/post-class-feedback/types";
import { AUTOWRITER_EVENT_DEADLINE_MS, AUTOWRITER_POST_TIMEOUT_MS, AUTOWRITER_STALE_POSTING_MS } from "./config";
import {
  AGENT_CORRECTION_ACTOR,
  CorrectionRefusedError,
  agentCorrectionDedupeKey,
  exactFeedbackFields,
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
 * The halt is undone only by a compare-and-swap on the exact lock reason — nothing appended (` | then: `) — while
 * nothing has written the control row since the lock (`updated_at` still the halt's own time): an owner pause or an
 * anomaly halt added on top always survives the release, even one `haltAutowriter` folded into the lock reason
 * unchanged because the lock reason already contained its text. Every time the store compares is on the database
 * clock; taking the lock also compares this machine's clock with it (`clock_skew` beyond 2 s).
 */

const C = schema.feedbackAutowriterControl;
const S = schema.feedbackAutowriterSessions;
const P = schema.feedbackAutowriterPosts;

/**
 * The lock's sweep lease: longer than any run (a 3-minute pre-POST budget, then up to about 10 minutes of read-back
 * and waiting for our event). A run gives it back when it ends; one that dies keeps the backstop sweeps off this long.
 */
export const CORRECTION_LOCK_LEASE_MS = 20 * 60_000;
/**
 * How long taking the lock waits for a sweep that holds the lease, and how often it tries. A backstop sweep (:08/:38)
 * ran p50 2 s, p90 75 s, p99 4.3 min over 7 days to 7 Oct 2026: a correction starting at :10/:40 met it often enough
 * that two verified corrections were refused `lock:sweep_running` that morning. Nothing is sent while waiting.
 */
export const CORRECTION_LOCK_WAIT_MS = 5 * 60_000;
export const CORRECTION_LOCK_POLL_MS = 15_000;
/** A POST claim that began before our halt committed can still commit after it: wait this long, then look for one. */
export const CORRECTION_LOCK_SETTLE_MS = 2_000;
/**
 * How far this machine's clock may be from the database's when the lock is taken. Wise's event times are compared
 * with database times only, but this clock still decides the window, the budgets and the waits.
 */
export const CORRECTION_MAX_CLOCK_SKEW_MS = 2_000;
/**
 * An agent correction still unsettled this long after its POST started is no live request any more: its lease (taken
 * before the POST) has run out, with five minutes to spare. Recovery also waits while any correction lease is live.
 */
export const CORRECTION_STALE_AFTER_MS = CORRECTION_LOCK_LEASE_MS + 5 * 60_000;
/** At most this many agent corrections (any outcome but `not_sent`) in any 24 h, checked in the database. */
export const CORRECTION_DAILY_CAP = 6;

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

/** A timestamp as the driver returns it (a Date, or Postgres' text form), or null. */
function databaseDate(value: unknown): Date | null {
  const at = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  return at && !Number.isNaN(at.getTime()) ? at : null;
}

/** SQL: any POST — a first post or a correction — whose outcome is not settled yet. */
const postInFlightSql = sql`(exists (select 1 from feedback_autowriter_sessions s where s.state in ('posting', 'awaiting_event'))
  or exists (select 1 from feedback_autowriter_posts p where p.outcome in ('posting', 'awaiting_event')))`;

/** SQL: the daily cap is reached — `CORRECTION_DAILY_CAP` agent corrections that may have reached Wise in the last 24 h. */
const dailyCapReachedSql = sql`(select count(*) from feedback_autowriter_posts p where p.kind = 'correction'
  and p.actor_kind = 'agent' and p.outcome <> 'not_sent'
  and coalesce(p.post_started_at, p.recorded_at) > now() - interval '24 hours') >= ${CORRECTION_DAILY_CAP}`;

/**
 * SQL: the control row's halt is untouched since the lock wrote it — no ` | then: ` appended, and no write at all
 * (`haltAutowriter` and `updateControl` always set `updated_at`; the lock set it to the halt's own time). The reason
 * alone cannot show a halt that `haltAutowriter` folded into it because the lock reason already contained its text.
 */
const lockHaltUntouchedSql = sql`(position(' | then: ' in ${C.haltReason}) = 0 and ${C.updatedAt} = ${C.haltedAt})`;

/** SQL: a correction lock's lease is still live (its run may still be working), whatever was appended to its halt. */
const correctionLeaseLiveSql = sql`exists (select 1 from feedback_autowriter_control c where c.id = 'default'
  and c.lease_until > now() and c.lease_token is not null
  and position(${LOCK_PREFIX} || c.lease_token::text in coalesce(c.halt_reason, '')) = 1)`;

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
 * `CorrectionStore` on Postgres for one correction at a time (the store remembers the lock it holds). `now` is this
 * machine's clock (the executor's): taking the lock checks it against the database's. Every other time the store
 * compares is on the database clock.
 */
export function pgCorrectionStore(db: Database, opts: {
  actor: string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}): CorrectionStore {
  const { actor } = opts;
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? defaultSleep;
  let held: { token: string; reason: string; wiseSessionId: string; teacherId: string } | null = null;

  /** SQL: the lock is still ours — live, halted with exactly our reason, our lease not expired. */
  const lockHeldSql = (current: { token: string; reason: string }) => sql`exists (select 1 from feedback_autowriter_control c
    where c.id = 'default' and c.mode = 'live' and c.halted_at is not null and c.halt_reason = ${current.reason}
      and c.lease_token = ${current.token}::uuid and c.lease_until > now())`;
  const tutorDisabledSql = (teacherId: string) => sql`exists (select 1 from feedback_autowriter_control c
    where c.id = 'default' and c.disabled_tutors ? ${teacherId})`;

  /** Un-halt first, only while the halt is exactly ours (compare-and-swap), then give the sweep lease back. */
  const release = async (): Promise<boolean> => {
    const current = held;
    if (!current) return false;
    const rows = await db.update(C).set({ haltedAt: null, haltReason: null, updatedBy: actor, updatedAt: sql`now()` })
      .where(and(eq(C.id, "default"), eq(C.haltReason, current.reason), lockHaltUntouchedSql))
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
        noShowNote: sql<boolean>`${S.metadata} ? 'noShowPost'`,
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
        dailyCapReached: dailyCapReachedSql,
      });
      const stuck = await stuckPostInFlight(db, AUTOWRITER_STALE_POSTING_MS);

      const problems: string[] = [];
      // The owner's no-show note: a correction would have to drop its absence wording (and with it the exemption).
      if (row?.noShowNote) problems.push("no_show_note");
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
      if (facts.dailyCapReached) problems.push("daily_cap");
      if (stuck) problems.push("app_post_stuck");
      return { problems: [...new Set(problems)], firstShotPostedAt: firstShot?.postStartedAt ?? null };
    },

    async lock(plan, options = {}) {
      if (held) throw new CorrectionStoreError("lock_already_held");
      // A running sweep is waited for: bounded by attempts (a stubbed sleep cannot spin) and by `waitUntil` (no wait
      // runs past the correction window; the executor refuses a window already closed before calling), and given up
      // at once on STOP. Nothing is halted meanwhile.
      let token = await acquireSweepLease(db, CORRECTION_LOCK_LEASE_MS);
      for (let attempt = 1; !token && attempt <= CORRECTION_LOCK_WAIT_MS / CORRECTION_LOCK_POLL_MS; attempt += 1) {
        if (options.waitUntil && now().getTime() + CORRECTION_LOCK_POLL_MS >= options.waitUntil.getTime()) break;
        if (options.stopRequested?.()) return { ok: false, reason: "stop_requested" };
        await sleep(CORRECTION_LOCK_POLL_MS);
        if (options.stopRequested?.()) return { ok: false, reason: "stop_requested" };
        token = await acquireSweepLease(db, CORRECTION_LOCK_LEASE_MS);
      }
      if (!token) return { ok: false, reason: "sweep_running" };
      const reason = correctionLockReason(token, plan.wiseSessionId);
      let halted = false;
      try {
        // One statement: live, not halted, and our lease still valid. Its `now()` is the database clock at the halt,
        // read between two readings of this machine's.
        const before = now().getTime();
        const rows = await db.update(C).set({ haltedAt: sql`now()`, haltReason: reason, updatedBy: actor, updatedAt: sql`now()` })
          .where(and(
            eq(C.id, "default"),
            isNull(C.haltedAt),
            eq(C.mode, "live"),
            eq(C.leaseToken, token),
            sql`${C.leaseUntil} > now()`,
          ))
          .returning({ id: C.id, at: sql<unknown>`now()` });
        const after = now().getTime();
        if (rows.length === 0) {
          await releaseSweepLease(db, token);
          return { ok: false, reason: "not_live_or_halted" };
        }
        halted = true;
        held = { token, reason, wiseSessionId: plan.wiseSessionId, teacherId: plan.wiseTeacherUserId };
        // Within the tolerance whatever the round trip took: the database's time lies within it of both readings.
        const at = databaseDate(rows[0].at)?.getTime() ?? Number.NaN;
        if (!(at <= before + CORRECTION_MAX_CLOCK_SKEW_MS && at >= after - CORRECTION_MAX_CLOCK_SKEW_MS)) {
          await release();
          return { ok: false, reason: "clock_skew" };
        }
        await sleep(CORRECTION_LOCK_SETTLE_MS);
        const { inFlight } = await readBooleans(db, { inFlight: postInFlightSql });
        if (inFlight) {
          await release();
          return { ok: false, reason: "post_in_flight" };
        }
        const isHeld = async (): Promise<boolean> => {
          const current = held;
          if (!current) return false;
          const facts = await readBooleans(db, { lockHeld: lockHeldSql(current), tutorDisabled: tutorDisabledSql(current.teacherId) });
          return facts.lockHeld && !facts.tutorDisabled;
        };
        const lock: CorrectionLock = { isHeld, release, haltedAtMs: before };
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
        ...(input.eventsReadAt ? { eventsReadAt: input.eventsReadAt.toISOString() } : {}),
        ...(input.freshReadAt ? { freshReadAt: input.freshReadAt.toISOString() } : {}),
        ...(input.studentWiseUserId ? { studentWiseUserId: input.studentWiseUserId } : {}),
        ...(input.baselineCredits ? { baselineCredits: input.baselineCredits } : {}),
      };
      const pipeline = { ...plan.pipeline, rootCauseRef: plan.rootCauseRef };
      // The claim: inserted only while the lock is still ours (an owner pause or resume, a mode change or the tutor
      // switched off since stop it), the session row still holds the base text, nothing else is in flight, and the
      // daily cap is not reached. Never touches the session row (its state, post_started_at, body_hash and
      // verified_event belong to the first shot).
      const result = await db.execute(sql`
        insert into feedback_autowriter_posts (wise_session_id, wise_class_id, wise_teacher_user_id, kind, fields, fields_sha256,
          body_hash, billing, arm, evidence, pipeline, actor_kind, actor, reason, post_started_at, outcome, verification,
          provenance, dedupe_key)
        select ${sid}, ${plan.wiseClassId}, ${plan.wiseTeacherUserId}, 'correction', ${JSON.stringify(exactFeedbackFields(plan.fields))}::jsonb,
          ${plan.fieldsSha256}, ${input.bodyHash}, ${JSON.stringify(plan.base.billing)}::jsonb, ${plan.arm}, ${plan.evidence},
          ${JSON.stringify(pipeline)}::jsonb, 'agent', ${actor}, ${plan.reason}, now(), 'posting',
          ${JSON.stringify(verification)}::jsonb, 'live', ${agentCorrectionDedupeKey(sid)}
        where ${lockHeldSql(current)}
          and not ${tutorDisabledSql(plan.wiseTeacherUserId)}
          and ${sessionStillBaseSql(plan)}
          and not ${ownerFlagOpenSql(sid)}
          and not ${postInFlightSql}
          and not ${dailyCapReachedSql}
        returning id, post_started_at`);
      const row = result.rows[0] as { id?: unknown; post_started_at?: unknown } | undefined;
      if (row && typeof row.id === "string") {
        const postStartedAt = databaseDate(row.post_started_at);
        // Never happens with a sane driver; the row stays `posting` for recovery, which finds the POST was not sent.
        if (!postStartedAt) throw new CorrectionStoreError("post_started_at_unreadable");
        return { postId: row.id, postStartedAt };
      }
      const why = await readBooleans(db, {
        lockHeld: lockHeldSql(current),
        tutorDisabled: tutorDisabledSql(plan.wiseTeacherUserId),
        rowSame: sessionStillBaseSql(plan),
        ownerFlagOpen: ownerFlagOpenSql(sid),
        inFlight: postInFlightSql,
        dailyCap: dailyCapReachedSql,
      });
      throw new CorrectionRefusedError(
        !why.lockHeld ? "lock:lost"
          : why.tutorDisabled ? "control:tutor_disabled"
            : !why.rowSame ? "row_changed"
              : why.ownerFlagOpen ? "owner_flag_open"
                : why.inFlight ? "post_in_flight"
                  : why.dailyCap ? "daily_cap"
                    : "conditions_changed",
      );
    },

    async databaseNow() {
      const result = await db.execute(sql`select now() as at`);
      const at = databaseDate((result.rows[0] as { at?: unknown } | undefined)?.at);
      if (!at) throw new CorrectionStoreError("database_clock_unreadable");
      return at;
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
          fields: exactFeedbackFields(update.fields) as unknown as Record<string, string>,
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

/** `lease_live`: a correction lock's lease is still live (its run may still be working); nothing was read or written. */
export type CorrectionRecoveryResult = "verified" | "awaiting_event" | "not_sent" | "safety" | "read_failed" | "lease_live";

export interface CorrectionRecovery {
  postId: string;
  wiseSessionId: string;
  result: CorrectionRecoveryResult;
  problems: string[];
}

/**
 * Settle agent corrections a dead or interrupted run left `posting` or `awaiting_event` (older than `olderThanMs`,
 * default `CORRECTION_STALE_AFTER_MS`) from what Wise shows — reads only, never a POST, and nothing at all while a
 * correction lock's lease is live (`lease_live`):
 * - an `awaiting_event` correction (the run read its text back from Wise already): only the events, as the sweep's
 *   reconciliation does — `verified` once our event shows with no stranger's or second API save in the POST window,
 *   for at most 2 h; what Wise shows later is on top of ours, never a reason to halt;
 * - a `posting` correction whose corrected text is in Wise and verifies (same submission, billing and credit entries,
 *   no stranger's or second API save in the POST window): `verified` with our event (the session takes the text),
 *   else `awaiting_event`;
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
  // A live run may still be reading Wise or settling its row: never recover under its lease.
  const { leaseLive } = await readBooleans(db, { leaseLive: correctionLeaseLiveSql });
  if (leaseLive) return rows.map((row) => ({ postId: row.id, wiseSessionId: row.wiseSessionId, result: "lease_live" as const, problems: [] }));
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
  const postStartedAt = row.postStartedAt;
  if (!row.wiseClassId || !postStartedAt) return fail(failOutcome, ["row_incomplete_for_recovery"]);
  const classId = row.wiseClassId;
  const overdue = recoveredAt.getTime() - postStartedAt.getTime() > AUTOWRITER_EVENT_DEADLINE_MS;
  const unreadable = (what: string) => overdue
    ? fail(failOutcome, [`${what}_unreadable_after_2h`])
    : Promise.resolve({ result: "read_failed" as const, problems: [`${what}_read_failed`] });
  const recovery = { at: recoveredAt.toISOString(), from: row.outcome };
  const settleFailed = (error: unknown) => fail("verify_failed", [
    `settle_failed:${error instanceof CorrectionStoreError ? error.code : error instanceof Error ? error.name : "Error"}`,
  ]);

  // The POST window as the run recorded it, on the database clock: from the first of the fresh reads (older rows: the
  // session read) to the POST's end (unknown: its time-out bound), with the 5 s slack either side. Saves after it are
  // on top of ours, whoever made them.
  const windowFrom = dateOf(v.eventsReadAt) ?? dateOf(v.freshReadAt) ?? new Date(postStartedAt.getTime() - 60_000);
  const postFinishedAt = dateOf(v.postFinishedAt);
  const windowEndMs = (postFinishedAt?.getTime() ?? postStartedAt.getTime() + AUTOWRITER_POST_TIMEOUT_MS) + 5_000;
  const checkEvents = (events: readonly SubmitFeedbackEvent[]) => {
    const found = classifySubmitEvents(events, { apiActorId, freshReadAt: windowFrom, postStartedAt, postFinishedAt });
    const extra = events.filter((event) => event !== found.ours && event.autoSubmitted !== true && event.actorId === apiActorId &&
      event.at.getTime() >= windowFrom.getTime() - 5_000 && event.at.getTime() <= windowEndMs);
    const problems = [
      ...(found.foreign.length > 0 ? ["foreign_submit_event_in_post_window"] : []),
      ...(extra.length > 0 ? [`extra_api_save_in_post_window:${extra.length}`] : []),
    ];
    return { ours: found.ours, problems };
  };
  const serialized = (event: SubmitFeedbackEvent) => ({ ...event, at: event.at.toISOString() });

  if (!fromPosting) {
    // `awaiting_event`: the run read the corrected text back from Wise, and the session took it. Like the sweep's
    // reconciliation, only the events are checked now: what Wise shows later is on top of ours, never a false alarm.
    let events: SubmitFeedbackEvent[];
    try {
      events = await ops.findFeedbackEvents(classId, sid, new Date(windowFrom.getTime() - 5_000));
    } catch {
      return unreadable("events");
    }
    const checked = checkEvents(events);
    if (checked.problems.length > 0) return fail("verify_failed", checked.problems);
    if (!checked.ours) return overdue ? fail("verify_failed", ["no_submit_event_after_2h"]) : { result: "awaiting_event", problems: [] };
    try {
      await store.settle(row.id, { outcome: "verified", verification: { recovery, event: serialized(checked.ours) } });
    } catch (error) {
      return settleFailed(error);
    }
    return { result: "verified", problems: [] };
  }

  // `posting`: the run stopped after its claim, before or after the POST — Wise shows which.
  const submissionId = stringOf(v.submissionId);
  const studentId = stringOf(v.studentWiseUserId);
  const baseSha = stringOf(v.baseFieldsSha256);
  const baselineCredits = Array.isArray(v.baselineCredits) && v.baselineCredits.every((value) => typeof value === "number")
    ? v.baselineCredits as number[]
    : null;
  const billing = postedBilling(row.billing);
  if (!submissionId || !studentId || !baseSha || !billing) return fail(failOutcome, ["row_incomplete_for_recovery"]);
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
  let events: SubmitFeedbackEvent[];
  try {
    events = await ops.findFeedbackEvents(classId, sid, new Date(windowFrom.getTime() - 5_000));
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
  const checked = checkEvents(events);

  if (landedProblems.length === 0) {
    if (checked.problems.length > 0) return fail("verify_failed", checked.problems);
    if (!checked.ours && overdue) return fail("verify_failed", ["no_submit_event_after_2h"]);
    const next = checked.ours ? "verified" : "awaiting_event";
    try {
      // The session row takes the corrected text as the post leaves `posting` (as the executor does).
      await store.settle(row.id, {
        outcome: next,
        verification: { recovery, landed: true, event: checked.ours ? serialized(checked.ours) : null },
        session: { fields, fieldsSha256: row.fieldsSha256, fromSha256: baseSha, at: recoveredAt, reason: row.reason ?? "agent correction" },
      });
    } catch (error) {
      return settleFailed(error);
    }
    return { result: next, problems: [] };
  }

  // The corrected text is not in Wise. Only a correction whose base text is untouched was simply not sent.
  if (checked.problems.length === 0 && !checked.ours && creditsOk) {
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
  return fail(failOutcome, [...landedProblems, ...checked.problems, ...(checked.ours ? ["api_save_but_text_not_landed"] : [])]);
}

/**
 * Lift a correction lock a run left behind (it died, or its release failed): only while the halt reason is exactly a
 * correction lock and untouched since (no owner pause or anomaly halt on top, appended or folded in), the run that
 * took it no longer holds its lease, and no agent correction is unsettled (run `recoverStaleCorrections` first).
 * Returns whether it un-halted.
 */
export async function releaseStaleCorrectionLock(db: Database, opts: { actor?: string } = {}): Promise<boolean> {
  const rows = await db.update(C).set({
    haltedAt: null, haltReason: null, updatedBy: opts.actor ?? AGENT_CORRECTION_ACTOR, updatedAt: sql`now()`,
  }).where(and(
    eq(C.id, "default"),
    sql`${C.haltReason} ~ ${LOCK_REASON_PATTERN}`,
    lockHaltUntouchedSql,
    sql`not coalesce(${C.leaseUntil} > now()
      and ${C.leaseToken}::text = substring(${C.haltReason} from '^correction-lock:([0-9a-f-]{36})'), false)`,
    sql`not exists (select 1 from feedback_autowriter_posts p where p.kind = 'correction' and p.outcome in ('posting', 'awaiting_event'))`,
  )).returning({ id: C.id });
  return rows.length > 0;
}
