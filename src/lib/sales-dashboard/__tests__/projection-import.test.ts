import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
  revalidateTag: vi.fn(),
}));
vi.mock("@/lib/sales-dashboard/sheets", () => ({
  fetchGoogleSheetRows: vi.fn(),
  listGoogleSheetTitles: vi.fn(),
}));
// Keep the DEFAULT_* constants; only the workbook parser is stubbed.
vi.mock("@/lib/sales-dashboard/projection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sales-dashboard/projection")>()),
  parseSalesProjectionWorkbook: vi.fn(),
}));

import { revalidateTag } from "next/cache";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import {
  importActiveSalesDashboardProjectionSource,
  importSalesDashboardProjectionSource,
} from "@/lib/sales-dashboard/data";
import {
  DEFAULT_PROJECTION_CALC_MULTI_SHEET,
  DEFAULT_PROJECTION_SUMMARY_SHEET,
  DEFAULT_PROJECTION_WHAT_IF_SHEET,
  parseSalesProjectionWorkbook,
} from "@/lib/sales-dashboard/projection";
import { fetchGoogleSheetRows, listGoogleSheetTitles } from "@/lib/sales-dashboard/sheets";
import type { ParsedSalesProjectionWorkbook } from "@/lib/sales-dashboard/types";

/**
 * Wiring test for the REAL importSalesDashboardProjectionSource. Both projection
 * route suites mock data.ts and import-guard.test.ts exercises the guard in
 * isolation, so without this suite nothing would notice the import reverting to a
 * raw insert or the `lastImportError: null` source update moving above the guard.
 */

type SourceRow = typeof schema.salesDashboardProjectionSources.$inferSelect;

interface RunningRow {
  id: string;
  startedAt: Date;
}

const NOW = new Date("2026-09-29T09:00:00.000Z");
const IMPORT_OPTIONS = { triggerType: "cron" as const, actorEmail: "cron@begifted.local", now: NOW };
const TARGET_MONTHLY_REVENUE = 750_000;

const SOURCE: SourceRow = {
  id: "projection-source-1",
  spreadsheetId: "projection-sheet-1",
  spreadsheetUrl: "https://docs.google.com/spreadsheets/d/projection-sheet-1/edit",
  summarySheetName: DEFAULT_PROJECTION_SUMMARY_SHEET,
  whatIfSheetName: DEFAULT_PROJECTION_WHAT_IF_SHEET,
  calcMultiSheetName: DEFAULT_PROJECTION_CALC_MULTI_SHEET,
  status: "active",
  lastSuccessfulImportRunId: null,
  lastImportedAt: null,
  lastImportError: null,
  lastProjectionMonthCount: 0,
  lastTargetMonthlyRevenue: null,
  connectedEmail: "sales@begifted.local",
  createdByEmail: "admin@begifted.local",
  updatedByEmail: "admin@begifted.local",
  createdAt: new Date("2026-05-01T00:00:00.000Z"),
  updatedAt: new Date("2026-05-01T00:00:00.000Z"),
};

// Typed against the real parser result so the stub cannot drift from it.
const PARSED_WORKBOOK: ParsedSalesProjectionWorkbook = {
  targetMonthlyRevenue: TARGET_MONTHLY_REVENUE,
  scenarioSummaries: [],
  months: [],
  metadata: {},
};

const LIVE_RUN: RunningRow = { id: "live-run", startedAt: new Date("2026-09-29T08:55:00.000Z") };

// Db calls are routed by the table object they receive (identity against the
// imported schema), so assertions can say WHICH table a write touched.
const TABLE_LABELS = new Map<unknown, string>([
  [schema.salesDashboardProjectionSources, "sources"],
  [schema.salesDashboardProjectionImportRuns, "runs"],
]);
const labelOf = (table: unknown) => TABLE_LABELS.get(table) ?? "unexpected table";

