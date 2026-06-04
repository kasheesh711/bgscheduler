import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/wise/client", () => ({ createWiseClient: vi.fn() }));
vi.mock("@/lib/progress-tests/sync", () => ({ runProgressTestSync: vi.fn() }));

import { getDb } from "@/lib/db";
import { createWiseClient } from "@/lib/wise/client";
import { runProgressTestSync } from "@/lib/progress-tests/sync";
import { runProgressTestSyncRequest } from "@/lib/progress-tests/run-sync-request";

const successResult = {
  success: true,
  ledgerRowCount: 5,
  enrollmentCount: 3,
  approachingCount: 1,
  dueCount: 1,
  unresolvedTeacherCount: 0,
};

function makeDbMock(options: {
  runningRows?: { id: string; startedAt: Date }[];
  staleRows?: { id: string }[];
} = {}) {
  const runningRows = options.runningRows ?? [];
  const staleRows = options.staleRows ?? [];

  return {
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue(staleRows),
        })),
      })),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue(runningRows),
          })),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([{ id: "guard-run-1" }]),
      })),
    })),
  };
}

describe("runProgressTestSyncRequest", () => {
  const originalInstituteId = process.env.WISE_INSTITUTE_ID;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env.WISE_INSTITUTE_ID = "institute-1";
    vi.mocked(getDb).mockReturnValue(makeDbMock() as never);
    vi.mocked(createWiseClient).mockReturnValue({ client: true } as never);
    vi.mocked(runProgressTestSync).mockResolvedValue(successResult as never);
  });

  afterEach(() => {
    if (originalInstituteId === undefined) delete process.env.WISE_INSTITUTE_ID;
    else process.env.WISE_INSTITUTE_ID = originalInstituteId;
  });

  it("acquires a run row and runs the sync when nothing is running", async () => {
    const res = await runProgressTestSyncRequest({ triggerType: "cron" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      syncRunId: "guard-run-1",
      staleRunningSyncsFailed: 0,
    });
    expect(runProgressTestSync).toHaveBeenCalledWith(
      expect.objectContaining({ instituteId: "institute-1", syncRunId: "guard-run-1" }),
    );
  });

  it("returns 202 and skips when a fresh sync is already running (single-flight)", async () => {
    vi.mocked(getDb).mockReturnValue(makeDbMock({
      runningRows: [{ id: "running-1", startedAt: new Date("2026-05-26T05:00:00.000Z") }],
    }) as never);

    const res = await runProgressTestSyncRequest({ triggerType: "cron" });

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      skipped: true,
      alreadyRunning: true,
      syncRunId: "running-1",
      runningStartedAt: "2026-05-26T05:00:00.000Z",
    });
    expect(runProgressTestSync).not.toHaveBeenCalled();
  });

  it("reports stale running syncs failed during acquisition", async () => {
    vi.mocked(getDb).mockReturnValue(makeDbMock({
      staleRows: [{ id: "stale-1" }, { id: "stale-2" }],
    }) as never);

    const res = await runProgressTestSyncRequest({ triggerType: "cron" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ staleRunningSyncsFailed: 2 });
  });

  it("returns 500 when the sync itself fails", async () => {
    vi.mocked(runProgressTestSync).mockResolvedValue({
      ...successResult,
      success: false,
      errorSummary: "boom",
    } as never);

    const res = await runProgressTestSyncRequest({ triggerType: "cron" });

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ success: false, errorSummary: "boom" });
  });
});
