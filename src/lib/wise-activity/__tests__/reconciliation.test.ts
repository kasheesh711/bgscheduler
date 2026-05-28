import { describe, expect, it } from "vitest";
import {
  buildPackageSalesReconciliation,
  wiseReconciliationBackfillLookbackDays,
  type CreditPackageInput,
  type PackageSaleInput,
  type WiseInvoiceEventInput,
} from "../reconciliation";
import type { WiseFeesPaidTrend, WiseReceiptTransaction } from "@/lib/wise/fetchers";

function sale(overrides: Partial<PackageSaleInput> = {}): PackageSaleInput {
  return {
    id: "sale-1",
    rowNumber: 4,
    studentNickname: "Minnie",
    program: "Math",
    packageHours: "10 hours",
    paymentAmount: 12000,
    paymentDate: "2026-05-10",
    enrollmentType: "Renewal",
    programWiseName: "Math Y5",
    packageHoursClean: "10 hrs",
    raw: {
      "Transaction No.": "INV-100",
      "Parent's Account": "Parent Minnie",
      "Recorded in WISE?": "Yes",
    },
    ...overrides,
  };
}

function event(overrides: Partial<WiseInvoiceEventInput> = {}): WiseInvoiceEventInput {
  return {
    id: "event-1",
    eventId: "wise-event-1",
    eventType: "BILLING",
    eventName: "InvoiceChargedEvent",
    eventTimestamp: new Date("2026-05-10T05:00:00.000Z"),
    actorName: "Admin",
    actorWiseUserId: "admin-1",
    classroomId: "class-1",
    classroomName: "Math Y5 Minnie",
    classroomSubject: "Math",
    transactionId: "tx-1",
    transactionStatus: "paid",
    transactionAmount: 1_200_000,
    transactionCurrency: "THB",
    payload: {
      transaction: {
        id: "tx-1",
        senderId: "student-1",
        amount: { value: 1_200_000, currency: "THB" },
        metadata: {
          invoiceNumber: "INV-100",
          classId: "class-1",
        },
      },
    },
    raw: {},
    ...overrides,
  };
}

function creditPackage(overrides: Partial<CreditPackageInput> = {}): CreditPackageInput {
  return {
    wiseStudentId: "student-1",
    wiseClassId: "class-1",
    studentKey: "minnie::parent-minnie",
    studentName: "Minnie Smith",
    parentName: "Parent Minnie",
    packageName: "Math Y5 10 hrs",
    subject: "Math",
    ...overrides,
  };
}

function receipt(overrides: Partial<WiseReceiptTransaction> = {}): WiseReceiptTransaction {
  return {
    id: "receipt-1",
    type: "OFFLINE_PAYMENT",
    status: "CHARGED",
    chargedAt: "2026-05-10T05:00:00.000Z",
    createdAt: "2026-05-10T05:00:00.000Z",
    amountMinor: 1_200_000,
    amount: 12_000,
    currency: "THB",
    note: "Paid Offline",
    classId: "class-1",
    classroomName: "Math Y5 Minnie",
    classroomSubject: "Math",
    studentId: "student-1",
    studentName: "Minnie Smith",
    parentIds: ["parent-1"],
    parentNames: ["Parent Minnie"],
    identifiers: ["receipt-1", "INV-100", "payment-option-1"],
    raw: {
      _id: "receipt-1",
      metadata: {
        invoiceNumber: "INV-100",
        classId: "class-1",
      },
    },
    ...overrides,
  };
}

function feesPaidTrend(overrides: Partial<WiseFeesPaidTrend> = {}): WiseFeesPaidTrend {
  return {
    timestamp: "2026-04-30T17:00:00.000Z",
    count: 148,
    amountMinor: 344_046_000,
    amount: 3_440_460,
    currency: "THB",
    ...overrides,
  };
}

