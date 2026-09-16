import { and, eq, gte, lt } from "drizzle-orm";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { getDb, type Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { ensureIndex, type SearchIndex } from "@/lib/search/index";
import { executeSearch } from "@/lib/search/engine";
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
import { isBlockingStatus } from "@/lib/normalization/sessions";
import { googleBusy } from "./calendar";
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
  tutorInvitationEmail,
  isCancelled,
  isUpcoming,
  ZONE,
} from "./model";

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
    if (
      lessonMap.has(row.wiseSessionId) ||
      !row.wiseClassId ||
      !isUpcoming(row.wiseStatus)
    )
      continue;
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
      participants: [],
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
export function snapshotAvailable(
  sources: Sources,
  observerKey: string,
  lesson: Lesson,
  reviewReasons?: Set<string>,
) {
  const head = sources.index.tutorGroups.find(
    (g) => g.canonicalKey === observerKey,
  );
  if (
    !head ||
    !head.leavesCompleteThrough ||
    head.leavesCompleteThrough < new Date(lesson.end) ||
    !lesson.modality
  ) {
    reviewReasons?.add(
      "Tutor identity, modality or leave coverage needs review for these dates.",
    );
    return false;
  }
  const date = localDate(new Date(lesson.start));
  if (date !== localDate(new Date(lesson.end))) return false;
  const result = executeSearch(sources.index, {
    searchMode: "one_time",
    slots: [
      {
        id: lesson.id,
        date,
        start: formatInTimeZone(new Date(lesson.start), ZONE, "HH:mm"),
        end: formatInTimeZone(new Date(lesson.end), ZONE, "HH:mm"),
        mode: "either",
      },
    ],
  });
  result.perSlotResults[0]?.needsReview
    .find((t) => t.tutorCanonicalKey === observerKey)
    ?.reasons.forEach((r) => reviewReasons?.add(r));
  return (
    result.perSlotResults[0]?.available.some(
      (t) => t.tutorCanonicalKey === observerKey,
    ) ?? false
  );
}
export type SuggestionCache = Map<string, ReturnType<typeof googleBusy>>;
export async function suggestionsFor(
  assignment: typeof s.tutorSitInAssignments.$inferSelect,
  sources: Sources,
  db: Database,
  now = new Date(),
  cache: SuggestionCache = new Map(),
): Promise<Suggestion[]> {
  if (!assignment.observerEmail)
    throw new SitInError(409, "Assign an eligible observer first.");
  const head = await resolveObserver(
    assignment.observerEmail,
    assignment.department,
    assignment.canonicalKey,
    db,
  );
  const reviewReasons = new Set<string>();
  const eligible = sources.lessons
    .filter(
      (l) =>
        l.tutorKey === assignment.canonicalKey &&
        l.departments.includes(assignment.department as Department) &&
        l.participants.length > 0 &&
        isUpcoming(l.status) &&
        new Date(l.start).getTime() >= now.getTime() + NOTICE_MS &&
        snapshotAvailable(sources, head.canonicalKey, l, reviewReasons),
    )
    .sort((a, b) => a.start.localeCompare(b.start));
  if (!eligible.length) {
    if (reviewReasons.size)
      throw new SitInError(
        409,
        "Needs review: " + [...reviewReasons].slice(0, 3).join(" "),
      );
    if (
      sources.lessons.some(
        (l) =>
          l.tutorKey === assignment.canonicalKey &&
          l.departments.includes(assignment.department as Department) &&
          !l.participants.length,
      )
    )
      throw new SitInError(
        409,
        "Student participants need source-data review before scheduling.",
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
  const key = head.email;
  if (!cache.has(key)) {
    const future = sources.lessons.filter((l) => new Date(l.end) > now);
    const end = new Date(Math.max(...future.map((l) => Date.parse(l.end))));
    cache.set(key, googleBusy(head.email, now, end, db));
  }
  const busy = await cache.get(key)!;
  return eligible
    .filter(
      (l) =>
        !busy.some((b) =>
          overlap({ start: new Date(l.start), end: new Date(l.end) }, b),
        ) &&
        !bookings.some((b) =>
          overlap(
            { start: new Date(l.start), end: new Date(l.end) },
            { start: b.startTime, end: b.endTime },
          ),
        ),
    )
    .map((l) => ({
      sessionId: l.id,
      title: l.title,
      start: l.start,
      end: l.end,
      location: l.location,
      modality: l.modality,
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
      [...a.participants].sort((x, y) =>
        x.studentKey.localeCompare(y.studentKey),
      ),
    ) ===
      JSON.stringify(
        [...b.participants].sort((x, y) =>
          x.studentKey.localeCompare(y.studentKey),
        ),
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
      assignment.department,
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
      (a) => !a.wiseUserId || a.lastSnapshotId !== sources.index.snapshotId,
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
    end = new Date(proposed.end),
    deadlineAt = Date.now() + 80_000;
  const [sessions, availability, detail, busy] = await Promise.all([
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
    googleBusy(
      observer.email,
      start,
      end,
      db,
      options.observation
        ? {
            calendarId: options.observation.calendarId,
            eventId: options.observation.eventId,
          }
        : undefined,
    ),
  ]);
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
  const departments = mapping
    ? mapping.departments
    : titleDepartments(session.title || proposed.title);
  if (!departments.includes(assignment.department))
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
  if (busy.some((b) => overlap({ start, end }, b)))
    throw new SitInError(
      409,
      "The observer is busy in Google Calendar.",
      "HEAD_UNAVAILABLE",
    );
  const participants =
    detail.students ||
    session.students ||
    detail.participants ||
    session.participants;
  if (!Array.isArray(participants) || !participants.length)
    throw new SitInError(
      409,
      "Wise did not provide a complete student list. Review this lesson before scheduling.",
    );
  const ids = [
    ...new Set(participants.map((p) => (typeof p === "string" ? p : p._id))),
  ].sort();
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
  if (
    options.observation &&
    tutorInvitationEmail(
      sources.contacts.find((c) => c.canonicalKey === assignment.canonicalKey),
      modality,
    ) !== proposed.tutorEmail
  )
    throw new SitInError(
      409,
      "The tutor invitation contact changed.",
      "LESSON_CHANGED",
    );
  return { observer, lesson: { ...proposed, location, modality } };
}
