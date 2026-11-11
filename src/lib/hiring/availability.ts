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
  weekStart,
  HiringError,
  type HiringConfig,
  type InterviewKind,
  type Slot,
  type Subject,
  type VisitSlot,
} from "./model";

const MAX_SOURCE_AGE = 90 * 60 * 1000;
// Real data_issue_type values are alias, modality, tag, completeness, conflict_model and sync.
// Block on alias (identity) and on every completeness issue except the sync's availability message
// (orchestrator.ts: `Failed to fetch availability for teacher "…"`). Wise hours are not used, and a failed
// near fetch also collapses leavesCompleteThrough, so leave stays fail-closed through that watermark.
// An unknown completeness message blocks.
const AVAILABILITY_ISSUE = /^Failed to fetch availability for teacher "/;
export const blocksHead = (issues: { type: string; message: string }[]) =>
  issues.some(
    (i) =>
      i.type === "alias" ||
      (i.type === "completeness" && !AVAILABILITY_ISSUE.test(i.message)),
  );

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
    !blocksHead(group.dataIssues) &&
    !group.leaves.some((l) =>
      overlap(range, { start: l.startTime, end: l.endTime }),
    ) &&
    !group.sessionBlocks.some(
      (b) =>
        b.isBlocking && overlap(range, { start: b.startTime, end: b.endTime }),
    )
  );
}

