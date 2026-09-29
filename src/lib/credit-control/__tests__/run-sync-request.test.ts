import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DrizzleQueryError } from "drizzle-orm";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/wise/client", () => ({ createWiseClient: vi.fn() }));
vi.mock("@/lib/credit-control/sync", () => ({ runCreditControlSync: vi.fn() }));

import { getDb } from "@/lib/db";
import { createWiseClient } from "@/lib/wise/client";
import { runCreditControlSync } from "@/lib/credit-control/sync";
import { runCreditControlSyncRequest } from "@/lib/credit-control/run-sync-request";

const successResult = {
  success: true,
  snapshotId: "snapshot-1",
  promotedSnapshotId: "snapshot-1",
  studentCount: 10,
  packageCount: 12,
  sessionCount: 30,
  failedCreditPairs: 0,
};

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
    'insert into "credit_control_sync_runs" ("status") values ($1)',
    ["running"],
    rawUnique(),
  );

const RACE_WINNER = { id: "running-after-race", startedAt: new Date("2026-05-26T05:03:00.000Z") };

function makeDbMock(options: {
  runningRows?: { id: string; startedAt: Date }[];
  staleRows?: { id: string }[];
  insertError?: Error;
  duplicateRaceRows?: { id: string; startedAt: Date }[];
} = {}) {
  const runningRows = options.runningRows ?? [];
  const staleRows = options.staleRows ?? [];
  // 1st select = the pre-insert running check; 2nd = the re-read after a lost insert race.
  const selectResponses = [runningRows, options.duplicateRaceRows ?? runningRows];

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
            limit: vi.fn().mockImplementation(() => Promise.resolve(selectResponses.shift() ?? runningRows)),
          })),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(() => ({
          returning: options.insertError
            ? vi.fn().mockRejectedValue(options.insertError)
            : vi.fn().mockResolvedValue([{ id: "guard-run-1" }]),
        })),
      })),
    })),
  };
}

describe("runCreditControlSyncRequest single-flight guard", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Pin the active (non-retired) path so acquireSyncRun runs directly, with no daily-refresh claim.
    vi.stubEnv("CREDIT_CONTROL_MODE", "active");
    vi.mocked(getDb).mockReturnValue(makeDbMock() as never);
    vi.mocked(createWiseClient).mockReturnValue({ client: true } as never);
    vi.mocked(runCreditControlSync).mockResolvedValue(successResult as never);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("acquires a run row and runs the sync when nothing is running", async () => {
    const res = await runCreditControlSyncRequest({ triggerSource: "cron" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ success: true, syncRunId: "guard-run-1" });
    expect(runCreditControlSync).toHaveBeenCalledWith(
      expect.any(Object),
      { client: true },
      expect.any(String),
      expect.any(Date),
      expect.objectContaining({ syncRunId: "guard-run-1" }),
    );
  });

  it("returns 202 and skips when a fresh sync is already running", async () => {
    vi.mocked(getDb).mockReturnValue(makeDbMock({ runningRows: [RACE_WINNER] }) as never);

    const res = await runCreditControlSyncRequest({ triggerSource: "cron" });

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toMatchObject({ skipped: true, alreadyRunning: true, syncRunId: RACE_WINNER.id });
    expect(runCreditControlSync).not.toHaveBeenCalled();
  });

  it.each([
    ["raw driver error", rawUnique],
    ["DrizzleQueryError-wrapped driver error", wrappedUnique],
    ["real DrizzleQueryError", realWrappedUnique],
  ])("returns 202 with the race winner when the run insert hits a unique violation (%s)", async (_label, makeError) => {
    vi.mocked(getDb).mockReturnValue(makeDbMock({
      insertError: makeError(),
      duplicateRaceRows: [RACE_WINNER],
    }) as never);

    const res = await runCreditControlSyncRequest({ triggerSource: "cron" });

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toMatchObject({
      skipped: true,
      alreadyRunning: true,
      syncRunId: RACE_WINNER.id,
      runningStartedAt: "2026-05-26T05:03:00.000Z",
    });
    expect(runCreditControlSync).not.toHaveBeenCalled();
  });

  it("rethrows a wrapped unique violation when the race winner has already finished", async () => {
    const error = wrappedUnique();
    const db = makeDbMock({ insertError: error, duplicateRaceRows: [] });
    vi.mocked(getDb).mockReturnValue(db as never);

    await expect(runCreditControlSyncRequest({ triggerSource: "cron" })).rejects.toBe(error);
    // Pre-insert running check + post-race re-read. An unrecognised error is rethrown before any re-read
    // (a single select), so this count proves the wrapped 23505 was classified as a unique violation.
    expect(db.select).toHaveBeenCalledTimes(2);
    expect(runCreditControlSync).not.toHaveBeenCalled();
  });

  it.each([
    ["wrapped non-unique error (cause.code 23503)", () => Object.assign(new Error("Failed query"), { cause: { code: "23503" } })],
    ["raw non-unique error (code 23503)", () => Object.assign(new Error("fk violation"), { code: "23503" })],
    ["wrapper with no cause", () => new Error("Failed query")],
  ])("rethrows a non-unique insert failure instead of skipping (%s)", async (_label, makeError) => {
    const error = makeError();
    vi.mocked(getDb).mockReturnValue(makeDbMock({ insertError: error, duplicateRaceRows: [RACE_WINNER] }) as never);

    await expect(runCreditControlSyncRequest({ triggerSource: "cron" })).rejects.toBe(error);
    expect(runCreditControlSync).not.toHaveBeenCalled();
  });
});
