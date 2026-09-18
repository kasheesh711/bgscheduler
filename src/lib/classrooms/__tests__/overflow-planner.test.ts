import { describe, expect, it } from "vitest";
import { assignClassrooms, REMOTE_NO_ROOM_NEEDED, type AssignmentResultRow } from "../assignment-engine";
import { DEFAULT_CLASSROOM_ROOMS, NO_ROOM_AVAILABLE, type ClassroomRoomDefinition } from "../rooms";
import { planClassroomOverflow } from "../overflow-planner";
import { unknownStudentEvidence } from "../mode-history";
import { reconcileClassroomAssignments, type PreviousAssignmentRow } from "../reconciliation";
import { confirmedSuggestedRelease } from "../overflow-release";
import fixture from "./fixtures/2026-09-05.json";
import { physicalRoom } from "../room-policy";
import { assignmentReadinessFindings } from "../weekend-readiness";

const now = new Date("2026-09-01T00:00:00Z");
const rooms: ClassroomRoomDefinition[] = [
  { name: "A", capacity: 3, hasTv: true, category: "standard", active: true, sortOrder: 1 },
  { name: "Booth", capacity: 1, hasTv: false, category: "online_only", active: true, sortOrder: 2 },
];
function row(id: string, room = "A", changes: Partial<AssignmentResultRow> = {}): AssignmentResultRow {
  return { wiseSessionId: id, wiseClassId: `class-${id}`, wiseTeacherId: id, groupId: id, canonicalKey: id,
    tutorDisplayName: `Tutor ${id}`, studentName: `Student ${id}`, studentIds: [`student-${id}`], studentCount: 1,
    classType: "ONE_TO_ONE", startTime: new Date("2026-09-19T10:00:00Z"), endTime: new Date("2026-09-19T11:00:00Z"),
    startMinute: 600, endMinute: 660, weekday: 6, wiseStatus: "CONFIRMED", sessionType: "OFFLINE",
    assignedRoom: room, status: room === NO_ROOM_AVAILABLE ? "no_room" : "assigned", minCapacity: 1, needsTv: false,
    overrideRoom: null, preferredRoom: null, warnings: [], ruleTrace: [], ...changes };
}
const input = (rows: AssignmentResultRow[], extra = {}) => ({ rows, rooms, assignmentDate: "2026-09-19", now, ...extra });
function assertValid(rows: Array<{ wiseSessionId: string; room: string; startMinute: number; endMinute: number }>) {
  for (const [index, current] of rows.entries()) for (const other of rows.slice(index + 1)) {
    if ([NO_ROOM_AVAILABLE, REMOTE_NO_ROOM_NEEDED].includes(current.room)) continue;
    expect(physicalRoom(current.room) !== physicalRoom(other.room) || current.endMinute <= other.startMinute || other.endMinute <= current.startMinute).toBe(true);
  }
}

