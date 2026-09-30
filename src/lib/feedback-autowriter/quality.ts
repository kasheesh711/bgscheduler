/**
 * Quality measurement for the autowriter operating loop (Phase 1, pure — no database, no clock).
 *
 * Owner decisions (29 Sep 2026, quick 260929-lop; D-01 and D-03 settled at the owner interview of 30 Sep):
 * - A post is accurate when it needed no real fix: approved, or "needs fix" with cosmetic severity.
 * - Accuracy = accurate ÷ owner-reviewed posts, judged on the two-sided 95% Wilson lower bound.
 * - Coverage = posted ÷ (eligible − classes the tutor wrote first − data-quality holds). Each class is judged by the
 *   mode, its tutor's switch and the roster during its own posting window (class end → deadline − margin), never by
 *   today's. D-03: a hold leaves the denominator only when the class's own data made a faithful write-up impossible
 *   (`DATA_QUALITY_REASONS`); a hold where the judge or the validator rejected our drafts is a miss. A deadline
 *   hand-back leaves it only when its tutor was switched off as its window closed, never by a later switch.
 * - Gate (rolling 14 days): lower bound ≥ 80%, zero critical verdicts, no unresolved critical flag, no unexplained API
 *   write, coverage ≥ 70%, no flagged post and no required post waiting for review, and every posted first shot
 *   recorded. A lower bound ≥ 70% starts the head start for the next tutors.
 * - Every tutor is reviewed at 100% until their cohort has passed a gate; proven tutors drop to a random 30%
 *   sample (drawn once, before any flag) plus flagged posts.
 * - Measured fixes: saves after our first post, per actor, up to the owner's current Approve. D-01: a one-time
 *   re-post for an owner policy change (the 29 Sep nickname rule) is `autowriter_policy`, never a fix; an
 *   owner-approved correction of a wrong post is a fix.
 * - Expansion grows the roster by half, rounded up: 5 → 8 → 12 → 18.
 */

import type { AutowriterVerdictSeverity } from "@/lib/db/schema";

/**
 * Bumped whenever a definition below changes, so persisted metrics say which rules produced them.
 * v1 = the rules as decided by the owner on 30 Sep (D-01/D-03); nothing was stored under earlier drafts.
 */
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

/**
 * A measured ratio as a percentage, rounded DOWN to `digits` decimals: 0.79999 reads "79.9%", never "80%", so a
 * shown value never appears to meet a threshold the status says it missed. Thresholds themselves are round.
 */
export function floorPercent(value: number, digits = 1): string {
  const scale = 10 ** digits;
  const floored = Math.floor(value * 100 * scale + 1e-9) / scale;
  return `${floored.toFixed(digits).replace(/\.0+$/u, "")}%`;
}

export interface VerdictLike {
  verdict: "approve" | "needs_fix";
  severity: AutowriterVerdictSeverity | null;
}

/** Approved, or needing only a cosmetic fix. */
export function isAccurate(verdict: VerdictLike): boolean {
  return verdict.verdict === "approve" || (verdict.verdict === "needs_fix" && verdict.severity === "cosmetic");
}

/** How harsh a judgement is: approve 0, cosmetic 1, major (`factual`) 2, critical 3. */
export function judgementRank(verdict: VerdictLike): number {
  if (verdict.verdict === "approve") return 0;
  return verdict.severity === "critical" ? 3 : verdict.severity === "factual" ? 2 : 1;
}

/**
 * Replacing a major or critical judgement (the current verdict, or a critical flag being answered) with a milder
 * verdict is a downgrade the owner must confirm and explain: a verdict judges the first shot as posted, so an
 * Approve after a fix must never quietly turn an inaccurate first shot into an accurate one. Returns what is
 * downgraded, or null.
 */
export function downgradeOf(input: {
  current: VerdictLike | null;
  openCriticalFlag: boolean;
  next: VerdictLike;
}): "critical" | "factual" | null {
  const replaced = Math.max(input.current ? judgementRank(input.current) : 0, input.openCriticalFlag ? 3 : 0);
  if (replaced < 2 || judgementRank(input.next) >= replaced) return null;
  return replaced === 3 ? "critical" : "factual";
}

// ---------------------------------------------------------------------------
// Measured fixes
// ---------------------------------------------------------------------------

/**
 * Whether a classified save counts as a fix now: saves after our first post count "until satisfied", i.e. up to
 * the owner's current Approve. A save after that Approve is listed but not counted; if a later verdict replaces
 * the Approve, it counts again.
 */
