import { describe, expect, it } from "vitest";

import {
  assertPayoutRunPublishable,
  buildPayoutRunCsv,
  payoutLineIdempotencyKey,
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
});

describe("assertPayoutRunPublishable", () => {
  function coverage(overrides: Partial<PayoutRunCoverage> = {}): PayoutRunCoverage {
    return {
      eligibleSessions: 1_000,
      readySessions: 1_000,
      unavailableSessions: 0,
      formDriftSessions: 0,
      identityReviewSessions: 0,
      pendingReviewDeductions: 0,
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
      { pendingReviewDeductions: 3, unavailableSessions: 900 },
    )).toThrow(/Source health is unproven/u);
  });

  it("blocks while deductions are still awaiting review", () => {
    expect(() => assertPayoutRunPublishable(coverage({ pendingReviewDeductions: 4 })))
      .toThrow(/awaiting review/u);
  });

  it("accepts an acknowledgement that matches the count exactly", () => {
    expect(() => assertPayoutRunPublishable(
      coverage({ pendingReviewDeductions: 4 }),
      { pendingReviewDeductions: 4 },
    )).not.toThrow();
  });

  it("rejects a stale acknowledgement", () => {
    // The operator approved 4; 6 are pending now. Publishing would quietly
    // include two nobody looked at.
    expect(() => assertPayoutRunPublishable(
      coverage({ pendingReviewDeductions: 6 }),
      { pendingReviewDeductions: 4 },
    )).toThrow(/awaiting review/u);
  });

  it("blocks when the window is materially unreconciled", () => {
    expect(() => assertPayoutRunPublishable(
      coverage({ eligibleSessions: 1_304, unavailableSessions: 1_271 }),
    )).toThrow(/no trustworthy Wise evidence/u);
  });

  it("tolerates a negligible unreconciled tail", () => {
    expect(() => assertPayoutRunPublishable(
      coverage({ eligibleSessions: 1_000, unavailableSessions: 10 }),
    )).not.toThrow();
  });

  it("lets an operator publish an unreconciled window by acknowledging the exact count", () => {
    expect(() => assertPayoutRunPublishable(
      coverage({ eligibleSessions: 1_304, unavailableSessions: 1_271 }),
      { unavailableSessions: 1_271 },
    )).not.toThrow();
  });

  it("does not divide by zero on an empty window", () => {
    expect(() => assertPayoutRunPublishable(
      coverage({ eligibleSessions: 0, unavailableSessions: 0, approvedDeductions: 0 }),
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
      amountMinor: 10_000,
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
    expect(csv).toContain('"Deduction"');
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
