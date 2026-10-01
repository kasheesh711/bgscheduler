// ----------------------------------------------------------------------------
// Tutor Offboarding calibration (spec §4.3): how often BeGifted tutors came back
// after being idle for a given number of days, learned from our own history.
// Pure; works on Bangkok date keys (YYYY-MM-DD).
// ----------------------------------------------------------------------------

/** First Bangkok day of usable teaching history: the progress-test attendance ledger starts here. */
export const HISTORY_START = new Date("2026-03-01T00:00:00+07:00");
export const HISTORY_START_KEY = "2026-03-01";

export const GAP_THRESHOLDS = [21, 30, 45, 60, 90] as const;
export type GapThreshold = (typeof GAP_THRESHOLDS)[number];

/** Used when a threshold has fewer than MIN_SAMPLE observations (the 1 Oct 2026 backtest). */
export const DEFAULT_GONE_PROBABILITY: Record<GapThreshold, number> = { 21: 0.6, 30: 0.7, 45: 0.78, 60: 0.9, 90: 0.96 };
/** Base likelihood for a gap under the first threshold. */
export const ACTIVE_BASE_PROBABILITY = 0.03;
export const MIN_SAMPLE = 5;

export interface CurvePoint {
  thresholdDays: GapThreshold;
  /** Closed gaps at least this long: the tutor taught again afterwards. */
  returned: number;
  /** Open gaps at least this long: idle up to today. */
  stillIdle: number;
  goneProbability: number;
  usedDefault: boolean;
}

export interface CalibrationCurve {
  points: CurvePoint[];
  tutorsObserved: number;
  historyStart: string;
}

function dayNumber(key: string): number {
  const [year, month, day] = key.split("-").map(Number);
  return Math.round(Date.UTC(year, month - 1, day) / 86_400_000);
}

export function daysBetweenDateKeys(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

/**
 * Builds the return-rate curve:
 * 1. per tutor, consecutive taught dates form closed gaps; the last date to today is the open gap;
 * 2. per threshold, P(gone) = 1 - (returned + 0.5) / (returned + stillIdle + 1), Jeffreys-smoothed;
 * 3. thresholds with fewer than MIN_SAMPLE observations use DEFAULT_GONE_PROBABILITY;
 * 4. the curve is made non-decreasing, so a longer gap never looks less final.
 * Tutors who never taught are not in `taughtDates` and do not count.
 */
export function buildCalibrationCurve(taughtDates: ReadonlyMap<string, readonly string[]>, todayKey: string): CalibrationCurve {
  const closed: number[] = [];
  const open: number[] = [];
  let tutorsObserved = 0;
  for (const dates of taughtDates.values()) {
    const sorted = [...new Set(dates)].sort();
    if (sorted.length === 0) continue;
    tutorsObserved += 1;
    for (let index = 1; index < sorted.length; index += 1) closed.push(daysBetweenDateKeys(sorted[index - 1], sorted[index]));
    open.push(Math.max(0, daysBetweenDateKeys(sorted[sorted.length - 1], todayKey)));
  }
  let previous = 0;
  const points = GAP_THRESHOLDS.map((thresholdDays): CurvePoint => {
    const returned = closed.filter((gap) => gap >= thresholdDays).length;
    const stillIdle = open.filter((gap) => gap >= thresholdDays).length;
    const usedDefault = returned + stillIdle < MIN_SAMPLE;
    const raw = usedDefault ? DEFAULT_GONE_PROBABILITY[thresholdDays] : 1 - (returned + 0.5) / (returned + stillIdle + 1);
    const goneProbability = Math.max(raw, previous);
    previous = goneProbability;
    return { thresholdDays, returned, stillIdle, goneProbability, usedDefault };
  });
  return { points, tutorsObserved, historyStart: HISTORY_START.toISOString() };
}

/** Base likelihood for an idle gap: the value at the largest threshold the gap has reached. */
export function baseGoneProbability(curve: CalibrationCurve, gapDays: number): number {
  let probability = ACTIVE_BASE_PROBABILITY;
  for (const point of curve.points) if (gapDays >= point.thresholdDays) probability = point.goneProbability;
  return probability;
}
