import { and, desc, eq, exists, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { classroomTimestampToWiseIso } from "@/lib/classrooms/timestamps";
import { fetchCreditStudents } from "@/lib/credit-control/wise";
import { createWiseClient } from "@/lib/wise/client";
import { isCancelledTitle, type RosterBuildInput, type RosterPackageRow, type RosterSessionRow, type RosterStudentRow } from "./build";

export class NoActiveSnapshotError extends Error {
  constructor() {
    super("No active tutor snapshot");
    this.name = "NoActiveSnapshotError";
  }
}

/** A "current" student has a non-cancelled session from this many days ago ... */
export const CURRENT_STUDENT_PAST_DAYS = 7;
/** ... up to this many days ahead. */
export const CURRENT_STUDENT_FUTURE_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;
/** The paged read took 7.6 s for 1,320 students (14 Oct); this leaves room in the route's 60 s. */
const WISE_STUDENT_FETCH_BUDGET_MS = 30_000;

/** Upcoming session on the ACTIVE tutor snapshot (`future_session_blocks`); `startTime` is a true instant. */
export interface FutureSessionRow {
  wiseSessionId: string;
  wiseClassId: string | null;
  recurrenceId: string | null;
  title: string | null;
  wiseTeacherId: string;
  wiseTeacherUserId: string | null;
  startTime: Date;
  wiseStatus: string;
  /** Wise class band, e.g. "Y9-11 / G8-10 (Int.)". */
  subject: string | null;
  studentIds: string[] | null;
}
/** Recent session from `post_class_sessions`; it has no session title. */
export interface PastSessionRow {
  wiseSessionId: string;
  wiseClassId: string;
  recurrenceId: string | null;
  wiseTeacherUserId: string | null;
  startTime: Date;
  finalStatus: string;
  /** Wise class band (`source_metadata.subject`). */
  band: string | null;
  studentIds: string[];
}

const isCancelledStatus = (status: string) => /^cancel+ed$/i.test(status.trim());
const teacherKey = (classId: string, userId: string | null) => (userId ? `${classId}|${userId}` : null);

/**
 * Pure mapping from session rows to the builder's class, student and session inputs.
 * Only non-cancelled sessions in [now - PAST_DAYS, now + FUTURE_DAYS] count. A past session
 * takes its title from an upcoming session of the same recurrence, else from the upcoming
 * sessions of the same class and teacher, else from the class's only upcoming title. With no
 * title it still makes its students current but gives no session (the builder reports the class).
 * Tutor Wise ids are dropped from student lists: tutors join sessions with their online accounts.
 * `packageName` is the class id; the loader replaces it with the class name.
 */
export function mapSessionsToRosterInput(
  future: FutureSessionRow[],
  past: PastSessionRow[],
  tutorIds: Set<string>,
  now: Date,
): { packages: RosterPackageRow[]; sessions: RosterSessionRow[]; studentIds: string[] } {
  const from = now.getTime() - CURRENT_STUDENT_PAST_DAYS * DAY_MS;
  const to = now.getTime() + CURRENT_STUDENT_FUTURE_DAYS * DAY_MS;
  const inWindow = (start: Date) => start.getTime() >= from && start.getTime() <= to;
  const liveFuture = future.filter((row) =>
    row.wiseClassId && !isCancelledStatus(row.wiseStatus) && !isCancelledTitle(row.title ?? ""));

  // Title sources for past sessions, all from upcoming non-cancelled rows.
  const recurrenceTitles = new Map<string, { title: string; wiseTeacherId: string }>();
  const titleVotes = new Map<string, Map<string, { count: number; wiseTeacherId: string }>>();
  const classTitles = new Map<string, Set<string>>();
  const classBands = new Map<string, string>();
  for (const row of liveFuture) {
    const classId = row.wiseClassId!;
    if (row.subject && !classBands.has(classId)) classBands.set(classId, row.subject);
    if (!row.title) continue;
    if (row.recurrenceId) recurrenceTitles.set(row.recurrenceId, { title: row.title, wiseTeacherId: row.wiseTeacherId });
    classTitles.set(classId, (classTitles.get(classId) ?? new Set()).add(row.title));
    const key = teacherKey(classId, row.wiseTeacherUserId);
    if (!key) continue;
    const votes = titleVotes.get(key) ?? new Map();
    const vote = votes.get(row.title) ?? { count: 0, wiseTeacherId: row.wiseTeacherId };
    vote.count += 1;
    votes.set(row.title, vote);
    titleVotes.set(key, votes);
  }
  const titleFor = (row: PastSessionRow): { title: string; wiseTeacherId: string | null } | null => {
    const byRecurrence = row.recurrenceId ? recurrenceTitles.get(row.recurrenceId) : undefined;
    if (byRecurrence) return byRecurrence;
    const key = teacherKey(row.wiseClassId, row.wiseTeacherUserId);
    const votes = key ? titleVotes.get(key) : undefined;
    if (votes) {
      // Most frequent title of this teacher in this class; ties go to the first title by name.
      const [title, vote] = [...votes].sort(([a, va], [b, vb]) => vb.count - va.count || a.localeCompare(b))[0];
      return { title, wiseTeacherId: vote.wiseTeacherId };
    }
    // The teacher changed (no upcoming sessions of theirs): a single-subject class still names the subject.
    const titles = classTitles.get(row.wiseClassId);
    return titles?.size === 1 ? { title: [...titles][0], wiseTeacherId: null } : null;
  };

  type Live = { wiseClassId: string; title: string | null; wiseTeacherUserId: string | null; wiseTeacherId: string | null; start: Date; band: string; studentIds: string[] };
  const live: Live[] = [];
  for (const row of liveFuture) {
    if (!inWindow(row.startTime)) continue;
    live.push({
      wiseClassId: row.wiseClassId!, title: row.title, wiseTeacherUserId: row.wiseTeacherUserId, wiseTeacherId: row.wiseTeacherId,
      start: row.startTime, band: row.subject ?? "", studentIds: row.studentIds ?? [],
    });
  }
  // The tutor snapshot owns a session once it is listed there (it has the title).
  const futureIds = new Set(future.map((row) => row.wiseSessionId));
  for (const row of past) {
    if (futureIds.has(row.wiseSessionId) || isCancelledStatus(row.finalStatus) || !inWindow(row.startTime)) continue;
    const match = titleFor(row);
    live.push({
      wiseClassId: row.wiseClassId, title: match?.title ?? null, wiseTeacherUserId: row.wiseTeacherUserId,
      wiseTeacherId: match?.wiseTeacherId ?? null, start: row.startTime,
      band: row.band || classBands.get(row.wiseClassId) || "", studentIds: row.studentIds,
    });
  }

  const packages = new Map<string, RosterPackageRow>();
  const sessions = new Map<string, RosterSessionRow & { sessionCount: number }>();
  for (const row of live) {
    for (const wiseStudentId of row.studentIds) {
      if (tutorIds.has(wiseStudentId)) continue;
      const key = JSON.stringify([row.wiseClassId, wiseStudentId, row.band]);
      if (!packages.has(key)) {
        packages.set(key, { wiseClassId: row.wiseClassId, wiseStudentId, packageName: row.wiseClassId, subject: row.band, excludedReason: null });
      }
    }
    if (row.title === null) continue;
    const key = JSON.stringify([row.wiseClassId, row.title, row.wiseTeacherUserId, row.wiseTeacherId]);
    const group = sessions.get(key) ?? {
      wiseClassId: row.wiseClassId, title: row.title, wiseTeacherUserId: row.wiseTeacherUserId,
      wiseTeacherId: row.wiseTeacherId, lastStart: row.start, sessionCount: 0,
    };
    group.sessionCount += 1;
    if (row.start > (group.lastStart as Date)) group.lastStart = row.start;
    sessions.set(key, group);
  }

  const studentIds = [...new Set([...packages.values()].map((row) => row.wiseStudentId))].sort();
  return { packages: [...packages.values()], sessions: [...sessions.values()], studentIds };
}

export type FetchWiseStudents = () => Promise<RosterStudentRow[]>;

const fetchWiseStudents: FetchWiseStudents = async () => {
  const instituteId = process.env.WISE_INSTITUTE_ID ?? "696e1f4d90102225641cc413";
  const students = await fetchCreditStudents(createWiseClient(), instituteId, { deadlineAt: Date.now() + WISE_STUDENT_FETCH_BUDGET_MS });
  return students.map((student) => ({ wiseStudentId: student._id, studentName: student.name, email: student.email ?? null }));
};

/**
 * Stored rows first; Wise is read (one paged list) only when a student id has no stored row.
 * A failed read rejects, so the export fails instead of dropping students.
 */
export async function resolveStudents(
  stored: RosterStudentRow[],
  studentIds: string[],
  fetchStudents: FetchWiseStudents,
): Promise<RosterStudentRow[]> {
  const known = new Set(stored.map((row) => row.wiseStudentId));
  const unknown = new Set(studentIds.filter((id) => !known.has(id)));
  if (!unknown.size) return stored;
  const started = Date.now();
  const fetched = (await fetchStudents()).filter((row) => unknown.has(row.wiseStudentId));
  console.info("[igcse-roster] Wise student read", { unknown: unknown.size, found: fetched.length, ms: Date.now() - started });
  return [...stored, ...fetched];
}

/**
 * Reads data that other syncs keep fresh: the ACTIVE tutor snapshot's upcoming sessions,
 * recent post-class sessions, the newest stored Wise student names and emails, the durable
 * tutor account/contact tables, and the reviewed academic-subject mappings. SELECT only,
 * plus one paged Wise student read when a current student has no stored row.
 */
export async function loadIgcseRosterInput(
  db: Database,
  now: Date = new Date(),
  fetchStudents: FetchWiseStudents = fetchWiseStudents,
): Promise<RosterBuildInput & { snapshotGeneratedAt: Date }> {
  const [snapshot] = await db
    .select({ id: s.snapshots.id, createdAt: s.snapshots.createdAt })
    .from(s.snapshots)
    .where(eq(s.snapshots.active, true))
    .limit(1);
  if (!snapshot) throw new NoActiveSnapshotError();

  const from = new Date(now.getTime() - CURRENT_STUDENT_PAST_DAYS * DAY_MS);
  const to = new Date(now.getTime() + CURRENT_STUDENT_FUTURE_DAYS * DAY_MS);
  const pc = s.postClassSessions;
  const fsb = s.futureSessionBlocks;

  const [futureRows, pastRows, accounts, contacts, mappings, qualifications] = await Promise.all([
    // All upcoming rows, not just the window: they also give titles to past sessions.
    db.select({
      wiseSessionId: fsb.wiseSessionId,
      wiseClassId: fsb.wiseClassId,
      recurrenceId: fsb.recurrenceId,
      title: fsb.title,
      wiseTeacherId: fsb.wiseTeacherId,
      wiseTeacherUserId: fsb.wiseTeacherUserId,
      startTime: fsb.startTime,
      wiseStatus: fsb.wiseStatus,
      subject: fsb.subject,
      studentIds: fsb.studentIds,
    }).from(fsb).where(eq(fsb.snapshotId, snapshot.id)),
    db.select({
      wiseSessionId: pc.wiseSessionId,
      wiseClassId: pc.wiseClassId,
      recurrenceId: pc.recurrenceId,
      wiseTeacherUserId: pc.wiseTeacherUserId,
      startTime: pc.scheduledStartAt,
      finalStatus: pc.finalStatus,
      band: sql<string | null>`${pc.sourceMetadata}->>'subject'`,
      wiseStudentId: s.postClassSessionParticipants.wiseStudentId,
    }).from(pc)
      .leftJoin(s.postClassSessionParticipants, eq(s.postClassSessionParticipants.sessionId, pc.id))
      .where(and(gte(pc.scheduledStartAt, from), lte(pc.scheduledStartAt, to), isNull(pc.wiseDeletedAt))),
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

  // The tutor sync stores Bangkok wall-clock time in UTC fields; post-class stores true instants.
  const future = futureRows.map((row) => ({ ...row, startTime: new Date(classroomTimestampToWiseIso(row.startTime)) }));
  // One row per post-class session with its participant ids.
  const pastById = new Map<string, PastSessionRow>();
  for (const { wiseStudentId, ...row } of pastRows) {
    const session = pastById.get(row.wiseSessionId) ?? { ...row, studentIds: [] };
    if (wiseStudentId && !session.studentIds.includes(wiseStudentId)) session.studentIds.push(wiseStudentId);
    pastById.set(row.wiseSessionId, session);
  }

  const tutorIds = new Set(accounts.flatMap((account) => (account.wiseUserId ? [account.wiseTeacherId, account.wiseUserId] : [account.wiseTeacherId])));
  const { packages, sessions, studentIds } = mapSessionsToRosterInput(future, [...pastById.values()], tutorIds, now);

  // Class name: the newest post-class name of the class (any date); upcoming rows carry none.
  const classIds = [...new Set(packages.map((row) => row.wiseClassId))];
  const nameRows = classIds.length
    ? await db.selectDistinctOn([pc.wiseClassId], { wiseClassId: pc.wiseClassId, className: pc.className })
      .from(pc)
      .where(and(inArray(pc.wiseClassId, classIds), ne(pc.className, "")))
      .orderBy(pc.wiseClassId, desc(pc.scheduledStartAt))
    : [];
  const classNames = new Map(nameRows.map((row) => [row.wiseClassId, row.className]));
  for (const row of packages) row.packageName = classNames.get(row.wiseClassId) ?? row.wiseClassId;

  // Student names/emails: the newest credit-control snapshot that stored students.
  const cc = s.creditControlSnapshots;
  const [studentSnapshot] = await db.select({ id: cc.id }).from(cc)
    .where(exists(db.select({ one: sql`1` }).from(s.creditControlStudents).where(eq(s.creditControlStudents.snapshotId, cc.id))))
    .orderBy(desc(cc.generatedAt))
    .limit(1);
  const stored = studentSnapshot && studentIds.length
    ? await db.select({
      wiseStudentId: s.creditControlStudents.wiseStudentId,
      studentName: s.creditControlStudents.studentName,
      email: s.creditControlStudents.email,
    }).from(s.creditControlStudents)
      .where(and(eq(s.creditControlStudents.snapshotId, studentSnapshot.id), inArray(s.creditControlStudents.wiseStudentId, studentIds)))
    : [];

  return {
    snapshotGeneratedAt: snapshot.createdAt,
    packages,
    students: await resolveStudents(stored, studentIds, fetchStudents),
    sessions,
    accounts,
    contacts,
    qualifications,
    mappings: mappings.map((m) => ({ ...m, reviewedAt: m.reviewedAt?.toISOString() ?? null })),
  };
}
