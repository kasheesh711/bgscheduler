import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SyncReviewNotice } from "../sync-review-notice";
import type { AssignmentDetail } from "../types";

function detail(summary = "10 future sessions need teacher review", count: number | undefined = 1): AssignmentDetail {
  const snapshotMeta = { snapshotId: "snapshot", latestSyncFinishedAt: "2026-09-07T03:40:00Z", staleAgeMs: 0, fresh: true };
  return {
    run: { id: "run", assignmentDate: "2026-09-09", status: "completed", forceReassign: false,
      totalSessions: 1, assignedCount: 1, needsReviewCount: 0, noRoomCount: 0, remoteCount: 0, publishedCount: 0, failedPublishCount: 0,
      createdAt: "2026-09-07T03:40:00Z", updatedAt: "2026-09-07T03:40:00Z",
      changeSummary: { syncErrorSummary: summary, ...(count === undefined ? {} : { unmanagedWiseSessionCount: count }) } },
    snapshotMeta, activeSnapshotMeta: { ...snapshotMeta, syncErrorSummary: summary },
    rows: [], rooms: [], liveRoomBlocks: [], roomConflictWarnings: [],
  };
}

describe("persistent sync review notice", () => {
  it("separates whole-schedule issues from the selected day's excluded count and links to review", () => {
    const html = renderToStaticMarkup(<SyncReviewNotice detail={detail()} />);
    expect(html).toContain("Wise data refreshed with issues");
    expect(html).toContain("whole upcoming schedule");
    expect(html).toContain("10 future sessions");
    expect(html).toContain("2026-09-09");
    expect(html).toContain("1 session.");
    expect(html).toContain("Affected email deliveries remain blocked");
    expect(html).toContain('href="/data-health"');
    expect(html).toContain('href="/tutor-profiles"');
  });
  it("retains saved review issues after a clean refresh and distinguishes zero from unknown counts", () => {
    const saved = detail("A teacher needed review", 0);
    delete saved.activeSnapshotMeta.syncErrorSummary;
    const html = renderToStaticMarkup(<SyncReviewNotice detail={JSON.parse(JSON.stringify(saved))} />);
    expect(html).toContain("Issues recorded with this day");
    expect(html).toContain("0 sessions.");
    delete saved.run!.changeSummary!.unmanagedWiseSessionCount;
    expect(renderToStaticMarkup(<SyncReviewNotice detail={saved} />)).toContain("Count unavailable");
  });
  it("has no warning for a clean saved run", () => {
    expect(renderToStaticMarkup(<SyncReviewNotice detail={detail("", 0)} />)).toBe("");
    expect(renderToStaticMarkup(<SyncReviewNotice detail={null} />)).toBe("");
  });
});
