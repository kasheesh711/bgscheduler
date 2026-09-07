import { describe, expect, it } from "vitest";
import { assignClassrooms, type AssignmentSession } from "../assignment-engine";
import { reconcileClassroomAssignments, type PreviousAssignmentRow } from "../reconciliation";
import { DEFAULT_CLASSROOM_ROOMS, type ClassroomRoomDefinition } from "../rooms";
import { preferenceFrozenSessionIds } from "../notification-state";
import { roomQualityMetrics } from "../room-policy";
import fixture from "./fixtures/2026-09-05.json";

const rooms: ClassroomRoomDefinition[] = ["A", "B", "C"].map((name, index) => ({ name, capacity: 3, hasTv: true, active: true, category: "standard", sortOrder: index }));
export function session(id: string, teacher: string, start: number, end: number, changes: Partial<AssignmentSession> = {}): AssignmentSession {
  return { canonicalKey: teacher, groupId: teacher, tutorDisplayName: teacher, wiseTeacherId: teacher, wiseClassId: id, wiseSessionId: id,
    startMinute: start, endMinute: end, startTime: new Date("2026-09-12T00:00:00Z"), endTime: new Date("2026-09-12T01:00:00Z"),
    weekday: 6, wiseStatus: "CONFIRMED", sessionType: "OFFLINE", studentCount: 1, ...changes };
}
const sample = () => [session("z1", "Teacher Z", 540, 600), session("z2", "Teacher Z", 600, 660), session("a", "Teacher A", 600, 660)];
const physicalValid = (rows: ReturnType<typeof assignClassrooms>["rows"], catalog = rooms) => {
  for (const a of rows.filter(row => row.status === "assigned")) {
    const room = catalog.find(room => room.name === a.assignedRoom)!;
    expect(room?.capacity).toBeGreaterThanOrEqual(a.minCapacity);
    if (a.needsTv) expect(room.hasTv).toBe(true);
    for (const b of rows.filter(row => row.wiseSessionId !== a.wiseSessionId && row.status === "assigned")) {
      expect(a.assignedRoom === b.assignedRoom && a.startMinute < b.endMinute && b.startMinute < a.endMinute).toBe(false);
    }
  }
};

