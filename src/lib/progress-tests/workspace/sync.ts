import { createHash } from "node:crypto";
import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { type Database } from "@/lib/db";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import * as s from "@/lib/db/schema";
import { loadActiveIdentityEntries } from "../db";
import type { ProgressTestSyncDeps, ProgressTestSyncResult } from "../sync";
import { cycleNumbers, cyclePosition, WorkspaceError } from "./model";
import { countedAttendance, verifiedInstructor, seriesKey, needsReminder } from "./cadence";
import { createAppsScriptScheduleEmailSender, type ScheduleEmailSender } from "@/lib/classrooms/schedule-email";
import { renderTeacherEmail } from "@/lib/teacher-emails/render";
import { teacherEmailPublicBaseUrl } from "@/lib/teacher-emails/config";
import { teacherEmailLogoUrl } from "@/lib/teacher-emails/brand";
import { scopeForEmail } from "./access";
import { loadWorkspaceAttendance, type AttendanceInput } from "./attendance";

export async function notifyWorkspaceTutors(db: Database, sender?: ScheduleEmailSender) {
  const rows = await db.select({ a: s.ptAssessments, series: s.ptSeries }).from(s.ptAssessments)
    .innerJoin(s.ptSeries, eq(s.ptSeries.id, s.ptAssessments.seriesId)).where(and(isNull(s.ptAssessments.notifiedAt),eq(s.ptSeries.classType,"ONE_TO_ONE")));
  let sent = 0;
  for (const { a, series } of rows) {
    if (!needsReminder(series.count, a.cycle, !!a.notifiedAt) || a.approvedReviewId === a.currentReviewId && !!a.currentReviewId) continue;
    try {
      const [contact] = await db.select().from(s.tutorContacts).where(and(eq(s.tutorContacts.canonicalKey, series.ownerKey), eq(s.tutorContacts.active, true))).limit(1);
      const email = (contact?.onsiteEmail || contact?.onlineEmail)?.trim().toLowerCase();
      if (!email) throw new Error("No verified tutor email is available.");
      const scope = await scopeForEmail(email, db);
      if (scope.keys !== null && !scope.keys.includes(series.ownerKey)) throw new Error("Tutor email ownership needs review.");
      const base = teacherEmailPublicBaseUrl();
      const content = renderTeacherEmail({ subject: `Prepare ${series.studentName}'s progress test · ${series.courseName}`, preheader: `Discuss topics in class ${a.cycle * 8 - 1}; administer in class ${a.cycle * 8}.`,
        category: "Progress Tests", title: "Time to prepare", subtitle: `${series.studentName} · ${series.courseName}`, greeting: `Hello ${series.tutorName},`,
        paragraphs: [`${series.studentName} has completed ${series.count} classes with you in this course since launch. Assessment ${a.cycle} is due in your class ${a.cycle * 8}.`],
        sections: [{ heading: "Your next steps", bullets: [`Prepare your topic test and marking rubric.`, `Explain the covered topics to the student in class ${a.cycle * 8 - 1}.`, `Administer the test within class ${a.cycle * 8}, then upload the student's work for review.`], action: { label: "Open Progress Tests", url: `${base}/progress-tests?assessment=${a.id}` } }],
        logoUrl: teacherEmailLogoUrl(base), footerNote: "This test takes place in the student's ordinary lesson. The next assessment remains due every eight classes, even if an earlier submission is late." });
      await (sender ?? createAppsScriptScheduleEmailSender()).sendEmail({ to: email, ...content, idempotencyKey: `pt-workspace-reminder:${a.id}` });
      await db.update(s.ptAssessments).set({ notifiedAt: new Date(), notificationError: null }).where(eq(s.ptAssessments.id, a.id));
      sent++;
    } catch {
      await db.update(s.ptAssessments).set({ notificationError: "Tutor reminder could not be delivered. Check the active tutor email binding and delivery configuration; the next sync will retry." }).where(eq(s.ptAssessments.id, a.id));
    }
  }
  return sent;
}

