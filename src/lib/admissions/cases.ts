// Admissions Case Management — case creation, caseload queries, case detail,
// and lifecycle transitions.
//
// Design: docs/casemanagementsystem_design.md §1 (module map), §3 (data
// model), §8 (lifecycle) and PRD CM-01..CM-05. Mutations run inside
// withAuditedTransaction so the write and its audit row commit atomically.
// Fail-closed: caseload access resolves to empty results for anyone who is
// neither an admin nor an active registry counselor; unknown transitions →
// Error("Conflict"); missing cases → Error("NotFound").
//
// Phase-1 placeholders (checklists/colleges land in later phases):
// progressPercent is 0 and nextDeadline is null until the checklist and
// college modules provide real projections.

import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import {
  adminUsers,
  admissionsCaseMeetings,
  admissionsCaseMembers,
  admissionsCases,
  admissionsCohorts,
  admissionsCollegeListItems,
  admissionsCounselors,
  admissionsStudents,
} from "@/lib/db/schema";
import { todayBangkok } from "@/lib/room-capacity/dates";
import {
  computeFieldDiff,
  withAuditedTransaction,
  writeAuditLog,
  type AdmissionsWriteDb,
} from "./audit";
import {
  insertCaseMember,
  isUuidShaped,
  mapAdmissionsMemberRow,
  normalizeAdmissionsEmail,
  type AdmissionsActor,
} from "./members";
import type {
  AdmissionsCaseDetail,
  AdmissionsCaseStatus,
  AdmissionsCaseSummary,
  AdmissionsMemberDto,
} from "./types";

const MS_PER_DAY = 86_400_000;

/**
 * Valid lifecycle transitions (design §8 / PRD §5):
 * active → committed → completed | active → withdrawn |
 * completed/withdrawn → archived. Everything else — including same-status
 * writes and anything out of archived — is rejected with Error("Conflict").
 */
export const CASE_LIFECYCLE_TRANSITIONS: Record<
  AdmissionsCaseStatus,
  readonly AdmissionsCaseStatus[]
> = {
  active: ["committed", "withdrawn"],
  committed: ["completed"],
  completed: ["archived"],
  withdrawn: ["archived"],
  archived: [],
};

/** Returns true when `from` → `to` is a legal case lifecycle transition. */
export function isValidCaseTransition(
  from: AdmissionsCaseStatus,
  to: AdmissionsCaseStatus,
): boolean {
  return CASE_LIFECYCLE_TRANSITIONS[from].includes(to);
}

/** Student identity fields captured at case creation (PRD CM-01). */
export interface CreateCaseStudentInput {
  fullName: string;
  preferredName?: string | null;
  studentEmail: string;
  phone?: string | null;
  school?: string | null;
  schoolCounselor?: string | null;
  wiseStudentKey?: string | null;
}

/** createCase input (PRD CM-01: student, parent email(s), counselor(s)). */
export interface CreateCaseInput {
  student: CreateCaseStudentInput;
  cohortId: string;
  parentEmails: string[];
  counselorEmails: string[];
  createdBy: AdmissionsActor;
}

/** createCase result: the new case, its student, and all membership rows. */
export interface CreateCaseResult {
  caseId: string;
  studentId: string;
  members: AdmissionsMemberDto[];
}

/**
 * Creates a case with its student and memberships in one audited transaction
 * (PRD CM-01).
 *
 * 1. Normalize + dedupe all emails; reject a parent email equal to the
 *    student email and any counselor/family overlap (Conflict — the member
 *    unique key and the student≠parent rule both forbid it). At least one
 *    counselor is required.
 * 2. Link an existing admissions_students row by studentEmail, or insert a
 *    new one from the provided fields (existing rows are linked as-is, not
 *    updated).
 * 3. Linked students must not already have a live (active/committed) case —
 *    Conflict (mirrors the partial unique index).
 * 4. Insert the case (status "active") and audit it.
 * 5. Insert memberships: student invited, parents invited, counselors active
 *    — each with its own audit row (CM-05).
 *
 * @returns the new caseId, studentId, and membership DTOs.
 */
