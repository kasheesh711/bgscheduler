import { describe, expect, it } from "vitest";
import { REMOTE_NO_ROOM_NEEDED, type AssignmentSession } from "../assignment-engine";
import { NO_ROOM_AVAILABLE, type ClassroomRoomDefinition } from "../rooms";
import {
  assignmentFingerprint,
  reconcileClassroomAssignments,
  type PreviousAssignmentRow,
} from "../reconciliation";

const rooms: ClassroomRoomDefinition[] = [
  { name: "Room A", hasTv: false, capacity: 2, category: "standard", active: true, sortOrder: 1 },
  { name: "Room B", hasTv: false, capacity: 2, category: "standard", active: true, sortOrder: 2 },
];

function session(overrides: Partial<AssignmentSession> = {}): AssignmentSession {
  const startMinute = overrides.startMinute ?? 9 * 60;
  const endMinute = overrides.endMinute ?? startMinute + 60;
  return {
    groupId: overrides.groupId ?? "group-1",
    tutorDisplayName: overrides.tutorDisplayName ?? "Tutor One",
    wiseTeacherId: overrides.wiseTeacherId ?? "teacher-1",
    wiseTeacherUserId: overrides.wiseTeacherUserId ?? "user-1",
    wiseSessionId: overrides.wiseSessionId ?? "session-1",
    wiseClassId: overrides.wiseClassId ?? "class-1",
    startTime: overrides.startTime ?? new Date("2026-05-26T02:00:00.000Z"),
    endTime: overrides.endTime ?? new Date("2026-05-26T03:00:00.000Z"),
    weekday: overrides.weekday ?? 2,
    startMinute,
    endMinute,
    wiseStatus: overrides.wiseStatus ?? "CONFIRMED",
    sessionType: overrides.sessionType ?? "OFFLINE",
    currentWiseLocation: overrides.currentWiseLocation ?? null,
    studentName: overrides.studentName ?? "Student One",
    studentCount: overrides.studentCount ?? 1,
    subject: overrides.subject ?? "Math",
    classType: overrides.classType ?? "ONE_TO_ONE",
    title: overrides.title ?? "Math class",
  };
}

function previous(overrides: Partial<PreviousAssignmentRow> = {}): PreviousAssignmentRow {
  const base = session(overrides);
  return {
    ...base,
    id: overrides.id ?? `row-${base.wiseSessionId}`,
    minCapacity: overrides.minCapacity ?? 1,
    needsTv: overrides.needsTv ?? false,
    preferredRoom: overrides.preferredRoom ?? null,
    overrideRoom: overrides.overrideRoom ?? null,
    assignedRoom: overrides.assignedRoom ?? "Room A",
    status: overrides.status ?? "assigned",
    warnings: overrides.warnings ?? [],
    ruleTrace: overrides.ruleTrace ?? ["previous"],
    publishStatus: overrides.publishStatus ?? "success",
    publishError: overrides.publishError ?? null,
    publishedAt: overrides.publishedAt === undefined ? new Date("2026-05-25T00:00:00.000Z") : overrides.publishedAt,
    assignmentFingerprint: overrides.assignmentFingerprint ?? assignmentFingerprint(base),
  };
}

