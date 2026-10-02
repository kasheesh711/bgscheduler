/**
 * Grace-hours resolution for the auto-approval sweep.
 *
 * The resolver guards the two failure modes a bare `Number(raw ?? 24)` had
 * once the accrual cron is scheduled: a blank value coercing to a 0-hour
 * grace (immediate auto-approval) and a malformed value coercing to NaN.
 */

import { DrizzleQueryError } from "drizzle-orm/errors";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

vi.mock("server-only", () => ({}));
// Only the sweeps below use these; the resolver cases never reach them.
vi.mock("@/lib/post-class-feedback/actions", () => ({ applyPostClassReviewAction: vi.fn() }));
vi.mock("@/lib/post-class-feedback/deduction-evidence", () => ({
  deductionEvidenceIssue: vi.fn(),
  loadCurrentDeductionEvidence: vi.fn(),
}));
vi.mock("@/lib/post-class-feedback/payout-repository", () => ({
  hasWrittenPayoutDeduction: vi.fn(),
  noLiveWrittenPayoutLine: vi.fn(),
}));

import type { Database } from "@/lib/db";
import { applyPostClassReviewAction } from "@/lib/post-class-feedback/actions";
import {
  autoChargeLowerBoundUtc,
  resolveAutoApproveEnabled,
  resolveAutoApproveGraceHours,
  runPostClassAutoApprovals,
  runPostClassAutoReopens,
  runPostClassIneligibleWaivers,
} from "@/lib/post-class-feedback/auto-approval";
import { deductionEvidenceIssue, loadCurrentDeductionEvidence } from "@/lib/post-class-feedback/deduction-evidence";
import { PostClassConflictError, PostClassValidationError } from "@/lib/post-class-feedback/errors";
import { hasWrittenPayoutDeduction } from "@/lib/post-class-feedback/payout-repository";

describe("resolveAutoApproveEnabled", () => {
  it("is off when the variable is absent — approvals are human-only by default", () => {
    expect(resolveAutoApproveEnabled(undefined)).toBe(false);
  });

  it("is off for blank, whitespace, and non-true values", () => {
    expect(resolveAutoApproveEnabled("")).toBe(false);
    expect(resolveAutoApproveEnabled("  ")).toBe(false);
    expect(resolveAutoApproveEnabled("false")).toBe(false);
    expect(resolveAutoApproveEnabled("1")).toBe(false);
    expect(resolveAutoApproveEnabled("TRUE")).toBe(false);
  });

  it("is on only for an explicit true", () => {
    expect(resolveAutoApproveEnabled("true")).toBe(true);
    expect(resolveAutoApproveEnabled(" true ")).toBe(true);
  });
});

describe("resolveAutoApproveGraceHours", () => {
  it("defaults to 24 when the variable is absent", () => {
    expect(resolveAutoApproveGraceHours(undefined)).toBe(24);
  });

  it("defaults to 24 for blank values instead of coercing to a 0-hour grace", () => {
    expect(resolveAutoApproveGraceHours("")).toBe(24);
    expect(resolveAutoApproveGraceHours("  ")).toBe(24);
  });

  it("defaults to 24 for non-numeric values instead of a NaN deadline", () => {
    expect(resolveAutoApproveGraceHours("banana")).toBe(24);
    expect(resolveAutoApproveGraceHours("24h")).toBe(24);
  });

  it("rejects negative and infinite values", () => {
    expect(resolveAutoApproveGraceHours("-1")).toBe(24);
    expect(resolveAutoApproveGraceHours("Infinity")).toBe(24);
  });

  it("keeps explicit zero as a deliberate immediate-approval mode", () => {
    expect(resolveAutoApproveGraceHours("0")).toBe(0);
  });

  it("accepts ordinary and fractional hour values", () => {
    expect(resolveAutoApproveGraceHours("36")).toBe(36);
    expect(resolveAutoApproveGraceHours("1.5")).toBe(1.5);
  });
});

