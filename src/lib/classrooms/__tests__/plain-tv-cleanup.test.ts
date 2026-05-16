import { describe, expect, it, vi } from "vitest";
import type { WiseSession } from "@/lib/wise/types";
import {
  assertKnownPlainTvRepairLocation,
  assertPlainTvCleanupApplyAllowed,
  buildPlainTvCleanupPlan,
  intendedPlainTvRepairLocation,
  type PlainTvCleanupPreflight,
  type PlainTvCleanupProposal,
} from "../plain-tv-cleanup";
import {
  ROOM_KEEP_GOING_TV,
  ROOM_RELAX_TV,
  ROOM_TURN_THE_PAGE_TV,
} from "../rooms";

function wiseSession(overrides: Partial<WiseSession> = {}): WiseSession {
  return {
    _id: "session-1",
    scheduledStartTime: "2026-05-16T11:00:00.000Z",
    scheduledEndTime: "2026-05-16T12:00:00.000Z",
    meetingStatus: "UPCOMING",
    type: "OFFLINE",
    location: "Keep Going",
    userId: { _id: "teacher-user-1", name: "Tutor One" },
    classId: { _id: "class-1", name: "Student One" },
    studentCount: 1,
    ...overrides,
  } satisfies WiseSession;
}

function proposal(overrides: Partial<PlainTvCleanupProposal> = {}): PlainTvCleanupProposal {
  return {
    wiseSessionId: "session-1",
    wiseClassId: "class-1",
    tutorName: "Tutor One",
    studentName: "Student One",
    startBangkok: "2026-05-16 18:00",
    endBangkok: "2026-05-16 19:00",
    fromLocation: "Keep Going",
    toLocation: ROOM_KEEP_GOING_TV,
    reason: "repair_plain_tv_location",
    dryRunConflict: false,
    dryRunError: null,
    dryRunWarning: null,
    skipSessionIds: ["session-1"],
    ...overrides,
  };
}

function repairEnv(enabled: boolean): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ENABLE_WISE_EMERGENCY_REPAIR;
  if (enabled) env.ENABLE_WISE_EMERGENCY_REPAIR = "true";
  return env;
}

