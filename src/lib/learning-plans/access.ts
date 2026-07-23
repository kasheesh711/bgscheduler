import "server-only";

import { and, eq, or, sql } from "drizzle-orm";
import { cache } from "react";
import { notFound, redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { getDb, type Database } from "@/lib/db";
import {
  learningPlanAccessGrants,
  tutorContacts,
} from "@/lib/db/schema";
import { hasLearningPlansAccess } from "./access-policy";

interface LearningPlansAccessSubject {
  email?: string | null;
  allowedPages?: string[] | null;
  role?: string | null;
}

interface CurrentLearningPlansAccess {
  authenticated: boolean;
  allowed: boolean;
}

function normalizeEmail(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

async function hasExactGrant(
  email: string,
  db: Database,
): Promise<boolean> {
  const rows = await db
    .select({ email: learningPlanAccessGrants.email })
    .from(learningPlanAccessGrants)
    .where(eq(learningPlanAccessGrants.email, email))
    .limit(1);

  return rows.length > 0;
}

async function isActiveTutorContactEmail(
  email: string,
  db: Database,
): Promise<boolean> {
  const rows = await db
    .select({ id: tutorContacts.id })
    .from(tutorContacts)
    .where(and(
      eq(tutorContacts.active, true),
      or(
        sql<boolean>`lower(btrim(${tutorContacts.onsiteEmail})) = ${email}`,
        sql<boolean>`lower(btrim(${tutorContacts.onlineEmail})) = ${email}`,
      ),
    ))
    .limit(1);

  return rows.length > 0;
}

/**
 * Resolves the feature grant for an already-authenticated session subject.
 *
 * Full admins and admins carrying the exact historical page prefix remain
 * automatic and therefore never depend on Postgres here. Other restricted
 * admins and teachers use an exact normalized grant lookup on every request.
 * A teacher must also still match an active tutor contact, so revoking or
 * changing the contact takes effect without waiting for JWT expiry. Any
 * database failure on those grant-dependent paths fails closed.
 */
export async function resolveLearningPlansAccess(
  subject: LearningPlansAccessSubject,
  db?: Database,
): Promise<boolean> {
  const email = normalizeEmail(subject.email);
  if (!email) return false;

  if (
    hasLearningPlansAccess(
      subject.allowedPages,
      subject.role,
      false,
    )
  ) {
    return true;
  }

  const role = subject.role;
  const isGrantEligibleRole =
    role === "admin" ||
    role === "teacher" ||
    role === null ||
    role === undefined;
  if (!isGrantEligibleRole) return false;

  try {
    const database = db ?? getDb();
    const hasGrant = await hasExactGrant(email, database);
    if (!hasGrant) return false;

    const hasEffectiveGrant =
      role !== "teacher" ||
      await isActiveTutorContactEmail(email, database);

    return hasLearningPlansAccess(
      subject.allowedPages,
      role,
      hasEffectiveGrant,
    );
  } catch {
    return false;
  }
}

/**
 * Request-render memoized DAL entry point. React.cache only deduplicates
 * within the current server render; it does not make feature grants stale
 * across requests.
 */
const getCurrentLearningPlansAccess = cache(
  async (): Promise<CurrentLearningPlansAccess> => {
    const session = await auth();
    const email = normalizeEmail(session?.user?.email);
    if (!email) {
      return { authenticated: false, allowed: false };
    }

    return {
      authenticated: true,
      allowed: await resolveLearningPlansAccess({
        email,
        allowedPages: session?.user?.allowedPages,
        role: session?.user?.role,
      }),
    };
  },
);

/** Returns the current session's fresh Learning Plans access decision. */
export async function getLearningPlansAccess(): Promise<boolean> {
  return (await getCurrentLearningPlansAccess()).allowed;
}

/**
 * Authoritative page guard. Middleware only performs a coarse authenticated
 * pass for this namespace; the live grant decision happens here.
 */
export async function requireLearningPlansAccess(): Promise<void> {
  const access = await getCurrentLearningPlansAccess();
  if (!access.authenticated) {
    redirect("/login");
  }
  if (!access.allowed) {
    notFound();
  }
}
