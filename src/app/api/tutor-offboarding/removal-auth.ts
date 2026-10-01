import "server-only";

import { getDb } from "@/lib/db";
import { requireTutorOffboardingAdmin } from "@/lib/tutor-offboarding/access";
import { TutorOffboardingError } from "@/lib/tutor-offboarding/errors";
import { hasRemovalGrant } from "@/lib/tutor-offboarding/grants";

/** Every operator request checks the current session and re-reads the removal capability from Postgres. */
export async function requireRemovalOperator() {
  const db = getDb();
  const viewer = await requireTutorOffboardingAdmin(db);
  if (!await hasRemovalGrant(viewer.email, db)) {
    throw new TutorOffboardingError("You are not allowed to remove tutors.", 403);
  }
  return { db, viewer };
}
