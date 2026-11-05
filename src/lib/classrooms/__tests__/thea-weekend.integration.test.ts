import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { startTestDb, stopTestDb, truncateAll } from "@/tests/integration/db-helper";
import type { Database } from "@/lib/db";
import { theaWeekendJobs as jobs, theaWeekendRequests as requests } from "@/lib/db/schema";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/line/client", () => ({ replyLineMessage: vi.fn(), pushLineTextMessage: vi.fn() }));
vi.mock("@/lib/sync/orchestrator", () => ({ runFullSync: vi.fn() }));
vi.mock("@/lib/wise/client", () => ({ createWiseClient: vi.fn(() => ({})) }));
vi.mock("@/lib/wise/day-sessions", () => ({ fetchWiseSessionsForBangkokDates: vi.fn() }));
vi.mock("../data", () => ({ getClassroomAssignmentForDate: vi.fn(), getClassroomAssignmentByRunId: vi.fn(),
  getFreshClassroomSnapshotForAssignment: vi.fn(), runIncrementalClassroomAssignment: vi.fn(),
  createClassroomPublishJob: vi.fn(), runClassroomPublishJob: vi.fn() }));
vi.mock("../print-report", () => ({ loadClassroomPrintReport: vi.fn() }));

import { receiveTheaCommand, resolveTheaLink, runTheaWeekendWorker } from "../thea-weekend";
import { theaPublishAllowed } from "../thea-publish-access";
import { THEA_ACTOR_PREFIX, theaToken } from "../thea-config";
import { pushLineTextMessage, replyLineMessage } from "@/lib/line/client";
import { fetchWiseSessionsForBangkokDates } from "@/lib/wise/day-sessions";
import { getClassroomAssignmentForDate, getClassroomAssignmentByRunId, getFreshClassroomSnapshotForAssignment,
  runIncrementalClassroomAssignment, createClassroomPublishJob } from "../data";
import { loadClassroomPrintReport } from "../print-report";

let handle: Awaited<ReturnType<typeof startTestDb>>, db: Database;
const groupId = `C${"a".repeat(32)}`;
const saved = new Map<string, { run: { id: string; assignmentDate: string }; rows: never[] }>();
beforeAll(async () => { handle = await startTestDb(); db = handle.db as unknown as Database; });
afterAll(async () => { if (handle) await stopTestDb(handle); });
beforeEach(async () => {
  await truncateAll(handle.db); saved.clear(); vi.resetAllMocks();
  vi.stubEnv("THEA_WEEKEND_COMMANDS_ENABLED", "true"); vi.stubEnv("THEA_LINE_GROUP_ID", groupId);
  vi.stubEnv("WISE_CLASSROOM_AUTOMATION_ENABLED", "false"); vi.stubEnv("AUTH_SECRET", "secret".repeat(8));
  vi.stubEnv("APP_BASE_URL", "https://app.example"); vi.stubEnv("WISE_INSTITUTE_ID", "institute");
  vi.mocked(getClassroomAssignmentForDate).mockImplementation(async (_db, date) => (saved.get(date) ?? { run: null }) as never);
  vi.mocked(runIncrementalClassroomAssignment).mockImplementation(async (_db, input) => {
    const detail = { run: { id: randomUUID(), assignmentDate: input.date }, rows: [] };
    saved.set(input.date, detail); return detail as never;
  });
  vi.mocked(getClassroomAssignmentByRunId).mockImplementation(async (_db, id) => [...saved.values()].find(day => day.run.id === id) as never);
  vi.mocked(replyLineMessage).mockResolvedValue({ sentMessageId: "ack", response: {} });
  vi.mocked(pushLineTextMessage).mockResolvedValue({ sentMessageId: "reply", response: {}, retryKey: "test" });
  vi.mocked(getFreshClassroomSnapshotForAssignment).mockResolvedValue({} as never);
  vi.mocked(fetchWiseSessionsForBangkokDates).mockResolvedValue([]);
  vi.mocked(loadClassroomPrintReport).mockImplementation(async (_db, ids) => ({ refreshFailed: false,
    days: ids.map(id => ({ runId: id, draft: false })) }) as never);
});
afterEach(() => vi.unstubAllEnvs());
function event(id = randomUUID(), group = groupId) {
  return { type: "message", webhookEventId: id, replyToken: "reply", source: { type: "group", groupId: group, userId: "any-staff-member" },
    message: { type: "text", text: "/จัดตะราง" } };
}

