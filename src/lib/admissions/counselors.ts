// Admissions Case Management — global counselor registry (design §3/§4).
//
// admissions_counselors is the sign-in authority for the counselor role
// (resolveAdmissionsRole + requireCaseAccess both require an ACTIVE row), so
// every registry mutation here is a sensitive action: it commits atomically
// with its append-only audit row via withAuditedTransaction (caseId: null —
// registry edits are cross-case admin actions).

import { asc, eq } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import { admissionsCounselors } from "@/lib/db/schema";
import { computeFieldDiff, withAuditedTransaction, writeAuditLog } from "./audit";
import type { AdmissionsCounselorDto, AdmissionsSessionUser } from "./types";

/** Audit attribution for registry mutations (who performed the edit). */
export type AdmissionsActor = Pick<AdmissionsSessionUser, "email" | "role">;

/** Registry fields recorded in audit diffs (email is the upsert key). */
const COUNSELOR_AUDIT_FIELDS = ["name", "active"] as const;

type CounselorRow = typeof admissionsCounselors.$inferSelect;

function toCounselorDto(row: CounselorRow): AdmissionsCounselorDto {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Lists all counselor registry rows (active and inactive — the admin registry
 * view needs both), ordered by name.
 */
export async function listCounselors(db: Database = getDb()): Promise<AdmissionsCounselorDto[]> {
  const rows = await db
    .select()
    .from(admissionsCounselors)
    .orderBy(asc(admissionsCounselors.name));
  return rows.map(toCounselorDto);
}

/**
 * Creates or updates a counselor registry row keyed by lowercase email, with
 * an audited transaction (grants/updates sign-in capability).
 *
 * 1. Normalize (email trim+lowercase, name trim); reject empties before
 *    touching the database.
 * 2. Inside withAuditedTransaction: read the existing row and compute the
 *    field diff (name/active). An existing row with no changes short-circuits
 *    — no write, no audit noise.
 * 3. Upsert via ON CONFLICT (email) DO UPDATE (race-safe against the unique
 *    index) and append the audit row (action "create" or "update", caseId
 *    null) in the same transaction.
 *
 * @returns the upserted counselor DTO.
 */
export async function upsertCounselor(
  email: string,
  name: string,
  active: boolean,
  actor: AdmissionsActor,
  db: Database = getDb(),
): Promise<AdmissionsCounselorDto> {
  const normalizedEmail = email.trim().toLowerCase();
  const trimmedName = name.trim();
  if (!normalizedEmail) throw new Error("Counselor email is required");
  if (!trimmedName) throw new Error("Counselor name is required");

  return withAuditedTransaction(async (tx) => {
    const existingRows = await tx
      .select()
      .from(admissionsCounselors)
      .where(eq(admissionsCounselors.email, normalizedEmail))
      .limit(1);
    const existing: CounselorRow | null = existingRows[0] ?? null;

    const diff = computeFieldDiff(
      existing ?? {},
      { name: trimmedName, active },
      COUNSELOR_AUDIT_FIELDS,
    );
    if (existing && Object.keys(diff).length === 0) return toCounselorDto(existing);

    const upsertedRows = await tx
      .insert(admissionsCounselors)
      .values({ email: normalizedEmail, name: trimmedName, active })
      .onConflictDoUpdate({
        target: admissionsCounselors.email,
        set: { name: trimmedName, active, updatedAt: new Date() },
      })
      .returning();
    const upserted = upsertedRows[0];

    await writeAuditLog(tx, {
      caseId: null,
      actorEmail: actor.email,
      actorRole: actor.role,
      entityType: "counselor",
      entityId: upserted.id,
      action: existing ? "update" : "create",
      diff,
    });

    return toCounselorDto(upserted);
  }, db);
}

/**
 * Deactivates a counselor registry row — this revokes counselor sign-in
 * capability, so the flip and its audit row commit atomically.
 *
 * 1. Normalize the email; reject an empty email before touching the database.
 * 2. Inside withAuditedTransaction: load the row; a missing row throws
 *    Error("NotFound") (→ 404). An already-inactive row returns unchanged
 *    (idempotent — no write, no duplicate audit row).
 * 3. Set active = false and append the audit row (action "deactivate",
 *    diff {active: {old: true, new: false}}, caseId null) in the same
 *    transaction.
 *
 * @returns the deactivated counselor DTO.
 */
export async function deactivateCounselor(
  email: string,
  actor: AdmissionsActor,
  db: Database = getDb(),
): Promise<AdmissionsCounselorDto> {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) throw new Error("Counselor email is required");

  return withAuditedTransaction(async (tx) => {
    const rows = await tx
      .select()
      .from(admissionsCounselors)
      .where(eq(admissionsCounselors.email, normalizedEmail))
      .limit(1);
    const existing: CounselorRow | undefined = rows[0];
    if (!existing) throw new Error("NotFound");
    if (!existing.active) return toCounselorDto(existing);

    const updatedRows = await tx
      .update(admissionsCounselors)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(admissionsCounselors.id, existing.id))
      .returning();

    await writeAuditLog(tx, {
      caseId: null,
      actorEmail: actor.email,
      actorRole: actor.role,
      entityType: "counselor",
      entityId: existing.id,
      action: "deactivate",
      diff: { active: { old: true, new: false } },
    });

    return toCounselorDto(updatedRows[0]);
  }, db);
}
