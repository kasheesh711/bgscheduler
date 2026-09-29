import { and, desc, eq, gte, inArray, isNull, or, sql, count } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { POST_CLASS_FEEDBACK_FIELDS, type FeedbackFieldAnswers } from "@/lib/post-class-feedback/types";
import { wiseSessionLink } from "@/lib/wise/links";
import { isOnsiteSkip } from "./dashboard";
import {
  GATE_THRESHOLDS,
  PROVEN_TUTOR_KEYS,
  addDays,
  bangkokDateKey,
  computeGateFacts,
  emptyCoverageCounts,
  evaluateGate,
  gateWindow,
  isAccurate,
  isRequiredReview,
  nextExpansionSize,
  wilsonLowerBound,
  type CoverageCounts,
  type GateStatus,
  type InclusionReason,
} from "./quality";
import { AUTOWRITER_TUTORS, rosterTutor, tutorLabel } from "./roster";
import type { AutowriterSessionRow } from "./store";

/**
 * The Quality and Review tabs of the autowriter dashboard (Phase 1 of the operating loop). Read-only; the pure
 * `buildAutowriterReview` shapes rows loaded by `loadAutowriterReview`. In-person classes stay hidden, as on the
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
const QUEUE_LIMIT = 300;

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
  openFlags: Array<{ source: string; note: string | null; createdAt: string }>;
  firstShot: {
    postId: string;
    fields: FeedbackFieldAnswers;
    fieldsSha256: string;
    provenance: "snapshot" | "live" | "backfill";
    method: string | null;
    postStartedAt: string | null;
    arm: string | null;
    evidence: string | null;
  };
  current: { fields: FeedbackFieldAnswers; source: "first_shot" | "correction" | "wise_feedback_version"; at: string | null };
  changed: boolean;
  diff: Array<{ field: Field; segments: DiffSegment[] }>;
  corrections: Array<{ actor: string; reason: string | null; outcome: string; at: string | null; provenance: string }>;
  fixEvents: Array<{ wiseEventId: string; at: string; actorKind: string; countsAsFix: boolean }>;
  measuredFixCount: number;
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
  posted: number;
  reviewed: number;
  accurate: number;
  wilsonLower: number;
  requiredPending: number;
  coverage: number | null;
  coverageNum: number;
  coverageDen: number;
  measuredFixClasses: number;
}

export interface AutowriterReview {
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
    coverageNum: number;
    coverageDen: number;
    thresholds: { passLowerBound: number; headStartLowerBound: number; minCoverage: number };
    lastDaily: { date: string; status: GateStatus; wilsonLower: number; createdAt: string } | null;
    currentTutors: number;
    nextExpansionSize: number;
  };
  coverage: CoverageCounts;
  fixRounds: { zero: number; one: number; two: number; threePlus: number; unresolved: number };
  daily: QualityDailyRow[];
  tutors: QualityTutorRow[];
  queue: ReviewQueueItem[];
  incidents: Array<{
    id: string;
    kind: string;
    severity: "critical" | "info";
    summary: string;
    wiseSessionId: string | null;
    pushStatus: string;
    lastPushError: string | null;
    createdAt: string;
  }>;
  lastRun: { status: string; startedAt: string; finishedAt: string | null; errorSummary: string | null } | null;
}

type ReviewRow = typeof R.$inferSelect;
type PostRow = typeof P.$inferSelect;
type VerdictRow = typeof V.$inferSelect;
type FlagRow = typeof FL.$inferSelect;
type MetricRow = typeof M.$inferSelect;

export interface ReviewSourceRows {
  reviews: readonly ReviewRow[];
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
  unresolvedCriticalFlags: number;
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
  const reviews = input.reviews.filter((review) => {
    const session = sessions.get(review.wiseSessionId);
    return !session || !isOnsiteSkip(session);
  });

  const gateFacts = computeGateFacts({
    window,
    reviews: reviews.map((review) => {
      const verdict = review.currentVerdictId ? verdictsById.get(review.currentVerdictId) ?? null : null;
      return {
        bangkokDate: review.bangkokDate,
        inclusionReason: review.inclusionReason,
        verdict: verdict ? { verdict: verdict.verdict, severity: verdict.severity } : null,
        hasOpenFlag: openFlags.some((flag) => flag.wiseSessionId === review.wiseSessionId),
      };
    }),
    unresolvedCriticalFlags: input.unresolvedCriticalFlags,
    metrics: input.metrics,
  });
  const gate = evaluateGate(gateFacts);

  const windowMetrics = input.metrics.filter((row) => inWindow(row.metricDate));
  const liveAll = windowMetrics.filter((row) => row.tutorKey === "*" && row.liveMode);
  const coverage = emptyCoverageCounts();
  for (const row of liveAll) {
    coverage.posted += row.posted;
    coverage.miss_held += row.held;
    coverage.miss_expired += row.expired;
    coverage.miss_failed += row.failed;
    coverage.miss_unseen += row.unseen;
    coverage.excluded_tutor_first += row.excludedTutorFirst;
    coverage.excluded_absent += row.excludedAbsent;
    coverage.excluded_tutor_off += row.excludedTutorOff;
    coverage.excluded_scope += row.excludedScope;
    coverage.pending += row.pending;
  }

  const fixRounds = { zero: 0, one: 0, two: 0, threePlus: 0, unresolved: 0 };
  for (const review of reviews.filter((row) => inWindow(row.bangkokDate))) {
    const verdict = review.currentVerdictId ? verdictsById.get(review.currentVerdictId) : undefined;
    if (verdict && verdict.verdict === "needs_fix" && review.measuredFixCount === 0) fixRounds.unresolved += 1;
    else if (review.measuredFixCount === 0) fixRounds.zero += 1;
    else if (review.measuredFixCount === 1) fixRounds.one += 1;
    else if (review.measuredFixCount === 2) fixRounds.two += 1;
    else fixRounds.threePlus += 1;
  }

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
    const tutorReviews = reviews.filter((review) => review.tutorKey === tutor.canonicalKey && inWindow(review.bangkokDate));
    const counted = tutorReviews.flatMap((review) => {
      const verdict = review.currentVerdictId ? verdictsById.get(review.currentVerdictId) : undefined;
      return isRequiredReview(review.inclusionReason) && verdict ? [verdict] : [];
    });
    const accurate = counted.filter((verdict) => isAccurate(verdict)).length;
    const live = windowMetrics.filter((row) => row.tutorKey === tutor.canonicalKey && row.liveMode);
    const coverageNum = live.reduce((sum, row) => sum + row.posted, 0);
    const coverageDen = live.reduce((sum, row) => sum + row.eligible, 0);
    return {
      tutorKey: tutor.canonicalKey,
      displayName: tutor.label,
      phase: PROVEN_TUTOR_KEYS.has(tutor.canonicalKey) ? "sampled" : "full_review",
      posted: tutorReviews.length,
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

  const queue = reviews
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
      const verdicts = input.verdicts.filter((row) => row.wiseSessionId === review.wiseSessionId)
        .toSorted((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map((row) => verdictView(row, review.currentVerdictId));
      const flags = openFlags.filter((flag) => flag.wiseSessionId === review.wiseSessionId);
      const required = isRequiredReview(review.inclusionReason);
      const tutor = rosterTutor(review.wiseTeacherUserId);
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
        openFlags: flags.map((flag) => ({ source: flag.source, note: flag.note, createdAt: flag.createdAt.toISOString() })),
        firstShot: {
          postId: firstShot.id,
          fields: firstFields,
          fieldsSha256: firstShot.fieldsSha256,
          provenance: firstShot.provenance,
          method: typeof firstShot.reconstruction?.method === "string" ? firstShot.reconstruction.method : null,
          postStartedAt: iso(firstShot.postStartedAt),
          arm: firstShot.arm,
          evidence: firstShot.evidence,
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
          .map((event) => ({ wiseEventId: event.wiseEventId, at: event.eventAt.toISOString(), actorKind: event.actorKind, countsAsFix: event.countsAsFix })),
        measuredFixCount: review.measuredFixCount,
        verdicts,
        currentVerdict: verdicts.find((verdict) => verdict.current) ?? null,
      }];
    });

  const recordedFirstShots = new Set(input.posts.filter((post) => post.kind === "first_shot").map((post) => post.wiseSessionId));
  return {
    generatedAt: input.now.toISOString(),
    window: { ...window, days: GATE_THRESHOLDS.windowDays },
    gate: {
      status: gate.status,
      wilsonLower: gate.wilsonLower,
      coverage: gate.coverage,
      reasons: gate.reasons,
      ...gateFacts,
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
    incidents: input.incidents
      // A first shot the backfill proved later is no longer an open question.
      .filter((incident) => !(incident.kind === "first_shot_unverified" && incident.wiseSessionId && recordedFirstShots.has(incident.wiseSessionId)))
      .map((incident) => ({
        id: incident.id,
        kind: incident.kind,
        severity: incident.severity,
        summary: incident.summary,
        wiseSessionId: incident.wiseSessionId,
        pushStatus: incident.pushStatus,
        lastPushError: incident.lastPushError,
        createdAt: incident.createdAt.toISOString(),
      })),
    lastRun: input.lastRun ? {
      status: input.lastRun.status,
      startedAt: input.lastRun.startedAt.toISOString(),
      finishedAt: iso(input.lastRun.finishedAt),
      errorSummary: input.lastRun.errorSummary,
    } : null,
  };
}

/** Read-only loader for the page and `GET /api/feedback-autowriter/review`. */
export async function loadAutowriterReview(db: Database, input: { now?: Date } = {}): Promise<AutowriterReview> {
  const now = input.now ?? new Date();
  const today = bangkokDateKey(now);
  const window = gateWindow(today);
  const queueSince = addDays(today, -(REVIEW_QUEUE_DAYS - 1));
  const openFlagSql = sql`exists (select 1 from feedback_autowriter_flags f
    where f.wise_session_id = feedback_autowriter_reviews.wise_session_id and f.resolved_by_verdict_id is null)`;
  const reviews = await db.select().from(R).where(or(
    gte(R.bangkokDate, queueSince),
    isNull(R.currentVerdictId),
    openFlagSql,
  )).orderBy(desc(R.classEndedAt)).limit(QUEUE_LIMIT);
  const ids = reviews.map((review) => review.wiseSessionId);
  const byIds = <T>(load: () => Promise<T[]>) => ids.length > 0 ? load() : Promise.resolve([] as T[]);

  const [posts, verdicts, flags, fixEvents, sessions, versions, metrics, lastDaily, incidents, lastRun, criticalFlags] = await Promise.all([
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
    db.select().from(I).where(or(
      gte(I.createdAt, new Date(now.getTime() - REVIEW_QUEUE_DAYS * 24 * 60 * 60 * 1000)),
      isNull(I.acknowledgedAt),
    )).orderBy(desc(I.createdAt)).limit(50),
    db.select().from(RUNS).orderBy(desc(RUNS.startedAt)).limit(1),
    db.select({ total: count() }).from(FL).where(and(eq(FL.suggestedSeverity, "critical"), isNull(FL.resolvedByVerdictId))),
  ]);
  return buildAutowriterReview({
    now,
    reviews,
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
    unresolvedCriticalFlags: criticalFlags[0]?.total ?? 0,
  });
}
