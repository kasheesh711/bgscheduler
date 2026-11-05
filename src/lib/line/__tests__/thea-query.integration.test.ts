import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { startTestDb, stopTestDb, truncateAll } from "@/tests/integration/db-helper";
import type { Database } from "@/lib/db";
import { theaTeacherQueries as jobs, theaQueryCache as cache } from "@/lib/db/schema";

vi.mock("@/lib/line/client", () => ({ replyLineMessage: vi.fn(), pushLineTextMessage: vi.fn() }));
vi.mock("@/lib/feedback-autowriter/openrouter", () => ({ callOpenRouter: vi.fn() }));
import { receiveTheaQuery, reserveTheaBudget, runTheaQueryWorker } from "../thea-query-queue";
import { TheaWiseReader, invalidateTheaSessions } from "../thea-query-data";
import { pushLineTextMessage, replyLineMessage } from "../client";
import { THEA_QUERY_RESERVATION_USD } from "../thea-query";

let handle: Awaited<ReturnType<typeof startTestDb>>, db: Database;
const group = `C${"a".repeat(32)}`;
beforeAll(async () => { handle = await startTestDb(); db = handle.db as unknown as Database; });
afterAll(async () => { if (handle) await stopTestDb(handle); });
beforeEach(async () => {
  await truncateAll(handle.db); vi.clearAllMocks();
  vi.stubEnv("THEA_TEACHER_QUERIES_ENABLED", "true"); vi.stubEnv("THEA_LINE_GROUP_ID", group);
  vi.mocked(replyLineMessage).mockResolvedValue({ sentMessageId: "ack", response: {} });
  vi.mocked(pushLineTextMessage).mockResolvedValue({ retryKey: "retry", sentMessageId: "reply", response: {} });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function event(id = randomUUID(), groupId = group) {
  return { type: "message", webhookEventId: id, replyToken: "reply", source: { type: "group", groupId, userId: "staff" },
    message: { type: "text", text: "@Thea tomorrow 9-10 Math", mention: { mentionees: [{ type: "user", isSelf: true, index: 0, length: 5 }] } } };
}

describe("Thea staff query queue", () => {
  it("rejects other groups and deduplicates concurrent redelivery before paid work", async () => {
    expect(await receiveTheaQuery(db, event(randomUUID(), `C${"b".repeat(32)}`))).toEqual({ handled: true });
    const request = event();
    await Promise.all([receiveTheaQuery(db, request), receiveTheaQuery(db, request)]);
    expect(await db.select().from(jobs)).toHaveLength(1);
    expect(replyLineMessage).toHaveBeenCalledTimes(1);
  });
  it("atomically stops reservations at the approved monthly budget", async () => {
    const claimToken = randomUUID();
    const [job] = await db.insert(jobs).values({ eventId: "one", groupId: group, userId: "staff", question: "test", status: "running",
      claimToken, leaseExpiresAt: new Date(Date.now() + 60_000), reservedUsd: 5 - THEA_QUERY_RESERVATION_USD }).returning();
    const values = await Promise.all([reserveTheaBudget(db, job.id, claimToken), reserveTheaBudget(db, job.id, claimToken)]);
    expect(values.filter(Boolean)).toHaveLength(1);
    const [saved] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(saved.reservedUsd).toBeCloseTo(5);
  });
  it("does not charge a previous month's queued question against an untracked month", async () => {
    const claimToken = randomUUID(), now = new Date("2026-12-01T00:01:00+07:00");
    const [job] = await db.insert(jobs).values({ eventId: "month-edge", groupId: group, userId: "staff", question: "test", status: "running",
      claimToken, createdAt: new Date("2026-11-30T23:59:00+07:00"), leaseExpiresAt: new Date("2026-12-01T00:10:00+07:00") }).returning();
    expect(await reserveTheaBudget(db, job.id, claimToken, now)).toBe(false);
    expect((await db.select().from(jobs))[0].reservedUsd).toBe(0);
  });
  it("only one worker delivers a saved reply, and a delivery retry uses the same key without another model call", async () => {
    const [job] = await db.insert(jobs).values({ eventId: "ready", groupId: group, userId: "staff", question: "test", answer: "Checked result" }).returning();
    vi.mocked(pushLineTextMessage).mockRejectedValueOnce(new Error("network"));
    await runTheaQueryWorker(db);
    await Promise.all([runTheaQueryWorker(db), runTheaQueryWorker(db)]);
    expect(pushLineTextMessage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(pushLineTextMessage).mock.calls.every(([arg]) => arg.retryKey === job.id)).toBe(true);
    expect((await db.select().from(jobs))[0]).toMatchObject({ status: "done", answer: "Checked result" });
  });
});

describe("Thea shared Wise read cache", () => {
  it("reuses checked data but invalidates a day after a session webhook, including a webhook during a fetch", async () => {
    const reader = new TheaWiseReader(db, Date.now() + 60_000);
    const load = vi.fn().mockResolvedValue(["first"]);
    await reader.read("day:2026-11-07", 120_000, load);
    await reader.read("day:2026-11-07", 120_000, load);
    expect(load).toHaveBeenCalledTimes(1);
    await invalidateTheaSessions(db);
    await reader.read("day:2026-11-07", 120_000, async () => { await invalidateTheaSessions(db); return ["changed during read"]; });
    await reader.read("day:2026-11-07", 120_000, load);
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("stops at a Wise 429 and shares the cooldown with the next worker", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{"error":"limited"}', { status: 429, headers: { "Retry-After": "120" } }));
    vi.stubGlobal("fetch", fetcher);
    const first = new TheaWiseReader(db, Date.now() + 60_000);
    await expect(first.read("probe", 1000, () => first.client.get("/probe"))).rejects.toThrow();
    const second = new TheaWiseReader(db, Date.now() + 60_000);
    await expect(second.read("other", 1000, () => second.client.get("/other"))).rejects.toThrow(/rate-limiting/);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await db.select().from(cache)).some(r => r.key === "wise-cooldown")).toBe(true);
  });
});
