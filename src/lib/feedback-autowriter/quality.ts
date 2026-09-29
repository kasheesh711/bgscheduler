/**
 * Quality measurement for the autowriter operating loop (Phase 1, pure — no database, no clock).
 *
 * Owner decisions (29 Sep 2026, quick 260929-lop):
 * - A post is accurate when it needed no real fix: approved, or "needs fix" with cosmetic severity.
 * - Accuracy = accurate ÷ owner-reviewed posts, judged on the two-sided 95% Wilson lower bound.
 * - Coverage = posted ÷ (eligible − classes the tutor wrote first), counted on live-mode days only.
 * - Gate (rolling 14 days): lower bound ≥ 80%, zero critical verdicts, no unresolved critical flag, coverage ≥ 70%
 *   and no flagged post waiting for review. A lower bound ≥ 70% starts the head start for the next tutors.
 * - Every tutor is reviewed at 100% until their cohort has passed a gate; proven tutors drop to a random 30%
 *   sample (drawn once, before any flag) plus flagged posts.
 * - Expansion grows the roster by half, rounded up: 5 → 8 → 12 → 18.
 */

import type { AutowriterVerdictSeverity } from "@/lib/db/schema";

/** Bumped whenever a definition below changes, so persisted metrics say which rules produced them. */
export const QUALITY_POLICY_VERSION = 1;

export const WILSON_Z_95 = 1.959964;
export const GATE_WINDOW_DAYS = 14;

export const GATE_THRESHOLDS = {
  passLowerBound: 0.8,
  headStartLowerBound: 0.7,
  minCoverage: 0.7,
  windowDays: GATE_WINDOW_DAYS,
  z: WILSON_Z_95,
} as const;

export const PROVEN_SAMPLE_PROBABILITY = 0.3;
export const SAMPLING_POLICY = "v1: 100% until the tutor's cohort passes a gate; proven tutors 0.30 random sample";

/**
 * Tutors whose cohort has passed a gate. None in Phase 1: every tutor is reviewed at 100%. Phase 6's enrollment
 * table supplies this once an expansion round is confirmed.
 */
export const PROVEN_TUTOR_KEYS: ReadonlySet<string> = new Set();

/**
 * Two-sided Wilson score lower bound for `successes` out of `trials`. 0 when nothing was reviewed.
 * With zero errors, 9 reviews reach 0.70 and 16 reach 0.80 (20/20 → 0.839).
 */
export function wilsonLowerBound(successes: number, trials: number, z = WILSON_Z_95): number {
  if (!(trials > 0)) return 0;
  const p = Math.min(1, Math.max(0, successes / trials));
  const z2 = z * z;
  const centre = p + z2 / (2 * trials);
  const margin = z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials));
  return Math.max(0, (centre - margin) / (1 + z2 / trials));
}

export interface VerdictLike {
  verdict: "approve" | "needs_fix";
  severity: AutowriterVerdictSeverity | null;
}

