import { describe, expect, it } from "vitest";
import {
  FLOOR_PLAN_ASSIGNABLE_ROOM_NAMES,
  getFloorPlanGeometry,
} from "../floor-plan";
import { DEFAULT_CLASSROOM_ROOMS, NO_ROOM_AVAILABLE } from "../rooms";
import {
  buildHeatmapCells,
  buildRoomCalendarEvents,
  buildRoomOccupancyState,
  buildTimelineBounds,
  type ClassroomVisualizationRoom,
  type ClassroomVisualizationRow,
  REVIEW_LANE_ROOM_NAME,
} from "../visualization";
import { REMOTE_NO_ROOM_NEEDED } from "../assignment-engine";

function rooms(): ClassroomVisualizationRoom[] {
  return DEFAULT_CLASSROOM_ROOMS.map((room, index) => ({
    id: `room-${index}`,
    ...room,
  }));
}

function row(overrides: Partial<ClassroomVisualizationRow> = {}): ClassroomVisualizationRow {
  return {
    id: overrides.id ?? "row-1",
    tutorDisplayName: overrides.tutorDisplayName ?? "Tutor One",
    startMinute: overrides.startMinute ?? 9 * 60,
    endMinute: overrides.endMinute ?? 10 * 60,
    sessionType: overrides.sessionType ?? "OFFLINE",
    studentName: overrides.studentName ?? "Student One",
    studentCount: overrides.studentCount ?? 1,
    subject: overrides.subject ?? "Math",
    classType: overrides.classType ?? "ONE_TO_ONE",
    title: overrides.title ?? "Math",
    minCapacity: overrides.minCapacity ?? 1,
    overrideRoom: overrides.overrideRoom ?? null,
    assignedRoom: overrides.assignedRoom ?? "Focus",
    status: overrides.status ?? "assigned",
    warnings: overrides.warnings ?? [],
  };
}

describe("classroom floor plan geometry", () => {
  it("covers every active default room with assignable geometry", () => {
    const missing = DEFAULT_CLASSROOM_ROOMS
      .filter((room) => room.active)
      .map((room) => room.name)
      .filter((roomName) => !getFloorPlanGeometry(roomName)?.assignable);

    expect(missing).toEqual([]);
    expect(new Set(FLOOR_PLAN_ASSIGNABLE_ROOM_NAMES).size).toBe(FLOOR_PLAN_ASSIGNABLE_ROOM_NAMES.length);
  });
});

