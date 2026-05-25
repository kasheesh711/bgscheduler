import { describe, expect, it } from "vitest";
import {
  assignClassrooms,
  REMOTE_NO_ROOM_NEEDED,
  type AssignmentSession,
} from "../assignment-engine";
import {
  DEFAULT_CLASSROOM_ROOMS,
  NO_ROOM_AVAILABLE,
  ROOM_JOY,
  ROOM_THINK_OUTSIDE_THE_BOX,
  type ClassroomRoomDefinition,
} from "../rooms";

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

const rememberOnlyRoom: ClassroomRoomDefinition[] = [{
  name: "Remember (TV)",
  hasTv: true,
  capacity: 2,
  category: "standard",
  active: true,
  sortOrder: 1,
}];

function roomByName(name: string): ClassroomRoomDefinition {
  const room = DEFAULT_CLASSROOM_ROOMS.find((candidate) => candidate.name === name);
  if (!room) throw new Error(`Missing default room ${name}`);
  return { ...room };
}

function roomsFor(...names: string[]): ClassroomRoomDefinition[] {
  return names.map((name, index) => ({ ...roomByName(name), sortOrder: index + 1 }));
}

describe("assignClassrooms", () => {
  it("uses Wise studentCount for capacity and selects the smallest sufficient room", () => {
    const result = assignClassrooms([
      session({ studentCount: 8, classType: "GROUP" }),
    ], DEFAULT_CLASSROOM_ROOMS);

    expect(result.rows[0]).toMatchObject({
      minCapacity: 8,
      assignedRoom: "Relax (TV)",
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

  it("treats overlapping live Wise room blocks as unavailable", () => {
    const result = assignClassrooms(
      [session({ wiseSessionId: "local", startMinute: 9 * 60, endMinute: 10 * 60 })],
      rememberOnlyRoom,
      new Map(),
      {
        externalRoomBlocks: [{
          wiseSessionId: "external",
          className: "External class",
          location: "Remember (TV)",
          startMinute: 9 * 60 + 30,
          endMinute: 10 * 60 + 30,
        }],
      },
    );

    expect(result.rows[0]).toMatchObject({
      assignedRoom: NO_ROOM_AVAILABLE,
      status: "no_room",
    });
  });

  it("normalizes plain live Wise TV room blocks to the canonical physical room", () => {
    const result = assignClassrooms(
      [session({ wiseSessionId: "local", startMinute: 9 * 60, endMinute: 10 * 60 })],
      rememberOnlyRoom,
      new Map(),
      {
        externalRoomBlocks: [{
          wiseSessionId: "external",
          className: "External class",
          location: "Remember",
          startMinute: 9 * 60 + 30,
          endMinute: 10 * 60 + 30,
        }],
      },
    );

    expect(result.rows[0].assignedRoom).toBe(NO_ROOM_AVAILABLE);
  });

  it("ignores non-overlapping live Wise room blocks", () => {
    const result = assignClassrooms(
      [session({ wiseSessionId: "local", startMinute: 9 * 60, endMinute: 10 * 60 })],
      rememberOnlyRoom,
      new Map(),
      {
        externalRoomBlocks: [{
          wiseSessionId: "external",
          className: "External class",
          location: "Remember (TV)",
          startMinute: 10 * 60,
          endMinute: 11 * 60,
        }],
      },
    );

    expect(result.rows[0]).toMatchObject({
      assignedRoom: "Remember (TV)",
      status: "assigned",
    });
  });

  it("marks online-only days remote and blocks online-only rooms for offline sessions", () => {
    const online = assignClassrooms([
      session({ sessionType: "ONLINE", studentCount: 1 }),
    ], DEFAULT_CLASSROOM_ROOMS);
    const offline = assignClassrooms([
      session({ sessionType: "OFFLINE", studentCount: 1 }),
    ], DEFAULT_CLASSROOM_ROOMS);

    expect(online.rows[0].assignedRoom).toBe(REMOTE_NO_ROOM_NEEDED);
    expect(online.rows[0].status).toBe("remote");
    expect(offline.rows[0].assignedRoom).not.toMatch(/online/i);
  });

  it("treats Wise SCHEDULED sessions as online and marks online-only days remote", () => {
    const result = assignClassrooms([
      session({ sessionType: "SCHEDULED", studentCount: 1 }),
    ], DEFAULT_CLASSROOM_ROOMS);

    expect(result.rows[0]).toMatchObject({
      assignedRoom: REMOTE_NO_ROOM_NEEDED,
      status: "remote",
    });
    expect(result.counts.remoteCount).toBe(1);
  });

  it("assigns an online room when an online class starts less than 60 minutes before onsite", () => {
    const result = assignClassrooms([
      session({
        wiseSessionId: "online",
        sessionType: "SCHEDULED",
        startMinute: 9 * 60,
        endMinute: 10 * 60,
      }),
      session({
        wiseSessionId: "onsite",
        sessionType: "OFFLINE",
        startMinute: 10 * 60 + 59,
        endMinute: 12 * 60,
      }),
    ], DEFAULT_CLASSROOM_ROOMS);

    const online = result.rows.find((row) => row.wiseSessionId === "online")!;
    expect(online.status).toBe("assigned");
    expect(online.assignedRoom).not.toBe(REMOTE_NO_ROOM_NEEDED);
  });

  it("marks an online class remote when the gap to onsite is exactly 60 minutes", () => {
    const result = assignClassrooms([
      session({
        wiseSessionId: "online",
        sessionType: "SCHEDULED",
        startMinute: 9 * 60,
        endMinute: 10 * 60,
      }),
      session({
        wiseSessionId: "onsite",
        sessionType: "OFFLINE",
        startMinute: 11 * 60,
        endMinute: 12 * 60,
      }),
    ], DEFAULT_CLASSROOM_ROOMS);

    const online = result.rows.find((row) => row.wiseSessionId === "online")!;
    expect(online.status).toBe("remote");
    expect(online.assignedRoom).toBe(REMOTE_NO_ROOM_NEEDED);
  });

  it("marks later online classes remote after a 60-minute gap with no later onsite class", () => {
    const result = assignClassrooms([
      session({
        wiseSessionId: "onsite",
        sessionType: "OFFLINE",
        startMinute: 9 * 60,
        endMinute: 10 * 60,
      }),
      session({
        wiseSessionId: "connected-online",
        sessionType: "SCHEDULED",
        startMinute: 10 * 60 + 30,
        endMinute: 11 * 60 + 30,
      }),
      session({
        wiseSessionId: "remote-online",
        sessionType: "SCHEDULED",
        startMinute: 12 * 60 + 30,
        endMinute: 13 * 60 + 30,
      }),
    ], DEFAULT_CLASSROOM_ROOMS);

    expect(result.rows.find((row) => row.wiseSessionId === "connected-online")?.status).toBe("assigned");
    expect(result.rows.find((row) => row.wiseSessionId === "remote-online")).toMatchObject({
      status: "remote",
      assignedRoom: REMOTE_NO_ROOM_NEEDED,
    });
  });

  it("prefers the tutor's same room for center-required online sessions", () => {
    const result = assignClassrooms([
      session({
        wiseSessionId: "onsite",
        tutorDisplayName: "Tutor One",
        sessionType: "OFFLINE",
        startMinute: 9 * 60,
        endMinute: 10 * 60,
      }),
      session({
        wiseSessionId: "online",
        tutorDisplayName: "Tutor One",
        sessionType: "SCHEDULED",
        startMinute: 10 * 60 + 30,
        endMinute: 11 * 60 + 30,
      }),
    ], DEFAULT_CLASSROOM_ROOMS);

    const onsite = result.rows.find((row) => row.wiseSessionId === "onsite")!;
    const online = result.rows.find((row) => row.wiseSessionId === "online")!;
    expect(online.assignedRoom).toBe(onsite.assignedRoom);
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

    expect(result.rows.find((row) => row.wiseSessionId === "gift")?.assignedRoom).toBe(ROOM_JOY);
    expect(result.rows.find((row) => row.wiseSessionId === "other")?.assignedRoom).not.toBe(ROOM_JOY);
  });

  it("honors preferred rooms before general rooms when valid", () => {
    const result = assignClassrooms([
      session({ tutorDisplayName: "Apivit (Ek) Sirithana" }),
    ], DEFAULT_CLASSROOM_ROOMS);

    expect(result.rows[0].preferredRoom).toBe("OMG");
    expect(result.rows[0].assignedRoom).toBe("OMG");
  });

  it("assigns Mek to Iconic (TV) when available", () => {
    const result = assignClassrooms([
      session({ tutorDisplayName: "Rachata (Mek) Sakpuaram" }),
    ], DEFAULT_CLASSROOM_ROOMS);

    expect(result.rows[0].preferredRoom).toBe("Iconic (TV)");
    expect(result.rows[0].assignedRoom).toBe("Iconic (TV)");
    expect(result.rows[0].ruleTrace).toContain("assigned priority preferred room: Iconic (TV)");
  });

  it("gives Mek Iconic (TV) over overlapping Menika sessions", () => {
    const result = assignClassrooms([
      session({
        groupId: "menika",
        wiseSessionId: "menika",
        tutorDisplayName: "Menika (Menika) Ratnakovit",
        startMinute: 9 * 60,
        endMinute: 10 * 60,
      }),
      session({
        groupId: "mek",
        wiseSessionId: "mek",
        tutorDisplayName: "Rachata (Mek) Sakpuaram",
        startMinute: 9 * 60,
        endMinute: 10 * 60,
      }),
    ], DEFAULT_CLASSROOM_ROOMS);

    const mek = result.rows.find((row) => row.wiseSessionId === "mek")!;
    const menika = result.rows.find((row) => row.wiseSessionId === "menika")!;
    expect(mek.preferredRoom).toBe("Iconic (TV)");
    expect(mek.assignedRoom).toBe("Iconic (TV)");
    expect(menika.preferredRoom).toBe("Iconic (TV)");
    expect(menika.assignedRoom).not.toBe("Iconic (TV)");
  });

  it("matches preferred room rules against Wise nickname display names", () => {
    const result = assignClassrooms([
      session({ tutorDisplayName: "Da" }),
      session({ tutorDisplayName: "Gift", wiseSessionId: "gift" }),
    ], DEFAULT_CLASSROOM_ROOMS);

    expect(result.rows.find((row) => row.tutorDisplayName === "Da")?.assignedRoom).toBe("Do It");
    expect(result.rows.find((row) => row.tutorDisplayName === "Gift")?.assignedRoom).toBe(ROOM_JOY);
  });

  it("uses core teaching rooms before non-priority rooms for generic sessions", () => {
    const result = assignClassrooms(
      [session({ studentCount: 1 })],
      [
        { name: "Side Room", hasTv: false, capacity: 1, category: "standard", active: true, sortOrder: 1 },
        { ...roomByName(ROOM_THINK_OUTSIDE_THE_BOX), sortOrder: 2 },
      ],
    );

    expect(result.rows[0].assignedRoom).toBe(ROOM_THINK_OUTSIDE_THE_BOX);
    expect(result.rows[0].ruleTrace).toContain(`assigned priority-scored standard room: ${ROOM_THINK_OUTSIDE_THE_BOX}`);
  });

  it.each([
    { tutorDisplayName: "Buzz", preferredRoom: "Tesla" },
    { tutorDisplayName: "Lukas", preferredRoom: "Keep Going (TV)" },
    { tutorDisplayName: "Mookie", preferredRoom: "Nerd" },
    { tutorDisplayName: "Tito", preferredRoom: ROOM_THINK_OUTSIDE_THE_BOX },
    { tutorDisplayName: "Ek", preferredRoom: "OMG" },
  ])("protects $tutorDisplayName's preferred room from an earlier overlapping generic session", ({ tutorDisplayName, preferredRoom }) => {
    const result = assignClassrooms(
      [
        session({
          wiseSessionId: "generic",
          tutorDisplayName: "Generic Tutor",
          startMinute: 9 * 60,
          endMinute: 11 * 60,
        }),
        session({
          wiseSessionId: "preferred",
          tutorDisplayName,
          startMinute: 10 * 60,
          endMinute: 11 * 60,
        }),
      ],
      roomsFor(preferredRoom, "Remember (TV)"),
    );

    const generic = result.rows.find((row) => row.wiseSessionId === "generic")!;
    const preferred = result.rows.find((row) => row.wiseSessionId === "preferred")!;
    expect(generic.assignedRoom).not.toBe(preferredRoom);
    expect(preferred.preferredRoom).toBe(preferredRoom);
    expect(preferred.assignedRoom).toBe(preferredRoom);
  });

  it("protects Mek's Iconic (TV) priority from an earlier overlapping generic session", () => {
    const result = assignClassrooms(
      [
        session({
          wiseSessionId: "generic",
          tutorDisplayName: "Generic Tutor",
          startMinute: 9 * 60,
          endMinute: 11 * 60,
        }),
        session({
          wiseSessionId: "mek",
          tutorDisplayName: "Mek",
          startMinute: 10 * 60,
          endMinute: 11 * 60,
        }),
      ],
      roomsFor("Iconic (TV)", "Remember (TV)"),
    );

    const generic = result.rows.find((row) => row.wiseSessionId === "generic")!;
    const mek = result.rows.find((row) => row.wiseSessionId === "mek")!;
    expect(generic.assignedRoom).not.toBe("Iconic (TV)");
    expect(mek.preferredRoom).toBe("Iconic (TV)");
    expect(mek.assignedRoom).toBe("Iconic (TV)");
  });

  it("still assigns Menika to Iconic (TV) when Mek is not competing", () => {
    const result = assignClassrooms([
      session({ tutorDisplayName: "Menika (Menika) Ratnakovit" }),
    ], DEFAULT_CLASSROOM_ROOMS);

    expect(result.rows[0].preferredRoom).toBe("Iconic (TV)");
    expect(result.rows[0].assignedRoom).toBe("Iconic (TV)");
  });

  it("honors Mek's own valid room override instead of automatic Iconic (TV) priority", () => {
    const result = assignClassrooms(
      [
        session({
          groupId: "mek",
          wiseSessionId: "mek",
          tutorDisplayName: "Rachata (Mek) Sakpuaram",
        }),
      ],
      DEFAULT_CLASSROOM_ROOMS,
      new Map([["mek", "Turn The Page (TV)"]]),
    );

    expect(result.rows[0].preferredRoom).toBe("Iconic (TV)");
    expect(result.rows[0].assignedRoom).toBe("Turn The Page (TV)");
    expect(result.rows[0].ruleTrace).toContain("assigned by override: Turn The Page (TV)");
  });

  it("requires a TV-capable room for Rasna without pinning her to one exact room", () => {
    const result = assignClassrooms(
      [session({ tutorDisplayName: "Rasna", studentCount: 1 })],
      roomsFor("Focus", "Iconic (TV)"),
    );

    expect(result.rows[0].needsTv).toBe(true);
    expect(result.rows[0].preferredRoom).toBeNull();
    expect(result.rows[0].assignedRoom).toBe("Iconic (TV)");
  });

  it("treats Dream. Plan. Do. as a priority standard room before non-core rooms", () => {
    const result = assignClassrooms(
      [session({ studentCount: 1 })],
      [
        { name: "Side Room", hasTv: false, capacity: 1, category: "standard", active: true, sortOrder: 1 },
        { ...roomByName("Dream. Plan. Do."), sortOrder: 2 },
      ],
    );

    expect(result.rows[0].assignedRoom).toBe("Dream. Plan. Do.");
  });

  it("gives Kevin Think Outside the Box over overlapping automatic preferred-room sessions", () => {
    const result = assignClassrooms([
      session({
        groupId: "tito",
        wiseSessionId: "tito",
        tutorDisplayName: "Smit (Tito) Kanjanapas",
        startMinute: 9 * 60,
        endMinute: 10 * 60 + 30,
      }),
      session({
        groupId: "kevin",
        wiseSessionId: "kevin",
        tutorDisplayName: "Kev",
        startMinute: 9 * 60 + 30,
        endMinute: 10 * 60 + 30,
      }),
    ], DEFAULT_CLASSROOM_ROOMS);

    const kevin = result.rows.find((row) => row.wiseSessionId === "kevin")!;
    const tito = result.rows.find((row) => row.wiseSessionId === "tito")!;
    expect(kevin.preferredRoom).toBe(ROOM_THINK_OUTSIDE_THE_BOX);
    expect(kevin.assignedRoom).toBe(ROOM_THINK_OUTSIDE_THE_BOX);
    expect(kevin.ruleTrace).toContain(`assigned Kevin priority room: ${ROOM_THINK_OUTSIDE_THE_BOX}`);
    expect(tito.preferredRoom).toBe(ROOM_THINK_OUTSIDE_THE_BOX);
    expect(tito.assignedRoom).not.toBe(ROOM_THINK_OUTSIDE_THE_BOX);
  });

  it("honors Kevin's own valid room override instead of the automatic priority room", () => {
    const result = assignClassrooms(
      [
        session({
          groupId: "kevin",
          wiseSessionId: "kevin",
          tutorDisplayName: "Kevin",
        }),
      ],
      DEFAULT_CLASSROOM_ROOMS,
      new Map([["kevin", "Turn The Page (TV)"]]),
    );

    expect(result.rows[0].assignedRoom).toBe("Turn The Page (TV)");
    expect(result.rows[0].ruleTrace).toContain("assigned by override: Turn The Page (TV)");
  });

  it("rejects inactive plain TV-room overrides", () => {
    const result = assignClassrooms(
      [
        session({
          groupId: "kevin",
          wiseSessionId: "kevin",
          tutorDisplayName: "Kevin",
        }),
      ],
      DEFAULT_CLASSROOM_ROOMS,
      new Map([["kevin", "Turn The Page"]]),
    );

    expect(result.rows[0].overrideRoom).toBe("Turn The Page");
    expect(result.rows[0].warnings).toContain("invalid_override_room");
    expect(result.rows[0].assignedRoom).not.toBe("Turn The Page");
  });

  it("lets a valid non-Kevin override to Think Outside the Box force an exception", () => {
    const result = assignClassrooms(
      [
        session({
          groupId: "kevin",
          wiseSessionId: "kevin",
          tutorDisplayName: "Kevin (Kev) Y. Hsieh",
        }),
        session({
          groupId: "other",
          wiseSessionId: "other",
          tutorDisplayName: "Tutor Two",
        }),
      ],
      DEFAULT_CLASSROOM_ROOMS,
      new Map([["other", ROOM_THINK_OUTSIDE_THE_BOX]]),
    );

    const kevin = result.rows.find((row) => row.wiseSessionId === "kevin")!;
    const other = result.rows.find((row) => row.wiseSessionId === "other")!;
    expect(other.assignedRoom).toBe(ROOM_THINK_OUTSIDE_THE_BOX);
    expect(kevin.assignedRoom).not.toBe(ROOM_THINK_OUTSIDE_THE_BOX);
    expect(kevin.ruleTrace).not.toContain(`assigned Kevin priority room: ${ROOM_THINK_OUTSIDE_THE_BOX}`);
  });

  it("does not claim Think Outside the Box for Kevin when capacity constraints fail", () => {
    const result = assignClassrooms([
      session({
        groupId: "kevin",
        wiseSessionId: "kevin",
        tutorDisplayName: "Kev",
        studentCount: 3,
        classType: "GROUP",
      }),
    ], DEFAULT_CLASSROOM_ROOMS);

    const kevin = result.rows[0];
    expect(kevin.preferredRoom).toBe(ROOM_THINK_OUTSIDE_THE_BOX);
    expect(kevin.assignedRoom).not.toBe(ROOM_THINK_OUTSIDE_THE_BOX);
    expect(DEFAULT_CLASSROOM_ROOMS.find((room) => room.name === kevin.assignedRoom)?.capacity).toBeGreaterThanOrEqual(3);
    expect(kevin.ruleTrace).not.toContain(`assigned Kevin priority room: ${ROOM_THINK_OUTSIDE_THE_BOX}`);
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
    const result = assignClassrooms(
      [
        session({ wiseSessionId: "standard", tutorDisplayName: "Tutor A" }),
        session({ wiseSessionId: "overflow", tutorDisplayName: "Tutor B" }),
      ],
      [
        { name: "Standard Room", hasTv: false, capacity: 1, category: "standard", active: true, sortOrder: 1 },
        { name: "Overflow Room", hasTv: false, capacity: 1, category: "overflow_only", active: true, sortOrder: 2 },
      ],
    );

    expect(result.rows.find((row) => row.wiseSessionId === "standard")?.assignedRoom).toBe("Standard Room");
    expect(result.rows.find((row) => row.wiseSessionId === "overflow")?.assignedRoom).toBe("Overflow Room");
  });

  it("marks no room when constraints cannot be met", () => {
    const result = assignClassrooms([
      session({ studentCount: 9, classType: "GROUP" }),
    ], DEFAULT_CLASSROOM_ROOMS);

    expect(result.rows[0].assignedRoom).toBe(NO_ROOM_AVAILABLE);
    expect(result.rows[0].status).toBe("no_room");
  });
});
