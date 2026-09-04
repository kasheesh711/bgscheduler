import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { addBangkokDays } from "../dates";
import { renderFootTrafficPdf } from "../pdf";
import { renderFootTrafficReportHtml } from "../report";
import type { FootTrafficBreakdownRow, FootTrafficPeriodRow, FootTrafficReportSnapshot } from "../types";

function representativeSnapshot(): FootTrafficReportSnapshot {
  const weekly: FootTrafficPeriodRow[] = Array.from({ length: 31 }, (_, index) => {
    const start = addBangkokDays("2026-02-23", index * 7);
    const visits = 30 + (index * 17) % 46;
    return { key: start, label: `Week of ${start.slice(5)}`, periodStart: start, periodEnd: addBangkokDays(start, 6), isPartial: index === 0 || index === 30, studentVisits: visits, uniqueStudents: Math.round(visits * .65), onsiteClasses: Math.round(visits * .72), averageVisitsPerClass: 1.39, unidentifiedVisits: index % 8 === 0 ? 1 : 0 };
  });
  const monthly: FootTrafficPeriodRow[] = ["Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep"].map((label, index) => ({
    key: `2026-${String(index + 3).padStart(2, "0")}`, label: `${label} 2026`, periodStart: `2026-${String(index + 3).padStart(2, "0")}-01`, periodEnd: index === 6 ? "2026-09-30" : `2026-${String(index + 3).padStart(2, "0")}-28`, isPartial: index === 6, studentVisits: 150 + index * 19, uniqueStudents: 72 + index * 4, onsiteClasses: 105 + index * 9, averageVisitsPerClass: 1.42, unidentifiedVisits: 2,
  }));
  const weekdays: FootTrafficBreakdownRow[] = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((label, index) => ({ key: String(index), label, studentVisits: 180 - index * 17, uniqueStudents: 60 - index * 3, onsiteClasses: 120 - index * 10, averageVisitsPerClass: 1.5, unidentifiedVisits: 1 }));
  const rooms: FootTrafficBreakdownRow[] = Array.from({ length: 18 }, (_, index) => ({ key: `Room ${index + 1}`, label: `Room ${index + 1}`, studentVisits: 120 - index * 5, uniqueStudents: 50 - index, onsiteClasses: 80 - index * 3, averageVisitsPerClass: 1.5, unidentifiedVisits: index === 0 ? 1 : 0 }));
  return {
    id: "11111111-1111-4111-8111-111111111111",
    createdByEmail: "analyst@example.com",
    createdAt: "2026-09-04T02:00:00.000Z",
    expiresAt: "2026-10-04T02:00:00.000Z",
    payload: {
      meta: { requestedStartDate: "2026-03-01", requestedEndDate: "2026-09-30", effectiveStartDate: "2026-03-01", effectiveEndDate: "2026-09-03", coverageStartDate: "2026-03-01", coverageEndDate: "2026-09-03", latestCompletedDate: "2026-09-03", dataAsOf: "2026-09-03", lastSuccessfulSyncAt: "2026-09-04T01:18:00.000Z", sourceSyncRunId: "run-1", timeZone: "Asia/Bangkok", source: "Wise PAST sessions", isEndDateCapped: true, isSeptemberMonthToDate: true, rooms: [], weekdays: [], availableRooms: rooms.map((row) => row.label) },
      summary: { studentVisits: 1_260, uniqueStudents: 318, onsiteClasses: 842, averageVisitsPerClass: 1.5, unidentifiedVisits: 4 },
      weekly, monthly, byWeekday: weekdays, byRoom: rooms,
      dataQuality: { totalPastSessions: 2_100, countedOnsiteSessions: 842, excludedSessions: 1_258, cancelledSessions: 620, missedSessions: 28, notEndedSessions: 0, nonOnsiteSessions: 560, missingLocationSessions: 8, unknownRoomSessions: 7, onlineOnlyRoomSessions: 5, sessionsWithoutAttendanceEvidence: 30, participantsWithoutAttendanceEvidence: 42, unidentifiedVisits: 4 },
    },
  };
}

describe("onsite foot-traffic PDF artifact", () => {
  it("renders a complete, selectable, portrait-A4 analytics pack below the response limit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "begifted-foot-traffic-"));
    try {
      const html = renderFootTrafficReportHtml(representativeSnapshot());
      const pdf = await renderFootTrafficPdf(html);
      const pdfPath = join(directory, "report.pdf");
      const textPath = join(directory, "report.txt");
      const imagePrefix = join(directory, "page");
      writeFileSync(pdfPath, pdf);
      execFileSync("pdfinfo", [pdfPath], { stdio: "pipe" });
      execFileSync("pdftotext", ["-layout", pdfPath, textPath], { stdio: "pipe" });
      execFileSync("pdftoppm", ["-f", "1", "-singlefile", "-png", "-r", "100", pdfPath, imagePrefix], { stdio: "pipe" });

      const info = execFileSync("pdfinfo", [pdfPath], { encoding: "utf8" });
      const text = readFileSync(textPath, "utf8");
      expect(info).toMatch(/Page size:\s+59[45](?:\.\d+)? x 84[12](?:\.\d+)? pts \(A4\)/);
      expect(info).toContain("Tagged:          yes");
      expect(text).toContain("Executive Summary");
      expect(text).toContain("Weekly trend");
      expect(text).toContain("Monthly trend · September MTD");
      expect(text).toContain("Recommended next steps");
      expect(text).toContain("Wise PAST-session feed");
      expect(statSync(pdfPath).size).toBeLessThan(4_400_000);
      expect(statSync(`${imagePrefix}.png`).size).toBeGreaterThan(20_000);
      const pageText = text.split("\f").filter((page) => page.trim());
      expect(pageText.length).toBeGreaterThanOrEqual(4);
      expect(pageText.every((page) => page.trim().length > 80)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
