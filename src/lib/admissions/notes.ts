// Admissions Case Management — case notes with explicit visibility enforcement.
//
// Design: docs/casemanagementsystem_design.md §1 (notes.ts owns visibility
// enforcement) and §3 (admissions_notes.visibility is NOT NULL with no
// default — every write carries an explicit choice; visibility mutations are
// transactional + audited). PRD CM-91. staff_only rows reach ONLY
// counselor/admin readers — enforced in the SQL filter AND re-checked on the
// fetched rows (defense in depth, fail-closed).

import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import { admissionsNotes } from "@/lib/db/schema";
import { roleAtLeast } from "./config";
import { computeFieldDiff, withAuditedTransaction, writeAuditLog } from "./audit";
import type { AdmissionsNoteDto, AdmissionsNoteVisibility, CaseRole } from "./types";

/** All valid note visibilities, for boundary validation. */
export const ADMISSIONS_NOTE_VISIBILITIES: readonly AdmissionsNoteVisibility[] = [
  "staff_only",
  "shared_with_family",
];

type NoteRow = typeof admissionsNotes.$inferSelect;

/** Input for createNote; visibility is mandatory — there is NO default. */
export interface CreateNoteInput {
  caseId: string;
  authorEmail: string;
  actorRole: CaseRole;
  body: string;
  visibility: AdmissionsNoteVisibility;
}

/** Input for updateNoteVisibility; actor fields feed the paired audit row. */
export interface UpdateNoteVisibilityInput {
  caseId: string;
  noteId: string;
  actorEmail: string;
  actorRole: CaseRole;
  visibility: AdmissionsNoteVisibility;
}

function toNoteDto(row: NoteRow): AdmissionsNoteDto {
  return {
    id: row.id,
    caseId: row.caseId,
    authorEmail: row.authorEmail,
    body: row.body,
    visibility: row.visibility,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function assertNoteVisibility(value: unknown): asserts value is AdmissionsNoteVisibility {
  if (!ADMISSIONS_NOTE_VISIBILITIES.includes(value as AdmissionsNoteVisibility)) {
    throw new Error(
      'Note visibility is required and must be "staff_only" or "shared_with_family"',
    );
  }
}

/**
 * Creates a case note with an EXPLICIT visibility (CM-91).
 *
 * 1. Reject any missing/unknown visibility before touching the database —
 *    there is deliberately no default, matching the NOT-NULL-no-default
 *    column; a blank body is also rejected.
 * 2. Inside one audited transaction, insert the admissions_notes row
 *    (authorEmail normalized to lowercase).
 * 3. Write one append-only audit row (entityType "note", action "create")
 *    whose diff records the chosen visibility, so the initial audience
 *    decision is inspectable later.
 *
 * @returns the created note DTO.
 */
export async function createNote(
  input: CreateNoteInput,
  db: Database = getDb(),
): Promise<AdmissionsNoteDto> {
  assertNoteVisibility(input.visibility);
  if (!input.body.trim()) throw new Error("Note body must not be empty");

  return withAuditedTransaction(async (tx) => {
    const rows = await tx
      .insert(admissionsNotes)
      .values({
        caseId: input.caseId,
        authorEmail: input.authorEmail.trim().toLowerCase(),
        body: input.body,
        visibility: input.visibility,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to insert note");

    await writeAuditLog(tx, {
      caseId: input.caseId,
      actorEmail: input.authorEmail,
      actorRole: input.actorRole,
      entityType: "note",
      entityId: row.id,
      action: "create",
      diff: { visibility: { old: null, new: row.visibility } },
    });

    return toNoteDto(row);
  }, db);
}

/**
 * Lists a case's non-deleted notes shaped for the reader's role (CM-91),
 * newest first.
 *
 * 1. Staff readers (counselor/admin via roleAtLeast) see every note; family
 *    readers (student/parent) are restricted to shared_with_family in the
 *    SQL where clause.
 * 2. Fetched rows are filtered AGAIN in process for non-staff readers, so a
 *    future query edit cannot leak staff_only rows (fail-closed defense in
 *    depth).
 * 3. Rows map through the explicit DTO whitelist — internal columns such as
 *    deletedAt never reach the caller.
 */
export async function listNotesForRole(
  caseId: string,
  role: CaseRole,
  db: Database = getDb(),
): Promise<AdmissionsNoteDto[]> {
  const isStaff = roleAtLeast(role, "counselor");
  const baseFilter = and(
    eq(admissionsNotes.caseId, caseId),
    isNull(admissionsNotes.deletedAt),
  );
  const filter = isStaff
    ? baseFilter
    : and(baseFilter, eq(admissionsNotes.visibility, "shared_with_family"));

  const rows = await db
    .select()
    .from(admissionsNotes)
    .where(filter)
    .orderBy(desc(admissionsNotes.createdAt));

  const visible = isStaff
    ? rows
    : rows.filter((row) => row.visibility === "shared_with_family");
  return visible.map(toNoteDto);
}

/**
 * Changes a note's visibility; the mutation and its audit row commit
 * atomically (visibility changes are sensitive — design §3 transactions list).
 *
 * 1. Reject unknown target visibilities before touching the database.
 * 2. Load the note scoped to (noteId, caseId, not soft-deleted); a miss
 *    throws "NotFound" — the caseId scope stops cross-case noteId probing.
 * 3. When the visibility is already the target, return the current DTO
 *    without writing (no empty audit rows).
 * 4. Update visibility plus a fresh updatedAt, then write one audit row
 *    (entityType "note", action "visibility_change") carrying the
 *    {old, new} visibility diff.
 *
 * @returns the updated note DTO.
 */
export async function updateNoteVisibility(
  input: UpdateNoteVisibilityInput,
  db: Database = getDb(),
): Promise<AdmissionsNoteDto> {
  assertNoteVisibility(input.visibility);

  return withAuditedTransaction(async (tx) => {
    const existingRows = await tx
      .select()
      .from(admissionsNotes)
      .where(and(
        eq(admissionsNotes.id, input.noteId),
        eq(admissionsNotes.caseId, input.caseId),
        isNull(admissionsNotes.deletedAt),
      ))
      .limit(1);
    const existing = existingRows[0];
    if (!existing) throw new Error("NotFound");
    if (existing.visibility === input.visibility) return toNoteDto(existing);

    const updatedRows = await tx
      .update(admissionsNotes)
      .set({ visibility: input.visibility, updatedAt: new Date() })
      .where(eq(admissionsNotes.id, existing.id))
      .returning();
    const updated = updatedRows[0];
    if (!updated) throw new Error("NotFound");

    await writeAuditLog(tx, {
      caseId: input.caseId,
      actorEmail: input.actorEmail,
      actorRole: input.actorRole,
      entityType: "note",
      entityId: existing.id,
      action: "visibility_change",
      diff: computeFieldDiff(
        { visibility: existing.visibility },
        { visibility: updated.visibility },
        ["visibility"],
      ),
    });

    return toNoteDto(updated);
  }, db);
}
