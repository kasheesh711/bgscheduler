import { describe, expect, it, vi } from "vitest";
vi.mock("../mode-history-data", () => ({ loadStudentModeEvidence: vi.fn() }));
import { sessionMatchesLive, improveOverflowAllocation } from "../overflow-service";
import { loadStudentModeEvidence } from "../mode-history-data";
import { reconcileClassroomAssignments } from "../reconciliation";
import type { AssignmentSession } from "../assignment-engine";
import type { WiseSession } from "@/lib/wise/types";
const rooms = [{ name: "A", capacity: 4, hasTv: true, active: true, category: "standard" as const, sortOrder: 0 }];
const session: AssignmentSession = { groupId: "g", tutorDisplayName: "Teacher", wiseTeacherId: "t", wiseTeacherUserId: "t",
  wiseSessionId: "one", wiseClassId: "class", studentIds: ["s"], studentCount: 1, classType: "ONE_TO_ONE", sessionType: "OFFLINE",
  startTime: new Date("2099-09-19T09:00:00Z"), endTime: new Date("2099-09-19T10:00:00Z"), startMinute: 540, endMinute: 600, weekday: 6, wiseStatus: "CONFIRMED" };
const live: WiseSession = { _id: "one", classId: { _id: "class", classType: "ONE_TO_ONE" }, userId: "t", type: "OFFLINE", students: ["s"], studentCount: 1,
  scheduledStartTime: "2099-09-19T02:00:00Z", scheduledEndTime: "2099-09-19T03:00:00Z", meetingStatus: "CONFIRMED" };
describe("overflow source verification", () => {
  it("requires matching authoritative times, roster, tutor, modality and class type", () => {
    expect(sessionMatchesLive(session, live)).toBe(true);
    for (const change of [{ userId: undefined }, { students: undefined }, { students: ["other"] }, { type: "SCHEDULED" },
      { classId: { _id: "class", classType: "GROUP" } }, { meetingStatus: "CANCELLED" }, { scheduledEndTime: "2099-09-19T04:00:00Z" }]) {
      expect(sessionMatchesLive(session, { ...live, ...change })).toBe(false);
    }
  });
  it("keeps stale or incomplete live inputs unverified without consulting history", async () => {
    const reconciliation = reconcileClassroomAssignments({ sessions: [session, { ...session, wiseSessionId: "two" }], previousRows: [], rooms });
    const result = await improveOverflowAllocation({} as never, { reconciliation, rooms, assignmentDate: "2099-09-19", snapshotId: "snapshot",
      snapshotFinishedAt: new Date().toISOString(), liveSessions: [live], externalRoomBlocks: [], frozenSessionIds: new Set() });
    expect(result.plan?.status).toBe("unverified");
    expect(result.reconciliation.rows).toEqual(reconciliation.rows);
    expect(loadStudentModeEvidence).not.toHaveBeenCalled();
  });
});
