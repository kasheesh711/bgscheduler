import {sessionCreditMap,readSessionCredits,type CreditSessionAnchor} from './credit-session';
import { isProgressClass } from "./cadence";
import { recentClassWindowMs,courseExclusion } from "./course-policy";
import { gte,sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { creditSessionTeacher, fetchCreditSessions, fetchCreditStudents, fetchSessionCredits } from "@/lib/credit-control/wise";
import type { WiseClient } from "@/lib/wise/client";

export type AttendanceRow = Pick<typeof s.creditControlSessions.$inferSelect, "wiseSessionId" | "wiseClassId" | "wiseStudentId" | "studentKey" | "studentName" | "subject" | "title" | "packageName" | "scheduledStartTime" | "meetingStatus" | "sessionKind" | "creditApplied" | "wiseTeacherUserId" | "wiseTeacherId"> & {scheduledEndTime?:Date|null};
export type AttendanceInput = { source: AttendanceRow[]; packages: { wiseClassId: string; wiseStudentId: string; classType: string | null }[]; snapshotId: string | null };

/** Progress Tests owns its refresh after launch. The retired Credit Control UI's
 * daily snapshot must not delay a class-seven reminder. Every read is bounded by
 * the caller's WiseClient deadline; a partial read never replaces the ledger. */
export async function loadWorkspaceAttendance(db: Database, client: WiseClient, instituteId: string, launch: Date, now: Date): Promise<AttendanceInput> {
  const [students, past, future, previous] = await Promise.all([
    fetchCreditStudents(client, instituteId),
    fetchCreditSessions(client, instituteId, "PAST", new Date(Math.min(launch.getTime(),now.getTime()-recentClassWindowMs) - 86400000), new Date(now.getTime() + 86400000)),
    fetchCreditSessions(client, instituteId, "FUTURE", now, new Date(now.getTime() + 30 * 86400000)),
    db.select().from(s.progressTestAttendanceLedger).where(gte(s.progressTestAttendanceLedger.scheduledStartTime, launch)),
  ]);
  const names = new Map(students.map(student => [student._id, student.name]));
  const activeStudents = new Set(students.filter(student=>student.activated).map(student=>student._id));
  const pairs = new Map<string, { wiseClassId: string; wiseStudentId: string; classType: string | null }>();
  const key = (course: string, student: string) => JSON.stringify([course, student]);
  for (const student of students) for (const course of student.classrooms) pairs.set(key(course._id, student._id), { wiseClassId: course._id, wiseStudentId: student._id, classType: student.activated ? course.classType ?? null : null });
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
    if (session.scheduledStartTime.getTime() < Math.min(launch.getTime(),now.getTime()-recentClassWindowMs) && !previous.some(row => row.wiseSessionId === session._id)) continue;
    if (session.scheduledStartTime.getTime() > now.getTime() + 30 * 86400000) continue;
    for (const studentId of session.students) {
      const pairKey = key(session.classId._id, studentId);
      const pair = pairs.get(pairKey);
      const sessionType = session.classId.classType;
      const classType = !activeStudents.has(studentId) || pair?.classType && sessionType && pair.classType !== sessionType ? null : sessionType ?? pair?.classType ?? null;
      pairs.set(pairKey, { wiseClassId: session.classId._id, wiseStudentId: studentId, classType });
      rows.set(key(session._id, studentId), { wiseSessionId: session._id, wiseClassId: session.classId._id, wiseStudentId: studentId, studentKey: studentId, studentName: names.get(studentId) ?? "Unresolved student", subject: session.classId.subject ?? "", title: session.classId.name ?? session.title ?? "Course", packageName: "", scheduledStartTime: session.scheduledStartTime, scheduledEndTime: session.scheduledEndTime, meetingStatus: session.meetingStatus.toUpperCase(), sessionKind: kind, creditApplied: 0, ...creditSessionTeacher(session) });
    }
  }
  const snapshotIds=[...new Set(previous.flatMap(row=>row.firstObservedSnapshotId?[row.firstObservedSnapshotId]:[]))];
  const anchors=(await db.execute(sql`with retained as materialized (select sn.id from credit_control_snapshots sn where (sn.active or sn.id=any(ARRAY(select jsonb_array_elements_text(${JSON.stringify(snapshotIds)}::jsonb)::uuid))) and coalesce((sn.metadata->>'failedCreditPairs')::integer,0)=0 and exists(select 1 from credit_control_sync_runs cr where cr.promoted_snapshot_id=sn.id and cr.status='success')) select se.wise_session_id as "wiseSessionId",h.wise_class_id as "wiseClassId",h.wise_student_id as "wiseStudentId",h.raw from retained sn join credit_control_sessions se on se.snapshot_id=sn.id join credit_control_credit_history h on h.snapshot_id=sn.id and h.wise_class_id=se.wise_class_id and h.wise_student_id=se.wise_student_id and h.wise_credit_history_id=se.wise_session_id where h.credit>0 and h.raw->>'_id'=se.wise_session_id and h.raw->>'type'='SESSION' and se.scheduled_start_time>=${new Date(Math.min(launch.getTime(),now.getTime()-recentClassWindowMs))} and coalesce(se.scheduled_end_time,se.scheduled_start_time)<=${now}`)).rows as CreditSessionAnchor[];
  const observedAnchors=anchors.filter(a=>{const row=rows.get(key(a.wiseSessionId,a.wiseStudentId));return row?.wiseClassId===a.wiseClassId&&row.meetingStatus==='ENDED';});
  const retainedPositive=new Set(previous.filter(row=>row.creditApplied>0&&row.meetingStatus==='ENDED').map(row=>key(row.wiseSessionId,row.wiseStudentId)));
  const credits = new Map<string, Map<string, number>>();
  const needed = [...new Set([...rows.values()].filter(row => row.sessionKind === "past" && isProgressClass(pairs.get(key(row.wiseClassId, row.wiseStudentId))?.classType) && !courseExclusion(row.wiseClassId,pairs.get(key(row.wiseClassId, row.wiseStudentId))?.classType)).map(row => key(row.wiseClassId, row.wiseStudentId)))];
  // Avoid creating thousands of queued promises while preserving the shared
  // client's pacing and deadline. Check credit for each student in each course.
  for (let i = 0; i < needed.length; i += 4) await Promise.all(needed.slice(i, i + 4).map(async pairKey => {
    const pair = pairs.get(pairKey)!;
    const history = await fetchSessionCredits(client, instituteId, pair.wiseClassId, pair.wiseStudentId);
    const resolved=sessionCreditMap(history.sessionCreditHistory,observedAnchors,pair.wiseClassId,pair.wiseStudentId);
    for(const row of rows.values())if(row.wiseClassId===pair.wiseClassId&&row.wiseStudentId===pair.wiseStudentId&&row.meetingStatus==='ENDED'&&row.sessionKind==='past'&&retainedPositive.has(key(row.wiseSessionId,row.wiseStudentId))&&!resolved.credits.has(row.wiseSessionId))resolved.unresolved.add(row.wiseSessionId);
    for(const sessionId of resolved.unresolved)resolved.credits.set(sessionId,await readSessionCredits(client,pair.wiseClassId,pair.wiseStudentId,sessionId));
    credits.set(pairKey,resolved.credits);
  }));
  for (const row of rows.values()) row.creditApplied = row.sessionKind === "past" ? credits.get(key(row.wiseClassId, row.wiseStudentId))?.get(row.wiseSessionId) ?? 0 : 0;
  return { source: [...rows.values()], packages: [...pairs.values()], snapshotId: null };
}
