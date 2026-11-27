import "server-only";
import { auth } from "@/lib/auth";
import { resolveTeacherCanonicalKeys } from "@/lib/progress-tests/teacher-access";
import type { Database } from "@/lib/db";
import { HiringError } from "./model";
import { headKeys } from "./role-views";
import { settings } from "./service";
export async function requireHiringAdmin() {
  const session = await auth();
  if (!session?.user?.email)
    throw new HiringError(401, "Sign in to view hiring.");
  if (
    session.user.role !== "admin" ||
    (session.user.allowedPages &&
      !session.user.allowedPages.some((p) => p === "/hiring"))
  )
    throw new HiringError(403, "Hiring access is required.");
  return session.user.email.trim().toLowerCase();
}

/** The head an email belongs to, by the tutor-contact match sign-in uses, or null when it is not one of `heads`. */
export async function headKeyFor(email: string | null | undefined, heads: string[]) {
  if (!email) return null;
  try {
    return (await resolveTeacherCanonicalKeys(email)).find((key) => heads.includes(key)) ?? null;
  } catch (error) {
    // The Heads screen is a convenience: without it the full dashboard still opens.
    console.error("[hiring] head lookup failed", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
}

export async function requireHiringHr() {
  const actor = await requireHiringAdmin();
  const { finalReviewAccess } = await import("./final-review");
  if (!finalReviewAccess(actor).hr) throw new HiringError(403, "Final review access is required.");
  return actor;
}

/** Gift's head key: the final reviewer, who owns the school (Kevin, 25 Nov 2026). Null when she is not a head here. */
export async function finalReviewerKey(db: Database) {
  const { config } = await settings(db);
  return headKeyFor(process.env.HIRING_FINAL_REVIEWER_EMAIL, headKeys(config));
}
