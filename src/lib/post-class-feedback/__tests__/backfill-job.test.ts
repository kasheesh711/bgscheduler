import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { runPostClassBackfillJob } from "../backfill-job";
import type { SyncPostClassFeedbackResult } from "../sync";

function syncResult(overrides: Partial<SyncPostClassFeedbackResult> = {}): SyncPostClassFeedbackResult {
  return {
    runId: "run-1",
    status: "success",
    windowStart: "2026-04-01",
    windowEnd: "2026-04-07",
    discoveredCount: 10,
    candidateCount: 10,
    windowCandidateCount: 10,
    detailFetchedCount: 10,
    sessionSavedCount: 10,
    sourceIssueCount: 0,
    checkpoint: null,
    ...overrides,
  };
}

describe("runPostClassBackfillJob", () => {
  it("keeps draining until a batch finds no remaining candidate", async () => {
    const full = syncResult({ windowCandidateCount: 10, detailFetchedCount: 10 });
    const sync = vi.fn()
      .mockResolvedValueOnce(full)
      .mockResolvedValueOnce(full)
      .mockResolvedValueOnce(syncResult({
        windowCandidateCount: 0,
        candidateCount: 0,
        detailFetchedCount: 0,
        sessionSavedCount: 0,
      }));

    const result = await runPostClassBackfillJob({
      startDate: "2026-04-01",
      endDate: "2026-04-07",
      detailCap: 10,
      sync,
    });

    expect(sync).toHaveBeenCalledTimes(3);
    expect(result.drained).toBe(true);
    expect(result.stoppedReason).toBe("drained");
    expect(result.detailFetchedCount).toBe(20);
    expect(result.sessionSavedCount).toBe(20);
  });

  it("reports drained on the window's own backlog, not on the total candidate count", async () => {
    // The bug this replaces: `candidateCount` sums all three candidate lanes,
    // so a saturated recheck queue — the normal state while a backlog is being
    // worked off — held it at the cap on every batch. A window that was in
    // fact complete never reported drained, and the job spent its whole batch
    // and wall-clock budget re-running it.
    const sync = vi.fn().mockResolvedValue(
      syncResult({ candidateCount: 400, windowCandidateCount: 0, detailFetchedCount: 400 }),
    );

    const result = await runPostClassBackfillJob({
      startDate: "2026-04-01",
      endDate: "2026-04-07",
      detailCap: 400,
      maxBatches: 6,
      sync,
    });

    expect(sync).toHaveBeenCalledTimes(1);
    expect(result.drained).toBe(true);
    expect(result.stoppedReason).toBe("drained");
  });

  it("keeps batching while the window still has outstanding sessions", async () => {
    // A partially-filled batch says nothing on its own: the cap is shared with
    // the event and recheck lanes, so the window can still have work left.
    const sync = vi.fn().mockResolvedValue(
      syncResult({ candidateCount: 137, windowCandidateCount: 90, detailFetchedCount: 137 }),
    );

    const result = await runPostClassBackfillJob({
      startDate: "2026-04-01",
      endDate: "2026-04-07",
      detailCap: 400,
      maxBatches: 3,
      sync,
    });

    expect(sync).toHaveBeenCalledTimes(3);
    expect(result.drained).toBe(false);
    expect(result.stoppedReason).toBe("batch_limit");
  });

  it("keeps batching while every batch fills the cap", async () => {
    const sync = vi.fn().mockResolvedValue(
      syncResult({ candidateCount: 400, windowCandidateCount: 400, detailFetchedCount: 400 }),
    );

    const result = await runPostClassBackfillJob({
      startDate: "2026-04-01",
      endDate: "2026-04-07",
      detailCap: 400,
      maxBatches: 4,
      sync,
    });

    expect(sync).toHaveBeenCalledTimes(4);
    expect(result.drained).toBe(false);
    expect(result.stoppedReason).toBe("batch_limit");
  });

  it("passes the manual backfill window and detail cap to every batch", async () => {
    const sync = vi.fn().mockResolvedValue(
      syncResult({ candidateCount: 0, windowCandidateCount: 0, detailFetchedCount: 0 }),
    );

    await runPostClassBackfillJob({
      startDate: "2026-04-01",
      endDate: "2026-04-07",
      detailCap: 400,
      actorEmail: "admin@example.com",
      now: new Date("2026-07-26T00:00:00.000Z"),
      sync,
    });

    expect(sync).toHaveBeenCalledWith({
      triggerType: "manual",
      actorEmail: "admin@example.com",
      now: new Date("2026-07-26T00:00:00.000Z"),
      startDate: "2026-04-01",
      endDate: "2026-04-07",
      detailCap: 400,
    });
  });

  it("stops on the batch limit without claiming the window is drained", async () => {
    const sync = vi.fn().mockResolvedValue(syncResult({ candidateCount: 50, windowCandidateCount: 50, detailFetchedCount: 50 }));

    const result = await runPostClassBackfillJob({
      startDate: "2026-04-01",
      endDate: "2026-04-07",
      maxBatches: 3,
      sync,
    });

    expect(sync).toHaveBeenCalledTimes(3);
    expect(result.drained).toBe(false);
    expect(result.stoppedReason).toBe("batch_limit");
  });

  it("stops on the wall-clock budget so a long backfill cannot overrun the function timeout", async () => {
    const sync = vi.fn().mockResolvedValue(syncResult({ candidateCount: 50, windowCandidateCount: 50, detailFetchedCount: 50 }));
    let ticks = 0;
    // Second budget check exceeds the limit.
    const clock = () => (ticks++ === 0 ? 0 : 10 * 60 * 1000);

    const result = await runPostClassBackfillJob({
      startDate: "2026-04-01",
      endDate: "2026-04-07",
      maxBatches: 20,
      clock,
      sync,
    });

    expect(sync).toHaveBeenCalledTimes(1);
    expect(result.stoppedReason).toBe("time_limit");
    expect(result.drained).toBe(false);
  });
});
