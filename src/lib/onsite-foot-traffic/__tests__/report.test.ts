import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { renderFootTrafficReportHtml } from "../report";
import type { FootTrafficReportSnapshot } from "../types";

const summary = { studentVisits: 42, uniqueStudents: 17, onsiteClasses: 30, averageVisitsPerClass: 1.4, unidentifiedVisits: 1 };
const snapshot: FootTrafficReportSnapshot = {
  id: "11111111-1111-4111-8111-111111111111",
  createdByEmail: "analyst@example.com",
  createdAt: "2026-09-04T02:00:00.000Z",
  expiresAt: "2026-10-04T02:00:00.000Z",
  payload: {
    meta: {
      requestedStartDate: "2026-03-01", requestedEndDate: "2026-09-30",
      effectiveStartDate: "2026-03-01", effectiveEndDate: "2026-09-03",
      coverageStartDate: "2026-03-01", coverageEndDate: "2026-09-03",
      latestCompletedDate: "2026-09-03", dataAsOf: "2026-09-03",
      lastSuccessfulSyncAt: "2026-09-04T01:18:00.000Z", sourceSyncRunId: "run-1",
      timeZone: "Asia/Bangkok", source: "Wise PAST sessions", isEndDateCapped: true,
      isSeptemberMonthToDate: true, rooms: [], weekdays: [], availableRooms: ["Focus"],
    },
    summary,
    weekly: [{ key: "2026-08-31", label: "Week of 31 Aug", periodStart: "2026-08-31", periodEnd: "2026-09-06", isPartial: true, ...summary }],
    monthly: [{ key: "2026-09", label: "Sep 2026", periodStart: "2026-09-01", periodEnd: "2026-09-30", isPartial: true, ...summary }],
    byWeekday: [{ key: "1", label: "Monday", ...summary }],
    byRoom: [{ key: "Focus", label: "Focus", ...summary }],
    dataQuality: { totalPastSessions: 100, countedOnsiteSessions: 30, excludedSessions: 70, cancelledSessions: 20, missedSessions: 2, notEndedSessions: 0, nonOnsiteSessions: 40, missingLocationSessions: 1, unknownRoomSessions: 2, onlineOnlyRoomSessions: 1, sessionsWithoutAttendanceEvidence: 4, participantsWithoutAttendanceEvidence: 5, unidentifiedVisits: 1 },
  },
};

describe("onsite foot-traffic standalone report", () => {
  it("embeds assets and contains the required executive, analytical and methodology sections", () => {
    const html = renderFootTrafficReportHtml(snapshot);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Executive Summary");
    expect(html).toContain("Weekly trend");
    expect(html).toContain("Monthly trend · September MTD");
    expect(html).toContain("Visit patterns");
    expect(html).toContain("Methodology and data quality");
    expect(html).toContain("Recommended next steps");
    expect(html).toContain("Wise PAST sessions");
    expect(html).toContain("data:image/png;base64,");
    expect(html).toContain("data:font/woff2;base64,");
    expect(html).not.toMatch(/(?:src|href)=["']https?:\/\//);
  });

  it("renders labelled accessible SVGs and exact tables from the immutable payload", () => {
    const html = renderFootTrafficReportHtml(snapshot);
    expect(html).toContain('role="img"');
    expect(html).toContain("directly labelled");
    expect(html).toContain(">42</text>");
    expect(html).toContain("Visits/class");
    expect(html).toContain("Snapshot 11111111-1111-4111-8111-111111111111");
  });
});
