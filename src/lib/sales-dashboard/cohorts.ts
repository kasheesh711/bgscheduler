import { addDaysIso } from "./dates";
import type { StudentLiveStatus } from "./types";

// ————————————————————————————————————————————————————————————————————————————
// Shared cohort decision helpers — extracted from analytics.ts (trial/retention
// cohorts) so dimensions.ts and analytics.ts apply identical rules.
// ————————————————————————————————————————————————————————————————————————————

/** Minimal row shape the cohort helpers operate on. */
export interface CohortRow {
  paymentDate: string;
  enrollmentType: string;
  validUntil: string | null;
}

/**
 * Canonical rep grouping key: trim, lowercase, collapse internal whitespace.
 * Applied identically in aggregation and transaction filtering so drill keys
 * always match.
 */
export function normalizeRepKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Canonical student grouping key: trim, lowercase, collapse internal
 * whitespace. Matches the nickname-identity caveat — distinct spellings of the
 * same nickname collapse to one key.
 */
export function normalizeStudentKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Renewal decision deadline: validUntil + 14-day grace window. */
export function decisionDateFor(validUntil: string): string {
  return addDaysIso(validUntil, 14);
}

/**
 * First "New Student" row strictly after the given trial date, in
 * payment-date order. Mirrors the trial-cohort conversion rule extracted from
 * analytics.ts — returns null when the trial never converted.
 */
export function findConversion<T extends Pick<CohortRow, "paymentDate" | "enrollmentType">>(
  sortedRows: T[],
  trialDate: string,
): T | null {
  return sortedRows.find((row) => row.enrollmentType === "New Student" && row.paymentDate > trialDate) ?? null;
}

export interface LiveStatusResult {
  status: StudentLiveStatus;
  latestValidUntil: string | null;
  decisionDate: string | null;
}

/**
 * Live-recomputed student status using the validUntil+14d rule — never the
 * stored churn_status (which is frozen at import time and goes stale).
 *
 * 1. No paid (non-Trial) rows → "Trial-only".
 * 2. Latest paid row has no validUntil → "Pending" (cannot judge coverage).
 * 3. decisionDate (validUntil + 14d) >= today → "Active".
 * 4. Any payment strictly after decisionDate → "Retained".
 * 5. Otherwise → "Churned".
 */
export function computeLiveStatus(rows: CohortRow[], today: string): LiveStatusResult {
  const sorted = [...rows].sort((left, right) => left.paymentDate.localeCompare(right.paymentDate));
  const paid = sorted.filter((row) => row.enrollmentType !== "Trial");
  if (paid.length === 0) {
    return { status: "Trial-only", latestValidUntil: null, decisionDate: null };
  }

  const latestPaid = paid[paid.length - 1];
  if (!latestPaid.validUntil) {
    return { status: "Pending", latestValidUntil: null, decisionDate: null };
  }

  const decisionDate = decisionDateFor(latestPaid.validUntil);
  if (decisionDate >= today) {
    return { status: "Active", latestValidUntil: latestPaid.validUntil, decisionDate };
  }

  const renewedAfterDeadline = sorted.some((row) => row.paymentDate > decisionDate);
  return {
    status: renewedAfterDeadline ? "Retained" : "Churned",
    latestValidUntil: latestPaid.validUntil,
    decisionDate,
  };
}
