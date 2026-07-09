// Admissions Case Management — membership add/revoke/re-invite/email-change.
//
// Design: docs/casemanagementsystem_design.md §2.4/§3 and PRD CM-05
// (counselor reassignment, co-counseling, and multi-guardian membership are
// membership edits, fully audited). Every mutation runs inside
// withAuditedTransaction so the member write and its audit row (field diffs
// via computeFieldDiff) commit atomically. Fail-closed error contract:
// missing case/member → Error("NotFound"); rule violations (student-as-parent
// without override, duplicate membership, invalid member state) →
// Error("Conflict") — admissionsErrorResponse maps both.

import { and, eq, isNull } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import {
  admissionsCaseMembers,
  admissionsCases,
  admissionsStudents,
} from "@/lib/db/schema";
import {
  computeFieldDiff,
  withAuditedTransaction,
  writeAuditLog,
  type AdmissionsWriteDb,
} from "./audit";
import { sendMemberInviteForCase } from "./notifications";
import type {
  AdmissionsMemberDto,
  AdmissionsMemberStatus,
  AdmissionsRole,
  CaseRole,
} from "./types";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Acting user attributed on audit rows and addedByEmail stamps. */
export interface AdmissionsActor {
  email: string;
  role: CaseRole;
}

type CaseMemberRow = typeof admissionsCaseMembers.$inferSelect;

