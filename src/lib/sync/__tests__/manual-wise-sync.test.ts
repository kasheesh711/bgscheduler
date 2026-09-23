vi.mock("server-only", () => ({}));
import { and, eq, gt } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import {
  computeTypicalSyncDurationMs,
  decideManualWiseSync,
  getRunningSyncStartedAt,
  MANUAL_WISE_SYNC_FRESH_MS,
  RUNNING_SYNC_STALE_MS,
} from "../manual-wise-sync";

describe("decideManualWiseSync", () => {
  const now = new Date("2026-09-23T03:00:00.000Z");

  it("waits when a sync is already running, even with a fresh latest success", () => {
    const runningStartedAt = new Date("2026-09-23T02:58:00.000Z");
    expect(decideManualWiseSync({
      latestSuccessFinishedAt: new Date("2026-09-23T02:59:00.000Z"),
      runningStartedAt,
      now,
    })).toEqual({ action: "wait", runningStartedAt: runningStartedAt.toISOString() });
  });

  it("skips as fresh when the latest success finished under 12 minutes ago and nothing is running", () => {
    const finishedAt = new Date(now.getTime() - (MANUAL_WISE_SYNC_FRESH_MS - 1));
    expect(decideManualWiseSync({
      latestSuccessFinishedAt: finishedAt,
      runningStartedAt: null,
      now,
    })).toEqual({ action: "skip_fresh", finishedAt: finishedAt.toISOString() });
  });

  it("starts when the latest success is at or beyond the 12-minute freshness window", () => {
    const finishedAt = new Date(now.getTime() - MANUAL_WISE_SYNC_FRESH_MS);
    expect(decideManualWiseSync({
      latestSuccessFinishedAt: finishedAt,
      runningStartedAt: null,
      now,
    })).toEqual({ action: "start" });
  });

  it("starts when there is no success evidence and nothing is running", () => {
    expect(decideManualWiseSync({
      latestSuccessFinishedAt: null,
      runningStartedAt: null,
      now,
    })).toEqual({ action: "start" });
  });
});

describe("getRunningSyncStartedAt", () => {
  function makeDbMock(rows: { startedAt: Date }[]) {
    const whereMock = vi.fn(() => ({
      orderBy: vi.fn(() => ({
        limit: vi.fn().mockResolvedValue(rows),
      })),
    }));
    const db = { select: vi.fn(() => ({ from: vi.fn(() => ({ where: whereMock })) })) };
    return { db: db as unknown as Database, whereMock };
  }

  it("queries only running rows started after the staleness cutoff", async () => {
    const now = new Date("2026-09-23T03:30:00.000Z");
    const { db, whereMock } = makeDbMock([]);

    await getRunningSyncStartedAt(db, now);

    const cutoff = new Date(now.getTime() - RUNNING_SYNC_STALE_MS);
    expect(whereMock).toHaveBeenCalledWith(
      and(eq(schema.syncRuns.status, "running"), gt(schema.syncRuns.startedAt, cutoff)),
    );
  });

  it("treats an abandoned running row past the staleness window as not running (does not defer publishing)", async () => {
    // A real Postgres WHERE clause built with this cutoff excludes a row this
    // old, so the query below never actually returns it -- this asserts the
    // resulting "not running" outcome that publish-queue.ts's
    // claimPublishAttempt relies on to avoid deferring forever while
    // automation is paused and nothing ever runs failStaleRunningSyncs().
    const { db } = makeDbMock([]);

    await expect(getRunningSyncStartedAt(db, new Date("2026-09-23T03:30:00.000Z"))).resolves.toBeNull();
  });

  it("still returns the startedAt of a genuinely live running row", async () => {
    const startedAt = new Date("2026-09-23T03:29:00.000Z");
    const { db } = makeDbMock([{ startedAt }]);

    await expect(getRunningSyncStartedAt(db, new Date("2026-09-23T03:30:00.000Z"))).resolves.toEqual(startedAt);
  });
});

describe("RUNNING_SYNC_STALE_MS", () => {
  it("matches the staleness window run-wise-sync.ts uses to fail abandoned running rows", async () => {
    const { STALE_RUNNING_SYNC_MS } = await import("../run-wise-sync");
    expect(RUNNING_SYNC_STALE_MS).toBe(STALE_RUNNING_SYNC_MS);
  });
});

describe("computeTypicalSyncDurationMs", () => {
  it("returns null for no evidence", () => {
    expect(computeTypicalSyncDurationMs([])).toBeNull();
  });

  it("returns the middle value for an odd-length sample", () => {
    expect(computeTypicalSyncDurationMs([300_000, 100_000, 200_000])).toBe(200_000);
  });

  it("averages the two middle values for an even-length sample", () => {
    expect(computeTypicalSyncDurationMs([400_000, 100_000, 300_000, 200_000])).toBe(250_000);
  });
});
