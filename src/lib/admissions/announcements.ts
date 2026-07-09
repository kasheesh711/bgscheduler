// Admissions Case Management — cohort/case announcements (CM-90).
//
// Design: docs/casemanagementsystem_design.md §3 (admissions_announcements —
// cohortId XOR caseId enforced by a check constraint) and §4 (/announcements
// routes, counselor-only writes). Announcements are family-visible by design
// (PRD CM-90: "visible to student and parent surfaces") — there is
// deliberately NO visibility enum here; audience shaping belongs to notes.ts.
// The exactly-one-scope rule is enforced in code before any write AND by the
// admissions_announcements_target_check constraint (defense in depth).

import { and, desc, eq, isNull, or } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import { admissionsAnnouncements, admissionsCases } from "@/lib/db/schema";
import { computeFieldDiff, withAuditedTransaction, writeAuditLog } from "./audit";
import { isUuidShaped } from "./members";
import type { CaseRole } from "./types";

const ANNOUNCEMENT_DIFF_FIELDS = ["title", "body"] as const;

type AnnouncementRow = typeof admissionsAnnouncements.$inferSelect;

/** One announcement row serialized for API/UI consumers. */
export interface AdmissionsAnnouncementDto {
  id: string;
  /** Cohort broadcast target; null for case-scoped announcements. */
  cohortId: string | null;
  /** Case target; null for cohort broadcasts. Exactly one scope is set. */
  caseId: string | null;
  title: string;
  body: string;
  authorEmail: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Input for createAnnouncement. Exactly one of cohortId/caseId must be set
 * (CM-90: cohort broadcast XOR case-scoped). `actorRole` feeds the paired
 * audit row and defaults to "counselor" — announcement writes are
 * counselor-level per design §4.
 */
export interface CreateAnnouncementInput {
  cohortId?: string | null;
  caseId?: string | null;
  title: string;
  body: string;
  authorEmail: string;
  actorRole?: CaseRole;
}

/** Partial-update input for updateAnnouncement; undefined fields are untouched. */
export interface UpdateAnnouncementInput {
  announcementId: string;
  actorEmail: string;
  actorRole: CaseRole;
  title?: string;
  body?: string;
}

/** Input for softDeleteAnnouncement; actor fields feed the paired audit row. */
export interface SoftDeleteAnnouncementInput {
  announcementId: string;
  actorEmail: string;
  actorRole: CaseRole;
}

function toAnnouncementDto(row: AnnouncementRow): AdmissionsAnnouncementDto {
  return {
    id: row.id,
    cohortId: row.cohortId,
    caseId: row.caseId,
    title: row.title,
    body: row.body,
    authorEmail: row.authorEmail,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Stable newest-first ordering: createdAt desc, then id desc as tiebreak. */
function compareNewestFirst(a: AnnouncementRow, b: AnnouncementRow): number {
  const byCreatedAt = b.createdAt.getTime() - a.createdAt.getTime();
  if (byCreatedAt !== 0) return byCreatedAt;
  return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
}

/**
 * Creates an announcement scoped to exactly one target (CM-90).
 *
 * 1. Enforce the exactly-one-scope rule before touching the database: both
 *    cohortId and caseId set, or neither, throws — mirroring the
 *    admissions_announcements_target_check constraint. The provided scope id
 *    must be uuid-shaped; title and body must be non-empty.
 * 2. Inside one audited transaction, insert the admissions_announcements row
 *    (title trimmed, authorEmail normalized to lowercase).
 * 3. Write one append-only audit row (entityType "announcement", action
 *    "create") whose diff records the chosen scope. The audit row's caseId is
 *    the target case for case-scoped announcements and null for cohort
 *    broadcasts (cross-case action).
 *
 * @returns the created announcement DTO.
 */
export async function createAnnouncement(
  input: CreateAnnouncementInput,
  db: Database = getDb(),
): Promise<AdmissionsAnnouncementDto> {
  const cohortId = input.cohortId ?? null;
  const caseId = input.caseId ?? null;
  if ((cohortId === null) === (caseId === null)) {
    throw new Error("createAnnouncement requires exactly one of cohortId or caseId");
  }
  const scopeId = cohortId ?? caseId;
  if (scopeId === null || !isUuidShaped(scopeId)) {
    throw new Error(`createAnnouncement requires a valid ${cohortId !== null ? "cohortId" : "caseId"}`);
  }
  if (!input.title.trim()) throw new Error("Announcement title must not be empty");
  if (!input.body.trim()) throw new Error("Announcement body must not be empty");
  const actorRole: CaseRole = input.actorRole ?? "counselor";

  return withAuditedTransaction(async (tx) => {
    const rows = await tx
      .insert(admissionsAnnouncements)
      .values({
        cohortId,
        caseId,
        title: input.title.trim(),
        body: input.body,
        authorEmail: input.authorEmail.trim().toLowerCase(),
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to insert announcement");

    await writeAuditLog(tx, {
      caseId,
      actorEmail: input.authorEmail,
      actorRole,
      entityType: "announcement",
      entityId: row.id,
      action: "create",
      diff: cohortId !== null
        ? { cohortId: { old: null, new: cohortId } }
        : { caseId: { old: null, new: caseId } },
    });

    return toAnnouncementDto(row);
  }, db);
}

/**
 * Lists the announcements visible on one case: case-scoped rows merged with
 * the case's cohort broadcasts, newest first (CM-90).
 *
 * 1. Load the case (not soft-deleted) to resolve its cohortId; a miss throws
 *    "NotFound" (routes translate to 404).
 * 2. Fetch non-deleted announcements targeting the case OR its cohort in one
 *    query.
 * 3. Sort in process (createdAt desc, id desc tiebreak) so the merged
 *    ordering never depends on which scope a row came from.
 */
export async function listAnnouncementsForCase(
  caseId: string,
  db: Database = getDb(),
): Promise<AdmissionsAnnouncementDto[]> {
  if (!isUuidShaped(caseId)) throw new Error("NotFound");

  const caseRows = await db
    .select({ cohortId: admissionsCases.cohortId })
    .from(admissionsCases)
    .where(and(eq(admissionsCases.id, caseId), isNull(admissionsCases.deletedAt)))
    .limit(1);
  const caseRow = caseRows[0];
  if (!caseRow) throw new Error("NotFound");

  const rows = await db
    .select()
    .from(admissionsAnnouncements)
    .where(and(
      isNull(admissionsAnnouncements.deletedAt),
      or(
        eq(admissionsAnnouncements.caseId, caseId),
        eq(admissionsAnnouncements.cohortId, caseRow.cohortId),
      ),
    ))
    .orderBy(desc(admissionsAnnouncements.createdAt), desc(admissionsAnnouncements.id));

  return [...rows].sort(compareNewestFirst).map(toAnnouncementDto);
}

/**
 * Lists a cohort's non-deleted broadcast announcements, newest first.
 */
export async function listAnnouncementsForCohort(
  cohortId: string,
  db: Database = getDb(),
): Promise<AdmissionsAnnouncementDto[]> {
  if (!isUuidShaped(cohortId)) throw new Error("NotFound");

  const rows = await db
    .select()
    .from(admissionsAnnouncements)
    .where(and(
      eq(admissionsAnnouncements.cohortId, cohortId),
      isNull(admissionsAnnouncements.deletedAt),
    ))
    .orderBy(desc(admissionsAnnouncements.createdAt), desc(admissionsAnnouncements.id));

  return [...rows].sort(compareNewestFirst).map(toAnnouncementDto);
}

/**
 * Partially updates an announcement's title/body; the mutation and its audit
 * row commit atomically. Scope (cohortId/caseId) is immutable — retargeting
 * an announcement is a delete + create, never an update.
 *
 * 1. Validate any provided title/body is non-empty before touching the
 *    database.
 * 2. Load the announcement (not soft-deleted); a miss throws "NotFound".
 * 3. Diff only the provided fields; when nothing actually changed, return the
 *    current DTO without writing (no empty audit rows).
 * 4. Apply the changed fields plus a fresh updatedAt, then write one audit
 *    row (entityType "announcement", action "update") carrying the field diff.
 *
 * @returns the updated announcement DTO.
 */
export async function updateAnnouncement(
  input: UpdateAnnouncementInput,
  db: Database = getDb(),
): Promise<AdmissionsAnnouncementDto> {
  if (input.title !== undefined && !input.title.trim()) {
    throw new Error("Announcement title must not be empty");
  }
  if (input.body !== undefined && !input.body.trim()) {
    throw new Error("Announcement body must not be empty");
  }

  return withAuditedTransaction(async (tx) => {
    const existingRows = await tx
      .select()
      .from(admissionsAnnouncements)
      .where(and(
        eq(admissionsAnnouncements.id, input.announcementId),
        isNull(admissionsAnnouncements.deletedAt),
      ))
      .limit(1);
    const existing = existingRows[0];
    if (!existing) throw new Error("NotFound");

    const diff = computeFieldDiff(
      existing as unknown as Record<string, unknown>,
      { title: input.title?.trim(), body: input.body },
      ANNOUNCEMENT_DIFF_FIELDS,
    );
    if (Object.keys(diff).length === 0) return toAnnouncementDto(existing);

    const setValues: Partial<typeof admissionsAnnouncements.$inferInsert> = {
      updatedAt: new Date(),
    };
    if ("title" in diff) setValues.title = input.title?.trim();
    if ("body" in diff) setValues.body = input.body;

    const updatedRows = await tx
      .update(admissionsAnnouncements)
      .set(setValues)
      .where(eq(admissionsAnnouncements.id, existing.id))
      .returning();
    const updated = updatedRows[0];
    if (!updated) throw new Error("NotFound");

    await writeAuditLog(tx, {
      caseId: existing.caseId,
      actorEmail: input.actorEmail,
      actorRole: input.actorRole,
      entityType: "announcement",
      entityId: existing.id,
      action: "update",
      diff,
    });

    return toAnnouncementDto(updated);
  }, db);
}

/**
 * Soft-deletes an announcement (sets deletedAt; the row is retained for the
 * audit trail); the mutation and its audit row commit atomically.
 *
 * 1. Load the announcement scoped to not-yet-deleted; a miss — including an
 *    already-deleted row — throws "NotFound" (idempotent from the caller's
 *    perspective: the second delete 404s rather than double-auditing).
 * 2. Stamp deletedAt + updatedAt, then write one audit row (entityType
 *    "announcement", action "delete") recording the deletion instant.
 */
export async function softDeleteAnnouncement(
  input: SoftDeleteAnnouncementInput,
  db: Database = getDb(),
): Promise<void> {
  await withAuditedTransaction(async (tx) => {
    const existingRows = await tx
      .select()
      .from(admissionsAnnouncements)
      .where(and(
        eq(admissionsAnnouncements.id, input.announcementId),
        isNull(admissionsAnnouncements.deletedAt),
      ))
      .limit(1);
    const existing = existingRows[0];
    if (!existing) throw new Error("NotFound");

    const deletedAt = new Date();
    const updatedRows = await tx
      .update(admissionsAnnouncements)
      .set({ deletedAt, updatedAt: deletedAt })
      .where(eq(admissionsAnnouncements.id, existing.id))
      .returning();
    if (!updatedRows[0]) throw new Error("NotFound");

    await writeAuditLog(tx, {
      caseId: existing.caseId,
      actorEmail: input.actorEmail,
      actorRole: input.actorRole,
      entityType: "announcement",
      entityId: existing.id,
      action: "delete",
      diff: { deletedAt: { old: null, new: deletedAt.toISOString() } },
    });
  }, db);
}
