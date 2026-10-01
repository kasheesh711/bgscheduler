import { and, count, eq, gt, gte, inArray, isNotNull, isNull, like, lt, max, min, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { bangkokDateKey } from "@/lib/room-capacity/dates";
import { HISTORY_START } from "./calibration";
import type { FeedTimestamps, LastTaughtBySource, OffboardingAccount, OffboardingSignals, PersonSignals } from "./types";

// ----------------------------------------------------------------------------
// Tutor Offboarding signals (spec §4.2): everything the score needs, read from
// Postgres only — never from Wise on the request path.
// ----------------------------------------------------------------------------

interface TaughtDayRow {
  canonicalKey: string | null;
  day: string;
  last: Date | null;
}

const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);
const later = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : a > b ? a : b);
const earlier = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : a < b ? a : b);

/** The Bangkok calendar day of a timestamp column, as YYYY-MM-DD. */
function bangkokDay(column: AnyColumn): SQL<string> {
  return sql<string>`to_char((${column} at time zone 'Asia/Bangkok')::date, 'YYYY-MM-DD')`;
}

/** Taught days per person from the three history sources; a session counts only when it really happened (spec §4.3). */
async function loadTaughtDays(db: Database, now: Date) {
  const ledger = schema.progressTestAttendanceLedger;
  const blocks = schema.pastSessionBlocks;
  const postClass = schema.postClassSessions;
  const ledgerDay = bangkokDay(ledger.scheduledStartTime);
  const blockDay = bangkokDay(blocks.startTime);
  const postClassDay = bangkokDay(postClass.scheduledStartAt);
  const [fromLedger, fromBlocks, fromPostClass] = await Promise.all([
    db.select({ canonicalKey: ledger.tutorCanonicalKey, day: ledgerDay, last: max(ledger.scheduledStartTime) })
      .from(ledger)
      .where(and(isNotNull(ledger.tutorCanonicalKey), eq(ledger.meetingStatus, "ENDED"),
        gte(ledger.scheduledStartTime, HISTORY_START), lt(ledger.scheduledStartTime, now)))
      .groupBy(ledger.tutorCanonicalKey, ledgerDay),
    db.select({ canonicalKey: blocks.groupCanonicalKey, day: blockDay, last: max(blocks.startTime) })
      .from(blocks)
      .where(and(eq(blocks.isBlocking, true), gte(blocks.startTime, HISTORY_START), lt(blocks.startTime, now)))
      .groupBy(blocks.groupCanonicalKey, blockDay),
    db.select({ canonicalKey: postClass.canonicalTutorKey, day: postClassDay, last: max(postClass.scheduledStartAt) })
      .from(postClass)
      .where(and(isNotNull(postClass.canonicalTutorKey), eq(postClass.finalStatus, "ENDED"),
        gte(postClass.scheduledStartAt, HISTORY_START), lt(postClass.scheduledStartAt, now)))
      .groupBy(postClass.canonicalTutorKey, postClassDay),
  ]);
  return { fromLedger, fromBlocks, fromPostClass };
}

