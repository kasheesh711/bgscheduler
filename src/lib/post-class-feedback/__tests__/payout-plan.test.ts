import { describe, expect, it } from "vitest";

import {
  assertPayoutRunPublishable,
  buildPayoutRunCsv,
  payoutLineIdempotencyKey,
  payoutPreviewToken,
  payoutSourceFingerprint,
  type PayoutRunCoverage,
} from "../payout-plan";

describe("payoutLineIdempotencyKey", () => {
  it("is deterministic for the same run and deduction", () => {
    const key = payoutLineIdempotencyKey({ runId: "run-1", deductionId: "ded-1" });
    expect(key).toBe("payout:run-1:ded-1");
    expect(payoutLineIdempotencyKey({ runId: "run-1", deductionId: "ded-1" })).toBe(key);
  });

  it("separates the same deduction across two runs", () => {
    expect(payoutLineIdempotencyKey({ runId: "run-1", deductionId: "ded-1" }))
      .not.toBe(payoutLineIdempotencyKey({ runId: "run-2", deductionId: "ded-1" }));
  });

  it("separates a reinstated generation while keeping generation 1 byte-identical", () => {
    expect(payoutLineIdempotencyKey({ runId: "run-1", deductionId: "ded-1", generation: 1 }))
      .toBe("payout:run-1:ded-1");
    expect(payoutLineIdempotencyKey({ runId: "run-1", deductionId: "ded-1", generation: 2 }))
      .toBe("payout:run-1:ded-1:g2");
  });
});

describe("payoutPreviewToken", () => {
  const input = {
    policyVersion: 3,
    anchorMonth: "2026-07",
    windowStart: "2026-06-26",
    windowEnd: "2026-07-25",
    tutorFilter: null,
    runVersion: null,
    runStatus: null,
    coverage: {
      eligibleSessions: 1,
      readySessions: 1,
      nonReadySessions: 0,
      unavailableSessions: 0,
      formDriftSessions: 0,
      identityReviewSessions: 0,
      pendingReviewDeductions: 0,
      unprovenApprovedDeductions: 0,
      approvedDeductions: 1,
      unmappedTutorKeys: [],
      nullTutorKeyLines: 0,
      blockingGlobalSourceIssues: 0,
    },
    obligations: [{
      sourceIdentity: "deduction:1",
      rowSignature: "BGS-PAYOUT 2026-07 abcdef123456",
      sessionId: "session-1",
      wiseSessionId: "wise-session-1",
      amountMinor: -10_000,
      currency: "THB",
      canonicalTutorKey: "kevin",
      tutorName: "Kevin",
      className: "Mathematics",
      studentNames: ["Ada Lovelace"],
      scheduledStartAt: "2026-07-10T03:00:00.000Z",
      scheduledEndAt: "2026-07-10T04:00:00.000Z",
      deadlineAt: "2026-07-10T06:00:00.000Z",
      tutorSubmittedAt: null,
      financeMonth: "2026-07-01",
      reason: "Feedback was incomplete at the deadline",
      mappingIdentity: "Kevin\u0000Kevin Online",
    }],
    adjustments: [],
  };

  it("is stable for the same read-only snapshot", () => {
    expect(payoutPreviewToken(input)).toBe(payoutPreviewToken(input));
  });

  it("changes when a signed obligation changes", () => {
    expect(payoutPreviewToken(input)).not.toBe(payoutPreviewToken({
      ...input,
      obligations: [{ ...input.obligations[0], amountMinor: -20_000 }],
    }));
  });

  it("changes when the enforcement policy version changes", () => {
    expect(payoutPreviewToken(input)).not.toBe(payoutPreviewToken({
      ...input,
      policyVersion: input.policyVersion + 1,
    }));
  });

  it("changes when row matching inputs change", () => {
    expect(payoutPreviewToken(input)).not.toBe(payoutPreviewToken({
      ...input,
      obligations: [{
        ...input.obligations[0],
        scheduledStartAt: "2026-07-10T03:30:00.000Z",
      }],
    }));
    expect(payoutPreviewToken(input)).not.toBe(payoutPreviewToken({
      ...input,
      obligations: [{
        ...input.obligations[0],
        studentNames: ["Grace Hopper"],
      }],
    }));
  });

  it("keeps a source fingerprint stable across expected run and write-outcome changes", () => {
    const withAdjustment = {
      ...input,
      runVersion: 4,
      runStatus: "publishing",
      adjustments: [{
        sourceIdentity: "adjustment:1",
        rowSignature: "BGS-PAYOUT-CORRECTION 2026-07 abcdef123456",
        amountMinor: 10_000,
        status: "pending",
      }],
    };
    expect(payoutSourceFingerprint(withAdjustment)).toBe(
      payoutSourceFingerprint({
        ...withAdjustment,
        runVersion: 5,
        runStatus: "published",
        adjustments: [{ ...withAdjustment.adjustments[0], status: "written" }],
      }),
    );
  });

  it("changes the source fingerprint when a row-affecting input changes", () => {
    expect(payoutSourceFingerprint(input)).not.toBe(payoutSourceFingerprint({
      ...input,
      obligations: [{
        ...input.obligations[0],
        mappingIdentity: "Different Ledger Name\u0000",
      }],
    }));
  });
});