function makeDb(options: {
  /** Active projection source; `null` = none configured. */
  source?: SourceRow | null;
  /** One response per read of the running run: the guard's pre-check first, then the post-race re-read. */
  runningReads?: RunningRow[][];
  /** Rows the stale sweep's `.returning()` reports as reclaimed. */
  staleRows?: Array<{ id: string }>;
  /** When present, the run insert rejects with it. */
  insertError?: unknown;
} = {}) {
  const activeSource = options.source === undefined ? SOURCE : options.source;
  const runningReads = [...(options.runningReads ?? [[]])];
  const updates: Array<{ table: string; values: Record<string, unknown> }> = [];
  const inserts: Array<{ table: string; values: Record<string, unknown> }> = [];

  // getActiveSalesDashboardProjectionSource ends in `.limit(1)`; the guard's reads go through `.orderBy().limit(1)`.
  const select = vi.fn(() => ({
    from: (table: unknown) => {
      const limit = vi.fn(() => {
        if (table === schema.salesDashboardProjectionSources) {
          return Promise.resolve(activeSource ? [activeSource] : []);
        }
        if (table === schema.salesDashboardProjectionImportRuns) {
          return Promise.resolve(runningReads.shift() ?? []);
        }
        return Promise.reject(new Error(`unexpected select from ${labelOf(table)}`));
      });
      return { where: () => ({ limit, orderBy: () => ({ limit }) }) };
    },
  }));

  const sweepReturning = vi.fn(() => Promise.resolve(options.staleRows ?? []));
  const update = vi.fn((table: unknown) => ({
    set: (values: Record<string, unknown>) => {
      updates.push({ table: labelOf(table), values });
      // The stale sweep awaits `.where().returning()`; every other update awaits `.where()` itself.
      return { where: () => Object.assign(Promise.resolve([]), { returning: sweepReturning }) };
    },
  }));

  const insertReturning = "insertError" in options
    ? vi.fn().mockRejectedValue(options.insertError)
    : vi.fn().mockResolvedValue([{ id: "new-run" }]);
  const insert = vi.fn((table: unknown) => ({
    values: (values: Record<string, unknown>) => {
      inserts.push({ table: labelOf(table), values });
      return { returning: insertReturning };
    },
  }));

  return {
    db: { select, update, insert } as unknown as Database,
    insert,
    inserts,
    update,
    updates,
  };
}

function skippedOutcome(running: RunningRow, staleRunningImportsFailed = 0) {
  return {
    sourceId: SOURCE.id,
    runId: running.id,
    projectionMonths: 0,
    targetMonthlyRevenue: null,
    skipped: true,
    alreadyRunning: true,
    runningStartedAt: running.startedAt.toISOString(),
    staleRunningImportsFailed,
    message: "Sales dashboard projection import is already running.",
  };
}