describe("classroom visualization helpers", () => {
  it("keeps default day bounds and starts playback at the earliest session", () => {
    const bounds = buildTimelineBounds([
      row({ startMinute: 9 * 60, endMinute: 10 * 60 }),
      row({ id: "row-2", startMinute: 15 * 60, endMinute: 16 * 60 }),
    ]);

    expect(bounds).toEqual({
      startMinute: 7 * 60,
      endMinute: 21 * 60,
      initialMinute: 9 * 60,
    });
  });

  it("expands day bounds only when rows fall outside the default day", () => {
    const bounds = buildTimelineBounds([
      row({ startMinute: 6 * 60 + 30, endMinute: 7 * 60 + 30 }),
      row({ id: "row-2", startMinute: 20 * 60 + 30, endMinute: 21 * 60 + 15 }),
    ]);

    expect(bounds.startMinute).toBe(6 * 60 + 30);
    expect(bounds.endMinute).toBe(21 * 60 + 15);
  });

  it("treats active occupancy as start inclusive and end exclusive", () => {
    const atStart = buildRoomOccupancyState([row()], rooms(), 9 * 60);
    const atEnd = buildRoomOccupancyState([row()], rooms(), 10 * 60);

    expect(atStart.rooms.find((room) => room.room.name === "Focus")?.activeRows).toHaveLength(1);
    expect(atEnd.rooms.find((room) => room.room.name === "Focus")?.activeRows).toHaveLength(0);
  });

  it("uses studentCount before minCapacity for room load ratio", () => {
    const state = buildRoomOccupancyState(
      [row({ assignedRoom: "Relax", studentCount: 4, minCapacity: 1 })],
      rooms(),
      9 * 60 + 15,
    );

    const relax = state.rooms.find((room) => room.room.name === "Relax");
    expect(relax?.load).toBe(4);
    expect(relax?.loadRatio).toBe(0.5);
  });

  it("routes no-room, unknown-room, and warning rows to review instead of physical rooms", () => {
    const state = buildRoomOccupancyState(
      [
        row({ id: "no-room", assignedRoom: NO_ROOM_AVAILABLE, status: "no_room" }),
        row({ id: "unknown", assignedRoom: "Storage Closet" }),
        row({ id: "warning", assignedRoom: "Focus", warnings: ["needs_review_missing_capacity"] }),
      ],
      rooms(),
      9 * 60 + 15,
    );

    expect(state.rooms.find((room) => room.room.name === "Focus")?.activeRows).toHaveLength(0);
    expect(state.reviewRows.map((reviewRow) => reviewRow.id).sort()).toEqual([
      "no-room",
      "unknown",
      "warning",
    ]);
  });

  it("excludes remote online rows from occupancy, heat maps, review lanes, and timeline bounds", () => {
    const remote = row({
      id: "remote",
      assignedRoom: REMOTE_NO_ROOM_NEEDED,
      status: "remote",
      sessionType: "SCHEDULED",
      startMinute: 23 * 60,
      endMinute: 24 * 60,
    });
    const onsite = row({
      id: "onsite",
      assignedRoom: "Focus",
      startMinute: 9 * 60,
      endMinute: 10 * 60,
    });

    const state = buildRoomOccupancyState([remote], rooms(), 23 * 60 + 15);
    const cells = buildHeatmapCells([remote], rooms(), {
      startMinute: 23 * 60,
      endMinute: 24 * 60,
      initialMinute: 23 * 60,
    });
    const events = buildRoomCalendarEvents([remote], rooms());
    const bounds = buildTimelineBounds([remote, onsite]);

    expect(state.reviewRows).toHaveLength(0);
    expect(state.rooms.every((room) => room.activeRows.length === 0)).toBe(true);
    expect(cells.every((cell) => !cell.active)).toBe(true);
    expect(events).toHaveLength(0);
    expect(bounds.initialMinute).toBe(9 * 60);
    expect(bounds.endMinute).toBe(21 * 60);
  });

  it("marks every 15-minute heat-map bin crossed by a session", () => {
    const bounds = { startMinute: 9 * 60, endMinute: 10 * 60, initialMinute: 9 * 60 };
    const cells = buildHeatmapCells(
      [row({ startMinute: 9 * 60 + 10, endMinute: 9 * 60 + 20 })],
      rooms(),
      bounds,
    ).filter((cell) => cell.roomName === "Focus");

    expect(cells.find((cell) => cell.startMinute === 9 * 60)?.active).toBe(true);
    expect(cells.find((cell) => cell.startMinute === 9 * 60 + 15)?.active).toBe(true);
    expect(cells.find((cell) => cell.startMinute === 9 * 60 + 30)?.active).toBe(false);
  });

  it("adds a heat-map review lane when review rows exist", () => {
    const cells = buildHeatmapCells(
      [row({ assignedRoom: NO_ROOM_AVAILABLE, status: "no_room" })],
      rooms(),
      { startMinute: 9 * 60, endMinute: 9 * 60 + 15, initialMinute: 9 * 60 },
    );

    expect(cells.some((cell) => cell.roomName === REVIEW_LANE_ROOM_NAME && cell.active)).toBe(true);
  });

  it("splits overlapping room-calendar events into lanes", () => {
    const events = buildRoomCalendarEvents(
      [
        row({ id: "first", assignedRoom: "Focus", startMinute: 9 * 60, endMinute: 10 * 60 }),
        row({ id: "second", assignedRoom: "Focus", startMinute: 9 * 60 + 30, endMinute: 10 * 60 + 30 }),
      ],
      rooms(),
    ).filter((event) => event.roomName === "Focus");

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.lane).sort()).toEqual([0, 1]);
    expect(events.every((event) => event.laneCount === 2)).toBe(true);
    expect(events.every((event) => event.hasRoomConflict)).toBe(true);
  });
});
