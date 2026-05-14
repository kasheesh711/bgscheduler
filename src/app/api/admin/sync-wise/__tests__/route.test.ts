import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidateTag: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/wise/client", () => ({ createWiseClient: vi.fn() }));
vi.mock("@/lib/sync/orchestrator", () => ({ runFullSync: vi.fn() }));

import { revalidateTag } from "next/cache";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { createWiseClient } from "@/lib/wise/client";
import { runFullSync } from "@/lib/sync/orchestrator";
import { POST } from "@/app/api/admin/sync-wise/route";

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

describe("POST /api/admin/sync-wise", () => {
  const originalInstituteId = process.env.WISE_INSTITUTE_ID;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env.WISE_INSTITUTE_ID = "institute-1";
    vi.mocked(auth).mockResolvedValue({
      user: { email: "kevinhsieh711@gmail.com" },
      expires: "2026-05-14T00:00:00.000Z",
    } as never);
    vi.mocked(getDb).mockReturnValue({ db: true } as never);
    vi.mocked(createWiseClient).mockReturnValue({ client: true } as never);
    vi.mocked(runFullSync).mockResolvedValue(successResult as never);
  });

  afterEach(() => {
    if (originalInstituteId === undefined) {
      delete process.env.WISE_INSTITUTE_ID;
    } else {
      process.env.WISE_INSTITUTE_ID = originalInstituteId;
    }
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const res = await POST();

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(runFullSync).not.toHaveBeenCalled();
  });

  it("runs the Wise sync for an authenticated admin session", async () => {
    const res = await POST();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      syncRunId: "run-1",
      promotedSnapshotId: "snap-1",
    });
    expect(runFullSync).toHaveBeenCalledWith({ db: true }, { client: true }, "institute-1");
    expect(revalidateTag).toHaveBeenCalledWith("snapshot", { expire: 0 });
  });

  it("returns 500 and skips revalidation when sync fails", async () => {
    vi.mocked(runFullSync).mockResolvedValue(failedResult as never);

    const res = await POST();

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({
      success: false,
      errorSummary: "Wise failed",
    });
    expect(revalidateTag).not.toHaveBeenCalled();
  });
});
