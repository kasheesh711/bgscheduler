import { toZonedTime } from "date-fns-tz";

export const TIMEZONE = "Asia/Bangkok";

/**
 * Convert a UTC ISO string or Date to a Date in Asia/Bangkok timezone.
 */
export function toLocalTime(utcDateOrString: Date | string): Date {
  const utcDate = typeof utcDateOrString === "string" ? new Date(utcDateOrString) : utcDateOrString;
  return toZonedTime(utcDate, TIMEZONE);
}

/**
 * Get weekday (0=Sun..6=Sat) in Asia/Bangkok timezone.
 */
export function getLocalWeekday(utcDateOrString: Date | string): number {
  return toLocalTime(utcDateOrString).getDay();
}

/**
 * Get minutes since midnight in Asia/Bangkok timezone.
 */
export function getLocalMinuteOfDay(utcDateOrString: Date | string): number {
  const local = toLocalTime(utcDateOrString);
  return local.getHours() * 60 + local.getMinutes();
}

/**
 * Parse a time string like "09:00" or "14:30" into minutes since midnight.
 */
export function parseTimeToMinutes(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + (minutes ?? 0);
}