export type OfficeContext = {
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
 * The head's saved hours on that date, or null when the head is out. An enrolled head uses the Tutor
 * Attendance schedule version in force on the date (a future version is not applied early). Any other head
 * uses the fallback week in Hiring settings. Closures, excused days and one-day hours follow Tutor
 * Attendance for both.
 */
export function headOfficeWindow(
  head: { canonicalKey: string; fallbackWeek?: ScheduleVersion["week"] },
  date: string,
  ctx: OfficeContext,
): { start: string; end: string } | null {
  const enrolled = ctx.enrollments.find(
    (e) => e.canonicalKey === head.canonicalKey,
  );
  if (
    enrolled &&
    (!enrolled.active ||
      enrolled.startDate > date ||
      (enrolled.endDate && enrolled.endDate < date))
  )
    return null;
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
  return required && "start" in required
    ? { start: required.start, end: required.end }
    : null;
}

/** True when the whole [startMinute, endMinute) range sits inside the head's saved hours on that date. */
export function headInOffice(
  head: { canonicalKey: string; fallbackWeek?: ScheduleVersion["week"] },
  date: string,
  startMinute: number,
  endMinute: number,
  ctx: OfficeContext,
): boolean {
  const window = headOfficeWindow(head, date, ctx);
  return (
    !!window &&
    minuteOf(window.start) <= startMinute &&
    endMinute <= minuteOf(window.end)
  );
}

/** The head with fewer mocks this week. A tie keeps the earlier entry, so pass heads in settings order. */
export function assignHead(candidates: { key: string; weekMocks: number }[]) {
  return candidates.reduce((best, c) =>
    c.weekMocks < best.weekMocks ? c : best,
  ).key;
}

/** True when the index is older than the Wise freshness limit, or comes from the future. */
export const indexIsStale = (index: { syncedAt: Date }, now: Date) =>
  now.getTime() - index.syncedAt.getTime() > MAX_SOURCE_AGE ||
  index.syncedAt.getTime() > now.getTime() + 60_000;
function assertFreshIndex(index: { syncedAt: Date }, now: Date) {
  if (indexIsStale(index, now))
    throw new HiringError(
      409,
      "Wise availability is stale. Please try again after the next sync.",
    );
}

// One at a time: `db` can be a transaction on one connection, and pg@9 refuses overlapping queries on a connection.
export const readCalendar = async (db: Database) => {
  const bookings = await db
    .select()
    .from(s.hiringBookings)
    .where(eq(s.hiringBookings.status, "confirmed"));
  const observations = await db
    .select()
    .from(s.tutorSitInObservations)
    .where(eq(s.tutorSitInObservations.current, true));
  const schedules = await db.select().from(s.tutorAttendanceSchedules);
  const exceptions = await db.select().from(s.tutorAttendanceExceptions);
  const enrollments = await db.select().from(s.tutorAttendanceEnrollments);
  return { bookings, observations, schedules, exceptions, enrollments };
};

export async function availableSlots(
  db: Database,
  config: HiringConfig,
  kind: InterviewKind,
  subjects: Subject[],
  now = new Date(),
  // ensureIndex reads in parallel, so a caller inside a transaction passes its outer connection here.
  indexDb: Database = db,
  live?: LiveBusy,
): Promise<Slot[]> {
  if (!subjects.length || (kind === "mock" && subjects.length !== 1)) return [];
  const dates = businessDates(now, config.holidays);
  const calendar = await readCalendar(db);
  const { bookings, observations } = calendar;
  const duration = kind === "mock" ? 60 : subjects.length * 120;
  const slots: Slot[] = [];
  const index = kind === "mock" ? await ensureIndex(indexDb) : null;
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
        if (!liveFree(live, interviewer.canonicalKey, range)) continue;
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
 * `movingCandidate`'s own rows are left out: a move gives them up, so they must not block its new time.
 */
export async function availableVisitSlots(
  db: Database,
  config: HiringConfig,
  subject: Subject,
  now = new Date(),
  movingCandidate?: string,
  // ensureIndex reads in parallel, so a caller inside a transaction passes its outer connection here.
  indexDb: Database = db,
  live?: LiveBusy,
): Promise<VisitSlot[]> {
  const heads = config.interviewers.filter((h) => h.subjects.includes(subject));
  if (!heads.length) return [];
  const calendar = await readCalendar(db);
  const { observations } = calendar;
  const bookings = calendar.bookings.filter((b) => !movingCandidate || b.candidateId !== movingCandidate);
  const index = await ensureIndex(indexDb);
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
          liveFree(live, head.canonicalKey, mock) &&
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

type Range = { start: Date; end: Date };
/** Per head: the live Wise classes and leaves on the dates read, or the reason the head cannot be checked. */
export type LiveBusy = {
  checkedAt: string;
  snapshotId: string;
  heads: Map<string, { classes: Range[]; leaves: Range[] } | { error: string }>;
};
const liveCache = ((globalThis as { __bgscheduler_hiringLiveBusy?: Map<string, { at: number; read: Promise<LiveBusy> }> })
  .__bgscheduler_hiringLiveBusy ??= new Map());
const WISE_WINDOW_DAYS = 6; // Wise refuses an availability window longer than 7 days.

/**
 * One live Wise read for several heads and dates: every class of the institute on those dates, and each
 * head account's leaves. Fail-closed: a class with no teacher, or bad leave data, fails the whole read.
 * A head whose accounts need review gets an `error` and is never offered.
 */
export async function readLiveBusy(
  db: Database,
  headKeys: string[],
  dates: string[],
  // shortcut: per-instance cache for page reads only (cacheMs > 0); the confirm check never uses it.
  { cacheMs = 0, deadlineMs = 45_000 }: { cacheMs?: number; deadlineMs?: number } = {},
): Promise<LiveBusy> {
  const key = `${[...headKeys].sort().join("|")}@${[...dates].sort().join("|")}`;
  const hit = liveCache.get(key);
  if (cacheMs && hit && Date.now() - hit.at < cacheMs) return hit.read;
  const read = readLive(db, headKeys, [...dates].sort(), deadlineMs);
  if (cacheMs) {
    liveCache.set(key, { at: Date.now(), read });
    read.catch(() => liveCache.delete(key));
  }
  return read;
}

async function readLive(db: Database, headKeys: string[], dates: string[], deadlineMs: number): Promise<LiveBusy> {
  const index = await ensureIndex(db);
  const heads: LiveBusy["heads"] = new Map();
  const ids = new Map<string, string>(); // Wise user or teacher id -> head
  const users: { key: string; wiseUserId: string }[] = [];
  for (const key of headKeys) {
    const group = index.tutorGroups.find((g) => g.canonicalKey === key);
    if (!group) {
      heads.set(key, { error: "Interviewer identity needs review." });
      continue;
    }
    const accounts = await db.select().from(s.tutorWiseAccounts).where(eq(s.tutorWiseAccounts.canonicalKey, key));
    const linked = group.wiseRecords.map((record) => accounts.find((a) => a.wiseTeacherId === record.wiseTeacherId));
    if (!linked.length || linked.some((a) => !a?.wiseUserId)) {
      heads.set(key, { error: "Interviewer accounts need review." });
      continue;
    }
    if (
      linked.some(
        (a) => a!.lastSnapshotId !== index.snapshotId || !["active", "invalid_email", "email_conflict"].includes(a!.status),
      )
    ) {
      heads.set(key, { error: "Interviewer accounts changed. Refresh Wise before booking." });
      continue;
    }
    heads.set(key, { classes: [], leaves: [] });
    for (const a of linked) {
      ids.set(a!.wiseUserId!, key);
      ids.set(a!.wiseTeacherId, key);
      users.push({ key, wiseUserId: a!.wiseUserId! });
    }
  }
  const busy = (key: string) => heads.get(key) as { classes: Range[]; leaves: Range[] };
  if (users.length && dates.length) {
    const client = createWiseClient({
      signal: AbortSignal.timeout(deadlineMs + 35_000),
      maxConcurrency: 3,
      requestsPerSecond: 3,
    });
    const institute = process.env.WISE_INSTITUTE_ID || "696e1f4d90102225641cc413";
    const deadlineAt = Date.now() + deadlineMs;
    const windows: [string, string][] = [];
    for (const date of dates) {
      const last = windows.at(-1);
      if (last && Date.parse(date) - Date.parse(last[0]) < WISE_WINDOW_DAYS * 86_400_000) last[1] = date;
      else windows.push([date, date]);
    }
    const [days, leaves] = await Promise.all([
      Promise.all(dates.map((date) => fetchWiseSessionsForBangkokDates(client, institute, [date], { deadlineAt }))),
      Promise.all(
        users.flatMap((user) =>
          windows.map(async ([from, to]) => ({
            user,
            availability: await fetchTeacherAvailability(client, institute, user.wiseUserId, instant(from, 0), instant(to, 1439)),
          })),
        ),
      ),
    ]);
    for (const session of days.flat()) {
      const userId = getWiseSessionTeacherUserId(session);
      if (!userId) throw new HiringError(409, "Wise returned a class with an unresolved teacher.");
      // Wise names the teacher by user id or by teacher id, so both match (as the sit-in check does).
      const key = ids.get(userId) ?? (session.teacherId ? ids.get(session.teacherId) : undefined);
      if (key && isBlockingStatus(session.meetingStatus))
        busy(key).classes.push({ start: new Date(session.scheduledStartTime), end: new Date(session.scheduledEndTime) });
    }
    for (const { user, availability } of leaves) {
      if (!Array.isArray(availability.leaves)) throw new HiringError(409, "Wise did not return complete availability.");
      for (const leave of availability.leaves) {
        const start = new Date(leave.startTime),
          end = new Date(leave.endTime);
        if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start)
          throw new HiringError(409, "Wise leave data needs review.");
        busy(user.key).leaves.push({ start, end });
      }
    }
  }
  return { checkedAt: new Date().toISOString(), snapshotId: index.snapshotId, heads };
}

/** With a live read, a head is free only when that read shows no class and no leave in the range. */
const liveFree = (live: LiveBusy | undefined, key: string, range: Range) => {
  if (!live) return true;
  const head = live.heads.get(key);
  return !!head && !("error" in head) && ![...head.classes, ...head.leaves].some((b) => overlap(range, b));
};

/** The confirm check: one fresh, uncached Wise read for this head and day. */
export async function verifyLiveSlot(db: Database, slot: Slot) {
  if (!slot.interviewerKey)
    return { checkedAt: new Date().toISOString(), source: "office-capacity" };
  // A refusal here must not be followed by a cached list that still shows the same time.
  liveCache.clear();
  const live = await readLiveBusy(db, [slot.interviewerKey], [slot.date]);
  const head = live.heads.get(slot.interviewerKey)!;
  if ("error" in head) throw new HiringError(409, head.error);
  const range = { start: new Date(slot.start), end: new Date(slot.end) };
  if (head.classes.some((b) => overlap(range, b)))
    throw new HiringError(409, "The interviewer now has a class. Choose another time.");
  if (head.leaves.some((b) => overlap(range, b)))
    throw new HiringError(409, "The interviewer is on leave. Choose another time.");
  return { checkedAt: live.checkedAt, source: "wise-live", snapshotId: live.snapshotId };
}
