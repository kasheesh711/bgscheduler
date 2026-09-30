import type { Database } from "@/lib/db";
import { HOLD_REASON_CATEGORIES, holdReasonCategory, type HoldReasonCategory } from "./hold-reasons";
import {
  GATE_WINDOW_DAYS,
  addDays,
  bangkokDateKey,
  isAccurate,
  isRequiredReview,
  wilsonLowerBound,
  type InclusionReason,
  type VerdictLike,
} from "./quality";
import type { AutowriterState } from "./store";
import type { ModelArm } from "./types";

/**
 * Daily trend series of the autowriter dashboard (redesign, section 4.2): accuracy and the gate, coverage, speed and
 * cost, evidence and models. Read-only. `buildAutowriterTrends` is pure; `loadAutowriterTrends` reads our database.
 * Client components import the types only (the loader pulls in the database layer).
 *
 * Every date is the Bangkok date of the class's scheduled end — the date `feedback_autowriter_daily_metrics` uses.
 * Every 7-day value is pooled: the numerators and the denominators are summed over the date and the six days before
 * it, then divided, so a day with two classes cannot swing it. A day with no data is a gap (null), never zero.
 */

export const TREND_RANGES = [14, 30, 90] as const;
export type TrendRangeDays = 14 | 30 | 90;

/** The `tutorKey` of the all-tutors series. */
export const ALL_TUTORS = "*";

/** Every ratio's moving average pools this many days: the date and the six before it. */
export const TREND_POOL_DAYS = 7;

/** Days read before the range so the rolling values of its first date are complete (the 14-day lower bound). */
export const TREND_LOOKBACK_DAYS = GATE_WINDOW_DAYS - 1;

export interface TrendDay {
  /** Bangkok date of the class's scheduled end, YYYY-MM-DD. */
  date: string;
  /** Required reviews with a verdict, the accurate ones among them, and every critical verdict (sampled or not). */
  reviewed: number;
  accurate: number;
  critical: number;
  /** accurate / reviewed; null when reviewed = 0. */
  accuracy: number | null;
  /** Pooled over the date and the six days before. */
  accuracy7d: number | null;
  /** `wilsonLowerBound` over the date and the 13 days before; null when nothing was reviewed in them. */
  wilson14d: number | null;
  /** The stored coverage pair of the date (`feedback_autowriter_daily_metrics`): posted ÷ eligible. */
  posted: number;
  eligible: number;
  coverage: number | null;
  coverage7d: number | null;
  /** Median minutes from the scheduled class end to the POST claim, over the classes posted with this class date. */
  minutesToPost: number | null;
  /** The median over the classes posted in the pooled seven days. */
  minutesToPost7d: number | null;
  /** Every model and transcription call of the classes with this class date. */
  costUsd: number;
  /** costUsd ÷ classes posted (`fromSummary + fromTranscript`); null when none was posted. */
  costPerClass: number | null;
  costPerClass7d: number | null;
  /** Classes posted with this class date, by the evidence they were written from. */
  fromSummary: number;
  fromTranscript: number;
  /** fromTranscript ÷ classes posted, pooled over seven days. */
  transcriptShare7d: number | null;
  /** Classes posted with this class date, by the writer of the posted draft. */
  writers: { sol: number; luna: number; glm: number };
}

export interface AutowriterTrends {
  generatedAt: string;
  range: { start: string; end: string; days: TrendRangeDays };
  /** "*" = all tutors. */
  tutorKey: string;
  /**
   * The first date with any data among the dates read (the range and its look-back); null when there is none. A value
   * after `range.start` means the series begin inside the range, so the first 7-day values cover fewer than 7 days.
   */
  since: string | null;
  /** One entry per date in the range, oldest first (gaps are entries with nulls and zeros). */
  days: TrendDay[];
  /** Over the range only (never the look-back). */
  totals: {
    reviewed: number;
    accurate: number;
    critical: number;
    posted: number;
    eligible: number;
    medianMinutesToPost: number | null;
    p90MinutesToPost: number | null;
    costUsd: number;
    costPerClass: number | null;
    fromSummary: number;
    fromTranscript: number;
    writers: { sol: number; luna: number; glm: number };
    /** Classes in state `held` with a class date in the range, by `holdReasonCategory`. */
    holdsByCategory: Record<HoldReasonCategory, number>;
  };
}

