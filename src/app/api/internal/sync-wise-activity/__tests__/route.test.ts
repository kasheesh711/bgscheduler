import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/wise/client", () => ({ createWiseClient: vi.fn() }));
vi.mock("@/lib/wise-activity/sync", () => ({
  WiseActivitySyncAlreadyRunningError: class WiseActivitySyncAlreadyRunningError extends Error {},
  syncWiseActivityEvents: vi.fn(),
}));

import { getDb } from "@/lib/db";
import { createWiseClient } from "@/lib/wise/client";
import { syncWiseActivityEvents } from "@/lib/wise-activity/sync";
import { GET } from "../route";

function request(secret?: string): NextRequest {
  const headers = secret === undefined ? undefined : { authorization: `Bearer ${secret}` };
  return new NextRequest("http://test.local/api/internal/sync-wise-activity", { method: "GET", headers });
}

describe("GET /api/internal/sync-wise-activity", () => {
  const originalCronSecret = process.env.CRON_SECRET;
  const originalInstituteId = process.env.WISE_INSTITUTE_ID;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env.CRON_SECRET = "test-secret";
    process.env.WISE_INSTITUTE_ID = "institute-1";
    vi.mocked(getDb).mockReturnValue({ db: true } as never);
    vi.mocked(createWiseClient).mockReturnValue({ client: true } as never);
    vi.mocked(syncWiseActivityEvents).mockResolvedValue({ syncRunId: "run-1", status: "success" } as never);
  });

  afterEach(() => {
    if (originalCronSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalCronSecret;

    if (originalInstituteId === undefined) delete process.env.WISE_INSTITUTE_ID;
    else process.env.WISE_INSTITUTE_ID = originalInstituteId;
  });

  it("runs the activity sync with a valid cron secret", async () => {
    const res = await GET(request("test-secret"));

    expect(res.status).toBe(200);
    expect(syncWiseActivityEvents).toHaveBeenCalledWith(
      { db: true },
      { client: true },
      "institute-1",
      { triggerType: "cron" },
    );
    await expect(res.json()).resolves.toEqual({
      ok: true,
      result: { syncRunId: "run-1", status: "success" },
    });
  });

  it("rejects requests without the cron secret", async () => {
    const res = await GET(request("wrong-secret"));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(syncWiseActivityEvents).not.toHaveBeenCalled();
  });
});
