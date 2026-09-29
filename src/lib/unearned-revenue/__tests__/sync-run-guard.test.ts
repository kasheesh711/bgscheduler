import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DrizzleQueryError } from "drizzle-orm";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/sales-dashboard/sheets", () => ({
  fetchGoogleSheetRange: vi.fn(),
  listGoogleSheetProperties: vi.fn(),
  quoteGoogleSheetName: vi.fn((name: string) => name),
}));

import type { Database } from "@/lib/db";
import { fetchGoogleSheetRange, listGoogleSheetProperties } from "@/lib/sales-dashboard/sheets";
import {
  runUnearnedRevenueSync,
  STALE_RUNNING_UNEARNED_REVENUE_SYNC_MS,
} from "@/lib/unearned-revenue/sync";

// drizzle-orm 0.45 wraps every driver error in DrizzleQueryError: the SQLSTATE
// lives on `.cause`, `.code` is undefined and `.message` is "Failed query: ...".
// Raw `.code` errors (a driver error that reaches the guard unwrapped) stay
// supported as a defensive fallback, so both shapes must work.
const rawUnique = () =>
  Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
const wrappedUnique = () =>
  Object.assign(new Error("Failed query"), { cause: { code: "23505" } });
const realWrappedUnique = () =>
  new DrizzleQueryError(
    'insert into "unearned_revenue_sync_runs" ("status") values ($1)',
    ["running"],
    rawUnique(),
  );

interface RunningRow {
  id: string;
  startedAt: Date;
}

const WINNER: RunningRow = { id: "winner-run", startedAt: new Date("2026-09-29T08:00:00.000Z") };

function makeDb(options: {
  /** One response per select().from().where().orderBy().limit(): the pre-check first, then the post-race re-read. */
  selects?: RunningRow[][];
  /** Rows the stale sweep's `.returning()` reports as reclaimed. */
  staleRows?: Array<{ id: string }>;
  /** When present, the run insert rejects with it (null and strings included). */
  insertError?: unknown;
} = {}) {
  const selects = [...(options.selects ?? [[]])];
  const returning = vi.fn().mockResolvedValue(options.staleRows ?? []);
  // The stale sweep awaits `.where().returning()`; the failure path awaits `.where()` itself.
  const where = vi.fn(() => Object.assign(Promise.resolve([]), { returning }));
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  const limit = vi.fn(() => Promise.resolve(selects.shift() ?? []));
  const select = vi.fn(() => ({
    from: () => ({ where: () => ({ orderBy: () => ({ limit }) }) }),
  }));
  const insertReturning = "insertError" in options
    ? vi.fn().mockRejectedValue(options.insertError)
    : vi.fn().mockResolvedValue([{ id: "new-run" }]);
  const values = vi.fn(() => ({ returning: insertReturning }));
  const insert = vi.fn(() => ({ values }));

  return {
    db: { update, select, insert } as unknown as Database,
    insert,
    select,
    set,
    values,
  };
}

function skippedResult(running: RunningRow, staleRunningSyncsFailed = 0) {
  return {
    ok: true,
    skipped: true,
    idempotent: false,
    syncRunId: running.id,
    snapshotId: null,
    cutoff: null,
    counts: null,
    alreadyRunning: true,
    runningStartedAt: running.startedAt.toISOString(),
    message: "Unearned revenue sync is already running. Data will refresh when that run finishes.",
    staleRunningSyncsFailed,
  };
}

