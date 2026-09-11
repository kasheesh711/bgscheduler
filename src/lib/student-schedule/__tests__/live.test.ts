import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveMonthCache, LiveMonthEntry } from "../live-cache";
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("../live-cache", () => ({ createLiveMonthCache: vi.fn() }));
vi.mock("@/lib/credit-control/wise", async original => ({ ...await original<typeof import("@/lib/credit-control/wise")>(), fetchInstituteSessionsForDays: vi.fn() }));
import { fetchInstituteSessionsForDays, type WiseCreditSession } from "@/lib/credit-control/wise";
import { createLiveMonthCache } from "../live-cache";
import { fetchLiveMonthSessions, studentScheduleLiveEnabled } from "../live";

const fetcher = vi.mocked(fetchInstituteSessionsForDays);
const args = { wiseStudentId: "s1", monthKey: "2026-09" };
let entry: LiveMonthEntry | null;
let owner: string | null;
let repository: LiveMonthCache;
const session = (id: string, student: string): WiseCreditSession => ({
  _id: id, classId: { _id: "c1", name: "Math" }, students: [student],
  scheduledStartTime: new Date("2026-09-12T08:00:00Z"), meetingStatus: "UPCOMING",
});
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-11T01:00:00Z"));
  vi.stubEnv("ENABLE_STUDENT_SCHEDULE_LIVE", "true");
  entry = null; owner = null; fetcher.mockReset();
  repository = {
    read: vi.fn(async () => entry),
    claim: vi.fn(async (_key, token) => { if (owner) return false; owner = token; return true; }),
    publish: vi.fn(async (_key, token, sessions, fetchedAt) => {
      if (owner !== token) return false;
      entry = { sessions, fetchedAt, publishedAt: new Date(), retryAfter: null }; owner = null; return true;
    }),
    fail: vi.fn(async (_key, token) => {
      if (owner === token) { owner = null; if (entry) entry.retryAfter = new Date(Date.now() + 30_000); }
    }),
  };
  vi.mocked(createLiveMonthCache).mockReturnValue(repository);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("shared live schedule reads", () => {
  it("honors the opt-out without touching the cache or Wise", async () => {
    vi.stubEnv("ENABLE_STUDENT_SCHEDULE_LIVE", "false");
    expect(studentScheduleLiveEnabled()).toBe(false);
    expect(await fetchLiveMonthSessions(args)).toEqual({ sessions: [], ok: false });
    expect(repository.read).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
  it("shares one institute sweep across students without exposing other students", async () => {
    fetcher.mockResolvedValue([session("one", "s1"), session("two", "s2")]);
    const first = await fetchLiveMonthSessions(args);
    const second = await fetchLiveMonthSessions({ ...args, wiseStudentId: "s2" });
    expect(first.sessions.map(s => s._id)).toEqual(["one"]);
    expect(second.sessions.map(s => s._id)).toEqual(["two"]);
    expect(second.sourceAt).toEqual(first.sourceAt);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][2][0]).toBe("2026-08-31");
    expect(fetcher.mock.calls[0][2].at(-1)).toBe("2026-10-01");
  });
  it("coalesces simultaneous requests, including an explicit refresh", async () => {
    fetcher.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve([session("one", "s1")]), 300)));
    const calls = [fetchLiveMonthSessions(args), fetchLiveMonthSessions({ ...args, wiseStudentId: "s2", forceRefresh: true })];
    await vi.advanceTimersByTimeAsync(500);
    const [a, b] = await Promise.all(calls);
    expect(a.ok).toBe(true); expect(b.ok).toBe(true); expect(b.sessions).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("expires at 60 seconds and explicit refresh bypasses a younger completed cache", async () => {
    fetcher.mockResolvedValue([]);
    await fetchLiveMonthSessions(args);
    await vi.advanceTimersByTimeAsync(59_000);
    await fetchLiveMonthSessions(args); expect(fetcher).toHaveBeenCalledTimes(1);
    await fetchLiveMonthSessions({ ...args, forceRefresh: true }); expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    await fetchLiveMonthSessions(args); expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("retains a verified empty month as complete cached evidence", async () => {
    fetcher.mockResolvedValue([]);
    expect(await fetchLiveMonthSessions(args)).toMatchObject({ ok: true, sessions: [], stale: false });
    await fetchLiveMonthSessions(args); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("keeps the actual source time and cached sessions on error and during cooldown", async () => {
    fetcher.mockResolvedValue([session("one", "s1")]);
    const original = await fetchLiveMonthSessions(args);
    await vi.advanceTimersByTimeAsync(61_000);
    fetcher.mockRejectedValue(new Error("429"));
    const result = await fetchLiveMonthSessions(args);
    expect(result).toMatchObject({ ok: true, stale: true, source: "cache", sourceAt: original.sourceAt });
    expect(result.sessions).toHaveLength(1);
    await fetchLiveMonthSessions({ ...args, forceRefresh: true }); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("does not issue an uncoordinated sweep when the cache store is down", async () => {
    vi.mocked(repository.read).mockRejectedValue(new Error("DB down"));
    expect(await fetchLiveMonthSessions(args)).toEqual({ ok: false, sessions: [] });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("aborts a stalled sweep at the deadline and does not publish partial data", async () => {
    fetcher.mockImplementation(() => new Promise(() => {}));
    const pending = fetchLiveMonthSessions({ ...args, deadlineMs: 10 });
    await vi.advanceTimersByTimeAsync(11);
    expect(await pending).toEqual({ ok: false, sessions: [] });
    expect(fetcher.mock.calls[0][4]?.signal?.aborted).toBe(true);
    expect(repository.publish).not.toHaveBeenCalled();
    expect(repository.fail).toHaveBeenCalledOnce();
  });
  it("rejects a lost lease without publishing another owner's result", async () => {
    fetcher.mockResolvedValue([session("one", "s1")]);
    vi.mocked(repository.publish).mockResolvedValue(false);
    expect(await fetchLiveMonthSessions(args)).toEqual({ ok: false, sessions: [] });
  });
  it("cancels a disconnected caller's sweep and releases its lease", async () => {
    fetcher.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = fetchLiveMonthSessions({ ...args, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    expect(await pending).toEqual({ ok: false, sessions: [] });
    expect(fetcher.mock.calls[0][4]?.signal?.aborted).toBe(true);
    expect(repository.publish).not.toHaveBeenCalled();
    expect(repository.fail).toHaveBeenCalledOnce();
  });
});
