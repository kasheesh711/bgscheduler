import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { startTestDb, stopTestDb, truncateAll } from "@/tests/integration/db-helper";
import type { Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { DEFAULT_CLASSROOM_ROOMS } from "../rooms";
import { ensureTutorRoomProfiles, listTutorRoomProfiles, toRoomPolicies, updateTutorRoomProfile } from "../room-profiles";
import { notifiedTutorKeys } from "../notification-state";
import { listPrintRuns, loadClassroomPrintReport } from "../print-report";
import { ensureDefaultClassroomRooms, runIncrementalClassroomAssignment } from "../data";
import { roomQualityMetrics } from "../room-policy";

let handle: Awaited<ReturnType<typeof startTestDb>>, db: Database;
beforeAll(async () => { handle = await startTestDb(); db = handle.db as unknown as Database; });
afterAll(async () => { if (handle) await stopTestDb(handle); });
beforeEach(async () => { await truncateAll(handle.db); });
afterEach(() => vi.unstubAllEnvs());
async function seed(name = "Da") {
  const [snapshot] = await handle.db.insert(s.snapshots).values({}).returning();
  const [group] = await handle.db.insert(s.tutorIdentityGroups).values({ snapshotId: snapshot.id, canonicalKey: name.toLowerCase(), displayName: name }).returning();
  const [session] = await handle.db.insert(s.futureSessionBlocks).values({ snapshotId: snapshot.id, groupId: group.id, wiseTeacherId: name, wiseSessionId: crypto.randomUUID(),
    startTime: new Date("2026-09-12T02:00:00Z"), endTime: new Date("2026-09-12T03:00:00Z"), startMinute: 540, endMinute: 600,
    weekday: 6, wiseStatus: "CONFIRMED", isBlocking: true, sessionType: "OFFLINE", studentCount: 1 }).returning();
  return { snapshot, group, session };
}
describe("stable room policies and saved print data in Postgres", () => {
  it("persists generation policies while protecting delivered rooms and carrying publishing outcomes", async () => {
    const { snapshot, group, session } = await seed("Teacher Z");
    const [other] = await handle.db.insert(s.tutorIdentityGroups).values({ snapshotId: snapshot.id, canonicalKey: "teacher a", displayName: "Teacher A" }).returning();
    const date = "2099-09-12";
    await handle.db.update(s.futureSessionBlocks).set({ startTime: new Date(`${date}T02:00:00Z`), endTime: new Date(`${date}T03:00:00Z`) }).where(eq(s.futureSessionBlocks.id, session.id));
    await handle.db.insert(s.futureSessionBlocks).values([group, other].map(tutor => ({ ...session, id: undefined, groupId: tutor.id, wiseSessionId: crypto.randomUUID(),
      startTime: new Date(`${date}T03:00:00Z`), endTime: new Date(`${date}T04:00:00Z`), startMinute: 600, endMinute: 660 })));
    const input = { date, snapshotId: snapshot.id, liveSessions: [], trustedSnapshotMeta: { snapshotId: snapshot.id, latestSyncFinishedAt: new Date().toISOString(), staleAgeMs: 0, fresh: true } };
    vi.stubEnv("CLASSROOM_CONTINUITY_ENABLED", "false");
    const first = await runIncrementalClassroomAssignment(db, input);
    expect(roomQualityMetrics(first.rows).roomChanges).toBe(1);
    await handle.db.update(s.classroomAssignmentRows).set({ publishStatus: "success", publishedAt: new Date() }).where(eq(s.classroomAssignmentRows.runId, first.run!.id));
    const [email] = await handle.db.insert(s.classroomScheduleEmailRuns).values({ assignmentRunId: first.run!.id, subject: "test" }).returning();
    await handle.db.insert(s.classroomScheduleEmailRecipients).values({ emailRunId: email.id, assignmentRunId: first.run!.id, groupId: group.id,
      canonicalKey: group.canonicalKey, tutorDisplayName: group.displayName, status: "sent" });
    vi.stubEnv("CLASSROOM_CONTINUITY_ENABLED", "true");
    const protectedRun = await runIncrementalClassroomAssignment(db, input);
    expect(protectedRun.run?.changeSummary.algorithmVersion).toBe("continuity-v1");
    expect(protectedRun.run?.changeSummary.roomPolicies).toHaveLength(2);
    const zRooms = (rows: typeof first.rows) => rows.filter(row => row.canonicalKey === "teacher z").map(row => row.assignedRoom);
    expect(zRooms(protectedRun.rows)).toEqual(zRooms(first.rows));
    expect(protectedRun.rows.filter(row => row.canonicalKey === "teacher z").every(row => row.publishStatus === "success")).toBe(true);
    expect(protectedRun.run?.publishedCount).toBe(protectedRun.rows.filter(row => row.publishStatus === "success").length);
    // Remove the synthetic delivery only in this scratch database, then demonstrate eligibility.
    await handle.db.delete(s.classroomScheduleEmailRecipients).where(eq(s.classroomScheduleEmailRecipients.emailRunId, email.id));
    const improved = await runIncrementalClassroomAssignment(db, input);
    expect(roomQualityMetrics(improved.rows).roomChanges).toBe(0);
    expect(improved.rows.some(row => row.changeType === "moved" && row.publishStatus === "not_published")).toBe(true);
    const repeat = await runIncrementalClassroomAssignment(db, input);
    expect(repeat.events).toEqual([]);
    expect((await listTutorRoomProfiles(db)).profiles.every(profile => profile.revision === 1)).toBe(true);
  });
  it("initializes concurrently once, survives snapshot rotation, and preserves admin revisions", async () => {
    const first = await seed();
    const rooms = await handle.db.insert(s.classroomRooms).values(DEFAULT_CLASSROOM_ROOMS).returning();
    await Promise.all([1, 2].map(() => ensureTutorRoomProfiles(db, first.snapshot.id, "2026-09-12", rooms)));
    let listed = await listTutorRoomProfiles(db);
    expect(listed.profiles).toHaveLength(1);
    expect(listed.profiles[0].rooms[0].name).toBe("Do It");
    const wanted = [rooms.find(r => r.name === "Do It")!.id, rooms.find(r => r.name === "Cool")!.id];
    await updateTutorRoomProfile(db, { canonicalKey: "DA", roomIds: wanted, revision: 1, actor: "admin@example.com" });
    await expect(updateTutorRoomProfile(db, { canonicalKey: "da", roomIds: wanted, revision: 1, actor: "stale@example.com" })).rejects.toMatchObject({ status: 409 });
    const rotated = await seed();
    await ensureTutorRoomProfiles(db, rotated.snapshot.id, "2026-09-12", rooms);
    listed = await listTutorRoomProfiles(db);
    expect(listed.profiles[0]).toMatchObject({ roomIds: wanted, revision: 2, updatedBy: "admin@example.com", source: "admin" });
    await handle.db.update(s.classroomRooms).set({ active: false }).where(eq(s.classroomRooms.id, wanted[1]));
    await ensureDefaultClassroomRooms(db);
    expect(toRoomPolicies((await listTutorRoomProfiles(db)).profiles).get("da")?.unavailableRooms).toEqual(["Cool"]);
    await expect(updateTutorRoomProfile(db, { canonicalKey: "da", roomIds: wanted, revision: 2, actor: "admin" })).rejects.toMatchObject({ status: 400 });
    await expect(updateTutorRoomProfile(db, { canonicalKey: "da", roomIds: [rooms[0].id], revision: 2, actor: "admin" })).rejects.toMatchObject({ status: 400 });
  });
  it("recognizes sent schedules across runs and produces a PII-free, explicitly selected print revision", async () => {
    const { snapshot, group, session } = await seed("ครูทดสอบ");
    const [oldRun, latest] = await handle.db.insert(s.classroomAssignmentRuns).values([
      { snapshotId: snapshot.id, assignmentDate: "2026-09-12", createdAt: new Date("2026-09-10T00:00:00Z") },
      { snapshotId: snapshot.id, assignmentDate: "2026-09-12", createdAt: new Date("2026-09-11T00:00:00Z") },
    ]).returning();
    await handle.db.insert(s.classroomAssignmentRows).values({ ...session, id: undefined, runId: oldRun.id, canonicalKey: group.canonicalKey, tutorDisplayName: group.displayName,
      minCapacity: 1, assignedRoom: "Very long room ห้องเรียน", studentName: "PRIVATE STUDENT", subject: "PRIVATE SUBJECT", status: "assigned", publishStatus: "failed" });
    const [email] = await handle.db.insert(s.classroomScheduleEmailRuns).values({ assignmentRunId: oldRun.id, subject: "test" }).returning();
    await handle.db.insert(s.classroomScheduleEmailRecipients).values({ emailRunId: email.id, assignmentRunId: oldRun.id, groupId: group.id, canonicalKey: group.canonicalKey,
      tutorDisplayName: group.displayName, recipientEmail: "private@example.com", status: "sent" });
    expect(await notifiedTutorKeys(db, "2026-09-12")).toEqual(new Set([group.canonicalKey]));
    expect(await notifiedTutorKeys(db, "2026-09-13")).toEqual(new Set());
    const manifest = await listPrintRuns(db, "2026-09-12");
    expect(manifest.runs).toEqual([{ id: latest.id, date: "2026-09-12" }]);
    expect(manifest.missingDates).toHaveLength(6);
    const report = await loadClassroomPrintReport(db, [oldRun.id]);
    expect(report.days[0]).toMatchObject({ runId: oldRun.id, draft: true });
    expect(report.days[0].tutors[0].blocks[0]).toMatchObject({ publication: "failed", room: "Very long room ห้องเรียน" });
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE|private@example|studentName|subject|classType/);
    expect((await loadClassroomPrintReport(db, [oldRun.id])).days[0].revision).toBe(report.days[0].revision);
    await expect(loadClassroomPrintReport(db, [oldRun.id, latest.id])).rejects.toThrow("one saved run per day");
    await expect(loadClassroomPrintReport(db, [crypto.randomUUID()])).rejects.toThrow("could not be found");
  });
});