describe("minimum-switch overflow optimizer", () => {
  it("does nothing on a clear day", async () => {
    const rows = [row("a")];
    expect(await planClassroomOverflow(input(rows))).toEqual({ actualRows: rows, plan: null });
  });
  it("first relocates an already-online class into a dedicated room without switching students", async () => {
    const result = await planClassroomOverflow(input([row("online", "A", { sessionType: "SCHEDULED" }), row("onsite", NO_ROOM_AVAILABLE)]));
    expect(result.plan?.warnings).toEqual([]);
    expect(result.plan).toMatchObject({ status: "minimum_proven", minimumSwitches: 0, actualRemainingOverflow: 0 });
    expect(result.actualRows.find(row => row.wiseSessionId === "online")).toMatchObject({ assignedRoom: "Booth", overflowReleaseRoom: "Booth" });
    expect(result.plan?.actualActions.find(row => row.wiseSessionId === "online")?.teachingLocation).toBe("dedicated_online_room");
  });
  it("releases the classroom even when the dedicated online room is occupied", async () => {
    const result = await planClassroomOverflow(input([row("online", "A", { sessionType: "SCHEDULED" }), row("onsite", NO_ROOM_AVAILABLE)], {
      externalRoomBlocks: [{ wiseSessionId: "reservation", location: "Booth", className: null, startMinute: 590, endMinute: 670 }],
    }));
    expect(result.actualRows[0]).toMatchObject({ assignedRoom: REMOTE_NO_ROOM_NEEDED, overflowReleaseRoom: REMOTE_NO_ROOM_NEEDED });
    expect(result.plan?.minimumSwitches).toBe(0);
    expect(assignmentReadinessFindings({ date: "2026-09-19", rows: result.actualRows, rooms })
      .some(finding => finding.kind === "review" && finding.message.includes("vacate the onsite classroom"))).toBe(true);
  });
  it("finds one long switch instead of switching two separate overflow classes", async () => {
    const rows = [row("long", "A", { endMinute: 720 }), row("first", NO_ROOM_AVAILABLE), row("second", NO_ROOM_AVAILABLE, { startMinute: 660, endMinute: 720 })];
    const result = await planClassroomOverflow(input(rows));
    expect(result.plan).toMatchObject({ status: "minimum_proven", proposedSwitches: 1, predictedRemainingOverflow: 0 });
    expect(result.plan?.proposedActions.filter(action => action.kind === "switch_to_online").map(action => action.wiseSessionId)).toEqual(["long"]);
    expect(result.actualRows.every(row => row.sessionType === "OFFLINE")).toBe(true);
    expect(result.actualRows.filter(row => row.status === "no_room")).toHaveLength(2);
    expect(result.plan?.accommodatedSessionIds.sort()).toEqual(["first", "second"]);
    assertValid(result.plan!.predictedAssignments);
  });
  it("uses history only among equally small complete conversion sets", async () => {
    const evidence = new Map([["student-b", { ...unknownStudentEvidence("student-b"), tier: "online_attendance" as const, onlineAttended: 6, attendedLessons: 8, adjustedFrequency: 6 / 11 }]]);
    const result = await planClassroomOverflow(input([row("a"), row("b", NO_ROOM_AVAILABLE)], { evidence }));
    expect(result.plan?.proposedActions.filter(action => action.kind === "switch_to_online").map(action => action.wiseSessionId)).toEqual(["b"]);
    expect(result.plan?.minimumSwitches).toBe(1);
    const again = await planClassroomOverflow(input([row("a"), row("b", NO_ROOM_AVAILABLE)], { evidence }));
    expect(again.plan?.predictedAssignments).toEqual(result.plan?.predictedAssignments);
  });
  it("preserves group classes, overrides, frozen lessons and incomplete rosters", async () => {
    for (const protectedField of [{ classType: "GROUP" }, { overrideRoom: "A" }, { studentIds: null }]) {
      const result = await planClassroomOverflow(input([row("fixed", "A", protectedField), row("other", NO_ROOM_AVAILABLE)], { frozenSessionIds: new Set(["other"]) }));
      expect(result.plan).toMatchObject({ status: "no_complete_solution", minimumSwitches: null, predictedRemainingOverflow: 1 });
      expect(result.plan?.proposedActions.some(action => action.kind === "switch_to_online")).toBe(false);
    }
  });
  it("fits classes through room rearrangement before proposing conversions", async () => {
    const catalog = [rooms[0], { ...rooms[0], name: "Small", capacity: 1, sortOrder: 2 }];
    const result = await planClassroomOverflow(input([row("small"), row("large", NO_ROOM_AVAILABLE, { minCapacity: 3, studentCount: 3, classType: "GROUP" })], { rooms: catalog }));
    expect(result.plan?.minimumSwitches).toBe(0);
    expect(result.actualRows.map(row => row.assignedRoom)).toEqual(["Small", "A"]);
  });
  it("does not claim optimality or impossibility when the time budget expires", async () => {
    const result = await planClassroomOverflow(input([row("a"), row("b", NO_ROOM_AVAILABLE)], { budgetMs: 0 }));
    expect(result.plan).toMatchObject({ status: "unverified", minimumSwitches: null });
    expect(result.actualRows[1].status).toBe("no_room");
  });
  it("fails closed on missing source evidence or unknown class size", async () => {
    for (const extra of [{ unverifiedReasons: ["Stale snapshot"] }, {}]) {
      const result = await planClassroomOverflow(input([row("a"), row("b", NO_ROOM_AVAILABLE, { warnings: ["needs_review_missing_capacity"] })], extra));
      expect(result.plan?.status).toBe("unverified");
      expect(result.plan?.predictedAssignments).toEqual([]);
    }
  });
  it("treats aliases as one physical room and respects full-duration reservations", async () => {
    const catalog = [rooms[0], { ...rooms[0], name: "A (TV)" }];
    const result = await planClassroomOverflow(input([row("a"), row("b", NO_ROOM_AVAILABLE)], { rooms: catalog,
      externalRoomBlocks: [{ wiseSessionId: "reserved", location: "A (TV)", className: null, startMinute: 659, endMinute: 700 }] }));
    expect(result.plan?.proposedSwitches).toBe(2);
  });
  it("keeps released online lessons free of the adjacent-onsite retention rule on regeneration", async () => {
    const online = row("online", REMOTE_NO_ROOM_NEEDED, { sessionType: "SCHEDULED", status: "remote", overflowReleaseRoom: REMOTE_NO_ROOM_NEEDED });
    const onsite = row("same-tutor", "A", { canonicalKey: online.canonicalKey, startMinute: 660, endMinute: 720 });
    const previous: PreviousAssignmentRow = { ...online, id: "old", publishStatus: "not_published", publishError: null, publishedAt: null, assignmentFingerprint: null };
    const next = reconcileClassroomAssignments({ sessions: [{ ...online, overflowReleaseRoom: null }, onsite], previousRows: [previous], rooms });
    expect(next.rows.find(row => row.wiseSessionId === "online")).toMatchObject({ assignedRoom: REMOTE_NO_ROOM_NEEDED, status: "remote", overflowReleaseRoom: REMOTE_NO_ROOM_NEEDED });
    const changed = reconcileClassroomAssignments({ sessions: [{ ...online, overflowReleaseRoom: null, sessionType: "OFFLINE" }], previousRows: [previous], rooms });
    expect(changed.rows[0].status).not.toBe("remote");
  });
  it("activates a suggested release only after the same occurrence is verified online", async () => {
    const a = row("a"), b = row("b", NO_ROOM_AVAILABLE);
    const result = await planClassroomOverflow(input([a, b]));
    const action = result.plan!.proposedActions.find(action => action.converted)!;
    const source = [a, b].find(row => row.wiseSessionId === action.wiseSessionId)!;
    expect(confirmedSuggestedRelease(source, result.plan, new Set([source.wiseSessionId]))).toBeNull();
    expect(confirmedSuggestedRelease({ ...source, sessionType: "SCHEDULED" }, result.plan, new Set())).toBeNull();
    expect(confirmedSuggestedRelease({ ...source, sessionType: "SCHEDULED" }, result.plan, new Set([source.wiseSessionId]))).toBe(action.room);
    expect(confirmedSuggestedRelease({ ...source, sessionType: "SCHEDULED", studentIds: ["replacement"] }, result.plan, new Set([source.wiseSessionId]))).toBeNull();
  });

  it("carries a saved room when Wise only reorders an unchanged roster", () => {
    const source = row("group", "A", { studentIds: ["s2", "s1"], studentCount: 2, classType: "GROUP" });
    const previous: PreviousAssignmentRow = { ...source, id: "old", publishStatus: "success", publishError: null, publishedAt: new Date(), assignmentFingerprint: null };
    const result = reconcileClassroomAssignments({ sessions: [{ ...source, studentIds: ["s1", "s2"] }], previousRows: [previous], rooms });
    expect(result.events).toEqual([]);
    expect(result.rows[0]).toMatchObject({ assignedRoom: "A", changeType: "carried", publishStatus: "success" });
  });

  it("moves blockers to satisfy an unallocated fixed override without changing its requested room", async () => {
    const catalog = [rooms[0], { ...rooms[0], name: "B", sortOrder: 2 }];
    const result = await planClassroomOverflow(input([row("movable"), row("override", NO_ROOM_AVAILABLE, { overrideRoom: "A" })], { rooms: catalog }));
    expect(result.plan).toMatchObject({ minimumSwitches: 0, actualRemainingOverflow: 0 });
    expect(result.actualRows.find(row => row.wiseSessionId === "override")).toMatchObject({ assignedRoom: "A", overrideRoom: "A" });
    expect(result.actualRows.find(row => row.wiseSessionId === "movable")?.assignedRoom).toBe("B");
  });

  it("matches exhaustive minimum conversion enumeration on small interval schedules", async () => {
    let seed = 41;
    const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let trial = 0; trial < 30; trial++) {
      const count = 3 + Math.floor(random() * 4), capacity = 1 + Math.floor(random() * 2);
      const catalog = Array.from({ length: capacity }, (_, index) => ({ ...rooms[0], name: `R${index}`, sortOrder: index }));
      const rows = Array.from({ length: count }, (_, index) => {
        const startMinute = 600 + Math.floor(random() * 3) * 30;
        return row(`s${index}`, NO_ROOM_AVAILABLE, { startMinute, endMinute: startMinute + (1 + Math.floor(random() * 3)) * 30 });
      });
      let minimum = count, bestRank = Infinity;
      for (let mask = 0; mask < 2 ** count; mask++) {
        const removed = rows.filter((_, index) => mask & (1 << index)).length;
        const rankSum = rows.reduce((sum, _, index) => sum + (mask & (1 << index) ? index + 1 : 0), 0);
        if (removed > minimum) continue;
        const remain = rows.filter((_, index) => !(mask & (1 << index)));
        if (remain.every(current => remain.filter(other => other.startMinute <= current.startMinute && other.endMinute > current.startMinute).length <= capacity)) {
          if (removed < minimum) bestRank = Infinity;
          minimum = removed; bestRank = Math.min(bestRank, rankSum);
        }
      }
      const result = await planClassroomOverflow(input(rows, { rooms: catalog }));
      expect(result.plan?.minimumSwitches, `trial ${trial}`).toBe(minimum);
      expect(result.plan?.predictedAssignments.filter(row => row.converted).reduce((sum, row) => sum + Number(row.wiseSessionId.slice(1)) + 1, 0)).toBe(bestRank);
      assertValid(result.plan!.predictedAssignments);
    }
  }, 30_000);

  it("replays the busy-day fixture without losing or overlapping classes", async () => {
    const sessions = fixture.map(raw => ({ ...raw, studentIds: [`student-${raw.wiseSessionId}`], startTime: new Date(raw.startTime), endTime: new Date(raw.endTime) }));
    const baseline = assignClassrooms(sessions, DEFAULT_CLASSROOM_ROOMS);
    // Remove one standard room to exercise a genuine constrained full-day case.
    const catalog = DEFAULT_CLASSROOM_ROOMS.filter(room => room.name !== "Cool");
    const rows = baseline.rows.map(row => row.assignedRoom === "Cool" ? { ...row, assignedRoom: NO_ROOM_AVAILABLE, status: "no_room" as const } : row);
    const result = await planClassroomOverflow(input(rows, { rooms: catalog }));
    expect(result.plan?.warnings).toEqual([]);
    expect(result.actualRows).toHaveLength(sessions.length);
    expect(result.plan?.predictedRemainingOverflow).toBe(0);
    assertValid(result.plan!.predictedAssignments);
  }, 35_000);
});
