import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  classroomTimestampToWiseIso,
  estimatePublishRemainingMs,
  findPublishRoomBlockers,
  findTemporaryPublishLocation,
  isClassroomPublishEligible,
  orderTemporaryPublishCandidates,
  toPublishJobProgress,
  updateWiseLocationOnly,
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
  it("converts stored Bangkok wall-clock timestamps to Wise UTC instants", () => {
    expect(classroomTimestampToWiseIso(new Date("2026-05-16T18:00:00.000Z"))).toBe(
      "2026-05-16T11:00:00.000Z",
    );
  });

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

describe("findPublishRoomBlockers", () => {
  it("detects overlapping rows currently occupying the target physical room", () => {
    const row = {
      id: "target",
      tutorDisplayName: "Target",
      currentWiseLocation: "Doubt",
      assignedRoom: "Remember",
      startMinute: 600,
      endMinute: 660,
    };
    const blocker = {
      id: "blocker",
      tutorDisplayName: "Blocker",
      currentWiseLocation: "Remember (TV)",
      assignedRoom: "Cool",
      startMinute: 630,
      endMinute: 690,
    };

    expect(findPublishRoomBlockers(row, [row, blocker])).toEqual([blocker]);
  });

  it("ignores rows that do not overlap the target time", () => {
    const row = {
      id: "target",
      tutorDisplayName: "Target",
      currentWiseLocation: "Doubt",
      assignedRoom: "Remember",
      startMinute: 600,
      endMinute: 660,
    };
    const later = {
      id: "later",
      tutorDisplayName: "Later",
      currentWiseLocation: "Remember",
      assignedRoom: "Cool",
      startMinute: 660,
      endMinute: 720,
    };

    expect(findPublishRoomBlockers(row, [later])).toEqual([]);
  });
});

describe("findTemporaryPublishLocation", () => {
  it("chooses a room with no current or assigned overlap", () => {
    const row = {
      id: "target",
      tutorDisplayName: "Target",
      currentWiseLocation: "Cool",
      assignedRoom: "Remember",
      startMinute: 600,
      endMinute: 660,
    };
    const occupiedCurrent = {
      id: "current",
      tutorDisplayName: "Current",
      currentWiseLocation: "Dream. Plan. Do.",
      assignedRoom: "Nerd",
      startMinute: 600,
      endMinute: 660,
    };
    const occupiedAssigned = {
      id: "assigned",
      tutorDisplayName: "Assigned",
      currentWiseLocation: "Doubt",
      assignedRoom: "Joy",
      startMinute: 630,
      endMinute: 690,
    };

    expect(findTemporaryPublishLocation(row, [row, occupiedCurrent, occupiedAssigned], [
      "Dream. Plan. Do.",
      "Joy",
      "Iconic",
    ])).toBe("Iconic");
  });
});

describe("orderTemporaryPublishCandidates", () => {
  it("only chooses rows currently blocking another pending row", () => {
    const passiveBlockedRow = {
      id: "passive-blocked",
      tutorDisplayName: "Passive",
      currentWiseLocation: "Cool",
      assignedRoom: "Do It",
      startMinute: 720,
      endMinute: 780,
    };
    const actualBlocker = {
      id: "actual-blocker",
      tutorDisplayName: "Blocker",
      currentWiseLocation: "Do It",
      assignedRoom: "Here There",
      startMinute: 750,
      endMinute: 840,
    };
    const downstream = {
      id: "downstream",
      tutorDisplayName: "Downstream",
      currentWiseLocation: "Here There",
      assignedRoom: "Remember",
      startMinute: 780,
      endMinute: 840,
    };

    expect(orderTemporaryPublishCandidates([passiveBlockedRow, actualBlocker, downstream]).map((row) => row.id)).toEqual([
      "actual-blocker",
      "downstream",
    ]);
  });
});

describe("updateWiseLocationOnly", () => {
  it("treats a successful Wise location PUT as publishable without availability preflight", async () => {
    const updateLocation = vi.fn().mockResolvedValue({ ok: true });

    await expect(updateWiseLocationOnly(
      updateLocation,
      { wiseClassId: "class-1", wiseSessionId: "session-1" },
      "Remember",
    )).resolves.toBeNull();

    expect(updateLocation).toHaveBeenCalledWith("class-1", "session-1", "Remember");
  });

  it("returns the raw Wise PUT error when location update is rejected", async () => {
    const updateLocation = vi.fn().mockRejectedValue(new Error("Wise API 422: invalid location"));

    await expect(updateWiseLocationOnly(
      updateLocation,
      { wiseClassId: "class-1", wiseSessionId: "session-1" },
      "Remember",
    )).resolves.toBe("Wise API 422: invalid location");
  });

  it("does not use Wise availability preflight from the classroom publisher", () => {
    const source = readFileSync(new URL("../data.ts", import.meta.url), "utf8");

    expect(source).not.toContain("checkTeacherAvailabilityForSessions");
    expect(source).not.toContain("Wise availability conflict");
  });
});
