// Admissions Case Management — client-safe test-type constants, typed score
// payloads, superscore helpers, and registration-deadline derivation.
// registration-deadline derivation.
//
// Pure module: no database, audit, or server-only imports — safe to import
// from "use client" components. The db-facing testing.ts re-exports these
// symbols so existing lib/route/test consumers keep their import paths.
//
// Design: docs/casemanagementsystem_design.md — PRD CM-80 (test sittings,
// registration-deadline auto-derivation).

import { z } from "zod";

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

export const ADMISSIONS_TEST_SITTING_STATUSES = [
  "planned",
  "registered",
  "taken",
  "score_received",
  "canceled",
] as const;
export type AdmissionsTestSittingStatus =
  (typeof ADMISSIONS_TEST_SITTING_STATUSES)[number];

export function isAdmissionsTestSittingStatus(
  value: string,
): value is AdmissionsTestSittingStatus {
  return ADMISSIONS_TEST_SITTING_STATUSES.includes(value as AdmissionsTestSittingStatus);
}

const halfPointScoreSchema = z.number().min(0).max(9).refine(
  (value) => Number.isInteger(value * 2),
  { message: "IELTS section scores must use 0.5-point increments" },
);

export const admissionsTestScoreDetailsSchema = z.discriminatedUnion("testType", [
  z.object({
    testType: z.literal("sat"),
    math: z.number().int().min(200).max(800),
    readingWriting: z.number().int().min(200).max(800),
    total: z.number().int().min(400).max(1600),
  }).strict(),
  z.object({
    testType: z.literal("act"),
    english: z.number().int().min(1).max(36),
    math: z.number().int().min(1).max(36),
    reading: z.number().int().min(1).max(36),
    science: z.number().int().min(1).max(36),
    writing: z.number().int().min(2).max(12).nullable().optional(),
    composite: z.number().int().min(1).max(36),
  }).strict(),
  z.object({
    testType: z.literal("ap"),
    score: z.number().int().min(1).max(5),
  }).strict(),
  z.object({
    testType: z.literal("ib"),
    score: z.number().int().min(1).max(7),
  }).strict(),
  z.object({
    testType: z.literal("toefl"),
    reading: z.number().int().min(0).max(30),
    listening: z.number().int().min(0).max(30),
    speaking: z.number().int().min(0).max(30),
    writing: z.number().int().min(0).max(30),
    total: z.number().int().min(0).max(120),
  }).strict(),
  z.object({
    testType: z.literal("ielts"),
    listening: halfPointScoreSchema,
    reading: halfPointScoreSchema,
    writing: halfPointScoreSchema,
    speaking: halfPointScoreSchema,
    overall: halfPointScoreSchema,
  }).strict(),
  z.object({
    testType: z.literal("other"),
    score: z.number(),
    scale: z.string().trim().min(1).max(80).nullable().optional(),
  }).strict(),
]);

export type AdmissionsTestScoreDetails = z.infer<typeof admissionsTestScoreDetailsSchema>;

/** Derives and verifies the aggregate fields before a score payload is stored. */
export function normalizeTestScoreDetails(input: unknown): AdmissionsTestScoreDetails {
  const loose = input as Record<string, unknown> | null;
  if (!loose || typeof loose !== "object" || typeof loose.testType !== "string") {
    throw new Error("Invalid scoreDetails: expected a typed score object");
  }

  const candidate = { ...loose };
  if (loose.testType === "sat") {
    candidate.total = Number(loose.math) + Number(loose.readingWriting);
  } else if (loose.testType === "act") {
    candidate.composite = Math.round(
      (Number(loose.english) + Number(loose.math) + Number(loose.reading) + Number(loose.science)) / 4,
    );
  } else if (loose.testType === "toefl") {
    candidate.total =
      Number(loose.reading) + Number(loose.listening) + Number(loose.speaking) + Number(loose.writing);
  } else if (loose.testType === "ielts") {
    const average =
      (Number(loose.listening) + Number(loose.reading) + Number(loose.writing) + Number(loose.speaking)) / 4;
    candidate.overall = Math.round(average * 2) / 2;
  }

  const parsed = admissionsTestScoreDetailsSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".");
    throw new Error(`Invalid scoreDetails${path ? ` (${path})` : ""}: ${issue?.message ?? "malformed payload"}`);
  }
  return parsed.data;
}

/** Canonical aggregate score retained in the legacy actualScore column. */
export function getScoreDetailsAggregate(details: AdmissionsTestScoreDetails): string {
  switch (details.testType) {
    case "sat": return String(details.total);
    case "act": return String(details.composite);
    case "toefl": return String(details.total);
    case "ielts": return String(details.overall);
    case "ap":
    case "ib":
    case "other": return String(details.score);
  }
}

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
