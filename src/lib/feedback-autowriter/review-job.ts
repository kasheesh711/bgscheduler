import { randomBytes } from "node:crypto";
import { and, between, count, eq, gte, inArray, isNotNull, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { ingestFixEvents, type FixEventIngestResult } from "./fix-events";
import { normalizeFields, postedBilling, proveFirstShot, type FirstShotProof } from "./first-shot";
import { drainIncidentOutbox, recordIncident, type DrainResult, type IncidentPushChannels } from "./incidents";
import {
  GATE_THRESHOLDS,
  PROVEN_TUTOR_KEYS,
  SAMPLING_POLICY,
  QUALITY_POLICY_VERSION,
  addDays,
  bangkokDateKey,
  bangkokDayBounds,
  buildDailyMetrics,
  classifyCoverage,
  computeGateFacts,
  dailyGateDate,
  evaluateGate,
  gateWindow,
  reviewInclusion,
  type GateInput,
  type GateStatus,
  type InclusionReason,
} from "./quality";
import { AUTOWRITER_TEACHER_ALLOWLIST, AUTOWRITER_TUTORS, rosterTutor } from "./roster";
import type { AutowriterSessionRow } from "./store";
import { fieldsHash } from "./submit";

/**
 * The hourly review job of the operating loop (Phase 1, UTC minute 27 — after the :17 Wise activity sync).
 * Reads our own database only and never writes to Wise:
 *   a. snapshot the first shot of every settled posted class, proven against the POST claim's `body_hash`;
 *   b. derive fix events from Wise activity events;
 *   c. give each posted class its review row (inclusion drawn once, before any flag);
 *   d. flag classes a person fixed, and raise incidents for API writes no post explains;
 *   e. recompute daily metrics (last 3 Bangkok days plus days with fresh verdicts) and the daily gate row;
 *   f. push pending critical incidents.
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
const PC = schema.postClassSessions;

export const REVIEW_SYSTEM_ACTOR = "system:feedback-autowriter-review";
/** A `running` review run older than this is abandoned (maxDuration is 300 s). */
export const REVIEW_RUN_STALE_MS = 15 * 60 * 1000;
const FIX_EVENT_LOOKBACK_MS = 45 * 24 * 60 * 60 * 1000;
const METRIC_RECOMPUTE_DAYS = 3;
/** A roster class is "unseen" only this long after it ended: by then the sweep or the webhook has made its row. */
const UNSEEN_AFTER_END_MS = 2 * 60 * 60 * 1000;
const SETTLED_POST_STATES = ["verified", "rejected", "unknown_outcome", "verify_failed"] as const;
const HUMAN_FIX_KINDS = ["owner_web", "tutor", "other_staff"] as const;
const ONLINE_TITLE_SQL = "^\\s*(online|live)\\y";
const IN_PERSON_TITLE_SQL = "^\\s*(in[\\s-]?person|on[\\s-]?site)\\y";

/** Uniform in [0, 1) from the crypto RNG (48 bits). */
export function uniformDraw(): number {
  return randomBytes(6).readUIntBE(0, 6) / 2 ** 48;
}

/** A tutor's canonical key (both Wise accounts), or the account id for someone no longer on the roster. */
export function tutorKeyFor(wiseTeacherUserId: string | null): string {
  return rosterTutor(wiseTeacherUserId)?.canonicalKey ?? wiseTeacherUserId ?? "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validDate(value: unknown): Date | null {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: unknown; cause?: { code?: unknown } } | null;
  return typeof candidate === "object" && candidate !== null &&
    (candidate.code === "23505" || candidate.cause?.code === "23505");
}

// ---------------------------------------------------------------------------
// a. First shots
// ---------------------------------------------------------------------------

/**
 * The posts row for a proven first shot. Its pipeline stamp is the POST claim's (`metadata.pipeline` plus
 * `postedFromCommit`); rows posted before Phase 0 have none.
 */
export function firstShotPostValues(
  row: AutowriterSessionRow,
  proof: FirstShotProof,
  provenance: "snapshot" | "backfill",
): typeof P.$inferInsert {
  const metadata = isRecord(row.metadata) ? row.metadata : {};
  const post = isRecord(metadata.post) ? metadata.post : {};
  const expected = isRecord(metadata.expected) ? metadata.expected : {};
  const stamp = isRecord(metadata.pipeline) ? metadata.pipeline : null;
  const postedFromCommit = typeof metadata.postedFromCommit === "string" ? metadata.postedFromCommit : null;
  const verifiedAt = validDate(isRecord(row.verifiedEvent) ? row.verifiedEvent.at : null);
  const outcome = (SETTLED_POST_STATES as readonly string[]).includes(row.state)
    ? row.state as (typeof SETTLED_POST_STATES)[number]
    : "unknown_outcome";
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
 * after posting (the one-time nickname fix) no longer does: it is left for the backfill script, with an info incident.
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
      await recordIncident(db, {
        dedupeKey: `first_shot_unverified:${row.wiseSessionId}`,
        kind: "first_shot_unverified",
        severity: "info",
        wiseSessionId: row.wiseSessionId,
        summary: "The stored text no longer proves the posted body (edited after posting): run the review backfill.",
        detail: { state: row.state, nicknameFix: isRecord(row.metadata) && "nicknameFix" in row.metadata },
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

/** One review row per verified first shot; inclusion is drawn here, once, before any flag can exist. */
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
      eq(P.outcome, "verified"),
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

/**
 * Idempotent over every fix event in the look-back: a person's save after our first post flags the class
 * (`measured_fix`); an API save no post explains raises a critical incident and, after our first post, a flag.
 */
export async function raiseFixFlags(db: Database, input: { since: Date }): Promise<{ flags: number; incidents: number }> {
  const events = await db.select().from(FX).where(and(
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
    if (unmatched && await recordIncident(db, {
      dedupeKey: `api_actor_unmatched:${event.wiseEventId}`,
      kind: "api_actor_unmatched",
      severity: "critical",
      wiseSessionId: event.wiseSessionId,
      summary: `A feedback save by the Wise API user at ${event.eventAt.toISOString()} matches no recorded autowriter post`,
      detail: { wiseEventId: event.wiseEventId, eventAt: event.eventAt.toISOString() },
    })) incidents += 1;
    if (!event.countsAsFix) continue;
    const source = unmatched ? "api_unmatched" : "measured_fix";
    const inserted = await db.insert(FL).values({
      wiseSessionId: event.wiseSessionId,
      source,
      note: `${ACTOR_LABEL[event.actorKind] ?? event.actorKind} saved the feedback at ${event.eventAt.toISOString()}`,
      createdBy: REVIEW_SYSTEM_ACTOR,
      idempotencyKey: `${source}:${event.wiseEventId}`,
    }).onConflictDoNothing().returning({ id: FL.id });
    if (inserted.length === 0) continue;
    flags += 1;
    await db.update(R).set({
      flaggedAt: sql`coalesce(feedback_autowriter_reviews.flagged_at, now())`,
      flagSources: sql`array(select distinct unnest(feedback_autowriter_reviews.flag_sources || array[${source}]::text[]) order by 1)`,
      updatedAt: sql`now()`,
    }).where(eq(R.wiseSessionId, event.wiseSessionId));
  }
  return { flags, incidents };
}

/** Measured fixes (every counted save, corrections included) and verified corrections per review. */
export async function refreshReviewCounts(db: Database, input: { sinceDate: string }): Promise<number> {
  const fixes = sql`(select count(*)::int from feedback_autowriter_fix_events f
    where f.wise_session_id = feedback_autowriter_reviews.wise_session_id and f.counts_as_fix)`;
  const corrections = sql`(select count(*)::int from feedback_autowriter_posts p
    where p.wise_session_id = feedback_autowriter_reviews.wise_session_id and p.kind = 'correction' and p.outcome = 'verified')`;
  const rows = await db.update(R).set({ measuredFixCount: fixes, correctionsVerified: corrections, updatedAt: sql`now()` })
    .where(and(
      gte(R.bangkokDate, input.sinceDate),
      sql`(feedback_autowriter_reviews.measured_fix_count, feedback_autowriter_reviews.corrections_verified)
        is distinct from (${fixes}, ${corrections})`,
    )).returning({ id: R.wiseSessionId });
  return rows.length;
}

// ---------------------------------------------------------------------------
// e. Daily metrics and the gate
// ---------------------------------------------------------------------------

/**
 * Recompute the metric rows of the given Bangkok dates. A date counts as live when the autowriter posted on it,
 * when the job saw mode `live` during it, or when an earlier run already said so (sticky). A roster class the
 * autowriter never saw is a miss only when proven online one-to-one, and not while its tutor is switched off (the
 * sweep does not shortlist their classes; the recomputed days are recent, so today's switches stand in for then).
 */
export async function refreshDailyMetrics(db: Database, input: {
  dates: readonly string[];
  now: Date;
  liveNow: boolean;
  disabledTutors?: readonly string[];
}): Promise<number> {
  const disabled = new Set(input.disabledTutors ?? []);
  const today = bangkokDateKey(input.now);
  const rosterIds = [...AUTOWRITER_TEACHER_ALLOWLIST];
  let written = 0;
  for (const date of [...new Set(input.dates)]) {
    const { start, end } = bangkokDayBounds(date);
    const unseenBefore = new Date(Math.min(end.getTime(), input.now.getTime() - UNSEEN_AFTER_END_MS));
    const [sessions, unseen, reviews, posted, previous] = await Promise.all([
      db.select({ wiseTeacherUserId: S.wiseTeacherUserId, state: S.state, reason: S.reason }).from(S)
        .where(and(gte(S.scheduledEndAt, start), lt(S.scheduledEndAt, end))),
      db.select({
        wiseTeacherUserId: PC.wiseTeacherUserId,
        proven: sql<boolean>`(
          exists (select 1 from past_session_blocks b where b.wise_session_id = post_class_sessions.wise_session_id
            and b.session_type = 'SCHEDULED' and b.class_type = 'ONE_TO_ONE' and coalesce(b.title, '') !~* ${IN_PERSON_TITLE_SQL})
          or (select count(distinct c.wise_student_id) from credit_control_sessions c
            where c.snapshot_id = (select s.id from credit_control_snapshots s where s.active order by s.generated_at desc limit 1)
              and c.wise_session_id = post_class_sessions.wise_session_id and c.title ~* ${ONLINE_TITLE_SQL}) = 1
        )`,
      }).from(PC).where(and(
        inArray(PC.wiseTeacherUserId, rosterIds),
        gte(PC.scheduledEndAt, start),
        lt(PC.scheduledEndAt, unseenBefore),
        or(isNull(PC.finalStatus), notInArray(PC.finalStatus, ["CANCELLED", "CANCELED", "NO_SHOW", "DELETED"])),
        isNull(PC.wiseDeletedAt),
        sql`not exists (select 1 from feedback_autowriter_sessions a where a.wise_session_id = post_class_sessions.wise_session_id)`,
      )),
      db.select({
        tutorKey: R.tutorKey,
        inclusionReason: R.inclusionReason,
        measuredFixCount: R.measuredFixCount,
        correctionsVerified: R.correctionsVerified,
        verdict: V.verdict,
        severity: V.severity,
      }).from(R).leftJoin(V, eq(V.id, R.currentVerdictId)).where(eq(R.bangkokDate, date)),
      db.select({ total: count() }).from(P).where(and(eq(P.kind, "first_shot"), gte(P.postStartedAt, start), lt(P.postStartedAt, end))),
      db.select({ liveMode: M.liveMode }).from(M).where(and(eq(M.metricDate, date), eq(M.tutorKey, "*"))).limit(1),
    ]);
    const liveMode = Boolean(previous[0]?.liveMode) || (posted[0]?.total ?? 0) > 0 || (input.liveNow && date === today);
    const rows = buildDailyMetrics({
      tutorKeys: AUTOWRITER_TUTORS.map((tutor) => tutor.canonicalKey),
      classes: [
        ...sessions.map((row) => ({ tutorKey: tutorKeyFor(row.wiseTeacherUserId), coverage: classifyCoverage({ state: row.state, reason: row.reason }) })),
        ...unseen.map((row) => ({
          tutorKey: tutorKeyFor(row.wiseTeacherUserId),
          coverage: row.wiseTeacherUserId && disabled.has(row.wiseTeacherUserId) && row.proven === true
            ? "excluded_tutor_off" as const
            : classifyCoverage({ state: null, reason: null, provenOnlineOneToOne: row.proven === true }),
        })),
      ],
      reviews: reviews.map((row) => ({
        tutorKey: row.tutorKey,
        inclusionReason: row.inclusionReason as InclusionReason,
        measuredFixCount: row.measuredFixCount,
        correctionsVerified: row.correctionsVerified,
        verdict: row.verdict ? { verdict: row.verdict, severity: row.severity } : null,
      })),
    });
    for (const row of rows) {
      const values = { metricDate: date, liveMode, policyVersion: QUALITY_POLICY_VERSION, ...row };
      await db.insert(M).values(values).onConflictDoUpdate({
        target: [M.metricDate, M.tutorKey],
        set: { ...Object.fromEntries(Object.entries(values).filter(([key]) => key !== "metricDate" && key !== "tutorKey")), computedAt: sql`now()` },
      });
      written += 1;
    }
  }
  return written;
}

/** Gate inputs for an inclusive window, straight from the review rows (current verdicts, open flags) and metrics. */
export async function loadGateFacts(db: Database, window: { start: string; end: string }): Promise<GateInput> {
  const [reviews, criticalFlags, metrics] = await Promise.all([
    db.select({
      bangkokDate: R.bangkokDate,
      inclusionReason: R.inclusionReason,
      verdict: V.verdict,
      severity: V.severity,
      hasOpenFlag: sql<boolean>`exists (select 1 from feedback_autowriter_flags f
        where f.wise_session_id = feedback_autowriter_reviews.wise_session_id and f.resolved_by_verdict_id is null)`,
    }).from(R).leftJoin(V, eq(V.id, R.currentVerdictId)).where(between(R.bangkokDate, window.start, window.end)),
    db.select({ total: count() }).from(FL).where(and(eq(FL.suggestedSeverity, "critical"), isNull(FL.resolvedByVerdictId))),
    db.select({ metricDate: M.metricDate, tutorKey: M.tutorKey, liveMode: M.liveMode, posted: M.posted, eligible: M.eligible })
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
    metrics,
  });
}

/** The daily gate row for `date` (append-only, one per date); null when it already exists. */
export async function recordDailyGate(db: Database, date: string): Promise<{ date: string; status: GateStatus } | null> {
  const [existing] = await db.select({ id: G.id }).from(G).where(and(eq(G.evalKind, "daily"), eq(G.bangkokDate, date))).limit(1);
  if (existing) return null;
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
    wilsonLower: result.wilsonLower.toFixed(4),
    critical: facts.criticalVerdicts,
    pendingCriticalFlags: facts.unresolvedCriticalFlags,
    pendingFlaggedReviews: facts.pendingFlaggedReviews,
    coverageNum: facts.coverageNum,
    coverageDen: facts.coverageDen,
    status: result.status,
    reasons: result.reasons,
    thresholds: { ...GATE_THRESHOLDS },
    createdBy: REVIEW_SYSTEM_ACTOR,
  }).onConflictDoNothing().returning({ id: G.id });
  return inserted.length > 0 ? { date, status: result.status } : null;
}

/** Dates to recompute: the last three Bangkok days, plus any day in the gate window with a verdict since yesterday. */
export async function metricDatesToRefresh(db: Database, now: Date): Promise<string[]> {
  const today = bangkokDateKey(now);
  const recent = Array.from({ length: METRIC_RECOMPUTE_DAYS }, (_, index) => addDays(today, -index));
  const reviewed = await db.selectDistinct({ date: R.bangkokDate }).from(R).where(and(
    gte(R.reviewedAt, new Date(now.getTime() - 26 * 60 * 60 * 1000)),
    gte(R.bangkokDate, gateWindow(today).start),
  ));
  return [...new Set([...recent, ...reviewed.map((row) => row.date)])].toSorted();
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

export interface ReviewJobDeps {
  db: Database;
  /** The Wise user behind the API key (`WISE_USER_ID`): its saves are ours. */
  apiActorId: string | null;
  /** False on preview deployments: the job never touches state there. */
  writesAllowedHere: boolean;
  triggerSource: "cron" | "admin" | "cli";
  channels: IncidentPushChannels;
  /** The control row's mode right now (a date seen live counts for coverage). */
  liveNow: boolean;
  /** Roster accounts switched off right now (their unseen classes are not misses). */
  disabledTutors?: readonly string[];
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
  flags?: { flags: number; incidents: number };
  reviewCountsUpdated?: number;
  metricRows?: number;
  dailyGate?: { date: string; status: GateStatus } | null;
  incidents?: DrainResult;
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
    if (isUniqueViolation(error)) return null;
    throw error;
  }
}

function stepError(step: string, error: unknown): string {
  // Only the error's name and SQLSTATE: messages of database errors can carry lesson text in their parameters.
  const code = (error as { code?: unknown; cause?: { code?: unknown } } | null);
  const sqlState = typeof code?.code === "string" ? code.code : typeof code?.cause?.code === "string" ? code.cause.code : null;
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
  const step = async <T>(name: string, work: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await work();
    } catch (error) {
      errors.push(stepError(name, error));
      return undefined;
    }
  };
  try {
    const now = clock();
    const since = new Date(now.getTime() - FIX_EVENT_LOOKBACK_MS);
    const shots = await step("first_shots", () => snapshotFirstShots(db));
    if (shots) result.firstShots = { recorded: shots.recorded, unverified: shots.unverified.length };
    const fixes = await step("fix_events", () => ingestFixEvents(db, { apiActorId: deps.apiActorId, since }));
    if (fixes) result.fixEvents = { sessions: fixes.sessions, inserted: fixes.inserted, updated: fixes.updated };
    result.reviewsCreated = await step("reviews", () => assignReviews(db, { draw: deps.draw, provenTutorKeys: deps.provenTutorKeys, now }));
    result.flags = await step("flags", () => raiseFixFlags(db, { since }));
    result.reviewCountsUpdated = await step("review_counts", () => refreshReviewCounts(db, { sinceDate: bangkokDateKey(since) }));
    const dates = await step("metric_dates", () => metricDatesToRefresh(db, now));
    if (dates) {
      result.metricRows = await step("metrics", () => refreshDailyMetrics(db, { dates, now, liveNow: deps.liveNow, disabledTutors: deps.disabledTutors }));
    }
    result.dailyGate = (await step("gate", () => recordDailyGate(db, dailyGateDate(now)))) ?? null;
    const drained = await step("incidents", () => drainIncidentOutbox(db, deps.channels, now));
    if (drained) {
      result.incidents = drained;
      if (drained.stillPending > 0 || drained.failed > 0) {
        errors.push(`Critical incident push not delivered: ${drained.errors.slice(0, 2).join(" | ") || "retrying"}`);
      }
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
