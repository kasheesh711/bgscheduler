import "server-only";

import { getDb, type Database } from "@/lib/db";

import type { PostClassUser } from "./access";
import { runPostClassAutoApprovalSweep } from "./auto-approval";
import { PostClassConflictError } from "./errors";
import type { PayoutPublishAcknowledgements } from "./payout-plan";
import {
  previewPayoutRun,
  publishPayoutRun,
  type PayoutRunDependencies,
  type PayoutRunView,
} from "./payout-run";
import { payoutBangkokDate, payoutRunWindow, payoutRunWindowForBangkokDate } from "./payout-window";

// ── Continuous payout accrual and automated finalize ────────────────────
//
// Neither pass reimplements publish; both call it. This module only decides
// *when* to call it and with which mode -- the append primitive, the durable
// lease, the source-anchor claim, and the CSV/finalize logic all live in
// payout-run.ts / payout-repository.ts and are reused verbatim.

/**
 * System actor for the unattended accrual/finalize passes. Every write still
 * goes through `publishPayoutRun`, so this only ever appears as the acting
 * email on the same audited run/line/exception rows a human operator publish
 * would produce.
 */
const SYSTEM_ACTOR: PostClassUser = {
  email: "system:post-class-payout-accrual",
  name: "Post-class Payout Accrual",
  role: "admin",
  capabilities: ["viewer", "reviewer", "finance", "access_manager"],
};

/** Every obligation this preview knows about is already durably written. */
function isEverythingAlreadyWritten(view: PayoutRunView): boolean {
  return view.lines.every((line) => line.persisted && line.writeStatus === "written")
    && view.adjustments.every((adjustment) => adjustment.status === "written");
}

/**
 * Feed the pass's own simulated clock into `publishPayoutRun`'s clock too,
 * unless the caller already supplied one. Production never passes a custom
 * `now`, so this has no effect there; it only prevents the pass's `now` and
 * `publishPayoutRun`'s internal `operationNow` from silently disagreeing
 * about the current instant (e.g. in a test that simulates a specific
 * mid-window or post-window moment).
 */
function dependenciesWithClock(
  dependencies: PayoutRunDependencies,
  now: Date,
): PayoutRunDependencies {
  return {
    ...dependencies,
    now: dependencies.now ?? (() => now.getTime()),
  };
}

/**
 * Append this tick's approved, ready obligations to the master ledger.
 *
 * Runs the auto-approval/reopen sweep first: `publishPayoutRun` only ever
 * selects `status = 'approved'` deductions, so nothing is writable until the
 * reopen-then-approve sweep has run, and the reopen half is what keeps
 * `assertPayoutRunPublishable`'s hard `unprovenApprovedDeductions` gate at 0
 * every tick. Publishes in `mode: "accrual"`, so this can never mint
 * `published` and never touches the CSV/Drive leg.
 */
export async function runPayoutAccrualPass(
  db: Database = getDb(),
  dependencies: PayoutRunDependencies = {},
  now: Date = new Date(),
): Promise<{ skipped: string } | PayoutRunView> {
  await runPostClassAutoApprovalSweep(db, now);
  const window = payoutRunWindowForBangkokDate(payoutBangkokDate(now));
  const view = await previewPayoutRun(SYSTEM_ACTOR, {
    anchorMonth: window.anchorMonth,
    tutorFilter: null,
  }, db);
  if (isEverythingAlreadyWritten(view)) {
    return { skipped: "nothing-pending" };
  }
  const acknowledgements: PayoutPublishAcknowledgements = {
    confirmed: true,
    pendingReviewDeductions: view.coverage.pendingReviewDeductions,
    nonReadySessions: view.coverage.nonReadySessions,
    reason: "Scheduled payout accrual pass.",
  };
  try {
    return await publishPayoutRun(SYSTEM_ACTOR, {
      anchorMonth: window.anchorMonth,
      previewToken: view.previewToken,
      acknowledgements,
      expectedVersion: view.run.version,
      mode: "accrual",
    }, db, dependenciesWithClock(dependencies, now));
  } catch (error) {
    // Source sync holding its lane, a lease already held, or a stale
    // token/version are all expected and simply retry next tick.
    if (error instanceof PostClassConflictError) {
      console.error("[payout-accrual]", error.message);
      return { skipped: error.message };
    }
    throw error;
  }
}

/**
 * Append any remainder and reach `published` once the window has ended and
 * coverage is clean.
 *
 * Deliberately **not** `payoutRunWindowForBangkokDate(payoutBangkokDate(now))`
 * -- that resolves "the window containing `now`", which by construction
 * always satisfies `now <= windowEnd` (it rolls the anchor forward once the
 * 25th passes), so that comparison would be a tautology and this pass could
 * never proceed. Finalize instead targets `now`'s own Bangkok calendar month
 * as the anchor: once the 26th arrives, that anchor's own window (26th of
 * the prior month through the 25th of this one) has provably just ended,
 * and stays targeted for the rest of this calendar month so a transient
 * failure keeps retrying the same window until the next month rolls the
 * anchor forward.
 *
 * No `mode` is passed: finalize only ever runs after `windowEnd`, so the
 * unmodified operator-mode window guard never blocks it, and CSV upload
 * stays enabled exactly like today's manual publish. A source-fingerprint
 * race against the hourly external refresh naturally yields `status:
 * "partial"` from the existing `finalizePayoutRunPass` logic -- nothing new
 * to do for that case; the next invocation retries.
 */
export async function runPayoutFinalizePass(
  db: Database = getDb(),
  dependencies: PayoutRunDependencies = {},
  now: Date = new Date(),
): Promise<{ skipped: string } | PayoutRunView> {
  const window = payoutRunWindow(payoutBangkokDate(now).slice(0, 7));
  if (payoutBangkokDate(now) <= window.windowEnd) {
    return { skipped: "window-not-ended" };
  }
  await runPostClassAutoApprovalSweep(db, now);
  const view = await previewPayoutRun(SYSTEM_ACTOR, {
    anchorMonth: window.anchorMonth,
    tutorFilter: null,
  }, db);
  const acknowledgements: PayoutPublishAcknowledgements = {
    confirmed: true,
    pendingReviewDeductions: view.coverage.pendingReviewDeductions,
    nonReadySessions: view.coverage.nonReadySessions,
    reason: "Scheduled payout finalize pass.",
  };
  try {
    return await publishPayoutRun(SYSTEM_ACTOR, {
      anchorMonth: window.anchorMonth,
      previewToken: view.previewToken,
      acknowledgements,
      expectedVersion: view.run.version,
    }, db, dependenciesWithClock(dependencies, now));
  } catch (error) {
    if (error instanceof PostClassConflictError) {
      console.error("[payout-finalize]", error.message);
      return { skipped: error.message };
    }
    throw error;
  }
}
