// Admissions Case Management — leak-safe parent sibling switcher.
//
// This read model deliberately exposes route hrefs instead of raw database
// identifiers. It mirrors requireCaseAccess's family predicates: active parent
// membership, open portal, live student/case, and an active/committed/completed
// lifecycle. Closed, withdrawn, archived, invited, bounced, and revoked rows
// are structurally absent.

import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import {
  admissionsCaseMembers,
  admissionsCases,
  admissionsCohorts,
  admissionsStudents,
} from "@/lib/db/schema";
import { normalizeAdmissionsEmail } from "./members";
import type { AdmissionsCaseStatus } from "./types";

export interface LinkedFamilyCase {
  /** Safe application route; the raw case id is not a named response field. */
  href: string;
  studentName: string;
  preferredName: string | null;
  cohortName: string;
  caseStatus: Extract<AdmissionsCaseStatus, "active" | "committed" | "completed">;
}

/**
 * Lists every child case an active parent may currently open. The newest case
 * is first with a stable student-name/href tiebreak. Callers still run
 * requireCaseAccess on the destination; this list never grants access.
 */
export async function listLinkedFamilyCases(
  email: string,
  db: Database = getDb(),
): Promise<LinkedFamilyCase[]> {
  const normalized = normalizeAdmissionsEmail(email);
  if (!normalized) return [];

  const rows = await db
    .select({
      caseId: admissionsCases.id,
      status: admissionsCases.status,
      studentName: admissionsStudents.fullName,
      preferredName: admissionsStudents.preferredName,
      cohortName: admissionsCohorts.name,
      createdAt: admissionsCases.createdAt,
    })
    .from(admissionsCaseMembers)
    .innerJoin(admissionsCases, eq(admissionsCaseMembers.caseId, admissionsCases.id))
    .innerJoin(admissionsStudents, eq(admissionsCases.studentId, admissionsStudents.id))
    .innerJoin(admissionsCohorts, eq(admissionsCases.cohortId, admissionsCohorts.id))
    .where(and(
      eq(admissionsCaseMembers.email, normalized),
      eq(admissionsCaseMembers.role, "parent"),
      eq(admissionsCaseMembers.status, "active"),
      eq(admissionsCases.familyPortalOpen, true),
      inArray(admissionsCases.status, ["active", "committed", "completed"]),
      isNull(admissionsCases.deletedAt),
      isNull(admissionsStudents.deletedAt),
    ));

  return rows
    .slice()
    .sort((a, b) =>
      b.createdAt.getTime() - a.createdAt.getTime() ||
      a.studentName.localeCompare(b.studentName) ||
      a.caseId.localeCompare(b.caseId),
    )
    .map((row) => ({
      href: `/admissions/${row.caseId}`,
      studentName: row.studentName,
      preferredName: row.preferredName,
      cohortName: row.cohortName,
      caseStatus: row.status as LinkedFamilyCase["caseStatus"],
    }));
}
