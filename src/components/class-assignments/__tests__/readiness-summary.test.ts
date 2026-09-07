import { describe, expect, it } from "vitest";
import { getSyncReview, groupReadinessFindings, summarizeAssignmentReadiness, summarizeWeekendReadiness, summarizeWiseReadiness,
  type WeekendView } from "../readiness-summary";
import type { AssignmentDetail, ClassroomRow } from "../types";
import type { WeekendFinding } from "@/lib/classrooms/weekend-readiness";

export function assignmentDetail(): AssignmentDetail {
  const snapshotMeta = { snapshotId: "snapshot", latestSyncFinishedAt: "2026-09-07T03:40:00Z", staleAgeMs: 0, fresh: true };
  return {
    run: { id: "run", assignmentDate: "2026-09-12", status: "completed", forceReassign: false,
      totalSessions: 1, assignedCount: 1, needsReviewCount: 0, noRoomCount: 0, remoteCount: 0, publishedCount: 0, failedPublishCount: 0,
      createdAt: "2026-09-07T03:40:00Z", updatedAt: "2026-09-07T03:40:00Z", changeSummary: { unmanagedWiseSessionCount: 0 } },
    snapshotMeta, activeSnapshotMeta: { ...snapshotMeta }, rows: [], roomConflictWarnings: [], liveRoomBlocks: [],
    rooms: [{ id: "room", name: "Tesla", capacity: 3, hasTv: false, active: true, sortOrder: 1, category: "standard" }],
  };
}
function row(overrides: Partial<ClassroomRow> = {}): ClassroomRow {
  return { id: "row", runId: "run", wiseSessionId: "class", wiseClassId: null, wiseTeacherId: "teacher", wiseTeacherUserId: null,
    tutorDisplayName: "Teacher", studentName: "Student", studentCount: 1, subject: null, classType: null, title: null,
    startTime: "2026-09-12T03:00:00Z", endTime: "2026-09-12T04:00:00Z", weekday: 6, startMinute: 600, endMinute: 660,
    wiseStatus: "CONFIRMED", sessionType: "OFFLINE", currentWiseLocation: "Tesla", assignedRoom: "Tesla", status: "assigned",
    minCapacity: 1, needsTv: false, warnings: [], preferredRoom: null, overrideRoom: null, publishStatus: "not_published", publishError: null, ...overrides };
}
const finding: WeekendFinding = { date: "2026-09-12", wiseSessionId: "class", kind: "conflict", tutor: "Teacher", className: "Student",
  startMinute: 600, endMinute: 660, room: "Tesla", message: "Wise room overlap" };
const notChecked: WeekendView = { check: null, dates: ["2026-09-12", "2026-09-13"], error: null, loading: false };

