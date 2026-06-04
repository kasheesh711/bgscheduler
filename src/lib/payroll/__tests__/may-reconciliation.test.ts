import { describe, expect, it } from "vitest";
import {
  buildMayPayrollReconciliationReport,
  parseLegacyAggregatePayroll,
  parseLegacyLongPayroll,
} from "../may-reconciliation";
import type { PayrollPayload } from "../types";

const aggregateRows = [
  ["Tutor", null, "Balance"],
  ["BG1: Tutor One", "10.50 Hours", "฿7,350.00"],
  ["BG2: Tutor Two", "2.00 Hours", "฿1,000.00"],
  ["2 Tutors", "12.50 Hours", "฿8,350.00"],
];

const longRows = [
  ["BG1: Tutor One"],
  ["Date", "Description", "Income", "Payments"],
  ["1/5/2026", "9:00 AM - 60 mins - Live Session - Student One", "฿700.00"],
  ["2/5/2026", "9:00 AM - 60 mins - Live Session (Cancelled) - Student One", "฿0.00"],
  ["Totals", null, "฿700.00", "฿0.00"],
];

function payload(overrides: Partial<PayrollPayload> = {}): PayrollPayload {
  return {
    month: "2026-05",
    payrollMonth: "2026-05-01",
    rateCard: null,
    review: { status: "draft", notes: "", approvedByEmail: null, approvedByName: null, approvedAt: null, updatedAt: null },
    lastSync: null,
    summary: {
      totalPayoutAmount: 7350,
      paidHours: 10.5,
      utilizationHours: 10.5,
      varianceHours: 0,
      detectedFreePayHours: 0,
      kevinHours: 0,
      kevinPaidHours: 0,
      kevinPayoutAmount: 0,
      manualAdjustmentHours: 0,
      manualAdjustmentAmount: 0,
      unresolvedTutorCount: 0,
      issueCount: 0,
      expectedRateCheckedCount: 1,
      expectedRateMismatchCount: 0,
      missingRateRuleCount: 0,
      unmappedRateCourseCount: 0,
      tutorCount: 1,
    },
    tutors: [{
      tutorKey: "tutor-one",
      canonicalKey: "tutor-one",
      tutorName: "Tutor One",
      tier: "BG1",
      rawTier: "Tier 1",
      paidHours: 10.5,
      utilizationHours: 10.5,
      payoutAmount: 7350,
      invoiceCount: 10,
      endedSessionCount: 10,
      effectiveRate: 700,
      rateBuckets: [],
      varianceHours: 0,
      flags: [],
      isKevin: false,
      freePayHours: 0,
      expectedRateCheckedCount: 1,
      expectedRateIssueCount: 0,
      expectedRateMismatchCount: 0,
      expectedRateMissingCount: 0,
    }],
    issues: [],
    adjustments: [],
    ...overrides,
  };
}

describe("May payroll reconciliation helpers", () => {
  it("parses legacy Aggregate Payroll totals and tutor rows", () => {
    expect(parseLegacyAggregatePayroll(aggregateRows)).toEqual({
      tutors: [
        { tier: "BG1", tutorName: "Tutor One", hours: 10.5, balance: 7350 },
        { tier: "BG2", tutorName: "Tutor Two", hours: 2, balance: 1000 },
      ],
      totals: { tutorCount: 2, hours: 12.5, balance: 8350 },
    });
  });

  it("parses Long Payroll lines and cancelled rows", () => {
    const lines = parseLegacyLongPayroll(longRows);

    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ cancelled: true, income: 0 });
  });

  it("builds a discrepancy report without mutating Wise totals", () => {
    const report = buildMayPayrollReconciliationReport({
      aggregateRows,
      longPayrollRows: longRows,
      payload: payload(),
    });

    expect(report.legacyTotals).toEqual({ tutorCount: 2, hours: 12.5, balance: 8350 });
    expect(report.wiseTotals).toEqual({ tutorCount: 1, hours: 10.5, balance: 7350 });
    expect(report.missingInWise.map((row) => row.tutorName)).toEqual(["Tutor Two"]);
    expect(report.extraInWise).toEqual([]);
    expect(report.longPayrollLineCount).toBe(2);
    expect(report.cancelledLongPayrollLineCount).toBe(1);
  });
});
