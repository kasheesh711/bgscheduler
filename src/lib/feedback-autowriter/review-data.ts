import { and, desc, eq, gte, inArray, isNull, or, sql, count } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { POST_CLASS_FEEDBACK_FIELDS, type FeedbackFieldAnswers } from "@/lib/post-class-feedback/types";
import { wiseSessionLink } from "@/lib/wise/links";
import { isOnsiteSkip } from "./dashboard";
import { isMissingRelationError, sqlStateOf } from "./db-errors";
import { problemCodes } from "./first-shot";
import {
  GATE_THRESHOLDS,
  PROVEN_TUTOR_KEYS,
  addDays,
  bangkokDateKey,
  countsTowardFix,
  emptyCoverageCounts,
  evaluateGate,
  fixRoundBucket,
  gateWindow,
  isAccurate,
  isRequiredReview,
  nextExpansionSize,
  wilsonLowerBound,
  type CoverageCounts,
  type GateInput,
  type GateStatus,
  type InclusionReason,
} from "./quality";
import { loadGateFacts } from "./review-job";
import { AUTOWRITER_TUTORS, rosterTutor, tutorLabel } from "./roster";
import type { AutowriterSessionRow } from "./store";

/**
 * The Quality and Review tabs of the autowriter dashboard (Phase 1 of the operating loop). Read-only; the pure
 * `buildAutowriterReview` shapes rows loaded by `loadAutowriterReview`. The gate shown is computed by the same SQL
 * as the nightly row (`loadGateFacts`), never from the page's rows. In-person classes stay hidden, as on the
 * overview (`isOnsiteSkip`).
 */

const R = schema.feedbackAutowriterReviews;
const P = schema.feedbackAutowriterPosts;
const V = schema.feedbackAutowriterVerdicts;
const FL = schema.feedbackAutowriterFlags;
const FX = schema.feedbackAutowriterFixEvents;
const M = schema.feedbackAutowriterDailyMetrics;
const G = schema.feedbackAutowriterGateEvaluations;
const I = schema.feedbackAutowriterIncidents;
const RUNS = schema.feedbackAutowriterReviewRuns;
const S = schema.feedbackAutowriterSessions;
const PC = schema.postClassSessions;
const PCV = schema.postClassFeedbackVersions;

/** Classes older than this leave the queue once reviewed and unflagged. */
export const REVIEW_QUEUE_DAYS = 30;
/** Reviewed, unflagged classes shown (every flagged and every unreviewed required class is always shown). */
export const QUEUE_LIMIT = 300;
/** Unreviewed required classes loaded at most (far above a day's posts; the count is exact regardless). */
const UNREVIEWED_LIMIT = 500;

type Field = (typeof POST_CLASS_FEEDBACK_FIELDS)[number];

// ---------------------------------------------------------------------------
// Word diff
// ---------------------------------------------------------------------------

export interface DiffSegment {
  kind: "same" | "added" | "removed";
  text: string;
}

/** Above this many token pairs the diff is shown as a whole replacement. */
const DIFF_MAX_CELLS = 250_000;

/** Word-level diff (whitespace kept as its own tokens), adjacent segments of one kind merged. */
export function diffWords(before: string, after: string): DiffSegment[] {
  const a = before.split(/(\s+)/u).filter(Boolean);
  const b = after.split(/(\s+)/u).filter(Boolean);
  const push = (segments: DiffSegment[], kind: DiffSegment["kind"], text: string) => {
    const last = segments.at(-1);
    if (last && last.kind === kind) last.text += text;
    else segments.push({ kind, text });
  };
  if (a.length * b.length > DIFF_MAX_CELLS) {
    const whole: DiffSegment[] = [];
    if (before) push(whole, "removed", before);
    if (after) push(whole, "added", after);
    return whole;
  }
  // Longest common subsequence table, from the end.
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const segments: DiffSegment[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push(segments, "same", a[i]);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      push(segments, "removed", a[i]);
      i += 1;
    } else {
      push(segments, "added", b[j]);
      j += 1;
    }
  }
  for (; i < a.length; i += 1) push(segments, "removed", a[i]);
  for (; j < b.length; j += 1) push(segments, "added", b[j]);
  return segments;
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

