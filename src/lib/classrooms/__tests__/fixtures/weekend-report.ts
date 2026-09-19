import type { OverflowAction, OverflowPlan } from "../../overflow-types";
import type { WeekendReport } from "../../weekend-readiness";
import { unknownStudentEvidence } from "../../mode-history";

const release: OverflowAction = { wiseSessionId: "online", tutor: "Tutor A", student: "Student A", startMinute: 600, endMinute: 660,
  originalRoom: "Classroom A", room: "Hope (online)", status: "assigned", converted: false, released: true,
  lessonKey: "online-key", kind: "relocate_online", teachingLocation: "dedicated_online_room", evidence: null };
const conversion: OverflowAction = { ...release, wiseSessionId: "switch", student: "Student B", tutor: "Tutor B", startMinute: 660, endMinute: 780,
  room: "REMOTE_NO_ROOM_NEEDED", status: "remote", converted: true, lessonKey: "switch-key", kind: "switch_to_online", teachingLocation: "elsewhere",
  evidence: { ...unknownStudentEvidence("student-b"), tier: "online_attendance", onlineAttended: 4, attendedLessons: 6, adjustedFrequency: 4 / 9,
    firstLessonAt: "2026-05-01T02:00:00Z", lastLessonAt: "2026-09-01T02:00:00Z", lastOnlineAt: "2026-09-01T02:00:00Z" } };
export const weekendOverflowFixture: OverflowPlan = { version: 1, algorithmVersion: "overflow-v1", assignmentDate: "2026-09-26",
  generatedAt: "2026-09-23T02:01:00Z", sourceSnapshotId: "snapshot", sourceCheckedAt: "2026-09-23T02:00:40Z",
  historyCheckedAt: "2026-09-23T02:00:50Z", status: "minimum_proven", minimumSwitches: 1, switchLowerBound: 1,
  proposedSwitches: 1, rankingComplete: true, baselineOverflow: 3, actualRemainingOverflow: 2, predictedRemainingOverflow: 0,
  actualActions: [release], proposedActions: [release, conversion], predictedAssignments: [{ ...release, wiseSessionId: "overflow-1", student: "Student C",
    released: false, originalRoom: "NO_ROOM_AVAILABLE", room: "Classroom A" }], accommodatedSessionIds: ["overflow-1"], warnings: [], elapsedMs: 15 };
export const weekendReportFixture: WeekendReport = { version: 2, checkedAt: "2026-09-23T02:02:00Z", dates: ["2026-09-26", "2026-09-27"],
  snapshotId: "snapshot", snapshotFinishedAt: "2026-09-23T02:00:00Z", readiness: "attention",
  days: [{ date: "2026-09-26", liveSessions: 12, plannedSessions: 12, noRoomCount: 2, allocation: "saved", runId: "saturday-run",
    allocationCreatedAt: "2026-09-23T02:01:00Z", sourceCheckedAt: "2026-09-23T02:00:40Z", overflowPlan: weekendOverflowFixture,
    publication: { state: "partial", verified: 8, pending: 2, failed: 0, checkedAt: "2026-09-23T02:00:40Z" } },
  { date: "2026-09-27", liveSessions: 10, plannedSessions: 0, noRoomCount: 0, allocation: "blocked", runId: null, overflowPlan: null,
    allocationError: "Source data incomplete: an old lesson could not be verified as cancelled." }],
  findings: [{ date: "2026-09-26", wiseSessionId: "overflow-1", tutor: "Tutor C", className: "Student C", kind: "no_room", message: "Room capacity remains unresolved until actions are confirmed." }] };
