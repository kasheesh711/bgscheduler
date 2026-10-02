import { describe, expect, it, vi } from "vitest";
import { DrizzleQueryError } from "drizzle-orm";
import {
  failStaleRunningCompetitorSyncs,
  runCompetitorIntelligenceSync,
} from "@/lib/competitor-intelligence/sync";

function makeDbMock(staleRows: Array<{ id: string }> = []) {
  const topReturning = vi.fn().mockResolvedValue(staleRows);
  const childWhere = vi.fn().mockResolvedValue([]);
  const topWhere = vi.fn(() => ({ returning: topReturning }));
  const set = vi
    .fn()
    .mockImplementationOnce(() => ({ where: topWhere }))
    .mockImplementation(() => ({ where: childWhere }));
  const update = vi.fn(() => ({ set }));

  return {
    childWhere,
    set,
    topReturning,
    update,
    db: { update },
  };
}

describe("competitor sync guard", () => {
  it("marks stale running syncs and child runs failed", async () => {
    const { db, childWhere, set, update } = makeDbMock([{ id: "stale-run-1" }]);

    await expect(
      failStaleRunningCompetitorSyncs(db as never, new Date("2026-06-15T14:00:00.000Z")),
    ).resolves.toBe(1);

    expect(update).toHaveBeenCalledTimes(3);
    expect(set).toHaveBeenNthCalledWith(1, expect.objectContaining({
      status: "failed",
      errorSummary: expect.stringContaining("still running after 20 minutes"),
    }));
    expect(set).toHaveBeenNthCalledWith(2, expect.objectContaining({
      status: "failed",
      errorSummary: expect.stringContaining("still running after 20 minutes"),
    }));
    expect(set).toHaveBeenNthCalledWith(3, expect.objectContaining({
      status: "failed",
      errorSummary: expect.stringContaining("still running after 20 minutes"),
    }));
    expect(childWhere).toHaveBeenCalledTimes(2);
  });

  it("does not touch child runs when no stale syncs exist", async () => {
    const { db, childWhere, update } = makeDbMock();

    await expect(
      failStaleRunningCompetitorSyncs(db as never, new Date("2026-06-15T14:00:00.000Z")),
    ).resolves.toBe(0);

    expect(update).toHaveBeenCalledTimes(1);
    expect(childWhere).not.toHaveBeenCalled();
  });
});

// Callers (both sync routes, the data-health runner) map any message containing
// "already running" to HTTP 409, and cron-audit records it as `skipped`.
const ALREADY_RUNNING = "Competitor intelligence sync is already running";

// drizzle-orm 0.45 wraps every driver error in DrizzleQueryError: the SQLSTATE
// lives on `.cause`, `.code` is undefined. Raw `.code` errors stay supported.
const rawUnique = () =>
  Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
const wrappedUnique = () =>
  Object.assign(new Error("Failed query"), { cause: { code: "23505" } });
const realWrappedUnique = () =>
  new DrizzleQueryError(
    'insert into "competitor_sync_runs" ("trigger_type") values ($1)',
    ["manual"],
    rawUnique(),
  );

function makeRunDb(options: { runningRows?: Array<{ id: string }>; insertError: unknown }) {
  // Stale sweep: update().set().where().returning() -> [] so no child-run updates fire.
  const sweepReturning = vi.fn().mockResolvedValue([]);
  const update = vi.fn(() => ({ set: () => ({ where: () => ({ returning: sweepReturning }) }) }));
  const limit = vi.fn().mockResolvedValue(options.runningRows ?? []);
  const select = vi.fn(() => ({ from: () => ({ where: () => ({ limit }) }) }));
  const insertReturning = vi.fn().mockRejectedValue(options.insertError);
  const insert = vi.fn(() => ({ values: () => ({ returning: insertReturning }) }));

  return { db: { update, select, insert }, insert };
}

describe("competitor sync single-flight insert guard", () => {
  it.each([
    ["raw driver error", rawUnique],
    ["DrizzleQueryError-wrapped driver error", wrappedUnique],
    ["real DrizzleQueryError", realWrappedUnique],
  ])("maps a lost insert race to the already-running error (%s)", async (_label, makeError) => {
    const { db } = makeRunDb({ insertError: makeError() });

    const failure = await runCompetitorIntelligenceSync({
      triggerType: "manual",
      actorEmail: "admin@example.com",
      db: db as never,
    }).then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(ALREADY_RUNNING);
  });

  it.each([
    ["wrapped non-unique error (cause.code 23503)", () => Object.assign(new Error("Failed query"), { cause: { code: "23503" } })],
    ["raw non-unique error (code 23503)", () => Object.assign(new Error("fk violation"), { code: "23503" })],
    ["wrapper with no cause", () => new Error("Failed query")],
  ])("rethrows a non-unique insert failure verbatim (%s)", async (_label, makeError) => {
    const error = makeError();
    const { db } = makeRunDb({ insertError: error });

    await expect(runCompetitorIntelligenceSync({
      triggerType: "manual",
      actorEmail: "admin@example.com",
      db: db as never,
    })).rejects.toBe(error);
  });

  it("keeps the pre-check error text and never inserts while a run is already running", async () => {
    const { db, insert } = makeRunDb({
      runningRows: [{ id: "running-1" }],
      insertError: new Error("insert must not be reached"),
    });

    const failure = await runCompetitorIntelligenceSync({
      triggerType: "cron",
      db: db as never,
    }).then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(ALREADY_RUNNING);
    expect(insert).not.toHaveBeenCalled();
  });
});
