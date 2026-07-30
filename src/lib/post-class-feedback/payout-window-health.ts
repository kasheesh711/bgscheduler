import "server-only";

import { getCronJobDefinition } from "@/lib/data-health/cron-registry";
import { getDb, type Database } from "@/lib/db";

import {
  findOldestUnfinalizedPayoutRun,
  getPayoutRunByAnchor,
} from "./payout-repository";
import { lastEndedPayoutRunWindow, payoutBangkokDate } from "./payout-window";

// ── Stale payout window detection ───────────────────────────────────────
//
// `runPayoutFinalizePass` keeps retrying an un-finalized window forever, so
// a window that never reaches `published` no longer disappears -- but a
// permanently retrying pass is still invisible. This check turns that into a
// signal the cron watchdog can alert on.
//
// Threshold: a window is stale once the calendar month it is anchored to has
// itself ended. Anchor month M covers M-1-26 through M-25, so finalize has
// the 26th through the last day of M to succeed on its own; only once M+1
// arrives does an un-finalized M mean something is actually wrong.

/** Registry key of the accrual/finalize cron this check speaks for. */
export const PAYOUT_ACCRUAL_JOB_KEY = "post_class_feedback_payout_accrual";

export interface PayoutWindowStaleness {
  stale: boolean;
  /** The window in question, `YYYY-MM`; null only when nothing has ended yet. */
  anchorMonth: string | null;
  windowEnd: string | null;
  /** The run's status, or null when no run row was ever created for it. */
  runStatus: string | null;
  detail: string;
}

/**
 * Decide whether a payout window has been left un-finalized past its month
 * end (pure).
 *
 * Two ways a window goes stale:
 * - a run row exists but never reached `published`/`closed` -- finalize has
 *   been retrying and failing;
 * - no run row exists at all for the window that most recently ended, so
 *   finalize's clock-derived branch never even got far enough to create one
 *   (a source sync holding its lane every tick, a Google scope failure, or a
 *   coverage gate) and, being clock-derived, it has now stopped trying.
 */
export function classifyPayoutWindowStaleness(input: {
  /** Today in Bangkok, `YYYY-MM-DD`. */
  today: string;
  /** Oldest ended run still short of published/closed, if any. */
  pendingRun: { anchorMonth: string; windowEnd: string; status: string } | null;
  /** The most recently ended window, and whether any run row exists for it. */
  lastEnded: { anchorMonth: string; windowEnd: string; exists: boolean };
}): PayoutWindowStaleness {
  const currentMonth = input.today.slice(0, 7);
  const pending = input.pendingRun;
  if (pending && pending.anchorMonth < currentMonth) {
    return {
      stale: true,
      anchorMonth: pending.anchorMonth,
      windowEnd: pending.windowEnd,
      runStatus: pending.status,
      detail: `Payout window ${pending.anchorMonth} (ended ${pending.windowEnd}) is still ${pending.status}; the automated finalize pass has not been able to publish it.`,
    };
  }
  if (!pending && !input.lastEnded.exists && input.lastEnded.anchorMonth < currentMonth) {
    return {
      stale: true,
      anchorMonth: input.lastEnded.anchorMonth,
      windowEnd: input.lastEnded.windowEnd,
      runStatus: null,
      detail: `Payout window ${input.lastEnded.anchorMonth} (ended ${input.lastEnded.windowEnd}) has no payout run at all; nothing finalized it before its month ended.`,
    };
  }
  return {
    stale: false,
    anchorMonth: pending?.anchorMonth ?? input.lastEnded.anchorMonth,
    windowEnd: pending?.windowEnd ?? input.lastEnded.windowEnd,
    runStatus: pending?.status ?? null,
    detail: pending
      ? `Payout window ${pending.anchorMonth} is ${pending.status}; the finalize pass still has this month to publish it.`
      : `Payout window ${input.lastEnded.anchorMonth} is finalized.`,
  };
}

/**
 * Load the staleness verdict for the current instant, or `null` when the
 * accrual cron is parked.
 *
 * The parked gate is load-bearing, not defensive: while the route has no
 * schedule nothing is finalizing windows by design (payout writes are also
 * off in production), so alerting would be pure noise. The check arms itself
 * automatically the moment the registry entry gains a schedule.
 */
export async function loadPayoutWindowStaleness(
  db: Database = getDb(),
  now: Date = new Date(),
): Promise<PayoutWindowStaleness | null> {
  if (!getCronJobDefinition(PAYOUT_ACCRUAL_JOB_KEY)?.schedule) return null;
  const today = payoutBangkokDate(now);
  const pending = await findOldestUnfinalizedPayoutRun(db, { bangkokDate: today });
  const lastEnded = lastEndedPayoutRunWindow(today);
  const lastEndedRun = await getPayoutRunByAnchor(db, lastEnded.anchorMonth);
  return classifyPayoutWindowStaleness({
    today,
    pendingRun: pending
      ? {
        anchorMonth: pending.anchorMonth.slice(0, 7),
        windowEnd: pending.windowEnd,
        status: pending.status,
      }
      : null,
    lastEnded: {
      anchorMonth: lastEnded.anchorMonth,
      windowEnd: lastEnded.windowEnd,
      exists: lastEndedRun !== null,
    },
  });
}
