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

import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import {
  admissionsCaseMembers,
  admissionsCases,
  admissionsCounselors,
  admissionsNotificationOutbox,
  admissionsStudents,
} from "@/lib/db/schema";
import {
  computeFieldDiff,
  withAuditedTransaction,
  writeAuditLog,
  type AdmissionsWriteDb,
} from "./audit";
import {
  deliverAdmissionsOutboxBestEffort,
  deriveStudentFirstName,
  queueMemberInviteOutbox,
} from "./notifications";
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

/** Ensures an optimistic-concurrency token always advances at millisecond precision. */
function nextMutationTimestamp(previous: Date): Date {
  return new Date(Math.max(Date.now(), previous.getTime() + 1));
}

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

interface CaseStudentContext {
  studentId: string;
  studentEmail: string;
  fullName: string;
  preferredName: string | null;
  familyPortalOpen: boolean;
}

/**
 * Loads the live case's student email (join through admissions_students).
 * Soft-deleted cases/students resolve to null — callers treat that as NotFound.
 */
async function findCaseStudentContext(
  db: AdmissionsWriteDb,
  caseId: string,
): Promise<CaseStudentContext | null> {
  const rows = await db
    .select({
      studentId: admissionsStudents.id,
      studentEmail: admissionsStudents.studentEmail,
      fullName: admissionsStudents.fullName,
      preferredName: admissionsStudents.preferredName,
      familyPortalOpen: admissionsCases.familyPortalOpen,
    })
    .from(admissionsCases)
    .innerJoin(admissionsStudents, eq(admissionsCases.studentId, admissionsStudents.id))
    .where(and(
      eq(admissionsCases.id, caseId),
      isNull(admissionsCases.deletedAt),
      isNull(admissionsStudents.deletedAt),
    ))
    .limit(1);
  if (rows.length === 0) return null;
  return {
    studentId: rows[0].studentId,
    studentEmail: normalizeAdmissionsEmail(rows[0].studentEmail),
    fullName: rows[0].fullName,
    preferredName: rows[0].preferredName,
    familyPortalOpen: rows[0].familyPortalOpen,
  };
}

async function findCaseStudentEmail(
  db: AdmissionsWriteDb,
  caseId: string,
): Promise<string | null> {
  return (await findCaseStudentContext(db, caseId))?.studentEmail ?? null;
}

