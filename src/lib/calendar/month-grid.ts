// ----------------------------------------------------------------------------
// Shared Monday-start month-grid math.
//
// Extracted from src/components/admissions/calendar-tab.tsx so non-client
// callers (Server Components, the print route, the public parent schedule page)
// can reuse the grid without pulling a "use client" module into the server
// graph. calendar-tab.tsx re-exports every symbol here, so its existing imports
// and tests continue to resolve unchanged.
//
// All arithmetic is UTC-based on date-only keys ("YYYY-MM-DD"). These functions
// never touch the clock — callers pass in a Bangkok "today" when they need one.
// ----------------------------------------------------------------------------

const MONTH_KEY_PATTERN = /^\d{4}-\d{2}$/;
const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Day-of-week headers, Monday-start (mirrors WeekCalendar). */
export const CALENDAR_DAY_HEADERS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"] as const;

/** One cell of the 6×7 month grid. */
export interface CalendarGridCell {
  /** "YYYY-MM-DD" date key of the cell. */
  dateKey: string;
  /** True when the cell belongs to the viewed month (chips render only here). */
  inMonth: boolean;
}

function toUtcDate(dateKey: string): Date {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** True when `value` is a well-formed "YYYY-MM" key. */
export function isMonthKey(value: string): boolean {
  return MONTH_KEY_PATTERN.test(value);
}

/** "YYYY-MM-DD" → "YYYY-MM" month key; non-dates pass through unchanged. */
export function getMonthKey(dateKey: string): string {
  return DATE_KEY_PATTERN.test(dateKey) ? dateKey.slice(0, 7) : dateKey;
}

/**
 * Adds `delta` months to a "YYYY-MM" key (delta may be negative; crosses year
 * boundaries). Throws on a malformed key — never guesses a month.
 */
export function addMonths(monthKey: string, delta: number): string {
  if (!MONTH_KEY_PATTERN.test(monthKey)) {
    throw new Error(`Invalid month key: expected "YYYY-MM", got "${monthKey}"`);
  }
  const [year, month] = monthKey.split("-").map(Number);
  const total = year * 12 + (month - 1) + delta;
  const nextYear = Math.floor(total / 12);
  const nextMonth = (total % 12 + 12) % 12 + 1;
  return `${nextYear}-${String(nextMonth).padStart(2, "0")}`;
}

/** "YYYY-MM" → "July 2026"; malformed keys pass through unchanged. */
export function formatMonthLabel(monthKey: string): string {
  if (!MONTH_KEY_PATTERN.test(monthKey)) return monthKey;
  const [year, month] = monthKey.split("-").map(Number);
  const name = MONTH_NAMES[month - 1];
  return name ? `${name} ${year}` : monthKey;
}

/**
 * Inclusive first..last-day window for a "YYYY-MM" month key (leap years
 * handled by Date.UTC day-0 arithmetic).
 */
export function getMonthWindow(monthKey: string): { from: string; to: string } {
  if (!MONTH_KEY_PATTERN.test(monthKey)) {
    throw new Error(`Invalid month key: expected "YYYY-MM", got "${monthKey}"`);
  }
  const [year, month] = monthKey.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    from: `${monthKey}-01`,
    to: `${monthKey}-${String(lastDay).padStart(2, "0")}`,
  };
}

/** Monday ("YYYY-MM-DD") of the week containing `dateKey`. */
export function getMondayKey(dateKey: string): string {
  const date = toUtcDate(dateKey);
  const offset = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - offset);
  return toDateKey(date);
}

/**
 * Builds the Monday-start 6×7 grid (42 cells) for a "YYYY-MM" month key,
 * mirroring the WeekCalendar layout. Cells before/after the month carry
 * `inMonth: false` and render dimmed without chips.
 */
export function buildMonthGrid(monthKey: string): CalendarGridCell[] {
  const { from } = getMonthWindow(monthKey);
  const gridStart = toUtcDate(getMondayKey(from));
  const cells: CalendarGridCell[] = [];
  for (let index = 0; index < 42; index += 1) {
    const cell = new Date(gridStart);
    cell.setUTCDate(gridStart.getUTCDate() + index);
    const dateKey = toDateKey(cell);
    cells.push({ dateKey, inMonth: getMonthKey(dateKey) === monthKey });
  }
  return cells;
}

/** "YYYY-MM-DD" → "D/M/YYYY" (repo-wide D/M convention); non-dates pass through. */
export function formatDateOnly(value: string): string {
  const match = DATE_KEY_PATTERN.exec(value);
  if (!match) return value;
  return `${Number(match[3])}/${Number(match[2])}/${match[1]}`;
}

/** Day-of-month number for a "YYYY-MM-DD" key (1..31). */
export function dayOfMonth(dateKey: string): number {
  const match = DATE_KEY_PATTERN.exec(dateKey);
  return match ? Number(match[3]) : Number.NaN;
}
