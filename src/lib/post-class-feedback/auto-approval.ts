import "server-only";

import { and, eq, isNull, lte, ne, or } from "drizzle-orm";

import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";

import { applyPostClassReviewAction } from "./actions";
import { hasWrittenPayoutDeduction } from "./payout-repository";

// ── Continuous auto-approval and reopen sweep ───────────────────────────
//
// Neither sweep writes approval logic of its own. Every state change is
// driven through the existing `applyPostClassReviewAction`, which already
// does the finance lock, version check, `revalidateDeductionCandidate`,
// `assertApprovalPeriodOpen`, idempotency, and the audit-row insert -- this
// module only decides *which* deductions to hand it and tolerates one bad
// candidate without aborting the sweep.

/**
 * System actor for unattended auto-approve/reopen actions. It only ever
 * appears as the `actorEmail` on an audited `postClassDeductionActions` row
 * -- the same audit trail shape a human reviewer action produces.
 */
const SYSTEM_ACTOR = {
  email: "system:post-class-auto-approve",
  name: "Post-class Auto-Approval",
};

const DEFAULT_AUTO_APPROVE_GRACE_HOURS = 24;

/**
 * Auto-approval is opt-in and off by default (INC-260829). The armed accrual
 * cron once converted the entire pending_review backlog into sheet writes with
 * no human decision; approvals are now human-only unless this flag is an
 * explicit `"true"`. The reopen sweep is deliberately NOT behind this flag --
 * reopening restores safety, approving moves money.
 */
export function resolveAutoApproveEnabled(
  raw: string | undefined = process.env.POST_CLASS_AUTO_APPROVE_ENABLED,
): boolean {
  return raw?.trim() === "true";
}

/**
 * Resolve the auto-approval grace window from the environment, defaulting to
 * 24 hours whenever the value is absent, blank, non-numeric, or negative.
 *
 * The bare `Number(raw ?? 24)` it replaces had two live failure modes once
 * the accrual cron is scheduled: `""` coerces to `0` (immediate
 * auto-approval, no grace at all) and a value like `"24h"` coerces to `NaN`,
 * which poisons the deadline `Date` handed to the query. An explicit `"0"`
 * remains allowed -- that is a deliberate immediate-approval mode, distinct
 * from a blank or malformed value.
 */
export function resolveAutoApproveGraceHours(
  raw: string | undefined = process.env.POST_CLASS_AUTO_APPROVE_GRACE_HOURS,
): number {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_AUTO_APPROVE_GRACE_HOURS;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_AUTO_APPROVE_GRACE_HOURS;
}

/**
 * Approve every `pending_review` deduction whose grace period has elapsed on
 * a `live`-enforced, source-`ready` session.
 *
 * The grace window exists so a late-arriving Wise event that clears the
 * violation still wins before money moves.
 */
export async function runPostClassAutoApprovals(
  db: Database = getDb(),
  now: Date = new Date(),
): Promise<{ approved: number; failed: number }> {
  if (!resolveAutoApproveEnabled()) return { approved: 0, failed: 0 };
  const graceMs = resolveAutoApproveGraceHours() * 60 * 60 * 1_000;
  const deadline = new Date(now.getTime() - graceMs);
  const candidates = await db.select({
    deductionId: schema.postClassDeductions.id,
    version: schema.postClassDeductions.version,
  }).from(schema.postClassDeductions)
    .innerJoin(
      schema.postClassSessions,
      eq(schema.postClassDeductions.sessionId, schema.postClassSessions.id),
    )
    .where(and(
      eq(schema.postClassDeductions.status, "pending_review"),
      eq(schema.postClassSessions.enforcementMode, "live"),
      eq(schema.postClassSessions.sourceStatus, "ready"),
      lte(schema.postClassSessions.deadlineAt, deadline),
    ));

  let approved = 0;
  let failed = 0;
  for (const candidate of candidates) {
    try {
      await applyPostClassReviewAction(SYSTEM_ACTOR, {
        deductionId: candidate.deductionId,
        action: "approve",
        note: "Automated approval after the grace period.",
        expectedVersion: candidate.version,
        idempotencyKey: `auto-approve:${candidate.deductionId}`,
      }, db);
      approved += 1;
    } catch (error) {
      console.error("[post-class-auto-approve]", error);
      failed += 1;
    }
  }
  return { approved, failed };
}

/**
 * System actor for the unattended waivers below. Waiving RELEASES a money
 * claim -- the fail-safe direction -- so unlike the approve sweep it is not
 * env-gated.
 */
const INELIGIBLE_WAIVER_ACTOR = {
  email: "system:post-class-ineligible-waive",
  name: "Post-class Ineligible Waiver",
};

/**
 * Waive every `pending_review` deduction whose session is no longer eligible.
 *
 * A deduction candidate is only ever created for an eligible session, but a
 * class can be cancelled (or turn no-show / non-billable) in Wise AFTER the
 * candidate was raised. Such a deduction cannot stand -- and it must not sit
 * in the review queue demanding a human decision for a class that no longer
 * counts. The waiver note carries Wise's eligibility reason; a cancellation
 * gets its own category.
 */
