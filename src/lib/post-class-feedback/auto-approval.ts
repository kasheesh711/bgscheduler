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

function autoApproveGraceHours(): number {
  return Number(process.env.POST_CLASS_AUTO_APPROVE_GRACE_HOURS ?? 24);
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
  const graceMs = autoApproveGraceHours() * 60 * 60 * 1_000;
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
 * be treated as a stale `approved` row by the approve sweep in the same tick.
 */
export async function runPostClassAutoApprovalSweep(
  db: Database = getDb(),
  now: Date = new Date(),
): Promise<{
  approved: number;
  approveFailed: number;
  reopened: number;
  reopenFailed: number;
}> {
  const reopenResult = await runPostClassAutoReopens(db);
  const approveResult = await runPostClassAutoApprovals(db, now);
  return {
    approved: approveResult.approved,
    approveFailed: approveResult.failed,
    reopened: reopenResult.reopened,
    reopenFailed: reopenResult.failed,
  };
}
