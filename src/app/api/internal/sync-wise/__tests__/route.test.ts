import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next/cache", () => ({ revalidateTag: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/wise/client", () => ({ createWiseClient: vi.fn() }));
vi.mock("@/lib/sync/orchestrator", () => ({ runFullSync: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { revalidateTag } from "next/cache";
import { getDb } from "@/lib/db";
import { createWiseClient } from "@/lib/wise/client";
import { runFullSync } from "@/lib/sync/orchestrator";
import { auth } from "@/lib/auth";
import { GET, POST } from "@/app/api/internal/sync-wise/route";

const successResult = {
  success: true,
  syncRunId: "run-1",
  snapshotId: "snap-1",
  promotedSnapshotId: "snap-1",
  teacherCount: 131,
  groupCount: 72,
  issueCount: 3,
  errorSummary: null,
  durationMs: 250,
};

const failedResult = {
  ...successResult,
  success: false,
  promotedSnapshotId: null,
  errorSummary: "Wise failed",
};

function makeDbMock(options: {
  runningRows?: { id: string; startedAt: Date }[];
  staleRows?: { id: string }[];
  insertError?: Error & { code?: string };
  duplicateRaceRows?: { id: string; startedAt: Date }[];
} = {}) {
  const runningRows = options.runningRows ?? [];
  const staleRows = options.staleRows ?? [];
  const insertRows = [{ id: "guard-run-1" }];
  const selectResponses = [runningRows, options.duplicateRaceRows ?? runningRows];

  const updateReturning = vi.fn().mockResolvedValue(staleRows);
  const db = {
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: updateReturning,
        })),
      })),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn().mockImplementation(() => (
              Promise.resolve(selectResponses.shift() ?? runningRows)
            )),
          })),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: options.insertError
          ? vi.fn().mockRejectedValue(options.insertError)
          : vi.fn().mockResolvedValue(insertRows),
      })),
    })),
  };

  return db;
}