/** Called under the existing progress-test sync run's database single-flight guard. */
export async function syncWorkspace(deps: ProgressTestSyncDeps, launchedAt: Date, input?: AttendanceInput): Promise<ProgressTestSyncResult> {
  const db = deps.db;
  const now = deps.now ?? new Date();
  const [{ source, packages, snapshotId }, identities] = await Promise.all([
    input ?? loadWorkspaceAttendance(db, deps.client, deps.instituteId, launchedAt, now),
    loadActiveIdentityEntries(db),
  ]);
  if (!identities.length) throw new WorkspaceError(503, "Verified Wise instructors are unavailable.");
  const packageMap = new Map(packages.map(p => [JSON.stringify([p.wiseClassId,p.wiseStudentId]),p]));
  const classTypeFor = (course:string,student:string) => packageMap.get(JSON.stringify([course,student]))?.classType ?? null;
  const normalized = source.map(row => ({ row, tutor: verifiedInstructor(row.wiseTeacherUserId, row.wiseTeacherId, identities) }));
  let unresolvedTeacherCount = 0;
  let ledgerRowCount = 0;
  await withDatabaseTransaction(db, async tx => {
    await tx.delete(s.ptSourceIssues);
    const unknown=new Map(source.filter(row=>!classTypeFor(row.wiseClassId,row.wiseStudentId)).map(row=>[JSON.stringify([row.wiseClassId,row.wiseStudentId]),row]));
    if(unknown.size)await tx.insert(s.ptSourceIssues).values([...unknown].map(([sourceKey,row])=>({sourceKey,studentName:row.studentName,courseName:row.title||row.subject,reason:"Wise course type is unresolved. No counters, reminders or tutor access are created.",observedAt:now})));
    const previousLedger = await tx.select({ session: s.progressTestAttendanceLedger.wiseSessionId, student: s.progressTestAttendanceLedger.wiseStudentId }).from(s.progressTestAttendanceLedger).where(gte(s.progressTestAttendanceLedger.scheduledStartTime,launchedAt));
    const observed = new Set(previousLedger.map(r => JSON.stringify([r.session,r.student])));
    // Also reconcile a known session moved before launch or into the future.
    const candidates = normalized.filter(({ row }) => row.scheduledStartTime >= launchedAt && row.scheduledStartTime <= now || observed.has(JSON.stringify([row.wiseSessionId,row.wiseStudentId])));
    for (let i = 0; i < candidates.length; i += 300) {
      const values = candidates.slice(i, i + 300).map(({ row, tutor }) => ({
        enrollmentKey: `${row.wiseClassId}|${row.wiseStudentId}`, wiseSessionId: row.wiseSessionId, wiseClassId: row.wiseClassId, wiseStudentId: row.wiseStudentId,
        studentKey: row.studentKey, studentName: row.studentName, subject: row.title || row.packageName || row.subject,
        scheduledStartTime: row.scheduledStartTime, creditApplied: row.creditApplied, meetingStatus: row.meetingStatus,
        wiseTeacherUserId: row.wiseTeacherUserId, wiseTeacherId: row.wiseTeacherId, tutorCanonicalKey: tutor?.canonicalKey ?? null, tutorDisplayName: tutor?.displayName ?? null,
        isProgressTest: false, countsTowardCycle: classTypeFor(row.wiseClassId,row.wiseStudentId) === "ONE_TO_ONE" && row.meetingStatus === "ENDED" && row.creditApplied > 0 && row.scheduledStartTime >= launchedAt && row.scheduledStartTime <= now, firstObservedSnapshotId: snapshotId,
      }));
      if (!values.length) continue;
      await tx.insert(s.progressTestAttendanceLedger).values(values).onConflictDoUpdate({ target: [s.progressTestAttendanceLedger.wiseSessionId, s.progressTestAttendanceLedger.wiseStudentId],
        set: { enrollmentKey: sql`excluded.enrollment_key`, wiseClassId: sql`excluded.wise_class_id`, scheduledStartTime: sql`excluded.scheduled_start_time`, creditApplied: sql`excluded.credit_applied`, meetingStatus: sql`excluded.meeting_status`,
          wiseTeacherUserId: sql`excluded.wise_teacher_user_id`, wiseTeacherId: sql`excluded.wise_teacher_id`, tutorCanonicalKey: sql`excluded.tutor_canonical_key`, tutorDisplayName: sql`excluded.tutor_display_name`, countsTowardCycle: sql`excluded.counts_toward_cycle`, updatedAt: now } });
      await tx.insert(s.ptAttendanceEvidence).values(values.map(v => {
        const data = { ...v, scheduledStartTime: v.scheduledStartTime.toISOString(), firstObservedSnapshotId: undefined };
        return { wiseSessionId: v.wiseSessionId, wiseStudentId: v.wiseStudentId, data: { ...data, snapshotId: snapshotId }, contentHash: createHash("sha256").update(JSON.stringify(data)).digest("hex") };
      })).onConflictDoNothing();
      ledgerRowCount += values.length;
    }
    // A proven Wise deletion revokes attendance without erasing its evidence.
    await tx.update(s.progressTestAttendanceLedger).set({ countsTowardCycle: false, meetingStatus: "DELETED", updatedAt: now })
      .where(and(gte(s.progressTestAttendanceLedger.scheduledStartTime, launchedAt), sql`exists (select 1 from ${s.postClassSessions} pc where pc.wise_session_id = ${s.progressTestAttendanceLedger.wiseSessionId} and pc.wise_deleted_at is not null)`));
    const ledger = await tx.select().from(s.progressTestAttendanceLedger).where(gte(s.progressTestAttendanceLedger.scheduledStartTime, launchedAt));
    unresolvedTeacherCount = ledger.filter(r => r.countsTowardCycle && !r.tutorCanonicalKey).length;
    const groups = countedAttendance(ledger.filter(r=>r.countsTowardCycle && classTypeFor(r.wiseClassId,r.wiseStudentId)==="ONE_TO_ONE").map(r => ({ sessionId: r.wiseSessionId, studentId: r.wiseStudentId, courseId: r.wiseClassId, ownerKey: r.tutorCanonicalKey, start: r.scheduledStartTime, status: r.meetingStatus, credit: r.creditApplied })), launchedAt, now);
    const seeds = new Map<string, typeof s.ptSeries.$inferInsert>();
    for (const { row, tutor } of normalized) {
      if (classTypeFor(row.wiseClassId,row.wiseStudentId) !== "ONE_TO_ONE" || !tutor || ["CANCELLED", "CANCELED", "DELETED"].includes(row.meetingStatus)) continue;
      const key = seriesKey(tutor.canonicalKey,row.wiseClassId,row.wiseStudentId);
      const pkg = packageMap.get(JSON.stringify([row.wiseClassId,row.wiseStudentId]));
      const previous = seeds.get(key);
      const upcoming = previous?.upcomingSessions ?? [];
      if (row.scheduledStartTime > now && row.sessionKind === "future") upcoming.push({ id: row.wiseSessionId, date: row.scheduledStartTime.toISOString() });
      seeds.set(key, { ownerKey: tutor.canonicalKey, wiseClassId: row.wiseClassId, wiseStudentId: row.wiseStudentId, studentName: row.studentName, courseName: row.title || row.packageName || row.subject, tutorName: tutor.displayName, classType: pkg?.classType ?? null, upcomingSessions: upcoming });
    }
    for (const seed of seeds.values()) {
      seed.upcomingSessions = seed.upcomingSessions?.sort((a,b) => a.date.localeCompare(b.date)).slice(0, 24);
      await tx.insert(s.ptSeries).values(seed).onConflictDoUpdate({ target: [s.ptSeries.ownerKey,s.ptSeries.wiseClassId,s.ptSeries.wiseStudentId], set: { studentName: seed.studentName, courseName: seed.courseName, tutorName: seed.tutorName, classType: seed.classType, upcomingSessions: seed.upcomingSessions } });
    }
    const series = await tx.select().from(s.ptSeries);
    for (const row of series) {
      const key = seriesKey(row.ownerKey,row.wiseClassId,row.wiseStudentId);
      const classType=classTypeFor(row.wiseClassId,row.wiseStudentId);
      const ids = classType==="ONE_TO_ONE" ? groups.get(key) ?? [] : [];
      await tx.update(s.ptSeries).set({ classType, count: ids.length, sessionIds: ids, updatedAt: now, ...(seeds.has(key) ? {} : { upcomingSessions: [] }) }).where(eq(s.ptSeries.id,row.id));
      if(classType!=="ONE_TO_ONE")continue;
      // Never delete older obligations, submissions or approvals on correction.
      await tx.insert(s.ptAssessments).values(cycleNumbers(ids.length).map(cycle => ({ seriesId: row.id, cycle }))).onConflictDoNothing();
    }
  });
  const notificationCount = await notifyWorkspaceTutors(db, deps.sender);
  const rows = await db.select({ a: s.ptAssessments, series: s.ptSeries }).from(s.ptAssessments).innerJoin(s.ptSeries, eq(s.ptAssessments.seriesId,s.ptSeries.id)).where(eq(s.ptSeries.classType,"ONE_TO_ONE"));
  const outstanding = rows.filter(({ a }) => !(a.approvedReviewId && a.approvedReviewId === a.currentReviewId));
  const approachingCount = outstanding.filter(({ a, series }) => { const p = cyclePosition(series.count,a.cycle); return p >= 6 && p < 8; }).length;
  const dueCount = outstanding.filter(({ a, series }) => cyclePosition(series.count,a.cycle) >= 8).length;
  const result = { success: true, ledgerRowCount, enrollmentCount: new Set(rows.map(r => r.series.id)).size, approachingCount, dueCount, unresolvedTeacherCount, notificationCount };
  await db.update(s.progressTestSyncRuns).set({ status: "success", finishedAt: new Date(), ledgerRowCount, enrollmentCount: result.enrollmentCount, approachingCount, dueCount, notificationCount, metadata: { workflow: "tutor", launchedAt: launchedAt.toISOString(), unresolvedTeacherCount } }).where(eq(s.progressTestSyncRuns.id,deps.syncRunId));
  return result;
}
