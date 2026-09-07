import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AssignmentReadinessNotice, WeekendReportNotice } from "../readiness-notice";
import type { AssignmentDetail } from "../types";

describe("visible classroom readiness", () => {
  it("warns when a completed run still has no-room classes", () => {
    const detail = { run: { status: "completed", assignmentDate: "2026-09-12", noRoomCount: 1, needsReviewCount: 0 },
      rows: [], rooms: [], liveRoomBlocks: [], roomConflictWarnings: [] } as unknown as AssignmentDetail;
    const html = renderToStaticMarkup(<AssignmentReadinessNotice detail={detail} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("classroom coverage is incomplete");
    expect(html).toContain("room plan is not ready");
  });
  it("does not render an unverified or absent report as an all-clear", () => {
    const html = renderToStaticMarkup(<WeekendReportNotice check={null} dates={["2026-09-12", "2026-09-13"]} />);
    expect(html).toContain("has not been verified yet");
    expect(html).not.toContain("found no room blockers");
    expect(renderToStaticMarkup(<WeekendReportNotice check={null} dates={[]} error="Failed to load" />)).toContain("could not be loaded");
  });
  it("renders saved findings and date-specific links without exposing the recipient", () => {
    const html = renderToStaticMarkup(<WeekendReportNotice dates={[]} check={{ id: "check", checkDate: "2026-09-09", status: "completed", lastError: null,
      delivery: { status: "sent", sentAt: "2026-09-09T02:00:00Z", kind: "warning" },
      report: { checkedAt: "2026-09-09T02:00:00Z", dates: ["2026-09-12", "2026-09-13"], readiness: "unverified", snapshotId: null, snapshotFinishedAt: null,
        days: [], findings: [{ date: "2026-09-12", kind: "unverified", message: "Teacher could not be resolved" }] } }} />);
    expect(html).toContain("could not be verified");
    expect(html).toContain("Teacher could not be resolved");
    expect(html).toContain("date=2026-09-13&amp;weekendCheck=check");
    expect(html).toContain("later booking changes");
    expect(html).not.toContain("@gmail.com");
  });
});
