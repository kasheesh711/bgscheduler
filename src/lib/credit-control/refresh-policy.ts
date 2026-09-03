import { ALERT_THRESHOLD } from "@/lib/credit-control/config";

// ── CRED-01: which (class, student) pairs must be re-read from Wise ──────
//
// `fetchSessionCredits` is one Wise GET per pair, issued for every pair on
// every run (931 of the ~1,265 calls a credit-control sync makes, 48 times a
// day). Wise rate-limits the institute, so the pairs nobody is looking at are
// carried forward from the previous snapshot instead of refetched.
//
// The rule is narrowed by BUSINESS RISK, not by change detection alone.
// Credits FALL through attendance, which the PAST session feed already tells
// us about for free, but they RISE through top-ups, for which Wise gives no
// signal at all. So a pure "did anything change" test is unsafe: a parent
// pays, the balance rises, and a stale low number would have us chase money
// already paid. What makes reuse safe instead is that every pair whose
// balance is low enough for a human to act on is refetched every run — only
// comfortable, quiet pairs are allowed to age.
//
// Consequence worth stating once: because attendance forces a refetch, a
// carried-forward balance can only ever be an UNDER-statement of the truth
// (the pair may have topped up since). Under-stating keeps a student in the
// worklist and can never drop them out of it, so reuse cannot cause a
// spurious `clearRecoveredActionStates` auto-clear (service.ts:109) or a
// spurious churn auto-removal (sync.ts applyChurnMaintenance). The one
// unguarded case is a manual credit deduction inside Wise, which emits no
// session and no signal; CREDIT_REFRESH_MAX_AGE_MINUTES bounds it.

/** Hours a comfortable pair's balance may age before it is refetched anyway. */
export const CREDIT_REFRESH_MAX_AGE_MINUTES_DEFAULT = 180;

/**
 * Margin over ALERT_THRESHOLD for the "hot" band. Deliberately derived from
 * the single alert constant rather than declared independently: the hot set
 * must stay a superset of every pair the worklist can escalate, and
 * `notify` is exactly `adjustedRemaining < ALERT_THRESHOLD`
 * (projection.ts:16,68). 3x leaves room for a pair to burn a couple of
 * classes before it lands in the band a human reads.
 */
export const CREDIT_HOT_BALANCE_MULTIPLIER = 3;

/** Balances below this are never carried forward. */
export const CREDIT_HOT_BALANCE_CREDITS = ALERT_THRESHOLD * CREDIT_HOT_BALANCE_MULTIPLIER;

/**
 * The previous snapshot's view of one pair. `pendingDeductionCredits` mirrors
 * `buildPendingDeductionContext` (packages.ts:156) so the hot test runs on the
 * same adjusted figure the dashboard renders, not on raw remaining.
 */
export interface PriorPairCredits {
  remainingCredits: number;
  pendingDeductionCredits: number;
  excludedReason: string | null;
  creditsObservedAt: Date;
}

export interface PairRefreshInput {
  /** Previous snapshot's row for this pair, or null when it is new/unreadable. */
  prior: PriorPairCredits | null;
  /** Whether THIS run's package name/subject still reads as excluded. */
  currentlyExcluded: boolean;
  /** Latest end instant among this pair's PAST-feed sessions this run, if any. */
  lastSessionEndAt: Date | null;
  now: Date;
  maxAgeMinutes: number;
}

export type PairRefreshAction = "refetch" | "reuse" | "skip";

export type PairRefreshReason =
  | "reuse-disabled"
  | "no-prior-row"
  | "excluded"
  | "low-balance"
  | "session-ended"
  | "stale"
  | "quiet";

export interface PairRefreshDecision {
  action: PairRefreshAction;
  reason: PairRefreshReason;
}

/**
 * Reads CREDIT_REFRESH_MAX_AGE_MINUTES. `0` is the feature off-switch — every
 * pair is refetched, exactly as before CRED-01. An unset value takes the
 * 180-minute default; anything unparseable or negative fails CLOSED to 0
 * (refetch everything) rather than silently granting a longer reuse window.
 */
export function getCreditRefreshMaxAgeMinutes(
  raw: string | undefined = process.env.CREDIT_REFRESH_MAX_AGE_MINUTES,
): number {
  if (raw === undefined || raw.trim() === "") return CREDIT_REFRESH_MAX_AGE_MINUTES_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

/**
 * The balance a human would see for this pair on the previous snapshot:
 * remaining minus the deductions still pending teacher feedback, clamped at
 * zero the way `buildDashboardStudents` (packages.ts:328) clamps it.
 */
export function priorAdjustedRemaining(prior: PriorPairCredits): number {
  return Math.max(0, prior.remainingCredits - prior.pendingDeductionCredits);
}

/**
 * Decides what this run does with one pair. Ordered so the safety conditions
 * win over the savings ones:
 *
 * 1. `maxAgeMinutes <= 0` — the off-switch; refetch everything.
 * 2. No prior row (new pair, or the prior snapshot could not be read) —
 *    refetch, because carrying nothing forward would mean writing zeroed
 *    credits, which reads as a drained balance and triggers false follow-up.
 * 3. Excluded on BOTH the prior row and this run's package name — no consumer
 *    ever reads these (db.ts:112, credit-bot.ts:240, credit-digest.ts:289),
 *    so skip the call outright. Requiring both sides means a package renamed
 *    out of the excluded keywords resumes being fetched.
 * 4. At or near the alert band — never reused, at any age.
 * 5. A session ended since the balance was last observed — attendance is the
 *    one way credits fall, and the PAST feed is already in hand this run.
 * 6. Older than the max age — bounds every unobservable movement (top-ups,
 *    manual Wise adjustments).
 */
export function decidePairRefresh({
  prior,
  currentlyExcluded,
  lastSessionEndAt,
  now,
  maxAgeMinutes,
}: PairRefreshInput): PairRefreshDecision {
  if (maxAgeMinutes <= 0) return { action: "refetch", reason: "reuse-disabled" };
  if (!prior) return { action: "refetch", reason: "no-prior-row" };
  if (currentlyExcluded && prior.excludedReason) return { action: "skip", reason: "excluded" };
  if (priorAdjustedRemaining(prior) < CREDIT_HOT_BALANCE_CREDITS) {
    return { action: "refetch", reason: "low-balance" };
  }
  if (lastSessionEndAt && lastSessionEndAt.getTime() >= prior.creditsObservedAt.getTime()) {
    return { action: "refetch", reason: "session-ended" };
  }
  if (now.getTime() - prior.creditsObservedAt.getTime() > maxAgeMinutes * 60_000) {
    return { action: "refetch", reason: "stale" };
  }
  return { action: "reuse", reason: "quiet" };
}
