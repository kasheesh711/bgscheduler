import "server-only";
import { auth } from "@/lib/auth";
import { HiringError } from "./model";
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

export async function requireHiringHr() {
  const actor = await requireHiringAdmin();
  const { finalReviewAccess } = await import("./final-review");
  if (!finalReviewAccess(actor).hr) throw new HiringError(403, "Final review access is required.");
  return actor;
}
