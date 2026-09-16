import { and, eq, sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import { adminUsers, tutorContacts, tutorSitInGrants } from "@/lib/db/schema";
import { SitInError, SIT_INS_ROUTE, enabled, type Department } from "./model";

export type SitInAccess = {
  email: string;
  role: "observer" | "coordinator" | "manager";
  departments: Department[];
  canonicalKey: string | null;
};
export async function sitInGrant(
  email: string,
  db: Database = getDb(),
): Promise<typeof tutorSitInGrants.$inferSelect | null> {
  const [grant] = await db
    .select()
    .from(tutorSitInGrants)
    .where(
      and(
        eq(tutorSitInGrants.email, email.trim().toLowerCase()),
        eq(tutorSitInGrants.active, true),
      ),
    );
  return grant ?? null;
}
export async function accessForEmail(
  email: string,
  db: Database = getDb(),
): Promise<SitInAccess> {
  const normalized = email.trim().toLowerCase();
  const [admin] = await db
    .select()
    .from(adminUsers)
    .where(sql`lower(btrim(${adminUsers.email})) = ${normalized}`)
    .limit(1);
  if (admin?.disabled)
    throw new SitInError(403, "Your account access has been revoked.");
  const [grant] = await db
    .select()
    .from(tutorSitInGrants)
    .where(eq(tutorSitInGrants.email, normalized))
    .limit(1);
  if (grant && !grant.active)
    throw new SitInError(403, "Tutor Sit-ins access has been revoked.");
  // A department grant stays scoped even when the head has a legacy admin row.
  if (grant?.role === "observer")
    return {
      email: normalized,
      role: "observer",
      departments: grant.departments as Department[],
      canonicalKey: grant.canonicalKey,
    };
  const adminAllowed =
    admin &&
    (admin.allowedPages === null || admin.allowedPages.includes(SIT_INS_ROUTE));
  if (adminAllowed || grant?.role === "manager")
    return {
      email: normalized,
      role: "manager",
      departments: [],
      canonicalKey: grant?.canonicalKey ?? null,
    };
  if (grant?.role === "coordinator")
    return {
      email: normalized,
      role: "coordinator",
      departments: [],
      canonicalKey: null,
    };
  throw new SitInError(
    403,
    "Tutor Sit-ins is available to enrolled heads and authorized staff.",
  );
}
export async function requireSitInAccess() {
  if (!enabled())
    throw new SitInError(503, "Tutor Sit-ins has not been enabled.");
  const { auth } = await import("@/lib/auth");
  const session = await auth();
  if (!session?.user.email)
    throw new SitInError(
      401,
      "Please sign in with your approved Google account.",
    );
  return accessForEmail(session.user.email);
}
export function requireManager(access: SitInAccess) {
  if (access.role !== "manager")
    throw new SitInError(403, "Administrator access is required.");
}
export function assertDepartment(
  access: SitInAccess,
  department: string,
  reports = false,
) {
  if (
    (access.role === "observer" &&
      !access.departments.includes(department as Department)) ||
    (reports && access.role === "coordinator")
  ) {
    throw new SitInError(403, "This observation is outside your access.");
  }
}
export async function resolveObserver(
  email: string,
  department: string,
  targetKey: string,
  db: Database,
) {
  const access = await accessForEmail(email, db);
  if (access.role === "coordinator")
    throw new SitInError(409, "Choose an enrolled observer.");
  assertDepartment(access, department);
  const grant = await sitInGrant(email, db);
  if (grant && !grant.departments.includes(department))
    throw new SitInError(
      409,
      "This observer is not designated for this department.",
    );
  if (!grant?.canonicalKey)
    throw new SitInError(
      409,
      "An administrator must verify the observer's tutor identity.",
      "IDENTITY_REVIEW",
    );
  const [contact] = await db
    .select()
    .from(tutorContacts)
    .where(
      and(
        eq(tutorContacts.canonicalKey, grant.canonicalKey),
        eq(tutorContacts.active, true),
      ),
    )
    .limit(1);
  if (!contact)
    throw new SitInError(409, "The observer's tutor identity is not active.");
  if (grant.canonicalKey === targetKey)
    throw new SitInError(
      409,
      "A tutor cannot observe their own class. Assign another eligible observer.",
      "SELF_OBSERVATION",
    );
  return {
    ...access,
    canonicalKey: grant.canonicalKey,
    name: contact.displayName,
  };
}
export async function canUseSitIns(email: string) {
  if (!enabled()) return false;
  try {
    await accessForEmail(email);
    return true;
  } catch {
    return false;
  }
}
