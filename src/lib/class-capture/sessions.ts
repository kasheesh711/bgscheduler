import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { isSuperAdminEmail } from "@/lib/admin-users/policy";
import { getDb, type Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { classroomTimestampToWiseIso } from "@/lib/classrooms/timestamps";
import { getClassroomSessionMode } from "@/lib/classrooms/session-mode";
import { addBangkokDays, bangkokDateKey, bangkokDateStartUtc, todayBangkok } from "@/lib/room-capacity/dates";
import { deriveSessionModality } from "@/lib/student-schedule/data";
import { wiseSessionLink } from "@/lib/wise/links";
import { captureEnabled, CaptureError, type CaptureSession } from "./model";

export type CaptureScope = { email: string; keys: string[] | null };

const pilotEmailSchema = z.email().max(254);
function normalizedPilotEmail(value: unknown): string | null {
  // Permit surrounding configuration whitespace without accepting unbounded input,
  // address lists, display names, aliases or Unicode lookalikes as another identity.
  if (typeof value !== "string" || value.length > 320) return null;
  const parsed = pilotEmailSchema.safeParse(value.trim());
  return parsed.success ? parsed.data.toLowerCase() : null;
}

/** A single designated owner AND fresh admin access gate every pilot entry point. */
export async function requireCaptureScope(): Promise<CaptureScope> {
  const session = await auth();
  const email = normalizedPilotEmail(session?.user?.email);
  if (!email) throw new CaptureError(401, "Sign in to use Class Capture.");
  const pilotEmail = normalizedPilotEmail(process.env.CLASS_CAPTURE_PILOT_EMAIL);
  const accessVersion = session?.user?.adminAccessVersion;
  if (session?.user?.role !== "admin" || !pilotEmail || email !== pilotEmail || !isSuperAdminEmail(email) ||
    typeof accessVersion !== "number" || !Number.isInteger(accessVersion) || accessVersion < 0) {
    throw new CaptureError(403, "Class Capture is limited to its configured website-owner pilot.");
  }
  const db = getDb();
  const [admin] = await db.select({ disabled: s.adminUsers.disabled, allowedPages: s.adminUsers.allowedPages,
    accessVersion: s.adminUsers.accessVersion }).from(s.adminUsers)
    .where(sql`lower(btrim(${s.adminUsers.email})) = ${email}`).limit(1);
  if (!admin || admin.disabled !== false || admin.accessVersion !== accessVersion ||
    (admin.allowedPages !== null && (!Array.isArray(admin.allowedPages) || !admin.allowedPages.includes("/class-capture")))) {
    throw new CaptureError(403, "Class Capture access has not been granted or is no longer current. Sign in again after access is restored.");
  }
  return { email, keys: null };
}

/** Navigation uses the same current grant as the page; a stale cookie cannot expose the tool. */
export async function canUseClassCapture(): Promise<boolean> {
  if (!captureEnabled()) return false;
  try { await requireCaptureScope(); return true; } catch { return false; }
}

const MAX_SNAPSHOT_AGE_MS = 2 * 60 * 60 * 1000;
const MAX_QUERY_ROWS = 1000;
const ACTIVE_STATUSES = new Set(["UPCOMING", "SCHEDULED", "IN_PROGRESS", "ENDED"]);

function assertScope(scope: CaptureScope, teacherKey?: string) {
  if (!scope.email || (scope.keys !== null && (scope.keys.length !== 1 || (teacherKey !== undefined && !scope.keys.includes(teacherKey))))) {
    throw new CaptureError(403, "This class is outside your current tutor access.");
  }
}

function isFresh(value: Date, now: Date): boolean {
  const age = now.getTime() - value.getTime();
  return Number.isFinite(age) && age >= -5 * 60 * 1000 && age <= MAX_SNAPSHOT_AGE_MS;
}

function captureWindow(now: Date) {
  const today = todayBangkok(now);
  return { first: addBangkokDays(today, -7), last: addBangkokDays(today, 1) };
}

type Identity = {
  groupId: string; canonicalKey: string; displayName: string; wiseTeacherId: string;
  wiseUserId: string | null; isOnlineVariant: boolean; supportedModality: string;
};

function verifiedTeacher(identities: Identity[], userId: string | null, teacherId: string | null, scope: CaptureScope) {
  if (!userId || !teacherId) return null;
  const matches = identities.filter(identity => identity.wiseUserId === userId);
  if (new Set(matches.map(identity => identity.canonicalKey)).size !== 1 ||
    new Set(matches.map(identity => identity.groupId)).size !== 1) return null;
  const match = matches.find(identity => identity.wiseTeacherId === teacherId);
  if (!match || match.isOnlineVariant || !["onsite", "both"].includes(match.supportedModality) ||
    (scope.keys !== null && !scope.keys.includes(match.canonicalKey))) return null;
  return match;
}

/** Reads only pinned snapshots. The caller receives no synthetic or recurrence-derived sessions. */
async function readCaptureSessions(scope: CaptureScope, first: string, last: string, now: Date, requestedSessionId?: string) {
  assertScope(scope);
  const db = getDb();
  const [identitySnapshots, creditSnapshots] = await Promise.all([
    db.select({ id: s.snapshots.id, createdAt: s.snapshots.createdAt }).from(s.snapshots)
      .where(eq(s.snapshots.active, true)).limit(2),
    db.select({ id: s.creditControlSnapshots.id, generatedAt: s.creditControlSnapshots.generatedAt, source: s.creditControlSnapshots.source })
      .from(s.creditControlSnapshots).where(eq(s.creditControlSnapshots.active, true)).limit(2),
  ]);
  const snapshot = identitySnapshots[0];
  if (identitySnapshots.length !== 1 || !snapshot || !isFresh(snapshot.createdAt, now)) {
    throw new CaptureError(503, "The tutor schedule needs a refresh. Ask an administrator to refresh the Wise snapshot in Data Health.");
  }
  const credit = creditSnapshots.length === 1 && creditSnapshots[0].source === "wise" ? creditSnapshots[0] : null;
  const identities = await db.select({
    groupId: s.tutorIdentityGroupMembers.groupId, canonicalKey: s.tutorIdentityGroups.canonicalKey,
    displayName: s.tutorIdentityGroups.displayName, wiseTeacherId: s.tutorIdentityGroupMembers.wiseTeacherId,
    wiseUserId: s.tutorIdentityGroupMembers.wiseUserId, isOnlineVariant: s.tutorIdentityGroupMembers.isOnlineVariant,
    supportedModality: s.tutorIdentityGroups.supportedModality,
  }).from(s.tutorIdentityGroupMembers).innerJoin(s.tutorIdentityGroups,
    and(eq(s.tutorIdentityGroups.id, s.tutorIdentityGroupMembers.groupId), eq(s.tutorIdentityGroups.snapshotId, snapshot.id)))
    .where(eq(s.tutorIdentityGroupMembers.snapshotId, snapshot.id));
  // Resolve ambiguity against all active identities BEFORE restricting to this teacher.
  const userIds = [...new Set(identities.filter(identity => verifiedTeacher(identities, identity.wiseUserId, identity.wiseTeacherId, scope))
    .map(identity => identity.wiseUserId!))];
  if (!userIds.length) return [];

  const endDate = addBangkokDays(last, 1);
  const start = bangkokDateStartUtc(first), end = bangkokDateStartUtc(endDate);
  // The tutor snapshot encodes Bangkok wall time in UTC Date fields. Its bounds
  // and conversion deliberately use the existing classroom timestamp contract.
  const wallStart = new Date(`${first}T00:00:00Z`), wallEnd = new Date(`${endDate}T00:00:00Z`);
  const futureCount = sql<number>`(select count(*)::int from ${s.futureSessionBlocks} capture_sibling
    where capture_sibling.snapshot_id = ${snapshot.id} and capture_sibling.wise_session_id = ${s.futureSessionBlocks.wiseSessionId})`.mapWith(Number);
  const upcoming = await db.select({
    groupId: s.futureSessionBlocks.groupId, wiseTeacherId: s.futureSessionBlocks.wiseTeacherId,
    wiseTeacherUserId: s.futureSessionBlocks.wiseTeacherUserId, wiseSessionId: s.futureSessionBlocks.wiseSessionId,
    wiseClassId: s.futureSessionBlocks.wiseClassId, studentIds: s.futureSessionBlocks.studentIds,
    studentCount: s.futureSessionBlocks.studentCount, resolvedStudentName: s.creditControlStudents.studentName,
    classType: s.futureSessionBlocks.classType, startTime: s.futureSessionBlocks.startTime, endTime: s.futureSessionBlocks.endTime,
    wiseStatus: s.futureSessionBlocks.wiseStatus, sessionType: s.futureSessionBlocks.sessionType,
    title: s.futureSessionBlocks.title, sourceRowCount: futureCount,
    knownDeleted: sql<boolean>`exists (select 1 from ${s.postClassSessions} capture_deleted
      where capture_deleted.wise_session_id = ${s.futureSessionBlocks.wiseSessionId} and capture_deleted.wise_deleted_at is not null)`,
  }).from(s.futureSessionBlocks).leftJoin(s.creditControlStudents, credit ? and(
    eq(s.creditControlStudents.snapshotId, credit.id),
    sql`${s.creditControlStudents.wiseStudentId} = ${s.futureSessionBlocks.studentIds}->>0`,
  ) : sql`false`).where(and(
    eq(s.futureSessionBlocks.snapshotId, snapshot.id), inArray(s.futureSessionBlocks.wiseTeacherUserId, userIds),
    gte(s.futureSessionBlocks.startTime, wallStart), lt(s.futureSessionBlocks.startTime, wallEnd),
    requestedSessionId ? eq(s.futureSessionBlocks.wiseSessionId, requestedSessionId) : undefined,
  )).orderBy(asc(s.futureSessionBlocks.startTime)).limit(MAX_QUERY_ROWS + 1);
  if (upcoming.length > MAX_QUERY_ROWS) throw new CaptureError(503, "Too many scheduled classes to verify. Ask an administrator to review the source data.");
  const result = new Map<string, CaptureSession>();
  for (const row of upcoming) {
    const teacher = verifiedTeacher(identities, row.wiseTeacherUserId, row.wiseTeacherId, scope);
    if (!teacher || row.groupId !== teacher.groupId || !row.wiseClassId || row.sourceRowCount !== 1 || row.knownDeleted ||
      row.classType !== "ONE_TO_ONE" || !Array.isArray(row.studentIds) || row.studentIds.length !== 1 ||
      !row.studentIds[0]?.trim() || (row.studentCount !== null && row.studentCount !== 1) ||
      getClassroomSessionMode(row.sessionType) !== "onsite" || deriveSessionModality(row.title ?? "") === "online" ||
      !ACTIVE_STATUSES.has(row.wiseStatus.trim().toUpperCase()) ||
      !Number.isFinite(row.startTime.getTime()) || !Number.isFinite(row.endTime.getTime())) continue;
    const starts = new Date(classroomTimestampToWiseIso(row.startTime));
    const ends = new Date(classroomTimestampToWiseIso(row.endTime));
    if (starts < start || starts >= end || ends <= starts || (ends <= now && row.wiseStatus !== "ENDED")) continue;
    const session: CaptureSession = {
      sessionId: row.wiseSessionId, classId: row.wiseClassId, studentId: row.studentIds[0],
      studentName: row.resolvedStudentName?.trim() || `Student ${row.studentIds[0]}`,
      teacherKey: teacher.canonicalKey, teacherName: teacher.displayName, title: row.title?.trim() || "Onsite class",
      startTime: starts.toISOString(), endTime: ends.toISOString(),
      wiseUrl: wiseSessionLink({ wiseClassId: row.wiseClassId, wiseSessionId: row.wiseSessionId }),
    };
    result.set(session.sessionId, session);
  }

  // A scheduled class remains usable when the DAILY shared student snapshot is
  // stale. That older snapshot supplies names only; it never supplies grants.
  if (credit && isFresh(credit.generatedAt, now)) {
    const participantCount = sql<number>`(select count(*)::int from ${s.creditControlSessions} capture_participant
      where capture_participant.snapshot_id = ${credit.id} and capture_participant.wise_session_id = ${s.creditControlSessions.wiseSessionId})`.mapWith(Number);
    const recent = await db.select({
      wiseSessionId: s.creditControlSessions.wiseSessionId, wiseClassId: s.creditControlSessions.wiseClassId,
      wiseStudentId: s.creditControlSessions.wiseStudentId, wiseTeacherId: s.creditControlSessions.wiseTeacherId,
      wiseTeacherUserId: s.creditControlSessions.wiseTeacherUserId, studentName: s.creditControlStudents.studentName,
      title: s.creditControlSessions.title, classType: s.creditControlPackages.classType,
      sessionKind: s.creditControlSessions.sessionKind, meetingStatus: s.creditControlSessions.meetingStatus,
      scheduledStartTime: s.creditControlSessions.scheduledStartTime, scheduledEndTime: s.creditControlSessions.scheduledEndTime,
      sourceRowCount: participantCount,
      hasCurrentScheduleEntry: sql<boolean>`exists (select 1 from ${s.futureSessionBlocks} capture_current
        where capture_current.snapshot_id = ${snapshot.id} and capture_current.wise_session_id = ${s.creditControlSessions.wiseSessionId})`,
      knownDeleted: sql<boolean>`exists (select 1 from ${s.postClassSessions} capture_deleted
        where capture_deleted.wise_session_id = ${s.creditControlSessions.wiseSessionId} and capture_deleted.wise_deleted_at is not null)`,
    }).from(s.creditControlSessions).innerJoin(s.creditControlStudents, and(
      eq(s.creditControlStudents.snapshotId, credit.id), eq(s.creditControlStudents.wiseStudentId, s.creditControlSessions.wiseStudentId),
    )).innerJoin(s.creditControlPackages, and(
      eq(s.creditControlPackages.snapshotId, credit.id), eq(s.creditControlPackages.wiseClassId, s.creditControlSessions.wiseClassId),
      eq(s.creditControlPackages.wiseStudentId, s.creditControlSessions.wiseStudentId),
    )).where(and(
      eq(s.creditControlSessions.snapshotId, credit.id), inArray(s.creditControlSessions.wiseTeacherUserId, userIds),
      gte(s.creditControlSessions.scheduledStartTime, start), lt(s.creditControlSessions.scheduledStartTime, end),
      eq(s.creditControlSessions.sessionKind, "past"), eq(s.creditControlSessions.meetingStatus, "ENDED"),
      lte(s.creditControlSessions.scheduledEndTime, now),
      requestedSessionId ? eq(s.creditControlSessions.wiseSessionId, requestedSessionId) : undefined,
    )).orderBy(asc(s.creditControlSessions.scheduledStartTime)).limit(MAX_QUERY_ROWS + 1);
    if (recent.length > MAX_QUERY_ROWS) throw new CaptureError(503, "Too many recent classes to verify. Ask an administrator to review the source data.");
    for (const row of recent) {
      const teacher = verifiedTeacher(identities, row.wiseTeacherUserId, row.wiseTeacherId, scope);
      if (!teacher || !row.wiseStudentId || !row.wiseClassId || row.classType !== "ONE_TO_ONE" || row.sourceRowCount !== 1 || row.knownDeleted || row.hasCurrentScheduleEntry ||
        row.sessionKind !== "past" || row.meetingStatus !== "ENDED" || deriveSessionModality(row.title) !== "onsite" ||
        !row.scheduledEndTime || row.scheduledEndTime <= row.scheduledStartTime || row.scheduledEndTime > now ||
        row.scheduledStartTime < start || row.scheduledStartTime >= end) continue;
      // Any presence in the fresh tutor feed outranks the independent student
      // snapshot, including a fresh cancellation, roster change or reassignment.
      if (upcoming.some(session => session.wiseSessionId === row.wiseSessionId)) continue;
      result.set(row.wiseSessionId, {
        sessionId: row.wiseSessionId, classId: row.wiseClassId, studentId: row.wiseStudentId,
        studentName: row.studentName, teacherKey: teacher.canonicalKey, teacherName: teacher.displayName, title: row.title,
        startTime: row.scheduledStartTime.toISOString(), endTime: row.scheduledEndTime.toISOString(),
        wiseUrl: wiseSessionLink({ wiseClassId: row.wiseClassId, wiseSessionId: row.wiseSessionId }),
      });
    }
  } else if (!result.size) {
    throw new CaptureError(503, "Recently completed classes need a fresh student snapshot. Ask an administrator to refresh the shared student snapshot in Data Health.");
  }
  return [...result.values()].sort((a, b) => a.startTime.localeCompare(b.startTime) || a.sessionId.localeCompare(b.sessionId));
}

export async function listCaptureSessions(scope: CaptureScope, date: string): Promise<CaptureSession[]> {
  const now = new Date(), window = captureWindow(now);
  const parsed = new Date(`${date}T00:00:00+07:00`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed.getTime()) || bangkokDateKey(parsed) !== date || date < window.first || date > window.last) {
    throw new CaptureError(400, "Choose a Bangkok date from the past seven days through tomorrow.");
  }
  return readCaptureSessions(scope, date, date, now);
}

