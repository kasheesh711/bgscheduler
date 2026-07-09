// Admissions Case Management — deadline aggregation across modules (CM-100..102).
//
// Design: docs/casemanagementsystem_design.md §1 (calendar.ts owns deadline
// aggregation) and §8 (Phase 2 delivers "calendar aggregates tasks"). Phase 2
// aggregates ONLY admissions_case_tasks.dueDate; later phases add application
// rounds, essay deadlines, and test registrations/sittings by appending one
// collector per source to CALENDAR_COLLECTORS — the window filter, overdue
// stamping, urgency sort, and DTO shape are source-agnostic. All dates are
// "YYYY-MM-DD" strings compared on the Asia/Bangkok calendar; malformed dates
// are skipped, never guessed (fail-closed).

import { and, inArray, isNotNull, isNull } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import { admissionsCaseTasks } from "@/lib/db/schema";
import { BANGKOK_TIME_ZONE } from "@/lib/bangkok-time";
import { isUuidShaped } from "./members";
import type { AdmissionsTaskOwner } from "./meetings";

/**
 * Dated-item source feeding the calendar. Phase 2: tasks only; later phases
 * widen this union ("application" | "essay" | "testing", design §8).
 */
export type CalendarItemSource = "task";

/** One dated item on the per-case calendar / deadlines panel (CM-100/CM-102). */
export interface CalendarItem {
  /** Source row id (e.g. the admissions_case_tasks id). */
  id: string;
  caseId: string;
  source: CalendarItemSource;
  title: string;
  /** Due date, "YYYY-MM-DD" (Asia/Bangkok calendar semantics). */
  date: string;
  /** True when the date is before today (Bangkok) and the item is still open. */
  overdue: boolean;
  /** Who the item is on (task owner); null for future ownerless sources. */
  ownerRole: AdmissionsTaskOwner | null;
}

/** Inclusive date window for buildCaseCalendar ("YYYY-MM-DD" bounds). */
export interface CalendarWindow {
  from: string;
  to: string;
}

/** Default number of rows in the upcoming-deadlines panel (CM-102). */
export const UPCOMING_DEADLINES_DEFAULT_LIMIT = 5;

/** Hard cap on deadline rows per call (protects the read path). */
export const UPCOMING_DEADLINES_MAX_LIMIT = 100;

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * CalendarItem plus the completion flag collectors must report so the
 * aggregator can stamp `overdue` (never overdue when completed) and drop
 * completed items from the deadlines panel. `overdue` is stamped centrally —
 * collectors never compute it.
 */
interface RawCalendarEntry extends Omit<CalendarItem, "overdue"> {
  completed: boolean;
}

/**
 * One collector per dated-item source (design §8: adding a source in a later
 * phase = adding one function here). Collectors fetch entries for a batch of
 * cases so the cross-case view stays one query per source.
 */
type CalendarCollector = (
  caseIds: readonly string[],
  db: Database,
) => Promise<RawCalendarEntry[]>;

/** Task collector (Phase 2): non-deleted admissions_case_tasks with a dueDate. */
const collectTaskEntries: CalendarCollector = async (caseIds, db) => {
  const rows = await db
    .select({
      id: admissionsCaseTasks.id,
      caseId: admissionsCaseTasks.caseId,
      title: admissionsCaseTasks.title,
      owner: admissionsCaseTasks.owner,
      status: admissionsCaseTasks.status,
      dueDate: admissionsCaseTasks.dueDate,
    })
    .from(admissionsCaseTasks)
    .where(and(
      inArray(admissionsCaseTasks.caseId, [...caseIds]),
      isNull(admissionsCaseTasks.deletedAt),
      isNotNull(admissionsCaseTasks.dueDate),
    ));

  const entries: RawCalendarEntry[] = [];
  for (const row of rows) {
    if (row.dueDate === null || !DATE_ONLY_PATTERN.test(row.dueDate)) continue;
    entries.push({
      id: row.id,
      caseId: row.caseId,
      source: "task",
      title: row.title,
      date: row.dueDate,
      ownerRole: row.owner,
      completed: row.status === "done",
    });
  }
  return entries;
};

const CALENDAR_COLLECTORS: readonly CalendarCollector[] = [collectTaskEntries];

/**
 * Asia/Bangkok calendar date ("YYYY-MM-DD") for an instant (mirrors the
 * private helper in meetings.ts).
 */
