import { and, count, eq, max } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import type { RosterBuildInput } from "./build";

export class NoActiveSnapshotError extends Error {
  constructor() {
    super("No active credit-control snapshot");
    this.name = "NoActiveSnapshotError";
  }
}

/**
 * Reads the already-synced Wise data: the ACTIVE credit-control snapshot
 * (students, packages, sessions) plus the durable tutor account/contact tables
 * and the reviewed academic-subject mappings. SELECT only.
 */
export async function loadIgcseRosterInput(db: Database): Promise<RosterBuildInput & { snapshotGeneratedAt: Date }> {
  const [snapshot] = await db
    .select({ id: s.creditControlSnapshots.id, generatedAt: s.creditControlSnapshots.generatedAt })
    .from(s.creditControlSnapshots)
    .where(eq(s.creditControlSnapshots.active, true))
    .limit(1);
  if (!snapshot) throw new NoActiveSnapshotError();

  const [packages, students, sessions, accounts, contacts, mappings, qualifications] = await Promise.all([
    db.select({
      wiseClassId: s.creditControlPackages.wiseClassId,
      wiseStudentId: s.creditControlPackages.wiseStudentId,
      packageName: s.creditControlPackages.packageName,
      subject: s.creditControlPackages.subject,
      excludedReason: s.creditControlPackages.excludedReason,
    }).from(s.creditControlPackages).where(eq(s.creditControlPackages.snapshotId, snapshot.id)),
    db.select({
      wiseStudentId: s.creditControlStudents.wiseStudentId,
      studentName: s.creditControlStudents.studentName,
      email: s.creditControlStudents.email,
    }).from(s.creditControlStudents).where(eq(s.creditControlStudents.snapshotId, snapshot.id)),
    db.select({
      wiseClassId: s.creditControlSessions.wiseClassId,
      title: s.creditControlSessions.title,
      wiseTeacherUserId: s.creditControlSessions.wiseTeacherUserId,
      wiseTeacherId: s.creditControlSessions.wiseTeacherId,
      lastStart: max(s.creditControlSessions.scheduledStartTime),
      sessionCount: count(),
    }).from(s.creditControlSessions)
      .where(eq(s.creditControlSessions.snapshotId, snapshot.id))
      .groupBy(
        s.creditControlSessions.wiseClassId,
        s.creditControlSessions.title,
        s.creditControlSessions.wiseTeacherUserId,
        s.creditControlSessions.wiseTeacherId,
      ),
    db.select({
      wiseTeacherId: s.tutorWiseAccounts.wiseTeacherId,
      wiseUserId: s.tutorWiseAccounts.wiseUserId,
      canonicalKey: s.tutorWiseAccounts.canonicalKey,
      isOnlineVariant: s.tutorWiseAccounts.isOnlineVariant,
      email: s.tutorWiseAccounts.email,
    }).from(s.tutorWiseAccounts),
    db.select({
      canonicalKey: s.tutorContacts.canonicalKey,
      displayName: s.tutorContacts.displayName,
      primaryEmail: s.tutorContacts.primaryEmail,
      onsiteEmail: s.tutorContacts.onsiteEmail,
      onlineEmail: s.tutorContacts.onlineEmail,
      active: s.tutorContacts.active,
    }).from(s.tutorContacts),
    db.select().from(s.workforceSubjectMappings),
    // Wise qualification tags live on the ACTIVE availability snapshot, keyed by identity group.
    db.select({
      canonicalKey: s.tutorIdentityGroups.canonicalKey,
      subject: s.subjectLevelQualifications.subject,
      curriculum: s.subjectLevelQualifications.curriculum,
      level: s.subjectLevelQualifications.level,
    }).from(s.subjectLevelQualifications)
      .innerJoin(s.tutorIdentityGroups, eq(s.tutorIdentityGroups.id, s.subjectLevelQualifications.groupId))
      .innerJoin(s.snapshots, and(eq(s.snapshots.id, s.subjectLevelQualifications.snapshotId), eq(s.snapshots.active, true))),
  ]);

  return {
    snapshotGeneratedAt: snapshot.generatedAt,
    packages,
    students,
    sessions,
    accounts,
    contacts,
    qualifications,
    mappings: mappings.map((m) => ({ ...m, reviewedAt: m.reviewedAt?.toISOString() ?? null })),
  };
}
