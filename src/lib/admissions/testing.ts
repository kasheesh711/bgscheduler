// Admissions Case Management — standardized-test sittings: registration-
// deadline derivation, best-score rollup, and testing-deadline calendar
// collection.
//
// Design: docs/casemanagementsystem_design.md §1 (testing.ts module map row),
// §2.4 (write matrix: testing self-entries are student self-report; counselor
// override is attributed via the audit actorRole), §3 (admissions_test_sittings:
// registrationDeadline is auto-derived and editable), §6 (expectedUpdatedAt
// optimistic concurrency). PRD CM-80..CM-83.
//
// Core rules:
// - CM-80: a sitting is type + test date + auto-derived registration deadline
//   + target score + actual score. The deadline derives from
//   REGISTRATION_LEAD_DAYS at create and stays editable via update.
// - CM-81: registration deadlines AND test dates feed the deadline calendar
//   via the collector contract (source "testing", registered in calendar.ts's
//   CALENDAR_COLLECTORS).
// - CM-82: score sends per college live in admissions_college_docs
//   (recommenders.ts setCollegeDoc) — this module never duplicates them; it
//   only cleans up dependent score-send rows when a sitting is deleted.
// - CM-83: scoreReleasedToParent is COUNSELOR-ONLY — raw scores stay
//   staff+student until a counselor releases them; a student or parent
//   attempt throws Forbidden.
// - §2.4 student writes: students may create sittings and edit dates, scores,
//   and accommodations on their own case; counselor edits are attributed by
//   audit actorRole.
//
// Schema gap (reported, not hand-fixed): admissions_test_sittings carries NO
// deletedAt column (design §3 asks for soft-delete on user-facing tables), so
// softDeleteSitting currently performs an audited HARD delete inside a
// transaction, preserving the full row in the audit diff and removing
// dependent score-send doc rows. When a migration adds deleted_at, the delete
// flips to an UPDATE and reads gain an isNull(deletedAt) filter.
//
// Error contract (admissionsErrorResponse maps these): missing rows /
// malformed ids → Error("NotFound"); role violations → Error("Forbidden");
// expectedUpdatedAt mismatch → Error("Conflict"); input-shape violations
// throw descriptive Errors (routes' Zod schemas are the 400 boundary).

import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import { admissionsCollegeDocs, admissionsTestSittings } from "@/lib/db/schema";
import { BANGKOK_TIME_ZONE } from "@/lib/bangkok-time";
import {
  computeFieldDiff,
  withAuditedTransaction,
  writeAuditLog,
  type AdmissionsWriteDb,
} from "./audit";
import { roleAtLeast } from "./config";
import { isUuidShaped } from "./members";
import {
  ADMISSIONS_TEST_TYPES,
  ADMISSIONS_TEST_TYPE_LABELS,
  deriveRegistrationDeadline,
  isAdmissionsTestType,
  type AdmissionsTestType,
} from "./shared/testing";
import type { CalendarItem, CalendarWindow } from "./calendar";
import type { AdmissionsTaskOwner } from "./meetings";
import type { CaseAccess } from "./types";

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Strict numeric score shape ("1450", "34", "7.5"); anything else is skipped. */
const SCORE_PATTERN = /^-?\d+(?:\.\d+)?$/;

type TestSittingRow = typeof admissionsTestSittings.$inferSelect;

// ── Test-type union (mirrors pgEnum in schema.ts) ───────────────────────

// The test-type union, its closed value list/labels, the registration lead
// days, and the pure deriveRegistrationDeadline helper live in the
// client-safe shared module (shared/testing.ts); this module re-exports them
// so existing consumers keep importing from "./testing".
export {
  ADMISSIONS_TEST_TYPES,
  ADMISSIONS_TEST_TYPE_LABELS,
  REGISTRATION_LEAD_DAYS,
  deriveRegistrationDeadline,
  isAdmissionsTestType,
} from "./shared/testing";
export type { AdmissionsTestType } from "./shared/testing";

