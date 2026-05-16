import { describe, expect, it } from "vitest";
import {
  assertEmergencyRepairApplyAllowed,
  buildEmergencyRepairPlan,
  detectRoomConflicts,
  normalizeWiseSessionForRepair,
  type EmergencyRepairProposal,
  type EmergencyRepairSession,
} from "../wise-room-conflict-repair";
import type { WiseSession } from "@/lib/wise/types";
import {
  ROOM_KEEP_GOING_TV,
  ROOM_RELAX_TV,
} from "../rooms";

function session(overrides: Partial<EmergencyRepairSession> = {}): EmergencyRepairSession {
  const startTime = overrides.startTime ?? new Date("2026-05-16T11:00:00.000Z");
  const durationMinutes = overrides.durationMinutes ?? 60;
  const endTime = overrides.endTime ?? new Date(startTime.getTime() + durationMinutes * 60_000);

  return {
    wiseSessionId: overrides.wiseSessionId ?? "session-1",
    wiseClassId: overrides.wiseClassId ?? "class-1",
    tutorName: overrides.tutorName ?? "Tutor One",
    studentName: overrides.studentName ?? "Student One",
    subject: overrides.subject ?? "Math",
    title: overrides.title ?? "In-Person Session - Math",
    status: overrides.status ?? "UPCOMING",
    sessionType: overrides.sessionType ?? "OFFLINE",
    location: overrides.location ?? ROOM_KEEP_GOING_TV,
    startTime,
    endTime,
    startTimeBangkok: overrides.startTimeBangkok ?? "2026-05-16 18:00",
    endTimeBangkok: overrides.endTimeBangkok ?? "2026-05-16 19:00",
    durationMinutes,
  };
}

function proposal(overrides: Partial<EmergencyRepairProposal> = {}): EmergencyRepairProposal {
  return {
    wiseSessionId: overrides.wiseSessionId ?? "session-1",
    wiseClassId: overrides.wiseClassId ?? "class-1",
    tutorName: overrides.tutorName ?? "Tutor One",
    studentName: overrides.studentName ?? "Student One",
    startTimeBangkok: overrides.startTimeBangkok ?? "2026-05-16 18:00",
    endTimeBangkok: overrides.endTimeBangkok ?? "2026-05-16 19:00",
    fromLocation: overrides.fromLocation ?? "Keep Going",
    toLocation: overrides.toLocation ?? ROOM_KEEP_GOING_TV,
    reason: overrides.reason ?? "repair_plain_tv_location",
  };
}

function repairEnv(enabled: boolean): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ENABLE_WISE_EMERGENCY_REPAIR;
  if (enabled) env.ENABLE_WISE_EMERGENCY_REPAIR = "true";
  return env;
}