function getBangkokDateKey(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BANGKOK_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

function assertDateOnly(value: string, field: string): void {
  if (!DATE_ONLY_PATTERN.test(value)) {
    throw new Error(`Invalid ${field}: expected "YYYY-MM-DD"`);
  }
}

/**
 * Urgency order for deadline panels: date ascending — past-due (overdue)
 * dates sort first automatically, longest-overdue at the top, then today,
 * then the nearest future deadlines. Ties break by caseId, source, then id
 * for a stable render.
 */
function compareByUrgency(a: RawCalendarEntry, b: RawCalendarEntry): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.caseId !== b.caseId) return a.caseId < b.caseId ? -1 : 1;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function toCalendarItem(entry: RawCalendarEntry, todayKey: string): CalendarItem {
  return {
    id: entry.id,
    caseId: entry.caseId,
    source: entry.source,
    title: entry.title,
    date: entry.date,
    overdue: !entry.completed && entry.date < todayKey,
    ownerRole: entry.ownerRole,
  };
}

/** Runs every collector for the given cases and concatenates the entries. */
async function collectEntries(
  caseIds: readonly string[],
  db: Database,
): Promise<RawCalendarEntry[]> {
  const entries: RawCalendarEntry[] = [];
  for (const collector of CALENDAR_COLLECTORS) {
    entries.push(...(await collector(caseIds, db)));
  }
  return entries;
}

/**
 * Builds one case's calendar for an inclusive date window (CM-100).
 *
 * 1. Validate the window up front: both bounds "YYYY-MM-DD" with from <= to;
 *    a malformed caseId throws "NotFound" (routes translate to 404).
 * 2. Run every registered collector (Phase 2: tasks) and keep entries whose
 *    date falls inside [from, to] inclusive.
 * 3. Stamp `overdue` against today's Bangkok date — an item is overdue only
 *    when its date is strictly before today AND it is not completed; done
 *    items still render on the grid (historical record) but never as overdue.
 * 4. Sort date ascending (stable tiebreaks) for the month-grid/list views.
 *
 * @returns the window's calendar items, earliest first.
 */
export async function buildCaseCalendar(
  caseId: string,
  window: CalendarWindow,
  now: Date = new Date(),
  db: Database = getDb(),
): Promise<CalendarItem[]> {
  if (!isUuidShaped(caseId)) throw new Error("NotFound");
  assertDateOnly(window.from, "from");
  assertDateOnly(window.to, "to");
  if (window.from > window.to) {
    throw new Error("Invalid calendar window: from must be on or before to");
  }

  const todayKey = getBangkokDateKey(now);
  const entries = await collectEntries([caseId], db);
  return entries
    .filter((entry) => entry.date >= window.from && entry.date <= window.to)
    .sort(compareByUrgency)
    .map((entry) => toCalendarItem(entry, todayKey));
}

/**
 * Upcoming-deadlines panel for one case (CM-102): open items sorted by
 * urgency with overdue first.
 *
 * Completed items are excluded — the panel lists what still needs doing —
 * and there is no window: an overdue item stays on the panel until it is
 * done, no matter how old. `limit` is clamped to
 * [1, UPCOMING_DEADLINES_MAX_LIMIT].
 *
 * @returns at most `limit` items, longest-overdue first, then by date.
 */
export async function getUpcomingDeadlines(
  caseId: string,
  limit: number = UPCOMING_DEADLINES_DEFAULT_LIMIT,
  now: Date = new Date(),
  db: Database = getDb(),
): Promise<CalendarItem[]> {
  if (!isUuidShaped(caseId)) throw new Error("NotFound");
  return getUpcomingDeadlinesForCases([caseId], limit, now, db);
}

/**
 * Cross-case upcoming deadlines for a counselor's caseload (CM-101): one
 * merged list across every requested case, sorted by urgency with overdue
 * first, capped at `limit` overall.
 *
 * 1. Drop non-uuid-shaped caseIds (fail-closed skip — one bad id must not
 *    fail the whole caseload view); empty input returns [] without a query.
 * 2. Run every collector once for the whole batch (one query per source).
 * 3. Exclude completed items, stamp `overdue` against today (Bangkok), sort
 *    date ascending (overdue naturally first, longest-overdue at the top),
 *    and take the first `limit` (clamped to [1, UPCOMING_DEADLINES_MAX_LIMIT]).
 */
export async function getUpcomingDeadlinesForCases(
  caseIds: readonly string[],
  limit: number = UPCOMING_DEADLINES_DEFAULT_LIMIT,
  now: Date = new Date(),
  db: Database = getDb(),
): Promise<CalendarItem[]> {
  const validCaseIds = caseIds.filter((id) => isUuidShaped(id));
  if (validCaseIds.length === 0) return [];

  const clampedLimit = Math.min(
    UPCOMING_DEADLINES_MAX_LIMIT,
    Math.max(1, Math.trunc(limit)),
  );
  const todayKey = getBangkokDateKey(now);
  const entries = await collectEntries(validCaseIds, db);
  return entries
    .filter((entry) => !entry.completed)
    .sort(compareByUrgency)
    .slice(0, clampedLimit)
    .map((entry) => toCalendarItem(entry, todayKey));
}