export interface ReviewVerdictView {
  id: string;
  verdict: "approve" | "needs_fix";
  severity: schema.AutowriterVerdictSeverity | null;
  criticalCategory: schema.AutowriterCriticalCategory | null;
  note: string | null;
  reviewer: string;
  source: "dashboard" | "backfill";
  /** The judgement this verdict downgraded (a noted, confirmed owner act), or null. */
  downgradedFrom: "critical" | "factual" | null;
  createdAt: string;
  current: boolean;
}

export interface ReviewQueueItem {
  wiseSessionId: string;
  wiseUrl: string | null;
  className: string | null;
  tutor: string;
  tutorKey: string;
  classEndedAt: string | null;
  bangkokDate: string;
  inclusionReason: InclusionReason;
  required: boolean;
  status: "needs_review" | "flagged" | "reviewed" | "optional";
  openFlags: Array<{
    id: string;
    source: string;
    note: string | null;
    suggestedSeverity: schema.AutowriterVerdictSeverity | null;
    suggestedCategory: schema.AutowriterCriticalCategory | null;
    createdAt: string;
  }>;
  firstShot: {
    postId: string;
    fields: FeedbackFieldAnswers;
    fieldsSha256: string;
    provenance: "snapshot" | "live" | "backfill";
    method: string | null;
    postStartedAt: string | null;
    arm: string | null;
    evidence: string | null;
    /** `verified`, or a landed-but-unverified outcome the owner must judge. */
    outcome: string;
    problems: string[];
  };
  current: { fields: FeedbackFieldAnswers; source: "first_shot" | "correction" | "wise_feedback_version"; at: string | null };
  changed: boolean;
  diff: Array<{ field: Field; segments: DiffSegment[] }>;
  corrections: Array<{ actor: string; reason: string | null; outcome: string; at: string | null; provenance: string }>;
  /** Every save in Wise; `counted` = a measured fix now (a save after the current Approve is listed, not counted). */
  fixEvents: Array<{ wiseEventId: string; at: string; actorKind: string; countsAsFix: boolean; counted: boolean }>;
  measuredFixCount: number;
  measuredFixesByActor: Record<string, number>;
  verdicts: ReviewVerdictView[];
  currentVerdict: ReviewVerdictView | null;
}

export interface QualityDailyRow {
  date: string;
  liveMode: boolean;
  posted: number;
  required: number;
  reviewed: number;
  requiredPending: number;
  accurate: number;
  cosmetic: number;
  factual: number;
  critical: number;
  eligible: number;
  coverage: number | null;
  measuredFixClasses: number;
  correctionsVerified: number;
}

export interface QualityTutorRow {
  tutorKey: string;
  displayName: string;
  phase: "full_review" | "sampled";
  /** Review rows in the window: every first shot whose text may be in Wise. */
  textsInWise: number;
  reviewed: number;
  accurate: number;
  wilsonLower: number;
  requiredPending: number;
  coverage: number | null;
  coverageNum: number;
  coverageDen: number;
  measuredFixClasses: number;
}

/** The review tables cannot be read: not created yet (migration 0100), or a load failure (not the same thing). */
export interface AutowriterReviewUnavailable {
  available: false;
  reason: "review_tables_missing" | "load_failed";
}

export interface AutowriterReview {
  available: true;
  generatedAt: string;
  window: { start: string; end: string; days: number };
  gate: {
    status: GateStatus;
    wilsonLower: number;
    coverage: number | null;
    reasons: string[];
    reviewed: number;
    accurate: number;
    criticalVerdicts: number;
    unresolvedCriticalFlags: number;
    pendingFlaggedReviews: number;
    requiredPending: number;
    unrecordedPosts: number;
    unexplainedApiWrites: number;
    coverageNum: number;
    coverageDen: number;
    thresholds: { passLowerBound: number; headStartLowerBound: number; minCoverage: number };
    lastDaily: { date: string; status: GateStatus; wilsonLower: number; createdAt: string } | null;
    currentTutors: number;
    nextExpansionSize: number;
  };
  coverage: CoverageCounts & { heldAbsence: number };
  fixRounds: { zero: number; one: number; two: number; threePlus: number; unresolved: number };
  daily: QualityDailyRow[];
  tutors: QualityTutorRow[];
  queue: ReviewQueueItem[];
  /** Exact counts behind the filters (the queue itself may be a subset: `shown`). */
  queueTotals: { needsReview: number; flagged: number; all: number; shown: number };
  incidents: Array<{
    id: string;
    kind: string;
    severity: "critical" | "info";
    summary: string;
    wiseSessionId: string | null;
    pushStatus: string;
    lastPushError: string | null;
    acknowledgedAt: string | null;
    acknowledgedBy: string | null;
    createdAt: string;
  }>;
  lastRun: { status: string; startedAt: string; finishedAt: string | null; errorSummary: string | null; dailyGateSkipped: string | null } | null;
}