async function assertActiveCounselorEmail(
  db: AdmissionsWriteDb,
  email: string,
): Promise<void> {
  const rows = await db.select({ id: admissionsCounselors.id })
    .from(admissionsCounselors)
    .where(and(
      eq(admissionsCounselors.email, normalizeAdmissionsEmail(email)),
      eq(admissionsCounselors.active, true),
    ))
    .limit(1);
  if (!rows[0]) throw new Error("Conflict");
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

async function queueFamilyInvite(
  tx: AdmissionsWriteDb,
  input: {
    member: AdmissionsMemberDto;
    student: Pick<CaseStudentContext, "fullName" | "preferredName">;
    reason: "member-add" | "email-change" | "reinvite";
    now: Date;
    /** Stable request token used to collapse retries of one re-invite action. */
    dedupeToken?: string;
  },
): Promise<string | null> {
  if (
    (input.member.role !== "student" && input.member.role !== "parent") ||
    input.member.status !== "invited"
  ) {
    return null;
  }
  return queueMemberInviteOutbox(tx, {
    caseId: input.member.caseId,
    memberId: input.member.id,
    recipientEmail: input.member.email,
    studentFirstName: deriveStudentFirstName(input.student),
    dedupeKey: `member-invite:${input.reason}:${input.member.id}:${input.dedupeToken ?? input.now.toISOString()}`,
    now: input.now,
  });
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
 * 1. Shape-check caseId; load the case, student, and family-portal state
 *    (miss → NotFound).
 * 2. Reject role "student" — a case has exactly one student membership,
 *    created with the case; the student's address changes via
 *    changeMemberEmail (Conflict).
 * 3. Student-as-parent rule: a parent whose email equals the case's student
 *    email is rejected unless adminOverride (Conflict).
 * 4. Existing (caseId, email) row: none → fresh insert; revoked → reinstate
 *    in place (role + state reset, revokedAt cleared, audited as
 *    "reinstate"); any other status → Conflict (already a member).
 * 5. When the family portal is open, a new/reinstated parent invitation is
 *    queued in the same transaction. Delivery is attempted after commit and
 *    failures remain retryable by the notification cron.
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

  const mutation = await withAuditedTransaction(async (tx) => {
    const student = await findCaseStudentContext(tx, input.caseId);
    if (student === null) throw new Error("NotFound");

    if (input.role === "counselor") {
      await assertActiveCounselorEmail(tx, email);
    }

    if (input.role === "parent" && email === student.studentEmail && !input.adminOverride) {
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
      const member = await insertCaseMember(tx, {
        caseId: input.caseId,
        email,
        role: input.role,
        actor: input.actor,
      });
      const now = new Date();
      const queuedOutboxId = student.familyPortalOpen
        ? await queueFamilyInvite(tx, { member, student, reason: "member-add", now })
        : null;
      return { member, queuedOutboxId };
    }

    if (existing.status !== "revoked") throw new Error("Conflict");

    const now = nextMutationTimestamp(existing.updatedAt);
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

    const member = mapAdmissionsMemberRow({
      ...existing,
      role: input.role,
      status: state.status,
      invitedAt: state.invitedAt,
      activatedAt: state.activatedAt,
      revokedAt: null,
      addedByEmail: normalizeAdmissionsEmail(input.actor.email),
      updatedAt: now,
    });
    const queuedOutboxId = student.familyPortalOpen
      ? await queueFamilyInvite(tx, { member, student, reason: "member-add", now })
      : null;
    return { member, queuedOutboxId };
  }, db);

  if (mutation.queuedOutboxId) {
    await deliverAdmissionsOutboxBestEffort([mutation.queuedOutboxId], db);
  }
  return mutation.member;
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
      .limit(1)
      .for("update");
    const row = rows[0];
    if (!row) throw new Error("NotFound");
    if (row.status === "revoked") throw new Error("Conflict");
    if (row.role === "student") throw new Error("Conflict");

    const now = nextMutationTimestamp(row.updatedAt);
    const updatedRows = await tx
      .update(admissionsCaseMembers)
      .set({ status: "revoked", revokedAt: now, updatedAt: now })
      .where(and(
        eq(admissionsCaseMembers.id, row.id),
        eq(admissionsCaseMembers.status, row.status),
        eq(admissionsCaseMembers.updatedAt, row.updatedAt),
      ))
      .returning({ id: admissionsCaseMembers.id });
    if (!updatedRows[0]) throw new Error("Conflict");

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
 *    insert a replacement. Family roles start invited; a registry-validated
 *    counselor starts active because counselors do not use family invites.
 *    For the student role, update the canonical admissions_students email in
 *    the same transaction. When the family portal is open, queue the
 *    replacement family invite in that transaction and attempt delivery after
 *    commit.
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

  const mutation = await withAuditedTransaction(async (tx) => {
    const student = await findCaseStudentContext(tx, input.caseId);
    if (student === null) throw new Error("NotFound");

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

    if (row.role === "counselor") {
      await assertActiveCounselorEmail(tx, newEmail);
    }

    if (row.role === "parent" && newEmail === student.studentEmail && !input.adminOverride) {
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

    const now = nextMutationTimestamp(row.updatedAt);
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

    if (row.role === "student") {
      await tx
        .update(admissionsStudents)
        .set({ studentEmail: newEmail, updatedAt: now })
        .where(eq(admissionsStudents.id, student.studentId));
      await writeAuditLog(tx, {
        caseId: input.caseId,
        actorEmail: input.actor.email,
        actorRole: input.actor.role,
        entityType: "student",
        entityId: student.studentId,
        action: "email_change",
        diff: {
          studentEmail: { old: student.studentEmail, new: newEmail },
        },
      });
    }

    const member = await insertCaseMember(tx, {
      caseId: input.caseId,
      email: newEmail,
      role: row.role,
      actor: input.actor,
      ...(row.role === "counselor" ? {} : { initialStatus: "invited" as const }),
    });
    const queuedOutboxId =
      student.familyPortalOpen && (member.role === "student" || member.role === "parent")
        ? await queueFamilyInvite(tx, { member, student, reason: "email-change", now })
        : null;
    return { member, queuedOutboxId };
  }, db);

  if (mutation.queuedOutboxId) {
    await deliverAdmissionsOutboxBestEffort([mutation.queuedOutboxId], db);
  }
  return mutation.member;
}

/**
 * Re-sends an invite by stamping a fresh invitedAt on an invited or bounced
 * membership (audited). Active members need no invite and revoked members
 * must be re-added via addMember; a closed family portal cannot send a usable
 * family invite — all three cases return Conflict. The retryable invitation
 * is queued in the same transaction and attempted immediately after commit.
 * The caller supplies the membership updatedAt it observed; that token both
 * protects the row update and gives retries of one action a stable outbox
 * key, so concurrent requests cannot enqueue duplicate invitations.
 *
 * @returns the updated membership DTO.
 */
export async function reInvite(
  input: {
    caseId: string;
    memberId: string;
    actor: AdmissionsActor;
    /** Membership updatedAt observed by the caller; also scopes outbox idempotency. */
    expectedUpdatedAt: string;
  },
  db: Database = getDb(),
): Promise<AdmissionsMemberDto> {
  if (!isUuidShaped(input.caseId) || !isUuidShaped(input.memberId)) {
    throw new Error("NotFound");
  }

  const mutation = await withAuditedTransaction(async (tx) => {
    const rows = await tx
      .select()
      .from(admissionsCaseMembers)
      .where(and(
        eq(admissionsCaseMembers.id, input.memberId),
        eq(admissionsCaseMembers.caseId, input.caseId),
      ))
      .limit(1)
      .for("update");
    const row = rows[0];
    if (!row) throw new Error("NotFound");
    if (row.status !== "invited" && row.status !== "bounced") throw new Error("Conflict");

    const dedupeToken = input.expectedUpdatedAt.trim();
    if (!dedupeToken) throw new Error("Conflict");
    const dedupeKey = `member-invite:reinvite:${row.id}:${dedupeToken}`;

    // A retried request carries the same observed updatedAt. Once the first
    // transaction commits, the row token changes, but its stable outbox key
    // proves this exact action already committed. Return the current member
    // without a second audit row, timestamp write, or delivery attempt.
    if (row.updatedAt.toISOString() !== dedupeToken) {
      const replayRows = await tx
        .select({ id: admissionsNotificationOutbox.id })
        .from(admissionsNotificationOutbox)
        .where(and(
          eq(admissionsNotificationOutbox.caseId, input.caseId),
          eq(admissionsNotificationOutbox.memberId, row.id),
          eq(admissionsNotificationOutbox.dedupeKey, dedupeKey),
        ))
        .limit(1);
      if (!replayRows[0]) throw new Error("Conflict");
      return { member: mapAdmissionsMemberRow(row), queuedOutboxId: null as string | null };
    }

    const now = nextMutationTimestamp(row.updatedAt);
    const updatedRows = await tx
      .update(admissionsCaseMembers)
      .set({ status: "invited", invitedAt: now, updatedAt: now })
      .where(and(
        eq(admissionsCaseMembers.id, row.id),
        inArray(admissionsCaseMembers.status, ["invited", "bounced"]),
        eq(admissionsCaseMembers.updatedAt, row.updatedAt),
      ))
      .returning({ id: admissionsCaseMembers.id });
    if (!updatedRows[0]) throw new Error("Conflict");

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

    const member = mapAdmissionsMemberRow({
      ...row,
      status: "invited",
      invitedAt: now,
      updatedAt: now,
    });
    if (member.role !== "student" && member.role !== "parent") {
      return { member, queuedOutboxId: null as string | null };
    }
    const student = await findCaseStudentContext(tx, input.caseId);
    if (student === null) throw new Error("NotFound");
    if (!student.familyPortalOpen) throw new Error("Conflict");
    const queuedOutboxId = await queueFamilyInvite(tx, {
      member,
      student,
      reason: "reinvite",
      now,
      dedupeToken,
    });
    return { member, queuedOutboxId };
  }, db);

  if (mutation.queuedOutboxId) {
    await deliverAdmissionsOutboxBestEffort([mutation.queuedOutboxId], db);
  }
  return mutation.member;
}

/**
 * Activates every invited/bounced membership held by an email (PRD §3.7
 * "Access activates only on exact email match"). Called from the sign-in
 * callback (src/lib/auth.ts) BEFORE access resolution, so a freshly invited
 * student or parent signing in with the exact invited address flips to
 * "active" and passes resolveAdmissionsRole / requireCaseAccess (both filter
 * on status "active") on the same request. Bounced rows activate too — the
 * exact-email OAuth sign-in is stronger delivery proof than the bounce.
 *
 * 1. Normalize the email; empty → no-op ([]).
 * 2. Inside one audited transaction, lock the email's eligible invited/
 *    bounced rows, then flip each row to "active" + stamp
 *    activatedAt. The UPDATE re-checks status IN (invited, bounced) so a
 *    concurrent revoke is never overwritten (fail-closed), and each flip
 *    writes a paired "activate" audit row attributed to the member.
 * 3. Revoked and already-active rows are never touched.
 *
 * @returns the activated membership DTOs (empty when nothing was pending).
 */
export async function activateMembershipsForEmail(
  email: string,
  db: Database = getDb(),
): Promise<AdmissionsMemberDto[]> {
  const normalized = normalizeAdmissionsEmail(email);
  if (!normalized) return [];

  return withAuditedTransaction(async (tx) => {
    // Select and lock inside the transaction. The old pre-transaction read
    // allowed a revoke between the read and update, which could then be
    // overwritten by sign-in activation.
    const pendingRows = await tx
      .select({
        id: admissionsCaseMembers.id,
        caseId: admissionsCaseMembers.caseId,
        email: admissionsCaseMembers.email,
        role: admissionsCaseMembers.role,
        status: admissionsCaseMembers.status,
        invitedAt: admissionsCaseMembers.invitedAt,
        activatedAt: admissionsCaseMembers.activatedAt,
        revokedAt: admissionsCaseMembers.revokedAt,
        addedByEmail: admissionsCaseMembers.addedByEmail,
        notificationPrefs: admissionsCaseMembers.notificationPrefs,
        createdAt: admissionsCaseMembers.createdAt,
        updatedAt: admissionsCaseMembers.updatedAt,
      })
      .from(admissionsCaseMembers)
      .innerJoin(admissionsCases, eq(admissionsCaseMembers.caseId, admissionsCases.id))
      .where(and(
        eq(admissionsCaseMembers.email, normalized),
        inArray(admissionsCaseMembers.status, ["invited", "bounced"]),
        inArray(admissionsCaseMembers.role, ["student", "parent"]),
        eq(admissionsCases.familyPortalOpen, true),
        inArray(admissionsCases.status, ["active", "committed", "completed"]),
        isNull(admissionsCases.deletedAt),
      ))
      .for("update");
    if (pendingRows.length === 0) return [];

    const activated: AdmissionsMemberDto[] = [];
    for (const row of pendingRows) {
      const now = nextMutationTimestamp(row.updatedAt);
      const updatedRows = await tx
        .update(admissionsCaseMembers)
        .set({ status: "active", activatedAt: now, updatedAt: now })
        .where(and(
          eq(admissionsCaseMembers.id, row.id),
          inArray(admissionsCaseMembers.status, ["invited", "bounced"]),
          eq(admissionsCaseMembers.updatedAt, row.updatedAt),
        ))
        .returning({ id: admissionsCaseMembers.id });
      if (!updatedRows[0]) continue;

      await writeAuditLog(tx, {
        caseId: row.caseId,
        actorEmail: normalized,
        actorRole: row.role,
        entityType: "case_member",
        entityId: row.id,
        action: "activate",
        diff: computeFieldDiff(
          {
            status: row.status,
            activatedAt: row.activatedAt ? row.activatedAt.toISOString() : null,
          },
          { status: "active", activatedAt: now.toISOString() },
          ["status", "activatedAt"],
        ),
      });

      activated.push(mapAdmissionsMemberRow({
        ...row,
        status: "active",
        activatedAt: now,
        updatedAt: now,
      }));
    }
    return activated;
  }, db);
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