/** What `buildAutowriterTrends` shapes: rows of the range and its look-back (`TREND_LOOKBACK_DAYS`), already dated. */
export interface TrendSourceRows {
  now: Date;
  days: TrendRangeDays;
  tutorKey: string;
  /** The stored coverage of each class date: the `feedback_autowriter_daily_metrics` rows of `tutorKey`. */
  metrics: ReadonlyArray<{ date: string; posted: number; eligible: number }>;
  /** Every review row of the dates read, with its current verdict (null while it has none). */
  reviews: ReadonlyArray<{ date: string; inclusionReason: InclusionReason; verdict: VerdictLike | null }>;
  /** Every autowriter row whose class ended on the dates read (in-person classes left out), with its calls' cost. */
  classes: ReadonlyArray<{
    date: string;
    state: AutowriterState;
    reason: string | null;
    arm: ModelArm | null;
    evidence: "summary" | "transcript";
    /** Scheduled class end → POST claim; null when the class was never posted. */
    minutesToPost: number | null;
    costUsd: number;
  }>;
}

/** Σ of `values` over `index` and the `span − 1` entries before it; entries outside the series are days without data. */
function windowSum(values: readonly number[], index: number, span: number): number {
  let sum = 0;
  for (let at = Math.max(0, index - span + 1); at <= index; at += 1) sum += values[at] ?? 0;
  return sum;
}

/**
 * Σ numerators ÷ Σ denominators over `index` and the `span − 1` entries before it (fewer at the start of the series);
 * null when the pooled denominator is 0.
 */
export function pooledRate(numerators: readonly number[], denominators: readonly number[], index: number, span = TREND_POOL_DAYS): number | null {
  const denominator = windowSum(denominators, index, span);
  return denominator > 0 ? windowSum(numerators, index, span) / denominator : null;
}

/**
 * The Wilson 95% lower bound (`wilsonLowerBound`) of the pooled counts over `index` and the `span − 1` entries before
 * it; null when nothing was reviewed in them.
 */
export function rollingWilson(accurate: readonly number[], reviewed: readonly number[], index: number, span = GATE_WINDOW_DAYS): number | null {
  const trials = windowSum(reviewed, index, span);
  return trials > 0 ? wilsonLowerBound(windowSum(accurate, index, span), trials) : null;
}

/** The median (the mean of the two middle values for an even count); null when there are no values. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** The nearest-rank percentile `p` (0–100); null when there are no values. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const rank = Math.ceil((p * sorted.length) / 100);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

function round(value: number | null, digits: number): number | null {
  if (value === null) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Minutes are shown to one decimal, money to a hundredth of a cent (as on the dashboard); ratios are never rounded. */
const minutes = (value: number | null) => round(value, 1);
const usd = (value: number | null) => round(value, 4);

/** A POST claimed for the class: in flight, awaiting its event, or verified (as the dashboard counts "posted"). */
const POSTED_STATES: ReadonlySet<AutowriterState> = new Set(["posting", "awaiting_event", "verified"]);
const WRITER_ARMS = ["sol", "luna", "glm"] as const satisfies readonly ModelArm[];

/** Everything counted for one class date. */
interface DayCounts {
  hasData: boolean;
  reviewed: number;
  accurate: number;
  critical: number;
  posted: number;
  eligible: number;
  /** Classes in a posted state (the autowriter's rows), and their minutes from class end to the POST. */
  postedClasses: number;
  latencies: number[];
  costUsd: number;
  fromSummary: number;
  fromTranscript: number;
  writers: Record<(typeof WRITER_ARMS)[number], number>;
  heldReasons: Array<string | null>;
}

function emptyDayCounts(): DayCounts {
  return {
    hasData: false, reviewed: 0, accurate: 0, critical: 0, posted: 0, eligible: 0, postedClasses: 0, latencies: [],
    costUsd: 0, fromSummary: 0, fromTranscript: 0, writers: { sol: 0, luna: 0, glm: 0 }, heldReasons: [],
  };
}

/**
 * Pure shaping of the trend series, so every number is unit-testable without a database.
 * 1. Count every row under its class date, over the range and its look-back; rows of other dates are ignored.
 * 2. One entry per date of the range: the day's own values, and the rolling ones over the days before it.
 * 3. Totals over the range only.
 */
