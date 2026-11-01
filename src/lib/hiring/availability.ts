import { eq } from "drizzle-orm";
import { type Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { ensureIndex, type IndexedTutorGroup } from "@/lib/search/index";
import {
  requirementFor,
  type ExceptionVersion,
  type ScheduleVersion,
} from "@/lib/tutor-attendance/model";
import { createWiseClient } from "@/lib/wise/client";
import { fetchWiseSessionsForBangkokDates } from "@/lib/wise/day-sessions";
import { fetchTeacherAvailability } from "@/lib/wise/fetchers";
import { getWiseSessionTeacherUserId } from "@/lib/wise/types";
import { isBlockingStatus } from "@/lib/normalization/sessions";
import {
  businessDates,
  instant,
  localDate,
  overlap,
  HiringError,
  type HiringConfig,
  type InterviewKind,
  type Slot,
  type Subject,
  type VisitSlot,
} from "./model";

const MAX_SOURCE_AGE = 90 * 60 * 1000;
// Saved office hours decide when a head is in. Wise working hours are not used (Kevin's instruction).
export function indexedSlotAvailable(
  group: IndexedTutorGroup,
  date: string,
  start: number,
  end: number,
) {
  const range = { start: instant(date, start), end: instant(date, end) };
  return (
    !!group.leavesCompleteThrough &&
    group.leavesCompleteThrough >= range.end &&
    !group.dataIssues.some((i) => /identity|leave|session/i.test(i.type)) &&
    !group.leaves.some((l) =>
      overlap(range, { start: l.startTime, end: l.endTime }),
    ) &&
    !group.sessionBlocks.some(
      (b) =>
        b.isBlocking && overlap(range, { start: b.startTime, end: b.endTime }),
    )
  );
}

type OfficeContext = {
  schedules: ScheduleVersion[];
  exceptions: ExceptionVersion[];
  enrollments: {
    canonicalKey: string;
    active: boolean;
    startDate: string;
    endDate: string | null;
  }[];
};
const minuteOf = (time: string) =>
  Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/**
 * True when the whole [startMinute, endMinute) range sits inside the head's saved hours on that date.
 * An enrolled head uses the Tutor Attendance schedule version in force on the date (a future version
 * is not applied early). Any other head uses the fallback week in Hiring settings.
 * Closures, excused days and one-day hours follow Tutor Attendance for both.
 */
export function headInOffice(
  head: { canonicalKey: string; fallbackWeek?: ScheduleVersion["week"] },
  date: string,
  startMinute: number,
  endMinute: number,
  ctx: OfficeContext,
): boolean {
  const enrolled = ctx.enrollments.find(
    (e) => e.canonicalKey === head.canonicalKey,
  );
  if (
    enrolled &&
    (!enrolled.active ||
      enrolled.startDate > date ||
      (enrolled.endDate && enrolled.endDate < date))
  )
    return false;
  const schedules = enrolled
    ? ctx.schedules
    : head.fallbackWeek
      ? [
          {
            id: "fallback",
            canonicalKey: head.canonicalKey,
            effectiveFrom: "0000-01-01",
            week: head.fallbackWeek,
            revision: 0,
          },
        ]
      : [];
  const required = requirementFor(
    date,
    head.canonicalKey,
    schedules,
    ctx.exceptions,
  );
  return (
    !!required &&
    "start" in required &&
    minuteOf(required.start) <= startMinute &&
    endMinute <= minuteOf(required.end)
  );
}

/** The head with fewer mocks this week. A tie keeps the earlier entry, so pass heads in settings order. */
export function assignHead(candidates: { key: string; weekMocks: number }[]) {
  return candidates.reduce((best, c) =>
    c.weekMocks < best.weekMocks ? c : best,
  ).key;
}

function assertFreshIndex(index: { syncedAt: Date }, now: Date) {
  if (
    now.getTime() - index.syncedAt.getTime() > MAX_SOURCE_AGE ||
    index.syncedAt.getTime() > now.getTime() + 60_000
  )
    throw new HiringError(
      409,
      "Wise availability is stale. Please try again after the next sync.",
    );
}

const readCalendar = async (db: Database) => {
  const [bookings, observations, schedules, exceptions, enrollments] =
    await Promise.all([
      db
        .select()
        .from(s.hiringBookings)
        .where(eq(s.hiringBookings.status, "confirmed")),
      db
        .select()
        .from(s.tutorSitInObservations)
        .where(eq(s.tutorSitInObservations.current, true)),
      db.select().from(s.tutorAttendanceSchedules),
      db.select().from(s.tutorAttendanceExceptions),
      db.select().from(s.tutorAttendanceEnrollments),
    ]);
  return { bookings, observations, schedules, exceptions, enrollments };
};
// Monday of the Bangkok week that holds the date.
const weekStart = (date: string) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};

