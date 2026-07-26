import {
  addBangkokDays,
  bangkokDateStartUtc,
  monthStart,
  nextMonthStart,
  todayBangkok,
} from "@/lib/room-capacity/dates";

// ── Payout run windows ──────────────────────────────────────────────────
//
// Tutor payouts run 26th → 25th, not on calendar months. A run anchored to
// "2026-07" covers 2026-06-26 through 2026-07-25 inclusive, matching the
// START DATE / END DATE on the tutor payout sheets.
//
// Finance periods remain calendar months: they gate approval and month
// close. A payout run is a separate selection and export window layered on
// top, so one run legitimately spans two finance months.

export interface PayoutRunWindow {
  /** Anchor month, `YYYY-MM`. The run ends on the 25th of this month. */
  anchorMonth: string;
  /** Inclusive Bangkok start date, `YYYY-MM-DD` — the 26th of the prior month. */
  windowStart: string;
  /** Inclusive Bangkok end date, `YYYY-MM-DD` — the 25th of the anchor month. */
  windowEnd: string;
}

const ANCHOR_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/u;

export function assertPayoutAnchorMonth(anchorMonth: string): string {
  if (!ANCHOR_PATTERN.test(anchorMonth)) {
    throw new Error("Payout run month must be YYYY-MM.");
  }
  return anchorMonth;
}

/**
 * Resolve the 26th→25th Bangkok window for an anchor month.
 *
 * The start is derived by stepping one day back from the anchor month's 1st,
 * so month lengths and leap years fall out of the shared Bangkok date
 * arithmetic rather than being special-cased here.
 */
export function payoutRunWindow(anchorMonth: string): PayoutRunWindow {
  assertPayoutAnchorMonth(anchorMonth);
  const priorMonth = monthStart(addBangkokDays(`${anchorMonth}-01`, -1));
  return {
    anchorMonth,
    windowStart: `${priorMonth.slice(0, 7)}-26`,
    windowEnd: `${anchorMonth}-25`,
  };
}

/**
 * The run an admin is most likely working on right now. On or after the
 * 26th the current month's run has closed, so the anchor rolls forward.
 */
export function currentPayoutRunWindow(now = new Date()): PayoutRunWindow {
  const today = todayBangkok(now);
  const day = Number(today.slice(8, 10));
  const anchor = day >= 26
    ? nextMonthStart(monthStart(today)).slice(0, 7)
    : today.slice(0, 7);
  return payoutRunWindow(anchor);
}

/** Inclusive-start, exclusive-end UTC instants for querying `scheduledEndAt`. */
export function payoutRunRangeUtc(window: PayoutRunWindow): { start: Date; endExclusive: Date } {
  return {
    start: bangkokDateStartUtc(window.windowStart),
    endExclusive: bangkokDateStartUtc(addBangkokDays(window.windowEnd, 1)),
  };
}
