import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DrizzleQueryError, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  acquireSalesImportRun,
  acquireSalesProjectionImportRun,
  failStaleSalesDashboardImports,
  failStaleSalesDashboardProjectionImports,
  STALE_RUNNING_SALES_IMPORT_MS,
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
  const insertValues = vi.fn(() => ({
    returning: options.insertError
      ? vi.fn().mockRejectedValue(options.insertError)
      : vi.fn().mockResolvedValue([{ id: "import-run-1" }]),
  }));

  return {
    insertValues,
    updateSet,
    updateWhere,
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
      insert: vi.fn(() => ({ values: insertValues })),
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

  it("skips when a DrizzleQueryError-wrapped unique violation (cause.code 23505) loses the race", async () => {
    // drizzle-orm 0.45 wraps every driver error: the SQLSTATE is on `.cause`, `.code` is undefined.
    const wrapped = Object.assign(new Error("Failed query"), { cause: { code: "23505" } });
    const { db } = makeDbMock({
      insertError: wrapped,
      duplicateRaceRows: [{ id: "running-after-race", startedAt: new Date("2026-05-26T04:59:00.000Z") }],
    });

    const result = await acquireSalesImportRun(db as never, acquireInput);

    expect(result).toMatchObject({
      skipped: true,
      alreadyRunning: true,
      runId: "running-after-race",
    });
  });

  it("rethrows a wrapped non-unique insert failure (cause.code 23503) instead of skipping", async () => {
    const wrapped = Object.assign(new Error("Failed query"), { cause: { code: "23503" } });
    const { db } = makeDbMock({
      insertError: wrapped,
      duplicateRaceRows: [{ id: "running-after-race", startedAt: new Date("2026-05-26T04:59:00.000Z") }],
    });

    await expect(acquireSalesImportRun(db as never, acquireInput)).rejects.toBe(wrapped);
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

const projectionInput = {
  sourceId: "projection-1",
  triggerType: "cron" as const,
  actorEmail: "cron@begifted.local",
  now: new Date("2026-05-26T05:00:00.000Z"),
};

const projectionWinner = { id: "running-after-race", startedAt: new Date("2026-05-26T04:59:00.000Z") };

describe("sales dashboard projection import guard", () => {
  it("acquires a run stamped with the request clock when none is running", async () => {
    const { db, insertValues } = makeDbMock();

    const result = await acquireSalesProjectionImportRun(db as never, projectionInput);

    expect(result).toEqual({ runId: "import-run-1", staleRunningImportsFailed: 0 });
    expect(insertValues).toHaveBeenCalledWith({
      sourceId: "projection-1",
      status: "running",
      triggerType: "cron",
      actorEmail: "cron@begifted.local",
      startedAt: projectionInput.now,
    });
  });

  it("skips without inserting when a fresh projection import is already running", async () => {
    const { db } = makeDbMock({
      runningRows: [{ id: "running-1", startedAt: new Date("2026-05-26T04:55:00.000Z") }],
    });

    const result = await acquireSalesProjectionImportRun(db as never, projectionInput);

    expect(result).toEqual({
      sourceId: "projection-1",
      runId: "running-1",
      projectionMonths: 0,
      targetMonthlyRevenue: null,
      skipped: true,
      alreadyRunning: true,
      runningStartedAt: "2026-05-26T04:55:00.000Z",
      staleRunningImportsFailed: 0,
      message: "Sales dashboard projection import is already running.",
    });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it.each([
    ["raw driver error", () => Object.assign(new Error("duplicate"), { code: "23505" })],
    ["DrizzleQueryError-wrapped driver error", () => Object.assign(new Error("Failed query"), { cause: { code: "23505" } })],
    ["real DrizzleQueryError", () => new DrizzleQueryError(
      'insert into "sales_dashboard_projection_import_runs" ("source_id") values ($1)',
      ["projection-1"],
      Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" }),
    )],
  ])("skips naming the winning run when the insert loses the unique race (%s)", async (_label, makeError) => {
    const { db } = makeDbMock({ insertError: makeError(), duplicateRaceRows: [projectionWinner] });

    const result = await acquireSalesProjectionImportRun(db as never, projectionInput);

    expect(result).toEqual({
      sourceId: "projection-1",
      runId: "running-after-race",
      projectionMonths: 0,
      targetMonthlyRevenue: null,
      skipped: true,
      alreadyRunning: true,
      runningStartedAt: "2026-05-26T04:59:00.000Z",
      staleRunningImportsFailed: 0,
      message: "Sales dashboard projection import is already running.",
    });
  });

  it("rethrows the original unique violation when the winning import has already finished", async () => {
    const wrapped = Object.assign(new Error("Failed query"), { cause: { code: "23505" } });
    const { db } = makeDbMock({ insertError: wrapped, duplicateRaceRows: [] });

    await expect(acquireSalesProjectionImportRun(db as never, projectionInput)).rejects.toBe(wrapped);
  });

  it("rethrows a non-unique insert failure (cause.code 23503) without re-reading", async () => {
    const wrapped = Object.assign(new Error("Failed query"), { cause: { code: "23503" } });
    const { db } = makeDbMock({ insertError: wrapped, duplicateRaceRows: [projectionWinner] });

    await expect(acquireSalesProjectionImportRun(db as never, projectionInput)).rejects.toBe(wrapped);
    expect(db.select).toHaveBeenCalledTimes(1); // the pre-check only
  });

  it("fails a stale running projection import, then acquires a fresh run", async () => {
    const { db, updateSet, updateWhere } = makeDbMock({
      staleRows: [{ id: "stale-1", sourceId: "projection-1", metadata: {} }],
    });

    const result = await acquireSalesProjectionImportRun(db as never, projectionInput);

    expect(result).toEqual({ runId: "import-run-1", staleRunningImportsFailed: 1 });
    expect(updateSet).toHaveBeenCalledTimes(1); // projection imports never flip a source status
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed",
      finishedAt: projectionInput.now,
      errorSummary: expect.stringContaining("Sales dashboard projection import marked failed because it was still running after 20 minutes"),
    }));
    expect(db.insert).toHaveBeenCalledTimes(1);

    // The sweep is scoped to this source and reclaims only RUNNING rows older than the lease
    // (the timestamp column encodes the Date parameter as an ISO string).
    const sweepFilter = new PgDialect().sqlToQuery((updateWhere.mock.calls as unknown as Array<[SQL]>)[0][0]);
    expect(sweepFilter.sql).toBe(
      '("sales_dashboard_projection_import_runs"."source_id" = $1 and "sales_dashboard_projection_import_runs"."status" = $2 and "sales_dashboard_projection_import_runs"."started_at" < $3)',
    );
    expect(sweepFilter.params).toEqual([
      "projection-1",
      "running",
      new Date(projectionInput.now.getTime() - STALE_RUNNING_SALES_IMPORT_MS).toISOString(),
    ]);
  });

  it("counts failed stale projection imports for the source", async () => {
    const { db } = makeDbMock({
      staleRows: [
        { id: "stale-1", sourceId: "projection-1", metadata: {} },
        { id: "stale-2", sourceId: "projection-1", metadata: {} },
      ],
    });

    await expect(
      failStaleSalesDashboardProjectionImports(db as never, "projection-1", new Date("2026-05-26T05:30:00.000Z")),
    ).resolves.toBe(2);
  });
});

describe("sales dashboard import lease", () => {
  // Monthly and projection imports share this lease and the same 800 s entry
  // routes; it may only reclaim a run whose function is certainly dead. Read as
  // text because importing a route pulls in the Next/auth graph.
  it.each([
    ["projection-import", ["src", "app", "api", "sales-dashboard", "projection-import", "route.ts"]],
    ["sync-sales-dashboard", ["src", "app", "api", "internal", "sync-sales-dashboard", "route.ts"]],
    ["data-health job runner", ["src", "app", "api", "data-health", "jobs", "[jobKey]", "run", "route.ts"]],
  ])("stays longer than the %s route maxDuration", (_label, segments) => {
    const source = readFileSync(path.join(process.cwd(), ...segments), "utf8");
    const declared = /export const maxDuration = (\d+)/.exec(source);

    expect(declared).not.toBeNull();
    expect(STALE_RUNNING_SALES_IMPORT_MS).toBeGreaterThan(Number(declared?.[1]) * 1000);
  });
});
