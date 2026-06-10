import { bangkokDateKey, bangkokDateStartUtc, endOfBangkokMonth } from "@/lib/room-capacity/dates";

const DAY_MS = 86_400_000;
export const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Defensive cap for monthsInRange so a corrupt range cannot loop forever. */
const MAX_RANGE_MONTHS = 240;

/** "YYYY-MM-DD" → "YYYY-MM-01". */
export function monthStartOf(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** Pure month arithmetic on "YYYY-MM-01" keys (no Date construction). */
export function addMonths(month: string, delta: number): string {
  const zeroBased = Number(month.slice(0, 4)) * 12 + (Number(month.slice(5, 7)) - 1) + delta;
  const year = Math.floor(zeroBased / 12);
  const monthIndex = ((zeroBased % 12) + 12) % 12;
  return `${String(year).padStart(4, "0")}-${String(monthIndex + 1).padStart(2, "0")}-01`;
}

/** Inclusive calendar month starts covering [from, to]; empty when from > to. */
export function monthsInRange(from: string, to: string): string[] {
  const start = monthStartOf(from);
  const end = monthStartOf(to);
  if (!from || !to || start > end) return [];
  const months: string[] = [];
  for (let month = start; month <= end && months.length < MAX_RANGE_MONTHS; month = addMonths(month, 1)) {
    months.push(month);
  }
  return months;
}

/** "2026-04-01" → "Apr 26"; unparseable inputs are returned unchanged. */
export function monthShortLabel(month: string): string {
  const name = MONTH_NAMES[Number(month.slice(5, 7)) - 1];
  return name ? `${name} ${month.slice(2, 4)}` : month;
}

export function monthStartFromMonthKey(monthKey: string): string {
  if (!/^\d{4}-\d{2}$/.test(monthKey)) {
    throw new Error("Month must use YYYY-MM format");
  }
  return `${monthKey}-01`;
}

export function monthKeyFromDate(date: string): string {
  return date.slice(0, 7);
}

export function labelForMonth(monthStart: string): string {
  const [year, month] = monthStart.split("-").map(Number);
  return `${year}-${String(month).padStart(2, "0")} ${MONTH_NAMES[month - 1] ?? ""}`.trim();
}

export function currentBangkokMonthStart(now = new Date()): string {
  return monthStartFromMonthKey(monthKeyFromDate(bangkokDateKey(now)));
}

export function currentBangkokDate(now = new Date()): string {
  return bangkokDateKey(now);
}

export function currentBangkokMonthEnd(now = new Date()): string {
  return endOfBangkokMonth(bangkokDateKey(now));
}

export function previousBangkokMonthStart(now = new Date()): string {
  const today = bangkokDateKey(now);
  const [year, month] = today.split("-").map(Number);
  const previousYear = month === 1 ? year - 1 : year;
  const previousMonth = month === 1 ? 12 : month - 1;
  return `${previousYear}-${String(previousMonth).padStart(2, "0")}-01`;
}

export function bangkokDayOfMonth(now = new Date()): number {
  return Number(bangkokDateKey(now).slice(8, 10));
}

export function isoDateFromGoogleSerial(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const utc = Date.UTC(1899, 11, 30) + Math.floor(value) * DAY_MS;
  return new Date(utc).toISOString().slice(0, 10);
}

export function parseSalesDate(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === "number") {
    return isoDateFromGoogleSerial(value);
  }
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  }

  const dmy = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (dmy) {
    const year = dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3];
    return `${year}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime()) || parsed.getFullYear() < 2000) return null;
  return parsed.toISOString().slice(0, 10);
}

export function dateComparisonValue(date: string): number {
  return bangkokDateStartUtc(date).getTime();
}

export function addDaysIso(date: string, days: number): string {
  const next = bangkokDateStartUtc(date);
  next.setUTCDate(next.getUTCDate() + days);
  return bangkokDateKey(next);
}

export function dayOfWeekShort(date: string): string {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Bangkok",
    weekday: "short",
  }).format(bangkokDateStartUtc(date));
  return weekday;
}