export async function requireCaptureSession(scope: CaptureScope, sessionId: string, studentId: string): Promise<CaptureSession> {
  const now = new Date(), window = captureWindow(now);
  if (!sessionId.trim() || !studentId.trim() || sessionId.length > 200 || studentId.length > 200) throw new CaptureError(404, "This class is not available for capture.");
  const sessions = await readCaptureSessions(scope, window.first, window.last, now, sessionId);
  const session = sessions.find(session => session.sessionId === sessionId && session.studentId === studentId);
  if (!session) throw new CaptureError(404, "This class is not available for capture.");
  return session;
}

/**
 * Revalidate a server-loaded capture after its creator and retention window have
 * been checked. A completed class may leave the future feed without revoking the
 * owner's earlier artifact; a current conflicting schedule or deletion may not.
 */
export async function assertCaptureSessionCurrent(
  scope: CaptureScope,
  session: CaptureSession,
  db?: Database,
): Promise<void> {
  assertScope(scope, session.teacherKey);
  const start = new Date(session.startTime), end = new Date(session.endTime), now = new Date();
  const changed = () => new CaptureError(403, "This class has changed or is no longer authorized for this capture. Review the current schedule.");
  if (!session.sessionId || !session.classId || !session.studentId || !session.teacherKey ||
    !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) throw changed();
  const database = db ?? getDb();
  const snapshots = await database.select({ id: s.snapshots.id, createdAt: s.snapshots.createdAt })
    .from(s.snapshots).where(eq(s.snapshots.active, true)).limit(2);
  const snapshot = snapshots[0];
  if (snapshots.length !== 1 || !snapshot || !isFresh(snapshot.createdAt, now)) {
    throw new CaptureError(503, "The tutor schedule needs a refresh. Ask an administrator to refresh the Wise snapshot in Data Health.");
  }
  const [current, sourceStates] = await Promise.all([
    // Deliberately query by session across ALL teachers and dates so reassignment
    // or rescheduling cannot masquerade as an absent, completed class.
    database.select({
      wiseSessionId: s.futureSessionBlocks.wiseSessionId, wiseClassId: s.futureSessionBlocks.wiseClassId,
      groupId: s.futureSessionBlocks.groupId, wiseTeacherUserId: s.futureSessionBlocks.wiseTeacherUserId,
      wiseTeacherId: s.futureSessionBlocks.wiseTeacherId, studentIds: s.futureSessionBlocks.studentIds,
      studentCount: s.futureSessionBlocks.studentCount, classType: s.futureSessionBlocks.classType,
      sessionType: s.futureSessionBlocks.sessionType, title: s.futureSessionBlocks.title,
      wiseStatus: s.futureSessionBlocks.wiseStatus, startTime: s.futureSessionBlocks.startTime, endTime: s.futureSessionBlocks.endTime,
    }).from(s.futureSessionBlocks).where(and(
      eq(s.futureSessionBlocks.snapshotId, snapshot.id), eq(s.futureSessionBlocks.wiseSessionId, session.sessionId),
    )).limit(2),
    database.select({ wiseSessionId: s.postClassSessions.wiseSessionId, wiseDeletedAt: s.postClassSessions.wiseDeletedAt,
      finalStatus: s.postClassSessions.finalStatus }).from(s.postClassSessions)
      .where(eq(s.postClassSessions.wiseSessionId, session.sessionId)).limit(1),
  ]);
  if (sourceStates.some(state => state.wiseSessionId === session.sessionId &&
    (state.wiseDeletedAt || ["CANCELLED", "CANCELED", "DELETED"].includes(state.finalStatus?.trim().toUpperCase())))) throw changed();
  if (!current.length) {
    if (end < now) return;
    throw changed();
  }
  if (current.length !== 1) throw changed();
  const row = current[0];
  if (row.wiseSessionId !== session.sessionId || row.wiseClassId !== session.classId || row.classType !== "ONE_TO_ONE" ||
    !Array.isArray(row.studentIds) || row.studentIds.length !== 1 || row.studentIds[0] !== session.studentId ||
    (row.studentCount !== null && row.studentCount !== 1) || getClassroomSessionMode(row.sessionType) !== "onsite" ||
    deriveSessionModality(row.title ?? "") === "online" || !ACTIVE_STATUSES.has(row.wiseStatus.trim().toUpperCase()) ||
    !Number.isFinite(row.startTime.getTime()) || !Number.isFinite(row.endTime.getTime()) ||
    Date.parse(classroomTimestampToWiseIso(row.startTime)) !== start.getTime() ||
    Date.parse(classroomTimestampToWiseIso(row.endTime)) !== end.getTime()) throw changed();
  const identities = await database.select({
    groupId: s.tutorIdentityGroupMembers.groupId, canonicalKey: s.tutorIdentityGroups.canonicalKey,
    displayName: s.tutorIdentityGroups.displayName, wiseTeacherId: s.tutorIdentityGroupMembers.wiseTeacherId,
    wiseUserId: s.tutorIdentityGroupMembers.wiseUserId, isOnlineVariant: s.tutorIdentityGroupMembers.isOnlineVariant,
    supportedModality: s.tutorIdentityGroups.supportedModality,
  }).from(s.tutorIdentityGroupMembers).innerJoin(s.tutorIdentityGroups, and(
    eq(s.tutorIdentityGroups.id, s.tutorIdentityGroupMembers.groupId), eq(s.tutorIdentityGroups.snapshotId, snapshot.id),
  )).where(eq(s.tutorIdentityGroupMembers.snapshotId, snapshot.id));
  const teacher = verifiedTeacher(identities, row.wiseTeacherUserId, row.wiseTeacherId, scope);
  if (!teacher || teacher.canonicalKey !== session.teacherKey || row.groupId !== teacher.groupId) throw changed();
}

