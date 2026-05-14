import { describe, expect, it } from "vitest";
import { assignClassrooms, type AssignmentSession } from "../assignment-engine";
import { DEFAULT_CLASSROOM_ROOMS, NO_ROOM_AVAILABLE } from "../rooms";

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
    startTime: overrides.startTime ?? new Date("2026-05-14T09:00:00.000Z"),
    endTime: overrides.endTime ?? new Date("2026-05-14T10:00:00.000Z"),
    weekday: overrides.weekday ?? 4,
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

describe("assignClassrooms", () => {
  it("uses Wise studentCount for capacity and selects the smallest sufficient room", () => {
    const result = assignClassrooms([
      session({ studentCount: 8, classType: "GROUP" }),
    ], DEFAULT_CLASSROOM_ROOMS);

    expect(result.rows[0]).toMatchObject({
      minCapacity: 8,
      assignedRoom: "Relax",
      status: "assigned",
    });
  });

  it("requires TV for configured tutors", () => {
    const result = assignClassrooms([
      session({ tutorDisplayName: "Roger (Roger) Tang", studentCount: 2 }),
    ], DEFAULT_CLASSROOM_ROOMS);

    expect(result.rows[0].needsTv).toBe(true);
    expect(DEFAULT_CLASSROOM_ROOMS.find((room) => room.name === result.rows[0].assignedRoom)?.hasTv).toBe(true);
  });

  it("keeps online-only rooms for online sessions and blocks them for offline sessions", () => {
    const online = assignClassrooms([
      session({ sessionType: "ONLINE", studentCount: 1 }),
    ], DEFAULT_CLASSROOM_ROOMS);
    const offline = assignClassrooms([
      session({ sessionType: "OFFLINE", studentCount: 1 }),
    ], DEFAULT_CLASSROOM_ROOMS);

    expect(online.rows[0].assignedRoom).toBe("I learned (online)");
    expect(offline.rows[0].assignedRoom).not.toMatch(/online/i);
  });

  it("hard-fixes Gift to Joy and routes overlapping non-Gift work elsewhere", () => {
    const result = assignClassrooms([
      session({
        wiseSessionId: "gift",
        tutorDisplayName: "Wanwisa (Gift) Montrikittiphant",
        studentName: "Gift Student",
      }),
      session({
        wiseSessionId: "other",
        tutorDisplayName: "Tutor Two",
        studentName: "Other Student",
      }),
    ], DEFAULT_CLASSROOM_ROOMS);

    expect(result.rows.find((row) => row.wiseSessionId === "gift")?.assignedRoom).toBe("Joy");
    expect(result.rows.find((row) => row.wiseSessionId === "other")?.assignedRoom).not.toBe("Joy");
  });

  it("honors preferred rooms before general rooms when valid", () => {
    const result = assignClassrooms([
      session({ tutorDisplayName: "Apivit (Ek) Sirithana" }),
    ], DEFAULT_CLASSROOM_ROOMS);

    expect(result.rows[0].preferredRoom).toBe("OMG");
    expect(result.rows[0].assignedRoom).toBe("OMG");
  });

  it("matches preferred room rules against Wise nickname display names", () => {
    const result = assignClassrooms([
      session({ tutorDisplayName: "Da" }),
      session({ tutorDisplayName: "Gift", wiseSessionId: "gift" }),
    ], DEFAULT_CLASSROOM_ROOMS);

    expect(result.rows.find((row) => row.tutorDisplayName === "Da")?.assignedRoom).toBe("Do It");
    expect(result.rows.find((row) => row.tutorDisplayName === "Gift")?.assignedRoom).toBe("Joy");
  });

  it("keeps continuity for the same tutor with a 15-minute gap", () => {
    const result = assignClassrooms([
      session({
        wiseSessionId: "first",
        tutorDisplayName: "Tutor One",
        startMinute: 9 * 60,
        endMinute: 10 * 60,
      }),
      session({
        wiseSessionId: "second",
        tutorDisplayName: "Tutor One",
        startMinute: 10 * 60 + 15,
        endMinute: 11 * 60,
      }),
    ], DEFAULT_CLASSROOM_ROOMS);

    const first = result.rows.find((row) => row.wiseSessionId === "first")!;
    const second = result.rows.find((row) => row.wiseSessionId === "second")!;
    expect(second.assignedRoom).toBe(first.assignedRoom);
  });

  it("rejects invalid overrides and falls back to a valid room", () => {
    const result = assignClassrooms(
      [session()],
      DEFAULT_CLASSROOM_ROOMS,
      new Map([["session-1", "Not A Room"]]),
    );

    expect(result.rows[0].overrideRoom).toBe("Not A Room");
    expect(result.rows[0].warnings).toContain("invalid_override_room");
    expect(result.rows[0].assignedRoom).not.toBe("Not A Room");
  });

  it("uses overflow only after standard rooms are exhausted", () => {
    const sessions = DEFAULT_CLASSROOM_ROOMS
      .filter((room) => room.category === "standard" && room.capacity >= 3)
      .map((_, index) =>
        session({
          wiseSessionId: `standard-${index}`,
          tutorDisplayName: `Tutor ${index}`,
          studentName: `Student ${index}`,
          studentCount: 3,
          classType: "GROUP",
        }),
      );
    sessions.push(session({
      wiseSessionId: "overflow",
      tutorDisplayName: "ZZZ Overflow Tutor",
      studentName: "Overflow Student",
      studentCount: 3,
      classType: "GROUP",
    }));

    const result = assignClassrooms(sessions, DEFAULT_CLASSROOM_ROOMS);

    expect(result.rows.find((row) => row.wiseSessionId === "overflow")?.assignedRoom).toBe("Dream. Plan. Do.");
  });

  it("marks no room when constraints cannot be met", () => {
    const result = assignClassrooms([
      session({ studentCount: 9, classType: "GROUP" }),
    ], DEFAULT_CLASSROOM_ROOMS);

    expect(result.rows[0].assignedRoom).toBe(NO_ROOM_AVAILABLE);
    expect(result.rows[0].status).toBe("no_room");
  });
});