describe("GET/POST /api/internal/sync-wise", () => {
  const originalCronSecret = process.env.CRON_SECRET;
  const originalInstituteId = process.env.WISE_INSTITUTE_ID;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env.CRON_SECRET = "test-secret";
    process.env.WISE_INSTITUTE_ID = "institute-1";
    vi.mocked(getDb).mockReturnValue(makeDbMock() as never);
    vi.mocked(createWiseClient).mockReturnValue({ client: true } as never);
    vi.mocked(runFullSync).mockResolvedValue(successResult as never);
    vi.mocked(auth).mockResolvedValue(null as never);
  });

  afterEach(() => {
    if (originalCronSecret === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = originalCronSecret;
    }

    if (originalInstituteId === undefined) {
      delete process.env.WISE_INSTITUTE_ID;
    } else {
      process.env.WISE_INSTITUTE_ID = originalInstituteId;
    }
  });

  function makeRequest(secret?: string, method: "GET" | "POST" = "POST"): NextRequest {
    const headers = secret === undefined ? undefined : { authorization: `Bearer ${secret}` };
    return new NextRequest("http://localhost/api/internal/sync-wise", { method, headers });
  }

  it("returns 401 when POST Authorization is missing and no session exists", async () => {
    const res = await POST(makeRequest(undefined));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(runFullSync).not.toHaveBeenCalled();
  });

  it("returns 401 when POST CRON_SECRET does not match and no session exists", async () => {
    const res = await POST(makeRequest("wrong-secret"));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(runFullSync).not.toHaveBeenCalled();
  });

  it("returns 500 when CRON_SECRET is missing from the server environment", async () => {
    delete process.env.CRON_SECRET;

    const res = await POST(makeRequest("test-secret"));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Server misconfigured" });
    expect(runFullSync).not.toHaveBeenCalled();
  });

  it("returns 200 when POST has a valid session and CRON_SECRET is missing", async () => {
    delete process.env.CRON_SECRET;
    vi.mocked(auth).mockResolvedValue({
      user: { email: "kevinhsieh711@gmail.com" },
      expires: "2026-05-06T00:00:00.000Z",
    } as never);

    const res = await POST(makeRequest(undefined));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      syncRunId: "run-1",
    });
    expect(runFullSync).toHaveBeenCalledWith(expect.any(Object), { client: true }, "institute-1", {
      syncRunId: "guard-run-1",
    });
  });

  it("keeps GET blocked when CRON_SECRET is missing even with a valid session", async () => {
    delete process.env.CRON_SECRET;
    vi.mocked(auth).mockResolvedValue({
      user: { email: "kevinhsieh711@gmail.com" },
      expires: "2026-05-06T00:00:00.000Z",
    } as never);

    const res = await GET(makeRequest(undefined, "GET"));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Server misconfigured" });
    expect(runFullSync).not.toHaveBeenCalled();
  });

  it("returns 200 and revalidates snapshot data when POST sync succeeds", async () => {
    const res = await POST(makeRequest("test-secret"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      syncRunId: "run-1",
      promotedSnapshotId: "snap-1",
    });
    expect(runFullSync).toHaveBeenCalledWith(expect.any(Object), { client: true }, "institute-1", {
      syncRunId: "guard-run-1",
    });
    expect(revalidateTag).toHaveBeenCalledWith("snapshot", { expire: 0 });
  });

  it("returns 200 when POST has no Authorization header but has a valid session", async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { email: "kevinhsieh711@gmail.com" },
      expires: "2026-05-06T00:00:00.000Z",
    } as never);

    const res = await POST(makeRequest(undefined));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      syncRunId: "run-1",
    });
    expect(runFullSync).toHaveBeenCalledWith(expect.any(Object), { client: true }, "institute-1", {
      syncRunId: "guard-run-1",
    });
    expect(revalidateTag).toHaveBeenCalledWith("snapshot", { expire: 0 });
  });

  it("returns 200 when POST has an invalid cron secret but has a valid session", async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { email: "kevinhsieh711@gmail.com" },
      expires: "2026-05-06T00:00:00.000Z",
    } as never);

    const res = await POST(makeRequest("wrong-secret"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      syncRunId: "run-1",
    });
    expect(runFullSync).toHaveBeenCalledWith(expect.any(Object), { client: true }, "institute-1", {
      syncRunId: "guard-run-1",
    });
  });

  it("returns 500 and skips revalidation when runFullSync reports failure", async () => {
    vi.mocked(runFullSync).mockResolvedValue(failedResult as never);

    const res = await POST(makeRequest("test-secret"));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({
      success: false,
      errorSummary: "Wise failed",
    });
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("applies the same CRON_SECRET gate to GET", async () => {
    const res = await GET(makeRequest("test-secret", "GET"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ success: true, syncRunId: "run-1" });
    expect(runFullSync).toHaveBeenCalledWith(expect.any(Object), { client: true }, "institute-1", {
      syncRunId: "guard-run-1",
    });
  });

  it("returns 202 and skips the sync when a fresh run is already active", async () => {
    vi.mocked(getDb).mockReturnValue(makeDbMock({
      runningRows: [{ id: "running-1", startedAt: new Date("2026-05-18T15:00:00.000Z") }],
    }) as never);

    const res = await GET(makeRequest("test-secret", "GET"));

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      skipped: true,
      alreadyRunning: true,
      syncRunId: "running-1",
      runningStartedAt: "2026-05-18T15:00:00.000Z",
    });
    expect(runFullSync).not.toHaveBeenCalled();
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("returns the stale-running cleanup count when stale rows were failed before sync", async () => {
    vi.mocked(getDb).mockReturnValue(makeDbMock({
      staleRows: [{ id: "stale-1" }, { id: "stale-2" }],
    }) as never);

    const res = await GET(makeRequest("test-secret", "GET"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      staleRunningSyncsFailed: 2,
    });
    expect(runFullSync).toHaveBeenCalledWith(expect.any(Object), { client: true }, "institute-1", {
      syncRunId: "guard-run-1",
    });
  });

  it("returns 202 when the database unique lock is won by another request", async () => {
    const duplicate = Object.assign(new Error("duplicate"), { code: "23505" });
    vi.mocked(getDb).mockReturnValue(makeDbMock({
      insertError: duplicate,
      duplicateRaceRows: [{ id: "running-after-race", startedAt: new Date("2026-05-18T15:03:00.000Z") }],
    }) as never);

    const res = await GET(makeRequest("test-secret", "GET"));

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toMatchObject({
      skipped: true,
      alreadyRunning: true,
      syncRunId: "running-after-race",
    });
    expect(runFullSync).not.toHaveBeenCalled();
  });

  it("returns 401 when GET has no Authorization header even with a valid session", async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { email: "kevinhsieh711@gmail.com" },
      expires: "2026-05-06T00:00:00.000Z",
    } as never);

    const res = await GET(makeRequest(undefined, "GET"));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(runFullSync).not.toHaveBeenCalled();
  });
});