describe("Wise package-sales reconciliation", () => {
  it("returns review candidates from exact receipt metadata without auto-matching", () => {
    const result = buildPackageSalesReconciliation({
      sources: [],
      selectedSource: null,
      saleRows: [sale()],
      wiseEvents: [],
      wiseReceipts: [receipt()],
      creditPackages: [creditPackage()],
      startDate: "2026-05-10",
      endDate: "2026-05-10",
    });

    const row = result.students[0].rows[0];
    expect(row.candidates).toHaveLength(1);
    expect(row.candidates[0].confidence).toBe("high");
    expect(row.candidates[0].source).toBe("wise_receipt");
    expect(row.candidates[0].receiptType).toBe("OFFLINE_PAYMENT");
    expect(row.candidates[0].reasons).toContain("Sheet transaction number appears on the Wise receipt.");
    expect(row.candidates[0].reasons).toContain("Wise class ID matches the student's active Credit Control package.");
    expect(row).not.toHaveProperty("matched");
    expect(row).not.toHaveProperty("matchStatus");
  });

  it("computes revenue variance from Wise fees paid monthly trends", () => {
    const result = buildPackageSalesReconciliation({
      sources: [],
      selectedSource: null,
      saleRows: [sale()],
      wiseEvents: [],
      wiseReceipts: [receipt()],
      creditPackages: [],
      startDate: "2026-05-10",
      endDate: "2026-05-10",
      wiseFeesPaidTrends: [feesPaidTrend({ timestamp: "2026-05-09T17:00:00.000Z", count: 1, amountMinor: 1_200_000, amount: 12_000 })],
    });

    expect(result.revenueVariance).toMatchObject({
      startDate: "2026-05-10",
      endDate: "2026-05-10",
      periodLabel: "May 10, 2026",
      sheetPackageSalesTotal: 12000,
      wiseRevenueTotal: 12000,
      difference: 0,
      differencePct: 0,
      currency: "THB",
      wiseRevenueAvailable: true,
      wiseRevenueTrendTimestamp: "2026-05-09T17:00:00.000Z",
      wiseRevenueTransactionCount: 1,
      wiseReceiptTotal: 12000,
      wiseReceiptCount: 1,
      wiseReceiptSkippedCount: 0,
      sheetMinusReceipts: 0,
      receiptsMinusTrend: 0,
      source: "wise_fees_paid_trend",
    });
  });

  it("maps the May source month to the Wise Bangkok fees-paid trend row", () => {
    const result = buildPackageSalesReconciliation({
      sources: [],
      selectedSource: {
        id: "source-may",
        sourceMonth: "2026-05-01",
        label: "2026-05 May",
        status: "active",
        lastImportedAt: "2026-05-28T09:40:12.398Z",
        lastNormalRowCount: 157,
      },
      saleRows: [sale({ paymentAmount: 3_499_610, paymentDate: "2026-05-28" })],
      wiseEvents: [],
      wiseReceipts: [receipt({ amount: 3_569_360, amountMinor: 356_936_000 })],
      creditPackages: [],
      startDate: "2026-05-01",
      endDate: "2026-05-28",
      wiseFeesPaidTrends: [feesPaidTrend({ amount: 3_569_360, amountMinor: 356_936_000 })],
    });

    expect(result.revenueVariance.wiseRevenueTotal).toBe(3_569_360);
    expect(result.revenueVariance.wiseReceiptTotal).toBe(3_569_360);
    expect(result.revenueVariance.sheetMinusReceipts).toBe(-69_750);
    expect(result.revenueVariance.receiptsMinusTrend).toBe(0);
    expect(result.revenueVariance.difference).toBe(-69_750);
    expect(result.revenueVariance.wiseRevenueTrendTimestamp).toBe("2026-04-30T17:00:00.000Z");
  });

  it("returns official Wise revenue as unavailable when the fees-paid trend row is missing", () => {
    const result = buildPackageSalesReconciliation({
      sources: [],
      selectedSource: null,
      saleRows: [sale()],
      wiseEvents: [event()],
      wiseReceipts: [receipt()],
      creditPackages: [],
      startDate: "2026-05-10",
      endDate: "2026-05-10",
      wiseFeesPaidTrends: [feesPaidTrend({ timestamp: "2026-03-31T17:00:00.000Z" })],
    });

    expect(result.revenueVariance.wiseRevenueAvailable).toBe(false);
    expect(result.revenueVariance.wiseRevenueTotal).toBeNull();
    expect(result.revenueVariance.difference).toBeNull();
    expect(result.revenueVariance.wiseRevenueUnavailableReason).toContain("no row for 2026-05");
  });

  it("does not fall back to persisted activity events when the Wise fees-paid endpoint fails", () => {
    const result = buildPackageSalesReconciliation({
      sources: [],
      selectedSource: null,
      saleRows: [sale()],
      wiseEvents: [event()],
      wiseReceipts: [receipt()],
      creditPackages: [],
      startDate: "2026-05-10",
      endDate: "2026-05-10",
      wiseFeesPaidTrendsError: "Wise API 500",
    });

    expect(result.revenueVariance.wiseRevenueAvailable).toBe(false);
    expect(result.revenueVariance.wiseRevenueTotal).toBeNull();
    expect(result.revenueVariance.wiseRevenueUnavailableReason).toContain("Wise API 500");
  });

  it("uses normalized Wise THB receipt amounts for row-level candidates", () => {
    const result = buildPackageSalesReconciliation({
      sources: [],
      selectedSource: null,
      saleRows: [sale({ paymentAmount: 24000 })],
      wiseEvents: [],
      wiseReceipts: [receipt({
        id: "receipt-24000",
        amount: 24_000,
        amountMinor: 2_400_000,
        identifiers: ["receipt-24000"],
      })],
      creditPackages: [],
      startDate: "2026-05-10",
      endDate: "2026-05-10",
      wiseFeesPaidTrends: [feesPaidTrend({ timestamp: "2026-05-09T17:00:00.000Z", amountMinor: 2_400_000, amount: 24_000 })],
    });

    expect(result.revenueVariance.wiseRevenueTotal).toBe(24000);
    expect(result.revenueVariance.difference).toBe(0);
    expect(result.students[0].rows[0].candidates[0].transactionAmount).toBe(24000);
    expect(result.students[0].rows[0].candidates[0].reasons).toContain("Payment amount matches the package-sale row.");
  });

  it("does not classify session feedback as inbound finance because it contains the substring fee", () => {
    const result = buildPackageSalesReconciliation({
      sources: [],
      selectedSource: null,
      saleRows: [sale()],
      wiseEvents: [
        event(),
        event({
          id: "event-feedback",
          eventId: "wise-event-feedback",
          eventType: "SESSION",
          eventName: "SessionFeedbackSubmittedEvent",
          transactionId: null,
          transactionAmount: null,
          transactionCurrency: null,
          payload: {},
        }),
      ],
      creditPackages: [],
      startDate: "2026-05-10",
      endDate: "2026-05-10",
    });

    expect(result.summary.wiseInboundEvents).toBe(1);
    expect(result.coverage.inboundEventCount).toBe(1);
  });

  it("reports Sheet minus Wise difference and percentage against Wise revenue", () => {
    const result = buildPackageSalesReconciliation({
      sources: [],
      selectedSource: null,
      saleRows: [sale({ paymentAmount: 15000 })],
      wiseEvents: [event({ transactionAmount: 1_000_000, payload: { transaction: { id: "tx-1", amount: { value: 1_000_000, currency: "THB" } } } })],
      wiseReceipts: [receipt({ amount: 10_000, amountMinor: 1_000_000 })],
      creditPackages: [],
      startDate: "2026-05-10",
      endDate: "2026-05-10",
      wiseFeesPaidTrends: [feesPaidTrend({ timestamp: "2026-05-09T17:00:00.000Z", amountMinor: 1_000_000, amount: 10_000 })],
    });

    expect(result.revenueVariance.sheetPackageSalesTotal).toBe(15000);
    expect(result.revenueVariance.wiseRevenueTotal).toBe(10000);
    expect(result.revenueVariance.difference).toBe(5000);
    expect(result.revenueVariance.differencePct).toBe(50);
    expect(result.revenueVariance.sheetMinusReceipts).toBe(5000);
    expect(result.revenueVariance.receiptsMinusTrend).toBe(0);
  });

  it("returns receipt totals unavailable when the Wise receipt endpoint fails", () => {
    const result = buildPackageSalesReconciliation({
      sources: [],
      selectedSource: null,
      saleRows: [sale()],
      wiseEvents: [event()],
      wiseReceiptsError: "Wise API 500",
      creditPackages: [],
      startDate: "2026-05-10",
      endDate: "2026-05-10",
      wiseFeesPaidTrends: [feesPaidTrend({ timestamp: "2026-05-09T17:00:00.000Z", amountMinor: 1_200_000, amount: 12_000 })],
    });

    expect(result.revenueVariance.wiseReceiptsAvailable).toBe(false);
    expect(result.revenueVariance.wiseReceiptTotal).toBeNull();
    expect(result.revenueVariance.sheetMinusReceipts).toBeNull();
    expect(result.revenueVariance.wiseReceiptsUnavailableReason).toContain("Wise API 500");
    expect(result.students[0].rows[0].candidates).toHaveLength(0);
  });

  it("skips non-revenue receipt rows from receipt totals", () => {
    const result = buildPackageSalesReconciliation({
      sources: [],
      selectedSource: null,
      saleRows: [sale({ paymentAmount: 3569360 })],
      wiseEvents: [],
      wiseReceipts: [
        receipt({ id: "charged", amount: 3_569_360, amountMinor: 356_936_000 }),
        receipt({ id: "disbursal", type: "DISBURSAL", amount: 50_000, amountMinor: 5_000_000 }),
        receipt({ id: "pending", status: "PENDING_CONFIRMATION", amount: 10_000, amountMinor: 1_000_000 }),
        receipt({ id: "rejected", status: "REJECTED", amount: 10_000, amountMinor: 1_000_000 }),
        receipt({ id: "refund", type: "REFUND", amount: 1_000, amountMinor: 100_000 }),
        receipt({ id: "zero", amount: 0, amountMinor: 0 }),
      ],
      creditPackages: [],
      startDate: "2026-05-01",
      endDate: "2026-05-28",
      wiseFeesPaidTrends: [feesPaidTrend({ amount: 3_569_360, amountMinor: 356_936_000 })],
    });

    expect(result.revenueVariance.wiseReceiptTotal).toBe(3_569_360);
    expect(result.revenueVariance.wiseReceiptCount).toBe(1);
    expect(result.revenueVariance.wiseReceiptSkippedCount).toBe(5);
  });

  it("uses amount and date proximity as supporting candidate evidence", () => {
    const result = buildPackageSalesReconciliation({
      sources: [],
      selectedSource: null,
      saleRows: [sale({ raw: { "Transaction No.": "sheet-only" } })],
      wiseEvents: [],
      wiseReceipts: [receipt({
        id: "different",
        chargedAt: "2026-05-12T05:00:00.000Z",
        identifiers: ["different"],
      })],
      creditPackages: [],
      startDate: "2026-05-10",
      endDate: "2026-05-12",
    });

    const candidate = result.students[0].rows[0].candidates[0];
    expect(candidate.confidence).toBe("medium");
    expect(candidate.reasons).toContain("Payment amount matches the package-sale row.");
    expect(candidate.reasons).toContain("Wise receipt date is within 2 days of the sheet payment date.");
  });

  it("leaves rows candidate-only when no Wise evidence reaches the threshold", () => {
    const result = buildPackageSalesReconciliation({
      sources: [],
      selectedSource: null,
      saleRows: [sale({ paymentAmount: 9999, raw: {} })],
      wiseEvents: [],
      wiseReceipts: [receipt({
        id: "other",
        chargedAt: "2026-05-20T05:00:00.000Z",
        classroomName: "Unrelated class",
        amount: 100,
        identifiers: ["other"],
        parentNames: [],
        studentName: "Other Student",
      })],
      creditPackages: [],
      startDate: "2026-05-10",
      endDate: "2026-05-20",
    });

    const row = result.students[0].rows[0];
    expect(row.candidates).toHaveLength(0);
    expect(row.reviewFlags).toContain("No Wise receipt candidates found.");
    expect(row.reviewFlags).toContain("Sheet row has no transaction number.");
  });

  it("marks coverage incomplete when persisted inbound Wise events do not span the selected range", () => {
    const result = buildPackageSalesReconciliation({
      sources: [],
      selectedSource: null,
      saleRows: [sale()],
      wiseEvents: [
        event({ id: "event-late", eventTimestamp: new Date("2026-05-27T05:00:00.000Z") }),
        event({ id: "event-end", eventTimestamp: new Date("2026-05-28T05:00:00.000Z") }),
      ],
      creditPackages: [],
      startDate: "2026-05-01",
      endDate: "2026-05-28",
    });

    expect(result.coverage.status).toBe("partial");
    expect(result.coverage.firstInboundEventDate).toBe("2026-05-27");
    expect(result.coverage.message).toContain("backfill before trusting missing-candidate rows");
  });

  it("marks coverage complete when inbound Wise events span the selected range", () => {
    const result = buildPackageSalesReconciliation({
      sources: [],
      selectedSource: null,
      saleRows: [sale()],
      wiseEvents: [
        event({ id: "event-start", eventTimestamp: new Date("2026-04-30T17:30:00.000Z") }),
        event({ id: "event-end", eventTimestamp: new Date("2026-05-28T16:00:00.000Z") }),
      ],
      creditPackages: [],
      startDate: "2026-05-01",
      endDate: "2026-05-28",
    });

    expect(result.coverage.status).toBe("complete");
  });

  it("computes selected-range backfill lookback days from Bangkok dates", () => {
    expect(wiseReconciliationBackfillLookbackDays("2026-05-01", new Date("2026-05-28T06:00:00.000Z"))).toBe(28);
  });
});
