import "server-only";

import { getDb, type Database } from "@/lib/db";
import { addBangkokDays } from "@/lib/room-capacity/dates";

import type { PostClassUser } from "./access";
import {
  runPostClassAutoApprovalSweep,
  runPostClassDeductionHygiene,
} from "./auto-approval";
import { PostClassConflictError } from "./errors";
import { PAYOUT_AUTO_CHARGE_FLOOR_BANGKOK } from "./payout-config";
import type { PayoutPublishAcknowledgements } from "./payout-plan";
import { runPayoutLedgerRetirement } from "./payout-retirement";
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

/**
 * Bangkok days a window must have been over before the unattended finalize
 * may adopt it. The feedback deadline is 23:59:59 Bangkok two days after the
 * class date, so the last classes of a window (the 24th/25th) can still
 * produce brand-new proven violations through the 27th; flags also need the
 * activity mirror's next sync to prove themselves. Finalizing on the 26th
 * would strand those stragglers as approved-but-unwritten on a `published`
 * run, so the pass waits out the full settlement tail instead.
 */
const PAYOUT_SETTLEMENT_LAG_BANGKOK_DAYS = 3;

/** Every obligation this preview knows about is already durably written. */
function isEverythingAlreadyWritten(view: PayoutRunView): boolean {
  return view.lines.every((line) => line.persisted && line.writeStatus === "written")
    && view.adjustments.every((adjustment) =>
      adjustment.status === "written" || adjustment.status === "superseded");
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
  // Auto-un-charge before planning: rows whose violation cleared (or whose
  // class became ineligible) leave the ledger by deletion, so the publish
  // below never nets a +฿100 correction against them. A retirement failure
  // is deliberately non-fatal — the old netting path still self-corrects,
  // and the deleted pair is cleaned up on a later tick.
  try {
    const retirement = await runPayoutLedgerRetirement(db, {
      now,
      sheetOps: dependencies.retirementSheetOps,
      resolveGoogleTarget: dependencies.resolveGoogleTarget
        ? () => dependencies.resolveGoogleTarget!({ forWrite: false })
        : undefined,
    });
    if (retirement.retiredLines > 0) {
      // The freshly retired lines now read as unwritten, so the reopen and
      // ineligible-waive sweeps can finish those deductions' lifecycles in
      // this very tick instead of the next one.
      await runPostClassDeductionHygiene(db);
    }
  } catch (error) {
    console.error("[payout-accrual] retirement pass failed", error);
  }
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
  // Both branches see the clock shifted back by the settlement lag: a window
  // only becomes adoptable once `windowEnd` is that many Bangkok days in the
  // past, and the automation floor keeps the pre-automation (INC-260829-era)
  // windows an operator decision forever.
  const settledCutoff = addBangkokDays(today, -PAYOUT_SETTLEMENT_LAG_BANGKOK_DAYS);
  const pending = await findOldestUnfinalizedPayoutRun(db, {
    bangkokDate: settledCutoff,
    windowStartAtOrAfter: PAYOUT_AUTO_CHARGE_FLOOR_BANGKOK,
  });
  if (pending) return payoutRunWindow(pending.anchorMonth.slice(0, 7));
  const window = payoutRunWindow(today.slice(0, 7));
  return window.windowStart >= PAYOUT_AUTO_CHARGE_FLOOR_BANGKOK
    && settledCutoff > window.windowEnd
    ? window
    : null;
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
