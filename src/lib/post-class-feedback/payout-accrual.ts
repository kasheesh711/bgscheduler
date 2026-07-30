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
import { findOldestUnfinalizedPayoutRun } from "./payout-repository";
import {
  payoutBangkokDate,
  payoutRunWindow,
  payoutRunWindowForBangkokDate,
  type PayoutRunWindow,
} from "./payout-window";

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
 * Which ended window this finalize tick owes work to, or `null` when none
 * does.
 *
 * 1. The oldest persisted run whose window has ended and that has not reached
 *    `published`/`closed`. This is the durable half: a window that failed to
 *    finalize stays selected until it succeeds, however many months pass.
 * 2. Otherwise the window anchored to `now`'s own Bangkok calendar month,
 *    behind the original `now <= windowEnd` guard. Deliberately **not**
 *    `payoutRunWindowForBangkokDate` -- that resolves "the window containing
 *    `now`", which by construction always satisfies `now <= windowEnd`, so
 *    the comparison would be a tautology and this branch could never proceed.
 *    Anchoring to the calendar month means the 26th is the first day this can
 *    fire, which is exactly when that anchor's own window has just ended.
 *
 *    This is the only branch that can target a window with no run row, since
 *    `publishPayoutRun` creates the row; keeping it clock-derived is what
 *    stops the pass from minting an empty `published` run for some older
 *    window the system never observed. A window that ends up with no run row
 *    *and* no successful finalize before its month is out is surfaced by
 *    `classifyPayoutWindowStaleness` instead of being auto-published.
 */
async function resolveFinalizeWindow(
  db: Database,
  today: string,
): Promise<PayoutRunWindow | null> {
  const pending = await findOldestUnfinalizedPayoutRun(db, { bangkokDate: today });
  if (pending) return payoutRunWindow(pending.anchorMonth.slice(0, 7));
  const window = payoutRunWindow(today.slice(0, 7));
  return today > window.windowEnd ? window : null;
}

/**
 * Append any remainder and reach `published` once the window has ended and
 * coverage is clean.
 *
 * Targets the oldest un-finalized ended window rather than whichever window
 * `now`'s calendar month happens to name (see `resolveFinalizeWindow`), so a
 * finalize that fails for the whole 26th-to-month-end stretch is retried in
 * M+1 instead of silently falling back to a manual operator publish -- which
 * would also keep the roll CLI's strict-close preflight blocked on
 * `not_published` and land the next period's accrued rows in a workbook still
 * pointed at the old window.
 *
 * Idempotent and safe hourly: the selector excludes `published`/`closed`, so a
 * finished window is never re-published, and every conflict (lease held,
 * source sync active, stale token/version) returns as a skip for the next
 * tick.
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
  const window = await resolveFinalizeWindow(db, payoutBangkokDate(now));
  if (!window) {
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