describe("runUnearnedRevenueSync single-flight guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["raw driver error", rawUnique],
    ["DrizzleQueryError-wrapped driver error", wrappedUnique],
    ["real DrizzleQueryError", realWrappedUnique],
  ])("skips naming the winning run when the insert loses the unique race (%s)", async (_label, makeError) => {
    const { db } = makeDb({ selects: [[], [WINNER]], insertError: makeError() });

    const result = await runUnearnedRevenueSync({ triggerType: "cron", db });

    expect(result).toEqual(skippedResult(WINNER));
    expect(listGoogleSheetProperties).not.toHaveBeenCalled();
    expect(fetchGoogleSheetRange).not.toHaveBeenCalled();
  });

  it("skips without inserting when the pre-check finds a fresh running run", async () => {
    const { db, insert } = makeDb({ selects: [[WINNER]] });

    const result = await runUnearnedRevenueSync({ triggerType: "cron", db });

    expect(result).toEqual(skippedResult(WINNER));
    expect(insert).not.toHaveBeenCalled();
    expect(listGoogleSheetProperties).not.toHaveBeenCalled();
  });

  it("fails a stale running row, then proceeds under a fresh run id", async () => {
    vi.mocked(listGoogleSheetProperties).mockRejectedValueOnce(new Error("sheets unavailable"));
    const { db, set, values } = makeDb({ selects: [[]], staleRows: [{ id: "stale-run" }] });

    const result = await runUnearnedRevenueSync({ triggerType: "cron", db });

    expect(set).toHaveBeenNthCalledWith(1, expect.objectContaining({
      status: "failed",
      errorSummary: expect.stringMatching(/still running after 20 minutes/),
    }));
    expect(values).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: false,
      skipped: false,
      syncRunId: "new-run",
      staleRunningSyncsFailed: 1,
      errorSummary: "sheets unavailable",
    });

    // One clock: the stale cutoff, the sweep's finishedAt and the new row's startedAt share one `now`.
    const setCalls = set.mock.calls as unknown as Array<[Record<string, unknown>]>;
    const valuesCalls = values.mock.calls as unknown as Array<[Record<string, unknown>]>;
    expect(valuesCalls[0][0]).toMatchObject({ status: "running", triggerType: "cron" });
    expect(valuesCalls[0][0].startedAt).toBeInstanceOf(Date);
    expect(valuesCalls[0][0].startedAt).toBe(setCalls[0][0].finishedAt);
  });

  it("rethrows the original unique violation when the winning run has already finished", async () => {
    const error = wrappedUnique();
    const { db } = makeDb({ selects: [[], []], insertError: error });

    await expect(runUnearnedRevenueSync({ triggerType: "cron", db })).rejects.toBe(error);
    expect(listGoogleSheetProperties).not.toHaveBeenCalled();
  });

  it.each([
    ["wrapped non-unique error (cause.code 23503)", () => Object.assign(new Error("Failed query"), { cause: { code: "23503" } })],
    ["raw non-unique error (code 23503)", () => Object.assign(new Error("fk violation"), { code: "23503" })],
    ["wrapper with no cause", () => new Error("Failed query")],
  ])("rethrows a non-unique failure instead of skipping (%s)", async (_label, makeError) => {
    const error = makeError();
    const { db, select } = makeDb({ insertError: error });

    await expect(runUnearnedRevenueSync({ triggerType: "cron", db })).rejects.toBe(error);
    expect(select).toHaveBeenCalledTimes(1); // the pre-check only: a non-unique failure is never re-read
    expect(listGoogleSheetProperties).not.toHaveBeenCalled();
  });

  it.each([
    ["null", null],
    ["a string", "boom"],
  ])("rethrows %s rejection verbatim (the guard tolerates non-object rejections)", async (_label, rejection) => {
    const { db } = makeDb({ insertError: rejection });

    await expect(runUnearnedRevenueSync({ triggerType: "cron", db })).rejects.toBe(rejection);
  });

  // The lease may only reclaim a run whose function is certainly dead: it must
  // outlast the `maxDuration` of every route that starts a sync. Read as text
  // because importing a route pulls in the Next/auth graph.
  it.each([
    ["internal cron route", ["src", "app", "api", "internal", "sync-unearned-revenue", "route.ts"]],
    ["admin manual route", ["src", "app", "api", "unearned-revenue", "sync", "route.ts"]],
  ])("keeps the stale lease longer than the %s maxDuration", (_label, segments) => {
    const source = readFileSync(path.join(process.cwd(), ...segments), "utf8");
    const declared = /export const maxDuration = (\d+)/.exec(source);

    expect(declared).not.toBeNull();
    expect(STALE_RUNNING_UNEARNED_REVENUE_SYNC_MS).toBeGreaterThan(Number(declared?.[1]) * 1000);
  });
});
