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
  creditSessionTeacher,
  durationMsToMinutes,
  type WiseCreditSession,
} from "@/lib/credit-control/wise";
import { fetchLiveMonthSessions } from "@/lib/student-schedule/live";
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
  title: string;
  scheduledStartTime: Date;
  scheduledEndTime: Date | null;
  durationMinutes: number;
  meetingStatus: string;
  teacherName: string | null;
}

// "In-Person Session-Biology HL" → "Biology HL". Tolerates the spaced and
// tight hyphen variants Wise emits, plus en/em dashes and a colon.
const MODALITY_TITLE_PATTERN =
  /^\s*(?:in[- ]?person|on[- ]?site|online|live)\s+session\s*[-–—:]\s*/i;

/**
 * The parent-facing class label. The Wise session `title` is the only field
 * that names the class itself ("In-Person Session-Biology HL") — at BeGifted,
 * `subject` holds level bands ("Y12-13 / G11-12 (Int.)") and `packageName` is
 * the classroom name, which is the student's own name. So: title first with
 * the modality prefix stripped (fail-open to the full title when the pattern
 * doesn't match), then the legacy subject → packageName → "Class" chain for
 * rows that predate the title column.
 */
export function deriveDisplaySubject(row: {
  title: string;
  subject: string;
  packageName: string;
}): string {
  const title = row.title.trim();
  if (title) {
    return title.replace(MODALITY_TITLE_PATTERN, "").trim() || title;
  }
  return row.subject.trim() || row.packageName.trim() || "Class";
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
      subject: deriveDisplaySubject(row),
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
 * Merges a live Wise sweep into the snapshot's rows for one student's month.
 * Pure -- no DB, no clock -- so merge semantics are unit-testable directly.
 *
 *   - Matched (same wiseSessionId in both) -- takes the live session's time/
 *     end-time/status/duration; keeps the snapshot row's subject, package, and
 *     teacher (the sweep carries no package context).
 *   - Live-only (a new class the snapshot has never seen) -- synthesizes a row
 *     with no package (buildStudentSchedulePayload already falls back to
 *     `subject || packageName || "Class"`) and the session's own teacher via
 *     `creditSessionTeacher`.
 *   - Snapshot-only (the snapshot has it, the live sweep does not) -- dropped:
 *     a full successful sweep means Wise no longer has that session this month.
 *
 * `liveSessions` must already be trimmed to the exact Bangkok month window --
 * this function does not re-derive it (see `getStudentMonthlySchedule`, which
 * reuses `bangkokMonthInstantWindow` for both its DB query and this trim).
 */
export function mergeLiveSessionsIntoRows({
  snapshotRows,
  liveSessions,
  student,
}: {
  snapshotRows: readonly StudentScheduleRow[];
  liveSessions: readonly WiseCreditSession[];
  student: Pick<StudentScheduleRow, "studentKey" | "wiseStudentId" | "studentName" | "parentName">;
}): StudentScheduleRow[] {
  const liveById = new Map(liveSessions.map((session) => [session._id, session]));
  const seenSessionIds = new Set<string>();
  const merged: StudentScheduleRow[] = [];

  for (const row of snapshotRows) {
    seenSessionIds.add(row.wiseSessionId);
    const live = liveById.get(row.wiseSessionId);
    if (!live) continue; // snapshot-only: Wise no longer has this session -- drop it
    merged.push({
      ...row,
      // A snapshot row from before the title column backfilled still gets the
      // live title; a populated snapshot title is kept as-is.
      title: row.title.trim() || live.title?.trim() || "",
      scheduledStartTime: live.scheduledStartTime,
      scheduledEndTime: live.scheduledEndTime ?? null,
      durationMinutes: durationMsToMinutes(live.duration),
      meetingStatus: live.meetingStatus,
    });
  }

  for (const session of liveSessions) {
    if (seenSessionIds.has(session._id)) continue; // already merged above
    const teacher = creditSessionTeacher(session);
    merged.push({
      wiseSessionId: session._id,
      studentKey: student.studentKey,
      wiseStudentId: student.wiseStudentId,
      studentName: student.studentName,
      parentName: student.parentName,
      subject: session.classId.subject?.trim() || session.classId.name?.trim() || "",
      packageName: "",
      title: session.title?.trim() ?? "",
      scheduledStartTime: session.scheduledStartTime,
      scheduledEndTime: session.scheduledEndTime ?? null,
      durationMinutes: durationMsToMinutes(session.duration),
      meetingStatus: session.meetingStatus,
      teacherName: teacher.teacherName,
    });
  }

  return merged;
}

/**
 * Loads one student's Bangkok-month schedule from the active credit-control
 * snapshot.
 *
 * @returns the payload, or null when the student is not in the active snapshot
 *   (unknown key, or no snapshot has been generated yet). Callers must treat
 *   null as "not found" and never fall back to a name search.
 */
/** When the live overlay sweep runs: every call, only to rescue an empty snapshot month, or never. */
export type StudentScheduleLiveSweepMode = "always" | "rescue" | "never";

/**
 * Snapshot + student already resolved by the caller (the schedule-bot search
 * returns both), so this function can skip its own two lookups. The snapshot
 * may be one promotion stale by the time the sessions query runs; retired
 * snapshot rows are retained, so the read stays internally consistent.
 */
export interface PreResolvedScheduleContext {
  snapshot: { id: string; generatedAt: Date };
  student: { studentKey: string; wiseStudentId: string; studentName: string; parentName: string };
}

export async function getStudentMonthlySchedule(
  db: Database,
  { studentKey, monthKey, liveSweep = "always", preResolved }: {
    studentKey: string;
    monthKey: string;
    liveSweep?: StudentScheduleLiveSweepMode;
    preResolved?: PreResolvedScheduleContext;
  },
): Promise<StudentSchedulePayload | null> {
  if (!isMonthKey(monthKey)) {
    throw new Error(`Invalid month key: expected "YYYY-MM", got "${monthKey}"`);
  }

  const snapshot = preResolved?.snapshot ?? (await db
    .select({ id: schema.creditControlSnapshots.id, generatedAt: schema.creditControlSnapshots.generatedAt })
    .from(schema.creditControlSnapshots)
    .where(eq(schema.creditControlSnapshots.active, true))
    .orderBy(desc(schema.creditControlSnapshots.generatedAt))
    .limit(1))[0];
  if (!snapshot) return null;

  const studentRow = preResolved?.student ?? (await db
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
    .limit(1))[0];
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
      title: schema.creditControlSessions.title,
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

  const snapshotRows: StudentScheduleRow[] = rows.map((row) => ({ ...row, parentName: studentRow.parentName }));

  // "rescue" sweeps only when the snapshot month is empty at the PAYLOAD level
  // (mirroring the CANCELLED filter the payload builder applies), so a month
  // whose snapshot rows are all cancelled still gets a live look before a
  // caller like the schedule bot refuses it as empty (GRP-BOT-05).
  const snapshotHasVisibleSessions = snapshotRows.some(
    (row) => !CANCELLED_PATTERN.test(row.meetingStatus.trim()),
  );
  const runSweep = liveSweep === "always" || (liveSweep === "rescue" && !snapshotHasVisibleSessions);
  const live = runSweep
    ? await fetchLiveMonthSessions({ wiseStudentId: studentRow.wiseStudentId, monthKey })
    : { sessions: [], ok: false as const };
  const liveSessionsInMonth = live.ok
    ? live.sessions.filter((session) => (
      session.scheduledStartTime >= start && session.scheduledStartTime < end
    ))
    : [];

  const finalRows = live.ok
    ? mergeLiveSessionsIntoRows({ snapshotRows, liveSessions: liveSessionsInMonth, student: studentRow })
    : snapshotRows;

  const display = parseStudentDisplay(studentRow.studentName);

  return buildStudentSchedulePayload({
    rows: finalRows,
    student: {
      studentKey: studentRow.studentKey,
      wiseStudentId: studentRow.wiseStudentId,
      studentName: studentRow.studentName,
      parentName: studentRow.parentName,
      code: display.code,
      shortName: display.shortName,
    },
    monthKey,
    generatedAt: live.ok ? new Date() : snapshot.generatedAt,
  });
}

/** Convenience wrapper for Server Components that have no `db` in hand. */
export async function getStudentMonthlyScheduleForRequest(
  args: { studentKey: string; monthKey: string },
): Promise<StudentSchedulePayload | null> {
  return getStudentMonthlySchedule(getDb(), args);
}
