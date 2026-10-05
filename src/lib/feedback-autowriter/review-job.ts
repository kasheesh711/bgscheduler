import { reviewIsebPosts } from "./iseb-review";
import { randomBytes } from "node:crypto";
import { and, between, count, desc, eq, getTableColumns, gte, inArray, isNotNull, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { sqlStateOf } from "./db-errors";
import { UNMATCHED_API_CRITICAL_FROM, ingestFixEvents, type FixActorKind, type FixEventIngestResult } from "./fix-events";
import { landedProblemCategory, normalizeFields, postMayHaveLanded, postedBilling, problemCodes, proveFirstShot, type FirstShotProof } from "./first-shot";
import { countUndeliveredCritical, drainIncidentOutbox, recordIncident, type DrainResult, type IncidentPushChannels } from "./incidents";
import {
  ATTEMPT_AT_PATTERN,
  GATE_THRESHOLDS,
  PROVEN_TUTOR_KEYS,
  SAMPLING_POLICY,
  QUALITY_POLICY_VERSION,
  bangkokDateKey,
  bangkokDayBounds,
  buildDailyMetrics,
  classifyCoverage,
  computeGateFacts,
  countsTowardFix,
  dailyGateDate,
  evaluateGate,
  gateWindow,
  metricDates,
  postingWindowEligibility,
  reviewInclusion,
  tutorWroteFirst,
  type ControlStateChange,
  type DailyClassFact,
  type GateInput,
  type GateStatus,
  type InclusionReason,
  type RosterSpan,
} from "./quality";
import { AUTOWRITER_TEACHER_ALLOWLIST, AUTOWRITER_TUTORS, rosterTutor } from "./roster";
import type { AutowriterSessionRow } from "./store";
import { fieldsHash } from "./submit";
import { AUTOWRITER_DEADLINE_MARGIN_MS } from "./types";

/**
 * The hourly review job of the operating loop (Phase 1, UTC minute 27 — after the :17 Wise activity sync).
 * Reads our own database only and never writes to Wise:
 *   a. snapshot the first shot of every settled posted class, proven against the POST claim's `body_hash`;
 *   b. derive fix events from Wise activity events (every autowriter class; refused without our API user's id);
 *   c. give each class whose first shot may be in Wise its review row (inclusion drawn once, before any flag);
 *   d. flag landed-but-unverified first shots (critical), classes a person fixed, and API writes no post explains;
 *   e. recompute the daily metrics of every date in the gate window, each class judged by its own posting window;
 *   f. record the daily gate row — only when every step above succeeded and the activity mirror was fresh when
 *      the run began;
 *   g. push critical incidents (waiting ones first, this run's last) within the time budget; an undelivered one
 *      keeps the run red until the owner acknowledges it.
 * Single-flight through `feedback_autowriter_review_runs` (partial unique index on `running`).
 */

const S = schema.feedbackAutowriterSessions;
const P = schema.feedbackAutowriterPosts;
const R = schema.feedbackAutowriterReviews;
const V = schema.feedbackAutowriterVerdicts;
const FL = schema.feedbackAutowriterFlags;
const FX = schema.feedbackAutowriterFixEvents;
const M = schema.feedbackAutowriterDailyMetrics;
const G = schema.feedbackAutowriterGateEvaluations;
const RUNS = schema.feedbackAutowriterReviewRuns;
const CH = schema.feedbackAutowriterControlHistory;
const RA = schema.feedbackAutowriterRosterAccounts;
const CALLS = schema.feedbackAutowriterCalls;
const PC = schema.postClassSessions;
const WAR = schema.wiseActivitySyncRuns;
const INC = schema.feedbackAutowriterIncidents;
const C = schema.feedbackAutowriterControl;

export const REVIEW_SYSTEM_ACTOR = "system:feedback-autowriter-review";
/** A `running` review run older than this is abandoned (maxDuration is 300 s). */
export const REVIEW_RUN_STALE_MS = 15 * 60 * 1000;
/** The daily gate row is written only from a Wise activity mirror refreshed this recently (the sync runs every 15 min). */
export const GATE_ACTIVITY_MAX_AGE_MS = 30 * 60 * 1000;
const FIX_EVENT_LOOKBACK_MS = 45 * 24 * 60 * 60 * 1000;
/** A roster class is "unseen" only this long after it ended: by then the sweep or the webhook has made its row. */
const UNSEEN_AFTER_END_MS = 2 * 60 * 60 * 1000;
const SETTLED_POST_STATES = ["verified", "rejected", "unknown_outcome", "verify_failed"] as const;
const HUMAN_FIX_KINDS = ["owner_web", "tutor", "other_staff"] as const;
/** Saves by a person (or by our API user outside any post) that can make a class "written by the tutor first". */
const PERSON_SAVE_KINDS = [...HUMAN_FIX_KINDS, "api_actor_unmatched"] as const;
const ONSITE_REASONS = ["session_type_OFFLINE", "session_type_in_person_title"] as const;
export const ONLINE_TITLE_SQL = "^\\s*(online|live)\\y";
const IN_PERSON_TITLE_SQL = "^\\s*(in[\\s-]?person|on[\\s-]?site)\\y";

/** SQL: a first shot whose text may be in Wise (mirror of `postMayHaveLanded`). */
const landedPostSql = sql`(${P.outcome} in ('verified', 'verify_failed', 'unknown_outcome')
  or (${P.outcome} = 'rejected' and coalesce(${P.verification} ->> 'stillAutoBlank', 'false') <> 'true'))`;

/** Uniform in [0, 1) from the crypto RNG (48 bits). */
export function uniformDraw(): number {
  return randomBytes(6).readUIntBE(0, 6) / 2 ** 48;
}

/** A tutor's canonical key (both Wise accounts), or the account id for someone no longer on the roster. */
export function tutorKeyFor(wiseTeacherUserId: string | null, recorded?: ReadonlyMap<string, string>): string {
  return rosterTutor(wiseTeacherUserId)?.canonicalKey
    ?? (wiseTeacherUserId ? recorded?.get(wiseTeacherUserId) : undefined)
    ?? wiseTeacherUserId ?? "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validDate(value: unknown): Date | null {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// ---------------------------------------------------------------------------
// a. First shots
// ---------------------------------------------------------------------------

/**
 * The posts row for a proven first shot. Its pipeline stamp is the POST claim's (`metadata.pipeline` plus
 * `postedFromCommit`); rows posted before Phase 0 have none. The verification keeps the read-back's problem codes
 * and whether a refused POST left the submission unchanged — never Wise's response body.
 */
export function firstShotPostValues(
  row: AutowriterSessionRow,
  proof: FirstShotProof,
  provenance: "snapshot" | "backfill",
): typeof P.$inferInsert {
  const metadata = isRecord(row.metadata) ? row.metadata : {};
  const post = isRecord(metadata.post) ? metadata.post : {};
  const reconcile = isRecord(metadata.reconcile) ? metadata.reconcile : {};
  const expected = isRecord(metadata.expected) ? metadata.expected : {};
  const stamp = isRecord(metadata.pipeline) ? metadata.pipeline : null;
  const postedFromCommit = typeof metadata.postedFromCommit === "string" ? metadata.postedFromCommit : null;
  const verifiedAt = validDate(isRecord(row.verifiedEvent) ? row.verifiedEvent.at : null);
  const outcome = (SETTLED_POST_STATES as readonly string[]).includes(row.state)
    ? row.state as (typeof SETTLED_POST_STATES)[number]
    : "unknown_outcome";
  const problems = [...new Set([...problemCodes(post.problems), ...problemCodes(reconcile.problems)])];
  return {
    wiseSessionId: row.wiseSessionId,
    wiseClassId: row.wiseClassId,
    wiseTeacherUserId: row.wiseTeacherUserId,
    kind: "first_shot",
    fields: proof.fields,
    fieldsSha256: fieldsHash(proof.fields),
    bodyHash: proof.bodyHash,
    billing: row.billing ?? {},
    arm: row.arm,
    evidence: row.evidence,
    pipeline: stamp || postedFromCommit ? { ...(stamp ?? {}), ...(postedFromCommit ? { postedFromCommit } : {}) } : null,
    actorKind: "autowriter",
    actor: "system:feedback-autowriter",
    reason: null,
    postStartedAt: row.postStartedAt,
    postFinishedAt: validDate(post.postFinishedAt),
    outcome,
    verification: {
      state: row.state,
      event: row.verifiedEvent ?? null,
      submissionId: typeof expected.submissionId === "string" ? expected.submissionId : null,
      fieldOrder: proof.fieldOrder,
      ...(problems.length > 0 ? { problems } : {}),
      ...(typeof post.stillAutoBlank === "boolean" ? { stillAutoBlank: post.stillAutoBlank } : {}),
      ...(typeof post.httpStatus === "number" ? { httpStatus: post.httpStatus } : {}),
    },
    provenance,
    reconstruction: { method: proof.method, fieldOrder: proof.fieldOrder, bodyHash: proof.bodyHash, source: proof.source },
    settledAt: verifiedAt ?? row.updatedAt,
  };
}

/** Settled posted rows that have no first-shot record yet. */
export async function listUnrecordedPostedRows(db: Database): Promise<AutowriterSessionRow[]> {
  return db.select().from(S).where(and(
    isNotNull(S.postStartedAt),
    inArray(S.state, [...SETTLED_POST_STATES]),
    sql`not exists (select 1 from feedback_autowriter_posts p
      where p.wise_session_id = feedback_autowriter_sessions.wise_session_id and p.kind = 'first_shot')`,
  ));
}

/**
 * Record the first shot of every settled posted class whose stored text still proves the POST body. A row edited
 * after posting (a one-time script's re-post) no longer does: it is left for the backfill script, with an info
 * incident — or a critical one when the post did not verify, since then nobody knows what is in Wise.
 */
export async function snapshotFirstShots(db: Database): Promise<{ recorded: number; unverified: string[] }> {
  let recorded = 0;
  const unverified: string[] = [];
  for (const row of await listUnrecordedPostedRows(db)) {
    const billing = postedBilling(row.billing);
    const proof = billing && row.bodyHash && row.fields
      ? proveFirstShot({ bodyHash: row.bodyHash, billing, candidates: [{ method: "unchanged", fields: normalizeFields(row.fields) }] })
      : null;
    if (!proof) {
      unverified.push(row.wiseSessionId);
      const metadata = isRecord(row.metadata) ? row.metadata : {};
      const post = isRecord(metadata.post) ? metadata.post : {};
      const landedUnverified = row.state !== "verified" && postMayHaveLanded(row.state, { stillAutoBlank: post.stillAutoBlank });
      await recordIncident(db, {
        dedupeKey: `first_shot_unverified:${row.wiseSessionId}`,
        kind: "first_shot_unverified",
        severity: landedUnverified ? "critical" : "info",
        wiseSessionId: row.wiseSessionId,
        summary: landedUnverified
          ? `A post that may be in Wise (${row.state}) cannot be proven against its POST body: check the class in Wise.`
          : "The stored text no longer proves the posted body (edited after posting): run the review backfill.",
        detail: { state: row.state, nicknameFix: "nicknameFix" in metadata, corrections: Array.isArray(metadata.corrections) },
      });
      continue;
    }
    const inserted = await db.insert(P).values(firstShotPostValues(row, proof, "snapshot")).onConflictDoNothing().returning({ id: P.id });
    recorded += inserted.length;
  }
  return { recorded, unverified };
}

// ---------------------------------------------------------------------------
// c. Review rows
// ---------------------------------------------------------------------------

/**
 * One review row per first shot whose text may be in Wise (verified, and landed-but-unverified: the owner must be
 * able to judge those, critical errors included). Inclusion is drawn here, once, before any flag can count; flags
 * raised before the row existed are carried onto it.
 */
export async function assignReviews(db: Database, input: {
  draw?: () => number;
  provenTutorKeys?: ReadonlySet<string>;
  now: Date;
}): Promise<number> {
  const draw = input.draw ?? uniformDraw;
  const proven = input.provenTutorKeys ?? PROVEN_TUTOR_KEYS;
  const rows = await db.select({
    postId: P.id,
    wiseSessionId: P.wiseSessionId,
    wiseTeacherUserId: P.wiseTeacherUserId,
    postStartedAt: P.postStartedAt,
    scheduledEndAt: S.scheduledEndAt,
  }).from(P)
    .leftJoin(S, eq(S.wiseSessionId, P.wiseSessionId))
    .where(and(
      eq(P.kind, "first_shot"),
      landedPostSql,
      sql`not exists (select 1 from feedback_autowriter_reviews r where r.wise_session_id = feedback_autowriter_posts.wise_session_id)`,
    ));
  let created = 0;
  for (const row of rows) {
    const tutorKey = tutorKeyFor(row.wiseTeacherUserId);
    const classEndedAt = row.scheduledEndAt ?? row.postStartedAt;
    const sample = draw();
    const inclusion = reviewInclusion({ tutorProven: proven.has(tutorKey), draw: sample });
    const inserted = await db.insert(R).values({
      wiseSessionId: row.wiseSessionId,
      firstPostId: row.postId,
      tutorKey,
      wiseTeacherUserId: row.wiseTeacherUserId,
      classEndedAt,
      bangkokDate: bangkokDateKey(classEndedAt ?? input.now),
      inclusionReason: inclusion.reason,
      inclusionProbability: inclusion.probability.toFixed(3),
      sampleDraw: sample,
      samplingPolicy: SAMPLING_POLICY,
      flaggedAt: sql`(select min(f.created_at) from feedback_autowriter_flags f
        where f.wise_session_id = ${row.wiseSessionId} and f.resolved_by_verdict_id is null)`,
      flagSources: sql`array(select distinct f.source from feedback_autowriter_flags f
        where f.wise_session_id = ${row.wiseSessionId} and f.resolved_by_verdict_id is null order by 1)`,
    }).onConflictDoNothing().returning({ id: R.wiseSessionId });
    created += inserted.length;
  }
  return created;
}

// ---------------------------------------------------------------------------
// d. Flags
// ---------------------------------------------------------------------------

const ACTOR_LABEL: Record<string, string> = {
  owner_web: "Owner (Wise web)",
  tutor: "Tutor",
  other_staff: "Other staff",
  api_actor_unmatched: "Wise API user (no recorded post)",
};

async function insertFlag(db: Database, input: {
  wiseSessionId: string;
  source: "measured_fix" | "api_unmatched" | "system";
  idempotencyKey: string;
  note: string;
  suggestedSeverity?: "critical" | null;
  suggestedCategory?: "billing_status" | "should_not_have_posted" | null;
}): Promise<boolean> {
  const inserted = await db.insert(FL).values({
    wiseSessionId: input.wiseSessionId,
    source: input.source,
    suggestedSeverity: input.suggestedSeverity ?? null,
    suggestedCategory: input.suggestedCategory ?? null,
    note: input.note.slice(0, 500),
    createdBy: REVIEW_SYSTEM_ACTOR,
    idempotencyKey: input.idempotencyKey,
  }).onConflictDoNothing().returning({ id: FL.id });
  if (inserted.length === 0) return false;
  await db.update(R).set({
    flaggedAt: sql`coalesce(feedback_autowriter_reviews.flagged_at, now())`,
    flagSources: sql`array(select distinct unnest(feedback_autowriter_reviews.flag_sources || array[${input.source}]::text[]) order by 1)`,
    updatedAt: sql`now()`,
  }).where(eq(R.wiseSessionId, input.wiseSessionId));
  return true;
}

/**
 * A first shot that landed in Wise without verifying (read-back mismatch, changed credits or status, a stranger's
 * save in our POST window, an unknown outcome) is flagged critical and pushed: the gate stays blocked until the
 * owner has judged it (a non-critical verdict then is an explicit, noted downgrade). Idempotent per class.
 */
export async function raiseVerificationFlags(db: Database): Promise<{ flags: number; incidents: number }> {
  const rows = await db.select({ wiseSessionId: P.wiseSessionId, outcome: P.outcome, verification: P.verification }).from(P)
    .where(and(eq(P.kind, "first_shot"), sql`${P.outcome} <> 'verified'`, landedPostSql));
  let flags = 0;
  let incidents = 0;
  for (const row of rows) {
    const problems = problemCodes((row.verification as { problems?: unknown }).problems);
    const category = landedProblemCategory(problems);
    const codes = problems.length > 0 ? problems.join(", ") : "no read-back";
    if (await insertFlag(db, {
      wiseSessionId: row.wiseSessionId,
      source: "system",
      idempotencyKey: `verification:${row.wiseSessionId}`,
      suggestedSeverity: "critical",
      suggestedCategory: category,
      note: `The first shot may be in Wise but did not verify (${row.outcome}: ${codes}). Check the class in Wise.`,
    })) flags += 1;
    if (await recordIncident(db, {
      dedupeKey: `verification:${row.wiseSessionId}`,
      kind: problems.some((code) => code.startsWith("session_credit")) ? "credit_entries_changed" : "critical_flag",
      severity: "critical",
      wiseSessionId: row.wiseSessionId,
      summary: `A post landed in Wise without verifying (${row.outcome}: ${codes.slice(0, 200)})`,
      detail: { outcome: row.outcome, problems, category },
    })) incidents += 1;
  }
  return { flags, incidents };
}

/**
 * Idempotent over every fix event in the look-back:
 * - an API save no post explains raises an incident (critical — pushed — from `criticalFrom`, the autowriter's
 *   go-live; info before) and, after our first post, a gate-blocking flag, whatever the verdicts say;
 * - a person's save after our first post flags the class (`measured_fix`) unless it came after the owner's current
 *   Approve (then it is listed, not counted: "fixes until satisfied").
 */
export async function raiseFixFlags(db: Database, input: { since: Date; criticalFrom?: Date }): Promise<{ flags: number; incidents: number }> {
  const criticalFrom = input.criticalFrom ?? UNMATCHED_API_CRITICAL_FROM;
  const events = await db.select({
    wiseEventId: FX.wiseEventId,
    wiseSessionId: FX.wiseSessionId,
    eventAt: FX.eventAt,
    actorKind: FX.actorKind,
    countsAsFix: FX.countsAsFix,
    verdict: V.verdict,
    verdictAt: V.createdAt,
  }).from(FX)
    .leftJoin(R, eq(R.wiseSessionId, FX.wiseSessionId))
    .leftJoin(V, eq(V.id, R.currentVerdictId))
    .where(and(
      gte(FX.eventAt, input.since),
      or(
        eq(FX.actorKind, "api_actor_unmatched"),
        and(eq(FX.countsAsFix, true), inArray(FX.actorKind, [...HUMAN_FIX_KINDS])),
      ),
    ));
  let flags = 0;
  let incidents = 0;
  for (const event of events) {
    const unmatched = event.actorKind === "api_actor_unmatched";
    if (unmatched) {
      const critical = event.eventAt.getTime() >= criticalFrom.getTime();
      if (await recordIncident(db, {
        dedupeKey: `api_actor_unmatched:${event.wiseEventId}`,
        kind: "api_actor_unmatched",
        severity: critical ? "critical" : "info",
        wiseSessionId: event.wiseSessionId,
        summary: `A feedback save by the Wise API user at ${event.eventAt.toISOString()} matches no recorded autowriter post`
          + (critical ? "" : " (before the autowriter went live)"),
        detail: { wiseEventId: event.wiseEventId, eventAt: event.eventAt.toISOString() },
      })) incidents += 1;
      if (!event.countsAsFix) continue;
    } else if (!countsTowardFix(event, event.verdict && event.verdictAt ? { verdict: event.verdict, createdAt: event.verdictAt } : null)) {
      continue;
    }
    const source = unmatched ? "api_unmatched" : "measured_fix";
    if (await insertFlag(db, {
      wiseSessionId: event.wiseSessionId,
      source,
      idempotencyKey: `${source}:${event.wiseEventId}`,
      note: `${ACTOR_LABEL[event.actorKind] ?? event.actorKind} saved the feedback at ${event.eventAt.toISOString()}`,
    })) flags += 1;
  }
  return { flags, incidents };
}

/**
 * Measured fixes up to the owner's current Approve (all of them while there is none), in total and per actor kind,
 * and verified corrections, per review.
 */
export async function refreshReviewCounts(db: Database, input: { sinceDate: string }): Promise<number> {
  const counted = sql`f.wise_session_id = feedback_autowriter_reviews.wise_session_id and f.counts_as_fix
    and not exists (select 1 from feedback_autowriter_verdicts v
      where v.id = feedback_autowriter_reviews.current_verdict_id and v.verdict = 'approve' and f.event_at > v.created_at)`;
  const fixes = sql`(select count(*)::int from feedback_autowriter_fix_events f where ${counted})`;
  const byActor = sql`(select coalesce(jsonb_object_agg(x.actor_kind, x.n), '{}'::jsonb) from (
    select f.actor_kind, count(*)::int as n from feedback_autowriter_fix_events f where ${counted} group by f.actor_kind) x)`;
  const corrections = sql`(select count(*)::int from feedback_autowriter_posts p
    where p.wise_session_id = feedback_autowriter_reviews.wise_session_id and p.kind = 'correction' and p.outcome = 'verified')`;
  const rows = await db.update(R).set({ measuredFixCount: fixes, measuredFixesByActor: byActor, correctionsVerified: corrections, updatedAt: sql`now()` })
    .where(and(
      gte(R.bangkokDate, input.sinceDate),
      sql`(feedback_autowriter_reviews.measured_fix_count, feedback_autowriter_reviews.measured_fixes_by_actor,
        feedback_autowriter_reviews.corrections_verified) is distinct from (${fixes}, ${byActor}, ${corrections})`,
    )).returning({ id: R.wiseSessionId });
  return rows.length;
}

// ---------------------------------------------------------------------------
// e. Daily metrics and the gate
// ---------------------------------------------------------------------------

/**
 * Record every code-roster account as seen now. `first_seen_at` is the account's earliest autowriter row (evidence
 * it was on the roster then), else now; a removed account keeps its last sighting.
 */
export async function recordRosterAccounts(db: Database, now: Date): Promise<number> {
  const sightings = await rosterSightings(db, now);
  if (sightings.length === 0) return 0;
  await db.insert(RA).values(sightings).onConflictDoUpdate({
    target: RA.wiseTeacherUserId,
    set: {
      tutorKey: sql`excluded.tutor_key`,
      firstSeenAt: sql`least(${RA.firstSeenAt}, excluded.first_seen_at)`,
      lastSeenAt: sql`greatest(${RA.lastSeenAt}, excluded.last_seen_at)`,
    },
  });
  return sightings.length;
}

export interface RosterAccountRow {
  wiseTeacherUserId: string;
  tutorKey: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

/** The sightings a run at `now` records for the code roster (see `recordRosterAccounts`), without writing them. */
export async function rosterSightings(db: Database, now: Date): Promise<RosterAccountRow[]> {
  const accounts = [...AUTOWRITER_TEACHER_ALLOWLIST];
  if (accounts.length === 0) return [];
  const earliest = await db.select({ wiseTeacherUserId: S.wiseTeacherUserId, first: sql<Date>`min(${S.createdAt})` }).from(S)
    .where(inArray(S.wiseTeacherUserId, accounts)).groupBy(S.wiseTeacherUserId);
  const firstRow = new Map(earliest.map((row) => [row.wiseTeacherUserId, validDate(row.first)]));
  return accounts.map((id) => {
    const first = firstRow.get(id) ?? null;
    return {
      wiseTeacherUserId: id,
      tutorKey: tutorKeyFor(id),
      firstSeenAt: first && first.getTime() < now.getTime() ? first : now,
      lastSeenAt: now,
    };
  });
}

/** The control row's recorded changes, oldest first. */
export async function loadControlHistory(db: Database): Promise<ControlStateChange[]> {
  const rows = await db.select({ changedAt: CH.changedAt, mode: CH.mode, disabledTutors: CH.disabledTutors }).from(CH).orderBy(CH.changedAt);
  return rows.map((row) => ({
    changedAt: row.changedAt,
    mode: row.mode,
    disabledTutors: Array.isArray(row.disabledTutors) ? row.disabledTutors.filter((id): id is string => typeof id === "string") : [],
  }));
}

/** Whether a recorded change says the mode was live at some point of [start, end) (never assumed before the history). */
function recordedLiveDuring(history: readonly ControlStateChange[], start: Date, end: Date): boolean {
  const before = history.findLast((change) => change.changedAt.getTime() <= start.getTime());
  if (before?.mode === "live") return true;
  return history.some((change) => change.mode === "live" && change.changedAt.getTime() > start.getTime() && change.changedAt.getTime() < end.getTime());
}

/** The posting window of a class: from its end to its deadline less the margin, and never past now. */
function postingWindow(endedAt: Date, deadlineAt: Date | null, now: Date): { window: { start: Date; end: Date }; closed: boolean } {
  const close = deadlineAt ? deadlineAt.getTime() - AUTOWRITER_DEADLINE_MARGIN_MS : null;
  const closed = close !== null && close <= now.getTime();
  const end = Math.max(endedAt.getTime(), close !== null ? Math.min(close, now.getTime()) : now.getTime());
  return { window: { start: endedAt, end: new Date(end) }, closed };
}

const metricColumnNames = Object.fromEntries(Object.entries(getTableColumns(M)).map(([key, column]) => [key, column.name]));

/** The review rows of a date range with their current verdicts (accuracy and severities of the daily metrics). */
async function loadDailyReviewRows(db: Database, first: string, last: string) {
  return db.select({
    bangkokDate: R.bangkokDate,
    tutorKey: R.tutorKey,
    inclusionReason: R.inclusionReason,
    measuredFixCount: R.measuredFixCount,
    correctionsVerified: R.correctionsVerified,
    verdict: V.verdict,
    severity: V.severity,
  }).from(R).leftJoin(V, eq(V.id, R.currentVerdictId)).where(between(R.bangkokDate, first, last));
}

type DailyReviewRow = Awaited<ReturnType<typeof loadDailyReviewRows>>[number];

/** A person's first save on each skipped class in `sessionsSql`, from the stored fix events. */
async function loadFirstPersonSaves(db: Database, sessionsSql: ReturnType<typeof sql>): Promise<Map<string, Date>> {
  const rows = await db.select({ wiseSessionId: FX.wiseSessionId, at: sql<Date>`min(${FX.eventAt})` }).from(FX).where(and(
    inArray(FX.actorKind, [...PERSON_SAVE_KINDS]),
    sql`${FX.wiseSessionId} in ${sessionsSql}`,
  )).groupBy(FX.wiseSessionId);
  return new Map(rows.flatMap((row) => {
    const at = validDate(row.at);
    return at ? [[row.wiseSessionId, at] as const] : [];
  }));
}

/** A person's first save per class from classified fix events: what `loadFirstPersonSaves` reads once they are stored. */
export function firstPersonSavesOf(events: ReadonlyArray<{ wiseSessionId: string; actorKind: FixActorKind; eventAt: Date }>): Map<string, Date> {
  const kinds = new Set<FixActorKind>(PERSON_SAVE_KINDS);
  const first = new Map<string, Date>();
  for (const event of events) {
    if (!kinds.has(event.actorKind)) continue;
    const seen = first.get(event.wiseSessionId);
    if (!seen || event.eventAt.getTime() < seen.getTime()) first.set(event.wiseSessionId, event.eventAt);
  }
  return first;
}

/** Stand-ins for what the daily metrics read from the review tables (a dry run before migration 0101). */
export interface DailyMetricOverrides {
  rosterRows?: RosterAccountRow[];
  history?: ControlStateChange[];
  firstPersonSave?: ReadonlyMap<string, Date>;
  reviews?: DailyReviewRow[];
}

/**
 * The metric rows of the given Bangkok dates, computed without writing (`refreshDailyMetrics` records the roster
 * sightings first and stores them). Every class is judged by the switches, the roster and its own state over its
 * posting window: a posted class counts; a class the switches never let us write is excluded (not live, or its tutor
 * switched off), and so is one held for its own data (D-03); a class still unsettled once its window is over is a miss
 * (the sweep may not have expired it yet); an unseen roster class is a miss only when proven online one-to-one and its
 * account was on the roster during the window. `skipped_human` is "the tutor wrote first" only when a person's save is
 * recorded before our first writer call — before its request was sent, as the call records have it.
 */
export async function computeDailyMetrics(db: Database, input: {
  dates: readonly string[];
  now: Date;
  overrides?: DailyMetricOverrides;
}): Promise<Array<typeof M.$inferInsert>> {
  const dates = [...new Set(input.dates)].toSorted();
  if (dates.length === 0) return [];
  const { now, overrides = {} } = input;
  const rangeStart = bangkokDayBounds(dates[0]).start;
  const rangeEnd = bangkokDayBounds(dates.at(-1)!).end;
  const unseenBefore = new Date(Math.min(rangeEnd.getTime(), now.getTime() - UNSEEN_AFTER_END_MS));
  const rosterRows = overrides.rosterRows ?? await db.select().from(RA);
  const rosterIds = [...new Set([...AUTOWRITER_TEACHER_ALLOWLIST, ...rosterRows.map((row) => row.wiseTeacherUserId)])];
  const skippedHumanInRange = sql`(select s.wise_session_id from feedback_autowriter_sessions s where s.state = 'skipped_human'
    and s.scheduled_end_at >= ${rangeStart} and s.scheduled_end_at < ${rangeEnd})`;
  // Unseen classes first, then the rows: a row the sweep makes in between shows up in both reads, and is counted
  // once, as the row (read the other way round, it could be missed by both).
  const unseenRead = await db.select({
    wiseSessionId: PC.wiseSessionId,
    wiseTeacherUserId: PC.wiseTeacherUserId,
    scheduledEndAt: PC.scheduledEndAt,
    deadlineAt: PC.deadlineAt,
    proven: sql<boolean>`(
      exists (select 1 from past_session_blocks b where b.wise_session_id = post_class_sessions.wise_session_id
        and b.session_type = 'SCHEDULED' and b.class_type = 'ONE_TO_ONE' and coalesce(b.title, '') !~* ${IN_PERSON_TITLE_SQL})
      or (select count(distinct c.wise_student_id) from credit_control_sessions c
        where c.snapshot_id = (select s.id from credit_control_snapshots s where s.active order by s.generated_at desc limit 1)
          and c.wise_session_id = post_class_sessions.wise_session_id and c.title ~* ${ONLINE_TITLE_SQL}) = 1
    )`,
  }).from(PC).where(and(
    inArray(PC.wiseTeacherUserId, rosterIds),
    gte(PC.scheduledEndAt, rangeStart),
    lt(PC.scheduledEndAt, unseenBefore),
    or(isNull(PC.finalStatus), notInArray(PC.finalStatus, ["CANCELLED", "CANCELED", "NO_SHOW", "DELETED"])),
    isNull(PC.wiseDeletedAt),
    sql`not exists (select 1 from feedback_autowriter_sessions a where a.wise_session_id = post_class_sessions.wise_session_id)`,
  ));
  const [sessions, reviews, history, writerCalls, firstPersonSave] = await Promise.all([
    db.select({
      wiseSessionId: S.wiseSessionId, wiseTeacherUserId: S.wiseTeacherUserId, state: S.state, reason: S.reason,
      scheduledEndAt: S.scheduledEndAt, deadlineAt: S.deadlineAt,
    }).from(S).where(and(gte(S.scheduledEndAt, rangeStart), lt(S.scheduledEndAt, rangeEnd))),
    overrides.reviews ?? loadDailyReviewRows(db, dates[0], dates.at(-1)!),
    overrides.history ?? loadControlHistory(db),
    // Our first writer call, successful or not: from then on a person's save is a miss (late), not "wrote first".
    // A rate-limited attempt's row is written only when its call ends, after the waits, so it says itself when its
    // request was sent (`result.attemptAt`): that time comes before `created_at`, or a save during the waits would
    // pass for "the tutor wrote first". Cast only when it is a time (`ATTEMPT_AT_PATTERN`): a malformed value must
    // not fail the day's metrics, so its row is dated by `created_at` like any other.
    db.select({
      wiseSessionId: CALLS.wiseSessionId,
      at: sql<Date>`min(coalesce(case when ${CALLS.result} ->> 'attemptAt' ~ ${ATTEMPT_AT_PATTERN}
        then (${CALLS.result} ->> 'attemptAt')::timestamptz end, ${CALLS.createdAt}))`,
    }).from(CALLS).where(and(
      eq(CALLS.role, "writer"), sql`${CALLS.wiseSessionId} in ${skippedHumanInRange}`,
    )).groupBy(CALLS.wiseSessionId),
    overrides.firstPersonSave ?? loadFirstPersonSaves(db, skippedHumanInRange),
  ]);

  const rosterKeys = new Map(rosterRows.map((row) => [row.wiseTeacherUserId, row.tutorKey]));
  const rosterSpans = new Map<string, RosterSpan>(rosterRows.map((row) => [row.wiseTeacherUserId, { firstSeenAt: row.firstSeenAt, lastSeenAt: row.lastSeenAt }]));
  const rowIds = new Set(sessions.map((row) => row.wiseSessionId));
  const unseen = unseenRead.filter((row) => !rowIds.has(row.wiseSessionId));
  const firstWriterCall = new Map(writerCalls.map((row) => [row.wiseSessionId, validDate(row.at)]));
  const classes = new Map<string, Array<DailyClassFact & { workable: boolean }>>();
  const add = (endedAt: Date, fact: DailyClassFact & { workable: boolean }) => {
    const date = bangkokDateKey(endedAt);
    const day = classes.get(date);
    if (day) day.push(fact); else classes.set(date, [fact]);
  };
  for (const row of sessions) {
    if (!row.scheduledEndAt) continue;
    const { window, closed } = postingWindow(row.scheduledEndAt, row.deadlineAt, now);
    const eligibility = postingWindowEligibility({ teacherId: row.wiseTeacherUserId, window, history });
    const coverage = classifyCoverage({
      state: row.state,
      reason: row.reason,
      eligibility,
      windowClosed: closed,
      tutorWroteFirst: row.state === "skipped_human"
        ? tutorWroteFirst({ firstWriterCallAt: firstWriterCall.get(row.wiseSessionId) ?? null, firstHumanSaveAt: firstPersonSave.get(row.wiseSessionId) ?? null })
        : undefined,
    });
    add(row.scheduledEndAt, { tutorKey: tutorKeyFor(row.wiseTeacherUserId, rosterKeys), coverage, workable: eligibility.workable });
  }
  for (const row of unseen) {
    if (!row.scheduledEndAt) continue;
    const { window } = postingWindow(row.scheduledEndAt, row.deadlineAt, now);
    const eligibility = postingWindowEligibility({
      teacherId: row.wiseTeacherUserId,
      window,
      history,
      roster: row.wiseTeacherUserId ? rosterSpans.get(row.wiseTeacherUserId) ?? null : null,
    });
    const coverage = classifyCoverage({ state: null, reason: null, provenOnlineOneToOne: row.proven === true, eligibility });
    if (coverage === null) continue;
    add(row.scheduledEndAt, { tutorKey: tutorKeyFor(row.wiseTeacherUserId, rosterKeys), coverage, workable: eligibility.workable });
  }

  const tutorKeys = AUTOWRITER_TUTORS.map((tutor) => tutor.canonicalKey);
  const values: Array<typeof M.$inferInsert> = [];
  for (const date of dates) {
    const facts = classes.get(date) ?? [];
    const { start, end } = bangkokDayBounds(date);
    const counted = facts.some((fact) => fact.coverage === "posted" || (fact.coverage !== null && fact.workable && !fact.coverage.startsWith("excluded")));
    const liveMode = counted || recordedLiveDuring(history, start, end);
    const rows = buildDailyMetrics({
      tutorKeys,
      classes: facts,
      reviews: reviews.filter((row) => row.bangkokDate === date).map((row) => ({
        tutorKey: row.tutorKey,
        inclusionReason: row.inclusionReason as InclusionReason,
        measuredFixCount: row.measuredFixCount,
        correctionsVerified: row.correctionsVerified,
        verdict: row.verdict ? { verdict: row.verdict, severity: row.severity } : null,
      })),
    });
    for (const row of rows) values.push({ metricDate: date, liveMode, policyVersion: QUALITY_POLICY_VERSION, ...row });
  }
  return values;
}

/** Recompute and store the metric rows of the given Bangkok dates (all of the gate window on every run). */
export async function refreshDailyMetrics(db: Database, input: { dates: readonly string[]; now: Date }): Promise<number> {
  const dates = [...new Set(input.dates)].toSorted();
  if (dates.length === 0) return 0;
  await recordRosterAccounts(db, input.now);
  const values = await computeDailyMetrics(db, { dates, now: input.now });
  const updatable = Object.keys(values[0]).filter((key) => key !== "metricDate" && key !== "tutorKey");
  await db.insert(M).values(values).onConflictDoUpdate({
    target: [M.metricDate, M.tutorKey],
    set: {
      ...Object.fromEntries(updatable.map((key) => [key, sql.raw(`excluded.${metricColumnNames[key]}`)])),
      computedAt: sql`now()`,
    },
  });
  // A tutor key that no longer appears on a recomputed date (e.g. a class moved to another account) is dropped.
  const written = values.map((row) => `${row.metricDate}|${row.tutorKey}`);
  await db.delete(M).where(and(
    inArray(M.metricDate, dates),
    sql`(${M.metricDate}::text || '|' || ${M.tutorKey}) not in ${written}`,
  ));
  return values.length;
}

/**
 * The daily metrics of the gate window a run at `now` would store, computed without writing anything — the backfill's
 * dry run. The fix events are the dry run's own classification (the job's code over the same classes). Before
 * migration 0101 (`reviewTables: false`) the control history is the seed the migration writes (the control row at its
 * last update), the roster is the sightings the first run records, and no review exists yet.
 */
export async function previewDailyMetrics(db: Database, input: {
  now: Date;
  reviewTables: boolean;
  classifiedFixEvents: ReadonlyArray<{ wiseSessionId: string; actorKind: FixActorKind; eventAt: Date }>;
}): Promise<Array<typeof M.$inferInsert>> {
  const sightings = await rosterSightings(db, input.now);
  const stored = input.reviewTables ? await db.select().from(RA) : [];
  const roster = new Map<string, RosterAccountRow>(stored.map((row) => [row.wiseTeacherUserId, row]));
  for (const seen of sightings) {
    const before = roster.get(seen.wiseTeacherUserId);
    roster.set(seen.wiseTeacherUserId, before ? {
      ...seen,
      firstSeenAt: before.firstSeenAt.getTime() < seen.firstSeenAt.getTime() ? before.firstSeenAt : seen.firstSeenAt,
      lastSeenAt: before.lastSeenAt.getTime() > seen.lastSeenAt.getTime() ? before.lastSeenAt : seen.lastSeenAt,
    } : seen);
  }
  const overrides: DailyMetricOverrides = { rosterRows: [...roster.values()], firstPersonSave: firstPersonSavesOf(input.classifiedFixEvents) };
  if (!input.reviewTables) {
    const [control] = await db.select({ mode: C.mode, disabledTutors: C.disabledTutors, updatedAt: C.updatedAt }).from(C)
      .where(eq(C.id, "default")).limit(1);
    overrides.history = control ? [{ changedAt: control.updatedAt, mode: control.mode, disabledTutors: control.disabledTutors ?? [] }] : [];
    overrides.reviews = [];
  }
  return computeDailyMetrics(db, { dates: metricDates(input.now), now: input.now, overrides });
}

/** SQL: the autowriter row (if any) is not an in-person class (those are left out everywhere). */
const notInPersonSql = sql`not (coalesce(${S.state}, '') = 'skipped_scope' and coalesce(${S.reason}, '') in (${sql.join(ONSITE_REASONS.map((reason) => sql`${reason}`), sql`, `)}))`;

/**
 * Gate inputs for an inclusive window, straight from SQL (never a truncated page): the review rows with their
 * current verdicts and open flags, unresolved critical flags, posted classes whose first shot is not recorded, and
 * the all-tutor metrics. The dashboard shows exactly what the nightly row records.
 */
export async function loadGateFacts(db: Database, window: { start: string; end: string }): Promise<GateInput> {
  const from = bangkokDayBounds(window.start).start;
  const to = bangkokDayBounds(window.end).end;
  const [reviews, criticalFlags, unrecorded, unexplained, metrics] = await Promise.all([
    db.select({
      bangkokDate: R.bangkokDate,
      inclusionReason: R.inclusionReason,
      verdict: V.verdict,
      severity: V.severity,
      hasOpenFlag: sql<boolean>`exists (select 1 from feedback_autowriter_flags f
        where f.wise_session_id = feedback_autowriter_reviews.wise_session_id and f.resolved_by_verdict_id is null)`,
    }).from(R)
      .leftJoin(V, eq(V.id, R.currentVerdictId))
      .leftJoin(S, eq(S.wiseSessionId, R.wiseSessionId))
      .where(and(between(R.bangkokDate, window.start, window.end), notInPersonSql)),
    db.select({ total: count() }).from(FL).where(and(eq(FL.suggestedSeverity, "critical"), isNull(FL.resolvedByVerdictId))),
    db.select({ total: count() }).from(S).where(and(
      isNotNull(S.postStartedAt),
      sql`coalesce(${S.scheduledEndAt}, ${S.postStartedAt}) >= ${from} and coalesce(${S.scheduledEndAt}, ${S.postStartedAt}) < ${to}`,
      // Settled posts that may be in Wise, and POSTs still settling (their review row does not exist yet either).
      sql`(${S.state} in ('verified', 'verify_failed', 'unknown_outcome', 'posting', 'awaiting_event')
        or (${S.state} = 'rejected' and coalesce(${S.metadata} -> 'post' ->> 'stillAutoBlank', 'false') <> 'true'))`,
      sql`not exists (select 1 from feedback_autowriter_posts p
        where p.wise_session_id = feedback_autowriter_sessions.wise_session_id and p.kind = 'first_shot')`,
    )),
    // An API write no post explains blocks expansion until the owner has looked into it and acknowledged it.
    db.select({ total: count() }).from(INC).where(and(
      eq(INC.kind, "api_actor_unmatched"), eq(INC.severity, "critical"), isNull(INC.acknowledgedAt),
    )),
    db.select({ metricDate: M.metricDate, tutorKey: M.tutorKey, posted: M.posted, eligible: M.eligible })
      .from(M).where(and(eq(M.tutorKey, "*"), between(M.metricDate, window.start, window.end))),
  ]);
  return computeGateFacts({
    window,
    reviews: reviews.map((row) => ({
      bangkokDate: row.bangkokDate,
      inclusionReason: row.inclusionReason as InclusionReason,
      verdict: row.verdict ? { verdict: row.verdict, severity: row.severity } : null,
      hasOpenFlag: row.hasOpenFlag === true,
    })),
    unresolvedCriticalFlags: criticalFlags[0]?.total ?? 0,
    unrecordedPosts: unrecorded[0]?.total ?? 0,
    unexplainedApiWrites: unexplained[0]?.total ?? 0,
    metrics,
  });
}

export async function dailyGateRecorded(db: Database, date: string): Promise<boolean> {
  const [existing] = await db.select({ id: G.id }).from(G).where(and(eq(G.evalKind, "daily"), eq(G.bangkokDate, date))).limit(1);
  return Boolean(existing);
}

/** The daily gate row for `date` (append-only, one per date); null when it already exists. */
export async function recordDailyGate(db: Database, date: string): Promise<{ date: string; status: GateStatus } | null> {
  if (await dailyGateRecorded(db, date)) return null;
  const window = gateWindow(date);
  const facts = await loadGateFacts(db, window);
  const result = evaluateGate(facts);
  const inserted = await db.insert(G).values({
    evalKind: "daily",
    bangkokDate: date,
    windowStart: window.start,
    windowEnd: window.end,
    rosterTutors: AUTOWRITER_TUTORS.map((tutor) => tutor.canonicalKey),
    reviewed: facts.reviewed,
    accurate: facts.accurate,
    wilsonLower: result.wilsonLower,
    critical: facts.criticalVerdicts,
    pendingCriticalFlags: facts.unresolvedCriticalFlags,
    pendingFlaggedReviews: facts.pendingFlaggedReviews,
    requiredPending: facts.requiredPending,
    unrecordedPosts: facts.unrecordedPosts,
    unexplainedApiWrites: facts.unexplainedApiWrites,
    coverageNum: facts.coverageNum,
    coverageDen: facts.coverageDen,
    status: result.status,
    reasons: result.reasons,
    thresholds: { ...GATE_THRESHOLDS },
    createdBy: REVIEW_SYSTEM_ACTOR,
  }).onConflictDoNothing().returning({ id: G.id });
  return inserted.length > 0 ? { date, status: result.status } : null;
}

/**
 * The Wise activity mirror the gate reads fixes from: fresh when the latest full (first-page, all-event or
 * feedback-event) sync succeeded within GATE_ACTIVITY_MAX_AGE_MS and reached known events (a sync that stopped at
 * its page cap left older events unread). A stale mirror would hide a fix saved since. Read before the fix events
 * are derived, so a sync that finishes during the run cannot vouch for data the run did not read.
 */
export async function activityMirrorStatus(db: Database, now: Date): Promise<{ fresh: boolean; lastSuccessAt: string | null; reason: string | null }> {
  const [row] = await db.select({ finishedAt: WAR.finishedAt, stoppedReason: sql<string | null>`${WAR.metadata} ->> 'stoppedReason'` })
    .from(WAR).where(and(
      eq(WAR.status, "success"),
      isNotNull(WAR.finishedAt),
      sql`coalesce(${WAR.metadata} ->> 'startPage', '1') = '1'`,
      sql`coalesce(${WAR.metadata} ->> 'eventName', '') in ('', 'SessionFeedbackSubmittedEvent')`,
    )).orderBy(desc(WAR.finishedAt)).limit(1);
  const last = row?.finishedAt ?? null;
  const lastSuccessAt = last?.toISOString() ?? null;
  if (last === null || now.getTime() - last.getTime() > GATE_ACTIVITY_MAX_AGE_MS) {
    return { fresh: false, lastSuccessAt, reason: `activity_mirror_stale: last successful Wise activity sync ${lastSuccessAt ?? "never"}` };
  }
  if (row?.stoppedReason === "max_pages") {
    return { fresh: false, lastSuccessAt, reason: "activity_mirror_incomplete: the last Wise activity sync stopped at its page cap" };
  }
  return { fresh: true, lastSuccessAt, reason: null };
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

export interface ReviewJobDeps {
  db: Database;
  /** The Wise user behind the API key (`WISE_USER_ID`): its saves are ours. Missing → fix events are not derived. */
  apiActorId: string | null;
  /** False on preview deployments: the job never touches state there. */
  writesAllowedHere: boolean;
  triggerSource: "cron" | "admin" | "cli";
  channels: IncidentPushChannels;
  /** Wall-clock epoch ms the run must finish by (maxDuration headroom): incident pushes that cannot fit wait. */
  deadlineMs?: number;
  /** When an API save no post explains becomes critical (default: the autowriter's go-live). */
  unmatchedCriticalFrom?: Date;
  now?: () => Date;
  draw?: () => number;
  provenTutorKeys?: ReadonlySet<string>;
}

export interface ReviewJobResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  error?: string;
  syncRunId?: string;
  firstShots?: { recorded: number; unverified: number };
  fixEvents?: Omit<FixEventIngestResult, "changed">;
  reviewsCreated?: number;
  verificationFlags?: { flags: number; incidents: number };
  flags?: { flags: number; incidents: number };
  reviewCountsUpdated?: number;
  metricRows?: number;
  dailyGate?: { date: string; status: GateStatus } | null;
  /** Why the due daily gate row was not written this run (a later run of the day writes it). */
  dailyGateSkipped?: string;
  incidents?: DrainResult;
  undeliveredCritical?: number;
  stepErrors?: string[];
}

/** Single-flight on the database clock; a `running` row older than REVIEW_RUN_STALE_MS is failed first. */
async function startRun(db: Database, triggerSource: string): Promise<string | null> {
  await db.update(RUNS).set({
    status: "failed",
    finishedAt: sql`now()`,
    errorSummary: "Abandoned: the run did not finish within its time limit.",
  }).where(and(eq(RUNS.status, "running"), sql`${RUNS.startedAt} < now() - (${REVIEW_RUN_STALE_MS} * interval '1 millisecond')`));
  try {
    const [row] = await db.insert(RUNS).values({ triggerSource }).returning({ id: RUNS.id });
    return row.id;
  } catch (error) {
    if (sqlStateOf(error) === "23505") return null;
    throw error;
  }
}

function stepError(step: string, error: unknown): string {
  // Only the error's name and SQLSTATE: messages of database errors can carry lesson text in their parameters.
  const sqlState = sqlStateOf(error);
  return `${step}: ${error instanceof Error ? error.name : "Error"}${sqlState ? ` (${sqlState})` : ""}`;
}

export async function runReviewJob(deps: ReviewJobDeps): Promise<ReviewJobResult> {
  const { db } = deps;
  const clock = () => deps.now?.() ?? new Date();
  if (!deps.writesAllowedHere) return { ok: true, skipped: true, reason: "Preview deployment: the review job never runs here." };
  const runId = await startRun(db, deps.triggerSource);
  if (!runId) return { ok: true, skipped: true, reason: "Another review run is in progress." };

  const result: ReviewJobResult = { ok: true, syncRunId: runId };
  const errors: string[] = [];
  const failedSteps: string[] = [];
  const step = async <T>(name: string, work: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await work();
    } catch (error) {
      errors.push(stepError(name, error));
      failedSteps.push(name);
      return undefined;
    }
  };
  const drains: DrainResult[] = [];
  const drain = async (name: string, now: Date) => {
    const drained = await step(name, () => drainIncidentOutbox(db, deps.channels, now, { deadlineMs: deps.deadlineMs }));
    if (drained) drains.push(drained);
  };
  try {
    const now = clock();
    const since = new Date(now.getTime() - FIX_EVENT_LOOKBACK_MS);
    // Pushes already waiting go out first, whatever the rest of the run costs.
    await drain("incidents_waiting", now);
    // The mirror's state before any fix event is read from it (it vouches for this run's data only).
    const mirror = await step("activity_mirror", () => activityMirrorStatus(db, now));
    const shots = await step("first_shots", () => snapshotFirstShots(db));
    if (shots) result.firstShots = { recorded: shots.recorded, unverified: shots.unverified.length };
    const apiActorId = deps.apiActorId;
    if (!apiActorId) {
      // Fail closed: without our API user's id every save of ours would read as a stranger's (and a stranger's API
      // write as staff), so nothing is classified and the run is red until WISE_USER_ID is set.
      errors.push("fix_events: WISE_USER_ID is missing, so our API saves cannot be told apart (no fix events derived)");
      failedSteps.push("fix_events");
    } else {
      const fixes = await step("fix_events", () => ingestFixEvents(db, { apiActorId, since }));
      if (fixes) {
        result.fixEvents = { sessions: fixes.sessions, inserted: fixes.inserted, updated: fixes.updated, skippedInFlight: fixes.skippedInFlight };
      }
    }
    result.reviewsCreated = await step("reviews", () => assignReviews(db, { draw: deps.draw, provenTutorKeys: deps.provenTutorKeys, now }));
    result.verificationFlags = await step("verification_flags", () => raiseVerificationFlags(db));
    result.flags = await step("flags", () => raiseFixFlags(db, { since, criticalFrom: deps.unmatchedCriticalFrom }));
    result.reviewCountsUpdated = await step("review_counts", () => refreshReviewCounts(db, { sinceDate: bangkokDateKey(since) }));
    result.metricRows = await step("metrics", () => refreshDailyMetrics(db, { dates: metricDates(now), now }));

    // The daily row is append-only: record it only from a complete pass over a fresh mirror. Otherwise leave the
    // date for a later run (the same date is due until 21:59 the next day).
    const gateDate = dailyGateDate(now);
    result.dailyGate = null;
    const due = await step("gate_due", async () => !(await dailyGateRecorded(db, gateDate)));
    if (due) {
      if (failedSteps.length > 0) {
        result.dailyGateSkipped = `step_errors: ${failedSteps.join(", ")}`;
      } else if (mirror && !mirror.fresh) {
        result.dailyGateSkipped = mirror.reason ?? "activity_mirror_stale";
      } else if (mirror) {
        result.dailyGate = (await step("gate", () => recordDailyGate(db, gateDate))) ?? null;
      }
    }

    if (process.env.FEEDBACK_AUTOWRITER_ISEB_REVIEW_ENABLED === "true") {
      await step("iseb_style_review", () => reviewIsebPosts(db, deps.deadlineMs ?? Date.now() + 75_000));
    }
    // Incidents this run raised.
    await drain("incidents", now);
    if (drains.length > 0) {
      result.incidents = drains.reduce((total, next) => ({
        attempted: total.attempted + next.attempted,
        sent: total.sent + next.sent,
        failed: total.failed + next.failed,
        stillPending: total.stillPending + next.stillPending,
        deferred: total.deferred + next.deferred,
        errors: [...total.errors, ...next.errors],
      }));
    }
    // Red until every critical incident reached the owner or was acknowledged — a push that gave up, or one that
    // never got its turn, included.
    const undelivered = await step("incident_delivery", () => countUndeliveredCritical(db, now));
    if (undelivered !== undefined) result.undeliveredCritical = undelivered;
    const deferred = result.incidents?.deferred ?? 0;
    if ((undelivered ?? 0) > 0 || deferred > 0 || (result.incidents?.stillPending ?? 0) > 0) {
      errors.push(`Critical incident push not delivered: ${undelivered ?? "?"} undelivered, ${deferred} deferred `
        + `(acknowledge on the dashboard once handled): ${result.incidents?.errors.slice(0, 2).join(" | ") || "retrying"}`);
    }
  } finally {
    result.stepErrors = errors;
    result.ok = errors.length === 0;
    if (errors.length > 0) result.error = errors.join("; ").slice(0, 900);
    const counts: Record<string, unknown> = { ...result };
    delete counts.syncRunId;
    await db.update(RUNS).set({
      status: errors.length === 0 ? "succeeded" : "failed",
      finishedAt: sql`now()`,
      counts,
      errorSummary: errors.length > 0 ? errors.join("; ").slice(0, 900) : null,
    }).where(eq(RUNS.id, runId));
  }
  return result;
}
