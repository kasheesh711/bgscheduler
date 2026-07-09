// Admissions Case Management — cohort registry (design §3, admissions_cohorts).
//
// Cohorts group students by graduation year, own broadcast announcements and
// the checklist-template seed. Names are globally unique (unique index
// admissions_cohorts_name_idx); duplicates surface as Error("Conflict") so
// admissionsErrorResponse maps them to HTTP 409.

import { asc, desc } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import { admissionsCohorts } from "@/lib/db/schema";
import type { AdmissionsCohortDto } from "./types";

/**
 * Detects a Postgres unique-constraint violation (SQLSTATE 23505) across
 * drivers: checks `code`, the duplicate-key message text, and any nested
 * `cause` chain. Shared by admissions modules that map unique-index races
 * to Error("Conflict") (e.g. recommenders.ts link creation).
 */
export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown; cause?: unknown };
  if (candidate.code === "23505") return true;
  if (
    typeof candidate.message === "string" &&
    /duplicate key value violates unique constraint/i.test(candidate.message)
  ) {
    return true;
  }
  return candidate.cause === undefined ? false : isUniqueViolation(candidate.cause);
}

/**
 * Lists all cohorts, newest graduation year first, then by name.
 */
export async function listCohorts(db: Database = getDb()): Promise<AdmissionsCohortDto[]> {
  return db
    .select({
      id: admissionsCohorts.id,
      name: admissionsCohorts.name,
      graduationYear: admissionsCohorts.graduationYear,
    })
    .from(admissionsCohorts)
    .orderBy(desc(admissionsCohorts.graduationYear), asc(admissionsCohorts.name));
}

/**
 * Creates a cohort with a globally-unique name.
 *
 * 1. Trim the name; reject an empty name or a non-integer graduation year
 *    before touching the database.
 * 2. Insert and return the new row (single statement — race-safe: uniqueness
 *    is enforced by the admissions_cohorts_name_idx unique index, not a
 *    read-then-write check).
 * 3. A unique violation on the name rethrows as Error("Conflict") (→ 409);
 *    every other error propagates unchanged.
 *
 * @returns the created cohort DTO.
 */
export async function createCohort(
  name: string,
  graduationYear: number,
  db: Database = getDb(),
): Promise<AdmissionsCohortDto> {
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error("Cohort name is required");
  if (!Number.isInteger(graduationYear)) throw new Error("Graduation year must be an integer");

  try {
    const rows = await db
      .insert(admissionsCohorts)
      .values({ name: trimmedName, graduationYear })
      .returning();
    const row = rows[0];
    return { id: row.id, name: row.name, graduationYear: row.graduationYear };
  } catch (error) {
    if (isUniqueViolation(error)) throw new Error("Conflict");
    throw error;
  }
}
