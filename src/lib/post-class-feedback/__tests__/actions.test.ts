import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import {
  assertPostClassApprovalPeriodInvariant,
  assertPostClassDeductionCandidateStillActionable,
  assertPostClassFinanceIdempotentPayloadMatches,
  assertPostClassFinanceMonthActionInvariant,
  assertPostClassFinancePeriodIdempotentPayloadMatches,
  assertPostClassReviewIdempotentPayloadMatches,
  changePostClassFinancePeriod,
} from "@/lib/post-class-feedback/actions";

function actionableEvidence() {
  return {
    sessionEligible: true,
    sessionSourceStatus: "ready",
    formMappingValid: true,
    hasBlockingGlobalSourceIssue: false,
    assessment: {
      sourceReady: true,
      sourceStatus: "ready",
      enforcementMode: "live",
      objectiveViolation: true,
      rawOnTime: false,
      adjustedCompliant: false,
      policyApplies: true,
    },
  };
}

describe("post-class finance invariants", () => {
  it("rejects approval into an explicitly assigned closed period", () => {
    expect(() => assertPostClassApprovalPeriodInvariant({
      financePeriodId: "period-1",
      assignedPeriodStatus: "closed",
      defaultPeriodStatus: "open",
    })).toThrow(/reopen.*finance period/i);
  });

  it("fails closed when an explicit finance-period assignment cannot be resolved", () => {
    expect(() => assertPostClassApprovalPeriodInvariant({
      financePeriodId: "missing-period",
      assignedPeriodStatus: null,
      defaultPeriodStatus: null,
    })).toThrow(/could not be verified/i);
  });

  it("rejects approval when the implicit default period is closed", () => {
    expect(() => assertPostClassApprovalPeriodInvariant({
      financePeriodId: null,
      assignedPeriodStatus: null,
      defaultPeriodStatus: "closed",
    })).toThrow(/reopen.*finance period/i);
  });

  it("allows approval when an existing relevant period is open", () => {
    expect(() => assertPostClassApprovalPeriodInvariant({
      financePeriodId: "period-1",
      assignedPeriodStatus: "open",
      defaultPeriodStatus: null,
    })).not.toThrow();
  });

  it("allows approval before the default finance period is created", () => {
    expect(() => assertPostClassApprovalPeriodInvariant({
      financePeriodId: null,
      assignedPeriodStatus: null,
      defaultPeriodStatus: null,
    })).not.toThrow();
  });

  it("requires current eligible, source-ready, objective evidence before action", () => {
    expect(() => assertPostClassDeductionCandidateStillActionable(
      actionableEvidence(),
    )).not.toThrow();
    expect(() => assertPostClassDeductionCandidateStillActionable({
      ...actionableEvidence(),
      sessionEligible: false,
    })).toThrow(/no longer eligible/i);
    expect(() => assertPostClassDeductionCandidateStillActionable({
      ...actionableEvidence(),
      sessionSourceStatus: "identity_review",
    })).toThrow(/paused or ambiguous/i);
    expect(() => assertPostClassDeductionCandidateStillActionable({
      ...actionableEvidence(),
      assessment: null,
    })).toThrow(/paused or ambiguous/i);
    expect(() => assertPostClassDeductionCandidateStillActionable({
      ...actionableEvidence(),
      assessment: { ...actionableEvidence().assessment, objectiveViolation: false },
    })).toThrow(/no longer an objective violation/i);
  });

  it("rejects candidates that became raw-on-time or adjusted compliant", () => {
    expect(() => assertPostClassDeductionCandidateStillActionable({
      ...actionableEvidence(),
      assessment: { ...actionableEvidence().assessment, rawOnTime: true },
    })).toThrow(/is compliant/i);
    expect(() => assertPostClassDeductionCandidateStillActionable({
      ...actionableEvidence(),
      assessment: { ...actionableEvidence().assessment, adjustedCompliant: true },
    })).toThrow(/is compliant/i);
  });

  it("binds review idempotency to note, category, version, and target status", () => {
    const recorded = {
      deductionId: "deduction-1",
      action: "waive",
      note: "Tutor emergency",
      reference: null,
      waiverCategory: "tutor_emergency",
      toStatus: "waived" as const,
      metadata: { expectedVersion: 3 },
    };
    const expected = {
      note: "Tutor emergency",
      waiverCategory: "tutor_emergency" as const,
      expectedVersion: 3,
      targetStatus: "waived" as const,
    };
    expect(() => assertPostClassReviewIdempotentPayloadMatches(recorded, expected)).not.toThrow();
    expect(() => assertPostClassReviewIdempotentPayloadMatches(recorded, {
      ...expected,
      note: "Different note",
    })).toThrow(/different review payload/i);
    expect(() => assertPostClassReviewIdempotentPayloadMatches(recorded, {
      ...expected,
      waiverCategory: "other",
    })).toThrow(/different review payload/i);
    expect(() => assertPostClassReviewIdempotentPayloadMatches(recorded, {
      ...expected,
      expectedVersion: 4,
    })).toThrow(/different review payload/i);
  });

  it("binds finance-action idempotency to month, reference, reason, version, and target", () => {
    const recorded = {
      deductionId: "deduction-1",
      action: "process",
      note: null,
      reference: "Payroll ref",
      waiverCategory: null,
      toStatus: "processed" as const,
      metadata: { processingMonth: "2026-07", expectedVersion: 4 },
    };
    const expected = {
      processingMonth: "2026-07",
      reference: "Payroll ref",
      reason: null,
      expectedVersion: 4,
      targetStatus: "processed" as const,
    };
    expect(() => assertPostClassFinanceIdempotentPayloadMatches(recorded, expected)).not.toThrow();
    expect(() => assertPostClassFinanceIdempotentPayloadMatches(recorded, {
      ...expected,
      processingMonth: "2026-08",
    })).toThrow(/different finance payload/i);
    expect(() => assertPostClassFinanceIdempotentPayloadMatches(recorded, {
      ...expected,
      reference: "Different ref",
    })).toThrow(/different finance payload/i);
  });

  it("binds finance-period idempotency to every input", () => {
    const prior = {
      entityKey: "2026-07",
      action: "close",
      note: "Month complete",
      afterValue: { requestedExpectedVersion: 2 },
    };
    const expected = {
      month: "2026-07",
      action: "close" as const,
      reason: "Month complete",
      expectedVersion: 2,
    };
    expect(() => assertPostClassFinancePeriodIdempotentPayloadMatches(prior, expected)).not.toThrow();
    expect(() => assertPostClassFinancePeriodIdempotentPayloadMatches(prior, {
      ...expected,
      reason: "Different reason",
    })).toThrow(/different finance-period inputs/i);
    expect(() => assertPostClassFinancePeriodIdempotentPayloadMatches(prior, {
      ...expected,
      expectedVersion: 3,
    })).toThrow(/different finance-period inputs/i);
  });

  it("requires a move before processing in a later month", () => {
    expect(() => assertPostClassFinanceMonthActionInvariant({
      action: "process",
      requestedMonth: "2026-08-01",
      defaultMonth: "2026-07-01",
      assignedMonth: "2026-07-01",
    })).toThrow(/move.*before processing/i);
  });

  it("processes only in the currently assigned month", () => {
    expect(() => assertPostClassFinanceMonthActionInvariant({
      action: "process",
      requestedMonth: "2026-08-01",
      defaultMonth: "2026-07-01",
      assignedMonth: "2026-08-01",
    })).not.toThrow();
  });

  it("allows move only to a different later-than-class month", () => {
    expect(() => assertPostClassFinanceMonthActionInvariant({
      action: "move",
      requestedMonth: "2026-07-01",
      defaultMonth: "2026-07-01",
      assignedMonth: "2026-07-01",
    })).toThrow(/later month/i);
    expect(() => assertPostClassFinanceMonthActionInvariant({
      action: "move",
      requestedMonth: "2026-08-01",
      defaultMonth: "2026-07-01",
      assignedMonth: "2026-08-01",
    })).toThrow(/already assigned/i);
    expect(() => assertPostClassFinanceMonthActionInvariant({
      action: "move",
      requestedMonth: "2026-09-01",
      defaultMonth: "2026-07-01",
      assignedMonth: "2026-08-01",
    })).not.toThrow();
  });

  it("requires durable idempotency when opening a finance period", async () => {
    await expect(changePostClassFinancePeriod(
      { email: "finance@example.com" },
      { month: "2026-07", action: "open" } as never,
      {} as never,
    )).rejects.toThrow(/idempotency key is required/i);
  });

  it("requires optimistic concurrency when closing or reopening a period", async () => {
    await expect(changePostClassFinancePeriod(
      { email: "finance@example.com" },
      { month: "2026-07", action: "close" } as never,
      {} as never,
    )).rejects.toThrow(/expected version is required/i);
    await expect(changePostClassFinancePeriod(
      { email: "finance@example.com" },
      { month: "2026-07", action: "reopen", reason: "Correction" } as never,
      {} as never,
    )).rejects.toThrow(/expected version is required/i);
  });
});
