import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { startTestDb, stopTestDb, truncateAll } from "@/tests/integration/db-helper";
import type { Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import type { WiseSession } from "@/lib/wise/types";
import { ensureDefaultClassroomRooms, getClassroomAssignmentForDate, runIncrementalClassroomAssignment } from "../data";
import { loadAttendanceObservations, loadBootstrapModeObservations, loadStudentModeEvidence, recordModeObservations } from "../mode-history-data";
import type { ModeObservation } from "../mode-history";
import { REMOTE_NO_ROOM_NEEDED } from "../assignment-engine";
import { WEEKEND_ALLOCATION_ACTOR } from "../weekend-config";

let handle: Awaited<ReturnType<typeof startTestDb>>, db: Database;
beforeAll(async () => { handle = await startTestDb(); db = handle.db as unknown as Database; });
afterAll(async () => { if (handle) await stopTestDb(handle); });
beforeEach(async () => {
  await truncateAll(handle.db);
  await handle.db.execute(sql`TRUNCATE classroom_weekend_notifications, classroom_weekend_checks,
    onsite_foot_traffic_sessions, onsite_foot_traffic_sync_runs, credit_control_snapshots, credit_control_sync_runs CASCADE`);
  vi.stubEnv("CLASSROOM_CONTINUITY_ENABLED", "false");
  vi.stubEnv("WISE_USER_ID", "test-user");
  vi.stubEnv("WISE_API_KEY", "test-key");
});
afterEach(() => vi.unstubAllEnvs());
const date = "2099-09-19";
async function seed(online: boolean) {
  const [snapshot] = await handle.db.insert(s.snapshots).values({ active: true }).returning();
  await handle.db.insert(s.syncRuns).values({ status: "success", snapshotId: snapshot.id, promotedSnapshotId: snapshot.id, finishedAt: new Date() });
  await ensureDefaultClassroomRooms(db);
  await handle.db.update(s.classroomRooms).set({ active: false });
  await handle.db.insert(s.classroomRooms).values({ name: "Test classroom", capacity: 4, category: "standard", active: true, hasTv: true, sortOrder: 0 });
  const liveSessions: WiseSession[] = [];
  for (const [id, type, start, end] of [["a", "OFFLINE", 540, 600], ["b", online ? "SCHEDULED" : "OFFLINE", 600, 720], ["c", "OFFLINE", 600, 660], ["d", "OFFLINE", 660, 720]] as const) {
    const teacher = id === "b" ? "a" : id;
    let [group] = await handle.db.select().from(s.tutorIdentityGroups).where(eq(s.tutorIdentityGroups.canonicalKey, teacher));
    if (!group) {
      [group] = await handle.db.insert(s.tutorIdentityGroups).values({ snapshotId: snapshot.id, canonicalKey: teacher, displayName: `Teacher ${teacher}` }).returning();
      await handle.db.insert(s.tutorIdentityGroupMembers).values({ snapshotId: snapshot.id, groupId: group.id,
        wiseTeacherId: teacher, wiseUserId: teacher, wiseDisplayName: `Teacher ${teacher}` });
    }
    const wallTime = (minute: number) => new Date(`${date}T${String(Math.floor(minute / 60)).padStart(2, "0")}:00:00Z`);
    const startTime = wallTime(start), endTime = wallTime(end);
    await handle.db.insert(s.futureSessionBlocks).values({ snapshotId: snapshot.id, groupId: group.id, wiseTeacherId: teacher, wiseTeacherUserId: teacher,
      wiseSessionId: id, wiseClassId: `class-${id}`, startTime, endTime, weekday: 6, startMinute: start, endMinute: end,
      wiseStatus: "CONFIRMED", isBlocking: true, sessionType: type, studentCount: 1, studentIds: [`student-${id}`], classType: "ONE_TO_ONE" });
    liveSessions.push({ _id: id, classId: { _id: `class-${id}`, classType: "ONE_TO_ONE" }, userId: teacher, type, meetingStatus: "CONFIRMED", students: [`student-${id}`], studentCount: 1,
      scheduledStartTime: new Date(startTime.getTime() - 7 * 3600000).toISOString(), scheduledEndTime: new Date(endTime.getTime() - 7 * 3600000).toISOString() });
  }
  return { snapshot, liveSessions };
}
describe("durable overflow planning", () => {
  async function checkpoint() {
    const [check] = await handle.db.insert(s.classroomWeekendChecks).values({ checkDate: "2099-09-16", weekendDate: date, claimedAt: new Date() }).returning();
    return { id: check.id, claimedAt: check.claimedAt };
  }
  it("resumes a committed Wednesday allocation without a duplicate run, preserving an override and online release", async () => {
    const { liveSessions } = await seed(true);
    const original = await runIncrementalClassroomAssignment(db, { date, liveSessions });
    await handle.db.update(s.classroomAssignmentRows).set({ overrideRoom: "Test classroom" })
      .where(eq(s.classroomAssignmentRows.id, original.rows.find(row => row.wiseSessionId === "a")!.id));
    const weekendCheckpoint = await checkpoint();
    const first = await runIncrementalClassroomAssignment(db, { date, liveSessions, weekendCheckpoint });
    const resumed = await runIncrementalClassroomAssignment(db, { date, liveSessions, weekendCheckpoint });
    expect(resumed.allocationReused).toBe(true);
    expect(resumed.run!.id).toBe(first.run!.id);
    expect(resumed.rows.find(row => row.wiseSessionId === "a")?.overrideRoom).toBe("Test classroom");
    expect(resumed.rows.find(row => row.wiseSessionId === "b")).toMatchObject({ sessionType: "SCHEDULED", overflowReleaseRoom: REMOTE_NO_ROOM_NEEDED });
    expect(await handle.db.select().from(s.classroomAssignmentRuns).where(eq(s.classroomAssignmentRuns.automationBatchId, weekendCheckpoint.id))).toHaveLength(1);
    expect(await handle.db.select().from(s.classroomPublishJobs)).toHaveLength(0);
    expect(await handle.db.select().from(s.classroomScheduleEmailRuns)).toHaveLength(0);
    await expect(handle.db.insert(s.classroomAssignmentRuns).values({ assignmentDate: date, snapshotId: first.run!.snapshotId,
      automationBatchId: weekendCheckpoint.id, createdBy: WEEKEND_ALLOCATION_ACTOR })).rejects.toThrow();
  });
  it("refuses changed constraints when resuming a saved checkpoint", async () => {
    const { liveSessions } = await seed(true), weekendCheckpoint = await checkpoint();
    await runIncrementalClassroomAssignment(db, { date, liveSessions, weekendCheckpoint });
    await handle.db.update(s.classroomRooms).set({ capacity: 5 }).where(eq(s.classroomRooms.name, "Test classroom"));
    await expect(runIncrementalClassroomAssignment(db, { date, liveSessions, weekendCheckpoint })).rejects.toThrow("inputs have changed");
    expect(await handle.db.select().from(s.classroomAssignmentRuns)).toHaveLength(1);
  });
  it("fences a replaced checkpoint before committing an allocation", async () => {
    const { liveSessions } = await seed(true), weekendCheckpoint = await checkpoint();
    await handle.db.update(s.classroomWeekendChecks).set({ claimedAt: new Date(weekendCheckpoint.claimedAt.getTime() + 1) });
    await expect(runIncrementalClassroomAssignment(db, { date, liveSessions, weekendCheckpoint })).rejects.toThrow("no longer active");
    expect(await handle.db.select().from(s.classroomAssignmentRuns)).toHaveLength(0);
  });
  it("refuses a live lesson changed since the verified snapshot", async () => {
    const { liveSessions } = await seed(false), weekendCheckpoint = await checkpoint();
    liveSessions[0].students = ["changed-roster"];
    await expect(runIncrementalClassroomAssignment(db, { date, liveSessions, weekendCheckpoint })).rejects.toThrow("differ from the snapshot");
    expect(await handle.db.select().from(s.classroomAssignmentRuns)).toHaveLength(0);
  });
  it("saves zero-switch relief and keeps the release across regeneration adjacent to onsite teaching", async () => {
    const { liveSessions } = await seed(true);
    const first = await runIncrementalClassroomAssignment(db, { date, liveSessions });
    expect(first.overflowPlan).toMatchObject({ minimumSwitches: 0, actualRemainingOverflow: 0 });
    expect(first.rows.find(row => row.wiseSessionId === "b")).toMatchObject({ assignedRoom: REMOTE_NO_ROOM_NEEDED, overflowReleaseRoom: REMOTE_NO_ROOM_NEEDED });
    const next = await runIncrementalClassroomAssignment(db, { date, liveSessions });
    expect(next.run?.noRoomCount).toBe(0);
    expect(next.rows.find(row => row.wiseSessionId === "b")?.overflowReleaseRoom).toBe(REMOTE_NO_ROOM_NEEDED);
    expect(await handle.db.select().from(s.classroomScheduleEmailRuns)).toHaveLength(0);
  });
  it("saves hypothetical switches separately, then activates only with fresh matching ONLINE evidence", async () => {
    const { liveSessions, snapshot } = await seed(false);
    const first = await runIncrementalClassroomAssignment(db, { date, liveSessions });
    expect(first.overflowPlan).toMatchObject({ minimumSwitches: 1, proposedSwitches: 1, predictedRemainingOverflow: 0 });
    expect(first.run!.noRoomCount).toBeGreaterThan(0);
    expect(first.rows.every(row => row.sessionType === "OFFLINE" && !row.overflowReleaseRoom && row.publishStatus === "not_published")).toBe(true);
    const reloaded = await getClassroomAssignmentForDate(db, date);
    expect(reloaded.overflowPlan).toEqual(first.overflowPlan);
    const switchId = first.overflowPlan!.proposedActions.find(row => row.kind === "switch_to_online")!.wiseSessionId;
    expect(switchId).toBe("b");
    await handle.db.update(s.futureSessionBlocks).set({ sessionType: "SCHEDULED" }).where(eq(s.futureSessionBlocks.wiseSessionId, switchId));
    const nextLive = liveSessions.map(row => row._id === switchId ? { ...row, type: "SCHEDULED" } : row);
    const next = await runIncrementalClassroomAssignment(db, { date, liveSessions: nextLive });
    expect(next.rows.find(row => row.wiseSessionId === switchId)).toMatchObject({ sessionType: "SCHEDULED", assignedRoom: REMOTE_NO_ROOM_NEEDED, overflowReleaseRoom: REMOTE_NO_ROOM_NEEDED });
    expect(next.run?.noRoomCount).toBe(0);
    // Bootstrap preserves explicit snapshot observations, with no invented attendance.
    const bootstrap = await loadBootstrapModeObservations(db);
    expect(bootstrap).toHaveLength(4);
    expect(bootstrap.every(row => !row.attended)).toBe(true);
    expect(snapshot.id).toBeTruthy();
  });
  it("stores evidence changes idempotently and survives snapshot cleanup", async () => {
    const initial: ModeObservation = { wiseSessionId: "history-session", studentId: "s", rosterKey: "roster", mode: "onsite",
      scheduledStartAt: "2026-09-01T02:00:00Z", scheduledEndAt: "2026-09-01T03:00:00Z", observedAt: "2026-08-30T00:00:00Z", attended: false, cancelled: false };
    expect(await recordModeObservations(db, [initial, initial], "sync-1")).toBe(1);
    expect(await recordModeObservations(db, [{ ...initial, observedAt: "2026-08-31T00:00:00Z" }], "sync-2")).toBe(0);
    const final = { ...initial, mode: "online" as const, attended: true, observedAt: "2026-09-02T00:00:00Z" };
    await recordModeObservations(db, [final], "past-sync");
    expect(await recordModeObservations(db, [initial, final], "bootstrap")).toBe(2);
    expect(await recordModeObservations(db, [initial, final], "bootstrap")).toBe(0);
    const result = await loadStudentModeEvidence(db, ["s", "unknown"], new Date("2026-09-18"));
    expect(result.get("s")).toMatchObject({ verifiedSwitches: 1, attendedLessons: 1, tier: "verified_switches" });
    expect(result.get("unknown")?.tier).toBe("unknown");
  });

  it("bootstraps only successful exact-ID attendance joins and never invents a switch", async () => {
    const now = new Date("2026-09-18T00:00:00Z");
    const [snapshot] = await handle.db.insert(s.creditControlSnapshots).values({ active: true }).returning();
    const [sync] = await handle.db.insert(s.creditControlSyncRuns).values({ status: "success", snapshotId: snapshot.id, promotedSnapshotId: snapshot.id }).returning();
    const [pastSync] = await handle.db.insert(s.onsiteFootTrafficSyncRuns).values({ status: "success", requestedStartDate: "2026-09-01", requestedEndDate: "2026-09-01" }).returning();
    const start = new Date("2026-09-01T02:00:00Z"), end = new Date("2026-09-01T03:00:00Z");
    await handle.db.insert(s.creditControlSessions).values({ snapshotId: snapshot.id, wiseSessionId: "attended", wiseStudentId: "attendee", wiseClassId: "class",
      studentKey: "attendee", packageKey: "package", studentName: "Synthetic", packageName: "Synthetic", scheduledStartTime: start,
      scheduledEndTime: end, meetingStatus: "ENDED", sessionKind: "past", creditApplied: 1 });
    await handle.db.insert(s.onsiteFootTrafficSessions).values({ wiseSessionId: "attended", attendanceDate: "2026-09-01", scheduledStartAt: start,
      scheduledEndAt: end, wiseStatus: "ENDED", sessionType: "SCHEDULED", lastSyncRunId: pastSync.id, syncedAt: new Date("2026-09-02") });
    const rows = await loadAttendanceObservations(db, ["attendee"], now);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ studentId: "attendee", mode: "online", attended: true });
    expect(rows[0].rosterKey).toMatch(/^attendance-only:/);
    expect((await loadBootstrapModeObservations(db, now)).filter(row => row.attended)).toHaveLength(1);
    await recordModeObservations(db, rows, "bootstrap");
    expect((await loadStudentModeEvidence(db, ["attendee"], now)).get("attendee")).toMatchObject({ tier: "online_attendance", verifiedSwitches: 0, onlineAttended: 1 });
    await handle.db.update(s.creditControlSyncRuns).set({ status: "failed" }).where(eq(s.creditControlSyncRuns.id, sync.id));
    expect(await loadAttendanceObservations(db, ["attendee"], now)).toEqual([]);
    await handle.db.update(s.creditControlSyncRuns).set({ status: "success" }).where(eq(s.creditControlSyncRuns.id, sync.id));
    await handle.db.update(s.onsiteFootTrafficSessions).set({ scheduledEndAt: new Date(end.getTime() + 60_000) });
    expect(await loadAttendanceObservations(db, ["attendee"], now)).toEqual([]);
  });
});
