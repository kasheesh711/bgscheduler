// Admissions Case Management — auth guards and per-request access checks.
//
// Design: docs/casemanagementsystem_design.md §2. Fail-closed everywhere:
// unknown role, missing membership, revoked membership, inactive counselor
// registry row, or a soft-deleted case all deny. Non-admins never learn
// whether a case exists (Forbidden, not NotFound). JWT claims shape nav only;
// every case-scoped request re-resolves membership from Postgres here.

import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { getDb, type Database } from "@/lib/db";
import {
  adminUsers,
  admissionsCaseMembers,
  admissionsCases,
  admissionsCounselors,
} from "@/lib/db/schema";
import { hasPageAccess } from "@/lib/progress-tests/api";
import { ADMISSIONS_ROUTE, roleAtLeast } from "./config";
import type { AdmissionsRole, AdmissionsSessionUser, CaseAccess, CaseRole } from "./types";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves an email's global admissions role for sign-in/nav purposes
 * (design §2.1 steps 2 and 4 — steps 1/3 are handled by resolveUserAccess).
 *
 * 1. Active `admissions_counselors` registry row → "counselor".
 * 2. Otherwise, active `admissions_case_members` rows across all cases:
 *    any student membership → "student"; else any parent membership →
 *    "parent" (student > parent precedence for the global claim — actual
 *    rights remain per-case via requireCaseAccess).
 * 3. Neither → null (caller denies).
 */
export async function resolveAdmissionsRole(
  email: string,
  db: Database = getDb(),
): Promise<AdmissionsRole | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;

  const counselorRows = await db
    .select({ id: admissionsCounselors.id })
    .from(admissionsCounselors)
    .where(and(eq(admissionsCounselors.email, normalized), eq(admissionsCounselors.active, true)))
    .limit(1);
  if (counselorRows.length > 0) return "counselor";

  const memberRows = await db
    .select({ role: admissionsCaseMembers.role })
    .from(admissionsCaseMembers)
    .where(and(
      eq(admissionsCaseMembers.email, normalized),
      eq(admissionsCaseMembers.status, "active"),
    ));
  if (memberRows.some((row) => row.role === "student")) return "student";
  if (memberRows.some((row) => row.role === "parent")) return "parent";
  return null;
}

/**
 * Resolves and authorizes the current session for admissions routes
 * (mirror of requireProgressTestsSession).
 *
 * 1. Read the Auth.js session; normalize email/name; throw "Unauthorized"
 *    when either is missing.
 * 2. Throw "Forbidden" when allowedPages does not grant `/admissions`.
 * 3. Map the JWT role claim: counselor/student/parent pass through; "admin"
 *    or an absent role (legacy full-access admins) → "admin"; anything else
 *    (e.g. "teacher") → "Forbidden" (fail-closed, never guess upward).
 *
 * @returns the minimal authenticated user shape on success.
 */
export async function requireAdmissionsSession(): Promise<AdmissionsSessionUser> {
  const session = await auth();
  const email = session?.user?.email?.trim().toLowerCase();
  const name = session?.user?.name?.trim() || email;

  if (!email || !name) {
    throw new Error("Unauthorized");
  }

  if (!hasPageAccess(session?.user?.allowedPages, ADMISSIONS_ROUTE)) {
    throw new Error("Forbidden");
  }

  const rawRole: string | null | undefined = session?.user?.role;
  if (rawRole === "counselor" || rawRole === "student" || rawRole === "parent") {
    return { email, name, role: rawRole };
  }
  if (rawRole === "admin" || rawRole === null || rawRole === undefined) {
    return { email, name, role: "admin" };
  }
  throw new Error("Forbidden");
}

/**
 * Per-request case access check (design §2.2). Queries Postgres on EVERY
 * request so revocation is instant and caseId tampering fails closed.
 *
 * 1. Normalize email (throw "Unauthorized" when empty); reject a malformed
 *    caseId with "Forbidden" before touching the database.
 * 2. `admin_users` bypass: admins reach every case; a missing/soft-deleted
 *    case throws "NotFound" (admins may learn existence).
 * 3. Non-admins with a missing/soft-deleted case throw "Forbidden" — never
 *    "NotFound", so case existence does not leak.
 * 4. Require an active `admissions_case_members` row for THIS case; a
 *    counselor membership additionally requires an active
 *    `admissions_counselors` registry row (deactivated counselors deny).
 * 5. Enforce `minRole` under parent < student < counselor < admin; below the
 *    bar throws "Forbidden".
 *
 * @returns the resolved CaseAccess on success.
 */
