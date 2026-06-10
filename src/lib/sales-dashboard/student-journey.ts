import type { CoverageWindow } from "./types";

// ————————————————————————————————————————————————————————————————————————————
// Student-journey coverage-window timeline. Pure; runs client-side in the
// StudentDetailPanel over fetched slim transactions. Rendered with the
// --available / --blocked tokens (covered/open vs gap).
// ————————————————————————————————————————————————————————————————————————————

export interface CoverageTransactionInput {
  date: string;
  validUntil: string | null;
}

/**
 * Chain a student's paid transactions into coverage windows on `validUntil`.
 *
 * 1. Only transactions with a `validUntil` participate (trials and additional
 *    rows carry none).
 * 2. Each participating transaction opens a window `date → validUntil`.
 * 3. When the next participating transaction starts after the current window
 *    ends, a `gap` window `validUntil → next.date` is inserted between them.
 * 4. The final window is `open` when its `validUntil` is on/after `today`;
 *    every other purchase window is `covered`.
 */
export function buildCoverageWindows(
  transactions: CoverageTransactionInput[],
  today: string,
): CoverageWindow[] {
  const covered = transactions
    .filter((txn): txn is CoverageTransactionInput & { validUntil: string } => Boolean(txn.validUntil))
    .sort((left, right) => left.date.localeCompare(right.date) || left.validUntil.localeCompare(right.validUntil));

  const windows: CoverageWindow[] = [];
  covered.forEach((txn, index) => {
    const isLast = index === covered.length - 1;
    windows.push({
      from: txn.date,
      until: txn.validUntil,
      status: isLast && txn.validUntil >= today ? "open" : "covered",
    });
    if (!isLast) {
      const next = covered[index + 1];
      if (next.date > txn.validUntil) {
        windows.push({ from: txn.validUntil, until: next.date, status: "gap" });
      }
    }
  });

  return windows;
}
