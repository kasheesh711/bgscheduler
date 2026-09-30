import { floorPercent } from "@/lib/feedback-autowriter/quality";

/**
 * How the autowriter dashboard writes times, money, durations and ratios: one home for every component of the page.
 * Pure, and the same text on the server and in the browser: month and weekday names come from the tables below, never
 * from the runtime's locale data (Node and a browser may abbreviate September differently).
 */

/** The four feedback fields in form order, with the labels the tutor sees in Wise. */
export const FIELD_LABELS: Record<string, string> = {
  topics: "Topics covered",
  performance: "How the student did in class",
  improvement: "Need more work on",
  homework: "Homework and due date",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December",
] as const;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

const BANGKOK_PARTS = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Bangkok", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

/** The Bangkok calendar parts of an instant; null for a missing or unreadable one. */
function bangkokParts(value: string | null): { month: number; day: number; hour: string; minute: string } | null {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(BANGKOK_PARTS.formatToParts(date).map((part) => [part.type, part.value]));
  return { month: Number(parts.month), day: Number(parts.day), hour: parts.hour, minute: parts.minute };
}

/** An instant in Bangkok as "30 Sep, 12:00"; "—" when there is none. */
export function when(value: string | null): string {
  const parts = bangkokParts(value);
  return parts ? `${parts.day} ${MONTHS[parts.month - 1]}, ${parts.hour}:${parts.minute}` : "—";
}

/** An instant's Bangkok time of day as "12:00"; "—" when there is none. */
export function clock(value: string | null): string {
  const parts = bangkokParts(value);
  return parts ? `${parts.hour}:${parts.minute}` : "—";
}

function dateKeyParts(dateKey: string): { year: number; month: number; day: number } | null {
  const [year, month, day] = dateKey.split("-").map(Number);
  return year && MONTHS[month - 1] && day ? { year, month, day } : null;
}

/** A Bangkok date key ("2026-09-30") as "30 Sep"; an unreadable key is shown as it is. */
export function dayMonth(dateKey: string): string {
  const parts = dateKeyParts(dateKey);
  return parts ? `${parts.day} ${MONTHS[parts.month - 1]}` : dateKey;
}

/** A Bangkok date key as "Wednesday, 30 September 2026"; an unreadable key is shown as it is. */
export function longDate(dateKey: string): string {
  const parts = dateKeyParts(dateKey);
  if (!parts) return dateKey;
  const weekday = WEEKDAYS[new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay()];
  return `${weekday}, ${parts.day} ${MONTH_NAMES[parts.month - 1]} ${parts.year}`;
}

/** US dollars: to the cent, or to a hundredth of a cent below one cent; "—" when there is no amount. */
export function usd(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value < 0.01 && value > 0 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

/** Minutes as "2.5 min", or as hours from an hour up ("1.2 h"); "—" when there are none. */
export function minutes(value: number | null): string {
  if (value === null) return "—";
  return value < 60 ? `${value.toFixed(1)} min` : `${(value / 60).toFixed(1)} h`;
}

/** A measured ratio, rounded down (79.99…% never reads as the 80% it missed); "—" when there is none. */
export function percent(value: number | null, digits = 1): string {
  return value === null ? "—" : floorPercent(value, digits);
}

/** A threshold (round by definition). */
export function threshold(value: number): string {
  return `${Math.round(value * 100)}%`;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** A span as "3 days", "9 h" or "40 min", rounded down: the time left is never overstated. */
function span(ms: number): string {
  if (ms >= 2 * DAY_MS) return `${Math.floor(ms / DAY_MS)} days`;
  if (ms >= HOUR_MS) return `${Math.floor(ms / HOUR_MS)} h`;
  return `${Math.floor(ms / MINUTE_MS)} min`;
}

/** How far a deadline is: "Deadline in 9 h", "Deadline passed 3 h ago", or "No deadline". */
export function deadlineCountdown(deadlineAt: string | null, now: Date): string {
  const deadline = deadlineAt ? new Date(deadlineAt).getTime() : Number.NaN;
  if (Number.isNaN(deadline)) return "No deadline";
  const left = deadline - now.getTime();
  if (Math.abs(left) < MINUTE_MS) return left > 0 ? "Deadline in under a minute" : "Deadline just passed";
  return left > 0 ? `Deadline in ${span(left)}` : `Deadline passed ${span(-left)} ago`;
}

/** "1 post", "3 posts": a count with its noun. */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