/** Approved, or needing only a cosmetic fix. */
export function isAccurate(verdict: VerdictLike): boolean {
  return verdict.verdict === "approve" || (verdict.verdict === "needs_fix" && verdict.severity === "cosmetic");
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

export type CoverageClass =
  | "posted"
  | "excluded_scope"
  | "excluded_absent"
  | "excluded_tutor_off"
  | "excluded_tutor_first"
  | "pending"
  | "miss_held"
  | "miss_expired"
  | "miss_failed"
  | "miss_unseen";

export const COVERAGE_CLASSES: readonly CoverageClass[] = [
  "posted", "miss_held", "miss_expired", "miss_failed", "miss_unseen",
  "excluded_tutor_first", "excluded_absent", "excluded_tutor_off", "excluded_scope", "pending",
];

const MISSES = new Set<CoverageClass>(["miss_held", "miss_expired", "miss_failed", "miss_unseen"]);

/** Skip reasons of an in-person class; such classes are the tutor's and are left out everywhere. */
const ONSITE_REASONS = new Set(["session_type_OFFLINE", "session_type_in_person_title"]);

/** Held because the student was absent or barely there: not the autowriter's class to write. */
export function isAbsenceHold(reason: string | null): boolean {
  if (!reason) return false;
  return reason === "student_count_0" || reason === "student_not_wise_user" || /^attendance_\d+pct$/u.test(reason);
}

export interface CoverageInput {
  /** The autowriter row's state; null when the autowriter never saw the class. */
  state: string | null;
  reason: string | null;
  /** For a class the autowriter never saw: proven online one-to-one (past session blocks or Wise title/type). */
  provenOnlineOneToOne?: boolean;
}

/**
 * Where one roster class stands for coverage; null when it does not count at all (in-person, or an unseen class
 * not proven to be online one-to-one).
 */
export function classifyCoverage(input: CoverageInput): CoverageClass | null {
  const { state, reason } = input;
  if (state === null) return input.provenOnlineOneToOne ? "miss_unseen" : null;
  if (state === "skipped_scope" && reason !== null && ONSITE_REASONS.has(reason)) return null;
  switch (state) {
    case "verified":
    case "awaiting_event":
      return "posted";
    case "skipped_human":
      return "excluded_tutor_first";
    case "skipped_scope":
      return reason === "tutor_off_at_deadline" ? "excluded_tutor_off" : "excluded_scope";
    case "held":
      return isAbsenceHold(reason) ? "excluded_absent" : "miss_held";
    case "expired":
      return "miss_expired";
    case "rejected":
    case "unknown_outcome":
    case "verify_failed":
      return "miss_failed";
    default:
      // pending, generating, posting, awaiting_recording, transcribing, would_submit: not settled yet.
      return "pending";
  }
}

export type CoverageCounts = Record<CoverageClass, number>;

export function emptyCoverageCounts(): CoverageCounts {
  return Object.fromEntries(COVERAGE_CLASSES.map((key) => [key, 0])) as CoverageCounts;
}

/** Posted ÷ (posted + misses). Excluded and pending classes are in neither. */
export function coverageRatio(counts: CoverageCounts): { num: number; den: number; ratio: number | null } {
  const num = counts.posted;
  const den = num + [...MISSES].reduce((sum, key) => sum + counts[key], 0);
  return { num, den, ratio: den > 0 ? num / den : null };
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

export type GateStatus = "insufficient_data" | "below_head_start" | "head_start" | "pass" | "blocked_critical";

export interface GateInput {
  /** Owner-reviewed posts that the gate counts (required reviews with a current verdict). */
  reviewed: number;
  accurate: number;
  /** Current verdicts with critical severity in the window (sampled or not). */
  criticalVerdicts: number;
  unresolvedCriticalFlags: number;
  /** Posts in the window with a flag no verdict has answered yet. */
  pendingFlaggedReviews: number;
  coverageNum: number;
  coverageDen: number;
}

export interface GateResult {
  status: GateStatus;
  wilsonLower: number;
  coverage: number | null;
  reasons: string[];
}

export function evaluateGate(input: GateInput, thresholds = GATE_THRESHOLDS): GateResult {
  const wilsonLower = wilsonLowerBound(input.accurate, input.reviewed, thresholds.z);
  const coverage = input.coverageDen > 0 ? input.coverageNum / input.coverageDen : null;
  const reasons: string[] = [];
  if (input.criticalVerdicts > 0) reasons.push(`${input.criticalVerdicts} critical verdict(s) in the window`);
  if (input.unresolvedCriticalFlags > 0) reasons.push(`${input.unresolvedCriticalFlags} unresolved critical flag(s)`);
  if (input.reviewed === 0) reasons.push("no owner-reviewed posts in the window");
  else if (wilsonLower < thresholds.passLowerBound) {
    reasons.push(`accuracy lower bound ${pct(wilsonLower)} < ${pct(thresholds.passLowerBound)} (${input.accurate}/${input.reviewed})`);
  }
  if (coverage === null) reasons.push("no eligible classes on live days in the window");
  else if (coverage < thresholds.minCoverage) {
    reasons.push(`coverage ${pct(coverage)} < ${pct(thresholds.minCoverage)} (${input.coverageNum}/${input.coverageDen})`);
  }
  if (input.pendingFlaggedReviews > 0) reasons.push(`${input.pendingFlaggedReviews} flagged post(s) waiting for review`);

  let status: GateStatus;
  if (input.criticalVerdicts > 0 || input.unresolvedCriticalFlags > 0) status = "blocked_critical";
  else if (input.reviewed === 0) status = "insufficient_data";
  else if (wilsonLower >= thresholds.passLowerBound && coverage !== null && coverage >= thresholds.minCoverage
    && input.pendingFlaggedReviews === 0) status = "pass";
  else if (wilsonLower >= thresholds.headStartLowerBound) status = "head_start";
  else status = "below_head_start";
  return { status, wilsonLower, coverage, reasons };
}

function pct(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

export interface GateReviewFact {
  bangkokDate: string;
  inclusionReason: InclusionReason;
  verdict: VerdictLike | null;
  hasOpenFlag: boolean;
}

export interface GateMetricFact {
  metricDate: string;
  tutorKey: string;
  liveMode: boolean;
  posted: number;
  eligible: number;
}

/**
 * Gate inputs for an inclusive window of Bangkok dates. Accuracy counts only required reviews that have a
 * verdict (a voluntary review of a post that was not sampled never counts); critical verdicts count whatever the
 * sampling; coverage sums the all-tutor metric rows of live-mode days.
 */
export function computeGateFacts(input: {
  window: { start: string; end: string };
  reviews: readonly GateReviewFact[];
  unresolvedCriticalFlags: number;
  metrics: readonly GateMetricFact[];
}): GateInput {
  const inWindow = (date: string) => date >= input.window.start && date <= input.window.end;
  const reviews = input.reviews.filter((review) => inWindow(review.bangkokDate));
  const counted = reviews.filter((review) => isRequiredReview(review.inclusionReason) && review.verdict !== null);
  const coverage = input.metrics.filter((row) => row.tutorKey === "*" && row.liveMode && inWindow(row.metricDate));
  return {
    reviewed: counted.length,
    accurate: counted.filter((review) => isAccurate(review.verdict!)).length,
    criticalVerdicts: reviews.filter((review) => review.verdict?.severity === "critical").length,
    unresolvedCriticalFlags: input.unresolvedCriticalFlags,
    pendingFlaggedReviews: reviews.filter((review) => review.hasOpenFlag).length,
    coverageNum: coverage.reduce((sum, row) => sum + row.posted, 0),
    coverageDen: coverage.reduce((sum, row) => sum + row.eligible, 0),
  };
}

// ---------------------------------------------------------------------------
// Daily metrics
// ---------------------------------------------------------------------------

export interface DailyClassFact {
  tutorKey: string;
  coverage: CoverageClass | null;
}

export interface DailyReviewFact {
  tutorKey: string;
  inclusionReason: InclusionReason;
  verdict: VerdictLike | null;
  measuredFixCount: number;
  correctionsVerified: number;
}

export interface DailyMetricValues {
  posted: number;
  required: number;
  reviewed: number;
  requiredPending: number;
  accurate: number;
  cosmetic: number;
  factual: number;
  critical: number;
  /** Coverage denominator: posted plus every miss. */
  eligible: number;
  excludedScope: number;
  excludedTutorFirst: number;
  excludedAbsent: number;
  excludedTutorOff: number;
  pending: number;
  unseen: number;
  held: number;
  expired: number;
  failed: number;
  measuredFixClasses: number;
  correctionsVerified: number;
}

/** One row per tutor key (the given ones plus any present) and one for `*` (all tutors). */
export function buildDailyMetrics(input: {
  classes: readonly DailyClassFact[];
  reviews: readonly DailyReviewFact[];
  tutorKeys: readonly string[];
}): Array<{ tutorKey: string } & DailyMetricValues> {
  const keys = [...new Set([...input.tutorKeys, ...input.classes.map((row) => row.tutorKey), ...input.reviews.map((row) => row.tutorKey)])];
  const build = (classes: readonly DailyClassFact[], reviews: readonly DailyReviewFact[]): DailyMetricValues => {
    const counts = emptyCoverageCounts();
    for (const row of classes) if (row.coverage) counts[row.coverage] += 1;
    const required = reviews.filter((review) => isRequiredReview(review.inclusionReason));
    const reviewed = required.filter((review) => review.verdict !== null);
    const severities = reviews.flatMap((review) => review.verdict?.severity ? [review.verdict.severity] : []);
    return {
      posted: counts.posted,
      required: required.length,
      reviewed: reviewed.length,
      requiredPending: required.length - reviewed.length,
      accurate: reviewed.filter((review) => isAccurate(review.verdict!)).length,
      cosmetic: severities.filter((severity) => severity === "cosmetic").length,
      factual: severities.filter((severity) => severity === "factual").length,
      critical: severities.filter((severity) => severity === "critical").length,
      eligible: coverageRatio(counts).den,
      excludedScope: counts.excluded_scope,
      excludedTutorFirst: counts.excluded_tutor_first,
      excludedAbsent: counts.excluded_absent,
      excludedTutorOff: counts.excluded_tutor_off,
      pending: counts.pending,
      unseen: counts.miss_unseen,
      held: counts.miss_held,
      expired: counts.miss_expired,
      failed: counts.miss_failed,
      measuredFixClasses: reviews.filter((review) => review.measuredFixCount > 0).length,
      correctionsVerified: reviews.reduce((sum, review) => sum + review.correctionsVerified, 0),
    };
  };
  return [
    ...keys.map((tutorKey) => ({
      tutorKey,
      ...build(input.classes.filter((row) => row.tutorKey === tutorKey), input.reviews.filter((row) => row.tutorKey === tutorKey)),
    })),
    { tutorKey: "*", ...build(input.classes, input.reviews) },
  ];
}

// ---------------------------------------------------------------------------
// Review sampling and expansion
// ---------------------------------------------------------------------------

export type InclusionReason = "new_tutor" | "random_sample" | "not_sampled";

/**
 * Whether a post must be owner-reviewed. `draw` is uniform in [0, 1), drawn once when the review row is made
 * (crypto RNG) and stored; flags never change it.
 */
export function reviewInclusion(input: { tutorProven: boolean; draw: number }): { reason: InclusionReason; probability: number } {
  if (!input.tutorProven) return { reason: "new_tutor", probability: 1 };
  return input.draw < PROVEN_SAMPLE_PROBABILITY
    ? { reason: "random_sample", probability: PROVEN_SAMPLE_PROBABILITY }
    : { reason: "not_sampled", probability: PROVEN_SAMPLE_PROBABILITY };
}

/** Inclusion reasons whose posts the gate counts (and the owner must review). */
export function isRequiredReview(reason: InclusionReason): boolean {
  return reason === "new_tutor" || reason === "random_sample";
}

/** The next roster size: +50%, rounded up (5 → 8 → 12 → 18). */
export function nextExpansionSize(current: number): number {
  return current + Math.ceil(current / 2);
}

// ---------------------------------------------------------------------------
// Bangkok dates
// ---------------------------------------------------------------------------

const BANGKOK_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" });

/** "YYYY-MM-DD" of an instant in Bangkok. */
export function bangkokDateKey(date: Date): string {
  return BANGKOK_DATE.format(date);
}

const BANGKOK_HOUR = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", hour: "2-digit", hourCycle: "h23" });

/** Hour of the day (0–23) in Bangkok. */
export function bangkokHour(date: Date): number {
  return Number(BANGKOK_HOUR.format(date));
}

/**
 * The Bangkok date whose daily gate evaluation is due: today from 22:00 Bangkok (the owner's nightly
 * tabulation), otherwise yesterday.
 */
export function dailyGateDate(now: Date): string {
  const today = bangkokDateKey(now);
  return bangkokHour(now) >= 22 ? today : addDays(today, -1);
}

/** Shift a "YYYY-MM-DD" key by whole days. */
export function addDays(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The UTC instants bounding a Bangkok date: [start, end). */
export function bangkokDayBounds(dateKey: string): { start: Date; end: Date } {
  const start = new Date(`${dateKey}T00:00:00+07:00`);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

/** Inclusive 14-day window ending on `endDate`. */
export function gateWindow(endDate: string, days = GATE_WINDOW_DAYS): { start: string; end: string } {
  return { start: addDays(endDate, -(days - 1)), end: endDate };
}