export async function createCase(
  input: CreateCaseInput,
  db: Database = getDb(),
): Promise<CreateCaseResult> {
  const fullName = input.student.fullName.trim();
  const studentEmail = normalizeAdmissionsEmail(input.student.studentEmail);
  if (!fullName || !studentEmail) {
    throw new Error("createCase requires student fullName and studentEmail");
  }
  if (!isUuidShaped(input.cohortId)) {
    throw new Error("createCase requires a valid cohortId");
  }

  const parentEmails = dedupeEmails(input.parentEmails);
  const counselorEmails = dedupeEmails(input.counselorEmails);
  if (counselorEmails.length === 0) {
    throw new Error("createCase requires at least one counselor email");
  }

  // Student≠parent (PRD write-time rule) and cross-role duplicates both
  // violate the (caseId, email) unique key — fail closed before writing.
  if (parentEmails.includes(studentEmail)) throw new Error("Conflict");
  const familyEmails = new Set([studentEmail, ...parentEmails]);
  if (counselorEmails.some((email) => familyEmails.has(email))) {
    throw new Error("Conflict");
  }

  return withAuditedTransaction(async (tx) => {
    const studentId = await findOrCreateStudent(tx, {
      ...input.student,
      fullName,
      studentEmail,
      cohortId: input.cohortId,
    });

    const caseRows = await tx
      .insert(admissionsCases)
      .values({
        studentId,
        cohortId: input.cohortId,
        status: "active",
        statusChangedAt: new Date(),
      })
      .returning();
    const caseRow = caseRows[0];
    if (!caseRow) throw new Error("Case insert returned no row");

    await writeAuditLog(tx, {
      caseId: caseRow.id,
      actorEmail: input.createdBy.email,
      actorRole: input.createdBy.role,
      entityType: "case",
      entityId: caseRow.id,
      action: "create",
      diff: computeFieldDiff(
        {},
        { studentId, cohortId: input.cohortId, status: "active" },
        ["studentId", "cohortId", "status"],
      ),
    });

    const members: AdmissionsMemberDto[] = [];
    members.push(await insertCaseMember(tx, {
      caseId: caseRow.id,
      email: studentEmail,
      role: "student",
      actor: input.createdBy,
    }));
    for (const email of parentEmails) {
      members.push(await insertCaseMember(tx, {
        caseId: caseRow.id,
        email,
        role: "parent",
        actor: input.createdBy,
      }));
    }
    for (const email of counselorEmails) {
      members.push(await insertCaseMember(tx, {
        caseId: caseRow.id,
        email,
        role: "counselor",
        actor: input.createdBy,
      }));
    }

    return { caseId: caseRow.id, studentId, members };
  }, db);
}

/**
 * Caseload rows for the /admissions table + board (PRD CM-02/CM-03).
 * Admins see all live cases; counselors see only cases where they hold an
 * ACTIVE counselor membership AND their registry row is active. Anyone else
 * — including revoked counselors — fails closed to an empty list.
 *
 * 1. Resolve viewer scope: admin_users → all cases; otherwise an active
 *    admissions_counselors registry row is required, and the viewer's
 *    memberships are filtered to role "counselor" + status "active" (a
 *    revoked membership disappears from the caseload immediately).
 * 2. Load live cases (case + student + cohort, soft-deletes excluded).
 * 3. Enrich: active counselor members per case, registry display names
 *    (email fallback), latest meeting date (days-since-last-touch, Bangkok
 *    days), and the committed college name when set.
 * 4. progressPercent = 0 and nextDeadline = null (phase-1 placeholders).
 *
 * @returns summaries sorted by updatedAt (newest first), then student name.
 */
