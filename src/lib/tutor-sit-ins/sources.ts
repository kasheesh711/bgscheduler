import { and, eq, gte, lt } from "drizzle-orm";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { getDb, type Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { ensureIndex, type SearchIndex } from "@/lib/search/index";
import { createWiseClient } from "@/lib/wise/client";
import { fetchWiseSessionsForBangkokDates } from "@/lib/wise/day-sessions";
import {
  fetchTeacherAvailability,
  fetchWiseSessionDetail,
} from "@/lib/wise/fetchers";
import {
  getWiseSessionClassId,
  getWiseSessionTeacherUserId,
  type WiseSession,
} from "@/lib/wise/types";
import { normalizeWorkingHours } from "@/lib/normalization/availability";
import { getClassroomSessionMode } from "@/lib/classrooms/session-mode";
import {
  isBlockingStatus,
  sessionStudentIds,
} from "@/lib/normalization/sessions";
import { resolveObserver } from "./access";
import {
  type Department,
  type Lesson,
  type Suggestion,
  localDate,
  NOTICE_MS,
  overlap,
  quarterBounds,
  requireNotice,
  SitInError,
  SOURCE_MAX_AGE_MS,
  titleDepartments,
  titleScopes,
  coverageScopes,
  scopeOf,
  lessonScopes,
  isCancelled,
  isUpcoming,
  ZONE,
} from "./model";

import { datedRoster } from "./readiness";

export type Sources = {
  lessons: Lesson[];
  index: SearchIndex;
  accounts: Array<typeof s.tutorWiseAccounts.$inferSelect>;
  contacts: Array<typeof s.tutorContacts.$inferSelect>;
  snapshotId: string;
  generatedAt: Date;
  mappings: Array<typeof s.tutorSitInMappings.$inferSelect>;
};
export function lessonModality(type: string | null | undefined) {
  const mode = getClassroomSessionMode(type);
  return mode === "unknown" ? null : mode;
}
function sourcesSessionBlocks(index: SearchIndex) {
  return index.tutorGroups.flatMap((g) => g.sessionBlocks);
}
export async function loadSources(
  quarter: string,
  db: Database = getDb(),
  now = new Date(),
): Promise<Sources> {
  const { start, end } = quarterBounds(quarter);
  const [snapshot] = await db
    .select()
    .from(s.creditControlSnapshots)
    .where(eq(s.creditControlSnapshots.active, true))
    .limit(1);
  if (
    !snapshot ||
    now.getTime() - snapshot.generatedAt.getTime() > SOURCE_MAX_AGE_MS
  )
    throw new SitInError(
      409,
      "Wise student and class data is not fresh enough. Refresh the source sync before scheduling.",
      "STALE_SOURCE",
    );
  const [rows, students, accounts, contacts, mappings, index] =
    await Promise.all([
      db
        .select()
        .from(s.creditControlSessions)
        .where(
          and(
            eq(s.creditControlSessions.snapshotId, snapshot.id),
            gte(s.creditControlSessions.scheduledStartTime, start),
            lt(s.creditControlSessions.scheduledStartTime, end),
          ),
        ),
      db
        .select()
        .from(s.creditControlStudents)
        .where(eq(s.creditControlStudents.snapshotId, snapshot.id)),
      db.select().from(s.tutorWiseAccounts),
      db.select().from(s.tutorContacts).where(eq(s.tutorContacts.active, true)),
      db.select().from(s.tutorSitInMappings),
      ensureIndex(db),
    ]);
  if (now.getTime() - index.syncedAt.getTime() > SOURCE_MAX_AGE_MS)
    throw new SitInError(
      409,
      "Tutor availability data is stale. Refresh the Wise sync before scheduling.",
      "STALE_SOURCE",
    );
  const contactMap = new Map(contacts.map((c) => [c.canonicalKey, c]));
  const studentMap = new Map(students.map((v) => [v.wiseStudentId, v]));
  const lessonMap = new Map<string, Lesson>();
  const indexedSessions = new Map(
    sourcesSessionBlocks(index).map((b) => [b.wiseSessionId, b]),
  );
  for (const row of rows) {
    if (!row.scheduledEndTime || row.scheduledEndTime <= row.scheduledStartTime)
      continue;
    const matches = accounts.filter(
      (a) =>
        a.wiseTeacherId === row.wiseTeacherId ||
        (row.wiseTeacherUserId && a.wiseUserId === row.wiseTeacherUserId),
    );
    const keys = [...new Set(matches.map((a) => a.canonicalKey))];
    const key = keys.length === 1 && contactMap.has(keys[0]) ? keys[0] : null;
    const explicit = mappings.find((m) => m.classId === row.wiseClassId);
    let lesson = lessonMap.get(row.wiseSessionId);
    if (!lesson) {
      const indexed = indexedSessions.get(row.wiseSessionId);
      lesson = {
        id: row.wiseSessionId,
        classId: row.wiseClassId,
        tutorKey: key,
        tutorName: key
          ? contactMap.get(key)!.displayName
          : row.teacherName || "Tutor needs review",
        title: row.title,
        start: row.scheduledStartTime.toISOString(),
        end: row.scheduledEndTime.toISOString(),
        status: row.meetingStatus,
        location: indexed?.location || null,
        modality: lessonModality(indexed?.sessionType),
        departments: explicit
          ? (explicit.departments as Department[])
          : titleDepartments(row.title),
        scopes: explicit ? coverageScopes(explicit) : titleScopes(row.title),
        participants: [],
      };
      lessonMap.set(row.wiseSessionId, lesson);
    } else if (
      lesson.tutorKey !== key ||
      lesson.start !== row.scheduledStartTime.toISOString() ||
      lesson.end !== row.scheduledEndTime.toISOString() ||
      lesson.status !== row.meetingStatus
    ) {
      throw new SitInError(
        409,
        "Wise returned inconsistent class participants or teaching details.",
      );
    }
    const student = studentMap.get(row.wiseStudentId);
    const parentName = student?.parentName.trim() || null;
    // Family identity follows the existing credit-control parent grouping. A
    // missing parent stays unresolved; student names never supply parent identity.
    if (!lesson.participants.some((p) => p.studentKey === row.studentKey))
      lesson.participants.push({
        wiseStudentId: row.wiseStudentId,
        studentKey: row.studentKey,
        studentName: row.studentName,
        parentName,
        familyKey: parentName
          ? parentName.normalize("NFKC").toLowerCase().replace(/\s+/g, " ")
          : null,
      });
  }
  // Credit rows require a student/package pair. Keep obligations for real
  // core classes even if that join is unresolved; never silently omit a tutor.
  const core = await db
    .select()
    .from(s.futureSessionBlocks)
    .where(eq(s.futureSessionBlocks.snapshotId, index.snapshotId));
  for (const row of core) {
    if (!row.wiseClassId || !isUpcoming(row.wiseStatus)) continue;
    const date = row.startTime.toISOString().slice(0, 10);
    const hhmm = (minute: number) =>
      String(Math.floor(minute / 60)).padStart(2, "0") +
      ":" +
      String(minute % 60).padStart(2, "0");
    const lessonStart = fromZonedTime(date + "T" + hhmm(row.startMinute), ZONE);
    const lessonEnd = fromZonedTime(date + "T" + hhmm(row.endMinute), ZONE);
    if (lessonStart < start || lessonStart >= end || lessonEnd <= lessonStart)
      continue;
    const group = index.tutorGroups.find((g) => g.id === row.groupId);
    const key =
      group && contactMap.has(group.canonicalKey) ? group.canonicalKey : null;
    const mapping = mappings.find((m) => m.classId === row.wiseClassId);
    lessonMap.set(row.wiseSessionId, {
      id: row.wiseSessionId,
      classId: row.wiseClassId,
      tutorKey: key,
      tutorName: key ? contactMap.get(key)!.displayName : "Tutor needs review",
      title: row.title || "Untitled class",
      start: lessonStart.toISOString(),
      end: lessonEnd.toISOString(),
      status: row.wiseStatus,
      location: row.location,
      modality: lessonModality(row.sessionType),
      departments: mapping
        ? (mapping.departments as Department[])
        : titleDepartments(row.title || ""),
      scopes: mapping ? coverageScopes(mapping) : titleScopes(row.title || ""),
      ...datedRoster(row.studentIds, studentMap),
    });
  }
  return {
    lessons: [...lessonMap.values()],
    index,
    accounts,
    contacts,
    snapshotId: snapshot.id,
    generatedAt: snapshot.generatedAt,
    mappings,
  };
}
export function teachingEvidence(lesson: Lesson, now = new Date()) {
  return new Date(lesson.start) >= now
    ? isUpcoming(lesson.status)
    : /^(completed|attended|ended|ongoing)$/i.test(lesson.status);
}
// Core snapshot timestamps encode Bangkok wall time; convert explicitly, without
// depending on the worker/server host timezone.
const snapshotInstant = (date: Date) =>
  fromZonedTime(date.toISOString().slice(0, -1), ZONE);
export function snapshotAvailable(
  sources: Sources,
  observerKey: string,
  lesson: Lesson,
  reviewReasons?: Set<string>,
) {
  const head = sources.index.tutorGroups.find(
    (g) => g.canonicalKey === observerKey,
  );
  const accounts = sources.accounts.filter(
    (a) => a.canonicalKey === observerKey,
  );
  if (
    !head ||
    !accounts.length ||
    accounts.some(
      (a) =>
        !a.wiseUserId ||
        a.lastSnapshotId !== sources.index.snapshotId ||
        !["active", "invalid_email", "email_conflict"].includes(a.status),
    ) ||
    head.wiseRecords.some(
      (r) => !accounts.some((a) => a.wiseTeacherId === r.wiseTeacherId),
    )
  ) {
    reviewReasons?.add(
      "The observer's linked Wise accounts need identity verification.",
    );
    return false;
  }
  if (
    !head.leavesCompleteThrough ||
    head.leavesCompleteThrough < new Date(lesson.end)
  ) {
    reviewReasons?.add(
      "Wise leave coverage is temporarily incomplete for these dates. The source sync will retry automatically.",
    );
    return false;
  }
  if (!lesson.modality) {
    reviewReasons?.add(
      "The observed lesson's location or modality needs verification.",
    );
    return false;
  }
  const interval = { start: new Date(lesson.start), end: new Date(lesson.end) };
  const minute = (d: Date) =>
    Number(formatInTimeZone(d, ZONE, "H")) * 60 +
    Number(formatInTimeZone(d, ZONE, "m"));
  const weekday = Number(formatInTimeZone(interval.start, ZONE, "i")) % 7;
  if (localDate(interval.start) !== localDate(interval.end)) return false;
  // Observe inside any verified working window, irrespective of account labels
  // or teaching qualifications. Every linked account's classes and leave block.
  if (
    !head.availabilityWindows.some(
      (w) =>
        w.weekday === weekday &&
        w.startMinute <= minute(interval.start) &&
        w.endMinute >= minute(interval.end),
    )
  )
    return false;
  if (
    head.leaves.some((l) =>
      overlap(interval, {
        start: snapshotInstant(l.startTime),
        end: snapshotInstant(l.endTime),
      }),
    )
  )
    return false;
  return !head.sessionBlocks.some(
    (b) =>
      b.isBlocking &&
      overlap(interval, {
        start: snapshotInstant(b.startTime),
        end: snapshotInstant(b.endTime),
      }),
  );
}
export async function suggestionsFor(
  assignment: typeof s.tutorSitInAssignments.$inferSelect,
  sources: Sources,
  db: Database,
  now = new Date(),
): Promise<Suggestion[]> {
  if (!assignment.observerEmail)
    throw new SitInError(
      409,
      "Assign an eligible alternate observer first.",
      "ASSIGN_OBSERVER",
    );
  const head = await resolveObserver(
    assignment.observerEmail,
    scopeOf(assignment),
    assignment.canonicalKey,
    db,
  );
  const reviewReasons = new Set<string>();
  const matching = sources.lessons.filter(
    (l) =>
      l.tutorKey === assignment.canonicalKey &&
      lessonScopes(l).includes(scopeOf(assignment)) &&
      isUpcoming(l.status) &&
      Date.parse(l.start) >= now.getTime() + NOTICE_MS,
  );
  const eligible = matching
    .filter(
      (l) =>
        l.participants.length > 0 &&
        !l.issues?.some((i) => i.category === "students") &&
        snapshotAvailable(sources, head.canonicalKey, l, reviewReasons),
    )
    .sort((a, b) => a.start.localeCompare(b.start));
  if (!eligible.length) {
    if (reviewReasons.size)
      throw new SitInError(
        409,
        [...reviewReasons].join(" "),
        [...reviewReasons].some((r) => r.includes("identity"))
          ? "IDENTITY_REVIEW"
          : "WISE_VERIFICATION_PENDING",
      );
    if (
      matching.some(
        (l) =>
          !l.participants.length ||
          l.issues?.some((i) => i.category === "students"),
      )
    )
      throw new SitInError(
        409,
        "These dated lessons are awaiting student verification. Refresh the Wise student source.",
        "STUDENT_ROSTER",
      );
    return [];
  }
  const bookings = await db
    .select()
    .from(s.tutorSitInObservations)
    .where(
      and(
        eq(s.tutorSitInObservations.observerCanonicalKey, head.canonicalKey),
        eq(s.tutorSitInObservations.current, true),
      ),
    );
  const free = eligible.filter(
    (l) =>
      !bookings.some((b) =>
        overlap(
          { start: new Date(l.start), end: new Date(l.end) },
          { start: b.startTime, end: b.endTime },
        ),
      ),
  );
  if (!free.length) return [];
  return free.map((l) => ({
    sessionId: l.id,
    title: l.title,
    start: l.start,
    end: l.end,
    location: l.location,
    modality: l.modality,
    verification: "wise_verified",
    issues: l.issues || [],
  }));
}
export function sameLesson(a: Lesson, b: Lesson) {
  return (
    a.id === b.id &&
    a.classId === b.classId &&
    a.tutorKey === b.tutorKey &&
    a.start === b.start &&
    a.end === b.end &&
    a.location === b.location &&
    a.modality === b.modality &&
    JSON.stringify(
      a.participants
        .map(({ studentKey, studentName, familyKey, parentName }) => ({
          studentKey,
          studentName,
          familyKey,
          parentName,
        }))
        .sort((x, y) => x.studentKey.localeCompare(y.studentKey)),
    ) ===
      JSON.stringify(
        b.participants
          .map(({ studentKey, studentName, familyKey, parentName }) => ({
            studentKey,
            studentName,
            familyKey,
            parentName,
          }))
          .sort((x, y) => x.studentKey.localeCompare(y.studentKey)),
      )
  );
}
export function assertLiveHeadFree(
  lesson: Lesson,
  sessions: WiseSession[],
  userIds: Set<string>,
  working: ReturnType<typeof normalizeWorkingHours>,
  leaves: Array<{ startTime: string; endTime: string }>,
) {
  const interval = { start: new Date(lesson.start), end: new Date(lesson.end) };
  const date = localDate(interval.start),
    weekday = Number(formatInTimeZone(interval.start, ZONE, "i")) % 7;
  const minute = (d: Date) =>
    Number(formatInTimeZone(d, ZONE, "H")) * 60 +
    Number(formatInTimeZone(d, ZONE, "m"));
  if (
    date !== localDate(interval.end) ||
    !working.some(
      (w) =>
        w.weekday === weekday &&
        w.startMinute <= minute(interval.start) &&
        w.endMinute >= minute(interval.end),
    )
  )
    throw new SitInError(
      409,
      "This lesson is outside the observer's verified working hours.",
      "HEAD_UNAVAILABLE",
    );
  for (const leave of leaves) {
    if (
      !Number.isFinite(Date.parse(leave.startTime)) ||
      !Number.isFinite(Date.parse(leave.endTime))
    )
      throw new SitInError(409, "Observer leave data needs review.");
    if (
      overlap(interval, {
        start: new Date(leave.startTime),
        end: new Date(leave.endTime),
      })
    )
      throw new SitInError(
        409,
        "The observer is on leave.",
        "HEAD_UNAVAILABLE",
      );
  }
  for (const session of sessions) {
    const id = getWiseSessionTeacherUserId(session);
    if (
      !isBlockingStatus(session.meetingStatus) ||
      !overlap(interval, {
        start: new Date(session.scheduledStartTime),
        end: new Date(session.scheduledEndTime),
      })
    )
      continue;
    if (!id)
      throw new SitInError(
        409,
        "An overlapping Wise class has an unresolved teacher.",
      );
    if (
      userIds.has(id) ||
      (session.teacherId && userIds.has(session.teacherId))
    )
      throw new SitInError(
        409,
        "The observer has their own class at this time.",
        "HEAD_UNAVAILABLE",
      );
  }
}
export async function verifyLiveLesson(
  assignment: typeof s.tutorSitInAssignments.$inferSelect,
  proposed: Lesson,
  sources: Sources,
  db: Database,
  options: {
    observation?: typeof s.tutorSitInObservations.$inferSelect;
    now?: Date;
    requireAdvance?: boolean;
  } = {},
) {
  const now = options.now || new Date();
  if (options.requireAdvance !== false)
    requireNotice(new Date(proposed.start), now);
  if (!assignment.observerEmail)
    throw new SitInError(409, "Choose an observer first.");
  let observer;
  try {
    observer = await resolveObserver(
      assignment.observerEmail,
      scopeOf(assignment),
      assignment.canonicalKey,
      db,
    );
  } catch (e) {
    if (options.observation && e instanceof SitInError)
      throw new SitInError(409, e.message, "HEAD_UNAVAILABLE");
    throw e;
  }
  if (
    options.observation &&
    observer.canonicalKey !== options.observation.observerCanonicalKey
  )
    throw new SitInError(
      409,
      "The observer identity changed.",
      "HEAD_UNAVAILABLE",
    );
  const accounts = sources.accounts.filter(
    (a) => a.canonicalKey === observer.canonicalKey,
  );
  const userIds = new Set(
    accounts.flatMap((a) =>
      [a.wiseUserId, a.wiseTeacherId].filter((id): id is string => !!id),
    ),
  );
  if (
    !accounts.length ||
    accounts.some(
      (a) =>
        !a.wiseUserId ||
        a.lastSnapshotId !== sources.index.snapshotId ||
        !["active", "invalid_email", "email_conflict"].includes(a.status),
    )
  )
    throw new SitInError(
      409,
      "The observer's Wise accounts need identity review.",
    );
  const client = createWiseClient({
      signal: AbortSignal.timeout(80_000),
      requestsPerSecond: 3,
      maxConcurrency: 3,
    }),
    institute = process.env.WISE_INSTITUTE_ID || "696e1f4d90102225641cc413";
  const start = new Date(proposed.start),
    deadlineAt = Date.now() + 80_000;
  const [sessions, availability, detail] = await Promise.all([
    fetchWiseSessionsForBangkokDates(client, institute, [localDate(start)], {
      now,
      deadlineAt,
    }),
    Promise.all(
      [...new Set(accounts.map((a) => a.wiseUserId!))].map((id) =>
        fetchTeacherAvailability(
          client,
          institute,
          id,
          new Date(start.getTime() - 86400000),
          new Date(start.getTime() + 86400000),
        ),
      ),
    ),
    fetchWiseSessionDetail(client, proposed.classId, proposed.id, {
      deadlineAt,
    }),
  ]).catch((error) => {
    if (error instanceof SitInError) throw error;
    throw new SitInError(
      503,
      "Wise verification is temporarily unavailable. Retry after the next refresh.",
      "SOURCE_UNAVAILABLE",
    );
  });
  const session = sessions.find((s) => s._id === proposed.id);
  if (!session || isCancelled(session.meetingStatus || ""))
    throw new SitInError(
      409,
      "The lesson has been cancelled or is no longer scheduled.",
      "LESSON_CHANGED",
    );
  if (!isUpcoming(session.meetingStatus || ""))
    throw new SitInError(409, "The Wise lesson status needs review.");
  const mapping = sources.mappings.find((m) => m.classId === proposed.classId);
  const scopes = mapping
    ? coverageScopes(mapping)
    : titleScopes(session.title || proposed.title);
  if (!scopes.includes(scopeOf(assignment)))
    throw new SitInError(
      409,
      "The lesson no longer belongs to this department.",
      "LESSON_CHANGED",
    );
  const teacher = getWiseSessionTeacherUserId(session);
  const matching = [
    ...new Set(
      sources.accounts
        .filter(
          (a) =>
            a.wiseUserId === teacher ||
            a.wiseTeacherId === teacher ||
            a.wiseTeacherId === session.teacherId,
        )
        .map((a) => a.canonicalKey),
    ),
  ];
  if (
    matching.length !== 1 ||
    matching[0] !== assignment.canonicalKey ||
    getWiseSessionClassId(session) !== proposed.classId ||
    new Date(session.scheduledStartTime).toISOString() !== proposed.start ||
    new Date(session.scheduledEndTime).toISOString() !== proposed.end
  )
    throw new SitInError(
      409,
      "The lesson's tutor or time changed. Refresh the available lessons.",
      "LESSON_CHANGED",
    );
  if (
    availability.some(
      (a) => !Array.isArray(a.workingHours?.slots) || !Array.isArray(a.leaves),
    )
  )
    throw new SitInError(
      409,
      "Wise availability could not be verified completely.",
    );
  assertLiveHeadFree(
    proposed,
    sessions,
    userIds,
    normalizeWorkingHours(availability.flatMap((a) => a.workingHours!.slots!)),
    availability.flatMap((a) => a.leaves || []),
  );
  const ids = sessionStudentIds(
    Array.isArray(detail.students) ? detail : session,
  );
  if (!ids?.length)
    throw new SitInError(
      409,
      "Wise did not provide a complete student list. Review this lesson before scheduling.",
      "STUDENT_ROSTER",
    );
  const [snapshot] = await db
    .select()
    .from(s.creditControlSnapshots)
    .where(eq(s.creditControlSnapshots.id, sources.snapshotId));
  if (!snapshot)
    throw new SitInError(
      409,
      "Student evidence changed. Refresh and try again.",
    );
  const knownStudents = await db
    .select()
    .from(s.creditControlStudents)
    .where(eq(s.creditControlStudents.snapshotId, sources.snapshotId));
  const mapped = ids.map((id) =>
    knownStudents.find((s) => s.wiseStudentId === id),
  );
  if (
    mapped.some((s) => !s) ||
    mapped.length !== proposed.participants.length ||
    mapped.some(
      (s) => !proposed.participants.some((p) => p.studentKey === s!.studentKey),
    )
  )
    throw new SitInError(
      409,
      "The lesson's students changed. Refresh the source sync before scheduling.",
      "LESSON_CHANGED",
    );
  const location = session.location?.trim() || null;
  const modality = lessonModality(session.type);
  if (!modality)
    throw new SitInError(409, "The lesson's modality needs review.");
  if (
    options.observation &&
    (location !== proposed.location || modality !== proposed.modality)
  )
    throw new SitInError(
      409,
      "The observation's location or modality changed.",
      "LESSON_CHANGED",
    );
  return { observer, lesson: { ...proposed, location, modality } };
}
