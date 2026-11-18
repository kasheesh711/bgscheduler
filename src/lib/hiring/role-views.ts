import { formatInTimeZone } from "date-fns-tz";
import { localDate, shiftDate, ZONE } from "./model";

// ─── The simple screens for HR, Admin and the heads (Kevin's decision, 18 Nov 2026). Pure helpers: no reads, no writes. ───

export const ROLE_VIEWS = ["hr", "admin", "heads"] as const;
export type RoleView = (typeof ROLE_VIEWS)[number];
export const isRoleView = (value: string | null | undefined): value is RoleView => ROLE_VIEWS.includes(value as RoleView);

/** Monday to Friday of the Bangkok week HR works next: this week, or next week on a Saturday or Sunday. */
export function workWeek(now: Date) {
  const today = localDate(now);
  // 1 = Monday … 7 = Sunday.
  const weekday = Number(formatInTimeZone(now, ZONE, "i"));
  const monday = shiftDate(today, weekday > 5 ? 8 - weekday : 1 - weekday);
  return [0, 1, 2, 3, 4].map((offset) => shiftDate(monday, offset));
}

export interface WeekCall {
  candidateId: string;
  name: string;
  time: string;
}
/** Each day of the work week with its booked HR calls, first call first. A call outside the week is not shown. */
export function weekCalls(
  calls: { candidateId: string; start: Date | string }[],
  candidates: { id: string; name: string }[],
  now: Date,
) {
  const names = new Map(candidates.map((c) => [c.id, c.name]));
  return workWeek(now).map((date) => ({
    date,
    today: date === localDate(now),
    calls: calls
      .filter((call) => localDate(new Date(call.start)) === date)
      .map((call): WeekCall => ({
        candidateId: call.candidateId,
        name: names.get(call.candidateId) ?? "Candidate",
        time: formatInTimeZone(new Date(call.start), ZONE, "HH:mm"),
      }))
      .sort((a, b) => a.time.localeCompare(b.time)),
  }));
}

export interface HeadDecisionRow {
  candidateId: string | null;
  decision: "hire" | "reject";
  reason: string;
  head: string;
  draftProblem: string | null;
  at: Date | string;
}
/**
 * The head decisions HR must act on: the newest one for each candidate, and only while no result of that kind was sent.
 * `rows` is newest first. `sent` holds the result emails that left.
 */
export function openHeadDecisions(rows: HeadDecisionRow[], sent: { candidateId: string; decision: string; status: string }[]) {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (!row.candidateId || seen.has(row.candidateId)) return false;
    seen.add(row.candidateId);
    return !sent.some((d) => d.candidateId === row.candidateId && d.status === "sent" && d.decision === row.decision);
  });
}

export const dayTitle = (date: string, today: string) => {
  const label = new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" });
  return date === today ? `Today · ${label}` : date === shiftDate(today, 1) ? `Tomorrow · ${label}` : label;
};
