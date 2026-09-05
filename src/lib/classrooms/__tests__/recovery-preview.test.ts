import { describe, expect, it } from "vitest";
import { previewClassroomRecovery } from "../recovery-preview";
import type { PreviousAssignmentRow } from "../reconciliation";

const row = (id: string, startMinute: number, endMinute: number): PreviousAssignmentRow => ({
  id, groupId: id, tutorDisplayName: id, wiseTeacherId: id, wiseClassId: id, wiseSessionId: id,
  // Snapshot timestamps are Bangkok wall-clock encoded, not actual UTC instants.
  startTime: new Date("2026-09-05T10:00:00Z"), endTime: new Date("2026-09-05T12:00:00Z"),
  startMinute, endMinute, weekday: 6, wiseStatus: "CONFIRMED", sessionType: "OFFLINE",
  studentCount: 1, minCapacity: 1, needsTv: false, preferredRoom: null, overrideRoom: null,
  assignedRoom: "A", currentWiseLocation: "A", status: "assigned", warnings: [], ruleTrace: [],
  publishStatus: "success", publishError: null, publishedAt: null, assignmentFingerprint: null,
});
const rooms = ["A", "B"].map((name, sortOrder) => ({ name, sortOrder, capacity: 2, hasTv: true,
  category: "standard" as const, active: true }));
describe("fresh recovery preview", () => {
  it("freezes completed and in-progress classes by Bangkok clock and protects their real rooms", () => {
    const started = row("started", 600, 720), next = row("next", 690, 750), done = row("done", 540, 600);
    const result = previewClassroomRecovery({ assignmentDate: "2026-09-05", now: new Date("2026-09-05T04:00:00Z"),
      liveSessions: [started, { ...next, currentWiseLocation: null }], previousRows: [done, started], rooms });
    expect(result.frozen.map(r => r.wiseSessionId).sort()).toEqual(["done", "started"]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].assignedRoom).toBe("B");
  });
  it("does not move an upcoming saved session missing from the live read", () => {
    const result = previewClassroomRecovery({ assignmentDate: "2026-09-05", now: new Date("2026-09-05T04:00:00Z"),
      liveSessions: [], previousRows: [row("missing", 720, 780)], rooms });
    expect(result.rows).toEqual([]);
    expect(result.frozen[0].freezeReason).toBe("not_confirmed_live");
  });
  it("releases a missing reservation only with confirmed inactive Wise status", () => {
    const result = previewClassroomRecovery({ assignmentDate: "2026-09-05", now: new Date("2026-09-05T04:00:00Z"),
      liveSessions: [], previousRows: [row("canceled", 720, 780)], rooms, confirmedInactiveSessionIds: new Set(["canceled"]) });
    expect(result.frozen).toEqual([]);
    expect(result.externalRoomBlocks).toEqual([]);
  });
  it("keeps an upcoming online class at the center when connected to a frozen onsite class", () => {
    const onsite = { ...row("onsite", 600, 690), tutorDisplayName: "Same tutor", groupId: "old-snapshot-group" };
    const online = { ...row("online", 690, 750), tutorDisplayName: "Same tutor", groupId: "current-group", sessionType: "SCHEDULED" };
    const result = previewClassroomRecovery({ assignmentDate: "2026-09-05", now: new Date("2026-09-05T04:00:00Z"),
      liveSessions: [online], previousRows: [onsite], rooms });
    expect(result.rows[0].status).toBe("assigned");
  });
});