/** Lowercases and trims an email for storage/comparison (schema stores lowercase). */
export function normalizeAdmissionsEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** Cheap shape check so malformed ids never reach a Postgres uuid cast. */
export function isUuidShaped(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** Serializes an admissions_case_members row to its boundary DTO (ISO timestamps). */
export function mapAdmissionsMemberRow(row: CaseMemberRow): AdmissionsMemberDto {
  return {
    id: row.id,
    caseId: row.caseId,
    email: row.email,
    role: row.role,
    status: row.status,
    invitedAt: row.invitedAt ? row.invitedAt.toISOString() : null,
    activatedAt: row.activatedAt ? row.activatedAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    addedByEmail: row.addedByEmail,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

interface InitialMemberState {
  status: AdmissionsMemberStatus;
  invitedAt: Date | null;
  activatedAt: Date | null;
}

/**
 * Initial membership state by role: counselors are staff and become active
 * immediately; students and parents start invited (invite email pending).
 */
function getInitialMemberState(role: AdmissionsRole, now: Date): InitialMemberState {
  if (role === "counselor") {
    return { status: "active", invitedAt: null, activatedAt: now };
  }
  return { status: "invited", invitedAt: now, activatedAt: null };
}

/**
 * Fire-and-forget invite email for a freshly invited membership (PRD §3.7).
 * Only "invited" rows get an email (counselors activate immediately, no
 * invite); send failures are logged and never thrown — membership writes
 * must never fail because email delivery did.
 */
function dispatchInviteEmail(member: AdmissionsMemberDto, db: Database): void {
  if (member.status !== "invited") return;
  void sendMemberInviteForCase(member, db).catch((error) => {
    console.error("Failed to send admissions member invite email", error);
  });
}

/**
 * Loads the live case's student email (join through admissions_students).
 * Soft-deleted cases/students resolve to null — callers treat that as NotFound.
 */
async function findCaseStudentEmail(
  db: AdmissionsWriteDb,
  caseId: string,
): Promise<string | null> {
  const rows = await db
    .select({ studentEmail: admissionsStudents.studentEmail })
    .from(admissionsCases)
    .innerJoin(admissionsStudents, eq(admissionsCases.studentId, admissionsStudents.id))
    .where(and(
      eq(admissionsCases.id, caseId),
      isNull(admissionsCases.deletedAt),
      isNull(admissionsStudents.deletedAt),
    ))
    .limit(1);
  return rows.length > 0 ? normalizeAdmissionsEmail(rows[0].studentEmail) : null;
}

/**
 * Low-level member insert + paired audit row, for use INSIDE an audited
 * transaction (createCase, addMember, changeMemberEmail).
 *
 * 1. Normalize the email; reject empty.
 * 2. Derive the initial state — counselor → active, student/parent → invited;
 *    `initialStatus: "invited"` forces invited regardless of role (used by
 *    changeMemberEmail, where the new address must re-accept).
 * 3. Insert the row (addedByEmail = actor) and write the paired audit entry.
 *
 * @returns the inserted membership as a DTO.
 */
export async function insertCaseMember(
  tx: AdmissionsWriteDb,
  input: {
    caseId: string;
    email: string;
    role: AdmissionsRole;
    actor: AdmissionsActor;
    initialStatus?: "invited";
  },
): Promise<AdmissionsMemberDto> {
  const email = normalizeAdmissionsEmail(input.email);
  if (!email) throw new Error("Case member email is required");

  const now = new Date();
  const state: InitialMemberState = input.initialStatus === "invited"
    ? { status: "invited", invitedAt: now, activatedAt: null }
    : getInitialMemberState(input.role, now);

  const rows = await tx
    .insert(admissionsCaseMembers)
    .values({
      caseId: input.caseId,
      email,
      role: input.role,
      status: state.status,
      invitedAt: state.invitedAt,
      activatedAt: state.activatedAt,
      addedByEmail: normalizeAdmissionsEmail(input.actor.email),
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error("Case member insert returned no row");

  await writeAuditLog(tx, {
    caseId: input.caseId,
    actorEmail: input.actor.email,
    actorRole: input.actor.role,
    entityType: "case_member",
    entityId: row.id,
    action: "create",
    diff: computeFieldDiff(
      {},
      { email, role: input.role, status: state.status },
      ["email", "role", "status"],
    ),
  });

  return mapAdmissionsMemberRow(row);
}

/**
 * Guard for member payloads: rejects a parent email equal to the case's
 * student email unless adminOverride is set (PRD "same email as both student
 * and parent on one case is rejected at write time"). Routes call this after
 * Zod safeParse — the check needs the database, and the repo's sync
 * safeParse convention cannot await an async refinement.
 *
 * 1. Shape-check caseId and load the case's student email (missing/deleted
 *    case → Error("NotFound")).
 * 2. When any normalized parent email matches the student email and
 *    adminOverride is falsy → Error("Conflict").
 */
export async function rejectStudentAsParent(
  payload: { caseId: string; parentEmails: string[]; adminOverride?: boolean },
  db: Database = getDb(),
): Promise<void> {
  if (!isUuidShaped(payload.caseId)) throw new Error("NotFound");

  const studentEmail = await findCaseStudentEmail(db as AdmissionsWriteDb, payload.caseId);
  if (studentEmail === null) throw new Error("NotFound");

  if (payload.adminOverride) return;

  const collides = payload.parentEmails
    .map(normalizeAdmissionsEmail)
    .some((email) => email.length > 0 && email === studentEmail);
  if (collides) throw new Error("Conflict");
}

/**
 * Adds a parent or counselor member to a case (audited).
 *
 * 1. Shape-check caseId; load the case + student email (miss → NotFound).
 * 2. Reject role "student" — a case has exactly one student membership,
 *    created with the case; the student's address changes via
 *    changeMemberEmail (Conflict).
 * 3. Student-as-parent rule: a parent whose email equals the case's student
 *    email is rejected unless adminOverride (Conflict).
 * 4. Existing (caseId, email) row: none → fresh insert; revoked → reinstate
 *    in place (role + state reset, revokedAt cleared, audited as
 *    "reinstate"); any other status → Conflict (already a member).
 * 5. After the transaction commits, an "invited" membership triggers the
 *    invite email fire-and-forget (PRD §3.7; failures logged, never thrown).
 *
 * @returns the created or reinstated membership DTO.
 */
export async function addMember(
  input: {
    caseId: string;
    email: string;
    role: AdmissionsRole;
    actor: AdmissionsActor;
    adminOverride?: boolean;
  },
  db: Database = getDb(),
): Promise<AdmissionsMemberDto> {
  if (!isUuidShaped(input.caseId)) throw new Error("NotFound");
  const email = normalizeAdmissionsEmail(input.email);
  if (!email) throw new Error("Case member email is required");
  if (input.role === "student") throw new Error("Conflict");

  const member = await withAuditedTransaction(async (tx) => {
    const studentEmail = await findCaseStudentEmail(tx, input.caseId);
    if (studentEmail === null) throw new Error("NotFound");

    if (input.role === "parent" && email === studentEmail && !input.adminOverride) {
      throw new Error("Conflict");
    }

    const existingRows = await tx
      .select()
      .from(admissionsCaseMembers)
      .where(and(
        eq(admissionsCaseMembers.caseId, input.caseId),
        eq(admissionsCaseMembers.email, email),
      ))
      .limit(1);
    const existing = existingRows[0];

    if (!existing) {
      return insertCaseMember(tx, {
        caseId: input.caseId,
        email,
        role: input.role,
        actor: input.actor,
      });
    }

    if (existing.status !== "revoked") throw new Error("Conflict");

    const now = new Date();
    const state = getInitialMemberState(input.role, now);
    await tx
      .update(admissionsCaseMembers)
      .set({
        role: input.role,
        status: state.status,
        invitedAt: state.invitedAt,
        activatedAt: state.activatedAt,
        revokedAt: null,
        addedByEmail: normalizeAdmissionsEmail(input.actor.email),
        updatedAt: now,
      })
      .where(eq(admissionsCaseMembers.id, existing.id));

    await writeAuditLog(tx, {
      caseId: input.caseId,
      actorEmail: input.actor.email,
      actorRole: input.actor.role,
      entityType: "case_member",
      entityId: existing.id,
      action: "reinstate",
      diff: computeFieldDiff(
        {
          role: existing.role,
          status: existing.status,
          revokedAt: existing.revokedAt ? existing.revokedAt.toISOString() : null,
        },
        { role: input.role, status: state.status, revokedAt: null },
        ["role", "status", "revokedAt"],
      ),
    });

    return mapAdmissionsMemberRow({
      ...existing,
      role: input.role,
      status: state.status,
      invitedAt: state.invitedAt,
      activatedAt: state.activatedAt,
      revokedAt: null,
      addedByEmail: normalizeAdmissionsEmail(input.actor.email),
      updatedAt: now,
    });
  }, db);

  dispatchInviteEmail(member, db);
  return member;
}

/**
 * Revokes a case membership (audited). Revocation is instant: active
 * membership queries and requireCaseAccess filter on status "active", so a
 * revoked member loses access on their next request.
 *
 * 1. Shape-check ids; load the member row scoped to THIS case (miss →
 *    NotFound — cross-case memberId tampering never reveals other cases).
 * 2. Already revoked → Conflict.
 * 3. Set status "revoked" + revokedAt, write the paired audit diff.
 *
 * @returns the revoked membership DTO.
 */
export async function revokeMember(
  input: { caseId: string; memberId: string; actor: AdmissionsActor },
  db: Database = getDb(),
): Promise<AdmissionsMemberDto> {
  if (!isUuidShaped(input.caseId) || !isUuidShaped(input.memberId)) {
    throw new Error("NotFound");
  }

  return withAuditedTransaction(async (tx) => {
    const rows = await tx
      .select()
      .from(admissionsCaseMembers)
      .where(and(
        eq(admissionsCaseMembers.id, input.memberId),
        eq(admissionsCaseMembers.caseId, input.caseId),
      ))
      .limit(1);
    const row = rows[0];
    if (!row) throw new Error("NotFound");
    if (row.status === "revoked") throw new Error("Conflict");

    const now = new Date();
    await tx
      .update(admissionsCaseMembers)
      .set({ status: "revoked", revokedAt: now, updatedAt: now })
      .where(eq(admissionsCaseMembers.id, row.id));

    await writeAuditLog(tx, {
      caseId: input.caseId,
      actorEmail: input.actor.email,
      actorRole: input.actor.role,
      entityType: "case_member",
      entityId: row.id,
      action: "revoke",
      diff: computeFieldDiff(
        {
          status: row.status,
          revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
        },
        { status: "revoked", revokedAt: now.toISOString() },
        ["status", "revokedAt"],
      ),
    });

    return mapAdmissionsMemberRow({
      ...row,
      status: "revoked",
      revokedAt: now,
      updatedAt: now,
    });
  }, db);
}

/**
 * Changes a member's email by revoking the old row and creating a fresh
 * invited row for the new address (design §2.4 — history is preserved, the
 * new address must accept its own invite). Both writes are audited.
 *
 * 1. Shape-check ids; load the case's student email (miss → NotFound), then
 *    the member row scoped to this case (miss → NotFound).
 * 2. Revoked member or unchanged email → Conflict.
 * 3. Parent rows: the new email must not equal the case's student email
 *    unless adminOverride (Conflict).
 * 4. Any existing (caseId, newEmail) membership row → Conflict (unique key).
 * 5. Revoke the old row (audited as "email_change" with the email diff) and
 *    insert the new invited row (audited as "create").
 *
 * @returns the newly created invited membership DTO.
 */
export async function changeMemberEmail(
  input: {
    caseId: string;
    memberId: string;
    newEmail: string;
    actor: AdmissionsActor;
    adminOverride?: boolean;
  },
  db: Database = getDb(),
): Promise<AdmissionsMemberDto> {
  if (!isUuidShaped(input.caseId) || !isUuidShaped(input.memberId)) {
    throw new Error("NotFound");
  }
  const newEmail = normalizeAdmissionsEmail(input.newEmail);
  if (!newEmail) throw new Error("Case member email is required");

  return withAuditedTransaction(async (tx) => {
    const studentEmail = await findCaseStudentEmail(tx, input.caseId);
    if (studentEmail === null) throw new Error("NotFound");

    const rows = await tx
      .select()
      .from(admissionsCaseMembers)
      .where(and(
        eq(admissionsCaseMembers.id, input.memberId),
        eq(admissionsCaseMembers.caseId, input.caseId),
      ))
      .limit(1);
    const row = rows[0];
    if (!row) throw new Error("NotFound");
    if (row.status === "revoked") throw new Error("Conflict");
    if (row.email === newEmail) throw new Error("Conflict");

    if (row.role === "parent" && newEmail === studentEmail && !input.adminOverride) {
      throw new Error("Conflict");
    }

    const duplicateRows = await tx
      .select({ id: admissionsCaseMembers.id })
      .from(admissionsCaseMembers)
      .where(and(
        eq(admissionsCaseMembers.caseId, input.caseId),
        eq(admissionsCaseMembers.email, newEmail),
      ))
      .limit(1);
    if (duplicateRows.length > 0) throw new Error("Conflict");

    const now = new Date();
    await tx
      .update(admissionsCaseMembers)
      .set({ status: "revoked", revokedAt: now, updatedAt: now })
      .where(eq(admissionsCaseMembers.id, row.id));

    await writeAuditLog(tx, {
      caseId: input.caseId,
      actorEmail: input.actor.email,
      actorRole: input.actor.role,
      entityType: "case_member",
      entityId: row.id,
      action: "email_change",
      diff: computeFieldDiff(
        { status: row.status, email: row.email },
        { status: "revoked", email: newEmail },
        ["status", "email"],
      ),
    });

    return insertCaseMember(tx, {
      caseId: input.caseId,
      email: newEmail,
      role: row.role,
      actor: input.actor,
      initialStatus: "invited",
    });
  }, db);
}

/**
 * Re-sends an invite by stamping a fresh invitedAt on an invited or bounced
 * membership (audited). Active members need no invite and revoked members
 * must be re-added via addMember — both Conflict. After the transaction
 * commits, the invite email is re-sent fire-and-forget (PRD §3.7 one-click
 * re-invite; failures logged, never thrown).
 *
 * @returns the updated membership DTO.
 */
export async function reInvite(
  input: { caseId: string; memberId: string; actor: AdmissionsActor },
  db: Database = getDb(),
): Promise<AdmissionsMemberDto> {
  if (!isUuidShaped(input.caseId) || !isUuidShaped(input.memberId)) {
    throw new Error("NotFound");
  }

  const member = await withAuditedTransaction(async (tx) => {
    const rows = await tx
      .select()
      .from(admissionsCaseMembers)
      .where(and(
        eq(admissionsCaseMembers.id, input.memberId),
        eq(admissionsCaseMembers.caseId, input.caseId),
      ))
      .limit(1);
    const row = rows[0];
    if (!row) throw new Error("NotFound");
    if (row.status !== "invited" && row.status !== "bounced") throw new Error("Conflict");

    const now = new Date();
    await tx
      .update(admissionsCaseMembers)
      .set({ status: "invited", invitedAt: now, updatedAt: now })
      .where(eq(admissionsCaseMembers.id, row.id));

    await writeAuditLog(tx, {
      caseId: input.caseId,
      actorEmail: input.actor.email,
      actorRole: input.actor.role,
      entityType: "case_member",
      entityId: row.id,
      action: "reinvite",
      diff: computeFieldDiff(
        {
          status: row.status,
          invitedAt: row.invitedAt ? row.invitedAt.toISOString() : null,
        },
        { status: "invited", invitedAt: now.toISOString() },
        ["status", "invitedAt"],
      ),
    });

    return mapAdmissionsMemberRow({
      ...row,
      status: "invited",
      invitedAt: now,
      updatedAt: now,
    });
  }, db);

  dispatchInviteEmail(member, db);
  return member;
}

/**
 * Active memberships for a case (status "active" only) — revoked, invited,
 * and bounced rows are excluded, so revocation disappears from this view
 * immediately. Malformed caseId fails closed to an empty list.
 */
export async function getActiveCaseMembers(
  caseId: string,
  db: Database = getDb(),
): Promise<AdmissionsMemberDto[]> {
  if (!isUuidShaped(caseId)) return [];

  const rows = await db
    .select()
    .from(admissionsCaseMembers)
    .where(eq(admissionsCaseMembers.caseId, caseId));

  return rows
    .filter((row) => row.status === "active")
    .map(mapAdmissionsMemberRow);
}
