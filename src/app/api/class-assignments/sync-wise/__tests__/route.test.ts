vi.mock("server-only", () => ({}));
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/data-health/cron-audit", () => ({
  withCronInvocationAudit: (_input: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/sync/run-wise-sync", () => ({ runWiseSyncRequest: vi.fn() }));

import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { runWiseSyncRequest } from "@/lib/sync/run-wise-sync";
import { POST } from "../route";

function makeDbMock(rows: {
  latestSuccessRows?: { finishedAt: Date }[];
  runningRows?: { startedAt: Date }[];
  durationRows?: { startedAt: Date; finishedAt: Date | null }[];
} = {}) {
  // Consumed in the exact order the route awaits them: latestSuccess, running, typicalDuration.
  const queue = [rows.latestSuccessRows ?? [], rows.runningRows ?? [], rows.durationRows ?? []];
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn().mockImplementation(() => Promise.resolve(queue.shift() ?? [])),
          })),
        })),
      })),
    })),
  };
}

describe("POST /api/class-assignments/sync-wise", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getDb).mockReturnValue(makeDbMock() as never);
    vi.mocked(runWiseSyncRequest).mockImplementation(async () =>
      NextResponse.json({ success: true, promotedSnapshotId: "snap-1" }) as never);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("returns 401 with no session", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const res = await POST();

    expect(res.status).toBe(401);
    expect(runWiseSyncRequest).not.toHaveBeenCalled();
  });

  it("returns 403 for a non-admin role", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { email: "teacher@example.com", role: "teacher" } } as never);

    const res = await POST();

    expect(res.status).toBe(403);
    expect(runWiseSyncRequest).not.toHaveBeenCalled();
  });

  it("skips without calling runWiseSyncRequest when the latest success is fresh and nothing is running", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { email: "admin@example.com", role: "admin" } } as never);
    vi.mocked(getDb).mockReturnValue(makeDbMock({
      latestSuccessRows: [{ finishedAt: new Date(Date.now() - 5 * 60_000) }],
      runningRows: [],
    }) as never);

    const res = await POST();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ skipped: true, reason: "fresh" });
    expect(runWiseSyncRequest).not.toHaveBeenCalled();
  });

  it("starts a sync and reports typicalDurationMs when the latest success is stale", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { email: "admin@example.com", role: "admin" } } as never);
    vi.mocked(getDb).mockReturnValue(makeDbMock({
      latestSuccessRows: [{ finishedAt: new Date(Date.now() - 20 * 60_000) }],
      runningRows: [],
      durationRows: [
        { startedAt: new Date("2026-05-15T00:00:00.000Z"), finishedAt: new Date("2026-05-15T00:05:00.000Z") },
      ],
    }) as never);

    const res = await POST();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      promotedSnapshotId: "snap-1",
      typicalDurationMs: 5 * 60_000,
    });
    expect(runWiseSyncRequest).toHaveBeenCalledWith({ manualOwner: "admin@example.com" });
  });

  it("still delegates to runWiseSyncRequest (the wait case) when a sync is already running", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { email: "admin@example.com", role: "admin" } } as never);
    vi.mocked(getDb).mockReturnValue(makeDbMock({
      latestSuccessRows: [],
      runningRows: [{ startedAt: new Date("2026-05-15T00:00:00.000Z") }],
    }) as never);
    vi.mocked(runWiseSyncRequest).mockImplementation(async () => NextResponse.json({
      outcome: "running", success: true, skipped: true, alreadyRunning: true,
      runningStartedAt: "2026-05-15T00:00:00.000Z",
    }, { status: 202 }) as never);

    const res = await POST();

    expect(res.status).toBe(202);
    expect(runWiseSyncRequest).toHaveBeenCalledWith({ manualOwner: "admin@example.com" });
  });

  it("returns the paused result for a non-owner admin without touching the DB when automation is paused", async () => {
    vi.stubEnv("WISE_CLASSROOM_AUTOMATION_ENABLED", "false");
    vi.mocked(auth).mockResolvedValue({ user: { email: "admin@example.com", role: "admin" } } as never);

    const res = await POST();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ paused: true, skipped: true, reason: "AUTOMATION_PAUSED" });
    expect(runWiseSyncRequest).not.toHaveBeenCalled();
    expect(getDb).not.toHaveBeenCalled();
  });

  it("still runs the sync for the owner while automation is paused", async () => {
    vi.stubEnv("WISE_CLASSROOM_AUTOMATION_ENABLED", "false");
    vi.mocked(auth).mockResolvedValue({ user: { email: "kevhsh7@gmail.com", role: "admin" } } as never);
    vi.mocked(getDb).mockReturnValue(makeDbMock({
      latestSuccessRows: [{ finishedAt: new Date(Date.now() - 20 * 60_000) }],
      runningRows: [],
    }) as never);

    const res = await POST();

    expect(res.status).toBe(200);
    expect(runWiseSyncRequest).toHaveBeenCalledWith({ manualOwner: "kevhsh7@gmail.com" });
  });
});