export async function availableSlots(
  db: Database,
  config: HiringConfig,
  kind: InterviewKind,
  subjects: Subject[],
  now = new Date(),
): Promise<Slot[]> {
  if (!subjects.length || (kind === "mock" && subjects.length !== 1)) return [];
  const dates = businessDates(now, config.holidays);
  const calendar = await readCalendar(db);
  const { bookings, observations } = calendar;
  const duration = kind === "mock" ? 60 : subjects.length * 120;
  const slots: Slot[] = [];
  const index = kind === "mock" ? await ensureIndex(db) : null;
  if (index) assertFreshIndex(index, now);
  for (const date of dates) {
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    const office = config.paperOfficeHours.find((w) => w.weekday === weekday);
    const begin = kind === "mock" ? 600 : office?.startMinute;
    const finish = kind === "mock" ? 960 : office?.endMinute;
    if (begin === undefined || finish === undefined) continue;
    for (let start = begin; start + duration <= finish; start += 60) {
      if (kind === "paper" && start > office!.lastArrivalMinute) continue;
      const end = start + duration,
        range = { start: instant(date, start), end: instant(date, end) };
      if (range.start <= now) continue;
      if (kind === "paper") {
        if (
          bookings.filter(
            (b) =>
              b.kind === "paper" &&
              overlap(range, { start: b.startTime, end: b.endTime }),
          ).length < config.paperCapacity
        )
          slots.push({
            date,
            start: range.start.toISOString(),
            end: range.end.toISOString(),
            interviewerKey: null,
            subjects,
          });
        continue;
      }
      for (const interviewer of config.interviewers.filter((t) =>
        subjects.every((subject) => t.subjects.includes(subject)),
      )) {
        const group = index!.tutorGroups.find(
          (g) => g.canonicalKey === interviewer.canonicalKey,
        );
        if (!group || !indexedSlotAvailable(group, date, start, end)) continue;
        if (!headInOffice(interviewer, date, start, end, calendar)) continue;
        if (
          bookings.some(
            (b) =>
              b.interviewerKey === interviewer.canonicalKey &&
              overlap(range, { start: b.startTime, end: b.endTime }),
          )
        )
          continue;
        if (
          observations.some(
            (o) =>
              o.observerCanonicalKey === interviewer.canonicalKey &&
              overlap(range, { start: o.startTime, end: o.endTime }),
          )
        )
          continue;
        slots.push({
          date,
          start: range.start.toISOString(),
          end: range.end.toISOString(),
          interviewerKey: interviewer.canonicalKey,
          subjects,
        });
      }
    }
  }
  return slots;
}

/**
 * One-visit times: a 2-hour exam on the hour, then a 1-hour mock with one head. Read-only.
 * The exam needs room (paperCapacity) and blocks no head. The mock hour needs the head to be in saved
 * office hours, free in Wise and on leave, free of sit-ins and hiring bookings, and under the weekly limit.
 * The server picks the head (fewest mocks that week, then settings order). Candidates never choose.
 * Every confirmed mock counts toward the weekly limit, old flow or new, because each one uses the head's hour.
 */