export function buildAutowriterTrends(input: TrendSourceRows): AutowriterTrends {
  const end = bangkokDateKey(input.now);
  const start = addDays(end, -(input.days - 1));
  const dates: string[] = [];
  for (let date = addDays(start, -TREND_LOOKBACK_DAYS); date <= end; date = addDays(date, 1)) dates.push(date);
  const counts = new Map(dates.map((date) => [date, emptyDayCounts()]));

  for (const row of input.metrics) {
    const day = counts.get(row.date);
    if (!day) continue;
    day.posted += row.posted;
    day.eligible += row.eligible;
    // The review job stores a row for every date: one without a class is not data.
    if (row.posted > 0 || row.eligible > 0) day.hasData = true;
  }
  for (const row of input.reviews) {
    const day = counts.get(row.date);
    if (!day) continue;
    day.hasData = true;
    // As the gate counts them (`computeGateFacts`): accuracy over required reviews with a verdict, critical verdicts
    // whatever the sampling.
    if (row.verdict?.severity === "critical") day.critical += 1;
    if (!row.verdict || !isRequiredReview(row.inclusionReason)) continue;
    day.reviewed += 1;
    if (isAccurate(row.verdict)) day.accurate += 1;
  }
  for (const row of input.classes) {
    const day = counts.get(row.date);
    if (!day) continue;
    day.hasData = true;
    day.costUsd += row.costUsd;
    if (row.state === "held") day.heldReasons.push(row.reason);
    if (!POSTED_STATES.has(row.state)) continue;
    day.postedClasses += 1;
    if (row.minutesToPost !== null) day.latencies.push(row.minutesToPost);
    if (row.evidence === "transcript") day.fromTranscript += 1; else day.fromSummary += 1;
    if (row.arm) day.writers[row.arm] += 1;
  }

  const series = dates.map((date) => counts.get(date)!);
  const column = (pick: (day: DayCounts) => number) => series.map(pick);
  const reviewed = column((day) => day.reviewed);
  const accurate = column((day) => day.accurate);
  const posted = column((day) => day.posted);
  const eligible = column((day) => day.eligible);
  const postedClasses = column((day) => day.postedClasses);
  const cost = column((day) => day.costUsd);
  const fromTranscript = column((day) => day.fromTranscript);

  const days = series.map((day, index): TrendDay => ({
    date: dates[index],
    reviewed: day.reviewed,
    accurate: day.accurate,
    critical: day.critical,
    accuracy: pooledRate(accurate, reviewed, index, 1),
    accuracy7d: pooledRate(accurate, reviewed, index),
    wilson14d: rollingWilson(accurate, reviewed, index),
    posted: day.posted,
    eligible: day.eligible,
    coverage: pooledRate(posted, eligible, index, 1),
    coverage7d: pooledRate(posted, eligible, index),
    minutesToPost: minutes(median(day.latencies)),
    minutesToPost7d: minutes(median(series.slice(Math.max(0, index - TREND_POOL_DAYS + 1), index + 1).flatMap((pooled) => pooled.latencies))),
    costUsd: usd(day.costUsd) ?? 0,
    costPerClass: usd(pooledRate(cost, postedClasses, index, 1)),
    costPerClass7d: usd(pooledRate(cost, postedClasses, index)),
    fromSummary: day.fromSummary,
    fromTranscript: day.fromTranscript,
    transcriptShare7d: pooledRate(fromTranscript, postedClasses, index),
    writers: { ...day.writers },
  })).slice(TREND_LOOKBACK_DAYS);

  const inRange = series.slice(TREND_LOOKBACK_DAYS);
  const sum = (pick: (day: DayCounts) => number) => inRange.reduce((total, day) => total + pick(day), 0);
  const latencies = inRange.flatMap((day) => day.latencies);
  const totalCost = sum((day) => day.costUsd);
  const totalPostedClasses = sum((day) => day.postedClasses);
  const holdsByCategory = Object.fromEntries(HOLD_REASON_CATEGORIES.map((category) => [category, 0])) as Record<HoldReasonCategory, number>;
  for (const reason of inRange.flatMap((day) => day.heldReasons)) holdsByCategory[holdReasonCategory(reason)] += 1;

  return {
    generatedAt: input.now.toISOString(),
    range: { start, end, days: input.days },
    tutorKey: input.tutorKey,
    since: dates.find((date) => counts.get(date)!.hasData) ?? null,
    days,
    totals: {
      reviewed: sum((day) => day.reviewed),
      accurate: sum((day) => day.accurate),
      critical: sum((day) => day.critical),
      posted: sum((day) => day.posted),
      eligible: sum((day) => day.eligible),
      medianMinutesToPost: minutes(median(latencies)),
      p90MinutesToPost: minutes(percentile(latencies, 90)),
      costUsd: usd(totalCost) ?? 0,
      costPerClass: totalPostedClasses > 0 ? usd(totalCost / totalPostedClasses) : null,
      fromSummary: sum((day) => day.fromSummary),
      fromTranscript: sum((day) => day.fromTranscript),
      writers: Object.fromEntries(WRITER_ARMS.map((arm) => [arm, sum((day) => day.writers[arm])])) as DayCounts["writers"],
      holdsByCategory,
    },
  };
}

/**
 * Read-only loader for the page and `GET /api/feedback-autowriter/trends`. Coverage comes from the stored daily
 * metrics; accuracy is recomputed from the review rows and their current verdicts (the review job recomputes only the
 * last 15 dates, so an older stored row does not show a verdict recorded since).
 */
export async function loadAutowriterTrends(
  db: Database,
  input: { days: TrendRangeDays; tutorKey: string; now?: Date },
): Promise<AutowriterTrends> {
  void db;
  void input;
  throw new Error("not implemented");
}
