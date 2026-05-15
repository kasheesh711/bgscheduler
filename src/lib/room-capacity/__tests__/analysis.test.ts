import { describe, expect, it } from "vitest";
import { NO_ROOM_AVAILABLE } from "@/lib/classrooms/rooms";
import {
  buildDemandMixFromSessions,
  buildHeatmapCells,
  buildOvercapIntervals,
  findProjectedNoRoomRows,
  findUnmatchedCurrentAllocations,
  normalizeRoomLabel,
} from "../analysis";
import type { RoomCapacityRoom, RoomCapacitySession } from "../types";

function room(overrides: Partial<RoomCapacityRoom> = {}): RoomCapacityRoom {
  return {
    id: "room-1",
    name: "Focus",
    capacity: 2,
    hasTv: false,
    category: "standard",
    active: true,
    sortOrder: 1,
    ...overrides,
  };
}

function session(overrides: Partial<RoomCapacitySession> = {}): RoomCapacitySession {
  return {
    id: overrides.id ?? "session-1",
    groupId: "group-1",
    tutorDisplayName: overrides.tutorDisplayName ?? "Tutor One",
    wiseTeacherId: "teacher-1",
    wiseTeacherUserId: null,
    wiseSessionId: overrides.wiseSessionId ?? overrides.id ?? "session-1",
    wiseClassId: null,
    startTime: new Date("2026-05-15T02:00:00.000Z"),
    endTime: new Date("2026-05-15T03:00:00.000Z"),
    date: "2026-05-15",
    weekday: 5,
    startMinute: 9 * 60,
    endMinute: 10 * 60,
    wiseStatus: "CONFIRMED",
    sessionType: "OFFLINE",
    currentWiseLocation: "Focus",
    studentCount: 1,
    subject: "Math",
    classType: "ONE_TO_ONE",
    title: "Math A",
    ...overrides,
  };
}

describe("room capacity analysis", () => {
  it("normalizes Wise room labels with TV and lab suffixes", () => {
    expect(normalizeRoomLabel("Focus (TV)")).toBe("Focus");
    expect(normalizeRoomLabel("Room 2 📺 (Lab)")).toBe("Room 2");
    expect(normalizeRoomLabel("  Joy   :television:  ")).toBe("Joy");
  });

  it("detects exact overlapping overcap intervals and heatmap load", () => {
    const rooms = [room()];
    const rows = [
      session({ id: "s1", tutorDisplayName: "Tutor A", studentCount: 2, currentWiseLocation: "Focus (TV)" }),
      session({
        id: "s2",
        tutorDisplayName: "Tutor B",
        startMinute: 9 * 60 + 30,
        endMinute: 10 * 60 + 30,
        studentCount: 1,
        subject: "Science",
      }),
    ];

    const overcaps = buildOvercapIntervals(rows, rooms, "current");
    const cells = buildHeatmapCells(rows, rooms, "current", "2026-05-15", "2026-05-15");
    const peak = cells.find((cell) => cell.roomName === "Focus" && cell.startMinute === 9 * 60 + 30);

    expect(overcaps).toHaveLength(1);
    expect(overcaps[0]).toMatchObject({
      roomName: "Focus",
      startMinute: 9 * 60 + 30,
      endMinute: 10 * 60,
      load: 3,
      capacity: 2,
      tutors: ["Tutor A", "Tutor B"],
    });
    expect(peak).toMatchObject({ load: 3, capacity: 2, loadRatio: 1.5, status: "over_capacity" });
  });

  it("reports missing and unknown Wise room locations", () => {
    const rows = [
      session({ id: "missing", currentWiseLocation: null }),
      session({ id: "unknown", currentWiseLocation: "Not a room" }),
    ];

    expect(findUnmatchedCurrentAllocations(rows, [room()])).toEqual([
      expect.objectContaining({ id: "missing", reason: "missing_location" }),
      expect.objectContaining({ id: "unknown", reason: "unknown_room", location: "Not a room" }),
    ]);
  });

  it("summarizes projected assignment no-room rows", () => {
    const rows = [
      session({ id: "ok", assignedRoom: "Focus", status: "assigned" }),
      session({ id: "blocked", assignedRoom: NO_ROOM_AVAILABLE, status: "no_room", warnings: ["no_room_available"] }),
    ];

    expect(findProjectedNoRoomRows(rows)).toEqual([
      expect.objectContaining({
        id: "blocked",
        assignedRoom: NO_ROOM_AVAILABLE,
        warnings: ["no_room_available"],
        classLabel: "Math",
      }),
    ]);
  });

  it("derives deterministic demand mix buckets from onsite sessions only", () => {
    const mix = buildDemandMixFromSessions([
      session({ id: "s1", startMinute: 9 * 60, endMinute: 10 * 60, studentCount: 2 }),
      session({ id: "s2", startMinute: 9 * 60, endMinute: 10 * 60, studentCount: 2 }),
      session({ id: "online", sessionType: "ONLINE", currentWiseLocation: null }),
    ]);

    expect(mix).toEqual([
      expect.objectContaining({
        weekday: 5,
        startMinute: 9 * 60,
        durationMinutes: 60,
        mode: "onsite",
        studentCount: 2,
        share: 1,
        observedSessions: 2,
      }),
    ]);
  });
});