type ReviewRow = typeof R.$inferSelect;
type PostRow = typeof P.$inferSelect;
type VerdictRow = typeof V.$inferSelect;
type FlagRow = typeof FL.$inferSelect;
type MetricRow = typeof M.$inferSelect;

export interface ReviewSourceRows {
  /** The gate as the nightly job computes it (`loadGateFacts` over the dashboard window). */
  gateFacts: GateInput;
  /** Every review row in the window (unbounded): per-tutor rows and fix rounds. */
  windowReviews: readonly ReviewRow[];
  /** The queue's rows: every flagged and unreviewed required class, then the latest others up to the limit. */
  queueReviews: readonly ReviewRow[];
  queueTotals: { needsReview: number; flagged: number; all: number };
  posts: readonly PostRow[];
  verdicts: readonly VerdictRow[];
  flags: readonly FlagRow[];
  fixEvents: ReadonlyArray<{ wiseEventId: string; wiseSessionId: string; eventAt: Date; actorKind: string; countsAsFix: boolean }>;
  sessions: ReadonlyArray<{
    wiseSessionId: string;
    wiseClassId: string | null;
    wiseTeacherUserId: string | null;
    state: AutowriterSessionRow["state"];
    reason: string | null;
    className: string | null;
  }>;
  currentVersions: ReadonlyArray<{ wiseSessionId: string; observedAt: Date; fields: FeedbackFieldAnswers }>;
  metrics: readonly MetricRow[];
  lastDailyGate: typeof G.$inferSelect | null;
  incidents: ReadonlyArray<typeof I.$inferSelect>;
  lastRun: typeof RUNS.$inferSelect | null;
}

