import { describe, expect, it } from "vitest";
import { buildWeekendEmail } from "../weekend-email";
import { weekendReportFixture } from "./fixtures/weekend-report";

describe("Wednesday overflow email", () => {
  it("separates saved allocations, actual publication and conditional accommodation", () => {
    const email = buildWeekendEmail(weekendReportFixture, "check", "warning");
    for (const text of ["run saturday-run", "8 room(s) confirmed by live read-back, 2 pending", "3 initially; 2 after actual-modality room changes; 0 after the conditional plan",
      "Minimum proven. 1 proposed student lesson switch", "Student B | Tutor B", "11:00–13:00", "Classroom A → Teach elsewhere — classroom released",
      "Classroom A → Hope (online)", "including when adjacent lessons are onsite", "4 online / 6 attended lessons", "not a confirmed switching rate", "44.4%",
      "180-day lookback", "Student C", "room capacity not verified", "Source data incomplete"]) expect(email.text).toContain(text);
    expect(email.text).not.toContain("2026-09-27: 10 live classes; 0 classes without");
    expect(email.text).not.toContain("Wednesday allocations are saved locally");
  });
  it("deduplicates affected actions and never claims minimum proof on timeout", () => {
    const report = structuredClone(weekendReportFixture), plan = report.days[0].overflowPlan!;
    plan.status = "best_found"; plan.minimumSwitches = null; plan.rankingComplete = false;
    plan.proposedActions.push(plan.proposedActions[1]);
    const text = buildWeekendEmail(report, "check", "warning").text;
    expect(text.match(/PROPOSED STUDENT SWITCH/g)).toHaveLength(1);
    expect(text).toContain("Best found");
    expect(text).toContain("minimum not proven; lower bound 1");
    expect(text).not.toContain("Minimum proven");
  });
  it("labels verified switches with observed onsite opportunities and escapes identities", () => {
    const report = structuredClone(weekendReportFixture), action = report.days[0].overflowPlan!.proposedActions[1];
    action.student = "<Student>";
    Object.assign(action.evidence!, { tier: "verified_switches", verifiedSwitches: 2, observedOnsiteLessons: 5, adjustedFrequency: 2 / 8 });
    const email = buildWeekendEmail(report, "check", "warning");
    expect(email.text).toContain("2 verified onsite-to-online switches / 5 observed onsite opportunities");
    expect(email.html).toContain("&lt;Student&gt;");
    expect(email.html).not.toContain("<Student>");
  });
});