describe("plain TV Wise cleanup", () => {
  it("maps only known invalid plain TV names back to exact Wise TV names", () => {
    expect(intendedPlainTvRepairLocation("Keep Going")).toBe(ROOM_KEEP_GOING_TV);
    expect(intendedPlainTvRepairLocation(" Turn The Page ")).toBe(ROOM_TURN_THE_PAGE_TV);
    expect(intendedPlainTvRepairLocation(ROOM_KEEP_GOING_TV)).toBeNull();
    expect(intendedPlainTvRepairLocation("Cool")).toBeNull();
    expect(() => assertKnownPlainTvRepairLocation("Not A Room")).toThrow("Unknown plain TV room");
  });

  it("proposes a direct exact-TV repair when Wise preflight passes", async () => {
    const preflight = vi.fn<PlainTvCleanupPreflight>().mockResolvedValue({ conflict: false });
    const plan = await buildPlainTvCleanupPlan({
      wiseLocations: ["Keep Going", ROOM_KEEP_GOING_TV],
      wiseSessions: [wiseSession()],
      preflight,
    });

    expect(plan.invalidPlainTvSessions).toContainEqual(expect.objectContaining({
      wiseSessionId: "session-1",
      wrongLocation: "Keep Going",
      intendedLocation: ROOM_KEEP_GOING_TV,
      includedInRepairPlan: true,
    }));
    expect(plan.proposals).toEqual([
      expect.objectContaining({
        wiseSessionId: "session-1",
        fromLocation: "Keep Going",
        toLocation: ROOM_KEEP_GOING_TV,
        reason: "repair_plain_tv_location",
      }),
    ]);
    expect(preflight).toHaveBeenCalledWith(
      expect.objectContaining({ wiseSessionId: "session-1" }),
      ROOM_KEEP_GOING_TV,
      ["session-1"],
    );
  });

  it("refuses missing Wise class ids instead of proposing a PUT", async () => {
    const plan = await buildPlainTvCleanupPlan({
      wiseLocations: ["Keep Going", ROOM_KEEP_GOING_TV],
      wiseSessions: [wiseSession({ classId: undefined })],
      preflight: vi.fn<PlainTvCleanupPreflight>().mockResolvedValue({ conflict: false }),
    });

    expect(plan.proposals).toEqual([]);
    expect(plan.manualRequired).toEqual([
      expect.objectContaining({
        wiseSessionId: "session-1",
        reason: "Missing Wise class/session id",
      }),
    ]);
  });

  it("allows known non-location Wise preflight conflicts for location-only repairs", async () => {
    const plan = await buildPlainTvCleanupPlan({
      wiseLocations: ["Keep Going", ROOM_KEEP_GOING_TV],
      wiseSessions: [wiseSession()],
      preflight: vi.fn<PlainTvCleanupPreflight>().mockResolvedValue({
        conflict: true,
        conflictReasons: ["TEACHER_WORKING_HOURS"],
      }),
    });

    expect(plan.proposals).toEqual([
      expect.objectContaining({
        wiseSessionId: "session-1",
        toLocation: ROOM_KEEP_GOING_TV,
        dryRunConflict: true,
        dryRunWarning: "Wise preflight reported only pre-existing non-location conflict reason(s): TEACHER_WORKING_HOURS",
      }),
    ]);
    expect(plan.manualRequired).toEqual([]);
  });

  it("separates blocker moves from direct repairs when the exact TV room is occupied", async () => {
    const invalid = wiseSession({
      _id: "invalid-plain",
      classId: { _id: "class-invalid", name: "Student Invalid" },
      location: "Keep Going",
    });
    const blocker = wiseSession({
      _id: "exact-blocker",
      classId: { _id: "class-blocker", name: "Student Blocker" },
      location: ROOM_KEEP_GOING_TV,
      userId: { _id: "teacher-user-2", name: "Tutor Two" },
    });
    const preflight: PlainTvCleanupPreflight = async (session, toLocation, skipSessionIds) => ({
      conflict:
        session.wiseSessionId === "invalid-plain" &&
        toLocation === ROOM_KEEP_GOING_TV &&
        !skipSessionIds.includes("exact-blocker"),
    });

    const plan = await buildPlainTvCleanupPlan({
      wiseLocations: ["Keep Going", ROOM_KEEP_GOING_TV, ROOM_RELAX_TV],
      wiseSessions: [invalid, blocker],
      preflight,
    });

    expect(plan.proposals).toEqual([
      expect.objectContaining({
        wiseSessionId: "exact-blocker",
        fromLocation: ROOM_KEEP_GOING_TV,
        toLocation: ROOM_RELAX_TV,
        reason: "move_blocker_to_alternate_room",
        relatedInvalidSessionId: "invalid-plain",
      }),
      expect.objectContaining({
        wiseSessionId: "invalid-plain",
        fromLocation: "Keep Going",
        toLocation: ROOM_KEEP_GOING_TV,
        reason: "repair_plain_tv_location",
        skipSessionIds: ["exact-blocker", "invalid-plain"],
      }),
    ]);
    expect(plan.manualRequired).toEqual([]);
  });

  it("does not move TV/capacity-required blockers into rooms that cannot preserve requirements", async () => {
    const invalid = wiseSession({
      _id: "invalid-relax",
      classId: { _id: "class-invalid", name: "Student Invalid" },
      location: "Relax",
      studentCount: 1,
    });
    const largeTvBlocker = wiseSession({
      _id: "large-tv-blocker",
      classId: { _id: "class-blocker", name: "Student Blocker" },
      location: ROOM_RELAX_TV,
      studentCount: 4,
    });
    const preflight: PlainTvCleanupPreflight = async (session) => ({
      conflict: session.wiseSessionId === "invalid-relax",
    });

    const plan = await buildPlainTvCleanupPlan({
      wiseLocations: ["Relax", ROOM_RELAX_TV, ROOM_KEEP_GOING_TV, "Tesla", "Hakuna Matata"],
      wiseSessions: [invalid, largeTvBlocker],
      preflight,
    });

    expect(plan.proposals).toEqual([]);
    expect(plan.manualRequired).toContainEqual(expect.objectContaining({
      wiseSessionId: "large-tv-blocker",
      reason: "No approved alternate room is free for blocker of invalid-relax",
    }));
  });

  it("requires env flag, confirmation token, and exact session ids before apply", () => {
    const proposals = [
      proposal({ wiseSessionId: "session-a", wiseClassId: "class-a" }),
      proposal({ wiseSessionId: "session-b", wiseClassId: "class-b" }),
    ];

    expect(() => assertPlainTvCleanupApplyAllowed({
      proposals,
      confirm: "all:2",
      sessionIds: ["session-a", "session-b"],
      env: repairEnv(false),
    })).toThrow("Wise plain TV cleanup is disabled");

    expect(() => assertPlainTvCleanupApplyAllowed({
      proposals,
      confirm: "all:1",
      sessionIds: ["session-a", "session-b"],
      env: repairEnv(true),
    })).toThrow("expected --confirm all:2");

    expect(() => assertPlainTvCleanupApplyAllowed({
      proposals,
      confirm: "all:2",
      sessionIds: ["session-a"],
      env: repairEnv(true),
    })).toThrow("expected --session-ids session-a,session-b");

    expect(() => assertPlainTvCleanupApplyAllowed({
      proposals,
      confirm: "all:2",
      sessionIds: ["session-b", "session-a"],
      env: repairEnv(true),
    })).not.toThrow();
  });
});