describe("reconcileClassroomAssignments", () => {
  it("carries unchanged rows forward with publish state intact", () => {
    const current = session();
    const result = reconcileClassroomAssignments({
      sessions: [current],
      previousRows: [previous()],
      rooms,
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      sourceRowId: "row-session-1",
      changeType: "carried",
      assignedRoom: "Room A",
      publishStatus: "success",
    });
    expect(result.events).toEqual([]);
    expect(result.summary.carried).toBe(1);
  });

  it("records canceled sessions and omits them from the next run", () => {
    const result = reconcileClassroomAssignments({
      sessions: [],
      previousRows: [previous()],
      rooms,
    });

    expect(result.rows).toEqual([]);
    expect(result.events).toEqual([
      expect.objectContaining({
        type: "canceled",
        wiseSessionId: "session-1",
        sourceRowId: "row-session-1",
      }),
    ]);
    expect(result.summary.canceled).toBe(1);
  });

  it("assigns new sessions against carried fixed room blocks", () => {
    const carried = previous({ wiseSessionId: "existing", assignedRoom: "Room A" });
    const added = session({ wiseSessionId: "new", tutorDisplayName: "Tutor Two", groupId: "group-2" });

    const result = reconcileClassroomAssignments({
      sessions: [session({ wiseSessionId: "existing" }), added],
      previousRows: [carried],
      rooms,
    });

    const newRow = result.rows.find((row) => row.wiseSessionId === "new");
    expect(newRow).toMatchObject({
      changeType: "added",
      assignedRoom: "Room B",
      publishStatus: "not_published",
    });
  });

  it("detects same-session reschedules and resets publish state", () => {
    const oldRow = previous();
    const current = session({
      wiseSessionId: "session-1",
      startTime: new Date("2026-05-26T04:00:00.000Z"),
      endTime: new Date("2026-05-26T05:00:00.000Z"),
      startMinute: 11 * 60,
      endMinute: 12 * 60,
    });

    const result = reconcileClassroomAssignments({
      sessions: [current],
      previousRows: [oldRow],
      rooms,
    });

    expect(result.rows[0]).toMatchObject({
      changeType: "rescheduled",
      publishStatus: "not_published",
    });
    expect(result.events[0]).toMatchObject({ type: "rescheduled" });
  });

  it("unlocks the smallest overlapping carried set when a new class cannot fit", () => {
    const singleRoom = [rooms[0]];
    const oldRow = previous({ wiseSessionId: "existing", assignedRoom: "Room A" });
    const newSession = session({
      wiseSessionId: "new",
      tutorDisplayName: "Tutor Two",
      groupId: "group-2",
      startMinute: 9 * 60,
      endMinute: 10 * 60,
    });

    const result = reconcileClassroomAssignments({
      sessions: [session({ wiseSessionId: "existing" }), newSession],
      previousRows: [oldRow],
      rooms: singleRoom,
    });

    expect(result.rows.map((row) => row.wiseSessionId).sort()).toEqual(["existing", "new"]);
    expect(result.rows.filter((row) => row.assignedRoom === NO_ROOM_AVAILABLE)).toHaveLength(1);
    expect(result.rows.find((row) => row.wiseSessionId === "existing")?.changeType).toBe("carried");
  });

  it("does not move hard-pinned override rows during minimal displacement", () => {
    const singleRoom = [rooms[0]];
    const pinned = previous({
      wiseSessionId: "pinned",
      assignedRoom: "Room A",
      overrideRoom: "Room A",
    });
    const newSession = session({
      wiseSessionId: "new",
      tutorDisplayName: "Tutor Two",
      groupId: "group-2",
    });

    const result = reconcileClassroomAssignments({
      sessions: [session({ wiseSessionId: "pinned" }), newSession],
      previousRows: [pinned],
      rooms: singleRoom,
    });

    expect(result.rows.find((row) => row.wiseSessionId === "pinned")).toMatchObject({
      assignedRoom: "Room A",
      overrideRoom: "Room A",
      changeType: "carried",
    });
    expect(result.rows.find((row) => row.wiseSessionId === "new")).toMatchObject({
      assignedRoom: NO_ROOM_AVAILABLE,
      changeType: "added",
    });
  });

  it("keeps remote carried rows as remote/no-room-needed", () => {
    const current = session({ sessionType: "SCHEDULED" });
    const result = reconcileClassroomAssignments({
      sessions: [current],
      previousRows: [
        previous({
          sessionType: "SCHEDULED",
          assignedRoom: REMOTE_NO_ROOM_NEEDED,
          status: "remote",
        }),
      ],
      rooms,
    });

    expect(result.rows[0]).toMatchObject({
      assignedRoom: REMOTE_NO_ROOM_NEEDED,
      status: "remote",
      changeType: "carried",
    });
  });
});
