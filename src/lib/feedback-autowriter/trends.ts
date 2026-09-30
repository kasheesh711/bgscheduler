import type { Database } from "@/lib/db";
import type { HoldReasonCategory } from "./hold-reasons";
import type { InclusionReason, VerdictLike } from "./quality";
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

/** Days read before the range so the rolling values of its first date are complete (the 14-day lower bound). */
export const TREND_LOOKBACK_DAYS = 13;

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

/**
 * Σ numerators ÷ Σ denominators over `index` and the `span − 1` entries before it (fewer at the start of the series);
 * null when the pooled denominator is 0.
 */
export function pooledRate(numerators: readonly number[], denominators: readonly number[], index: number, span = 7): number | null {
  void numerators;
  void denominators;
  void index;
  void span;
  throw new Error("not implemented");
}

/**
 * The Wilson 95% lower bound (`wilsonLowerBound`) of the pooled counts over `index` and the `span − 1` entries before
 * it; null when nothing was reviewed in them.
 */
export function rollingWilson(accurate: readonly number[], reviewed: readonly number[], index: number, span = 14): number | null {
  void accurate;
  void reviewed;
  void index;
  void span;
  throw new Error("not implemented");
}

/** The median (the mean of the two middle values for an even count); null when there are no values. */
export function median(values: readonly number[]): number | null {
  void values;
  throw new Error("not implemented");
}

/** The nearest-rank percentile `p` (0–100); null when there are no values. */
export function percentile(values: readonly number[], p: number): number | null {
  void values;
  void p;
  throw new Error("not implemented");
}

/** Pure shaping of the trend series, so every number is unit-testable without a database. */
export function buildAutowriterTrends(input: TrendSourceRows): AutowriterTrends {
  void input;
  throw new Error("not implemented");
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