describe("Thea durable staff requests", () => {
  it("rejects other groups and direct messages, and deduplicates both redelivery and concurrent staff requests", async () => {
    expect(await receiveTheaCommand(db, event(randomUUID(), `C${"b".repeat(32)}`))).toEqual({ handled: true });
    expect(await receiveTheaCommand(db, { ...event(), source: { type: "user", userId: "staff" } })).toEqual({ handled: true });
    const first = event();
    await Promise.all([receiveTheaCommand(db, first), receiveTheaCommand(db, first), receiveTheaCommand(db, event())]);
    expect(await handle.db.select().from(jobs)).toHaveLength(1);
    expect(await handle.db.select().from(requests)).toHaveLength(2);
    expect(replyLineMessage).toHaveBeenCalledTimes(2);
  });
  it("allocates each missing day once while paused, then reuses it and delivers scoped, expiring links", async () => {
    await receiveTheaCommand(db, event());
    await Promise.all([runTheaWeekendWorker(db), runTheaWeekendWorker(db)]);
    expect(runIncrementalClassroomAssignment).toHaveBeenCalledTimes(2);
    expect(runIncrementalClassroomAssignment).toHaveBeenCalledWith(db, expect.objectContaining({ createOnlyIfMissing: true, forceReassign: false }));
    expect(createClassroomPublishJob).not.toHaveBeenCalled();
    const [receipt] = await handle.db.select().from(requests);
    expect(receipt.deliveredAt).not.toBeNull();
    expect(receipt.tokenHash).not.toContain(theaToken(receipt.id));
    expect((await resolveTheaLink(db, theaToken(receipt.id)))?.runIds).toHaveLength(2);
    expect(await resolveTheaLink(db, theaToken(receipt.id), receipt.expiresAt)).toBeNull();
    expect(await resolveTheaLink(db, "wrong")).toBeNull();
    await receiveTheaCommand(db, event()); await runTheaWeekendWorker(db);
    expect(runIncrementalClassroomAssignment).toHaveBeenCalledTimes(2);
    expect(pushLineTextMessage).toHaveBeenCalledTimes(2);
  });
  it("keeps saved plans and reports new Wise classes without creating or publishing replacements", async () => {
    await receiveTheaCommand(db, event()); await runTheaWeekendWorker(db);
    vi.mocked(fetchWiseSessionsForBangkokDates).mockResolvedValue([{ _id: "new", meetingStatus: "CONFIRMED" }] as never);
    await receiveTheaCommand(db, event()); await runTheaWeekendWorker(db);
    expect(runIncrementalClassroomAssignment).toHaveBeenCalledTimes(2);
    expect(createClassroomPublishJob).not.toHaveBeenCalled();
    const [job] = await handle.db.select().from(jobs);
    expect(job.status).toBe("completed"); expect(job.warnings.join(" ")).toContain("Wise changed");
  });
  it("delivers a request that arrives while the previous result is being sent", async () => {
    await receiveTheaCommand(db, event());
    vi.mocked(pushLineTextMessage).mockImplementationOnce(async () => {
      await receiveTheaCommand(db, event());
      return { sentMessageId: "sent", response: {}, retryKey: "test" };
    });
    await runTheaWeekendWorker(db);
    expect((await handle.db.select().from(jobs))[0].status).toBe("pending");
    await runTheaWeekendWorker(db);
    expect((await handle.db.select().from(requests)).every(row => row.deliveredAt)).toBe(true);
    expect(pushLineTextMessage).toHaveBeenCalledTimes(2);
  });
  it("allows paused publishing only for a current lease, exact group, and bound run", async () => {
    const id = randomUUID(), runId = randomUUID();
    await handle.db.insert(jobs).values({ id, weekendDate: "2099-01-03", groupId, status: "running", runIds: [runId],
      claimToken: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60_000) });
    const publication = { createdBy: `${THEA_ACTOR_PREFIX}${id}`, runId };
    expect(await theaPublishAllowed(db, publication)).toBe(true);
    expect(await theaPublishAllowed(db, { ...publication, runId: randomUUID() })).toBe(false);
    await handle.db.update(jobs).set({ leaseExpiresAt: new Date(0) }).where(eq(jobs.id, id));
    expect(await theaPublishAllowed(db, publication)).toBe(false);
  });
});