export async function getCaseloadForUser(
  email: string,
  db: Database = getDb(),
  now: Date = new Date(),
): Promise<AdmissionsCaseSummary[]> {
  const normalized = normalizeAdmissionsEmail(email);
  if (!normalized) return [];

  const adminRows = await db
    .select({ id: adminUsers.id })
    .from(adminUsers)
    .where(eq(adminUsers.email, normalized))
    .limit(1);
  const isAdmin = adminRows.length > 0;

  let scopedCaseIds: string[] | null = null;
  if (!isAdmin) {
    const registryRows = await db
      .select({ id: admissionsCounselors.id })
      .from(admissionsCounselors)
      .where(and(
        eq(admissionsCounselors.email, normalized),
        eq(admissionsCounselors.active, true),
      ))
      .limit(1);
    if (registryRows.length === 0) return [];

    const membershipRows = await db
      .select({
        caseId: admissionsCaseMembers.caseId,
        role: admissionsCaseMembers.role,
        status: admissionsCaseMembers.status,
      })
      .from(admissionsCaseMembers)
      .where(eq(admissionsCaseMembers.email, normalized));
    scopedCaseIds = membershipRows
      .filter((row) => row.role === "counselor" && row.status === "active")
      .map((row) => row.caseId);
    if (scopedCaseIds.length === 0) return [];
  }

  const caseRows = await db
    .select({
      caseRow: admissionsCases,
      studentRow: admissionsStudents,
      cohortRow: admissionsCohorts,
    })
    .from(admissionsCases)
    .innerJoin(admissionsStudents, eq(admissionsCases.studentId, admissionsStudents.id))
    .innerJoin(admissionsCohorts, eq(admissionsCases.cohortId, admissionsCohorts.id))
    .where(and(
      isNull(admissionsCases.deletedAt),
      isNull(admissionsStudents.deletedAt),
      ...(scopedCaseIds !== null ? [inArray(admissionsCases.id, scopedCaseIds)] : []),
    ));
  if (caseRows.length === 0) return [];

  const caseIds = caseRows.map((row) => row.caseRow.id);

  const memberRows = await db
    .select({
      caseId: admissionsCaseMembers.caseId,
      email: admissionsCaseMembers.email,
      role: admissionsCaseMembers.role,
      status: admissionsCaseMembers.status,
    })
    .from(admissionsCaseMembers)
    .where(inArray(admissionsCaseMembers.caseId, caseIds));
  const counselorsByCase = new Map<string, string[]>();
  for (const row of memberRows) {
    if (row.role !== "counselor" || row.status !== "active") continue;
    const list = counselorsByCase.get(row.caseId) ?? [];
    list.push(row.email);
    counselorsByCase.set(row.caseId, list);
  }

  const counselorEmailSet = new Set<string>();
  for (const emails of counselorsByCase.values()) {
    for (const value of emails) counselorEmailSet.add(value);
  }
  const nameByEmail = new Map<string, string>();
  if (counselorEmailSet.size > 0) {
    const nameRows = await db
      .select({ email: admissionsCounselors.email, name: admissionsCounselors.name })
      .from(admissionsCounselors)
      .where(inArray(admissionsCounselors.email, [...counselorEmailSet]));
    for (const row of nameRows) nameByEmail.set(row.email, row.name);
  }

  const meetingRows = await db
    .select({
      caseId: admissionsCaseMeetings.caseId,
      meetingDate: admissionsCaseMeetings.meetingDate,
    })
    .from(admissionsCaseMeetings)
    .where(and(
      inArray(admissionsCaseMeetings.caseId, caseIds),
      isNull(admissionsCaseMeetings.deletedAt),
    ));
  const lastMeetingByCase = new Map<string, string>();
  for (const row of meetingRows) {
    const current = lastMeetingByCase.get(row.caseId);
    if (!current || row.meetingDate > current) {
      lastMeetingByCase.set(row.caseId, row.meetingDate);
    }
  }

  const committedItemIds = caseRows
    .map((row) => row.caseRow.committedListItemId)
    .filter((value): value is string => value !== null);
  const committedNameByItemId = new Map<string, string>();
  if (committedItemIds.length > 0) {
    const itemRows = await db
      .select({
        id: admissionsCollegeListItems.id,
        instName: admissionsCollegeListItems.instName,
      })
      .from(admissionsCollegeListItems)
      .where(inArray(admissionsCollegeListItems.id, committedItemIds));
    for (const row of itemRows) committedNameByItemId.set(row.id, row.instName);
  }

  const todayIso = todayBangkok(now);
  const summaries = caseRows.map(({ caseRow, studentRow, cohortRow }): AdmissionsCaseSummary => {
    const counselorEmails = [...(counselorsByCase.get(caseRow.id) ?? [])].sort();
    const lastMeeting = lastMeetingByCase.get(caseRow.id) ?? null;
    return {
      caseId: caseRow.id,
      studentId: studentRow.id,
      studentName: studentRow.fullName,
      preferredName: studentRow.preferredName,
      cohortId: cohortRow.id,
      cohortName: cohortRow.name,
      graduationYear: cohortRow.graduationYear,
      status: caseRow.status,
      counselorEmails,
      counselorNames: counselorEmails.map((value) => nameByEmail.get(value) ?? value),
      progressPercent: 0,
      nextDeadline: null,
      daysSinceLastTouch: lastMeeting === null ? null : computeDaysSince(lastMeeting, todayIso),
      committedCollegeName: caseRow.committedListItemId
        ? committedNameByItemId.get(caseRow.committedListItemId) ?? null
        : null,
      updatedAt: caseRow.updatedAt.toISOString(),
    };
  });

  return summaries.sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt) || a.studentName.localeCompare(b.studentName),
  );
}