export function countsTowardFix(
  event: { countsAsFix: boolean; eventAt: Date },
  current: { verdict: "approve" | "needs_fix"; createdAt: Date } | null,
): boolean {
  if (!event.countsAsFix) return false;
  return !(current?.verdict === "approve" && event.eventAt.getTime() > current.createdAt.getTime());
}

export type FixRoundBucket = "zero" | "one" | "two" | "threePlus" | "unresolved";

/** Fix rounds are final only once the owner approved the class; before that it is unresolved. */
export function fixRoundBucket(current: { verdict: "approve" | "needs_fix" } | null, measuredFixCount: number): FixRoundBucket {
  if (current?.verdict !== "approve") return "unresolved";
  if (measuredFixCount === 0) return "zero";
  if (measuredFixCount === 1) return "one";
  if (measuredFixCount === 2) return "two";
  return "threePlus";
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

export type CoverageClass =
  | "posted"
  | "excluded_scope"
  | "excluded_data_quality"
  | "excluded_tutor_off"
  | "excluded_not_live"
  | "excluded_tutor_first"
  | "pending"
  | "miss_held"
  | "miss_late"
  | "miss_expired"
  | "miss_failed"
  | "miss_unseen";

export const COVERAGE_CLASSES: readonly CoverageClass[] = [
  "posted", "miss_held", "miss_late", "miss_expired", "miss_failed", "miss_unseen",
  "excluded_tutor_first", "excluded_data_quality", "excluded_tutor_off", "excluded_not_live", "excluded_scope", "pending",
];

const MISSES = new Set<CoverageClass>(["miss_held", "miss_late", "miss_expired", "miss_failed", "miss_unseen"]);

export function isCoverageMiss(value: CoverageClass): boolean {
  return MISSES.has(value);
}

/** Skip reasons of an in-person class; such classes are the tutor's and are left out everywhere. */
const ONSITE_REASONS = new Set(["session_type_OFFLINE", "session_type_in_person_title"]);

/**
 * D-03 (owner, 30 Sep 2026): the reasons a class goes unposted because of its own data — no draft of ours could have
 * fixed it — which leave the coverage denominator. Exactly these: a hold where the judge found our draft unfaithful,
 * the validator or the form rejected it, billing drifted or the pipeline failed, and any reason not listed here, is
 * a miss (fail-closed). Reasons are matched whole.
 * Transcript first adds none: a class that fell back to the summary is judged by where it ends, so its fallback cause
 * (`summary_fallback:<cause>`, even a recording in several parts or unclear speakers) never leaves it out, and a
 * mostly-Thai summary held after a fallback (`thai_summary_no_transcript`) is a miss.
 */
export const DATA_QUALITY_REASONS: ReadonlyArray<{
  match: RegExp;
  label: string;
  /** A hold (`held`), or the deadline hand-back of a switched-off tutor's class (`skipped_scope`). */
  coverage: "excluded_data_quality" | "excluded_tutor_off";
}> = [
  { match: /^recording_too_short$/u, label: "Recording too short", coverage: "excluded_data_quality" },
  { match: /^recording_multiple_parts$/u, label: "Recording in several parts", coverage: "excluded_data_quality" },
  { match: /^speakers_unclear$/u, label: "Speakers unclear", coverage: "excluded_data_quality" },
  { match: /^transcript_too_short$/u, label: "Transcript too short", coverage: "excluded_data_quality" },
  { match: /^student_count_0$/u, label: "No student", coverage: "excluded_data_quality" },
  { match: /^attendance_\d+pct$/u, label: "Student absent (attendance below the minimum)", coverage: "excluded_data_quality" },
  { match: /^student_not_wise_user$/u, label: "Student not a Wise user", coverage: "excluded_data_quality" },
  // The same fact when only the POST's fresh read finds it (`submit.ts` precheck): no student with a Wise user id.
  { match: /^student_id_missing$/u, label: "Student not a Wise user (POST check)", coverage: "excluded_data_quality" },
  { match: /^tutor_off_at_deadline$/u, label: "Tutor switched off", coverage: "excluded_tutor_off" },
];

/** The data-quality entry a hold or hand-back reason matches, or null (then the class is a miss). */
export function dataQualityReason(reason: string | null): (typeof DATA_QUALITY_REASONS)[number] | null {
  if (!reason) return null;
  return DATA_QUALITY_REASONS.find((entry) => entry.match.test(reason)) ?? null;
}

/** One change of the control row's mode or tutor switches (`feedback_autowriter_control_history`). */
export interface ControlStateChange {
  changedAt: Date;
  mode: "off" | "shadow" | "live";
  disabledTutors: readonly string[];
}

/** When the review job saw an account on the code roster. */
export interface RosterSpan {
  firstSeenAt: Date;
  lastSeenAt: Date;
}

/** The job records roster sightings hourly; an account counts as on the roster this long after its last sighting. */
export const ROSTER_SIGHTING_SLACK_MS = 2 * 60 * 60 * 1000;

export interface ClassEligibility {
  /** The account was on the roster at some point of the posting window. */
  onRoster: boolean;
  /** At some point of the window: on the roster, mode `live` and the tutor switched on. */
  workable: boolean;
  /** Whenever the window was live and on the roster, the tutor was switched off. */
  tutorOffThroughout: boolean;
  /**
   * The recorded switches had the tutor switched off at the window's end, whatever the mode: what a deadline hand-back
   * must show to be the owner's switch (D-03). False before the history starts (fail-closed).
   */
  tutorOffAtWindowEnd: boolean;
}

/**
 * Judge a class by the switches during its own posting window. The switches are piecewise constant, so they are
 * read at the window's start and at every change inside it. Before the first recorded change the history knows
 * nothing: the mode counts as live and every tutor as on (fail-closed — such a class counts, as a miss if unposted).
 * `tutorOffAtWindowEnd` reads the switches in effect at the window's end (a change at that very instant counts).
 * `roster` undefined means the roster is not in question (the autowriter made a row for the class); null means
 * the account was never seen on the roster.
 */
export function postingWindowEligibility(input: {
  teacherId: string | null;
  window: { start: Date; end: Date };
  history: readonly ControlStateChange[];
  roster?: RosterSpan | null;
}): ClassEligibility {
  const start = input.window.start.getTime();
  const end = Math.max(start, input.window.end.getTime());
  const history = [...input.history].toSorted((a, b) => a.changedAt.getTime() - b.changedAt.getTime());
  const roster = input.roster;
  const rosterEnd = roster ? roster.lastSeenAt.getTime() + ROSTER_SIGHTING_SLACK_MS : null;
  const instants = new Set<number>([start]);
  for (const change of history) {
    const at = change.changedAt.getTime();
    if (at > start && at <= end) instants.add(at);
  }
  if (roster) {
    const first = roster.firstSeenAt.getTime();
    if (first > start && first <= end) instants.add(first);
  }
  let onRoster = false;
  let workable = false;
  let liveOnRoster = false;
  for (const at of instants) {
    const inRoster = roster === undefined || (roster !== null && at >= roster.firstSeenAt.getTime() && at <= rosterEnd!);
    if (!inRoster) continue;
    onRoster = true;
    const state = history.findLast((change) => change.changedAt.getTime() <= at);
    const mode = state?.mode ?? "live";
    const disabled = state?.disabledTutors ?? [];
    if (mode !== "live") continue;
    liveOnRoster = true;
    if (!input.teacherId || !disabled.includes(input.teacherId)) workable = true;
  }
  const atEnd = history.findLast((change) => change.changedAt.getTime() <= end);
  const tutorOffAtWindowEnd = Boolean(input.teacherId && atEnd?.disabledTutors.includes(input.teacherId));
  return { onRoster, workable, tutorOffThroughout: liveOnRoster && !workable, tutorOffAtWindowEnd };
}

const ISO_DAY = String.raw`(?:20\d\d-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|02-(?:0[1-9]|1\d|2[0-8]))|20(?:[02468][048]|[13579][26])-02-29)`;
const ISO_TIME = String.raw`(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?`;
/**
 * A call record's `result.attemptAt` that can be read as a time: the form our own code writes (`Date#toISOString`,
 * `2026-09-30T12:40:00.000Z`), and a real day and time of this century — so a value that matches always casts to a
 * timestamp. The daily-metrics query casts `attemptAt` only when it matches (review-job.ts): a malformed value
 * (edited by hand, or a later bug's) dates the call by its row instead of failing the whole query. Written to be a
 * Postgres and a JavaScript regular expression alike.
 */
export const ATTEMPT_AT_PATTERN = `^${ISO_DAY}T${ISO_TIME}Z$`;

/**
 * Whether the tutor (or any person) wrote the class before we started writing it — before our first writer call,
 * successful or not (waiting for the evidence is not a miss; a writer outage is). `firstWriterCallAt` is when that
 * call's request was sent: a rate-limited attempt records it (`result.attemptAt`), since its row is only written
 * after the waits; any other call's row is dated when it ended (`created_at`). A person's save we have not seen
 * (activity not mirrored yet) proves nothing: the class counts as a miss until the event arrives (the metrics are
 * recomputed hourly).
 */
export function tutorWroteFirst(input: { firstWriterCallAt: Date | null; firstHumanSaveAt: Date | null }): boolean {
  if (!input.firstHumanSaveAt) return false;
  if (!input.firstWriterCallAt) return true;
  return input.firstHumanSaveAt.getTime() < input.firstWriterCallAt.getTime();
}

export interface CoverageInput {
  /** The autowriter row's state; null when the autowriter never saw the class. */
  state: string | null;
  reason: string | null;
  /** For a class the autowriter never saw: proven online one-to-one (past session blocks or Wise title/type). */
  provenOnlineOneToOne?: boolean;
  /** Mode, tutor switch and roster over the posting window; absent → workable (fail-closed). */
  eligibility?: ClassEligibility;
  /** The posting window (class end → deadline − margin) is over. */
  windowClosed?: boolean;
  /** For `skipped_human`: a person wrote before we started writing. Absent → not proven (a miss). */
  tutorWroteFirst?: boolean;
}

/**
 * Where one roster class stands for coverage; null when it does not count at all (in-person, an unseen class not
 * proven to be online one-to-one, or one whose account was never on the roster during its window).
 * A POST proves the class was workable; every other class the switches never let us write is excluded, and so is a
 * class held for a data-quality reason, or handed back at the deadline while its tutor was switched off as its window
 * closed (D-03).
 */
export function classifyCoverage(input: CoverageInput): CoverageClass | null {
  const { state, reason, eligibility } = input;
  const notWorkable = (): CoverageClass => eligibility?.tutorOffThroughout ? "excluded_tutor_off" : "excluded_not_live";
  if (state === null) {
    if (!input.provenOnlineOneToOne) return null;
    if (eligibility && !eligibility.onRoster) return null;
    if (eligibility && !eligibility.workable) return notWorkable();
    return "miss_unseen";
  }
  if (state === "skipped_scope" && reason !== null && ONSITE_REASONS.has(reason)) return null;
  if (state === "verified" || state === "awaiting_event") return "posted";
  const dataQuality = dataQualityReason(reason);
  if (state === "skipped_scope") {
    if (dataQuality?.coverage !== "excluded_tutor_off") return "excluded_scope";
    // Handed back unposted at the deadline because its tutor was switched off: the owner's switch, never our miss
    // (D-03) — when the history shows the tutor off as the window closed. The sweep stamps the reason from the switches
    // when it runs (up to 15 minutes later, or once the mode is back from `off`), so a hand-back whose tutor was still
    // on then is judged like the expiry it replaced.
    if (eligibility?.tutorOffAtWindowEnd) return "excluded_tutor_off";
  }
  if (eligibility && !eligibility.workable) return notWorkable();
  switch (state) {
    case "skipped_human":
      return input.tutorWroteFirst === true ? "excluded_tutor_first" : "miss_late";
    case "held":
      // D-03: the class's own data (recording, speakers, transcript, absence, not a Wise user) is left out; a hold on
      // our drafts (unfaithful, validation, form), billing drift or an error is a miss.
      return dataQuality?.coverage === "excluded_data_quality" ? "excluded_data_quality" : "miss_held";
    case "skipped_scope": // a hand-back the switches did not make when the window closed (above)
    case "expired":
      return "miss_expired";
    case "rejected":
    case "unknown_outcome":
    case "verify_failed":
      return "miss_failed";
    case "posting":
      return "pending";
    default:
      // pending, generating, awaiting_recording, transcribing, would_submit: still in the works — or, once the
      // posting window is over, a class that can no longer be posted (the sweep may not have expired it yet).
      // Transcript first: a class waiting for its recording (`transcript_first`) and one back on the summary after a
      // fallback (`summary_fallback:<cause>`) are in the works like any other.
      return input.windowClosed ? "miss_expired" : "pending";
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
  /** Required posts in the window with no verdict yet: the gate never counts a hand-picked subset. */
  requiredPending: number;
  /** Posted classes in the window whose first shot is not recorded yet — still settling, or unprovable. */
  unrecordedPosts: number;
  /** API writes to Wise no post explains, since go-live, not yet acknowledged by the owner (critical: block). */
  unexplainedApiWrites: number;
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
  const threshold = (value: number) => `${Math.round(value * 100)}%`;
  const reasons: string[] = [];
  if (input.criticalVerdicts > 0) reasons.push(`${input.criticalVerdicts} critical verdict(s) in the window`);
  if (input.unresolvedCriticalFlags > 0) reasons.push(`${input.unresolvedCriticalFlags} unresolved critical flag(s)`);
  if (input.unexplainedApiWrites > 0) reasons.push(`${input.unexplainedApiWrites} API write(s) to Wise no post explains, not acknowledged`);
  if (input.reviewed === 0) reasons.push("no owner-reviewed posts in the window");
  else if (wilsonLower < thresholds.passLowerBound) {
    reasons.push(`accuracy lower bound ${floorPercent(wilsonLower)} < ${threshold(thresholds.passLowerBound)} (${input.accurate}/${input.reviewed})`);
  }
  if (coverage === null) reasons.push("no eligible classes in the window");
  else if (coverage < thresholds.minCoverage) {
    reasons.push(`coverage ${floorPercent(coverage)} < ${threshold(thresholds.minCoverage)} (${input.coverageNum}/${input.coverageDen})`);
  }
  if (input.pendingFlaggedReviews > 0) reasons.push(`${input.pendingFlaggedReviews} flagged post(s) waiting for review`);
  if (input.requiredPending > 0) reasons.push(`${input.requiredPending} required post(s) not yet reviewed`);
  if (input.unrecordedPosts > 0) reasons.push(`${input.unrecordedPosts} posted class(es) whose first shot is not recorded yet`);

  let status: GateStatus;
  if (input.criticalVerdicts > 0 || input.unresolvedCriticalFlags > 0 || input.unexplainedApiWrites > 0) status = "blocked_critical";
  else if (input.reviewed === 0) status = "insufficient_data";
  else if (wilsonLower >= thresholds.passLowerBound && coverage !== null && coverage >= thresholds.minCoverage
    && input.pendingFlaggedReviews === 0 && input.requiredPending === 0 && input.unrecordedPosts === 0) status = "pass";
  else if (wilsonLower >= thresholds.headStartLowerBound) status = "head_start";
  else status = "below_head_start";
  return { status, wilsonLower, coverage, reasons };
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
  posted: number;
  eligible: number;
}

/**
 * Gate inputs for an inclusive window of Bangkok dates. Accuracy counts only required reviews that have a
 * verdict (a voluntary review of a post that was not sampled never counts); critical verdicts count whatever the
 * sampling; coverage sums the all-tutor metric rows (each class was already judged by its own window).
 */
export function computeGateFacts(input: {
  window: { start: string; end: string };
  reviews: readonly GateReviewFact[];
  unresolvedCriticalFlags: number;
  unrecordedPosts: number;
  unexplainedApiWrites: number;
  metrics: readonly GateMetricFact[];
}): GateInput {
  const inWindow = (date: string) => date >= input.window.start && date <= input.window.end;
  const reviews = input.reviews.filter((review) => inWindow(review.bangkokDate));
  const required = reviews.filter((review) => isRequiredReview(review.inclusionReason));
  const counted = required.filter((review) => review.verdict !== null);
  const coverage = input.metrics.filter((row) => row.tutorKey === "*" && inWindow(row.metricDate));
  return {
    reviewed: counted.length,
    accurate: counted.filter((review) => isAccurate(review.verdict!)).length,
    criticalVerdicts: reviews.filter((review) => review.verdict?.severity === "critical").length,
    unresolvedCriticalFlags: input.unresolvedCriticalFlags,
    pendingFlaggedReviews: reviews.filter((review) => review.hasOpenFlag).length,
    requiredPending: required.length - counted.length,
    unrecordedPosts: input.unrecordedPosts,
    unexplainedApiWrites: input.unexplainedApiWrites,
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
  /** Held for the class's own data (D-03): left out of coverage. */
  excludedDataQuality: number;
  excludedTutorOff: number;
  excludedNotLive: number;
  pending: number;
  unseen: number;
  /** Held for any other reason (our drafts rejected, form or billing drift, errors): a miss. */
  held: number;
  late: number;
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
      excludedDataQuality: counts.excluded_data_quality,
      excludedTutorOff: counts.excluded_tutor_off,
      excludedNotLive: counts.excluded_not_live,
      pending: counts.pending,
      unseen: counts.miss_unseen,
      held: counts.miss_held,
      late: counts.miss_late,
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

/**
 * Every Bangkok date the metrics must be current for: the window of the next daily gate row and the dashboard's
 * window (≤ 15 dates, oldest first). A class settles up to two days after it ends (expiry at the deadline) and a
 * verdict can land any time, so the whole window is recomputed on every run — never only the last few days.
 */
export function metricDates(now: Date): string[] {
  const today = bangkokDateKey(now);
  const dates: string[] = [];
  for (let date = gateWindow(dailyGateDate(now)).start; date <= today; date = addDays(date, 1)) dates.push(date);
  return dates;
}
