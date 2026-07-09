// Resolves a signed-in user's role + page access. Five roles exist today:
//   - "admin"     — present in `admin_users`; `allowedPages` comes from the row
//                   (null = full access; a list = page-restricted, e.g. m.giftwan).
//   - "counselor" — active `admissions_counselors` registry row; may access ONLY
//                   `/admissions` (per-case rights are re-checked on every request,
//                   see src/lib/admissions/access.ts).
//   - "teacher"   — not an admin, but their email matches an active tutor contact;
//                   may access ONLY `/progress-tests`, scoped read-only to their own
//                   students (see resolveTeacherCanonicalKeys).
//   - "student" / "parent" — active `admissions_case_members` membership on at
//                   least one case; may access ONLY `/admissions` (student wins over
//                   parent for the JWT claim; actual rights remain per-case).
// Resolution order (first match wins, docs/casemanagementsystem_design.md §2.1):
// admin → counselor → teacher → case member. Returns null when the email is none
// of these → sign-in is denied (fail-closed, the same posture as the original
// admin-only allowlist).
//
// Node-only (does DB work): imported by src/lib/auth.ts (sign-in + jwt). The edge
// auth config never imports this — it only reads the resulting token claims.

import { eq } from "drizzle-orm";
import { resolveAdmissionsRole } from "@/lib/admissions/access";
import { ADMISSIONS_ROUTE } from "@/lib/admissions/config";
import { getDb, type Database } from "@/lib/db";
import { adminUsers } from "@/lib/db/schema";
import { resolveTeacherCanonicalKeys } from "@/lib/progress-tests/teacher-access";

/** Page route a teacher is restricted to. */
const PROGRESS_TESTS_ROUTE = "/progress-tests";

export type UserRole = "admin" | "teacher" | "counselor" | "student" | "parent";

export interface UserAccess {
  role: UserRole;
  /** null = full access (admins); a list = restricted to those route prefixes. */
  allowedPages: string[] | null;
}

/**
 * Determines whether an email may sign in, and with what role + page access.
 *
 * 1. `admin_users` row → "admin" with the row's allowedPages (so kevhsh7 /
 *    m.giftwan keep their admin view even if they also appear as a tutor
 *    contact or admissions member).
 * 2. Active `admissions_counselors` registry row → "counselor", restricted to
 *    `/admissions`. Steps 2 and 4 share resolveAdmissionsRole, so a
 *    non-counselor admissions result is held until the teacher check loses.
 * 3. Email matches at least one active tutor contact → "teacher", restricted
 *    to `/progress-tests`.
 * 4. Active `admissions_case_members` membership on any case → "student" or
 *    "parent" (student wins when both), restricted to `/admissions`.
 *
 * @returns the resolved access, or null when the email matches none of the
 *   above (caller denies sign-in — fail-closed).
 */
export async function resolveUserAccess(
  email: string | null | undefined,
  db: Database = getDb(),
): Promise<UserAccess | null> {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return null;

  const [admin] = await db
    .select({ allowedPages: adminUsers.allowedPages })
    .from(adminUsers)
    .where(eq(adminUsers.email, normalized))
    .limit(1);
  if (admin) return { role: "admin", allowedPages: admin.allowedPages ?? null };

  const admissionsRole = await resolveAdmissionsRole(normalized, db);
  if (admissionsRole === "counselor") {
    return { role: "counselor", allowedPages: [ADMISSIONS_ROUTE] };
  }

  const teacherKeys = await resolveTeacherCanonicalKeys(normalized, db);
  if (teacherKeys.length > 0) {
    return { role: "teacher", allowedPages: [PROGRESS_TESTS_ROUTE] };
  }

  if (admissionsRole === "student" || admissionsRole === "parent") {
    return { role: admissionsRole, allowedPages: [ADMISSIONS_ROUTE] };
  }

  return null;
}
