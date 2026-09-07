import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { startTestDb, stopTestDb, truncateAll } from "@/tests/integration/db-helper";
import type { Database } from "@/lib/db";
import type { WiseSession } from "@/lib/wise/types";
import * as s from "@/lib/db/schema";
import { getClassroomAssignmentForDate, runIncrementalClassroomAssignment, StaleClassroomAssignmentSnapshotError } from "../data";

let handle: Awaited<ReturnType<typeof startTestDb>>, db: Database;
beforeAll(async () => { handle = await startTestDb(); db = handle.db as unknown as Database; });
afterAll(async () => { if (handle) await stopTestDb(handle); });
beforeEach(async () => { await truncateAll(handle.db); vi.stubEnv("CLASSROOM_CONTINUITY_ENABLED", "false"); });
afterEach(() => vi.unstubAllEnvs());

describe("classroom freshness with partial Wise syncs", () => {
  it("reads the active snapshot independently and preserves review counts through generation and reload", async () => {
    const date = "2099-09-09";
    const oldTime = new Date(Date.now() - 60 * 60 * 1000);
    const [old] = await handle.db.insert(s.snapshots).values({ createdAt: oldTime }).returning();
    const [active] = await handle.db.insert(s.snapshots).values({ active: true }).returning();
    const summary = "1 teacher contact needs review; 10 future sessions reference an absent teacher";
    await handle.db.insert(s.syncRuns).values([
      { status: "success", snapshotId: old.id, promotedSnapshotId: old.id, startedAt: oldTime, finishedAt: oldTime },
      { status: "failed", snapshotId: active.id, promotedSnapshotId: active.id, finishedAt: new Date(), errorSummary: summary },
    ]);
    const [saved] = await handle.db.insert(s.classroomAssignmentRuns).values({ snapshotId: old.id, assignmentDate: date, createdAt: oldTime }).returning();
    const before = await getClassroomAssignmentForDate(db, date);
    expect(before.run?.id).toBe(saved.id);
    expect(before.snapshotMeta).toMatchObject({ snapshotId: old.id, fresh: false });
    expect(before.activeSnapshotMeta).toMatchObject({ snapshotId: active.id, fresh: true, syncErrorSummary: summary });

    const [group] = await handle.db.insert(s.tutorIdentityGroups).values({ snapshotId: active.id, canonicalKey: "resolved", displayName: "Resolved teacher" }).returning();
    const startTime = new Date(`${date}T02:00:00Z`), endTime = new Date(`${date}T03:00:00Z`);
    await handle.db.insert(s.futureSessionBlocks).values({ snapshotId: active.id, groupId: group.id, wiseTeacherId: "teacher-1", wiseSessionId: "managed",
      startTime, endTime, weekday: 3, startMinute: 540, endMinute: 600, wiseStatus: "CONFIRMED", isBlocking: true, sessionType: "OFFLINE", studentCount: 1 });
    const liveSessions: WiseSession[] = ["managed", "unmanaged"].map(id => ({ _id: id, scheduledStartTime: startTime.toISOString(), scheduledEndTime: endTime.toISOString(), type: "OFFLINE", meetingStatus: "CONFIRMED" }));
    // A second absent-teacher session is on another day and must not inflate this day's count.
    liveSessions.push({ ...liveSessions[1], _id: "another-day", scheduledStartTime: "2099-09-10T02:00:00Z" });
    const generated = await runIncrementalClassroomAssignment(db, { date, liveSessions });
    expect(generated.rows.map(row => row.wiseSessionId)).toEqual(["managed"]);
    expect(generated.run?.changeSummary).toMatchObject({ syncErrorSummary: summary, unmanagedWiseSessionCount: 1, unmanagedWiseSessionIds: ["unmanaged"] });
    const reload = await getClassroomAssignmentForDate(db, date);
    expect(reload.run?.id).toBe(generated.run?.id);
    expect(reload.run?.changeSummary).toMatchObject({ syncErrorSummary: summary, unmanagedWiseSessionCount: 1 });
    expect(reload.activeSnapshotMeta.syncErrorSummary).toBe(summary);
    expect((await handle.db.select().from(s.syncRuns).where(eq(s.syncRuns.promotedSnapshotId, active.id)))[0].status).toBe("failed");
    expect(await handle.db.select().from(s.classroomScheduleEmailRuns)).toHaveLength(0);
    expect(generated.rows.every(row => row.publishStatus === "not_published")).toBe(true);

    await handle.db.update(s.syncRuns).set({ finishedAt: oldTime }).where(eq(s.syncRuns.promotedSnapshotId, active.id));
    await expect(runIncrementalClassroomAssignment(db, { date, liveSessions })).rejects.toBeInstanceOf(StaleClassroomAssignmentSnapshotError);
  });

  it("can display saved assignments when no active snapshot exists, without claiming freshness", async () => {
    const [snapshot] = await handle.db.insert(s.snapshots).values({}).returning();
    await handle.db.insert(s.classroomAssignmentRuns).values({ snapshotId: snapshot.id, assignmentDate: "2099-09-09" });
    const detail = await getClassroomAssignmentForDate(db, "2099-09-09");
    expect(detail.run).not.toBeNull();
    expect(detail.activeSnapshotMeta).toMatchObject({ snapshotId: null, fresh: false });
  });
});
