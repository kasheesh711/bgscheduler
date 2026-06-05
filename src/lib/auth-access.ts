// Resolves a signed-in user's role + page access. Two roles exist today:
//   - "admin"  — present in `admin_users`; `allowedPages` comes from the row
//                (null = full access; a list = page-restricted, e.g. m.giftwan).
//   - "teacher" — not an admin, but their email matches an active tutor contact;
//                may access ONLY `/progress-tests`, scoped read-only to their own
//                students (see resolveTeacherCanonicalKeys).
// Returns null when the email is neither → sign-in is denied (fail-closed, the
// same posture as the original admin-only allowlist).
//
// Node-only (does DB work): imported by src/lib/auth.ts (sign-in + jwt). The edge
// auth config never imports this — it only reads the resulting token claims.

import { eq } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import { adminUsers } from "@/lib/db/schema";
import { resolveTeacherCanonicalKeys } from "@/lib/progress-tests/teacher-access";

/** Page route a teacher is restricted to. */
const PROGRESS_TESTS_ROUTE = "/progress-tests";

export type UserRole = "admin" | "teacher";

export interface UserAccess {
  role: UserRole;
  /** null = full access (admins); a list = restricted to those route prefixes. */
  allowedPages: string[] | null;
}

/**
 * Determines whether an email may sign in, and with what role + page access.
 *
 * Admins take precedence (so kevhsh7 / m.giftwan keep their admin view even if
 * they also appear as a tutor contact). A non-admin whose email matches at least
 * one tutor contact becomes a page-restricted teacher.
 *
 * @returns the resolved access, or null when the email is neither admin nor a
 *   known teacher (caller denies sign-in).
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

  const teacherKeys = await resolveTeacherCanonicalKeys(normalized, db);
  if (teacherKeys.length > 0) {
    return { role: "teacher", allowedPages: [PROGRESS_TESTS_ROUTE] };
  }

  return null;
}