export async function availableVisitSlots(
  db: Database,
  config: HiringConfig,
  subject: Subject,
  now = new Date(),
): Promise<VisitSlot[]> {
  const heads = config.interviewers.filter((h) => h.subjects.includes(subject));
  if (!heads.length) return [];
  const calendar = await readCalendar(db);
  const { bookings, observations } = calendar;
  const index = await ensureIndex(db);
  assertFreshIndex(index, now);
  const mocks = bookings.filter((b) => b.kind === "mock");
  const weekMocks = (key: string, date: string) =>
    mocks.filter(
      (b) =>
        b.interviewerKey === key &&
        weekStart(localDate(b.startTime)) === weekStart(date),
    ).length;
  const slots: VisitSlot[] = [];
  for (const date of businessDates(now, config.holidays))
    for (
      let exam = Math.ceil(config.visitStartMinute / 60) * 60;
      exam + 180 <= config.visitEndMinute;
      exam += 60
    ) {
      const examRange = { start: instant(date, exam), end: instant(date, exam + 120) };
      if (examRange.start <= now) continue;
      if (
        bookings.filter(
          (b) =>
            b.kind === "paper" &&
            overlap(examRange, { start: b.startTime, end: b.endTime }),
        ).length >= config.paperCapacity
      )
        continue;
      const mock = { start: examRange.end, end: instant(date, exam + 180) };
      const free = heads.filter((head) => {
        const group = index.tutorGroups.find(
          (g) => g.canonicalKey === head.canonicalKey,
        );
        return (
          !!group &&
          weekMocks(head.canonicalKey, date) < config.onsiteLimits.perHeadPerWeek &&
          indexedSlotAvailable(group, date, exam + 120, exam + 180) &&
          headInOffice(head, date, exam + 120, exam + 180, calendar) &&
          !bookings.some(
            (b) =>
              b.interviewerKey === head.canonicalKey &&
              overlap(mock, { start: b.startTime, end: b.endTime }),
          ) &&
          !observations.some(
            (o) =>
              o.observerCanonicalKey === head.canonicalKey &&
              overlap(mock, { start: o.startTime, end: o.endTime }),
          )
        );
      });
      if (free.length)
        slots.push({
          date,
          examStart: examRange.start.toISOString(),
          mockStart: mock.start.toISOString(),
          mockEnd: mock.end.toISOString(),
          interviewerKey: assignHead(
            free.map((h) => ({
              key: h.canonicalKey,
              weekMocks: weekMocks(h.canonicalKey, date),
            })),
          ),
          subject,
        });
    }
  return slots;
}

export async function verifyLiveSlot(db: Database, slot: Slot) {
  if (!slot.interviewerKey)
    return { checkedAt: new Date().toISOString(), source: "office-capacity" };
  const index = await ensureIndex(db);
  const group = index.tutorGroups.find(
    (g) => g.canonicalKey === slot.interviewerKey,
  );
  if (!group) throw new HiringError(409, "Interviewer identity needs review.");
  const accounts = await db
    .select()
    .from(s.tutorWiseAccounts)
    .where(eq(s.tutorWiseAccounts.canonicalKey, slot.interviewerKey));
  const linked = group.wiseRecords.map((record) =>
    accounts.find((a) => a.wiseTeacherId === record.wiseTeacherId),
  );
  if (!linked.length || linked.some((a) => !a?.wiseUserId))
    throw new HiringError(409, "Interviewer accounts need review.");
  if (
    linked.some(
      (a) =>
        a!.lastSnapshotId !== index.snapshotId ||
        !["active", "invalid_email", "email_conflict"].includes(a!.status),
    )
  )
    throw new HiringError(
      409,
      "Interviewer accounts changed. Refresh Wise before booking.",
    );
  const client = createWiseClient({
    signal: AbortSignal.timeout(80000),
    maxConcurrency: 3,
    requestsPerSecond: 3,
  });
  const institute = process.env.WISE_INSTITUTE_ID || "696e1f4d90102225641cc413";
  const start = new Date(slot.start),
    end = new Date(slot.end);
  const sessions = await fetchWiseSessionsForBangkokDates(
    client,
    institute,
    [slot.date],
    { deadlineAt: Date.now() + 45_000 },
  );
  for (const session of sessions) {
    const userId = getWiseSessionTeacherUserId(session);
    if (!userId)
      throw new HiringError(
        409,
        "Wise returned a class with an unresolved teacher.",
      );
    if (
      linked.some((a) => a!.wiseUserId === userId) &&
      isBlockingStatus(session.meetingStatus) &&
      overlap(
        { start, end },
        {
          start: new Date(session.scheduledStartTime),
          end: new Date(session.scheduledEndTime),
        },
      )
    )
      throw new HiringError(
        409,
        "The interviewer now has a class. Choose another time.",
      );
  }
  for (const account of linked) {
    const availability = await fetchTeacherAvailability(
      client,
      institute,
      account!.wiseUserId!,
      instant(slot.date, 0),
      instant(slot.date, 1439),
    );
    if (!Array.isArray(availability.leaves))
      throw new HiringError(409, "Wise did not return complete availability.");
    for (const leave of availability.leaves) {
      const leaveStart = new Date(leave.startTime),
        leaveEnd = new Date(leave.endTime);
      if (
        !Number.isFinite(leaveStart.getTime()) ||
        !Number.isFinite(leaveEnd.getTime()) ||
        leaveEnd <= leaveStart
      )
        throw new HiringError(409, "Wise leave data needs review.");
      if (overlap({ start, end }, { start: leaveStart, end: leaveEnd }))
        throw new HiringError(
          409,
          "The interviewer is on leave. Choose another time.",
        );
    }
  }
  return {
    checkedAt: new Date().toISOString(),
    source: "wise-live",
    snapshotId: index.snapshotId,
  };
}
