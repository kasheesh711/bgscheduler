import { formatInTimeZone } from "date-fns-tz";
import { bangkokDayStart, bangkokMonthBounds, intersectIntervals, intervalMinutes } from "../intervals";
import type { WorkforceSourceCoverage } from "../types";

export const GROWTH_HISTORY_FLOOR = "2026-03-01";
export const GROWTH_CHURN_WAIT_MS = 60 * 86400000;
export function monthOf(instant: string | Date): string { return formatInTimeZone(instant, "Asia/Bangkok", "yyyy-MM"); }
export function addMonths(month: string, amount: number): string {
  bangkokMonthBounds(month);
  if (!Number.isInteger(amount)) throw new Error("Month offset must be an integer");
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year, number - 1 + amount, 1)).toISOString().slice(0, 7);
}
export function churnBaselineMonths(lastTaughtAt: string): string[] {
  const month = monthOf(lastTaughtAt);
  return [-3, -2, -1].map(offset => addMonths(month, offset));
}
export function isGrowthMonthMature(month: string, now: Date): boolean {
  const bounds = bangkokMonthBounds(month);
  // The last possible class before this loss month ends one millisecond before its start.
  return bounds.end <= now.getTime() && bounds.start - 1 + GROWTH_CHURN_WAIT_MS <= now.getTime();
}
export function commonMatureWindow(now: Date): string[] {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid model time");
  let newest = addMonths(monthOf(now), -1);
  while (newest >= "2026-04" && !isGrowthMonthMature(newest, now)) newest = addMonths(newest, -1);
  const months = [-2,-1,0].map(offset => addMonths(newest, offset));
  return months[0] < "2026-04" ? [] : months;
}
export function historyCoversMonth(coverage: WorkforceSourceCoverage[], month: string): boolean {
  const bounds = bangkokMonthBounds(month);
  if (bounds.start < bangkokDayStart(GROWTH_HISTORY_FLOOR)) return false;
  const intervals = coverage.filter(c => c.source === "wise_history" && c.completeness === "complete" && !c.truncated).flatMap(c => {
    try { return [{ start: bangkokDayStart(c.requestedFrom), end: bangkokDayStart(c.requestedTo) + 86400000 }]; }
    catch { return []; }
  });
  return intervalMinutes(intersectIntervals(intervals, [bounds])) * 60000 >= bounds.end - bounds.start;
}