describe("autoChargeLowerBoundUtc", () => {
  it("clamps to the automation floor while the last-ended window predates it", () => {
    // Mid-September: the last-ended window is 2026-07-26..2026-08-25 (the
    // INC-260829-era period), so the floor wins — Bangkok 2026-08-26 00:00.
    expect(autoChargeLowerBoundUtc(new Date("2026-09-15T12:00:00.000Z")).toISOString())
      .toBe("2026-08-25T17:00:00.000Z");
  });

  it("still clamps to the floor on the first day after the window rolls", () => {
    // Sep 26 Bangkok: the last-ended window is 2026-08-26..2026-09-25, whose
    // start equals the floor exactly.
    expect(autoChargeLowerBoundUtc(new Date("2026-09-26T01:00:00.000Z")).toISOString())
      .toBe("2026-08-25T17:00:00.000Z");
  });

  it("advances with the last-ended window once past the floor", () => {
    // Mid-November: last-ended window is 2026-09-26..2026-10-25, so months-old
    // flags fall out of the unattended scope and stay human decisions.
    expect(autoChargeLowerBoundUtc(new Date("2026-11-10T12:00:00.000Z")).toISOString())
      .toBe("2026-09-25T17:00:00.000Z");
  });
});

/** Each sweep awaits one select chain; this resolves it with the given candidate rows. */
function fakeDb(rows: unknown[]): Database {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    then: (resolve: (value: unknown) => void) => resolve(rows),
  };
  return { select: () => chain } as unknown as Database;
}

/** A real drizzle 0.45 failure: the SQL and its parameters in the message, the driver's SQLSTATE on `cause`. */
function driverError(): Error {
  const cause = Object.assign(new Error("could not serialize access due to concurrent update"), {
    name: "NeonDbError",
    code: "40001",
  });
  return new DrizzleQueryError('update "post_class_deductions" set "status" = $1 where "id" = $2', ["approved", "ded-1"], cause);
}

describe("sweep failure logging", () => {
  let consoleError: MockInstance<typeof console.error>;

  beforeEach(() => {
    vi.resetAllMocks();
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
    vi.unstubAllEnvs();
  });

  it("logs a failed auto-approval by deduction id, error class and SQLSTATE, never the SQL or its parameters", async () => {
    vi.stubEnv("POST_CLASS_AUTO_APPROVE_ENABLED", "true");
    vi.mocked(applyPostClassReviewAction).mockRejectedValueOnce(driverError());

    const result = await runPostClassAutoApprovals(
      fakeDb([{ deductionId: "ded-1", version: 3 }]),
      new Date("2026-09-29T12:00:00.000Z"),
    );

    expect(result).toEqual({ approved: 0, failed: 1 });
    expect(consoleError.mock.calls).toEqual([[
      "[post-class-auto-approve]",
      { deductionId: "ded-1", errorName: "DrizzleQueryError", causeName: "NeonDbError", code: "40001" },
    ]]);
  });

  it("logs a failed ineligible waiver with the typed error's own message", async () => {
    vi.mocked(applyPostClassReviewAction).mockRejectedValueOnce(
      new PostClassConflictError("This record changed. Refresh and try again."),
    );

    const result = await runPostClassIneligibleWaivers(
      fakeDb([{ deductionId: "ded-2", version: 1, eligibilityReason: "cancelled" }]),
    );

    expect(result).toEqual({ waived: 0, failed: 1 });
    expect(consoleError.mock.calls).toEqual([[
      "[post-class-ineligible-waive]",
      { deductionId: "ded-2", errorName: "PostClassConflictError", message: "This record changed. Refresh and try again." },
    ]]);
  });

  it("logs a failed auto-reopen by deduction id, and a non-Error rejection as UnknownError", async () => {
    vi.mocked(loadCurrentDeductionEvidence).mockResolvedValueOnce(new Map() as never);
    vi.mocked(deductionEvidenceIssue).mockReturnValue("The session is no longer eligible for a deduction.");
    vi.mocked(hasWrittenPayoutDeduction).mockResolvedValue(false);
    vi.mocked(applyPostClassReviewAction)
      .mockRejectedValueOnce(new PostClassValidationError("Only approved deductions can be reopened."))
      .mockRejectedValueOnce("reopen rejected with a string");

    const result = await runPostClassAutoReopens(fakeDb([
      { deductionId: "ded-3", sessionId: "session-3", version: 2 },
      { deductionId: "ded-4", sessionId: "session-4", version: 5 },
    ]));

    expect(result).toEqual({ reopened: 0, failed: 2 });
    expect(consoleError.mock.calls).toEqual([
      ["[post-class-auto-reopen]", {
        deductionId: "ded-3",
        errorName: "PostClassValidationError",
        message: "Only approved deductions can be reopened.",
      }],
      ["[post-class-auto-reopen]", { deductionId: "ded-4", errorName: "UnknownError" }],
    ]);
  });
});