// ── DTOs ────────────────────────────────────────────────────────────────

/** One test sitting serialized for the Testing tab (CM-80). */
export interface AdmissionsTestSittingDto {
  id: string;
  caseId: string;
  testType: AdmissionsTestType;
  /** Test date, "YYYY-MM-DD". */
  testDate: string;
  /** Auto-derived at create (REGISTRATION_LEAD_DAYS), editable via update. */
  registrationDeadline: string | null;
  targetScore: string;
  actualScore: string | null;
  /** CM-83: parents may see raw scores only when a counselor set this true. */
  scoreReleasedToParent: boolean;
  accommodations: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The best (max) actual score for one test type (CM-82 policy comparison). */
export interface AdmissionsBestScore {
  testType: AdmissionsTestType;
  /** The sitting that produced the best score. */
  sittingId: string;
  testDate: string;
  /** The stored score string of the best sitting. */
  actualScore: string;
  /** Parsed numeric value used for the max comparison. */
  numericScore: number;
  /** CM-83 release state of the best sitting's score. */
  scoreReleasedToParent: boolean;
}

// ── Internal helpers ────────────────────────────────────────────────────

function assertDateOnly(value: string, field: string): void {
  if (!DATE_ONLY_PATTERN.test(value)) {
    throw new Error(`Invalid ${field}: expected "YYYY-MM-DD"`);
  }
}

function assertTestType(value: string, field: string): void {
  if (!isAdmissionsTestType(value)) {
    throw new Error(`Invalid ${field}: ${String(value)}`);
  }
}

/** Trims a nullable text input; empty-after-trim collapses to null. */
function normalizeNullableText(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Asia/Bangkok calendar date ("YYYY-MM-DD") for an instant (mirrors the
 * private helper in calendar.ts / essays.ts).
 */
function getBangkokDateKey(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BANGKOK_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

function toSittingDto(row: TestSittingRow): AdmissionsTestSittingDto {
  return {
    id: row.id,
    caseId: row.caseId,
    testType: row.testType,
    testDate: row.testDate,
    registrationDeadline: row.registrationDeadline,
    targetScore: row.targetScore,
    actualScore: row.actualScore,
    scoreReleasedToParent: row.scoreReleasedToParent,
    accommodations: row.accommodations,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Loads a sitting scoped to (sittingId, caseId). The caseId scope stops
 * cross-case sittingId probing; a miss throws "NotFound".
 */
async function findCaseSitting(
  db: AdmissionsWriteDb,
  sittingId: string,
  caseId: string,
): Promise<TestSittingRow> {
  const rows = await db
    .select()
    .from(admissionsTestSittings)
    .where(and(
      eq(admissionsTestSittings.id, sittingId),
      eq(admissionsTestSittings.caseId, caseId),
    ))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error("NotFound");
  return row;
}

// ── Create (CM-80, design §2.4) ─────────────────────────────────────────

/** createSitting input; `access` must come from requireCaseAccess. */
export interface CreateSittingInput {
  access: CaseAccess;
  testType: AdmissionsTestType;
  /** Test date, "YYYY-MM-DD". */
  testDate: string;
  targetScore?: string;
  accommodations?: string | null;
}

/**
 * Adds one test sitting (CM-80). Student AND counselor/admin may add (design
 * §2.4: testing self-entries are a self-report surface); parents never write.
 * The insert and its audit row commit atomically.
 *
 * 1. Role gate: student+ (parent → Forbidden). Validate testType (known
 *    enum) and testDate ("YYYY-MM-DD") up front.
 * 2. Auto-derive registrationDeadline from REGISTRATION_LEAD_DAYS (null for
 *    school-managed/unknown types); it stays editable via updateSitting.
 * 3. Insert with scoreReleasedToParent false (CM-83 — scores start
 *    unreleased) and no actualScore.
 * 4. Audit (entityType "test_sitting", action "create", actorRole =
 *    access.role — the §2.4 attribution).
 *
 * @returns the created sitting DTO.
 */
export async function createSitting(
  input: CreateSittingInput,
  db: Database = getDb(),
): Promise<AdmissionsTestSittingDto> {
  if (!roleAtLeast(input.access.role, "student")) throw new Error("Forbidden");

  assertTestType(input.testType, "testType");
  assertDateOnly(input.testDate, "testDate");
  const targetScore = (input.targetScore ?? "").trim();
  const accommodations = normalizeNullableText(input.accommodations ?? null);
  const registrationDeadline = deriveRegistrationDeadline(input.testType, input.testDate);

  return withAuditedTransaction(async (tx) => {
    const insertedRows = await tx
      .insert(admissionsTestSittings)
      .values({
        caseId: input.access.caseId,
        testType: input.testType,
        testDate: input.testDate,
        registrationDeadline,
        targetScore,
        actualScore: null,
        scoreReleasedToParent: false,
        accommodations,
      })
      .returning();
    const row = insertedRows[0];
    if (!row) throw new Error("Test sitting insert returned no row");

    await writeAuditLog(tx, {
      caseId: input.access.caseId,
      actorEmail: input.access.email,
      actorRole: input.access.role,
      entityType: "test_sitting",
      entityId: row.id,
      action: "create",
      diff: computeFieldDiff(
        {},
        {
          testType: input.testType,
          testDate: input.testDate,
          registrationDeadline,
          targetScore,
          accommodations,
        },
        ["testType", "testDate", "registrationDeadline", "targetScore", "accommodations"],
      ),
    });

    return toSittingDto(row);
  }, db);
}

// ── Update (CM-80/83, design §2.4/§6) ───────────────────────────────────

/** updateSitting input — undefined fields are left untouched. */
export interface UpdateSittingInput {
  access: CaseAccess;
  sittingId: string;
  /** Optimistic-concurrency token (sitting updatedAt ISO); mismatch → Conflict. */
  expectedUpdatedAt?: string;
  /** Student-writable (design §2.4 self-report surface). */
  testType?: AdmissionsTestType;
  /** Student-writable, "YYYY-MM-DD". */
  testDate?: string;
  /** Student-writable explicit deadline; null clears (see re-derivation rule). */
  registrationDeadline?: string | null;
  /** Student-writable. */
  targetScore?: string;
  /** Student-writable; null clears. */
  actualScore?: string | null;
  /** Student-writable; null clears. */
  accommodations?: string | null;
  /** COUNSELOR-ONLY release flag (CM-83); a student attempt → Forbidden. */
  scoreReleasedToParent?: boolean;
}

const SITTING_DIFF_FIELDS = [
  "testType",
  "testDate",
  "registrationDeadline",
  "targetScore",
  "actualScore",
  "accommodations",
  "scoreReleasedToParent",
] as const;

/**
 * Partially updates a test sitting (CM-80/83). Write split per design §2.4:
 * students may edit their own case's sittings (type, dates, target/actual
 * scores, accommodations); scoreReleasedToParent is counselor+ ONLY (CM-83 —
 * a student or parent providing it → Forbidden). Counselor edits (including
 * overrides of student fields) are attributed via the audit actorRole. The
 * mutation and its field-level audit diff commit atomically.
 *
 * 1. Role gates + up-front validation (known testType, "YYYY-MM-DD" dates).
 * 2. Load the sitting scoped to the access's case (miss → NotFound); an
 *    expectedUpdatedAt mismatch → Error("Conflict") (design §6 — routes
 *    surface 409).
 * 3. Registration-deadline re-derivation ("still-auto" rule): when the
 *    sitting's (testType, testDate) changes, the caller did NOT pass an
 *    explicit registrationDeadline, and the stored deadline still equals the
 *    auto-derived value for the OLD (testType, testDate), the deadline is
 *    re-derived for the new pair. A manually edited deadline is never
 *    clobbered; an explicit registrationDeadline in the call always wins.
 * 4. Diff only the provided fields; nothing changed → no-op without writes.
 *    Apply the changed fields plus a fresh updatedAt and audit the diff.
 *
 * @returns the updated sitting DTO.
 */
export async function updateSitting(
  input: UpdateSittingInput,
  db: Database = getDb(),
): Promise<AdmissionsTestSittingDto> {
  if (!roleAtLeast(input.access.role, "student")) throw new Error("Forbidden");
  if (!isUuidShaped(input.sittingId)) throw new Error("NotFound");

  if (
    input.scoreReleasedToParent !== undefined &&
    !roleAtLeast(input.access.role, "counselor")
  ) {
    throw new Error("Forbidden");
  }

  if (input.testType !== undefined) assertTestType(input.testType, "testType");
  if (input.testDate !== undefined) assertDateOnly(input.testDate, "testDate");
  if (input.registrationDeadline != null) {
    assertDateOnly(input.registrationDeadline, "registrationDeadline");
  }
  const targetScore = input.targetScore === undefined ? undefined : input.targetScore.trim();
  const actualScore =
    input.actualScore === undefined ? undefined : normalizeNullableText(input.actualScore);
  const accommodations =
    input.accommodations === undefined ? undefined : normalizeNullableText(input.accommodations);

  return withAuditedTransaction(async (tx) => {
    const row = await findCaseSitting(tx, input.sittingId, input.access.caseId);

    if (
      input.expectedUpdatedAt !== undefined &&
      input.expectedUpdatedAt !== row.updatedAt.toISOString()
    ) {
      throw new Error("Conflict");
    }

    // Step 3 — "still-auto" re-derivation (see JSDoc).
    let registrationDeadline = input.registrationDeadline;
    if (registrationDeadline === undefined) {
      const nextTestType = input.testType ?? row.testType;
      const nextTestDate = input.testDate ?? row.testDate;
      const identityChanged =
        nextTestType !== row.testType || nextTestDate !== row.testDate;
      if (
        identityChanged &&
        row.registrationDeadline === deriveRegistrationDeadline(row.testType, row.testDate)
      ) {
        registrationDeadline = deriveRegistrationDeadline(nextTestType, nextTestDate);
      }
    }

    const diff = computeFieldDiff(
      row as unknown as Record<string, unknown>,
      {
        testType: input.testType,
        testDate: input.testDate,
        registrationDeadline,
        targetScore,
        actualScore,
        accommodations,
        scoreReleasedToParent: input.scoreReleasedToParent,
      },
      SITTING_DIFF_FIELDS,
    );
    if (Object.keys(diff).length === 0) return toSittingDto(row);

    const now = new Date();
    const setValues: Partial<typeof admissionsTestSittings.$inferInsert> = {
      updatedAt: now,
    };
    if ("testType" in diff) setValues.testType = input.testType;
    if ("testDate" in diff) setValues.testDate = input.testDate;
    if ("registrationDeadline" in diff) setValues.registrationDeadline = registrationDeadline;
    if ("targetScore" in diff) setValues.targetScore = targetScore;
    if ("actualScore" in diff) setValues.actualScore = actualScore;
    if ("accommodations" in diff) setValues.accommodations = accommodations;
    if ("scoreReleasedToParent" in diff) {
      setValues.scoreReleasedToParent = input.scoreReleasedToParent;
    }

    await tx
      .update(admissionsTestSittings)
      .set(setValues)
      .where(eq(admissionsTestSittings.id, row.id));

    await writeAuditLog(tx, {
      caseId: input.access.caseId,
      actorEmail: input.access.email,
      actorRole: input.access.role,
      entityType: "test_sitting",
      entityId: row.id,
      action: "update",
      diff,
    });

    return toSittingDto({ ...row, ...setValues } as TestSittingRow);
  }, db);
}

// ── Delete ──────────────────────────────────────────────────────────────

/** softDeleteSitting input; `access` must come from requireCaseAccess. */
export interface SoftDeleteSittingInput {
  access: CaseAccess;
  sittingId: string;
}

/**
 * Deletes a test sitting (student or counselor — a sitting is the student's
 * own self-report row, design §2.4; parents never write).
 *
 * admissions_test_sittings has no deletedAt column (schema gap vs design §3),
 * so this is currently an audited HARD delete: the full row is preserved in
 * the audit diff, and dependent score-send doc rows
 * (admissions_college_docs.testSittingId is a soft reference, CM-82) are
 * removed in the same transaction so no doc row claims scores were sent for
 * a sitting that no longer exists. Everything commits atomically.
 */
export async function softDeleteSitting(
  input: SoftDeleteSittingInput,
  db: Database = getDb(),
): Promise<void> {
  if (!roleAtLeast(input.access.role, "student")) throw new Error("Forbidden");
  if (!isUuidShaped(input.sittingId)) throw new Error("NotFound");

  return withAuditedTransaction(async (tx) => {
    const row = await findCaseSitting(tx, input.sittingId, input.access.caseId);

    const docRows = await tx
      .select({ id: admissionsCollegeDocs.id })
      .from(admissionsCollegeDocs)
      .where(eq(admissionsCollegeDocs.testSittingId, row.id));
    const removedScoreSendDocIds = docRows.map((doc) => doc.id);

    if (removedScoreSendDocIds.length > 0) {
      await tx
        .delete(admissionsCollegeDocs)
        .where(eq(admissionsCollegeDocs.testSittingId, row.id));
    }
    await tx
      .delete(admissionsTestSittings)
      .where(eq(admissionsTestSittings.id, row.id));

    await writeAuditLog(tx, {
      caseId: input.access.caseId,
      actorEmail: input.access.email,
      actorRole: input.access.role,
      entityType: "test_sitting",
      entityId: row.id,
      action: "delete",
      diff: {
        deleted: { old: toSittingDto(row), new: null },
        ...(removedScoreSendDocIds.length > 0
          ? { removedScoreSendDocIds: { old: removedScoreSendDocIds, new: null } }
          : {}),
      },
    });
  }, db);
}

// ── Read (CM-80/82) ─────────────────────────────────────────────────────

/** listSittingsForCase options. */
export interface ListSittingsOptions {
  /** "Upcoming" reference instant; defaults to the current time. */
  now?: Date;
}

/**
 * A case's test sittings, chronological with upcoming-first: sittings whose
 * testDate is today (Bangkok) or later come first, soonest first; past
 * sittings follow, most recent first. Ties break by id ascending (stable
 * render). Malformed caseId fails closed to an empty list.
 *
 * @returns Testing-tab rows, next sitting first.
 */
export async function listSittingsForCase(
  caseId: string,
  options: ListSittingsOptions = {},
  db: Database = getDb(),
): Promise<AdmissionsTestSittingDto[]> {
  if (!isUuidShaped(caseId)) return [];

  const todayKey = getBangkokDateKey(options.now ?? new Date());
  const rows = await db
    .select()
    .from(admissionsTestSittings)
    .where(eq(admissionsTestSittings.caseId, caseId))
    .orderBy(asc(admissionsTestSittings.testDate), asc(admissionsTestSittings.id));

  return rows
    .slice()
    .sort((a, b) => {
      const aUpcoming = a.testDate >= todayKey;
      const bUpcoming = b.testDate >= todayKey;
      if (aUpcoming !== bUpcoming) return aUpcoming ? -1 : 1;
      if (a.testDate !== b.testDate) {
        // Upcoming block ascending (soonest first); past block descending
        // (most recent first).
        if (aUpcoming) return a.testDate < b.testDate ? -1 : 1;
        return a.testDate > b.testDate ? -1 : 1;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .map(toSittingDto);
}

/**
 * Parses a stored score string into a number for best-score comparison.
 * Strictly numeric only ("1450", "34", "7.5") — composite or annotated
 * strings return null and are skipped, never guessed (fail-closed).
 */
export function parseScoreValue(value: string): number | null {
  const trimmed = value.trim();
  if (!SCORE_PATTERN.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The best actual score per test type for a case (CM-82: shown next to each
 * list college's test policy).
 *
 * 1. Only sittings with an actualScore participate; scores that do not parse
 *    as a plain number are skipped (fail-closed — never compared by string).
 * 2. Best = max numeric score per test type. Ties break by later testDate
 *    (the more recent sitting), then id ascending.
 * 3. Results are ordered by ADMISSIONS_TEST_TYPES canonical order; types
 *    with no scored sitting are omitted.
 *
 * Malformed caseId fails closed to an empty list.
 */
export async function getBestScores(
  caseId: string,
  db: Database = getDb(),
): Promise<AdmissionsBestScore[]> {
  if (!isUuidShaped(caseId)) return [];

  const rows = await db
    .select({
      id: admissionsTestSittings.id,
      testType: admissionsTestSittings.testType,
      testDate: admissionsTestSittings.testDate,
      actualScore: admissionsTestSittings.actualScore,
      scoreReleasedToParent: admissionsTestSittings.scoreReleasedToParent,
    })
    .from(admissionsTestSittings)
    .where(and(
      eq(admissionsTestSittings.caseId, caseId),
      isNotNull(admissionsTestSittings.actualScore),
    ));

  const best = new Map<AdmissionsTestType, AdmissionsBestScore>();
  for (const row of rows) {
    if (row.actualScore === null) continue;
    const numericScore = parseScoreValue(row.actualScore);
    if (numericScore === null) continue;

    const candidate: AdmissionsBestScore = {
      testType: row.testType,
      sittingId: row.id,
      testDate: row.testDate,
      actualScore: row.actualScore,
      numericScore,
      scoreReleasedToParent: row.scoreReleasedToParent,
    };
    const current = best.get(row.testType);
    if (!current || isBetterScore(candidate, current)) {
      best.set(row.testType, candidate);
    }
  }

  return ADMISSIONS_TEST_TYPES
    .map((testType) => best.get(testType))
    .filter((entry): entry is AdmissionsBestScore => entry !== undefined);
}

/** getBestScores comparator: higher score, then later testDate, then lower id. */
function isBetterScore(candidate: AdmissionsBestScore, current: AdmissionsBestScore): boolean {
  if (candidate.numericScore !== current.numericScore) {
    return candidate.numericScore > current.numericScore;
  }
  if (candidate.testDate !== current.testDate) {
    return candidate.testDate > current.testDate;
  }
  return candidate.sittingId < current.sittingId;
}

// ── Calendar collector (registration deadlines + test dates, CM-81) ─────

/**
 * One testing entry in the calendar aggregator's collector contract (design
 * §8: one collector per dated-item source): a CalendarItem WITHOUT `overdue`
 * (the aggregator stamps it against today centrally) plus the `completed`
 * flag the aggregator uses to drop finished items from the deadlines panel.
 * This source is registered in calendar.ts's CALENDAR_COLLECTORS (Phase 4).
 *
 * Each sitting yields up to TWO entries, so `id` is the sitting id suffixed
 * with the entry kind ("{sittingId}:registration" | "{sittingId}:sitting")
 * to keep calendar row ids unique.
 */
export interface TestingDeadlineEntry {
  /** "{sittingId}:registration" or "{sittingId}:sitting". */
  id: string;
  caseId: string;
  source: "testing";
  title: string;
  /** The registration deadline or test date, "YYYY-MM-DD". */
  date: string;
  /** Testing self-entries are the student's work (design §2.4). */
  ownerRole: AdmissionsTaskOwner;
  /** True when the sitting has an actualScore (the sitting is done). */
  completed: boolean;
}

/**
 * Batch collector for testing deadlines (CM-81): every sitting across the
 * requested cases yields its registration deadline (when present) AND its
 * test date as separate entries, in one query for the whole batch (keeps the
 * cross-case caseload view at one query per source, CM-101).
 *
 * Non-uuid-shaped caseIds are dropped (fail-closed skip); empty input
 * returns [] without a query. Malformed stored dates are skipped, never
 * guessed. Titles are "{label} registration deadline" / "{label} sitting"
 * (ADMISSIONS_TEST_TYPE_LABELS). Both entries are completed once the sitting
 * has an actualScore — a scored sitting needs no further reminders. Entries
 * are NOT sorted or window-filtered — the aggregator owns both.
 */
export async function collectTestingDeadlineEntries(
  caseIds: readonly string[],
  db: Database = getDb(),
): Promise<TestingDeadlineEntry[]> {
  const validCaseIds = caseIds.filter((id) => isUuidShaped(id));
  if (validCaseIds.length === 0) return [];

  const rows = await db
    .select({
      id: admissionsTestSittings.id,
      caseId: admissionsTestSittings.caseId,
      testType: admissionsTestSittings.testType,
      testDate: admissionsTestSittings.testDate,
      registrationDeadline: admissionsTestSittings.registrationDeadline,
      actualScore: admissionsTestSittings.actualScore,
    })
    .from(admissionsTestSittings)
    .where(inArray(admissionsTestSittings.caseId, validCaseIds));

  const entries: TestingDeadlineEntry[] = [];
  for (const row of rows) {
    const label = ADMISSIONS_TEST_TYPE_LABELS[row.testType];
    const completed = row.actualScore !== null;

    if (row.registrationDeadline !== null && DATE_ONLY_PATTERN.test(row.registrationDeadline)) {
      entries.push({
        id: `${row.id}:registration`,
        caseId: row.caseId,
        source: "testing",
        title: `${label} registration deadline`,
        date: row.registrationDeadline,
        ownerRole: "student",
        completed,
      });
    }
    if (DATE_ONLY_PATTERN.test(row.testDate)) {
      entries.push({
        id: `${row.id}:sitting`,
        caseId: row.caseId,
        source: "testing",
        title: `${label} sitting`,
        date: row.testDate,
        ownerRole: "student",
        completed,
      });
    }
  }
  return entries;
}

/**
 * CalendarItem-shaped row for testing deadlines (source "testing").
 * `completed` mirrors the calendar module's internal collector contract (the
 * aggregator drops completed rows from the deadlines panel); `overdue` is
 * pre-stamped here.
 */
export interface TestingDeadlineItem extends Omit<CalendarItem, "source"> {
  source: "testing";
  /** True when the sitting already has an actualScore. */
  completed: boolean;
}

/**
 * Collects ONE case's testing deadlines for an inclusive window (CM-81) —
 * CalendarItem-shaped rows with source "testing" (mirrors
 * collectEssayDeadlines).
 *
 * 1. Validate the window ("YYYY-MM-DD" bounds, from <= to); malformed caseId
 *    → NotFound. Rows with malformed stored dates are skipped (fail-closed).
 * 2. Every sitting contributes its registration deadline (when set) and its
 *    test date as separate rows; only rows dated inside [from, to] are kept.
 * 3. completed = the sitting has an actualScore; overdue = open AND the date
 *    is strictly before today (Bangkok). ownerRole is "student" (testing
 *    self-entries are the student's work, design §2.4).
 *
 * @returns the window's deadline rows, earliest first (stable id tiebreak).
 */
export async function collectTestingDeadlines(
  caseId: string,
  window: CalendarWindow,
  now: Date = new Date(),
  db: Database = getDb(),
): Promise<TestingDeadlineItem[]> {
  if (!isUuidShaped(caseId)) throw new Error("NotFound");
  assertDateOnly(window.from, "from");
  assertDateOnly(window.to, "to");
  if (window.from > window.to) {
    throw new Error("Invalid calendar window: from must be on or before to");
  }

  const todayKey = getBangkokDateKey(now);
  const entries = await collectTestingDeadlineEntries([caseId], db);
  return entries
    .filter((entry) => entry.date >= window.from && entry.date <= window.to)
    .map((entry) => ({
      ...entry,
      overdue: !entry.completed && entry.date < todayKey,
    }))
    .sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}