function asFields(value: unknown): FeedbackFieldAnswers {
  const record = (value ?? {}) as Record<string, unknown>;
  return Object.fromEntries(POST_CLASS_FEEDBACK_FIELDS.map((field) => [field, typeof record[field] === "string" ? record[field] : ""])) as FeedbackFieldAnswers;
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function postTime(post: PostRow): number {
  return (post.postFinishedAt ?? post.postStartedAt ?? post.recordedAt).getTime();
}

function verdictView(row: VerdictRow, currentId: string | null): ReviewVerdictView {
  return {
    id: row.id,
    verdict: row.verdict,
    severity: row.severity,
    criticalCategory: row.criticalCategory,
    note: row.note,
    reviewer: row.reviewer,
    source: row.source,
    downgradedFrom: row.downgradedFrom,
    createdAt: row.createdAt.toISOString(),
    current: row.id === currentId,
  };
}

/** Pure shaping of the Quality and Review tabs. */
export function buildAutowriterReview(input: { now: Date } & ReviewSourceRows): AutowriterReview {
  const today = bangkokDateKey(input.now);
  const window = gateWindow(today);
  const inWindow = (date: string) => date >= window.start && date <= window.end;
  const sessions = new Map(input.sessions.map((row) => [row.wiseSessionId, row]));
  const verdictsById = new Map(input.verdicts.map((row) => [row.id, row]));
  const openFlags = input.flags.filter((flag) => flag.resolvedByVerdictId === null);
  const notInPerson = (review: ReviewRow) => {
    const session = sessions.get(review.wiseSessionId);
    return !session || !isOnsiteSkip(session);
  };
  const currentVerdictOf = (review: ReviewRow) => review.currentVerdictId ? verdictsById.get(review.currentVerdictId) ?? null : null;
  const gate = evaluateGate(input.gateFacts);

  const windowMetrics = input.metrics.filter((row) => inWindow(row.metricDate));
  const coverage = { ...emptyCoverageCounts(), heldAbsence: 0 };
  for (const row of windowMetrics.filter((metric) => metric.tutorKey === "*")) {
    coverage.posted += row.posted;
    coverage.miss_held += row.held;
    coverage.heldAbsence += row.heldAbsence;
    coverage.miss_late += row.late;
    coverage.miss_expired += row.expired;
    coverage.miss_failed += row.failed;
    coverage.miss_unseen += row.unseen;
    coverage.excluded_tutor_first += row.excludedTutorFirst;
    coverage.excluded_tutor_off += row.excludedTutorOff;
    coverage.excluded_not_live += row.excludedNotLive;
    coverage.excluded_scope += row.excludedScope;
    coverage.pending += row.pending;
  }

  const windowReviews = input.windowReviews.filter((review) => inWindow(review.bangkokDate) && notInPerson(review));
  const fixRounds = { zero: 0, one: 0, two: 0, threePlus: 0, unresolved: 0 };
  for (const review of windowReviews) fixRounds[fixRoundBucket(currentVerdictOf(review), review.measuredFixCount)] += 1;

  const daily: QualityDailyRow[] = windowMetrics.filter((row) => row.tutorKey === "*")
    .toSorted((a, b) => b.metricDate.localeCompare(a.metricDate))
    .map((row) => ({
      date: row.metricDate,
      liveMode: row.liveMode,
      posted: row.posted,
      required: row.required,
      reviewed: row.reviewed,
      requiredPending: row.requiredPending,
      accurate: row.accurate,
      cosmetic: row.cosmetic,
      factual: row.factual,
      critical: row.critical,
      eligible: row.eligible,
      coverage: row.eligible > 0 ? row.posted / row.eligible : null,
      measuredFixClasses: row.measuredFixClasses,
      correctionsVerified: row.correctionsVerified,
    }));

  const tutors: QualityTutorRow[] = AUTOWRITER_TUTORS.map((tutor) => {
    const tutorReviews = windowReviews.filter((review) => review.tutorKey === tutor.canonicalKey);
    const counted = tutorReviews.flatMap((review) => {
      const verdict = currentVerdictOf(review);
      return isRequiredReview(review.inclusionReason) && verdict ? [verdict] : [];
    });
    const accurate = counted.filter((verdict) => isAccurate(verdict)).length;
    const rows = windowMetrics.filter((row) => row.tutorKey === tutor.canonicalKey);
    const coverageNum = rows.reduce((sum, row) => sum + row.posted, 0);
    const coverageDen = rows.reduce((sum, row) => sum + row.eligible, 0);
    return {
      tutorKey: tutor.canonicalKey,
      displayName: tutor.label,
      phase: PROVEN_TUTOR_KEYS.has(tutor.canonicalKey) ? "sampled" : "full_review",
      textsInWise: tutorReviews.length,
      reviewed: counted.length,
      accurate,
      wilsonLower: wilsonLowerBound(accurate, counted.length),
      requiredPending: tutorReviews.filter((review) => isRequiredReview(review.inclusionReason) && !review.currentVerdictId).length,
      coverage: coverageDen > 0 ? coverageNum / coverageDen : null,
      coverageNum,
      coverageDen,
      measuredFixClasses: tutorReviews.filter((review) => review.measuredFixCount > 0).length,
    };
  });

  const queue = input.queueReviews
    .filter(notInPerson)
    .toSorted((a, b) => (b.classEndedAt?.getTime() ?? 0) - (a.classEndedAt?.getTime() ?? 0))
    .flatMap((review): ReviewQueueItem[] => {
      const posts = input.posts.filter((post) => post.wiseSessionId === review.wiseSessionId);
      const firstShot = posts.find((post) => post.id === review.firstPostId);
      if (!firstShot) return [];
      const session = sessions.get(review.wiseSessionId);
      const corrections = posts.filter((post) => post.kind === "correction").toSorted((a, b) => postTime(a) - postTime(b));
      const latestPost = corrections.filter((post) => post.outcome === "verified").at(-1) ?? firstShot;
      const version = input.currentVersions.find((row) => row.wiseSessionId === review.wiseSessionId);
      const firstFields = asFields(firstShot.fields);
      const current = version && version.observedAt.getTime() > postTime(latestPost)
        ? { fields: version.fields, source: "wise_feedback_version" as const, at: version.observedAt.toISOString() }
        : {
          fields: asFields(latestPost.fields),
          source: latestPost === firstShot ? "first_shot" as const : "correction" as const,
          at: iso(latestPost.postFinishedAt ?? latestPost.postStartedAt),
        };
      const diff = POST_CLASS_FEEDBACK_FIELDS
        .filter((field) => firstFields[field] !== current.fields[field])
        .map((field) => ({ field, segments: diffWords(firstFields[field], current.fields[field]) }));
      const currentVerdict = currentVerdictOf(review);
      const verdicts = input.verdicts.filter((row) => row.wiseSessionId === review.wiseSessionId)
        .toSorted((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map((row) => verdictView(row, review.currentVerdictId));
      const flags = openFlags.filter((flag) => flag.wiseSessionId === review.wiseSessionId);
      const required = isRequiredReview(review.inclusionReason);
      const tutor = rosterTutor(review.wiseTeacherUserId);
      const cutoff = currentVerdict ? { verdict: currentVerdict.verdict, createdAt: currentVerdict.createdAt } : null;
      return [{
        wiseSessionId: review.wiseSessionId,
        wiseUrl: session?.wiseClassId ? wiseSessionLink({ wiseClassId: session.wiseClassId, wiseSessionId: review.wiseSessionId }) : null,
        className: session?.className ?? null,
        tutor: tutor ? tutorLabel(tutor) : review.tutorKey,
        tutorKey: review.tutorKey,
        classEndedAt: iso(review.classEndedAt),
        bangkokDate: review.bangkokDate,
        inclusionReason: review.inclusionReason,
        required,
        status: flags.length > 0 ? "flagged" : review.currentVerdictId ? "reviewed" : required ? "needs_review" : "optional",
        openFlags: flags.map((flag) => ({
          id: flag.id,
          source: flag.source,
          note: flag.note,
          suggestedSeverity: flag.suggestedSeverity,
          suggestedCategory: flag.suggestedCategory,
          createdAt: flag.createdAt.toISOString(),
        })),
        firstShot: {
          postId: firstShot.id,
          fields: firstFields,
          fieldsSha256: firstShot.fieldsSha256,
          provenance: firstShot.provenance,
          method: typeof firstShot.reconstruction?.method === "string" ? firstShot.reconstruction.method : null,
          postStartedAt: iso(firstShot.postStartedAt),
          arm: firstShot.arm,
          evidence: firstShot.evidence,
          outcome: firstShot.outcome,
          problems: problemCodes((firstShot.verification as { problems?: unknown }).problems),
        },
        current,
        changed: diff.length > 0,
        diff,
        corrections: corrections.map((post) => ({
          actor: post.actor,
          reason: post.reason,
          outcome: post.outcome,
          at: iso(post.postFinishedAt ?? post.postStartedAt),
          provenance: post.provenance,
        })),
        fixEvents: input.fixEvents.filter((event) => event.wiseSessionId === review.wiseSessionId)
          .toSorted((a, b) => a.eventAt.getTime() - b.eventAt.getTime())
          .map((event) => ({
            wiseEventId: event.wiseEventId,
            at: event.eventAt.toISOString(),
            actorKind: event.actorKind,
            countsAsFix: event.countsAsFix,
            counted: countsTowardFix(event, cutoff),
          })),
        measuredFixCount: review.measuredFixCount,
        measuredFixesByActor: review.measuredFixesByActor ?? {},
        verdicts,
        currentVerdict: verdicts.find((verdict) => verdict.current) ?? null,
      }];
    });

  const recordedFirstShots = new Set(input.posts.filter((post) => post.kind === "first_shot").map((post) => post.wiseSessionId));
  const skipped = (input.lastRun?.counts as { dailyGateSkipped?: unknown } | undefined)?.dailyGateSkipped;
  return {
    available: true,
    generatedAt: input.now.toISOString(),
    window: { ...window, days: GATE_THRESHOLDS.windowDays },
    gate: {
      status: gate.status,
      wilsonLower: gate.wilsonLower,
      coverage: gate.coverage,
      reasons: gate.reasons,
      ...input.gateFacts,
      thresholds: {
        passLowerBound: GATE_THRESHOLDS.passLowerBound,
        headStartLowerBound: GATE_THRESHOLDS.headStartLowerBound,
        minCoverage: GATE_THRESHOLDS.minCoverage,
      },
      lastDaily: input.lastDailyGate ? {
        date: input.lastDailyGate.bangkokDate,
        status: input.lastDailyGate.status,
        wilsonLower: Number(input.lastDailyGate.wilsonLower),
        createdAt: input.lastDailyGate.createdAt.toISOString(),
      } : null,
      currentTutors: AUTOWRITER_TUTORS.length,
      nextExpansionSize: nextExpansionSize(AUTOWRITER_TUTORS.length),
    },
    coverage,
    fixRounds,
    daily,
    tutors,
    queue,
    queueTotals: { ...input.queueTotals, shown: queue.length },
    incidents: input.incidents
      // A first shot the backfill proved later is no longer an open question.
      .filter((incident) => !(incident.kind === "first_shot_unverified" && incident.severity === "info"
        && incident.wiseSessionId && recordedFirstShots.has(incident.wiseSessionId)))
      .map((incident) => ({
        id: incident.id,
        kind: incident.kind,
        severity: incident.severity,
        summary: incident.summary,
        wiseSessionId: incident.wiseSessionId,
        pushStatus: incident.pushStatus,
        lastPushError: incident.lastPushError,
        acknowledgedAt: iso(incident.acknowledgedAt),
        acknowledgedBy: incident.acknowledgedBy,
        createdAt: incident.createdAt.toISOString(),
      })),
    lastRun: input.lastRun ? {
      status: input.lastRun.status,
      startedAt: input.lastRun.startedAt.toISOString(),
      finishedAt: iso(input.lastRun.finishedAt),
      errorSummary: input.lastRun.errorSummary,
      dailyGateSkipped: typeof skipped === "string" ? skipped : null,
    } : null,
  };
}

/** SQL: the class is not an in-person one (a review row's session, when the autowriter has a row for it). */
const notInPersonReviewSql = sql`not exists (select 1 from feedback_autowriter_sessions s
  where s.wise_session_id = feedback_autowriter_reviews.wise_session_id and s.state = 'skipped_scope'
    and s.reason in ('session_type_OFFLINE', 'session_type_in_person_title'))`;
const openFlagSql = sql`exists (select 1 from feedback_autowriter_flags f
  where f.wise_session_id = feedback_autowriter_reviews.wise_session_id and f.resolved_by_verdict_id is null)`;
const requiredUnreviewedSql = sql`(${R.inclusionReason} in ('new_tutor', 'random_sample') and ${R.currentVerdictId} is null)`;

async function loadAvailableReview(db: Database, now: Date, queueLimit: number): Promise<AutowriterReview> {
  const today = bangkokDateKey(now);
  const window = gateWindow(today);
  const queueSince = addDays(today, -(REVIEW_QUEUE_DAYS - 1));
  const [gateFacts, windowReviews, flagged, unreviewed, recent, totals] = await Promise.all([
    loadGateFacts(db, window),
    db.select().from(R).where(and(gte(R.bangkokDate, window.start), notInPersonReviewSql)),
    db.select().from(R).where(and(openFlagSql, notInPersonReviewSql)),
    db.select().from(R).where(and(requiredUnreviewedSql, notInPersonReviewSql)).orderBy(desc(R.classEndedAt)).limit(UNREVIEWED_LIMIT),
    db.select().from(R).where(and(gte(R.bangkokDate, queueSince), notInPersonReviewSql)).orderBy(desc(R.classEndedAt)).limit(queueLimit),
    db.select({
      needsReview: sql<number>`count(*) filter (where ${requiredUnreviewedSql})`.mapWith(Number),
      flagged: sql<number>`count(*) filter (where ${openFlagSql})`.mapWith(Number),
      all: count(),
    }).from(R).where(and(or(gte(R.bangkokDate, queueSince), requiredUnreviewedSql, openFlagSql), notInPersonReviewSql)),
  ]);
  const queueReviews = [...new Map([...flagged, ...unreviewed, ...recent].map((row) => [row.wiseSessionId, row])).values()];
  const ids = [...new Set([...queueReviews, ...windowReviews].map((review) => review.wiseSessionId))];
  const byIds = <T>(load: () => Promise<T[]>) => ids.length > 0 ? load() : Promise.resolve([] as T[]);
  const [posts, verdicts, flags, fixEvents, sessions, versions, metrics, lastDaily, incidents, lastRun] = await Promise.all([
    byIds(() => db.select().from(P).where(inArray(P.wiseSessionId, ids))),
    byIds(() => db.select().from(V).where(inArray(V.wiseSessionId, ids))),
    byIds(() => db.select().from(FL).where(inArray(FL.wiseSessionId, ids))),
    byIds(() => db.select({
      wiseEventId: FX.wiseEventId, wiseSessionId: FX.wiseSessionId, eventAt: FX.eventAt, actorKind: FX.actorKind, countsAsFix: FX.countsAsFix,
    }).from(FX).where(inArray(FX.wiseSessionId, ids))),
    byIds(() => db.select({
      wiseSessionId: S.wiseSessionId, wiseClassId: S.wiseClassId, wiseTeacherUserId: S.wiseTeacherUserId, state: S.state,
      reason: S.reason, className: PC.className,
    }).from(S).leftJoin(PC, eq(PC.wiseSessionId, S.wiseSessionId)).where(inArray(S.wiseSessionId, ids))),
    byIds(() => db.selectDistinctOn([PC.wiseSessionId], {
      wiseSessionId: PC.wiseSessionId, observedAt: PCV.observedAt, topics: PCV.topics, performance: PCV.performance,
      improvement: PCV.improvement, homework: PCV.homework,
    }).from(PCV).innerJoin(PC, eq(PC.id, PCV.sessionId))
      .where(and(inArray(PC.wiseSessionId, ids), eq(PCV.profile, "teacher")))
      .orderBy(PC.wiseSessionId, desc(PCV.observedAt))),
    db.select().from(M).where(gte(M.metricDate, window.start)),
    db.select().from(G).where(eq(G.evalKind, "daily")).orderBy(desc(G.bangkokDate)).limit(1),
    // The latest 50, plus every critical incident still waiting for the owner.
    db.select().from(I).where(or(
      gte(I.createdAt, new Date(now.getTime() - REVIEW_QUEUE_DAYS * 24 * 60 * 60 * 1000)),
      and(eq(I.severity, "critical"), isNull(I.acknowledgedAt), sql`${I.pushStatus} <> 'sent'`),
    )).orderBy(desc(I.createdAt)).limit(100),
    db.select().from(RUNS).orderBy(desc(RUNS.startedAt)).limit(1),
  ]);
  return buildAutowriterReview({
    now,
    gateFacts,
    windowReviews,
    queueReviews,
    queueTotals: totals[0] ?? { needsReview: 0, flagged: 0, all: 0 },
    posts,
    verdicts,
    flags,
    fixEvents,
    sessions,
    currentVersions: versions.map((row) => ({
      wiseSessionId: row.wiseSessionId,
      observedAt: row.observedAt,
      fields: { topics: row.topics, performance: row.performance, improvement: row.improvement, homework: row.homework },
    })),
    metrics,
    lastDailyGate: lastDaily[0] ?? null,
    incidents,
    lastRun: lastRun[0] ?? null,
  });
}

/**
 * Read-only loader for the page and `GET /api/feedback-autowriter/review`. A missing review table (SQLSTATE 42P01:
 * migration 0100 not applied) is a typed "unavailable" payload; any other failure propagates — it is not the same
 * thing and must not look like it.
 */
export async function loadAutowriterReview(
  db: Database,
  input: { now?: Date; queueLimit?: number } = {},
): Promise<AutowriterReview | AutowriterReviewUnavailable> {
  try {
    return await loadAvailableReview(db, input.now ?? new Date(), input.queueLimit ?? QUEUE_LIMIT);
  } catch (error) {
    if (isMissingRelationError(error)) return { available: false, reason: "review_tables_missing" };
    throw error;
  }
}

/** For logs: an error's name and SQLSTATE only (database errors can carry lesson text in their parameters). */
export function reviewLoadErrorSummary(error: unknown): { errorName: string; sqlState: string | null } {
  return { errorName: error instanceof Error ? error.name : "UnknownError", sqlState: sqlStateOf(error) };
}
