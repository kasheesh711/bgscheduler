import {
  addBangkokDays,
  bangkokDateKey,
  bangkokDateStartUtc,
  bangkokWeekday,
  endOfBangkokMonth,
  monthStart,
  todayBangkok,
} from "@/lib/room-capacity/dates";
import {
  FOOT_TRAFFIC_HISTORY_START,
  FOOT_TRAFFIC_REPORT_MAX_DAYS,
  FOOT_TRAFFIC_RESEARCH_END,
} from "./types";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function assertFootTrafficDate(value: string, label = "date"): string {
  if (!ISO_DATE_RE.test(value)) {
    throw new Error(`Invalid ${label}. Expected YYYY-MM-DD.`);
  }
  const parsed = bangkokDateStartUtc(value);
  if (Number.isNaN(parsed.getTime()) || bangkokDateKey(parsed) !== value) {
    throw new Error(`Invalid ${label}. Expected a real calendar date.`);
  }
  return value;
}

export function latestCompletedBangkokDate(now = new Date()): string {
  return addBangkokDays(todayBangkok(now), -1);
}

export function defaultFootTrafficRange(now = new Date()): { startDate: string; endDate: string } {
  void now;
  return {
    startDate: FOOT_TRAFFIC_HISTORY_START,
    endDate: FOOT_TRAFFIC_RESEARCH_END,
  };
}

export function daysInclusive(startDate: string, endDate: string): number {
  return Math.floor(
    (bangkokDateStartUtc(endDate).getTime() - bangkokDateStartUtc(startDate).getTime()) / 86_400_000,
  ) + 1;
}

export function validateFootTrafficRange(
  startDate: string,
  endDate: string,
  options: { maxDays?: number | null } = {},
): void {
  assertFootTrafficDate(startDate, "startDate");
  assertFootTrafficDate(endDate, "endDate");
  if (startDate > endDate) throw new Error("Invalid date range. startDate must be on or before endDate.");
  if (startDate < FOOT_TRAFFIC_HISTORY_START) {
    throw new Error(`Invalid startDate. Foot-traffic history begins ${FOOT_TRAFFIC_HISTORY_START}.`);
  }
  const maxDays = options.maxDays === undefined ? FOOT_TRAFFIC_REPORT_MAX_DAYS : options.maxDays;
  if (maxDays && daysInclusive(startDate, endDate) > maxDays) {
    throw new Error(`Invalid date range. Maximum range is ${maxDays} days.`);
  }
}

export function mondayWeekStart(date: string): string {
  const weekday = bangkokWeekday(date);
  return addBangkokDays(date, weekday === 0 ? -6 : 1 - weekday);
}

export function weekEnd(date: string): string {
  return addBangkokDays(mondayWeekStart(date), 6);
}

export function formatFootTrafficDate(date: string, options: Intl.DateTimeFormatOptions = {}): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    day: "numeric",
    month: "short",
    year: "numeric",
    ...options,
  }).format(bangkokDateStartUtc(date));
}

export function monthLabel(date: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    month: "short",
    year: "numeric",
  }).format(bangkokDateStartUtc(date));
}

export function monthBounds(date: string): { start: string; end: string } {
  return { start: monthStart(date), end: endOfBangkokMonth(date) };
}

export function bangkokTimeLabel(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export { addBangkokDays, bangkokDateKey, bangkokWeekday, endOfBangkokMonth, monthStart };
