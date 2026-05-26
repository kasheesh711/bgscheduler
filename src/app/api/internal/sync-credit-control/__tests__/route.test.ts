import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/wise/client", () => ({ createWiseClient: vi.fn() }));
vi.mock("@/lib/credit-control/sync", () => ({ runCreditControlSync: vi.fn() }));

import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { createWiseClient } from "@/lib/wise/client";
import { runCreditControlSync } from "@/lib/credit-control/sync";
import { GET, POST } from "../route";

const authMock = auth as unknown as Mock;

const successResult = {
  success: true,
  snapshotId: "snapshot-1",
  promotedSnapshotId: "snapshot-1",
  studentCount: 10,
  packageCount: 12,
  sessionCount: 30,
  failedCreditPairs: 0,
};

function makeDbMock(options: {
  runningRows?: { id: string; startedAt: Date }[];
  staleRows?: { id: string }[];
  insertError?: Error & { code?: string };
  duplicateRaceRows?: { id: string; startedAt: Date }[];
} = {}) {
  const runningRows = options.runningRows ?? [];
  const staleRows = options.staleRows ?? [];
  const selectResponses = [runningRows, options.duplicateRaceRows ?? runningRows];

  const updateReturning = vi.fn().mockResolvedValue(staleRows);
  return {
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
            limit: vi.fn().mockImplementation(() => Promise.resolve(selectResponses.shift() ?? runningRows)),
          })),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: options.insertError
          ? vi.fn().mockRejectedValue(options.insertError)
          : vi.fn().mockResolvedValue([{ id: "guard-run-1" }]),
      })),
    })),
  };
}

function request(secret?: string, method: "GET" | "POST" = "POST"): NextRequest {
  const headers = secret === undefined ? undefined : { authorization: `Bearer ${secret}` };
  return new NextRequest("http://test.local/api/internal/sync-credit-control", { method, headers });
}

describe("GET/POST /api/internal/sync-credit-control", () => {
  const originalCronSecret = process.env.CRON_SECRET;
  const originalInstituteId = process.env.WISE_INSTITUTE_ID;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env.CRON_SECRET = "test-secret";
    process.env.WISE_INSTITUTE_ID = "institute-1";
    authMock.mockResolvedValue(null);
    vi.mocked(getDb).mockReturnValue(makeDbMock() as never);
    vi.mocked(createWiseClient).mockReturnValue({ client: true } as never);
    vi.mocked(runCreditControlSync).mockResolvedValue(successResult as never);
  });

  afterEach(() => {
    if (originalCronSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalCronSecret;

    if (originalInstituteId === undefined) delete process.env.WISE_INSTITUTE_ID;
    else process.env.WISE_INSTITUTE_ID = originalInstituteId;
  });

  it("runs the sync with a valid cron secret", async () => {
    const res = await GET(request("test-secret", "GET"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      syncRunId: "guard-run-1",
      staleRunningSyncsFailed: 0,
    });
    expect(runCreditControlSync).toHaveBeenCalledWith(
      expect.any(Object),
      { client: true },
      "institute-1",
      expect.any(Date),
      { syncRunId: "guard-run-1" },
    );
  });

  it("rejects GET without the cron secret", async () => {
    const res = await GET(request("wrong-secret", "GET"));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(runCreditControlSync).not.toHaveBeenCalled();
  });

  it("returns 500 when CRON_SECRET is missing for GET", async () => {
    delete process.env.CRON_SECRET;

    const res = await GET(request(undefined, "GET"));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Server misconfigured" });
    expect(runCreditControlSync).not.toHaveBeenCalled();
  });

  it("allows a signed-in admin to trigger POST manually", async () => {
    authMock.mockResolvedValue({ user: { email: "admin@example.com" }, expires: "2026-05-26T00:00:00.000Z" });

    const res = await POST(request(undefined));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ success: true, syncRunId: "guard-run-1" });
    expect(runCreditControlSync).toHaveBeenCalledTimes(1);
  });

  it("returns 202 and skips when a fresh sync is already running", async () => {
    vi.mocked(getDb).mockReturnValue(makeDbMock({
      runningRows: [{ id: "running-1", startedAt: new Date("2026-05-26T05:00:00.000Z") }],
    }) as never);

    const res = await GET(request("test-secret", "GET"));

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      skipped: true,
      alreadyRunning: true,
      syncRunId: "running-1",
      runningStartedAt: "2026-05-26T05:00:00.000Z",
    });
    expect(runCreditControlSync).not.toHaveBeenCalled();
  });
});