export async function requireCaseAccess(
  email: string,
  caseId: string,
  minRole: CaseRole,
  db: Database = getDb(),
): Promise<CaseAccess> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) throw new Error("Unauthorized");
  if (!UUID_PATTERN.test(caseId)) throw new Error("Forbidden");

  const adminRows = await db
    .select({ id: adminUsers.id })
    .from(adminUsers)
    .where(eq(adminUsers.email, normalized))
    .limit(1);
  const isAdmin = adminRows.length > 0;

  const caseRows = await db
    .select({ id: admissionsCases.id })
    .from(admissionsCases)
    .where(and(eq(admissionsCases.id, caseId), isNull(admissionsCases.deletedAt)))
    .limit(1);
  const caseExists = caseRows.length > 0;

  if (isAdmin) {
    if (!caseExists) throw new Error("NotFound");
    return { caseId, email: normalized, role: "admin", isAdmin: true };
  }

  if (!caseExists) throw new Error("Forbidden");

  const memberRows = await db
    .select({ role: admissionsCaseMembers.role })
    .from(admissionsCaseMembers)
    .where(and(
      eq(admissionsCaseMembers.caseId, caseId),
      eq(admissionsCaseMembers.email, normalized),
      eq(admissionsCaseMembers.status, "active"),
    ))
    .limit(1);
  if (memberRows.length === 0) throw new Error("Forbidden");
  const role: CaseRole = memberRows[0].role;

  if (role === "counselor") {
    const counselorRows = await db
      .select({ id: admissionsCounselors.id })
      .from(admissionsCounselors)
      .where(and(eq(admissionsCounselors.email, normalized), eq(admissionsCounselors.active, true)))
      .limit(1);
    if (counselorRows.length === 0) throw new Error("Forbidden");
  }

  if (!roleAtLeast(role, minRole)) throw new Error("Forbidden");

  return { caseId, email: normalized, role, isAdmin: false };
}

/** Result of the Postgres-resolved staff check (requireCounselorOrAdmin). */
export interface AdmissionsStaffAccess {
  email: string;
  role: "counselor" | "admin";
  isAdmin: boolean;
}

/**
 * Per-request staff check for cross-case surfaces that have no single caseId
 * to anchor requireCaseAccess (e.g. cohort-scoped announcements, design §4 —
 * announcements are counselor/admin-writable per the §2.2 matrix). Resolved
 * from Postgres on EVERY request; the JWT role claim is never trusted for
 * rights.
 *
 * 1. Normalize the email; throw "Unauthorized" when empty.
 * 2. `admin_users` row → admin.
 * 3. Otherwise an ACTIVE `admissions_counselors` registry row → counselor;
 *    a deactivated registry row denies (fail-closed).
 * 4. Anyone else (students, parents, strangers) throws "Forbidden".
 *
 * @returns the resolved staff access on success.
 */
export async function requireCounselorOrAdmin(
  email: string,
  db: Database = getDb(),
): Promise<AdmissionsStaffAccess> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) throw new Error("Unauthorized");

  const adminRows = await db
    .select({ id: adminUsers.id })
    .from(adminUsers)
    .where(eq(adminUsers.email, normalized))
    .limit(1);
  if (adminRows.length > 0) {
    return { email: normalized, role: "admin", isAdmin: true };
  }

  const counselorRows = await db
    .select({ id: admissionsCounselors.id })
    .from(admissionsCounselors)
    .where(and(eq(admissionsCounselors.email, normalized), eq(admissionsCounselors.active, true)))
    .limit(1);
  if (counselorRows.length === 0) throw new Error("Forbidden");
  return { email: normalized, role: "counselor", isAdmin: false };
}

/**
 * Translates guard/domain errors into the route-handler response contract
 * (mirror of progressTestsErrorResponse, plus NotFound→404 and Conflict→409
 * for the admissions optimistic-concurrency and existence semantics).
 * Everything else logs via console.error and returns 500.
 */
export function admissionsErrorResponse(route: string, error: unknown, fallbackMessage: string) {
  if (
    typeof error === "object" &&
    error !== null &&
    "digest" in error &&
    (error as { digest?: unknown }).digest === "HANGING_PROMISE_REJECTION"
  ) {
    throw error;
  }

  if (error instanceof Error && error.message === "Unauthorized") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (error instanceof Error && error.message === "Forbidden") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (error instanceof Error && error.message === "NotFound") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (error instanceof Error && error.message === "Conflict") {
    return NextResponse.json({ error: "Conflict" }, { status: 409 });
  }

  console.error(route, error);
  return NextResponse.json(
    { error: error instanceof Error ? error.message : fallbackMessage },
    { status: 500 },
  );
}
