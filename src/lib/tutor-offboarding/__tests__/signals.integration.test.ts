import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, stopTestDb, truncateAll } from "@/tests/integration/db-helper";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { loadFeedTimestamps, loadOffboardingSignals } from "../signals";

let handle: Awaited<ReturnType<typeof startTestDb>>;
let db: Database;
const NOW = new Date("2026-10-01T05:00:00.000Z");

beforeAll(async () => { handle = await startTestDb(); db = handle.db as unknown as Database; });
afterAll(async () => { if (handle) await stopTestDb(handle); });
beforeEach(async () => { await truncateAll(handle.db); });

const HOUR = 3_600_000;

function futureBlock(snapshotId: string, groupId: string, wiseTeacherId: string, wiseSessionId: string, start: string, isBlocking: boolean) {
  const startTime = new Date(start);
  return { snapshotId, groupId, wiseTeacherId, wiseSessionId, startTime, endTime: new Date(startTime.getTime() + HOUR),
    weekday: 1, startMinute: 600, endMinute: 660, wiseStatus: isBlocking ? "UPCOMING" : "CANCELLED", isBlocking };
}

function pastBlock(groupCanonicalKey: string, wiseTeacherId: string, wiseSessionId: string, start: string, isBlocking: boolean) {
  const startTime = new Date(start);
  return { groupCanonicalKey, wiseTeacherId, wiseSessionId, startTime, endTime: new Date(startTime.getTime() + HOUR),
    weekday: 1, startMinute: 600, endMinute: 660, wiseStatus: isBlocking ? "UPCOMING" : "CANCELLED", isBlocking };
}

function ledgerRow(wiseSessionId: string, tutorCanonicalKey: string, start: string, meetingStatus: string) {
  return { enrollmentKey: "enr-1", wiseSessionId, wiseClassId: "c1", wiseStudentId: "st1", studentKey: "st1", studentName: "Student One",
    scheduledStartTime: new Date(start), meetingStatus, tutorCanonicalKey };
}

function postClassRow(wiseSessionId: string, start: string, finalStatus: string) {
  const startAt = new Date(start);
  return { wiseSessionId, wiseClassId: "c1", canonicalTutorKey: "Aria", scheduledStartAt: startAt,
    scheduledEndAt: new Date(startAt.getTime() + HOUR), deadlineAt: new Date(startAt.getTime() + 25 * HOUR), finalStatus };
}

