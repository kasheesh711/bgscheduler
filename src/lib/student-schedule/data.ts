// ----------------------------------------------------------------------------
// Student monthly schedule — read path.
//
// Source of truth is `credit_control_sessions` on the ACTIVE credit-control
// snapshot: it is the only table carrying (student × session) rows with the
// subject, and since Phase A also the teacher. Its window is past 120 days /
// future 180 days, and it is truncated and rebuilt on every credit-control
// sync, so it self-heals rather than accumulating drift.
//
// Two product rules are enforced here, not in the UI:
//   • CANCELLED/CANCELED sessions are omitted — a parent-facing schedule must
//     not list a class that will not happen (matches the repo-wide rule that
//     cancelled sessions are non-blocking).
//   • A session with no resolvable teacher renders TEACHER_TBC. It is never
//     dropped and the teacher is never inferred from the class or package name
//     (fail-closed: unresolved → visible placeholder, never a guess).
// ----------------------------------------------------------------------------

import { and, asc, desc, eq, gte, lt } from "drizzle-orm";

import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { BANGKOK_TIME_ZONE } from "@/lib/bangkok-time";
import { bangkokDateKey, bangkokDateStartUtc } from "@/lib/room-capacity/dates";
import {
  addMonths,
  formatMonthLabel,
  getMonthWindow,
  isMonthKey,
} from "@/lib/calendar/month-grid";
import {
  TEACHER_TBC,
  type StudentSchedulePayload,
  type StudentScheduleSession,
  type StudentScheduleStudent,
} from "@/lib/student-schedule/types";

/** Wise cancellation spellings seen in the feed (both single and double L). */
const CANCELLED_PATTERN = /^CANCELL?ED$/i;

const TIME_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: BANGKOK_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** One `credit_control_sessions` row as this module consumes it. */
export interface StudentScheduleRow {
  wiseSessionId: string;
  studentKey: string;
  wiseStudentId: string;
  studentName: string;
  parentName: string;
  subject: string;
  packageName: string;
  scheduledStartTime: Date;
  scheduledEndTime: Date | null;
  durationMinutes: number;
  meetingStatus: string;
  teacherName: string | null;
}

function formatBangkokTime(value: Date): string {
  return TIME_FORMATTER.format(value);
}

/**
 * Splits a Wise student name into a display nickname and its bracketed code.
 * `"Aadhiya (Aadhu.Sr) Srisethi"` → `{ code: "Aadhu.Sr", shortName: "Aadhu" }`.
 *
 * Deliberately does NOT reuse `nicknameCodes()` from the LINE module: that
 * lowercases for matching, whereas these values are shown to a parent and must
 * keep their original casing. The short name drops the family suffix so the
 * push message reads "น้อง Aadhu" rather than repeating the full code.
 */
export function parseStudentDisplay(studentName: string): {
  code: string | null;
  shortName: string;
} {
  const trimmed = studentName.trim();
  const code = /\(([^)]+)\)/.exec(trimmed)?.[1]?.trim() || null;
  if (!code) {
    // No bracketed code — fall back to the first word of the Wise name.
    const firstWord = trimmed.split(/\s+/)[0] ?? trimmed;
    return { code: null, shortName: firstWord || trimmed };
  }
  return { code, shortName: code.split(".")[0]?.trim() || code };
}

/**
 * Half-open UTC instant window `[start, end)` covering a Bangkok calendar month.
 * Bangkok is UTC+7 with no DST, so the month starts at 17:00 UTC on the last day
 * of the previous month. Using instants (not date strings) keeps the comparison
 * correct for a 23:00-UTC session that belongs to the NEXT Bangkok day.
 */
export function bangkokMonthInstantWindow(monthKey: string): { start: Date; end: Date } {
  const { from } = getMonthWindow(monthKey);
  const { from: nextFrom } = getMonthWindow(addMonths(monthKey, 1));
  return { start: bangkokDateStartUtc(from), end: bangkokDateStartUtc(nextFrom) };
}

/**
 * Shapes raw session rows into the render payload. Pure — no DB, no clock
 * beyond the `generatedAt` stamp the caller supplies — so the cancellation and
 * TBC rules are unit-testable in isolation.
 */
