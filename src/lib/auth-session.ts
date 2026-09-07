import { sql } from "drizzle-orm";
import type { Session } from "next-auth";
import { getDb, type Database } from "@/lib/db";
import { adminUsers } from "@/lib/db/schema";

/**
 * Shared by server auth() and the Node Proxy. Never replace a token's access
 * version with the database version: only a fresh Google sign-in may do that.
 * Unversioned legacy admin cookies must sign in once after this rollout.
 */
export async function validateSessionAccess(
  session: Session | null,
  db?: Database,
): Promise<Session | null> {
  const email = session?.user?.email?.trim().toLowerCase();
  if (!session || !email || !session.user.role) return null;

  try {
    const [admin] = await (db ?? getDb()).select({
      disabled: adminUsers.disabled,
      accessVersion: adminUsers.accessVersion,
      allowedPages: adminUsers.allowedPages,
    }).from(adminUsers)
      .where(sql`lower(btrim(${adminUsers.email})) = ${email}`).limit(1);

    if (admin) {
      if (
        admin.disabled ||
        session.user.role !== "admin" ||
        !Number.isInteger(session.user.adminAccessVersion) ||
        session.user.adminAccessVersion !== admin.accessVersion
      ) return null;
      return { ...session, user: { ...session.user, allowedPages: admin.allowedPages ?? null } };
    }

    // A deleted admin never falls back to a lower role through an existing JWT.
    return session.user.role === "admin" ? null : session;
  } catch (error) {
    console.error("Current account access check failed", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
}