/** Session must be the server-loaded, owned capture snapshot, never request-body fields. */
export async function loadPriorFeedback(scope: CaptureScope, session: CaptureSession): Promise<Array<{ date: string; text: string }>> {
  assertScope(scope, session.teacherKey);
  const start = new Date(session.startTime), now = new Date();
  if (!session.sessionId || !session.classId || !session.studentId || !session.teacherKey || !Number.isFinite(start.getTime())) return [];
  const earliest = new Date(start.getTime() - 90 * 86400000);
  const participantCount = sql<number>`(select count(*)::int from ${s.postClassSessionParticipants} capture_prior_participant
    where capture_prior_participant.session_id = ${s.postClassSessions.id})`.mapWith(Number);
  const rows = await getDb().select({
    wiseSessionId: s.postClassSessions.wiseSessionId, wiseClassId: s.postClassSessions.wiseClassId,
    canonicalTutorKey: s.postClassSessions.canonicalTutorKey, wiseStudentId: s.postClassSessionParticipants.wiseStudentId,
    scheduledEndAt: s.postClassSessions.scheduledEndAt, sourceStatus: s.postClassSessions.sourceStatus,
    finalStatus: s.postClassSessions.finalStatus, wiseDeletedAt: s.postClassSessions.wiseDeletedAt,
    participantCount, profile: s.postClassFeedbackVersions.profile,
    topics: s.postClassFeedbackVersions.topics, performance: s.postClassFeedbackVersions.performance,
    improvement: s.postClassFeedbackVersions.improvement, homework: s.postClassFeedbackVersions.homework,
  }).from(s.postClassSessions).innerJoin(s.postClassSessionParticipants, and(
    eq(s.postClassSessionParticipants.sessionId, s.postClassSessions.id), eq(s.postClassSessionParticipants.wiseStudentId, session.studentId),
  )).innerJoin(s.postClassFeedbackVersions, and(
    eq(s.postClassFeedbackVersions.id, s.postClassSessions.latestFeedbackVersionId),
    eq(s.postClassFeedbackVersions.sessionId, s.postClassSessions.id),
  )).where(and(
    eq(s.postClassSessions.wiseClassId, session.classId), eq(s.postClassSessions.canonicalTutorKey, session.teacherKey),
    eq(s.postClassSessionParticipants.wiseStudentId, session.studentId), ne(s.postClassSessions.wiseSessionId, session.sessionId),
    eq(s.postClassSessions.sourceStatus, "ready"), eq(s.postClassSessions.finalStatus, "ENDED"), isNull(s.postClassSessions.wiseDeletedAt),
    eq(s.postClassFeedbackVersions.profile, "teacher"), eq(participantCount, 1),
    gte(s.postClassSessions.scheduledEndAt, earliest), lt(s.postClassSessions.scheduledEndAt, start), lte(s.postClassSessions.scheduledEndAt, now),
  )).orderBy(desc(s.postClassSessions.scheduledEndAt)).limit(3);
  return rows.filter(row => row.wiseClassId === session.classId && row.wiseStudentId === session.studentId && row.canonicalTutorKey === session.teacherKey &&
    row.wiseSessionId !== session.sessionId && row.participantCount === 1 && row.profile === "teacher" && row.sourceStatus === "ready" &&
    row.finalStatus === "ENDED" && !row.wiseDeletedAt && row.scheduledEndAt >= earliest && row.scheduledEndAt < start && row.scheduledEndAt <= now)
    .map(row => ({ date: bangkokDateKey(row.scheduledEndAt), text: [
      ["Topics", row.topics], ["Demonstrated understanding", row.performance], ["Difficulties", row.improvement], ["Homework / next steps", row.homework],
    ].filter(([, value]) => value.trim()).map(([label, value]) => `${label}: ${value.trim().slice(0, 1500)}`).join("\n") }))
    .filter(row => row.text).slice(0, 3);
}
