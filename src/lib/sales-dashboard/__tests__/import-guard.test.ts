import { describe, expect, it, vi } from "vitest";
import {
  acquireSalesImportRun,
  failStaleSalesDashboardImports,
} from "@/lib/sales-dashboard/import-guard";

function makeDbMock(options: {
  runningRows?: { id: string; startedAt: Date }[];
  staleRows?: Array<{ id: string; sourceId: string | null; metadata: Record<string, unknown> }>;
  insertError?: Error & { code?: string };
  duplicateRaceRows?: { id: string; startedAt: Date }[];
} = {}) {
  const runningRows = options.runningRows ?? [];
  const staleRows = options.staleRows ?? [];
  const selectResponses = [runningRows, options.duplicateRaceRows ?? runningRows];
  const updateReturning = vi.fn().mockResolvedValue(staleRows);
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));

  return {
    updateSet,
    db: {
      update: vi.fn(() => ({ set: updateSet })),
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
            : vi.fn().mockResolvedValue([{ id: "import-run-1" }]),
        })),
      })),
    },
  };
}

const acquireInput = {
  sourceId: "source-1",
  sourceLabel: "May 2026",
  previousStatus: "active" as const,
  triggerType: "cron" as const,
  actorEmail: "cron@begifted.local",
  now: new Date("2026-05-26T05:00:00.000Z"),
};

describe("sales dashboard import guard", () => {
  it("acquires a new import run when no source import is running", async () => {
    const { db } = makeDbMock();

    const result = await acquireSalesImportRun(db as never, acquireInput);

    expect(result).toEqual({ runId: "import-run-1", staleRunningImportsFailed: 0 });
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it("skips when a fresh import for the source is already running", async () => {
    const { db } = makeDbMock({
      runningRows: [{ id: "running-1", startedAt: new Date("2026-05-26T04:55:00.000Z") }],
    });

    const result = await acquireSalesImportRun(db as never, acquireInput);

    expect(result).toMatchObject({
      sourceId: "source-1",
      runId: "running-1",
      normalRows: 0,
      additionalRows: 0,
      skipped: true,
      alreadyRunning: true,
      runningStartedAt: "2026-05-26T04:55:00.000Z",
    });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("skips when another request wins the unique-index race", async () => {
    const duplicate = Object.assign(new Error("duplicate"), { code: "23505" });
    const { db } = makeDbMock({
      insertError: duplicate,
      duplicateRaceRows: [{ id: "running-after-race", startedAt: new Date("2026-05-26T04:59:00.000Z") }],
    });

    const result = await acquireSalesImportRun(db as never, acquireInput);

    expect(result).toMatchObject({
      skipped: true,
      alreadyRunning: true,
      runId: "running-after-race",
    });
  });

  it("marks stale running imports failed and restores the previous source status", async () => {
    const { db, updateSet } = makeDbMock({
      staleRows: [{
        id: "stale-1",
        sourceId: "source-1",
        metadata: { previousStatus: "reopened" },
      }],
    });

    const result = await failStaleSalesDashboardImports(
      db as never,
      "source-1",
      new Date("2026-05-26T05:30:00.000Z"),
    );

    expect(result).toBe(1);
    expect(updateSet).toHaveBeenNthCalledWith(1, expect.objectContaining({
      status: "failed",
      errorSummary: expect.stringContaining("still running after 20 minutes"),
    }));
    expect(updateSet).toHaveBeenNthCalledWith(2, expect.objectContaining({
      status: "reopened",
    }));
  });
});