describe("Wise emergency room conflict repair", () => {
  it("prints Wise session times as Bangkok operational wall-clock time", () => {
    const normalized = normalizeWiseSessionForRepair({
      _id: "session-1",
      scheduledStartTime: "2026-05-16T04:00:00.000Z",
      scheduledEndTime: "2026-05-16T06:00:00.000Z",
      meetingStatus: "UPCOMING",
      type: "OFFLINE",
      location: "Keep Going",
      userId: { _id: "teacher-user-1", name: "Chettaporn (Fluke) Chuesuphan" },
      classId: {
        _id: "class-1",
        name: "Naruebate (Bingo.Wa) Wanichwatepibul",
        subject: "Y9-11 / G8-10 (Int.)",
      },
    } satisfies WiseSession);

    expect(normalized).toMatchObject({
      tutorName: "Chettaporn (Fluke) Chuesuphan",
      studentName: "Naruebate (Bingo.Wa) Wanichwatepibul",
      startTimeBangkok: "2026-05-16 18:00",
      endTimeBangkok: "2026-05-16 20:00",
      durationMinutes: 120,
    });
  });

  it("detects overlaps between plain TV-room names and exact TV-room names", () => {
    const conflicts = detectRoomConflicts([
      session({ wiseSessionId: "plain", location: "Keep Going" }),
      session({ wiseSessionId: "exact", location: ROOM_KEEP_GOING_TV }),
    ]);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      physicalRoom: "Keep Going",
      overlapStartBangkok: "2026-05-16 18:00",
      overlapEndBangkok: "2026-05-16 19:00",
    });
  });

  it("maps invalid plain TV-room locations back to exact Wise TV names in the proposal", () => {
    const longPlain = session({
      wiseSessionId: "long-plain",
      wiseClassId: "class-long",
      location: "Keep Going",
      durationMinutes: 120,
      endTimeBangkok: "2026-05-16 20:00",
    });
    const shortExact = session({
      wiseSessionId: "short-exact",
      wiseClassId: "class-short",
      location: ROOM_KEEP_GOING_TV,
      durationMinutes: 60,
    });

    const plan = buildEmergencyRepairPlan("2026-05-16", [longPlain, shortExact], [
      ROOM_KEEP_GOING_TV,
      ROOM_RELAX_TV,
      "Tesla",
      "Dream. Plan. Do.",
    ]);

    expect(plan.invalidPlainTvLocations).toContainEqual(expect.objectContaining({
      wiseSessionId: "long-plain",
      wrongLocation: "Keep Going",
      intendedLocation: ROOM_KEEP_GOING_TV,
      includedInRepairPlan: true,
    }));
    expect(plan.proposals).toContainEqual(expect.objectContaining({
      wiseSessionId: "long-plain",
      fromLocation: "Keep Going",
      toLocation: ROOM_KEEP_GOING_TV,
      reason: "repair_plain_tv_location",
    }));
  });

  it("moves the shorter conflicting session to the preferred free emergency room", () => {
    const longPlain = session({
      wiseSessionId: "fluke-bingo",
      wiseClassId: "699544571de459faae39bb4b",
      tutorName: "Fluke",
      studentName: "Bingo",
      location: "Keep Going",
      durationMinutes: 120,
      endTimeBangkok: "2026-05-16 20:00",
    });
    const shortPlain = session({
      wiseSessionId: "ras-pear",
      wiseClassId: "6a070c04528a4a1e18852dcd",
      tutorName: "Ras",
      studentName: "Pear",
      location: "Keep Going",
      durationMinutes: 60,
    });

    const plan = buildEmergencyRepairPlan("2026-05-16", [longPlain, shortPlain], [
      ROOM_KEEP_GOING_TV,
      ROOM_RELAX_TV,
      "Tesla",
      "Dream. Plan. Do.",
    ]);

    expect(plan.proposals).toEqual([
      expect.objectContaining({
        wiseSessionId: "ras-pear",
        fromLocation: "Keep Going",
        toLocation: ROOM_RELAX_TV,
        reason: "move_conflicting_session",
      }),
      expect.objectContaining({
        wiseSessionId: "fluke-bingo",
        fromLocation: "Keep Going",
        toLocation: ROOM_KEEP_GOING_TV,
        reason: "repair_plain_tv_location",
      }),
    ]);
    expect(plan.remainingConflictsAfterPlan).toEqual([]);
    expect(plan.confirmationToken).toBe("2026-05-16:2");
    expect(plan.requiredSessionIds).toEqual(["fluke-bingo", "ras-pear"]);
  });

  it("refuses apply mode without the emergency env flag, confirmation token, and exact session ids", () => {
    const proposals = [
      proposal({ wiseSessionId: "session-a", wiseClassId: "class-a" }),
      proposal({ wiseSessionId: "session-b", wiseClassId: "class-b" }),
    ];

    expect(() => assertEmergencyRepairApplyAllowed({
      date: "2026-05-16",
      proposals,
      confirm: "2026-05-16:2",
      sessionIds: ["session-a", "session-b"],
      env: repairEnv(false),
    })).toThrow("Wise emergency repair is disabled");

    expect(() => assertEmergencyRepairApplyAllowed({
      date: "2026-05-16",
      proposals,
      confirm: "2026-05-16:1",
      sessionIds: ["session-a", "session-b"],
      env: repairEnv(true),
    })).toThrow("expected --confirm 2026-05-16:2");

    expect(() => assertEmergencyRepairApplyAllowed({
      date: "2026-05-16",
      proposals,
      confirm: "2026-05-16:2",
      sessionIds: ["session-a"],
      env: repairEnv(true),
    })).toThrow("expected --session-ids session-a,session-b");

    expect(() => assertEmergencyRepairApplyAllowed({
      date: "2026-05-16",
      proposals,
      confirm: "2026-05-16:2",
      sessionIds: ["session-b", "session-a"],
      env: repairEnv(true),
    })).not.toThrow();
  });
});