/** People on the active snapshot with every signal, plus every tutor's taught dates. Null without an active snapshot. */
export async function loadOffboardingSignals(db: Database = getDb(), now: Date = new Date()): Promise<OffboardingSignals | null> {
  const [snapshot] = await db.select({ id: schema.snapshots.id, createdAt: schema.snapshots.createdAt })
    .from(schema.snapshots).where(eq(schema.snapshots.active, true)).limit(1);
  if (!snapshot) return null;

  const groups = schema.tutorIdentityGroups;
  const members = schema.tutorIdentityGroupMembers;
  const accounts = schema.tutorWiseAccounts;
  const memberRows = await db.select({
    groupId: groups.id,
    canonicalKey: groups.canonicalKey,
    groupDisplayName: groups.displayName,
    wiseTeacherId: members.wiseTeacherId,
    wiseUserId: members.wiseUserId,
    displayName: members.wiseDisplayName,
    isOnlineVariant: members.isOnlineVariant,
    email: accounts.email,
    status: accounts.status,
    relation: accounts.wiseRelation,
    joinedOn: accounts.wiseJoinedOn,
    courseCount: accounts.wiseCourseCount,
    activated: accounts.wiseActivated,
  }).from(members)
    .innerJoin(groups, eq(groups.id, members.groupId))
    .leftJoin(accounts, eq(accounts.wiseTeacherId, members.wiseTeacherId))
    .where(eq(groups.snapshotId, snapshot.id));

  const userIds = [...new Set(memberRows.map((row) => row.wiseUserId).filter((id): id is string => Boolean(id)))];
  const todayKey = bangkokDateKey(now);
  const blocks = schema.futureSessionBlocks;
  const windows = schema.recurringAvailabilityWindows;
  const leaves = schema.datedLeaves;
  const requests = schema.leaveRequests;
  const events = schema.wiseActivityEvents;
  const [upcoming, windowCounts, availabilityIssues, wiseLeaves, leaveRequests, actions, fullTime, taught] = await Promise.all([
    db.select({ groupId: blocks.groupId, sessions: count(), next: min(blocks.startTime) })
      .from(blocks)
      .where(and(eq(blocks.snapshotId, snapshot.id), eq(blocks.isBlocking, true), gt(blocks.startTime, now)))
      .groupBy(blocks.groupId),
    db.select({ wiseTeacherId: windows.wiseTeacherId, windows: count() })
      .from(windows).where(eq(windows.snapshotId, snapshot.id)).groupBy(windows.wiseTeacherId),
    db.selectDistinct({ wiseTeacherId: schema.dataIssues.entityId })
      .from(schema.dataIssues)
      .where(and(eq(schema.dataIssues.snapshotId, snapshot.id), like(schema.dataIssues.message, "Failed to fetch availability%"))),
    db.select({ groupId: leaves.groupId, until: max(leaves.endTime) })
      .from(leaves).where(and(eq(leaves.snapshotId, snapshot.id), gt(leaves.endTime, now))).groupBy(leaves.groupId),
    db.select({ canonicalKey: requests.tutorCanonicalKey, endTime: max(requests.leaveEndTime), endDate: max(requests.endDate) })
      .from(requests)
      .where(and(isNotNull(requests.tutorCanonicalKey), or(gt(requests.leaveEndTime, now),
        and(isNull(requests.leaveEndTime), gte(requests.endDate, todayKey)))))
      .groupBy(requests.tutorCanonicalKey),
    userIds.length === 0
      ? Promise.resolve([] as Array<{ userId: string | null; role: string | null; last: Date | null }>)
      : db.select({ userId: events.actorWiseUserId, role: events.actorRole, last: max(events.eventTimestamp) })
        .from(events)
        .where(and(inArray(events.actorWiseUserId, userIds), inArray(events.actorRole, ["TEACHER", "ADMIN", "OWNER"])))
        .groupBy(events.actorWiseUserId, events.actorRole),
    db.select({ canonicalKey: schema.tutorAttendanceEnrollments.canonicalKey })
      .from(schema.tutorAttendanceEnrollments).where(eq(schema.tutorAttendanceEnrollments.active, true)),
    loadTaughtDays(db, now),
  ]);

  const upcomingByGroup = new Map(upcoming.map((row) => [row.groupId, row]));
  const windowsByTeacher = new Map(windowCounts.map((row) => [row.wiseTeacherId, row.windows]));
  // OFF-02: a failed availability fetch makes working hours unknown, not zero.
  const failedAvailability = new Set(availabilityIssues.map((row) => row.wiseTeacherId).filter((id): id is string => Boolean(id)));
  const wiseLeaveByGroup = new Map(wiseLeaves.map((row) => [row.groupId, iso(row.until)]));
  const leaveRequestByKey = new Map(leaveRequests.filter((row) => row.canonicalKey).map((row) => [
    row.canonicalKey as string,
    later(iso(row.endTime), row.endDate ? new Date(`${row.endDate}T23:59:59+07:00`).toISOString() : null),
  ]));
  const fullTimeKeys = new Set(fullTime.map((row) => row.canonicalKey));
  const teacherActionByUser = new Map<string, string>();
  const adminActionByUser = new Map<string, string>();
  for (const row of actions) {
    if (!row.userId || !row.last) continue;
    const target = row.role === "TEACHER" ? teacherActionByUser : adminActionByUser;
    target.set(row.userId, later(target.get(row.userId) ?? null, row.last.toISOString())!);
  }

  const taughtDates = new Map<string, Set<string>>();
  const lastBySource = new Map<string, LastTaughtBySource>();
  const addDays = (rows: TaughtDayRow[], source: keyof LastTaughtBySource) => {
    for (const row of rows) {
      if (!row.canonicalKey) continue;
      const days = taughtDates.get(row.canonicalKey) ?? new Set<string>();
      days.add(row.day);
      taughtDates.set(row.canonicalKey, days);
      const bySource = lastBySource.get(row.canonicalKey) ?? { ledger: null, pastBlocks: null, postClass: null };
      bySource[source] = later(bySource[source], iso(row.last));
      lastBySource.set(row.canonicalKey, bySource);
    }
  };
  addDays(taught.fromLedger, "ledger");
  addDays(taught.fromBlocks, "pastBlocks");
  addDays(taught.fromPostClass, "postClass");

  const byKey = new Map<string, { displayName: string; groupIds: Set<string>; rows: typeof memberRows }>();
  for (const row of memberRows) {
    const entry = byKey.get(row.canonicalKey) ?? { displayName: row.groupDisplayName, groupIds: new Set<string>(), rows: [] };
    entry.groupIds.add(row.groupId);
    entry.rows.push(row);
    byKey.set(row.canonicalKey, entry);
  }

  const people: PersonSignals[] = [...byKey.entries()].map(([canonicalKey, entry]) => {
    const personAccounts: OffboardingAccount[] = entry.rows.map((row) => ({
      wiseTeacherId: row.wiseTeacherId,
      wiseUserId: row.wiseUserId,
      displayName: row.displayName,
      isOnlineVariant: row.isOnlineVariant,
      email: row.email ?? null,
      status: row.status ?? null,
      relation: row.relation ?? null,
      joinedOn: iso(row.joinedOn),
      courseCount: row.courseCount ?? null,
      activated: row.activated ?? null,
      availabilityKnown: !failedAvailability.has(row.wiseTeacherId),
      workingHourWindows: windowsByTeacher.get(row.wiseTeacherId) ?? 0,
    })).sort((a, b) => Number(a.isOnlineVariant) - Number(b.isOnlineVariant) || a.displayName.localeCompare(b.displayName));
    const groupIds = [...entry.groupIds];
    const upcomingRows = groupIds.flatMap((id) => upcomingByGroup.get(id) ?? []);
    const bySource = lastBySource.get(canonicalKey) ?? { ledger: null, pastBlocks: null, postClass: null };
    const ids = personAccounts.map((account) => account.wiseUserId).filter((id): id is string => Boolean(id));
    return {
      canonicalKey,
      displayName: entry.displayName,
      accounts: personAccounts,
      lastTaughtAt: later(later(bySource.ledger, bySource.pastBlocks), bySource.postClass),
      lastTaughtBySource: bySource,
      upcomingSessions: upcomingRows.reduce((total, row) => total + row.sessions, 0),
      nextSessionAt: upcomingRows.reduce<string | null>((next, row) => earlier(next, iso(row.next)), null),
      upcomingLeaveUntil: later(groupIds.reduce<string | null>((until, id) => later(until, wiseLeaveByGroup.get(id) ?? null), null),
        leaveRequestByKey.get(canonicalKey) ?? null),
      lastTeacherActionAt: ids.reduce<string | null>((last, id) => later(last, teacherActionByUser.get(id) ?? null), null),
      lastAdminActionAt: ids.reduce<string | null>((last, id) => later(last, adminActionByUser.get(id) ?? null), null),
      fullTime: fullTimeKeys.has(canonicalKey),
    };
  }).sort((a, b) => a.displayName.localeCompare(b.displayName));

  return {
    snapshotId: snapshot.id,
    snapshotCreatedAt: snapshot.createdAt.toISOString(),
    generatedAt: now.toISOString(),
    people,
    taughtDates: Object.fromEntries([...taughtDates.entries()].map(([key, days]) => [key, [...days].sort()])),
  };
}

