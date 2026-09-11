import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { startTestDb, stopTestDb, truncateAll } from "@/tests/integration/db-helper";
import type { Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { WiseApiError, type WiseClient } from "@/lib/wise/client";
import type { WiseSession } from "@/lib/wise/types";
import { createClassroomPublishJob, runClassroomPublishJob, getClassroomAssignmentForDate } from "../data";
import { claimPublishAttempt, withPublishClaim, publishFence, publishRetryDelay } from "../publish-queue";
import { getScheduleEmailPreview } from "../schedule-email";

let handle: Awaited<ReturnType<typeof startTestDb>>, db: Database;
beforeAll(async () => { handle = await startTestDb(); db = handle.db as unknown as Database; });
afterAll(async () => { if (handle) await stopTestDb(handle); });
beforeEach(async () => { await truncateAll(handle.db); await handle.db.execute(sql`truncate room_day_states cascade`); });
const date = "2099-09-12";

async function fixture(rooms = ["Cool", "Do It"], current = ["Do It", "Cool"]) {
  const [snapshot] = await handle.db.insert(s.snapshots).values({ active: true }).returning();
  const [group] = await handle.db.insert(s.tutorIdentityGroups).values({ snapshotId: snapshot.id, canonicalKey: "tutor", displayName: "Tutor" }).returning();
  const [run] = await handle.db.insert(s.classroomAssignmentRuns).values({ assignmentDate: date, snapshotId: snapshot.id, totalSessions: rooms.length }).returning();
  const rows = await handle.db.insert(s.classroomAssignmentRows).values(rooms.map((room, i) => ({
    runId: run.id, snapshotId: snapshot.id, groupId: group.id, canonicalKey: "tutor", tutorDisplayName: `Tutor ${i}`,
    wiseTeacherId: "teacher", wiseSessionId: randomUUID(), wiseClassId: `class-${i}`, startTime: new Date(`${date}T09:00:00Z`), endTime: new Date(`${date}T10:00:00Z`),
    weekday: 6, startMinute: 540, endMinute: 600, wiseStatus: "CONFIRMED", sessionType: "OFFLINE", minCapacity: 1,
    assignedRoom: room, currentWiseLocation: current[i], status: "assigned" as const,
  }))).returning();
  const live = new Map<string, WiseSession>(rows.map((row, i) => [row.wiseSessionId, {
    _id: row.wiseSessionId, classId: row.wiseClassId!, scheduledStartTime: `${date}T02:00:00Z`, scheduledEndTime: `${date}T03:00:00Z`,
    type: "OFFLINE", meetingStatus: "CONFIRMED", location: current[i],
  }]));
  const get = vi.fn(async (path: string) => path.endsWith("/locations")
    ? { data: { locations: ["Cool", "Do It", "Nerd", "Joy (TV)"] } }
    : { data: { sessions: [...live.values()].map(row => ({ ...row })), page_count: 1 } });
  const put = vi.fn(async (path: string, body: { location: string }) => {
    const id = path.split("/sessions/")[1].split("?")[0];
    live.get(id)!.location = body.location;
    return { data: {} };
  });
  const client = { get, put } as unknown as WiseClient;
  return { snapshot, run, rows, live, client, get, put };
}

async function due(jobId: string) {
  await handle.db.update(s.classroomPublishJobs).set({ nextAttemptAt: new Date(0) }).where(eq(s.classroomPublishJobs.id, jobId));
  await handle.db.update(s.classroomPublishWorker).set({ cooldownUntil: null }).where(eq(s.classroomPublishWorker.id, "global"));
}

describe("durable classroom publication", () => {
  it("deduplicates concurrent publish clicks and verifies a dependency-aware swap", async () => {
    const f = await fixture();
    const [one, two] = await Promise.all([createClassroomPublishJob(db, { runId: f.run.id }), createClassroomPublishJob(db, { runId: f.run.id })]);
    expect(one.jobId).toBe(two.jobId);
    const result = await runClassroomPublishJob(db, one.jobId, f.client);
    expect(result.progress).toMatchObject({ status: "succeeded", successCount: 2, completedCount: 2, remainingCount: 0, attemptCount: 1 });
    expect(result.progress.verifiedAt).toBeTruthy();
    expect(f.put).toHaveBeenCalledTimes(3); // temporary room, then two final destinations
    expect((await getClassroomAssignmentForDate(db, date)).publishProgress?.jobId).toBe(one.jobId);
    expect((await handle.db.select().from(s.roomDayStates))[0].leaseOwner).toBeNull();
  });
  it("pauses on a read 429 and preserves a longer Retry-After across duplicate clicks", async () => {
    const f = await fixture(["Cool"], ["Do It"]);
    f.get.mockRejectedValueOnce(new WiseApiError(429, "limited", "https://wise/test", 3_600_000));
    const job = await createClassroomPublishJob(db, { runId: f.run.id });
    const paused = await runClassroomPublishJob(db, job.jobId, f.client);
    expect(paused.progress.status).toBe("pending");
    expect(Date.parse(paused.progress.nextAttemptAt!) - Date.now()).toBeGreaterThan(3_590_000);
    expect(f.put).not.toHaveBeenCalled();
    expect((await createClassroomPublishJob(db, { runId: f.run.id })).jobId).toBe(job.jobId);
    await runClassroomPublishJob(db, job.jobId, f.client);
    expect(f.get).toHaveBeenCalledTimes(1);
    await due(job.jobId);
    expect((await runClassroomPublishJob(db, job.jobId, f.client)).progress).toMatchObject({ status: "succeeded", successCount: 1, attemptCount: 2 });
  });
  it("recovers a swap interrupted after its temporary move", async () => {
    const f = await fixture();
    const original = f.put.getMockImplementation()!;
    f.put.mockImplementationOnce(original).mockRejectedValueOnce(new WiseApiError(429, "limited", "https://wise/test"));
    const job = await createClassroomPublishJob(db, { runId: f.run.id });
    expect((await runClassroomPublishJob(db, job.jobId, f.client)).progress.status).toBe("pending");
    expect(f.put).toHaveBeenCalledTimes(2);
    await due(job.jobId);
    const result = await runClassroomPublishJob(db, job.jobId, f.client);
    expect(result.progress).toMatchObject({ status: "succeeded", successCount: 2, completedCount: 2 });
    expect([...f.live.values()].map(row => row.location)).toEqual(["Cool", "Do It"]);
  });
  it("reads back an uncertain accepted write without writing it twice", async () => {
    const f = await fixture(["Cool"], ["Do It"]);
    const original = f.put.getMockImplementation()!;
    f.put.mockImplementationOnce(async (...args) => { await original(...args); throw new TypeError("fetch failed"); });
    const job = await createClassroomPublishJob(db, { runId: f.run.id });
    expect((await runClassroomPublishJob(db, job.jobId, f.client)).progress.status).toBe("pending");
    await due(job.jobId);
    expect((await runClassroomPublishJob(db, job.jobId, f.client)).progress.status).toBe("succeeded");
    expect(f.put).toHaveBeenCalledTimes(1);
  });
  it("does not claim success when Wise accepts a PUT but read-back differs", async () => {
    const f = await fixture(["Cool"], ["Do It"]);
    f.put.mockResolvedValue({ data: {} });
    const job = await createClassroomPublishJob(db, { runId: f.run.id });
    const result = await runClassroomPublishJob(db, job.jobId, f.client);
    expect(result.progress).toMatchObject({ status: "pending", successCount: 0, remainingCount: 1 });
    expect(result.detail).toBeUndefined();
    expect((await handle.db.select().from(s.classroomAssignmentRows))[0].publishStatus).toBe("not_published");
  });
  it("blocks external occupancy and permanently changed sessions without PUTs", async () => {
    const f = await fixture(["Cool"], ["Do It"]);
    f.live.set("external", { ...[...f.live.values()][0], _id: "external", location: "Cool" });
    const job = await createClassroomPublishJob(db, { runId: f.run.id });
    expect((await runClassroomPublishJob(db, job.jobId, f.client)).progress).toMatchObject({ status: "failed", failedCount: 1 });
    expect(f.put).not.toHaveBeenCalled();
  });
  it("stops an older queued plan after a newer plan is saved", async () => {
    const f = await fixture();
    const job = await createClassroomPublishJob(db, { runId: f.run.id });
    await handle.db.insert(s.classroomAssignmentRuns).values({ assignmentDate: date, snapshotId: f.snapshot.id, createdAt: new Date(Date.now() + 1000) });
    expect((await runClassroomPublishJob(db, job.jobId, f.client)).progress.lastError).toContain("superseded");
    expect(f.get).not.toHaveBeenCalled();
  });
  it("blocks email while an already-matching plan is still queued for verification", async () => {
    const f = await fixture(["Cool"], ["Cool"]);
    await handle.db.insert(s.tutorContacts).values({ canonicalKey: "tutor", displayName: "Tutor", onsiteEmail: "test@example.com" });
    await handle.db.update(s.classroomAssignmentRows).set({ publishStatus: "success" }).where(eq(s.classroomAssignmentRows.runId, f.run.id));
    await createClassroomPublishJob(db, { runId: f.run.id });
    const preview = await getScheduleEmailPreview(db, f.run.id);
    expect(preview.recipients[0].status).toBe("blocked");
    expect(JSON.stringify(preview)).toContain("successful Wise publishing");
  });
  it("never writes a started class even when it is present in the live day read", async () => {
    const f = await fixture(["Cool"], ["Do It"]);
    const pastDate = "2020-01-01";
    await handle.db.update(s.classroomAssignmentRuns).set({ assignmentDate: pastDate }).where(eq(s.classroomAssignmentRuns.id, f.run.id));
    for (const live of f.live.values()) {
      live.scheduledStartTime = `${pastDate}T02:00:00Z`;
      live.scheduledEndTime = `${pastDate}T03:00:00Z`;
    }
    const job = await createClassroomPublishJob(db, { runId: f.run.id });
    expect((await runClassroomPublishJob(db, job.jobId, f.client)).progress).toMatchObject({ status: "failed", failedCount: 1 });
    expect(f.put).not.toHaveBeenCalled();
  });
  it("rejects changed times and incomplete pagination before any write", async () => {
    const f = await fixture(["Cool"], ["Do It"]);
    f.live.get(f.rows[0].wiseSessionId)!.scheduledEndTime = `${date}T04:00:00Z`;
    let job = await createClassroomPublishJob(db, { runId: f.run.id });
    expect((await runClassroomPublishJob(db, job.jobId, f.client)).progress.failedCount).toBe(1);
    f.get.mockResolvedValueOnce({ data: { sessions: [...f.live.values()], page_count: 2 } });
    job = await createClassroomPublishJob(db, { runId: f.run.id });
    expect((await runClassroomPublishJob(db, job.jobId, f.client)).progress.status).toBe("pending");
    expect(f.put).not.toHaveBeenCalled();
  });
  it("fences an expired worker from changing a newly claimed job", async () => {
    const f = await fixture();
    const job = await createClassroomPublishJob(db, { runId: f.run.id });
    const first = (await claimPublishAttempt(db, job.jobId))!;
    expect(await claimPublishAttempt(db, job.jobId)).toBeNull();
    await handle.db.update(s.classroomPublishWorker).set({ leaseExpiresAt: new Date(0) });
    await handle.db.update(s.classroomPublishJobs).set({ leaseExpiresAt: new Date(0) }).where(eq(s.classroomPublishJobs.id, job.jobId));
    const second = (await claimPublishAttempt(db, job.jobId))!;
    expect(second.token).not.toBe(first.token);
    await withPublishClaim(first, () => db.update(s.classroomPublishJobs).set({ status: "succeeded" }).where(publishFence()));
    expect((await handle.db.select().from(s.classroomPublishJobs))[0]).toMatchObject({ status: "running", claimToken: second.token });
  });
  it("uses bounded backoff", () => {
    expect([1, 2, 3, 4, 99].map(n => publishRetryDelay(n) / 60_000)).toEqual([5, 10, 20, 30, 30]);
  });
});