describe("assertPayoutRunPublishable", () => {
  function coverage(overrides: Partial<PayoutRunCoverage> = {}): PayoutRunCoverage {
    return {
      eligibleSessions: 1_000,
      readySessions: 1_000,
      nonReadySessions: 0,
      unavailableSessions: 0,
      formDriftSessions: 0,
      identityReviewSessions: 0,
      pendingReviewDeductions: 0,
      unprovenApprovedDeductions: 0,
      approvedDeductions: 12,
      unmappedTutorKeys: [],
      nullTutorKeyLines: 0,
      blockingGlobalSourceIssues: 0,
      ...overrides,
    };
  }

  it("passes a clean run", () => {
    expect(() => assertPayoutRunPublishable(coverage())).not.toThrow();
  });

  it("blocks on an open global source issue regardless of acknowledgements", () => {
    expect(() => assertPayoutRunPublishable(
      coverage({ blockingGlobalSourceIssues: 1, pendingReviewDeductions: 3, unavailableSessions: 900 }),
      { pendingReviewDeductions: 3, nonReadySessions: 900, reason: "Known source outage" },
    )).toThrow(/Source health is unproven/u);
  });

  it("blocks while deductions are still awaiting review", () => {
    expect(() => assertPayoutRunPublishable(coverage({ pendingReviewDeductions: 4 })))
      .toThrow(/awaiting review/u);
  });

  it("accepts an acknowledgement that matches the count exactly", () => {
    expect(() => assertPayoutRunPublishable(
      coverage({ pendingReviewDeductions: 4 }),
      { pendingReviewDeductions: 4, reason: "Finance reviewed the outstanding set" },
    )).not.toThrow();
  });

  it("rejects a stale acknowledgement", () => {
    // The operator approved 4; 6 are pending now. Publishing would quietly
    // include two nobody looked at.
    expect(() => assertPayoutRunPublishable(
      coverage({ pendingReviewDeductions: 6 }),
      { pendingReviewDeductions: 4, reason: "Stale acknowledgement" },
    )).toThrow(/awaiting review/u);
  });

  it("blocks when the window is materially unreconciled", () => {
    expect(() => assertPayoutRunPublishable(
      coverage({ eligibleSessions: 1_304, nonReadySessions: 1_271, unavailableSessions: 1_271 }),
    )).toThrow(/no trustworthy Wise evidence/u);
  });

  it("tolerates a negligible unreconciled tail", () => {
    expect(() => assertPayoutRunPublishable(
      coverage({ eligibleSessions: 1_000, nonReadySessions: 10, unavailableSessions: 10 }),
    )).not.toThrow();
  });

  it("counts form drift and identity review in the same non-ready gate", () => {
    const incomplete = coverage({
      eligibleSessions: 100,
      readySessions: 94,
      nonReadySessions: 6,
      unavailableSessions: 0,
      formDriftSessions: 3,
      identityReviewSessions: 3,
    });
    expect(() => assertPayoutRunPublishable(incomplete))
      .toThrow(/no trustworthy Wise evidence/u);
    expect(() => assertPayoutRunPublishable(incomplete, {
      nonReadySessions: 6,
      reason: "Every non-ready source row was independently reviewed.",
    })).not.toThrow();
  });

  it("lets an operator publish an unreconciled window by acknowledging the exact count", () => {
    expect(() => assertPayoutRunPublishable(
      coverage({ eligibleSessions: 1_304, nonReadySessions: 1_271, unavailableSessions: 1_271 }),
      { nonReadySessions: 1_271, reason: "Backfill is independently reconciled" },
    )).not.toThrow();
  });

  it("does not divide by zero on an empty window", () => {
    expect(() => assertPayoutRunPublishable(
      coverage({
        eligibleSessions: 0,
        nonReadySessions: 0,
        unavailableSessions: 0,
        approvedDeductions: 0,
      }),
    )).not.toThrow();
  });
});

