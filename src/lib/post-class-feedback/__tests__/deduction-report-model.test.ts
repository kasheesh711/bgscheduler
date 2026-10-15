import { describe, expect, it } from "vitest";
import { buildDeductionReport, previousReportDay, reportDeliveryCanSend } from "../deduction-report-model";

describe("daily deduction report", () => {
  it("uses the previous Bangkok calendar day across a month boundary", () => {
    expect(previousReportDay(new Date("2026-10-31T17:00:00Z"))).toEqual({ date: "2026-10-31", start: new Date("2026-10-30T17:00:00Z"), end: new Date("2026-10-31T17:00:00Z") });
  });
  it("sends an explicit zero result and labels incomplete source data", () => {
    expect(buildDeductionReport("2026-10-12", [], []).text).toContain("No new deduction candidates");
    expect(buildDeductionReport("2026-10-12", [], ["Wise collection is stale"]).text).toContain("INCOMPLETE");
  });
  it("reports a waived candidate and escapes student data in HTML", () => {
    const row = { sessionId: "s1", tutor: "Tutor One", students: "<Student>", subject: "Maths", classTime: "12 October, 10:00–11:00", deadline: "14 October, 23:59", reason: "Missing feedback", amountMinor: 10000, status: "waived", payout: "Not posted", screenshot: "Missing evidence" };
    const report = buildDeductionReport("2026-10-12", [row], []);
    expect(report.text).toContain("waived: 1, THB 100.00");
    expect(report.html).toContain("&lt;Student&gt;");
    expect(report.text).toContain("Not posted");
  });
  it("never resends a sent or uncertain delivery", () => {
    for (const status of ["sent", "unknown", "sending", "cancelled"]) expect(reportDeliveryCanSend(status)).toBe(false);
    expect(reportDeliveryCanSend("pending")).toBe(true);
    expect(reportDeliveryCanSend("failed")).toBe(true);
  });
});
