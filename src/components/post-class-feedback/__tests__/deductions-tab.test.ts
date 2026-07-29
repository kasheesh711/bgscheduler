import { describe, expect, it } from "vitest";

import type { FeedbackDeductionRow } from "@/types/post-class-feedback";

import { canProcessFeedbackDeduction } from "../deductions-tab";

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
    processingMonth: "2026-07",
    referenceNote: null,
    waiverCategory: null,
    decisionNote: null,
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
