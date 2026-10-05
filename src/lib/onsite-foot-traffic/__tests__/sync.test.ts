import { beforeEach, describe, expect, it, vi } from "vitest";
import { DrizzleQueryError } from "drizzle-orm";

vi.mock("server-only", () => ({}));

import type { Database } from "@/lib/db";
import { runOnsiteFootTrafficSync } from "../sync";

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
    'insert into "onsite_foot_traffic_sync_runs" ("status") values ($1)',
    ["running"],
    rawUnique(),
  );

// 2026-08-10 12:00 Bangkok, so the latest completed Bangkok day is 2026-08-09.
const NOW = new Date("2026-08-10T05:00:00.000Z");
const RUN_INPUT = {
  mode: "backfill" as const,
  startDate: "2026-08-01",
  endDate: "2026-08-07",
  triggerType: "manual" as const,
  now: NOW,
};

/**
 * Scripted db for the acquire path only. Drizzle's select builder is a thenable
 * (awaited directly by hasSuccessfulInitialBackfill) and also terminates in
 * `.limit()` (currentRunningRun); the first currentRunningRun read sees no
 * running row, the second (after the lost insert race) sees the race winner.
 */
function makeDb(options: { insertError: unknown; raceWinnerRows?: Array<{ id: string; startedAt: Date }> }) {
  const limitResponses: unknown[][] = [[], options.raceWinnerRows ?? []];
  const select = vi.fn(() => {
    const chain = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => Promise.resolve(limitResponses.shift() ?? []),
      then: (resolve: (value: unknown[]) => unknown) => Promise.resolve([]).then(resolve),
    };
    return chain;
  });
  const insertReturning = vi.fn().mockRejectedValue(options.insertError);
  const db = {
    select,
    update: vi.fn(() => ({ set: () => ({ where: () => Promise.resolve([]) }) })),
    insert: vi.fn(() => ({ values: () => ({ returning: insertReturning }) })),
  };
  return { db: db as unknown as Database, insertReturning, select };
}

describe("runOnsiteFootTrafficSync single-flight insert guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["raw driver error", rawUnique],
    ["DrizzleQueryError-wrapped driver error", wrappedUnique],
    ["real DrizzleQueryError", realWrappedUnique],
  ])("skips and reports the race winner when the run insert hits a unique violation (%s)", async (_label, makeError) => {
    const { db, insertReturning } = makeDb({
      insertError: makeError(),
      raceWinnerRows: [{ id: "run-race-winner", startedAt: new Date("2026-08-10T04:59:00.000Z") }],
    });

    const result = await runOnsiteFootTrafficSync(db, RUN_INPUT);

    expect(insertReturning).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: true,
      skipped: true,
      runId: "run-race-winner",
      mode: "backfill",
      startDate: "2026-08-01",
      endDate: "2026-08-07",
      fetchedSessionCount: 0,
      storedSessionCount: 0,
    });
  });

  it("rethrows a wrapped unique violation when the race winner has already finished", async () => {
    const error = wrappedUnique();
    const { db, select } = makeDb({ insertError: error, raceWinnerRows: [] });

    await expect(runOnsiteFootTrafficSync(db, RUN_INPUT)).rejects.toBe(error);
    // hasSuccessfulInitialBackfill + the pre-insert currentRunningRun + the post-race re-read. An unrecognised
    // error is rethrown before any re-read (two selects), so this count proves the wrapped 23505 was classified
    // as a unique violation.
    expect(select).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["wrapped non-unique error (cause.code 23503)", () => Object.assign(new Error("Failed query"), { cause: { code: "23503" } })],
    ["raw non-unique error (code 23503)", () => Object.assign(new Error("fk violation"), { code: "23503" })],
    ["wrapper with no cause", () => new Error("Failed query")],
  ])("rethrows a non-unique failure instead of skipping (%s)", async (_label, makeError) => {
    const error = makeError();
    const { db } = makeDb({
      insertError: error,
      raceWinnerRows: [{ id: "would-be-winner", startedAt: new Date("2026-08-10T04:59:00.000Z") }],
    });

    await expect(runOnsiteFootTrafficSync(db, RUN_INPUT)).rejects.toBe(error);
  });

  it.each([
    ["null", null],
    ["a string", "boom"],
  ])("rethrows %s rejection verbatim (the guard tolerates non-object rejections)", async (_label, rejection) => {
    const { db } = makeDb({ insertError: rejection });

    await expect(runOnsiteFootTrafficSync(db, RUN_INPUT)).rejects.toBe(rejection);
  });
});
