import { describe, expect, it } from "vitest";
import {
  buildPackageSalesReconciliation,
  wiseReconciliationBackfillLookbackDays,
  type CreditPackageInput,
  type PackageSaleInput,
  type WiseInvoiceEventInput,
} from "../reconciliation";

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
    transactionAmount: 12000,
    transactionCurrency: "THB",
    payload: {
      transaction: {
        id: "tx-1",
        senderId: "student-1",
        amount: { value: 12000, currency: "THB" },
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

describe("Wise package-sales reconciliation", () => {
  it("returns review candidates from exact transaction and invoice metadata without auto-matching", () => {
    const result = buildPackageSalesReconciliation({
      sources: [],
      selectedSource: null,
      saleRows: [sale()],
      wiseEvents: [event()],
      creditPackages: [creditPackage()],
      startDate: "2026-05-10",
      endDate: "2026-05-10",
    });

    const row = result.students[0].rows[0];
    expect(row.candidates).toHaveLength(1);
    expect(row.candidates[0].confidence).toBe("high");
    expect(row.candidates[0].reasons).toContain("Sheet transaction number appears on the Wise event.");
    expect(row.candidates[0].reasons).toContain("Wise class ID matches the student's active Credit Control package.");
    expect(row).not.toHaveProperty("matched");
    expect(row).not.toHaveProperty("matchStatus");
  });

  it("uses amount and date proximity as supporting candidate evidence", () => {
    const result = buildPackageSalesReconciliation({
      sources: [],
      selectedSource: null,
      saleRows: [sale({ raw: { "Transaction No.": "sheet-only" } })],
      wiseEvents: [event({
        transactionId: "different",
        eventTimestamp: new Date("2026-05-12T05:00:00.000Z"),
        payload: { transaction: { id: "different", amount: { value: 12000, currency: "THB" } } },
      })],
      creditPackages: [],
      startDate: "2026-05-10",
      endDate: "2026-05-12",
    });

    const candidate = result.students[0].rows[0].candidates[0];
    expect(candidate.confidence).toBe("medium");
    expect(candidate.reasons).toContain("Payment amount matches the package-sale row.");
    expect(candidate.reasons).toContain("Wise event date is within 2 days of the sheet payment date.");
  });

  it("leaves rows candidate-only when no Wise evidence reaches the threshold", () => {
    const result = buildPackageSalesReconciliation({
      sources: [],
      selectedSource: null,
      saleRows: [sale({ paymentAmount: 9999, raw: {} })],
      wiseEvents: [event({
        eventTimestamp: new Date("2026-05-20T05:00:00.000Z"),
        classroomName: "Unrelated class",
        transactionAmount: 100,
        payload: { transaction: { id: "other" } },
      })],
      creditPackages: [],
      startDate: "2026-05-10",
      endDate: "2026-05-20",
    });

    const row = result.students[0].rows[0];
    expect(row.candidates).toHaveLength(0);
    expect(row.reviewFlags).toContain("No Wise invoice/payment candidates found.");
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