describe("whole-day classroom continuity", () => {
  it("eliminates the alphabetical changeover move even when every class already has a room", () => {
    const baseline = assignClassrooms(sample(), rooms, new Map(), { optimizeContinuity: false });
    const result = assignClassrooms(sample(), rooms);
    expect(roomQualityMetrics(baseline.rows).roomChanges).toBe(1);
    expect(roomQualityMetrics(result.rows).roomChanges).toBe(0);
    expect(result.counts.noRoomCount).toBe(0);
    physicalValid(result.rows);
  });
  it("looks ahead through a long chain, combining canonical online and onsite identities", () => {
    const rows = sample();
    rows.push(session("z3", "Teacher Z Online", 660, 720, { canonicalKey: "Teacher Z", groupId: "online-account", sessionType: "SCHEDULED" }));
    const result = assignClassrooms(rows, rooms);
    expect(new Set(result.rows.filter(row => row.canonicalKey === "Teacher Z").map(row => row.assignedRoom)).size).toBe(1);
    physicalValid(result.rows);
  });
  it("prefers staying together outside usual rooms over a move into a usual room", () => {
    const policies = new Map([["teacher z", { canonicalKey: "Teacher Z", revision: 1, rooms: ["A"] }]]);
    const result = assignClassrooms(sample(), rooms, new Map([["a", "A"]]), { roomPolicies: policies });
    const z = result.rows.filter(row => row.canonicalKey === "Teacher Z");
    expect(z[0].assignedRoom).toBe(z[1].assignedRoom);
    expect(z[0].assignedRoom).not.toBe("A");
    physicalValid(result.rows);
  });
  it("preserves notified assignments across run and group changes but improves unnotified plans", () => {
    const baseline = assignClassrooms(sample(), rooms, new Map(), { optimizeContinuity: false });
    const previous: PreviousAssignmentRow[] = baseline.rows.map(row => ({ ...row, id: row.wiseSessionId, publishStatus: "success", publishError: null, publishedAt: new Date(), assignmentFingerprint: null }));
    const current = sample().map(row => ({ ...row, groupId: `new-${row.groupId}` }));
    const frozen = preferenceFrozenSessionIds(current, "2026-09-12", new Set(["teacher z"]), new Date("2026-09-11T00:00:00Z"));
    const kept = reconcileClassroomAssignments({ sessions: current, previousRows: previous, rooms, frozenSessionIds: frozen });
    expect(kept.rows.filter(row => row.canonicalKey === "Teacher Z").map(row => row.assignedRoom)).toEqual(previous.filter(row => row.canonicalKey === "Teacher Z").map(row => row.assignedRoom));
    const improved = reconcileClassroomAssignments({ sessions: current, previousRows: previous, rooms });
    expect(roomQualityMetrics(improved.rows).roomChanges).toBe(0);
    expect(improved.rows.some(row => row.changeType === "moved" && row.publishStatus === "not_published")).toBe(true);
    const again = reconcileClassroomAssignments({ sessions: current, previousRows: improved.rows.map(row => ({ ...row, id: row.wiseSessionId })), rooms });
    expect(again.events).toEqual([]);
  });
  it("freezes started Bangkok classes and leaves future days movable", () => {
    const now = new Date("2026-09-12T02:30:00Z");
    expect([...preferenceFrozenSessionIds(sample(), "2026-09-12", new Set(), now)]).toEqual(["z1"]);
    expect(preferenceFrozenSessionIds(sample(), "2026-09-13", new Set(), now).size).toBe(0);
  });
  it("swaps occupied rooms to preserve both teachers' consecutive chains", () => {
    const sessions = [session("z1", "Z", 540, 600), session("y1", "Y", 540, 600), session("z2", "Z", 600, 660), session("y2", "Y", 600, 660)];
    const assignments = assignClassrooms(sessions, rooms.slice(0, 2), new Map(), { optimizeContinuity: false }).rows;
    const targets: Record<string, string> = { z1: "A", z2: "B", y1: "B", y2: "A" };
    const previous = assignments.map(row => ({ ...row, id: row.wiseSessionId, assignedRoom: targets[row.wiseSessionId], publishStatus: "success" as const, publishError: null, publishedAt: new Date(), assignmentFingerprint: null }));
    const result = reconcileClassroomAssignments({ sessions, previousRows: previous, rooms: rooms.slice(0, 2) });
    expect(roomQualityMetrics(previous).roomChanges).toBe(2);
    expect(roomQualityMetrics(result.rows).roomChanges).toBe(0);
    physicalValid(result.rows);
  });
  it("keeps notified rooms when non-placement details change", () => {
    const baseline = assignClassrooms(sample(), rooms, new Map(), { optimizeContinuity: false });
    const previous = baseline.rows.map(row => ({ ...row, id: row.wiseSessionId, publishStatus: "success" as const, publishError: null, publishedAt: new Date(), assignmentFingerprint: null }));
    const result = reconcileClassroomAssignments({ sessions: sample().map(row => ({ ...row, title: "Updated lesson title" })), previousRows: previous, rooms,
      frozenSessionIds: new Set(sample().map(row => row.wiseSessionId)) });
    expect(result.rows.map(row => row.assignedRoom)).toEqual(previous.map(row => row.assignedRoom));
    expect(result.rows.every(row => row.publishStatus === "success")).toBe(true);
  });
  it("keeps TV and external occupancy constraints ahead of usual-room preferences", () => {
    const catalog = [{ ...rooms[0], hasTv: false }, rooms[1], rooms[2]];
    const sessions = [session("t1", "Roger", 540, 600), session("t2", "Roger", 610, 670)];
    const result = assignClassrooms(sessions, catalog, new Map(), { roomPolicies: new Map([["roger", { canonicalKey: "Roger", revision: 1, rooms: ["A", "B"] }]]),
      externalRoomBlocks: [{ wiseSessionId: "external", className: null, location: "B", startMinute: 600, endMinute: 700 }] });
    expect(result.rows.map(row => row.assignedRoom)).toEqual(["C", "C"]);
    physicalValid(result.rows, catalog);
  });
  it("splits a chain when capacity or external occupancy requires it, preserving explicit overrides", () => {
    const rows = [session("s", "Teacher", 540, 600), session("l", "Teacher", 600, 660, { studentCount: 8 })];
    const catalog = [{ ...rooms[0], capacity: 8 }, rooms[1]];
    const result = assignClassrooms(rows, catalog, new Map([["s", "B"]]));
    expect(result.rows.map(row => row.assignedRoom)).toEqual(["B", "A"]);
    physicalValid(result.rows, catalog);
  });
  it("returns the validated baseline when the quality budget is exhausted", () => {
    const diagnostics = {};
    const result = assignClassrooms(sample(), rooms, new Map(), { continuityMaxNodes: 0, diagnostics });
    expect(result.counts.noRoomCount).toBe(0);
    expect(diagnostics).toMatchObject({ quality: { continuitySearchExhausted: true, continuityNodes: 0 } });
    physicalValid(result.rows);
  });
  it("reduces historical fixture moves without losing rooms or designated assignments", () => {
    const sessions = fixture.map(row => ({ ...row, canonicalKey: row.tutorDisplayName, startTime: new Date(row.startTime), endTime: new Date(row.endTime) }));
    const baseline = assignClassrooms(sessions, DEFAULT_CLASSROOM_ROOMS, new Map(), { optimizeContinuity: false });
    const result = assignClassrooms(sessions, DEFAULT_CLASSROOM_ROOMS);
    expect(result.counts).toEqual(baseline.counts);
    expect(roomQualityMetrics(result.rows).roomChanges).toBeLessThan(roomQualityMetrics(baseline.rows).roomChanges);
    for (const name of ["Gift", "Kevin", "Mek", "Ras"]) expect(result.rows.filter(row => row.tutorDisplayName === name).map(row => row.assignedRoom)).toEqual(baseline.rows.filter(row => row.tutorDisplayName === name).map(row => row.assignedRoom));
    physicalValid(result.rows, DEFAULT_CLASSROOM_ROOMS);
  }, 30_000);
});
