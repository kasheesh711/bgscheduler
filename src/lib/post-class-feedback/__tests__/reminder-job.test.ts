import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  runPostClassReminderJob,
  type PostClassReminderCheckpoint,
} from "../reminder-job";
import type { SyncPostClassFeedbackResult } from "../sync";

function syncResult(
  kind: PostClassReminderCheckpoint,
  hasMore: boolean,
  runId: string,
): SyncPostClassFeedbackResult {
  return {
    runId,
    status: "success",
    windowStart: "2026-07-20",
    windowEnd: "2026-07-20",
    discoveredCount: 80,
    candidateCount: hasMore ? 50 : 30,
    detailFetchedCount: hasMore ? 50 : 30,
    sessionSavedCount: hasMore ? 50 : 30,
    sourceIssueCount: 0,
    checkpoint: {
      kind,
      classDate: "2026-07-20",
      freshAfter: "2026-07-21T01:40:00.000Z",
      pendingCount: hasMore ? 80 : 30,
      selectedCount: hasMore ? 50 : 30,
      remainingCount: hasMore ? 30 : 0,
      hasMore,
    },
  };
}

const reminderResult = {
  runId: "reminder-1",
  duplicate: false,
  eligible: 5,
  deliveries: 2,
  sent: 2,
  failed: 0,
  cancelled: 0,
  unresolvedRecipients: 0,
};

describe("runPostClassReminderJob", () => {
  it("drains bounded Wise batches before dispatching once", async () => {
    const sync = vi.fn()
      .mockResolvedValueOnce(syncResult("day_after", true, "sync-1"))
      .mockResolvedValueOnce(syncResult("day_after", false, "sync-2"));
    const remind = vi.fn().mockResolvedValue(reminderResult);
    const now = new Date("2026-07-21T02:00:00.000Z");

    const result = await runPostClassReminderJob("day_after", {
      triggerType: "cron",
      now,
      sync,
      remind,
    });

    expect(result.ready).toBe(true);
    expect(result.syncRuns.map((run) => run.runId)).toEqual(["sync-1", "sync-2"]);
    expect(remind).toHaveBeenCalledOnce();
    expect(remind).toHaveBeenCalledWith("tutor_day_after", { now });
    expect(sync).toHaveBeenNthCalledWith(1, expect.objectContaining({
      now,
      reminderCheckpoint: "day_after",
      triggerType: "cron",
    }));
  });

  it("does not dispatch when the batch ceiling leaves a backlog", async () => {
    const sync = vi.fn().mockResolvedValue(syncResult("deadline", true, "sync-1"));
    const remind = vi.fn();

    const result = await runPostClassReminderJob("deadline", {
      triggerType: "manual",
      actorEmail: "admin@example.com",
      maxBatches: 1,
      sync,
      remind,
    });

    expect(result).toMatchObject({
      ready: false,
      checkpoint: "deadline",
      reminder: null,
      blockedReason: "batch_limit",
    });
    expect(remind).not.toHaveBeenCalled();
  });

  it("does not dispatch after the route time budget is consumed", async () => {
    const sync = vi.fn().mockResolvedValue(syncResult("day_after", true, "sync-1"));
    const remind = vi.fn();
    const clock = vi.fn()
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(2_001);

    const result = await runPostClassReminderJob("day_after", {
      triggerType: "cron",
      maxElapsedMs: 1_000,
      clock,
      sync,
      remind,
    });

    expect(result.blockedReason).toBe("time_limit");
    expect(remind).not.toHaveBeenCalled();
  });

  it("does not dispatch when the final draining batch exhausts the time budget", async () => {
    const sync = vi.fn().mockResolvedValue(syncResult("deadline", false, "sync-1"));
    const remind = vi.fn();
    const clock = vi.fn()
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(2_001);

    const result = await runPostClassReminderJob("deadline", {
      triggerType: "cron",
      maxElapsedMs: 1_000,
      clock,
      sync,
      remind,
    });

    expect(result).toMatchObject({ ready: false, blockedReason: "time_limit" });
    expect(remind).not.toHaveBeenCalled();
  });

  it("fails closed when sync omits the requested checkpoint proof", async () => {
    const sync = vi.fn().mockResolvedValue({
      ...syncResult("deadline", false, "sync-1"),
      checkpoint: null,
    });
    const remind = vi.fn();

    const result = await runPostClassReminderJob("deadline", {
      triggerType: "cron",
      sync,
      remind,
    });

    expect(result.blockedReason).toBe("missing_checkpoint");
    expect(remind).not.toHaveBeenCalled();
  });
});
