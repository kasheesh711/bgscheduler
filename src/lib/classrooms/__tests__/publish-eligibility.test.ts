import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  buildWisePublishLocationCatalog,
  buildRoomConflictWarnings,
  classroomTimestampToWiseIso,
  estimatePublishRemainingMs,
  findExternalRoomBlocker,
  findPublishRoomBlockers,
  findTemporaryPublishLocation,
  liveRoomBlocksForDate,
  isCurrentWisePublishLocation,
  isClassroomPublishEligible,
  orderTemporaryPublishCandidates,
  resolveWisePublishLocation,
  toPublishJobProgress,
  updateWiseLocationOnly,
  wisePublishLocationName,
} from "../data";
import { REMOTE_NO_ROOM_NEEDED } from "../assignment-engine";
import { DEFAULT_CLASSROOM_ROOMS } from "../rooms";

const baseRow = {
  status: "assigned" as const,
  assignedRoom: "Joy (TV)",
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
      targetRowIds: null,
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

describe("Wise publish location catalog", () => {
  it("resolves TV rooms to exact Wise (TV) locations before calling Wise", async () => {
    const catalog = buildWisePublishLocationCatalog(DEFAULT_CLASSROOM_ROOMS, ["Remember (TV)"]);
    const resolved = resolveWisePublishLocation(catalog, "Remember (TV)");
    expect(resolved).toEqual({ ok: true, location: "Remember (TV)" });
    expect(wisePublishLocationName({ name: "Remember (TV)", hasTv: true })).toBe("Remember (TV)");

    const updateLocation = vi.fn().mockResolvedValue({ ok: true });
    if (resolved.ok) {
      await expect(updateWiseLocationOnly(
        updateLocation,
        { wiseClassId: "class-1", wiseSessionId: "session-1" },
        resolved.location,
      )).resolves.toBeNull();
    }

    expect(updateLocation).toHaveBeenCalledWith("class-1", "session-1", "Remember (TV)");
    expect(updateLocation).not.toHaveBeenCalledWith("class-1", "session-1", "Remember");
  });

  it("resolves non-TV rooms to plain Wise locations", () => {
    const catalog = buildWisePublishLocationCatalog(DEFAULT_CLASSROOM_ROOMS, ["Focus"]);

    expect(resolveWisePublishLocation(catalog, "Focus")).toEqual({
      ok: true,
      location: "Focus",
    });
    expect(wisePublishLocationName({ name: "Focus", hasTv: false })).toBe("Focus");
  });

  it("does not treat a plain TV-room Wise location as already published", () => {
    expect(isCurrentWisePublishLocation("Go All In", "Go All In (TV)")).toBe(false);
    expect(isCurrentWisePublishLocation("Go All In (TV)", "Go All In (TV)")).toBe(true);
  });

  it("uses verified Wise publish names for temporary swap candidates", () => {
    const catalog = buildWisePublishLocationCatalog(
      [
        { name: "Remember (TV)", hasTv: true, capacity: 2, category: "standard", active: true, sortOrder: 1 },
        { name: "Focus", hasTv: false, capacity: 2, category: "standard", active: true, sortOrder: 2 },
        { name: "Doubt (TV)", hasTv: true, capacity: 2, category: "standard", active: true, sortOrder: 3 },
      ],
      ["Remember (TV)", "Focus"],
    );

    expect(catalog.temporaryLocations).toEqual(["Remember (TV)", "Focus"]);
    expect(catalog.temporaryLocations).not.toContain("Remember");
    expect(catalog.temporaryLocations).not.toContain("Doubt");
    expect(resolveWisePublishLocation(catalog, "Doubt (TV)")).toEqual({
      ok: false,
      reason: "Verified Wise location Doubt (TV) is missing for assigned room Doubt (TV)",
    });
  });

  it("fails closed when the exact Wise location is missing", async () => {
    const catalog = buildWisePublishLocationCatalog(
      [{ name: "Joy (TV)", hasTv: true, capacity: 3, category: "standard", active: true, sortOrder: 1 }],
      ["Joy"],
    );
    const updateLocation = vi.fn();
    const resolved = resolveWisePublishLocation(catalog, "Joy (TV)");

    expect(resolved).toEqual({
      ok: false,
      reason: "Verified Wise location Joy (TV) is missing for assigned room Joy (TV)",
    });
    if (resolved.ok) {
      await updateWiseLocationOnly(
        updateLocation,
        { wiseClassId: "class-1", wiseSessionId: "session-1" },
        resolved.location,
      );
    }
    expect(updateLocation).not.toHaveBeenCalled();
  });

  it("fails closed when the Wise location catalog cannot verify any locations", () => {
    const catalog = buildWisePublishLocationCatalog(
      [{ name: "Focus", hasTv: false, capacity: 2, category: "standard", active: true, sortOrder: 1 }],
      [],
    );

    expect(catalog.temporaryLocations).toEqual([]);
    expect(resolveWisePublishLocation(catalog, "Focus")).toEqual({
      ok: false,
      reason: "Verified Wise location Focus is missing for assigned room Focus",
    });
  });
});

describe("live Wise room conflict helpers", () => {
  it("builds date-scoped offline room blocks from live Wise sessions", () => {
    const blocks = liveRoomBlocksForDate([
      {
        _id: "offline",
        scheduledStartTime: "2026-05-23T03:00:00.000Z",
        scheduledEndTime: "2026-05-23T04:00:00.000Z",
        meetingStatus: "CONFIRMED",
        type: "OFFLINE",
        location: "Remember (TV)",
        classId: { _id: "class-1", name: "External Student" },
      },
      {
        _id: "online",
        scheduledStartTime: "2026-05-23T03:00:00.000Z",
        scheduledEndTime: "2026-05-23T04:00:00.000Z",
        meetingStatus: "CONFIRMED",
        type: "SCHEDULED",
        location: "Remember (TV)",
      },
      {
        _id: "cancelled",
        scheduledStartTime: "2026-05-23T03:00:00.000Z",
        scheduledEndTime: "2026-05-23T04:00:00.000Z",
        meetingStatus: "CANCELLED",
        type: "OFFLINE",
        location: "Remember (TV)",
      },
    ], "2026-05-23");

    expect(blocks).toEqual([{
      wiseSessionId: "offline",
      wiseClassId: "class-1",
      className: "External Student",
      location: "Remember (TV)",
      startMinute: 10 * 60,
      endMinute: 11 * 60,
      sessionType: "OFFLINE",
      wiseStatus: "CONFIRMED",
    }]);
  });

  it("finds external live blockers by physical room, including plain TV names", () => {
    const blocker = {
      wiseSessionId: "external",
      wiseClassId: "class-2",
      className: "External Student",
      location: "Remember",
      startMinute: 10 * 60,
      endMinute: 11 * 60,
      sessionType: "OFFLINE",
      wiseStatus: "CONFIRMED",
    };

    expect(findExternalRoomBlocker(
      { startMinute: 10 * 60 + 30, endMinute: 11 * 60 + 30 },
      "Remember (TV)",
      [blocker],
    )).toBe(blocker);
    expect(findExternalRoomBlocker(
      { startMinute: 11 * 60, endMinute: 12 * 60 },
      "Remember (TV)",
      [blocker],
    )).toBeNull();
  });

  it("returns concrete room conflict warning messages", () => {
    const blocker = {
      wiseSessionId: "external",
      wiseClassId: "class-2",
      className: "External Student",
      location: "Go All In",
      startMinute: 12 * 60,
      endMinute: 13 * 60,
      sessionType: "OFFLINE",
      wiseStatus: "CONFIRMED",
    };

    expect(buildRoomConflictWarnings(
      [{
        wiseSessionId: "local",
        assignedRoom: "Go All In (TV)",
        startMinute: 12 * 60 + 30,
        endMinute: 13 * 60 + 30,
      }],
      [blocker],
      (assignedRoom) => assignedRoom,
    )).toEqual([{
      wiseSessionId: "local",
      assignedRoom: "Go All In (TV)",
      desiredLocation: "Go All In (TV)",
      blocker,
      message: "Blocked by live Wise class External Student in Go All In 12:00-13:00",
    }]);
  });
});

describe("findPublishRoomBlockers", () => {
  it("detects overlapping rows currently occupying the target physical room", () => {
    const row = {
      id: "target",
      tutorDisplayName: "Target",
      currentWiseLocation: "Doubt",
      assignedRoom: "Remember (TV)",
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
      assignedRoom: "Remember (TV)",
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
      assignedRoom: "Remember (TV)",
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
      assignedRoom: "Joy (TV)",
      startMinute: 630,
      endMinute: 690,
    };

    expect(findTemporaryPublishLocation(row, [row, occupiedCurrent, occupiedAssigned], [
      "Dream. Plan. Do.",
      "Joy (TV)",
      "Iconic (TV)",
    ])).toBe("Iconic (TV)");
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
      assignedRoom: "Here There (TV)",
      startMinute: 750,
      endMinute: 840,
    };
    const downstream = {
      id: "downstream",
      tutorDisplayName: "Downstream",
      currentWiseLocation: "Here There",
      assignedRoom: "Remember (TV)",
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
      "Remember (TV)",
    )).resolves.toBeNull();

    expect(updateLocation).toHaveBeenCalledWith("class-1", "session-1", "Remember (TV)");
  });

  it("returns the raw Wise PUT error when location update is rejected", async () => {
    const updateLocation = vi.fn().mockRejectedValue(new Error("Wise API 422: invalid location"));

    await expect(updateWiseLocationOnly(
      updateLocation,
      { wiseClassId: "class-1", wiseSessionId: "session-1" },
      "Remember (TV)",
    )).resolves.toBe("Wise API 422: invalid location");
  });

  it("does not use Wise availability preflight from the classroom publisher", () => {
    const source = readFileSync(new URL("../data.ts", import.meta.url), "utf8");

    expect(source).not.toContain("checkTeacherAvailabilityForSessions");
    expect(source).not.toContain("Wise availability conflict");
  });
});