async function seed() {
  const [old] = await handle.db.insert(schema.snapshots).values({ active: false, createdAt: new Date("2026-09-30T00:00:00Z") }).returning();
  const [snapshot] = await handle.db.insert(schema.snapshots).values({ active: true, createdAt: new Date("2026-10-01T04:30:00Z") }).returning();
  const [aria, bodhi, cleo] = await handle.db.insert(schema.tutorIdentityGroups).values([
    { snapshotId: snapshot.id, canonicalKey: "Aria", displayName: "Aria" },
    { snapshotId: snapshot.id, canonicalKey: "Bodhi", displayName: "Bodhi" },
    { snapshotId: snapshot.id, canonicalKey: "Cleo", displayName: "Cleo" },
  ]).returning();
  const [stale] = await handle.db.insert(schema.tutorIdentityGroups).values({ snapshotId: old.id, canonicalKey: "Stale", displayName: "Stale" }).returning();
  await handle.db.insert(schema.tutorIdentityGroupMembers).values([
    { snapshotId: snapshot.id, groupId: aria.id, wiseTeacherId: "t-aria-on", wiseUserId: "u-aria-on", wiseDisplayName: "Aria (Aria) Online", isOnlineVariant: true },
    { snapshotId: snapshot.id, groupId: aria.id, wiseTeacherId: "t-aria-off", wiseUserId: "u-aria-off", wiseDisplayName: "Aria (Aria)", isOnlineVariant: false },
    { snapshotId: snapshot.id, groupId: bodhi.id, wiseTeacherId: "t-bodhi", wiseUserId: "u-bodhi", wiseDisplayName: "Bodhi (Bodhi)", isOnlineVariant: false },
    { snapshotId: snapshot.id, groupId: cleo.id, wiseTeacherId: "t-cleo", wiseUserId: "u-cleo", wiseDisplayName: "Cleo (Cleo)", isOnlineVariant: false },
    { snapshotId: old.id, groupId: stale.id, wiseTeacherId: "t-stale", wiseUserId: "u-stale", wiseDisplayName: "Stale (Stale)", isOnlineVariant: false },
  ]);
  await handle.db.insert(schema.tutorWiseAccounts).values([
    { wiseTeacherId: "t-aria-on", wiseUserId: "u-aria-on", canonicalKey: "Aria", displayName: "Aria (Aria) Online", isOnlineVariant: true,
      email: "aria.online@example.com", status: "active", lastSnapshotId: snapshot.id,
      wiseRelation: "TEACHER", wiseJoinedOn: new Date("2026-01-20T00:00:00Z"), wiseCourseCount: 0, wiseActivated: true },
    { wiseTeacherId: "t-aria-off", wiseUserId: "u-aria-off", canonicalKey: "Aria", displayName: "Aria (Aria)", isOnlineVariant: false,
      email: "aria@example.com", status: "active", lastSnapshotId: snapshot.id,
      wiseRelation: "TEACHER", wiseJoinedOn: new Date("2026-01-20T00:00:00Z"), wiseCourseCount: 2, wiseActivated: false },
    { wiseTeacherId: "t-bodhi", wiseUserId: "u-bodhi", canonicalKey: "Bodhi", displayName: "Bodhi (Bodhi)", isOnlineVariant: false,
      email: "bodhi@example.com", status: "active", lastSnapshotId: snapshot.id, wiseRelation: "ADMIN" },
    // Cleo has no durable account row yet: every roster detail is unknown.
  ]);
  await handle.db.insert(schema.futureSessionBlocks).values([
    futureBlock(snapshot.id, bodhi.id, "t-bodhi", "s-b1", "2026-10-02T03:00:00Z", true),
    futureBlock(snapshot.id, bodhi.id, "t-bodhi", "s-b2", "2026-10-05T03:00:00Z", true),
    futureBlock(snapshot.id, bodhi.id, "t-bodhi", "s-b3", "2026-10-06T03:00:00Z", false), // cancelled: not counted
    futureBlock(snapshot.id, aria.id, "t-aria-off", "s-a1", "2026-10-01T01:00:00Z", true), // started before NOW
  ]);
  await handle.db.insert(schema.recurringAvailabilityWindows).values([
    { snapshotId: snapshot.id, groupId: aria.id, wiseTeacherId: "t-aria-off", weekday: 1, startMinute: 540, endMinute: 720 },
    { snapshotId: snapshot.id, groupId: aria.id, wiseTeacherId: "t-aria-off", weekday: 3, startMinute: 540, endMinute: 720 },
  ]);
  await handle.db.insert(schema.dataIssues).values({
    snapshotId: snapshot.id, type: "completeness", severity: "high", entityType: "teacher", entityId: "t-cleo", entityName: "Cleo (Cleo)",
    message: 'Failed to fetch availability for teacher "Cleo (Cleo)": Wise API 500',
  });
  await handle.db.insert(schema.datedLeaves).values([
    { snapshotId: snapshot.id, groupId: aria.id, wiseTeacherId: "t-aria-off", startTime: new Date("2026-10-10T00:00:00Z"), endTime: new Date("2026-10-20T10:00:00Z") },
    { snapshotId: snapshot.id, groupId: aria.id, wiseTeacherId: "t-aria-off", startTime: new Date("2026-09-01T00:00:00Z"), endTime: new Date("2026-09-05T00:00:00Z") },
  ]);
  await handle.db.insert(schema.leaveRequests).values({
    spreadsheetId: "sheet", sheetName: "Form Responses 1", sourceRowNumber: 2, sourceFingerprint: "fp-1",
    tutorName: "Cleo", tutorCanonicalKey: "Cleo", endDate: "2026-10-15",
  });
  await handle.db.insert(schema.pastSessionBlocks).values([
    pastBlock("Aria", "t-aria-off", "p-a1", "2026-06-03T03:00:00Z", true),
    pastBlock("Aria", "t-aria-off", "p-a2", "2026-08-03T03:00:00Z", false), // cancelled
    pastBlock("Aria", "t-aria-off", "p-a0", "2026-02-10T03:00:00Z", true), // before history starts
    pastBlock("Departed", "t-departed", "p-d1", "2026-04-10T03:00:00Z", true), // not on the roster: history only
  ]);
  await handle.db.insert(schema.progressTestAttendanceLedger).values([
    ledgerRow("l-1", "Aria", "2026-05-20T03:00:00Z", "ENDED"),
    ledgerRow("l-2", "Aria", "2026-07-01T03:00:00Z", "CANCELLED"),
  ]);
  await handle.db.insert(schema.postClassSessions).values([
    postClassRow("pc-1", "2026-07-25T03:00:00Z", "ENDED"),
    postClassRow("pc-2", "2026-08-01T03:00:00Z", "CANCELLED"),
  ]);
  await handle.db.insert(schema.wiseActivityEvents).values([
    { eventId: "e1", eventName: "SessionFeedbackSubmitted", eventTimestamp: new Date("2026-09-20T03:00:00Z"), actorWiseUserId: "u-aria-on", actorRole: "TEACHER" },
    { eventId: "e2", eventName: "SessionUpdated", eventTimestamp: new Date("2026-09-30T03:00:00Z"), actorWiseUserId: "u-bodhi", actorRole: "ADMIN" },
    { eventId: "e3", eventName: "SessionUpdated", eventTimestamp: new Date("2026-09-29T03:00:00Z"), actorWiseUserId: "u-aria-off", actorRole: "STUDENT" },
  ]);
  await handle.db.insert(schema.tutorAttendanceEnrollments).values({ canonicalKey: "Bodhi", loginEmail: "bodhi@example.com", startDate: "2026-09-15" });
  return { snapshot };
}