describe("importSalesDashboardProjectionSource single-flight wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listGoogleSheetTitles).mockResolvedValue([
      DEFAULT_PROJECTION_SUMMARY_SHEET,
      DEFAULT_PROJECTION_WHAT_IF_SHEET,
      DEFAULT_PROJECTION_CALC_MULTI_SHEET,
    ]);
    vi.mocked(fetchGoogleSheetRows).mockResolvedValue([]);
    vi.mocked(parseSalesProjectionWorkbook).mockReturnValue(PARSED_WORKBOOK);
  });

  it("skips a fresh running import before touching the source row or the workbook", async () => {
    const { db, insert, updates } = makeDb({ runningReads: [[LIVE_RUN]] });

    const result = await importSalesDashboardProjectionSource(SOURCE.id, IMPORT_OPTIONS, db);

    expect(result).toEqual(skippedOutcome(LIVE_RUN));
    expect(insert).not.toHaveBeenCalled();
    // Only the guard's stale sweep (runs table) may write: the running import owns the source's lastImportError.
    expect(updates.filter((update) => update.table !== "runs")).toEqual([]);
    expect(listGoogleSheetTitles).not.toHaveBeenCalled();
    expect(fetchGoogleSheetRows).not.toHaveBeenCalled();
    expect(parseSalesProjectionWorkbook).not.toHaveBeenCalled();
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("fails a stale run, inserts a fresh one stamped with the request clock, and only then touches the source row", async () => {
    const { db, insert, inserts, update, updates } = makeDb({ staleRows: [{ id: "stale-run" }] });

    const result = await importSalesDashboardProjectionSource(SOURCE.id, IMPORT_OPTIONS, db);

    expect(result).toEqual({
      sourceId: SOURCE.id,
      runId: "new-run",
      projectionMonths: 0,
      targetMonthlyRevenue: TARGET_MONTHLY_REVENUE,
      staleRunningImportsFailed: 1,
    });

    // The guard's sweep is the first write, and it fails the stale row with the request clock.
    expect(updates[0]).toEqual({
      table: "runs",
      values: expect.objectContaining({ status: "failed", finishedAt: NOW }),
    });
    expect(inserts).toEqual([{
      table: "runs",
      values: expect.objectContaining({
        sourceId: SOURCE.id,
        status: "running",
        triggerType: "cron",
        actorEmail: "cron@begifted.local",
      }),
    }]);
    expect(inserts[0].values.startedAt).toBe(NOW);

    // The source row is only touched once the new run row exists.
    const firstSourceUpdate = update.mock.calls.findIndex(([table]) => table === schema.salesDashboardProjectionSources);
    expect(firstSourceUpdate).toBeGreaterThanOrEqual(0);
    expect(update.mock.invocationCallOrder[firstSourceUpdate]).toBeGreaterThan(insert.mock.invocationCallOrder[0]);
    expect(updates[firstSourceUpdate]).toEqual({
      table: "sources",
      values: expect.objectContaining({ lastImportError: null, updatedAt: NOW, updatedByEmail: "cron@begifted.local" }),
    });

    // Success bookkeeping is keyed to the run id the guard returned.
    expect(updates).toContainEqual({
      table: "runs",
      values: expect.objectContaining({ status: "success", targetMonthlyRevenue: TARGET_MONTHLY_REVENUE }),
    });
    expect(updates).toContainEqual({
      table: "sources",
      values: expect.objectContaining({ lastSuccessfulImportRunId: "new-run", lastTargetMonthlyRevenue: TARGET_MONTHLY_REVENUE }),
    });
    expect(revalidateTag).toHaveBeenCalledTimes(1);
  });

  it("names the winner when the insert loses the unique race, still without touching the source row", async () => {
    // DrizzleQueryError shape: the SQLSTATE is on `.cause`.
    const lostRace = Object.assign(new Error("Failed query"), { cause: { code: "23505" } });
    const { db, updates } = makeDb({ runningReads: [[], [LIVE_RUN]], insertError: lostRace });

    const result = await importSalesDashboardProjectionSource(SOURCE.id, IMPORT_OPTIONS, db);

    expect(result).toEqual(skippedOutcome(LIVE_RUN));
    expect(updates.filter((update) => update.table !== "runs")).toEqual([]);
    expect(listGoogleSheetTitles).not.toHaveBeenCalled();
  });
});

describe("importActiveSalesDashboardProjectionSource", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listGoogleSheetTitles).mockResolvedValue([]);
  });

  it("returns null without writing anything when no projection source is active", async () => {
    const { db, insert, updates } = makeDb({ source: null });

    await expect(importActiveSalesDashboardProjectionSource(IMPORT_OPTIONS, db)).resolves.toBeNull();

    expect(insert).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it("passes a skipped outcome straight through", async () => {
    const { db } = makeDb({ runningReads: [[LIVE_RUN]] });

    await expect(importActiveSalesDashboardProjectionSource(IMPORT_OPTIONS, db)).resolves.toEqual(
      skippedOutcome(LIVE_RUN),
    );
    expect(listGoogleSheetTitles).not.toHaveBeenCalled();
  });
});