/**
 * Full case detail for the case shell (design §5.1). Callers must have run
 * requireCaseAccess first — this is a pure projection.
 *
 * 1. Load case + student + cohort (soft-deletes excluded); miss → NotFound.
 * 2. Load ALL membership rows (every status — the members tab shows invited/
 *    revoked/bounced states), oldest first.
 * 3. Resolve the committed college name and the latest meeting date.
 * 4. progressPercent = 0 and nextDeadline = null (phase-1 placeholders).
 */
export async function getCaseDetail(
  caseId: string,
  db: Database = getDb(),
): Promise<AdmissionsCaseDetail> {
  if (!isUuidShaped(caseId)) throw new Error("NotFound");

  const caseRows = await db
    .select({
      caseRow: admissionsCases,
      studentRow: admissionsStudents,
      cohortRow: admissionsCohorts,
    })
    .from(admissionsCases)
    .innerJoin(admissionsStudents, eq(admissionsCases.studentId, admissionsStudents.id))
    .innerJoin(admissionsCohorts, eq(admissionsCases.cohortId, admissionsCohorts.id))
    .where(and(
      eq(admissionsCases.id, caseId),
      isNull(admissionsCases.deletedAt),
      isNull(admissionsStudents.deletedAt),
    ))
    .limit(1);
  if (caseRows.length === 0) throw new Error("NotFound");
  const { caseRow, studentRow, cohortRow } = caseRows[0];

  const memberRows = await db
    .select()
    .from(admissionsCaseMembers)
    .where(eq(admissionsCaseMembers.caseId, caseId));
  const members = memberRows
    .slice()
    .sort((a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() || a.email.localeCompare(b.email),
    )
    .map(mapAdmissionsMemberRow);

  let committedCollegeName: string | null = null;
  if (caseRow.committedListItemId) {
    const itemRows = await db
      .select({ instName: admissionsCollegeListItems.instName })
      .from(admissionsCollegeListItems)
      .where(eq(admissionsCollegeListItems.id, caseRow.committedListItemId))
      .limit(1);
    committedCollegeName = itemRows.length > 0 ? itemRows[0].instName : null;
  }

  const meetingRows = await db
    .select({ meetingDate: admissionsCaseMeetings.meetingDate })
    .from(admissionsCaseMeetings)
    .where(and(
      eq(admissionsCaseMeetings.caseId, caseId),
      isNull(admissionsCaseMeetings.deletedAt),
    ));
  let lastMeetingDate: string | null = null;
  for (const row of meetingRows) {
    if (lastMeetingDate === null || row.meetingDate > lastMeetingDate) {
      lastMeetingDate = row.meetingDate;
    }
  }

  return {
    caseId: caseRow.id,
    status: caseRow.status,
    statusChangedAt: caseRow.statusChangedAt.toISOString(),
    committedListItemId: caseRow.committedListItemId,
    committedCollegeName,
    driveFolder: caseRow.driveFolder,
    student: {
      id: studentRow.id,
      fullName: studentRow.fullName,
      preferredName: studentRow.preferredName,
      studentEmail: studentRow.studentEmail,
      phone: studentRow.phone,
      school: studentRow.school,
      schoolCounselor: studentRow.schoolCounselor,
      wiseStudentKey: studentRow.wiseStudentKey,
      externalLinks: studentRow.externalLinks,
    },
    cohort: {
      id: cohortRow.id,
      name: cohortRow.name,
      graduationYear: cohortRow.graduationYear,
    },
    members,
    progressPercent: 0,
    nextDeadline: null,
    lastMeetingDate,
    createdAt: caseRow.createdAt.toISOString(),
    updatedAt: caseRow.updatedAt.toISOString(),
  };
}

/** updateCaseLifecycle result — the applied transition. */
export interface CaseLifecycleResult {
  caseId: string;
  previousStatus: AdmissionsCaseStatus;
  status: AdmissionsCaseStatus;
  statusChangedAt: string;
}

/**
 * Applies a lifecycle transition (design §8), audited.
 *
 * 1. Shape-check caseId and load the live case row; miss → NotFound.
 * 2. Validate the transition against CASE_LIFECYCLE_TRANSITIONS; anything
 *    invalid — including a same-status write — → Error("Conflict").
 * 3. Update status/statusChangedAt/updatedAt and write the audit diff in the
 *    same transaction.
 *
 * @returns the applied transition (previous → next, ISO statusChangedAt).
 */
export async function updateCaseLifecycle(
  caseId: string,
  nextStatus: AdmissionsCaseStatus,
  actor: AdmissionsActor,
  db: Database = getDb(),
): Promise<CaseLifecycleResult> {
  if (!isUuidShaped(caseId)) throw new Error("NotFound");

  return withAuditedTransaction(async (tx) => {
    const rows = await tx
      .select({ id: admissionsCases.id, status: admissionsCases.status })
      .from(admissionsCases)
      .where(and(eq(admissionsCases.id, caseId), isNull(admissionsCases.deletedAt)))
      .limit(1);
    if (rows.length === 0) throw new Error("NotFound");
    const previousStatus = rows[0].status;

    if (!isValidCaseTransition(previousStatus, nextStatus)) {
      throw new Error("Conflict");
    }

    const now = new Date();
    await tx
      .update(admissionsCases)
      .set({ status: nextStatus, statusChangedAt: now, updatedAt: now })
      .where(eq(admissionsCases.id, caseId));

    await writeAuditLog(tx, {
      caseId,
      actorEmail: actor.email,
      actorRole: actor.role,
      entityType: "case",
      entityId: caseId,
      action: "status_change",
      diff: computeFieldDiff(
        { status: previousStatus },
        { status: nextStatus },
        ["status"],
      ),
    });

    return {
      caseId,
      previousStatus,
      status: nextStatus,
      statusChangedAt: now.toISOString(),
    };
  }, db);
}

/** Editable student profile fields (design §5.1 Profile tab). Undefined = untouched. */
export interface UpdateCaseStudentFields {
  fullName?: string;
  preferredName?: string | null;
  phone?: string | null;
  school?: string | null;
  schoolCounselor?: string | null;
  wiseStudentKey?: string | null;
}

/** updateCaseProfile input — undefined fields are left untouched. */
export interface UpdateCaseProfileInput {
  caseId: string;
  actor: AdmissionsActor;
  /** Optimistic-concurrency token (case updatedAt ISO); mismatch → Conflict. */
  expectedUpdatedAt?: string;
  driveFolder?: string | null;
  student?: UpdateCaseStudentFields;
}

/** updateCaseProfile result — the fresh concurrency token. */
export interface CaseProfileUpdateResult {
  caseId: string;
  updatedAt: string;
}

const UPDATABLE_STUDENT_FIELDS = [
  "preferredName",
  "phone",
  "school",
  "schoolCounselor",
  "wiseStudentKey",
] as const;

/**
 * Updates case profile fields (driveFolder) and/or the linked student's
 * identity fields, audited (design §3 + §6 optimistic concurrency).
 *
 * 1. Shape-check caseId; load the live case + student join → NotFound on miss.
 * 2. When expectedUpdatedAt is provided and does not match the case row's
 *    updatedAt (ISO), throw Error("Conflict") — the route surfaces 409 with
 *    both versions.
 * 3. Compute the changed subset: driveFolder on the case; fullName (trimmed,
 *    must stay non-empty) and the other editable fields on the student.
 *    Nothing changed → no-op, current token returned, no audit rows.
 * 4. Apply the student update with its audit diff, then always bump the case
 *    row's updatedAt (the concurrency token moves whenever anything changed)
 *    with its own audit diff when case fields changed.
 *
 * @returns the caseId and the new case updatedAt (ISO concurrency token).
 */
export async function updateCaseProfile(
  input: UpdateCaseProfileInput,
  db: Database = getDb(),
): Promise<CaseProfileUpdateResult> {
  if (!isUuidShaped(input.caseId)) throw new Error("NotFound");

  return withAuditedTransaction(async (tx) => {
    const rows = await tx
      .select({ caseRow: admissionsCases, studentRow: admissionsStudents })
      .from(admissionsCases)
      .innerJoin(admissionsStudents, eq(admissionsCases.studentId, admissionsStudents.id))
      .where(and(
        eq(admissionsCases.id, input.caseId),
        isNull(admissionsCases.deletedAt),
        isNull(admissionsStudents.deletedAt),
      ))
      .limit(1);
    if (rows.length === 0) throw new Error("NotFound");
    const { caseRow, studentRow } = rows[0];

    if (
      input.expectedUpdatedAt !== undefined &&
      input.expectedUpdatedAt !== caseRow.updatedAt.toISOString()
    ) {
      throw new Error("Conflict");
    }

    const casePatch: { driveFolder?: string | null } = {};
    if (input.driveFolder !== undefined && input.driveFolder !== caseRow.driveFolder) {
      casePatch.driveFolder = input.driveFolder;
    }

    const studentPatch: Record<string, string | null> = {};
    if (input.student) {
      if (input.student.fullName !== undefined) {
        const fullName = input.student.fullName.trim();
        if (!fullName) throw new Error("updateCaseProfile requires a non-empty fullName");
        if (fullName !== studentRow.fullName) studentPatch.fullName = fullName;
      }
      for (const field of UPDATABLE_STUDENT_FIELDS) {
        const value = input.student[field];
        if (value !== undefined && value !== studentRow[field]) studentPatch[field] = value;
      }
    }

    const caseChanged = casePatch.driveFolder !== undefined;
    const studentChanged = Object.keys(studentPatch).length > 0;
    if (!caseChanged && !studentChanged) {
      return { caseId: input.caseId, updatedAt: caseRow.updatedAt.toISOString() };
    }

    const now = new Date();

    if (studentChanged) {
      await tx
        .update(admissionsStudents)
        .set({ ...studentPatch, updatedAt: now })
        .where(eq(admissionsStudents.id, studentRow.id));

      await writeAuditLog(tx, {
        caseId: input.caseId,
        actorEmail: input.actor.email,
        actorRole: input.actor.role,
        entityType: "student",
        entityId: studentRow.id,
        action: "update",
        diff: computeFieldDiff(
          studentRow as unknown as Record<string, unknown>,
          studentPatch,
          Object.keys(studentPatch),
        ),
      });
    }

    // Bump the case row even when only student fields changed so the
    // optimistic-concurrency token always moves with the profile.
    await tx
      .update(admissionsCases)
      .set({ ...casePatch, updatedAt: now })
      .where(eq(admissionsCases.id, input.caseId));

    if (caseChanged) {
      await writeAuditLog(tx, {
        caseId: input.caseId,
        actorEmail: input.actor.email,
        actorRole: input.actor.role,
        entityType: "case",
        entityId: input.caseId,
        action: "update",
        diff: computeFieldDiff(
          { driveFolder: caseRow.driveFolder },
          casePatch,
          ["driveFolder"],
        ),
      });
    }

    return { caseId: input.caseId, updatedAt: now.toISOString() };
  }, db);
}

/**
 * Links an existing admissions_students row by email or inserts a new one.
 * Existing rows are linked untouched (case creation is not a student edit).
 */
async function findOrCreateStudent(
  tx: AdmissionsWriteDb,
  student: CreateCaseStudentInput & { cohortId: string },
): Promise<string> {
  const existingRows = await tx
    .select({ id: admissionsStudents.id })
    .from(admissionsStudents)
    .where(and(
      eq(admissionsStudents.studentEmail, student.studentEmail),
      isNull(admissionsStudents.deletedAt),
    ))
    .limit(1);

  if (existingRows.length > 0) {
    const studentId = existingRows[0].id;
    const liveCaseRows = await tx
      .select({ id: admissionsCases.id })
      .from(admissionsCases)
      .where(and(
        eq(admissionsCases.studentId, studentId),
        inArray(admissionsCases.status, ["active", "committed"]),
        isNull(admissionsCases.deletedAt),
      ))
      .limit(1);
    if (liveCaseRows.length > 0) throw new Error("Conflict");
    return studentId;
  }

  const insertedRows = await tx
    .insert(admissionsStudents)
    .values({
      fullName: student.fullName,
      preferredName: student.preferredName ?? null,
      studentEmail: student.studentEmail,
      phone: student.phone ?? null,
      school: student.school ?? null,
      schoolCounselor: student.schoolCounselor ?? null,
      cohortId: student.cohortId,
      wiseStudentKey: student.wiseStudentKey ?? null,
    })
    .returning();
  const inserted = insertedRows[0];
  if (!inserted) throw new Error("Student insert returned no row");
  return inserted.id;
}

/** Whole Bangkok days elapsed from `isoDate` to `todayIso` (clamped ≥ 0). */
function computeDaysSince(isoDate: string, todayIso: string): number {
  const elapsed = Date.parse(`${todayIso}T00:00:00Z`) - Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(elapsed)) return 0;
  return Math.max(0, Math.floor(elapsed / MS_PER_DAY));
}

/** Trims, lowercases, dedupes, and drops empty emails (order-preserving). */
function dedupeEmails(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const email = normalizeAdmissionsEmail(value);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    result.push(email);
  }
  return result;
}
