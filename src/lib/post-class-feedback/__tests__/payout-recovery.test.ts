import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { payoutGoogleHealth } from "../payout-google-health";
import { payoutJobResponse, runPayoutAccrualPass, runPayoutFinalizePass } from "../payout-accrual";
import { PostClassConflictError } from "../errors";
import type { Database } from "@/lib/db";
import type { PayoutRunView } from "../payout-run";

afterEach(() => vi.unstubAllEnvs());
const token = {
  scope: "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file",
  accessTokenCiphertext: "encrypted", refreshTokenCiphertext: "encrypted", lastError: null,
};
describe("payout recovery controls", () => {
  it("requires reconnect for revoked or nonrenewable credentials despite existing scopes", () => {
    expect(payoutGoogleHealth({ ...token, lastError: "Token has been expired or revoked." }).reconnectRequired).toBe(true);
    expect(payoutGoogleHealth({ ...token, refreshTokenCiphertext: null }).reconnectRequired).toBe(true);
    expect(payoutGoogleHealth(token).reconnectRequired).toBe(false);
    expect(payoutGoogleHealth({ ...token, lastError: "Temporary service outage" }).reconnectRequired).toBe(false);
  });
  it("pauses both automation passes before any database or external operation", async () => {
    vi.stubEnv("POST_CLASS_PAYOUT_AUTOMATION_PAUSED", "true");
    const db = new Proxy({}, { get: () => { throw new Error("Unexpected database operation while paused"); } }) as Database;
    expect(await runPayoutAccrualPass(db)).toEqual({ skipped: "automation-paused" });
    expect(await runPayoutFinalizePass(db)).toEqual({ skipped: "automation-paused" });
  });
  it("does not classify arbitrary finance conflicts as transient", () => {
    expect(new PostClassConflictError("Written amount changed").retryableReason).toBeUndefined();
    expect(new PostClassConflictError("Sync active", "sync_active").retryableReason).toBe("sync_active");
  });
  it("surfaces incomplete writes and finalize failures to the cron auditor", () => {
    const view = { stoppedEarly: false, csvError: null, exceptions: [], adjustments: [], lines: [], run: { status: "partial" } } as unknown as PayoutRunView;
    expect(payoutJobResponse(view, { skipped: "window-not-ended" }).ok).toBe(true);
    expect(payoutJobResponse({ ...view, stoppedEarly: true }, { skipped: "window-not-ended" }).ok).toBe(false);
    expect(payoutJobResponse({ skipped: "nothing-pending" }, view).ok).toBe(false);
    expect(payoutJobResponse({ skipped: "automation-paused" }, { skipped: "automation-paused" }).skipped).toBe(true);
  });

  // The cron auditor maps an error containing "already running" to `skipped`,
  // so the job's error text must avoid it.
  function errorOf(response: ReturnType<typeof payoutJobResponse>): string {
    return (response as { error?: string }).error ?? "";
  }
  const cleanView = {
    stoppedEarly: false, csvError: null, exceptions: [], adjustments: [], lines: [], run: { status: "partial" },
  } as unknown as PayoutRunView;
  const publishedView = { ...cleanView, run: { status: "published" } } as unknown as PayoutRunView;

  // FU4: approvals `selectPayoutRunCandidates` silently drops for failing the
  // current-evidence check must not vanish; they fail the job, not the publish.
  it("fails the job when approved deductions are excluded for lost evidence", () => {
    const accrualExcluded = payoutJobResponse(
      { skipped: "nothing-pending", evidenceExcludedApproved: 2 },
      { skipped: "window-not-ended" },
    );
    expect(accrualExcluded.ok).toBe(false);
    expect(errorOf(accrualExcluded)).toContain("2 approved deduction(s) are excluded");
    expect(errorOf(accrualExcluded)).not.toMatch(/already running/iu);

    // A cleanly published finalize is otherwise a success...
    expect(payoutJobResponse(cleanView, publishedView).ok).toBe(true);
    // ...until its window still holds an evidence-excluded approval.
    const finalizeExcluded = payoutJobResponse(
      cleanView,
      { ...publishedView, evidenceExcludedApproved: 1 },
    );
    expect(finalizeExcluded.ok).toBe(false);
    expect(errorOf(finalizeExcluded)).toContain("1 approved deduction(s) are excluded");
  });

  it("fails the job when the evidence-exclusion check itself could not run", () => {
    const response = payoutJobResponse(
      { skipped: "nothing-pending", evidenceExclusionCheckFailed: true },
      { skipped: "window-not-ended" },
    );
    expect(response.ok).toBe(false);
    expect(errorOf(response)).toContain("evidence-exclusion check could not run");
    expect(errorOf(response)).not.toMatch(/already running/iu);
  });
});