describe("loadOffboardingSignals", () => {
  it("returns null without an active snapshot", async () => {
    expect(await loadOffboardingSignals(db, NOW)).toBeNull();
  });

  it("keeps a blocking class in progress as teaching evidence (OFF-04)", async () => {
    const { snapshot } = await seed();
    const [group] = await handle.db.select().from(schema.tutorIdentityGroups);
    await handle.db.insert(schema.futureSessionBlocks).values(
      futureBlock(snapshot.id, group.id, "t-aria-off", "ongoing", "2026-10-01T04:30:00Z", true),
    );
    const result = await loadOffboardingSignals(db, NOW);
    expect(result!.people.find((person) => person.canonicalKey === "Aria")!.upcomingSessions).toBe(1);
  });

  it("assembles each person on the active snapshot from every source", async () => {
    const { snapshot } = await seed();
    const signals = await loadOffboardingSignals(db, NOW);
    expect(signals).toMatchObject({ snapshotId: snapshot.id, snapshotCreatedAt: "2026-10-01T04:30:00.000Z", generatedAt: NOW.toISOString() });
    expect(signals!.people.map((person) => person.canonicalKey)).toEqual(["Aria", "Bodhi", "Cleo"]);

    const [aria, bodhi, cleo] = signals!.people;
    expect(aria.accounts.map((account) => account.wiseTeacherId)).toEqual(["t-aria-off", "t-aria-on"]);
    expect(aria.accounts[0]).toMatchObject({ relation: "TEACHER", courseCount: 2, activated: false, workingHourWindows: 2, availabilityKnown: true, email: "aria@example.com" });
    expect(aria.accounts[1]).toMatchObject({ courseCount: 0, activated: true, workingHourWindows: 0, joinedOn: "2026-01-20T00:00:00.000Z" });
    expect(aria.lastTaughtBySource).toEqual({ ledger: "2026-05-20T03:00:00.000Z", pastBlocks: "2026-06-03T03:00:00.000Z", postClass: "2026-07-25T03:00:00.000Z" });
    expect(aria).toMatchObject({
      lastTaughtAt: "2026-07-25T03:00:00.000Z", upcomingSessions: 0, nextSessionAt: null,
      upcomingLeaveUntil: "2026-10-20T10:00:00.000Z", lastTeacherActionAt: "2026-09-20T03:00:00.000Z", lastAdminActionAt: null, fullTime: false,
    });

    expect(bodhi).toMatchObject({ upcomingSessions: 2, nextSessionAt: "2026-10-02T03:00:00.000Z", lastAdminActionAt: "2026-09-30T03:00:00.000Z", fullTime: true });
    expect(bodhi.accounts[0].relation).toBe("ADMIN");

    expect(cleo.lastTaughtAt).toBeNull();
    expect(cleo.accounts[0]).toMatchObject({ status: null, relation: null, joinedOn: null, courseCount: null, activated: null, availabilityKnown: false, email: null });
    expect(cleo.upcomingLeaveUntil).toBe("2026-10-15T16:59:59.000Z");

    expect(signals!.taughtDates).toEqual({ Aria: ["2026-05-20", "2026-06-03", "2026-07-25"], Departed: ["2026-04-10"] });
  });
});

describe("loadFeedTimestamps", () => {
  it("reads the active snapshot's age and each feed's last successful run", async () => {
    await seed();
    await handle.db.insert(schema.progressTestSyncRuns).values([
      { status: "success", finishedAt: new Date("2026-10-01T02:57:00Z") },
      { status: "failed", finishedAt: new Date("2026-10-01T03:27:00Z") },
    ]);
    await handle.db.insert(schema.postClassSyncRuns).values({ status: "success", finishedAt: new Date("2026-10-01T03:13:00Z"), windowStart: "2026-09-28", windowEnd: "2026-10-01" });
    await handle.db.insert(schema.wiseActivitySyncRuns).values({ status: "success", triggerType: "cron", finishedAt: new Date("2026-10-01T03:02:00Z") });
    expect(await loadFeedTimestamps(db)).toEqual({
      tutorSnapshot: "2026-10-01T04:30:00.000Z",
      progressTests: "2026-10-01T02:57:00.000Z",
      postClass: "2026-10-01T03:13:00.000Z",
      wiseActivity: "2026-10-01T03:02:00.000Z",
      leaveRequests: null,
    });
  });
});
