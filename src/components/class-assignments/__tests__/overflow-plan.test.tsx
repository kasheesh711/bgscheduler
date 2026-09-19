import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OverflowPlanSection, StudentEvidence } from "../overflow-plan";
import { unknownStudentEvidence } from "@/lib/classrooms/mode-history";
import { summarizeAssignmentReadiness } from "../readiness-summary";
import type { AssignmentDetail } from "../types";
import type { OverflowPlan } from "@/lib/classrooms/overflow-types";

const plan: OverflowPlan = { version: 1, algorithmVersion: "overflow-v1", assignmentDate: "2026-09-19", generatedAt: "2026-09-18T00:00:00Z",
  sourceSnapshotId: "snapshot", sourceCheckedAt: null, historyCheckedAt: null, status: "minimum_proven", minimumSwitches: 1,
  switchLowerBound: 1, proposedSwitches: 1, rankingComplete: true, baselineOverflow: 2, actualRemainingOverflow: 2,
  predictedRemainingOverflow: 0, actualActions: [], proposedActions: [], predictedAssignments: [], accommodatedSessionIds: [], warnings: [], elapsedMs: 10 };
describe("overflow recommendations presentation", () => {
  it("keeps prediction conditional and displays stale source state", () => {
    const html = renderToStaticMarkup(<OverflowPlanSection plan={plan} stale />);
    expect(html).toContain("1 student switch needed");
    expect(html).toContain("only if the listed actions are completed");
    expect(html).toContain("Stale — refresh required");
    expect(html).toContain("Recommendations do not clear readiness warnings");
  });
  it("distinguishes online attendance from confirmed switching frequency", () => {
    const html = renderToStaticMarkup(<StudentEvidence evidence={{ ...unknownStudentEvidence("s"), tier: "online_attendance", onlineAttended: 4, attendedLessons: 6, adjustedFrequency: 4 / 9,
      firstLessonAt: "2026-08-01", lastLessonAt: "2026-09-01" }} />);
    expect(html).toContain("Past online attendance");
    expect(html).toContain("4 online / 6 attended lessons");
    expect(html).toContain("not a confirmed switching rate");
    expect(html).toContain("180-day lookback");
    expect(html).toContain("44.4%");
  });
  it("does not claim proof for a timeout or clear unresolved allocation warnings", () => {
    expect(renderToStaticMarkup(<OverflowPlanSection plan={{ ...plan, status: "best_found", minimumSwitches: null }} />)).toContain("a minimum is not proven");
    const detail = { run: { assignmentDate: plan.assignmentDate, status: "completed", noRoomCount: 2, needsReviewCount: 0 },
      rows: [], rooms: [], liveRoomBlocks: [], roomConflictWarnings: [], overflowPlan: plan } as unknown as AssignmentDetail;
    expect(summarizeAssignmentReadiness(detail, plan.assignmentDate)).toMatchObject({ severity: "danger", affectedClasses: 2 });
  });
});
