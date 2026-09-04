import { describe, expect, it } from "vitest";

import { buildFootTrafficAggregateCsv, buildFootTrafficVisitCsv } from "../csv";
import type { FootTrafficDashboardPayload, FootTrafficVisitDetail } from "../types";

const summary = { studentVisits: 1, uniqueStudents: 1, onsiteClasses: 1, averageVisitsPerClass: 1, unidentifiedVisits: 0 };
const payload: FootTrafficDashboardPayload = {
  meta: {
    requestedStartDate: "2026-03-01", requestedEndDate: "2026-09-30",
    effectiveStartDate: "2026-03-01", effectiveEndDate: "2026-09-03",
    coverageStartDate: "2026-03-01", coverageEndDate: "2026-09-03",
    latestCompletedDate: "2026-09-03", dataAsOf: "2026-09-03",
    lastSuccessfulSyncAt: "2026-09-04T01:00:00.000Z", sourceSyncRunId: "run-1",
    timeZone: "Asia/Bangkok", source: "Wise PAST sessions", isEndDateCapped: true,
    isSeptemberMonthToDate: true, rooms: [], weekdays: [], availableRooms: ["Focus"],
  },
  summary,
  weekly: [{ key: "2026-03-02", label: "Week of 2 Mar", periodStart: "2026-03-02", periodEnd: "2026-03-08", isPartial: false, ...summary }],
  monthly: [], byWeekday: [], byRoom: [],
  dataQuality: { totalPastSessions: 1, countedOnsiteSessions: 1, excludedSessions: 0, cancelledSessions: 0, missedSessions: 0, notEndedSessions: 0, nonOnsiteSessions: 0, missingLocationSessions: 0, unknownRoomSessions: 0, onlineOnlyRoomSessions: 0, sessionsWithoutAttendanceEvidence: 0, participantsWithoutAttendanceEvidence: 0, unidentifiedVisits: 0 },
};
const visits: FootTrafficVisitDetail[] = [{ attendanceDate: "2026-03-02", startTime: "10:00", weekStart: "2026-03-02", month: "2026-03", studentFingerprint: "fingerprint-only", wiseSessionId: "session-1", room: "Room \"A\", West", subject: "Math", tutor: "Tutor", consumedCredits: 1 }];

describe("onsite foot-traffic CSV", () => {
  it("uses a UTF-8 BOM, CRLF, quoted fields and aggregate provenance", () => {
    const result = buildFootTrafficAggregateCsv(payload, "weekly");
    expect(result.csv.startsWith("\uFEFF")).toBe(true);
    expect(result.csv).toContain("\r\n");
    expect(result.csv).toContain('"Period start"');
    expect(result.csv).toContain('"Wise PAST sessions"');
    expect(result.csv).toContain('"false"');
  });

  it("escapes visit fields and exposes only pseudonymous identity", () => {
    const result = buildFootTrafficVisitCsv(payload.meta, visits);
    expect(result.csv).toContain('"Room ""A"", West"');
    expect(result.csv).toContain('"fingerprint-only"');
    expect(result.csv).not.toContain("Student Name");
    expect(result.csv).not.toContain("Raw student ID");
  });
});
