import type { SalesDashboardSourceRecord, SalesSourceStatus } from "./types";
import {
  bangkokDayOfMonth,
  currentBangkokMonthStart,
  previousBangkokMonthStart,
} from "./dates";

export function sourceShouldRefresh(
  source: Pick<SalesDashboardSourceRecord, "sourceMonth" | "status">,
  now = new Date(),
): boolean {
  if (source.status === "finalized") return false;
  const current = currentBangkokMonthStart(now);
  const previous = previousBangkokMonthStart(now);
  if (source.sourceMonth === current) return true;
  if (source.sourceMonth === previous) return bangkokDayOfMonth(now) <= 7;
  return false;
}

export function statusAfterSuccessfulImport(
  sourceMonth: string,
  currentStatus: SalesSourceStatus,
  now = new Date(),
): SalesSourceStatus {
  if (currentStatus === "reopened") return "reopened";
  const current = currentBangkokMonthStart(now);
  const previous = previousBangkokMonthStart(now);
  if (sourceMonth === current) return "active";
  if (sourceMonth === previous && bangkokDayOfMonth(now) <= 7) return "active";
  return "finalized";
}

export function shouldAutoFinalizePreviousMonth(
  source: Pick<SalesDashboardSourceRecord, "sourceMonth" | "status">,
  now = new Date(),
): boolean {
  if (source.status === "finalized" || source.status === "reopened") return false;
  return source.sourceMonth === previousBangkokMonthStart(now) && bangkokDayOfMonth(now) >= 8;
}

export function isHistoricalMonth(sourceMonth: string, now = new Date()): boolean {
  const current = currentBangkokMonthStart(now);
  const previous = previousBangkokMonthStart(now);
  return sourceMonth !== current && sourceMonth !== previous;
}
