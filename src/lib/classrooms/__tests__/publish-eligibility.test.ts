import { describe, expect, it } from "vitest";
import {
  estimatePublishRemainingMs,
  isClassroomPublishEligible,
  toPublishJobProgress,
} from "../data";
import { REMOTE_NO_ROOM_NEEDED } from "../assignment-engine";

const baseRow = {
  status: "assigned" as const,
  assignedRoom: "Joy",
  sessionType: "OFFLINE",
  wiseClassId: "class-1",
  wiseSessionId: "session-1",
  warnings: [] as string[],
};

describe("isClassroomPublishEligible", () => {
  it("allows assigned offline rows with Wise ids", () => {
    expect(isClassroomPublishEligible(baseRow)).toEqual({ eligible: true });
  });

  it("skips online rows in v1", () => {
    expect(isClassroomPublishEligible({ ...baseRow, sessionType: "SCHEDULED" })).toEqual({
      eligible: false,
      reason: "V1 publishes Wise locations for OFFLINE sessions only",
    });
  });

  it("skips remote rows", () => {
    expect(isClassroomPublishEligible({
      ...baseRow,
      status: "remote",
      assignedRoom: REMOTE_NO_ROOM_NEEDED,
      sessionType: "SCHEDULED",
    })).toEqual({
      eligible: false,
      reason: "Remote online session has no Wise location to publish",
    });
  });

  it("skips rows that need capacity review", () => {
    expect(isClassroomPublishEligible({
      ...baseRow,
      warnings: ["needs_review_missing_capacity"],
    })).toEqual({
      eligible: false,
      reason: "Missing reliable group capacity",
    });
  });

  it("skips rows missing Wise class ids", () => {
    expect(isClassroomPublishEligible({ ...baseRow, wiseClassId: null })).toEqual({
      eligible: false,
      reason: "Missing Wise class id",
    });
  });
});

describe("publish job progress", () => {
  it("estimates remaining time from completed Wise attempts only", () => {
    const startedAt = new Date("2026-05-15T00:00:00.000Z");
    const now = new Date("2026-05-15T00:00:10.000Z");

    expect(estimatePublishRemainingMs({
      startedAt,
      finishedAt: null,
      eligibleCount: 6,
      successCount: 2,
      failedCount: 0,
    }, now)).toBe(20_000);
  });

  it("reports remaining row counts and terminal elapsed time", () => {
    const progress = toPublishJobProgress({
      id: "job-1",
      runId: "run-1",
      status: "partial",
      totalCount: 5,
      eligibleCount: 3,
      completedCount: 5,
      successCount: 2,
      failedCount: 1,
      skippedCount: 2,
      lastError: null,
      createdBy: "admin@example.com",
      startedAt: new Date("2026-05-15T00:00:00.000Z"),
      finishedAt: new Date("2026-05-15T00:00:12.000Z"),
      createdAt: new Date("2026-05-15T00:00:00.000Z"),
      updatedAt: new Date("2026-05-15T00:00:12.000Z"),
    });

    expect(progress.remainingCount).toBe(0);
    expect(progress.elapsedMs).toBe(12_000);
    expect(progress.estimatedRemainingMs).toBeNull();
  });
});
