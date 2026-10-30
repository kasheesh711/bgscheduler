import { eq } from "drizzle-orm";
import { type Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { ensureIndex, type IndexedTutorGroup } from "@/lib/search/index";
import { requirementFor } from "@/lib/tutor-attendance/model";
import { createWiseClient } from "@/lib/wise/client";
import { fetchWiseSessionsForBangkokDates } from "@/lib/wise/day-sessions";
import { fetchTeacherAvailability } from "@/lib/wise/fetchers";
import { getWiseSessionTeacherUserId } from "@/lib/wise/types";
import { isBlockingStatus } from "@/lib/normalization/sessions";
import { normalizeWorkingHours } from "@/lib/normalization/availability";
import {
  businessDates,
  instant,
  overlap,
  HiringError,
  type HiringConfig,
  type InterviewKind,
  type Slot,
  type Subject,
} from "./model";

const MAX_SOURCE_AGE = 90 * 60 * 1000;
const covers = (
  windows: { weekday: number; startMinute: number; endMinute: number }[],
  date: string,
  start: number,
  end: number,
) =>
  windows.some(
    (w) =>
      w.weekday === new Date(`${date}T12:00:00Z`).getUTCDay() &&
      w.startMinute <= start &&
      w.endMinute >= end,
  );
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
    !group.dataIssues.some((i) =>
      /identity|availability|leave|session|modality/i.test(i.type),
    ) &&
    covers(
      group.availabilityWindows.filter(
        (w) => w.modality.toUpperCase() === "OFFLINE",
      ),
      date,
      start,
      end,
    ) &&
    !group.leaves.some((l) =>
      overlap(range, { start: l.startTime, end: l.endTime }),
    ) &&
    !group.sessionBlocks.some(
      (b) =>
        b.isBlocking && overlap(range, { start: b.startTime, end: b.endTime }),
    )
  );
}

export async function availableSlots(
  db: Database,
  config: HiringConfig,
  kind: InterviewKind,
  subjects: Subject[],
  now = new Date(),
): Promise<Slot[]> {
  if (!subjects.length || (kind === "mock" && subjects.length !== 1)) return [];
  const dates = businessDates(now, config.holidays);
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
  const duration = kind === "mock" ? 60 : subjects.length * 120;
  const slots: Slot[] = [];
  const index = kind === "mock" ? await ensureIndex(db) : null;
  if (
    index &&
    (now.getTime() - index.syncedAt.getTime() > MAX_SOURCE_AGE ||
      index.syncedAt.getTime() > now.getTime() + 60_000)
  )
    throw new HiringError(
      409,
      "Wise availability is stale. Please try again after the next sync.",
    );
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
        const enrolled = enrollments.find(
          (e) => e.canonicalKey === interviewer.canonicalKey,
        );
        if (enrolled) {
          if (
            !enrolled.active ||
            enrolled.startDate > date ||
            (enrolled.endDate && enrolled.endDate < date)
          )
            continue;
          const required = requirementFor(
            date,
            interviewer.canonicalKey,
            schedules,
            exceptions,
          );
          if (
            !required ||
            !("start" in required) ||
            instant(date, start) <
              new Date(`${date}T${required.start}:00+07:00`) ||
            instant(date, end) > new Date(`${date}T${required.end}:00+07:00`)
          )
            continue;
        } else if (
          exceptions.some(
            (e) =>
              e.date === date &&
              (e.canonicalKey === null ||
                e.canonicalKey === interviewer.canonicalKey) &&
              e.kind === "excused",
          )
        )
          continue;
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
  let onsite = false;
  for (const account of linked) {
    const availability = await fetchTeacherAvailability(
      client,
      institute,
      account!.wiseUserId!,
      instant(slot.date, 0),
      instant(slot.date, 1439),
    );
    if (
      !Array.isArray(availability.leaves) ||
      !Array.isArray(availability.workingHours?.slots)
    )
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
    const startMinute = Number(formatMinute(start)),
      endMinute = Number(formatMinute(end));
    if (
      !account!.isOnlineVariant &&
      covers(
        normalizeWorkingHours(availability.workingHours.slots),
        slot.date,
        startMinute,
        endMinute,
      )
    )
      onsite = true;
  }
  if (!onsite)
    throw new HiringError(
      409,
      "Wise no longer confirms onsite availability. Choose another time.",
    );
  return {
    checkedAt: new Date().toISOString(),
    source: "wise-live",
    snapshotId: index.snapshotId,
  };
}
function formatMinute(date: Date) {
  return ((date.getUTCHours() + 7) % 24) * 60 + date.getUTCMinutes();
}
