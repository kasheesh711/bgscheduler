import { describe, expect, it } from "vitest";
import fixture from "./fixtures/2026-09-05.json";
import { assignClassrooms, repairClassroomAssignmentRows, type AssignmentResultRow, type AssignmentSession } from "../assignment-engine";
import { DEFAULT_CLASSROOM_ROOMS, NO_ROOM_AVAILABLE, type ClassroomRoomDefinition } from "../rooms";
import { assignmentFingerprint, reconcileClassroomAssignments, type PreviousAssignmentRow } from "../reconciliation";
import { repairClassroomAssignments, ROOM_REPAIR_MAX_NODES } from "../assignment-repair";

const rooms: ClassroomRoomDefinition[] = [
  { name: "A", capacity: 3, hasTv: true, active: true, category: "standard", sortOrder: 1 },
  { name: "B", capacity: 1, hasTv: false, active: true, category: "standard", sortOrder: 2 },
];
function session(id: string, changes: Partial<AssignmentSession> = {}): AssignmentSession {
  return { groupId: id, tutorDisplayName: id, wiseTeacherId: id, wiseSessionId: id, wiseClassId: id,
    startTime: new Date("2026-09-05T05:00:00Z"), endTime: new Date("2026-09-05T06:00:00Z"),
    startMinute: 720, endMinute: 780, weekday: 6, wiseStatus: "CONFIRMED", sessionType: "OFFLINE", studentCount: 1, ...changes };
}
function row(id: string, assignedRoom: string, changes: Partial<AssignmentResultRow> = {}): AssignmentResultRow {
  return { ...session(id), assignedRoom, status: assignedRoom === NO_ROOM_AVAILABLE ? "no_room" : "assigned",
    minCapacity: 1, needsTv: false, preferredRoom: null, overrideRoom: null, warnings: [], ruleTrace: [], ...changes };
}
function previous(r: AssignmentResultRow): PreviousAssignmentRow {
  return { ...r, id: `previous-${r.wiseSessionId}`, publishStatus: "success", publishError: null,
    publishedAt: new Date("2026-09-04"), assignmentFingerprint: "legacy-snapshot-dependent-hash" };
}
function assertNoOverlap(rows: AssignmentResultRow[]) {
  const placed = rows.filter(r => r.status === "assigned" || r.status === "needs_review");
  for (const [i, a] of placed.entries()) for (const b of placed.slice(i + 1)) {
    expect(a.assignedRoom === b.assignedRoom && a.startMinute < b.endMinute && b.startMinute < a.endMinute,
      `${a.tutorDisplayName} and ${b.tutorDisplayName} overlap in ${a.assignedRoom}`).toBe(false);
  }
}