/**
 * OFF-07 inputs. The tutor snapshot is judged by its own age: promoted runs are recorded `failed` whenever contact
 * warnings exist, so `sync_runs` has no recent `success` row. The other feeds use their last successful run.
 */
export async function loadFeedTimestamps(db: Database = getDb()): Promise<FeedTimestamps> {
  const [[snapshot], [progressTests], [postClass], [wiseActivity], [leaveRequests]] = await Promise.all([
    db.select({ at: schema.snapshots.createdAt }).from(schema.snapshots).where(eq(schema.snapshots.active, true)).limit(1),
    db.select({ at: max(schema.progressTestSyncRuns.finishedAt) }).from(schema.progressTestSyncRuns)
      .where(eq(schema.progressTestSyncRuns.status, "success")),
    db.select({ at: max(schema.postClassSyncRuns.finishedAt) }).from(schema.postClassSyncRuns)
      .where(eq(schema.postClassSyncRuns.status, "success")),
    db.select({ at: max(schema.wiseActivitySyncRuns.finishedAt) }).from(schema.wiseActivitySyncRuns)
      .where(eq(schema.wiseActivitySyncRuns.status, "success")),
    db.select({ at: max(schema.leaveRequestSyncRuns.finishedAt) }).from(schema.leaveRequestSyncRuns)
      .where(eq(schema.leaveRequestSyncRuns.status, "success")),
  ]);
  return {
    tutorSnapshot: iso(snapshot?.at),
    progressTests: iso(progressTests?.at),
    postClass: iso(postClass?.at),
    wiseActivity: iso(wiseActivity?.at),
    leaveRequests: iso(leaveRequests?.at),
  };
}