export function buildStudentSchedulePayload({
  rows,
  student,
  monthKey,
  generatedAt,
}: {
  rows: readonly StudentScheduleRow[];
  student: StudentScheduleStudent;
  monthKey: string;
  generatedAt: Date;
}): StudentSchedulePayload {
  const seen = new Set<string>();
  const sessions: StudentScheduleSession[] = [];

  for (const row of rows) {
    if (CANCELLED_PATTERN.test(row.meetingStatus.trim())) continue;
    // A student can hold two rows for one session across packages; the calendar
    // shows the class once.
    if (seen.has(row.wiseSessionId)) continue;
    seen.add(row.wiseSessionId);

    sessions.push({
      wiseSessionId: row.wiseSessionId,
      dateKey: bangkokDateKey(row.scheduledStartTime),
      startTime: row.scheduledStartTime.toISOString(),
      endTime: row.scheduledEndTime?.toISOString() ?? null,
      startLabel: formatBangkokTime(row.scheduledStartTime),
      endLabel: row.scheduledEndTime ? formatBangkokTime(row.scheduledEndTime) : "",
      subject: row.subject.trim() || row.packageName.trim() || "Class",
      packageName: row.packageName.trim(),
      teacherName: row.teacherName?.trim() || TEACHER_TBC,
      durationMinutes: row.durationMinutes,
      meetingStatus: row.meetingStatus.trim().toUpperCase(),
    });
  }

  sessions.sort((a, b) => (
    a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1 : 0
  ));

  return {
    student,
    monthKey,
    monthLabel: formatMonthLabel(monthKey),
    sessions,
    generatedAt: generatedAt.toISOString(),
  };
}

/**
 * Loads one student's Bangkok-month schedule from the active credit-control
 * snapshot.
 *
 * @returns the payload, or null when the student is not in the active snapshot
 *   (unknown key, or no snapshot has been generated yet). Callers must treat
 *   null as "not found" and never fall back to a name search.
 */
export async function getStudentMonthlySchedule(
  db: Database,
  { studentKey, monthKey }: { studentKey: string; monthKey: string },
): Promise<StudentSchedulePayload | null> {
  if (!isMonthKey(monthKey)) {
    throw new Error(`Invalid month key: expected "YYYY-MM", got "${monthKey}"`);
  }

  const [snapshot] = await db
    .select({ id: schema.creditControlSnapshots.id })
    .from(schema.creditControlSnapshots)
    .where(eq(schema.creditControlSnapshots.active, true))
    .orderBy(desc(schema.creditControlSnapshots.generatedAt))
    .limit(1);
  if (!snapshot) return null;

  const [studentRow] = await db
    .select({
      wiseStudentId: schema.creditControlStudents.wiseStudentId,
      studentKey: schema.creditControlStudents.studentKey,
      studentName: schema.creditControlStudents.studentName,
      parentName: schema.creditControlStudents.parentName,
    })
    .from(schema.creditControlStudents)
    .where(and(
      eq(schema.creditControlStudents.snapshotId, snapshot.id),
      eq(schema.creditControlStudents.studentKey, studentKey),
    ))
    .limit(1);
  if (!studentRow) return null;

  const { start, end } = bangkokMonthInstantWindow(monthKey);
  const rows = await db
    .select({
      wiseSessionId: schema.creditControlSessions.wiseSessionId,
      studentKey: schema.creditControlSessions.studentKey,
      wiseStudentId: schema.creditControlSessions.wiseStudentId,
      studentName: schema.creditControlSessions.studentName,
      subject: schema.creditControlSessions.subject,
      packageName: schema.creditControlSessions.packageName,
      scheduledStartTime: schema.creditControlSessions.scheduledStartTime,
      scheduledEndTime: schema.creditControlSessions.scheduledEndTime,
      durationMinutes: schema.creditControlSessions.durationMinutes,
      meetingStatus: schema.creditControlSessions.meetingStatus,
      teacherName: schema.creditControlSessions.teacherName,
    })
    .from(schema.creditControlSessions)
    .where(and(
      eq(schema.creditControlSessions.snapshotId, snapshot.id),
      eq(schema.creditControlSessions.studentKey, studentKey),
      gte(schema.creditControlSessions.scheduledStartTime, start),
      lt(schema.creditControlSessions.scheduledStartTime, end),
    ))
    .orderBy(asc(schema.creditControlSessions.scheduledStartTime));

  const display = parseStudentDisplay(studentRow.studentName);

  return buildStudentSchedulePayload({
    rows: rows.map((row) => ({ ...row, parentName: studentRow.parentName })),
    student: {
      studentKey: studentRow.studentKey,
      wiseStudentId: studentRow.wiseStudentId,
      studentName: studentRow.studentName,
      parentName: studentRow.parentName,
      code: display.code,
      shortName: display.shortName,
    },
    monthKey,
    generatedAt: new Date(),
  });
}

/** Convenience wrapper for Server Components that have no `db` in hand. */
export async function getStudentMonthlyScheduleForRequest(
  args: { studentKey: string; monthKey: string },
): Promise<StudentSchedulePayload | null> {
  return getStudentMonthlySchedule(getDb(), args);
}
