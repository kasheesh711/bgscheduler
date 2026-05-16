import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classroomTimestampToWiseIso,
  estimatePublishRemainingMs,
  findPublishRoomBlockers,
  intendedTvRepairLocation,
  isClassroomPublishEligible,
  isWiseClassroomWritebackEnabled,
  toPublishJobProgress,
  updateWiseLocationOnly,
} from "../data";
import { REMOTE_NO_ROOM_NEEDED } from "../assignment-engine";
import { ROOM_JOY, ROOM_REMEMBER_TV } from "../rooms";

const baseRow = {
  status: "assigned" as const,
  assignedRoom: ROOM_JOY,
  sessionType: "OFFLINE",
  wiseClassId: "class-1",
  wiseSessionId: "session-1",
  warnings: [] as string[],
};

afterEach(() => {
  vi.unstubAllEnvs();
});

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
  it("detects overlapping rows currently occupying the exact target Wise room", () => {
    const row = {
      id: "target",
      tutorDisplayName: "Target",
      currentWiseLocation: "Doubt",
      assignedRoom: ROOM_REMEMBER_TV,
      startMinute: 600,
      endMinute: 660,
    };
    const blocker = {
      id: "blocker",
      tutorDisplayName: "Blocker",
      currentWiseLocation: ROOM_REMEMBER_TV,
      assignedRoom: "Cool",
      startMinute: 630,
      endMinute: 690,
    };

    expect(findPublishRoomBlockers(row, [row, blocker])).toEqual([blocker]);
  });

  it("does not collapse plain and TV Wise room names", () => {
    const row = {
      id: "target",
      tutorDisplayName: "Target",
      currentWiseLocation: "Doubt",
      assignedRoom: ROOM_REMEMBER_TV,
      startMinute: 600,
      endMinute: 660,
    };
    const plainRoom = {
      id: "plain-room",
      tutorDisplayName: "Plain",
      currentWiseLocation: "Remember",
      assignedRoom: "Cool",
      startMinute: 630,
      endMinute: 690,
    };

    expect(findPublishRoomBlockers(row, [plainRoom])).toEqual([]);
  });

  it("ignores rows that do not overlap the target time", () => {
    const row = {
      id: "target",
      tutorDisplayName: "Target",
      currentWiseLocation: "Doubt",
      assignedRoom: ROOM_REMEMBER_TV,
      startMinute: 600,
      endMinute: 660,
    };
    const later = {
      id: "later",
      tutorDisplayName: "Later",
      currentWiseLocation: ROOM_REMEMBER_TV,
      assignedRoom: "Cool",
      startMinute: 660,
      endMinute: 720,
    };

    expect(findPublishRoomBlockers(row, [later])).toEqual([]);
  });
});

describe("updateWiseLocationOnly", () => {
  it("sends the exact Wise room string for a successful location PUT", async () => {
    const updateLocation = vi.fn().mockResolvedValue({ ok: true });

    await expect(updateWiseLocationOnly(
      updateLocation,
      { wiseClassId: "class-1", wiseSessionId: "session-1" },
      ROOM_REMEMBER_TV,
    )).resolves.toBeNull();

    expect(updateLocation).toHaveBeenCalledWith("class-1", "session-1", ROOM_REMEMBER_TV);
  });

  it("returns the raw Wise PUT error when location update is rejected", async () => {
    const updateLocation = vi.fn().mockRejectedValue(new Error("Wise API 422: invalid location"));

    await expect(updateWiseLocationOnly(
      updateLocation,
      { wiseClassId: "class-1", wiseSessionId: "session-1" },
      ROOM_REMEMBER_TV,
    )).resolves.toBe("Wise API 422: invalid location");
  });

  it("does not use Wise availability preflight or temporary room swaps from the classroom publisher", () => {
    const source = readFileSync(new URL("../data.ts", import.meta.url), "utf8");

    expect(source).not.toContain("checkTeacherAvailabilityForSessions");
    expect(source).not.toContain("Wise availability conflict");
    expect(source).not.toContain("moveCycleRowToTemporaryLocation");
    expect(source).not.toContain("temporaryLocations");
  });
});

describe("Wise classroom writeback safety", () => {
  it("is disabled unless the explicit env flag is true", () => {
    vi.stubEnv("ENABLE_WISE_CLASSROOM_WRITEBACK", "false");
    expect(isWiseClassroomWritebackEnabled()).toBe(false);

    vi.stubEnv("ENABLE_WISE_CLASSROOM_WRITEBACK", "true");
    expect(isWiseClassroomWritebackEnabled()).toBe(true);
  });

  it("maps only known invalid plain TV room names to exact repair locations", () => {
    expect(intendedTvRepairLocation("Joy")).toBe(ROOM_JOY);
    expect(intendedTvRepairLocation("Remember")).toBe(ROOM_REMEMBER_TV);
    expect(intendedTvRepairLocation("Focus")).toBeNull();
    expect(intendedTvRepairLocation("Storage Closet")).toBeNull();
  });
});