describe("classroom incident regressions", () => {
  it("fits September 5 including all five Shop classes without overlaps or relaxed hard constraints", () => {
    // Nicknames retain the code-owned tutor rules; all student and Wise identifiers are synthetic.
    const sessions = fixture.map(r => ({ ...r, startTime: new Date(r.startTime), endTime: new Date(r.endTime) }));
    const result = assignClassrooms(sessions, DEFAULT_CLASSROOM_ROOMS);
    expect(result.counts).toMatchObject({ totalSessions: 170, noRoomCount: 0, remoteCount: 6 });
    expect(result.rows.filter(r => r.tutorDisplayName === "Shop")).toHaveLength(5);
    expect(result.rows.filter(r => r.tutorDisplayName === "Shop").every(r => r.status === "assigned")).toBe(true);
    for (const r of result.rows.filter(r => r.status === "assigned")) {
      const room = DEFAULT_CLASSROOM_ROOMS.find(room => room.name === r.assignedRoom)!;
      expect(room.capacity).toBeGreaterThanOrEqual(r.minCapacity);
      if (r.needsTv) expect(room.hasTv).toBe(true);
      if (r.sessionType === "OFFLINE") expect(room.category).not.toBe("online_only");
      if (r.tutorDisplayName === "Gift") expect(room.name).toBe("Joy (TV)");
      if (r.tutorDisplayName === "Kevin") expect(room.name).toBe("Think Outside the Box");
      if (r.tutorDisplayName === "Mek") expect(room.name).toBe("Iconic (TV)");
      if (r.tutorDisplayName === "Ras") expect(room.name).toBe("Never Ever (TV)");
    }
    assertNoOverlap(result.rows);
  }, 30_000);

  it("releases a preferred room claim when continuity places its owner elsewhere", () => {
    const catalog = DEFAULT_CLASSROOM_ROOMS.filter(r => ["Do It", "Iconic (TV)"].includes(r.name));
    const result = assignClassrooms([
      session("prior", { tutorDisplayName: "Menika", startMinute: 660, endMinute: 720 }),
      session("later", { tutorDisplayName: "Menika", currentWiseLocation: "Iconic (TV)" }),
      session("shop", { tutorDisplayName: "Shop" }),
    ], catalog, new Map([["prior", "Do It"]]), { repairBudget: { remaining: 0 } });
    expect(result.rows.find(r => r.wiseSessionId === "later")?.assignedRoom).toBe("Do It");
    expect(result.rows.find(r => r.wiseSessionId === "shop")?.assignedRoom).toBe("Iconic (TV)");
  });

  it("ignores rotating group IDs and old hashes while retaining actual session changes", () => {
    const old = previous(row("teacher", "A"));
    const current = { ...old, groupId: "new-snapshot-group" };
    expect(assignmentFingerprint(old)).toBe(assignmentFingerprint(current));
    const result = reconcileClassroomAssignments({ sessions: [current], previousRows: [old], rooms });
    expect(result.rows[0]).toMatchObject({ groupId: "new-snapshot-group", changeType: "carried", publishStatus: "success", assignedRoom: "A" });
    expect(result.events).toEqual([]);
    for (const change of [{ studentCount: 2 }, { tutorDisplayName: "Different" }, { wiseTeacherId: "replacement" }]) {
      expect(assignmentFingerprint({ ...current, ...change })).not.toBe(assignmentFingerprint(old));
    }
  });

  it("retries an unchanged no-room row and only moves the blocker necessary to fit it", () => {
    const old = [previous(row("small", "A")), previous(row("large", NO_ROOM_AVAILABLE, { studentCount: 3, minCapacity: 3 }))];
    const result = reconcileClassroomAssignments({ sessions: old, previousRows: old, rooms });
    expect(result.rows.find(r => r.wiseSessionId === "large")).toMatchObject({ assignedRoom: "A", changeType: "moved", publishStatus: "not_published" });
    expect(result.rows.find(r => r.wiseSessionId === "small")?.assignedRoom).toBe("B");
    assertNoOverlap(result.rows);
  });

  it("preserves explicit overrides and external Wise occupancy", () => {
    const source = [row("small", "A", { overrideRoom: "A" }), row("large", NO_ROOM_AVAILABLE, { studentCount: 3, minCapacity: 3 })];
    const result = repairClassroomAssignmentRows(source, rooms);
    expect(result[0].assignedRoom).toBe("A");
    expect(result[1].status).toBe("no_room");
    const blocked = repairClassroomAssignmentRows([source[1]], rooms, {
      externalRoomBlocks: [{ wiseSessionId: "external", className: null, location: "A", startMinute: 720, endMinute: 780 }],
    });
    expect(blocked[0].status).toBe("no_room");
  });

  it("never allocates another class into a non-publishable class's retained Wise room", () => {
    const result = repairClassroomAssignmentRows([
      row("unpublishable", NO_ROOM_AVAILABLE, { wiseClassId: null, currentWiseLocation: "A" }),
      row("large", "A", { studentCount: 3, minCapacity: 3 }),
    ], rooms);
    expect(result.find(r => r.wiseSessionId === "large")?.status).toBe("no_room");
    assertNoOverlap(result);
  });

  it("protects retained Wise occupancy even when both saved rows previously had rooms", () => {
    const saved = [previous(row("fixed", "B", { currentWiseLocation: "A", wiseClassId: null })),
      previous(row("other", "A", { minCapacity: 3, studentCount: 3 }))];
    const result = reconcileClassroomAssignments({ sessions: saved, previousRows: saved, rooms });
    expect(result.rows.find(r => r.wiseSessionId === "fixed")?.assignedRoom).toBe("A");
    expect(result.rows.find(r => r.wiseSessionId === "other")?.status).toBe("no_room");
  });

  it("reconsiders a carried assignment when a fresh external class occupies its room", () => {
    const saved = previous(row("small", "A"));
    const result = reconcileClassroomAssignments({ sessions: [saved], previousRows: [saved], rooms,
      externalRoomBlocks: [{ wiseSessionId: "external", className: null, location: "A", startMinute: 720, endMinute: 780 }] });
    expect(result.rows[0]).toMatchObject({ assignedRoom: "B", publishStatus: "not_published", changeType: "moved" });
  });

  it("repairs four displacement levels deterministically and reports the five-level limit", () => {
    const run = (length: number) => {
      const catalog = Array.from({ length: length + 1 }, (_, i) => ({ ...rooms[0], name: `R${i}`, sortOrder: i }));
      const source = [...Array.from({ length }, (_, i) => row(`blocker-${i}`, `R${i}`)), row("root", NO_ROOM_AVAILABLE)];
      const budget = { remaining: ROOM_REPAIR_MAX_NODES };
      const repaired = repairClassroomAssignments({ rows: source, rooms: catalog, externalBlocks: [], budget,
        compatible: (r, room) => r.wiseSessionId === "root" ? room.name === "R0"
          : [r.assignedRoom, `R${Number(r.wiseSessionId.split("-")[1]) + 1}`].includes(room.name),
        locked: () => false, preferenceCost: () => 0 });
      return { repaired, remaining: budget.remaining };
    };
    const four = run(4);
    expect(four.repaired.every(r => r.status === "assigned")).toBe(true);
    assertNoOverlap(four.repaired);
    expect(run(4)).toEqual(four);
    const five = run(5);
    expect(five.repaired.at(-1)?.warnings).toContain("room_repair_search_exhausted");
    expect(five.repaired.slice(0, 5).map(r => r.assignedRoom)).toEqual(["R0", "R1", "R2", "R3", "R4"]);
    expect(five.remaining).toBeGreaterThanOrEqual(0);
    expect(five.remaining).toBeLessThan(ROOM_REPAIR_MAX_NODES);
  });

  it("reports budget exhaustion separately from having no compatible room", () => {
    const budget = { remaining: 0 };
    const result = repairClassroomAssignmentRows([row("small", "A"), row("large", NO_ROOM_AVAILABLE, { minCapacity: 3, warnings: ["no_compatible_room"] })], rooms, { repairBudget: budget });
    expect(result[1].warnings).toContain("room_repair_search_exhausted");
    expect(result[1].warnings).not.toContain("no_compatible_room");
    expect(budget.remaining).toBe(0);
    const impossible = repairClassroomAssignmentRows([row("too-large", NO_ROOM_AVAILABLE, { minCapacity: 99 })], rooms);
    expect(impossible[0].warnings).toContain("no_compatible_room");
  });
});