export async function runPostClassIneligibleWaivers(
  db: Database = getDb(),
): Promise<{ waived: number; failed: number }> {
  const candidates = await db.select({
    deductionId: schema.postClassDeductions.id,
    version: schema.postClassDeductions.version,
    eligibilityReason: schema.postClassSessions.eligibilityReason,
  }).from(schema.postClassDeductions)
    .innerJoin(
      schema.postClassSessions,
      eq(schema.postClassDeductions.sessionId, schema.postClassSessions.id),
    )
    .where(and(
      eq(schema.postClassDeductions.status, "pending_review"),
      eq(schema.postClassSessions.eligible, false),
    ));

  let waived = 0;
  let failed = 0;
  for (const candidate of candidates) {
    const reason = candidate.eligibilityReason ?? "ineligible";
    try {
      await applyPostClassReviewAction(INELIGIBLE_WAIVER_ACTOR, {
        deductionId: candidate.deductionId,
        action: "waive",
        note: `Automated waiver: the session is no longer eligible (${reason}); `
          + "a deduction cannot stand on an ineligible class.",
        waiverCategory: reason === "cancelled" ? "class_cancelled" : "other",
        expectedVersion: candidate.version,
        idempotencyKey: `ineligible-waive:${candidate.deductionId}`,
      }, db);
      waived += 1;
    } catch (error) {
      console.error("[post-class-ineligible-waive]", error);
      failed += 1;
    }
  }
  return { waived, failed };
}

/**
 * Reopen every `approved`, not-yet-written deduction that has lost proof --
 * its session is no longer eligible, or its source is no longer `ready`.
 *
 * This is not optional housekeeping: `assertPayoutRunPublishable` hard-blocks
 * on `unprovenApprovedDeductions > 0` with no acknowledgement escape, so one
 * unproven approved deduction would otherwise stall all accrual. Mirrors the
 * exact predicate `computePayoutRunCoverage` uses for `unprovenApproved`
 * (`payout-repository.ts`), without its window filter -- this is a global
 * safety sweep, not scoped to one payout run.
 */
export async function runPostClassAutoReopens(
  db: Database = getDb(),
): Promise<{ reopened: number; failed: number }> {
  const candidates = await db.select({
    deductionId: schema.postClassDeductions.id,
    version: schema.postClassDeductions.version,
  }).from(schema.postClassDeductions)
    .innerJoin(
      schema.postClassSessions,
      eq(schema.postClassDeductions.sessionId, schema.postClassSessions.id),
    )
    .leftJoin(
      schema.postClassDeductionOffsets,
      eq(schema.postClassDeductionOffsets.deductionId, schema.postClassDeductions.id),
    )
    .where(and(
      eq(schema.postClassDeductions.status, "approved"),
      isNull(schema.postClassDeductionOffsets.id),
      or(
        eq(schema.postClassSessions.eligible, false),
        ne(schema.postClassSessions.sourceStatus, "ready"),
      ),
    ));

  let reopened = 0;
  let failed = 0;
  for (const candidate of candidates) {
    // A pre-filter only -- `applyPostClassReviewAction`'s reopen branch
    // already refuses a written deduction. Skipping here just avoids a
    // guaranteed-failing call.
    if (await hasWrittenPayoutDeduction(db, candidate.deductionId)) continue;
    try {
      await applyPostClassReviewAction(SYSTEM_ACTOR, {
        deductionId: candidate.deductionId,
        action: "reopen",
        note: "Automated reopen: proof lost before the payout write.",
        expectedVersion: candidate.version,
        idempotencyKey: `auto-reopen:${candidate.deductionId}`,
      }, db);
      reopened += 1;
    } catch (error) {
      console.error("[post-class-auto-reopen]", error);
      failed += 1;
    }
  }
  return { reopened, failed };
}

/**
 * Single entry point the accrual/finalize passes call before every preview.
 *
 * Reopen runs first: a deduction reopened this tick must not simultaneously
 * be treated as a stale `approved` row by the approve sweep in the same tick
 * -- and a reopened ineligible deduction is then waived by the ineligible
 * sweep in this very tick rather than lingering in the review queue.
 */
export async function runPostClassAutoApprovalSweep(
  db: Database = getDb(),
  now: Date = new Date(),
): Promise<{
  approved: number;
  approveFailed: number;
  reopened: number;
  reopenFailed: number;
  waived: number;
  waiveFailed: number;
}> {
  const hygiene = await runPostClassDeductionHygiene(db);
  const approveResult = await runPostClassAutoApprovals(db, now);
  return {
    approved: approveResult.approved,
    approveFailed: approveResult.failed,
    ...hygiene,
  };
}

/**
 * The safety-restoring half of the sweep, with no approve leg: reopen
 * unproven approvals, then waive deductions on no-longer-eligible sessions.
 * Runs on every collection tick (sync-post-class-feedback route) so a class
 * cancelled in Wise clears its own review item within a sync cycle, without
 * any payout pass involved.
 */
export async function runPostClassDeductionHygiene(
  db: Database = getDb(),
): Promise<{
  reopened: number;
  reopenFailed: number;
  waived: number;
  waiveFailed: number;
}> {
  const reopenResult = await runPostClassAutoReopens(db);
  const waiveResult = await runPostClassIneligibleWaivers(db);
  return {
    reopened: reopenResult.reopened,
    reopenFailed: reopenResult.failed,
    waived: waiveResult.waived,
    waiveFailed: waiveResult.failed,
  };
}