describe("buildPayoutRunCsv", () => {
  const header = { anchorMonth: "2026-07", windowStart: "2026-06-26", windowEnd: "2026-07-25" };

  function line(overrides: Partial<Parameters<typeof buildPayoutRunCsv>[1][number]> = {}) {
    return {
      canonicalTutorKey: "Kevin",
      tutorName: "Kevin Hsieh",
      wiseSessionId: "sess-1",
      className: "Math",
      studentNames: ["Grace Hopper"],
      scheduledStartAt: new Date("2026-07-25T06:00:00.000Z"),
      scheduledEndAt: new Date("2026-07-25T07:00:00.000Z"),
      deadlineAt: new Date("2026-07-26T17:00:00.000Z"),
      tutorSubmittedAt: null,
      amountMinor: -10_000,
      currency: "THB",
      financeMonth: "2026-07",
      reason: "No feedback submitted",
      spreadsheetId: "book-1",
      sheetName: "Kevin",
      matchedRowNumber: 12,
      insertedRowNumber: 13,
      matchStatus: "matched",
      writeStatus: "written",
      writeError: null,
      writtenAt: new Date("2026-07-27T04:00:00.000Z"),
      ...overrides,
    };
  }

  it("writes a header row followed by one row per line", () => {
    const csv = buildPayoutRunCsv(header, [line(), line({ wiseSessionId: "sess-2" })]);
    expect(csv.split("\r\n")).toHaveLength(3);
    expect(csv).toContain('"Payout month"');
    expect(csv).toContain('"Signed amount"');
  });

  it("records the deduction as a negative amount", () => {
    expect(buildPayoutRunCsv(header, [line()])).toContain('"-100"');
  });

  it("formats timestamps in Bangkok, not UTC", () => {
    // 06:00Z is 13:00 in Bangkok. A UTC rendering here would misinform finance.
    const csv = buildPayoutRunCsv(header, [line()]);
    expect(csv).toContain("13:00");
  });

  it("keeps skipped and unmapped lines so an absence is distinguishable", () => {
    const csv = buildPayoutRunCsv(header, [
      line({ matchStatus: "no_sheet", writeStatus: "skipped", spreadsheetId: null, sheetName: null }),
      line({ matchStatus: "unmatched", writeStatus: "skipped", wiseSessionId: "sess-3" }),
      line({ writeStatus: "failed", writeError: "Google Sheets batch update failed (429)" }),
    ]);
    expect(csv.split("\r\n")).toHaveLength(4);
    expect(csv).toContain('"no_sheet"');
    expect(csv).toContain('"unmatched"');
    expect(csv).toContain("429");
  });

  it("starts with a UTF-8 BOM so Excel reads Thai names correctly", () => {
    expect(buildPayoutRunCsv(header, [line()]).startsWith("﻿")).toBe(true);
  });
});
