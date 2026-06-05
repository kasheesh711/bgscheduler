import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import type { AppSessionUser } from "./types";

/** Route prefix this domain's pages and APIs live under. */
const PROGRESS_TESTS_ROUTE = "/progress-tests";

/**
 * Page-level access check (defense-in-depth alongside middleware).
 *
 * @returns true when allowedPages grants access to `route`. A null/undefined
 *   allowedPages means full access (all existing admins); otherwise the route
 *   must match one of the allowed prefixes.
 */
export function hasPageAccess(
  allowedPages: string[] | null | undefined,
  route: string,
): boolean {
  if (!allowedPages) return true;
  return allowedPages.some((page) => route === page || route.startsWith(`${page}/`));
}

/**
 * Resolves and authorizes the current session for progress-tests routes.
 *
 * 1. Read the Auth.js session.
 * 2. Normalize email/name; throw "Unauthorized" when either is missing.
 * 3. Throw "Forbidden" when the user lacks access to `/progress-tests`.
 *
 * @returns the minimal authenticated user shape on success.
 */
export async function requireProgressTestsSession(): Promise<AppSessionUser> {
  const session = await auth();
  const email = session?.user?.email?.trim().toLowerCase();
  const name = session?.user?.name?.trim() || email;

  if (!email || !name) {
    throw new Error("Unauthorized");
  }

  if (!hasPageAccess(session?.user?.allowedPages, PROGRESS_TESTS_ROUTE)) {
    throw new Error("Forbidden");
  }

  const role = session?.user?.role === "teacher" ? "teacher" : "admin";
  return { email, name, role };
}

/**
 * Like requireProgressTestsSession but additionally requires an admin role.
 *
 * Teachers get a read-only, student-scoped view, so every mutating route uses
 * this guard — a teacher session throws "Forbidden" (403) before any write.
 *
 * @returns the authenticated admin user on success.
 */
export async function requireProgressTestsAdminSession(): Promise<AppSessionUser> {
  const user = await requireProgressTestsSession();
  if (user.role !== "admin") {
    throw new Error("Forbidden");
  }
  return user;
}

export function progressTestsErrorResponse(route: string, error: unknown, fallbackMessage: string) {
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

  console.error(route, error);
  return NextResponse.json(
    { error: error instanceof Error ? error.message : fallbackMessage },
    { status: 500 },
  );
}
