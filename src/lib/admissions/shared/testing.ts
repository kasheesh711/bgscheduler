// Admissions Case Management — client-safe test-type constants and the pure
// registration-deadline derivation.
//
// Pure module: no database, audit, or server-only imports — safe to import
// from "use client" components. The db-facing testing.ts re-exports these
// symbols so existing lib/route/test consumers keep their import paths.
//
// Design: docs/casemanagementsystem_design.md — PRD CM-80 (test sittings,
// registration-deadline auto-derivation).

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_IN_MS = 86_400_000;

/** Standardized test type (mirrors admissions_test_type). */
export type AdmissionsTestType =
  | "sat"
  | "act"
  | "ap"
  | "ib"
  | "toefl"
  | "ielts"
  | "other";

/** All valid test types, in canonical display order. */
export const ADMISSIONS_TEST_TYPES: readonly AdmissionsTestType[] = [
  "sat",
  "act",
  "ap",
  "ib",
  "toefl",
  "ielts",
  "other",
];

/** Type guard: is `value` a known admissions test type? */
export function isAdmissionsTestType(value: string): value is AdmissionsTestType {
  return ADMISSIONS_TEST_TYPES.includes(value as AdmissionsTestType);
}

/** Display label per test type (calendar titles, best-score chips). */
export const ADMISSIONS_TEST_TYPE_LABELS: Record<AdmissionsTestType, string> = {
  sat: "SAT",
  act: "ACT",
  ap: "AP",
  ib: "IB",
  toefl: "TOEFL",
  ielts: "IELTS",
  other: "Other test",
};

/**
 * Days between a test's registration deadline and its test date, per test
 * type (CM-80 auto-derivation):
 *
 * - SAT / ACT: regular registration closes ≈ 5 weeks before the sitting →
 *   35 days.
 * - AP / IB: exam registration is school-managed (no student-facing
 *   deadline) → null, no deadline derived.
 * - TOEFL / IELTS: seat booking typically closes ≈ 2 weeks before the test
 *   → 14 days.
 * - other: unknown test family → null (fail-closed — a deadline is never
 *   guessed; counselors can set one explicitly via update).
 */
export const REGISTRATION_LEAD_DAYS: Record<AdmissionsTestType, number | null> = {
  sat: 35,
  act: 35,
  ap: null,
  ib: null,
  toefl: 14,
  ielts: 14,
  other: null,
};

/** Throws unless `value` is a "YYYY-MM-DD" date-only string. */
function assertDateOnly(value: string, field: string): void {
  if (!DATE_ONLY_PATTERN.test(value)) {
    throw new Error(`Invalid ${field}: expected "YYYY-MM-DD"`);
  }
}

/** Shifts a "YYYY-MM-DD" date by whole days (UTC arithmetic, DST-proof). */
function shiftDateOnly(dateOnly: string, days: number): string {
  const shifted = new Date(new Date(`${dateOnly}T00:00:00Z`).getTime() + days * DAY_IN_MS);
  return shifted.toISOString().slice(0, 10);
}

/**
 * Derives the registration deadline for a sitting: testDate minus the test
 * type's REGISTRATION_LEAD_DAYS. Types with a null lead (AP/IB
 * school-managed, "other" unknown) derive null — no deadline is ever guessed
 * (fail-closed). Pure date-only arithmetic; a malformed testDate throws.
 */
export function deriveRegistrationDeadline(
  testType: AdmissionsTestType,
  testDate: string,
): string | null {
  assertDateOnly(testDate, "testDate");
  const leadDays = REGISTRATION_LEAD_DAYS[testType];
  if (leadDays === null) return null;
  return shiftDateOnly(testDate, -leadDays);
}
