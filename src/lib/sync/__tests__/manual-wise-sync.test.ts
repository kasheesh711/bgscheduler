vi.mock("server-only", () => ({}));
import { describe, expect, it, vi } from "vitest";
import {
  computeTypicalSyncDurationMs,
  decideManualWiseSync,
  MANUAL_WISE_SYNC_FRESH_MS,
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
