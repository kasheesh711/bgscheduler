import "server-only";

import { isSuperAdminEmail } from "@/lib/admin-users/policy";
import type { AdminAccessEnvironment } from "@/lib/admin-users/types";
import { auth } from "@/lib/auth";
import { getDb, type Database } from "@/lib/db";
import { isMissingSchemaError, TutorOffboardingError } from "./errors";
import { hasRemovalGrant, normalizeOffboardingEmail } from "./grants";
import type { TutorOffboardingViewer } from "./types";

/** Who is looking: owner status from SUPER_ADMIN_EMAILS; the removal grant read fresh (OFF-11). */
export async function viewerForEmail(
  email: string,
  db: Database = getDb(),
  env: AdminAccessEnvironment = process.env,
): Promise<TutorOffboardingViewer> {
  const normalized = normalizeOffboardingEmail(email);
  const canRemove = await hasRemovalGrant(normalized, db).catch((error: unknown) => {
    if (isMissingSchemaError(error)) return false;
    throw error;
  });
  return { email: normalized, isOwner: isSuperAdminEmail(normalized, env), canRemove };
}

/** An admin session is required; page scope (`allowedPages`) is enforced by the proxy. */
export async function requireTutorOffboardingAdmin(
  db: Database = getDb(),
  env: AdminAccessEnvironment = process.env,
): Promise<TutorOffboardingViewer> {
  const session = await auth();
  const email = normalizeOffboardingEmail(session?.user?.email);
  if (!email) throw new TutorOffboardingError("Unauthorized", 401);
  if (session?.user?.role !== "admin") throw new TutorOffboardingError("Forbidden", 403);
  return viewerForEmail(email, db, env);
}
