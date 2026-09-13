import { gte } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { creditSessionTeacher, fetchCreditSessions, fetchCreditStudents, fetchSessionCredits } from "@/lib/credit-control/wise";
import type { WiseClient } from "@/lib/wise/client";

export type AttendanceRow = Pick<typeof s.creditControlSessions.$inferSelect, "wiseSessionId" | "wiseClassId" | "wiseStudentId" | "studentKey" | "studentName" | "subject" | "title" | "packageName" | "scheduledStartTime" | "meetingStatus" | "sessionKind" | "creditApplied" | "wiseTeacherUserId" | "wiseTeacherId">;
export type AttendanceInput = { source: AttendanceRow[]; packages: { wiseClassId: string; wiseStudentId: string; classType: string | null }[]; snapshotId: string | null };

/** Progress Tests owns its refresh after launch. The retired Credit Control UI's
 * daily snapshot must not delay a class-seven reminder. Every read is bounded by
 * the caller's WiseClient deadline; a partial read never replaces the ledger. */
export async function loadWorkspaceAttendance(db: Database, client: WiseClient, instituteId: string, launch: Date, now: Date): Promise<AttendanceInput> {
  const [students, past, future, previous] = await Promise.all([
    fetchCreditStudents(client, instituteId),
    fetchCreditSessions(client, instituteId, "PAST", new Date(launch.getTime() - 86400000), new Date(now.getTime() + 86400000)),
    fetchCreditSessions(client, instituteId, "FUTURE", now, new Date(now.getTime() + 30 * 86400000)),
    db.select().from(s.progressTestAttendanceLedger).where(gte(s.progressTestAttendanceLedger.scheduledStartTime, launch)),
  ]);
  const names = new Map(students.map(student => [student._id, student.name]));
  const pairs = new Map<string, { wiseClassId: string; wiseStudentId: string; classType: string | null }>();
  const key = (course: string, student: string) => JSON.stringify([course, student]);
  for (const student of students) for (const course of student.classrooms) pairs.set(key(course._id, student._id), { wiseClassId: course._id, wiseStudentId: student._id, classType: course.classType ?? null });
  const rows = new Map<string, AttendanceRow>();
  // Retain evidence for sessions that disappeared from a date feed. Fresh credit
  // history still revokes refunded consumption; proven deletions are reconciled
  // separately. Absence from an unreliable date filter is not proof of deletion.
  for (const row of previous) {
    rows.set(key(row.wiseSessionId, row.wiseStudentId), { ...row, title: row.subject, packageName: row.subject, sessionKind: "past" });
    if (!pairs.has(key(row.wiseClassId, row.wiseStudentId))) pairs.set(key(row.wiseClassId, row.wiseStudentId), { wiseClassId: row.wiseClassId, wiseStudentId: row.wiseStudentId, classType: null });
  }
  for (const session of [...past, ...future]) {
    const kind = session.scheduledStartTime > now ? "future" : "past";
    if (session.scheduledStartTime < launch && !previous.some(row => row.wiseSessionId === session._id)) continue;
    if (session.scheduledStartTime.getTime() > now.getTime() + 30 * 86400000) continue;
    for (const studentId of session.students) {
      const pairKey = key(session.classId._id, studentId);
      const pair = pairs.get(pairKey);
      const sessionType = session.classId.classType;
      const classType = pair?.classType && sessionType && pair.classType !== sessionType ? null : sessionType ?? pair?.classType ?? null;
      pairs.set(pairKey, { wiseClassId: session.classId._id, wiseStudentId: studentId, classType });
      rows.set(key(session._id, studentId), { wiseSessionId: session._id, wiseClassId: session.classId._id, wiseStudentId: studentId, studentKey: studentId, studentName: names.get(studentId) ?? "Unresolved student", subject: session.classId.subject ?? "", title: session.classId.name ?? session.title ?? "Course", packageName: "", scheduledStartTime: session.scheduledStartTime, meetingStatus: session.meetingStatus.toUpperCase(), sessionKind: kind, creditApplied: 0, ...creditSessionTeacher(session) });
    }
  }
  const credits = new Map<string, Map<string, number>>();
  const needed = [...new Set([...rows.values()].filter(row => row.sessionKind === "past" && pairs.get(key(row.wiseClassId, row.wiseStudentId))?.classType === "ONE_TO_ONE").map(row => key(row.wiseClassId, row.wiseStudentId)))];
  // Avoid creating thousands of queued promises while preserving the shared
  // client's pacing and deadline. Group histories are never requested.
  for (let i = 0; i < needed.length; i += 4) await Promise.all(needed.slice(i, i + 4).map(async pairKey => {
    const pair = pairs.get(pairKey)!;
    const history = await fetchSessionCredits(client, instituteId, pair.wiseClassId, pair.wiseStudentId);
    credits.set(pairKey, new Map(history.sessionCreditHistory.map(entry => [entry._id, Math.max(0, entry.credit)])));
  }));
  for (const row of rows.values()) row.creditApplied = row.sessionKind === "past" ? credits.get(key(row.wiseClassId, row.wiseStudentId))?.get(row.wiseSessionId) ?? 0 : 0;
  return { source: [...rows.values()], packages: [...pairs.values()], snapshotId: null };
}
