import { describe, expect, it } from "vitest";

import { serializeCsv } from "@/lib/sales-dashboard/csv";
import type { FeedbackDeductionRow } from "@/types/post-class-feedback";

import { DEDUCTION_EXPORT_COLUMNS, canProcessFeedbackDeduction } from "../deductions-tab";

function row(overrides: Partial<FeedbackDeductionRow> = {}): FeedbackDeductionRow {
  return {
    id: "deduction-1",
    sessionId: "session-1",
    tutorKey: "Kevin",
    wiseSessionId: "wise-1",
    tutorName: "Kevin",
    className: "Math",
    students: ["Ada"],
    sessionEndAt: "2026-07-10T03:00:00.000Z",
    reason: "Missing feedback",
    amount: 100,
    status: "approved",
    payoutVerifiedWritten: false,
    payoutLedgerState: "none",
    processingMonth: "2026-07",
    referenceNote: null,
    waiverCategory: null,
    decisionNote: null,
    decisionByEmail: null,
    decisionAt: null,
    processedByEmail: null,
    processedAt: null,
    version: 1,
    updatedAt: "2026-07-10T03:00:00.000Z",
    ...overrides,
  };
}

describe("deduction payout lifecycle", () => {
  it("enables Process only for an approved, verified-written deduction", () => {
    expect(canProcessFeedbackDeduction(row())).toBe(false);
    expect(canProcessFeedbackDeduction(row({ payoutVerifiedWritten: true }))).toBe(true);
    expect(canProcessFeedbackDeduction(row({
      status: "processed",
      payoutVerifiedWritten: true,
    }))).toBe(false);
  });
});

describe("deduction CSV export", () => {
  function csvLines(rows: FeedbackDeductionRow[]): string[] {
    return serializeCsv(rows, DEDUCTION_EXPORT_COLUMNS, { includeBom: false }).split("\r\n");
  }

  it("pins the header order", () => {
    expect(csvLines([])[0]).toBe([
      "Tutor",
      "Session end (Bangkok)",
      "Class",
      "Students",
      "Reason",
      "Amount (THB)",
      "Status",
      "Ledger verified",
      "Processing month",
      "Processing reference",
      "Waiver category",
      "Decision note",
      "Decision by",
      "Decision at (Bangkok)",
      "Processed by",
      "Processed at (Bangkok)",
      "Wise session",
      "Deduction ID",
    ].map((header) => `"${header}"`).join(","));
  });

  it("renders timestamps as Bangkok wall time and joins students", () => {
    const [, line] = csvLines([row({
      students: ["Ada", "สมชาย"],
      decisionByEmail: "reviewer@example.com",
      decisionAt: "2026-08-01T05:30:00.000Z",
      payoutVerifiedWritten: true,
    })]);

    expect(line).toContain('"10 Jul 2026, 10:00"');
    expect(line).toContain('"Ada; สมชาย"');
    expect(line).toContain('"reviewer@example.com"');
    expect(line).toContain('"1 Aug 2026, 12:30"');
    expect(line).toContain('"yes"');
    expect(line).not.toContain("Z");
  });

  it("renders absent decision metadata as empty cells, never the em-dash placeholder", () => {
    const [, line] = csvLines([row()]);

    expect(line.endsWith('"","","","","wise-1","deduction-1"')).toBe(true);
    expect(line).not.toContain("—");
  });
});