describe("compact classroom readiness summaries", () => {
  it("groups one class's distinct findings, removes repeats, and keeps different teaching dates separate", () => {
    const groups = groupReadinessFindings([finding, { ...finding }, { ...finding, message: "Proposed room overlap" },
      { ...finding, date: "2026-09-13" }]);
    expect(groups).toHaveLength(2);
    expect(groups[0].findings.map(item => item.message)).toEqual(["Wise room overlap", "Proposed room overlap"]);
  });
  it("counts an incompatible assigned class once even if the saved run says zero need review", () => {
    const detail = assignmentDetail();
    detail.rows = [row({ needsTv: true })];
    expect(summarizeAssignmentReadiness(detail, "2026-09-12")).toMatchObject({ label: "1 class", severity: "danger", affectedClasses: 1 });
    expect(summarizeAssignmentReadiness(detail, "2026-09-12").groups[0].findings).toHaveLength(2);
  });
  it("retains conflict warnings not already represented in generated findings", () => {
    const detail = assignmentDetail();
    detail.rows = [row()];
    detail.roomConflictWarnings = [{ wiseSessionId: "class", assignedRoom: "Tesla", desiredLocation: "Tesla", message: "Live conflict still needs resolution",
      blocker: { wiseSessionId: "blocker", wiseClassId: null, className: "Other", location: "Tesla", startMinute: 600, endMinute: 660, sessionType: "OFFLINE", wiseStatus: "CONFIRMED" } }];
    const result = summarizeAssignmentReadiness(detail, "2026-09-12");
    expect(result).toMatchObject({ affectedClasses: 1, severity: "danger" });
    expect(result.groups[0].findings[0].message).toBe("Live conflict still needs resolution");
  });
  it("preserves excluded classes and missing row evidence without inventing a healthy result", () => {
    const detail = assignmentDetail();
    detail.run!.noRoomCount = 1;
    detail.run!.needsReviewCount = 1;
    detail.run!.changeSummary!.unmanagedWiseSessionCount = 2;
    expect(summarizeAssignmentReadiness(detail, "2026-09-12")).toMatchObject({ affectedClasses: 4, severity: "danger" });
  });
  it("distinguishes not checked, loading, unavailable, and failed generation from a healthy saved plan", () => {
    const detail = assignmentDetail();
    expect(summarizeAssignmentReadiness(detail, "2026-09-12").label).toBe("No issues");
    expect(summarizeAssignmentReadiness(detail, "2026-09-13").label).toBe("Unavailable");
    expect(summarizeAssignmentReadiness(detail, "2026-09-12", true).label).toBe("Loading…");
    expect(summarizeAssignmentReadiness(null, "2026-09-12").label).toBe("Unavailable");
    detail.run!.status = "failed";
    expect(summarizeAssignmentReadiness(detail, "2026-09-12")).toMatchObject({ label: "Needs review", severity: "warning" });
    detail.run = null;
    expect(summarizeAssignmentReadiness(detail, "2026-09-12").label).toBe("Not checked");
  });
  it("makes stale and saved/global sync issues visible independently of day findings", () => {
    const detail = assignmentDetail();
    expect(summarizeWiseReadiness(detail).label).toBe("Fresh");
    detail.activeSnapshotMeta.fresh = false;
    expect(summarizeWiseReadiness(detail)).toEqual({ label: "Stale", severity: "warning" });
    detail.run!.changeSummary!.syncErrorSummary = "Previous identity warning";
    expect(summarizeWiseReadiness(detail).label).toBe("Stale · review");
    expect(getSyncReview(detail)).toMatchObject({ runSummary: "Previous identity warning", excludedCount: 0, needsReview: true });
    delete detail.run!.changeSummary!.unmanagedWiseSessionCount;
    expect(getSyncReview(detail).excludedCount).toBeNull();
  });
  it("does not count nonconflicting live room reservations as classroom problems", () => {
    const detail = assignmentDetail();
    detail.rows = [row()];
    detail.liveRoomBlocks = [{ wiseSessionId: "later", wiseClassId: null, className: "Later class", location: "Tesla",
      startMinute: 660, endMinute: 720, sessionType: "OFFLINE", wiseStatus: "CONFIRMED" }];
    expect(summarizeAssignmentReadiness(detail, "2026-09-12")).toMatchObject({ affectedClasses: 0, severity: "neutral" });
  });
  it("never labels unchecked, unavailable, unverified or delivery-failed weekends as healthy", () => {
    expect(summarizeWeekendReadiness(notChecked).label).toBe("Not checked");
    expect(summarizeWeekendReadiness({ ...notChecked, error: "Offline" })).toMatchObject({ label: "Unavailable", severity: "warning" });
    const view: WeekendView = { ...notChecked, check: { id: "check", checkDate: "2026-09-09", status: "completed", lastError: null, delivery: null,
      report: { checkedAt: "2026-09-09T02:05:00Z", dates: ["2026-09-12", "2026-09-13"], readiness: "unverified", snapshotId: null, snapshotFinishedAt: null,
        days: [], findings: [{ date: "2026-09-12", kind: "unverified", message: "Snapshot not verified" }] } } };
    expect(summarizeWeekendReadiness(view)).toMatchObject({ label: "Unverified", severity: "warning", affectedClasses: 0 });
    view.check!.report!.findings.push(finding, { ...finding, message: "Proposed room conflict" });
    expect(summarizeWeekendReadiness(view)).toMatchObject({ label: "1 class", severity: "danger", affectedClasses: 1 });
    view.check!.report!.readiness = "clear";
    view.check!.report!.findings = [];
    view.check!.status = "failed";
    expect(summarizeWeekendReadiness(view)).toMatchObject({ label: "Check failed", severity: "warning" });
  });
});
