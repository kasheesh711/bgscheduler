import { describe, expect, it } from "vitest";
import { parseSalesProjectionWorkbook } from "@/lib/sales-dashboard/projection";

const summaryRows = [
  [],
  ["", "Metric", "Unit", "Bear", "Base", "Bull"],
  ["", "21-month total revenue", "THB", 70, 75, 77],
  ["", "Apr-Dec '26 (9 mo)", "THB", 30, 31, 32],
  ["", "CY 2027 (12 mo)", "THB", 40, 44, 45],
  ["", "Avg monthly revenue", "THB/mo", 3.3, 3.6, 3.7],
  ["", "Dec '27 active (end)", "count", 298, 405, 551],
  ["", "Student growth 21 mo", "%", -0.11, 0.21, 0.64],
  ["", "Dec '27 packs renewed", "packs/mo", 85, 115, 156],
  ["", "Revenue status", "", "ON TARGET", "ON TARGET", "OVERSHOOT"],
];

const whatIfRows = [
  [],
  ["", "Target monthly revenue (THB)", 4_000_000],
  ["", "Effective monthly revenue target", 3_500_000],
];

const calcRows = [
  ["", "Apr '26", "May '26", "Apr-Dec '26"],
  ["--- Bear ---"],
  ["Active students", 300, 301, ""],
  ["Trial bookings", 10, 11, ""],
  ["New students added", 6, 7, ""],
  ["Pack renewals", 80, 81, ""],
  ["Renewal hours", 100, 101, ""],
  ["New student hours", 20, 21, ""],
  ["Trial hours", 10, 11, ""],
  ["Total hours", 130, 133, ""],
  ["Room capacity", 200, 200, ""],
  ["Util %", 0.65, 0.665, ""],
  ["Renewal Rev", 1000, 1100, ""],
  ["New Rev", 200, 220, ""],
  ["Trial Rev", 50, 55, ""],
  ["TOTAL NET REVENUE", 1250, 1375, ""],
  ["--- Base ---"],
  ["Active students", 335, 331, ""],
  ["Trial bookings", 39, 28, ""],
  ["New students added", 22, 19, ""],
  ["Pack renewals", 95, 94, ""],
  ["Renewal hours", 1533, 2084, ""],
  ["New student hours", 413, 386, ""],
  ["Trial hours", 39, 28, ""],
  ["Total hours", 1985, 2498, ""],
  ["Room capacity", 2633, 2633, ""],
  ["Util %", 0.75, 0.95, ""],
  ["Renewal Rev", 2_052_850, 2_802_588, ""],
  ["New Rev", 565_050, 530_402, ""],
  ["Trial Rev", 25_800, 18_858, ""],
  ["TOTAL NET REVENUE", 2_643_700, 3_351_847, ""],
  ["--- Bull ---"],
  ["Active students", 340, 341, ""],
  ["Trial bookings", 40, 41, ""],
  ["New students added", 23, 24, ""],
  ["Pack renewals", 96, 97, ""],
  ["Renewal hours", 1600, 1700, ""],
  ["New student hours", 420, 430, ""],
  ["Trial hours", 40, 41, ""],
  ["Total hours", 2060, 2171, ""],
  ["Room capacity", 2633, 2633, ""],
  ["Util %", 0.78, 0.82, ""],
  ["Renewal Rev", 2_100_000, 2_900_000, ""],
  ["New Rev", 600_000, 700_000, ""],
  ["Trial Rev", 26_000, 30_000, ""],
  ["TOTAL NET REVENUE", 2_726_000, 3_630_000, ""],
];

describe("sales projection workbook parser", () => {
  it("parses target, scenario summaries, and monthly scenario rows by labels", () => {
    const parsed = parseSalesProjectionWorkbook({
      summaryRows,
      whatIfRows,
      calcMultiRows: calcRows,
    });

    expect(parsed.targetMonthlyRevenue).toBe(3_500_000);
    expect(parsed.scenarioSummaries).toContainEqual(expect.objectContaining({
      scenario: "Base",
      totalRevenue21Month: 75,
      avgMonthlyRevenue: 3.6,
      revenueStatus: "ON TARGET",
    }));
    expect(parsed.months).toHaveLength(6);
    expect(parsed.months).toContainEqual(expect.objectContaining({
      scenario: "Base",
      projectionMonth: "2026-04-01",
      totalNetRevenue: 2_643_700,
      renewalRevenue: 2_052_850,
      newStudentRevenue: 565_050,
      trialRevenue: 25_800,
      roomUtilization: 0.75,
    }));
  });

  it("fails clearly when required labels are missing", () => {
    expect(() => parseSalesProjectionWorkbook({
      summaryRows,
      whatIfRows,
      calcMultiRows: calcRows.filter((row) => row[0] !== "TOTAL NET REVENUE"),
    })).toThrow(/missing "total net revenue"/i);
  });
});
