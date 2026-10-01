import { asc, eq, sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import { TutorOffboardingError } from "./errors";
import type { GrantRecord } from "./types";

export function normalizeOffboardingEmail(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

export async function listGrants(db: Database = getDb()): Promise<GrantRecord[]> {
  const grants = schema.tutorOffboardingAccessGrants;
  const rows = await db.select().from(grants).orderBy(asc(grants.email));
  return rows.map((row) => ({ email: row.email, grantedByEmail: row.grantedByEmail, grantedAt: row.grantedAt.toISOString() }));
}

/** OFF-11: a grant counts only while its holder is an enabled admin, and is always read from Postgres. */
export async function hasRemovalGrant(email: string, db: Database = getDb()): Promise<boolean> {
  const normalized = normalizeOffboardingEmail(email);
  if (!normalized) return false;
  const grants = schema.tutorOffboardingAccessGrants;
  const rows = await db.select({ email: grants.email }).from(grants)
    .innerJoin(schema.adminUsers, sql`lower(btrim(${schema.adminUsers.email})) = ${grants.email}`)
    .where(sql`${grants.email} = ${normalized} and ${schema.adminUsers.disabled} = false`)
    .limit(1);
  return rows.length > 0;
}

/** Owner-only grant change, serialized and audited. Returns the grants after the change. */
export async function changeGrant(db: Database, input: { action: "grant" | "revoke"; email: string; actorEmail: string }): Promise<GrantRecord[]> {
  const email = normalizeOffboardingEmail(input.email);
  const grants = schema.tutorOffboardingAccessGrants;
  return withDatabaseTransaction(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('tutor_offboarding_grants'))`);
    if (input.action === "grant") {
      const [admin] = await tx.select({ disabled: schema.adminUsers.disabled }).from(schema.adminUsers)
        .where(sql`lower(btrim(${schema.adminUsers.email})) = ${email}`).limit(1);
      if (!admin || admin.disabled) throw new TutorOffboardingError("Only an enabled admin user can be allowed to remove tutors.", 422);
      const inserted = await tx.insert(grants).values({ email, grantedByEmail: input.actorEmail }).onConflictDoNothing().returning({ email: grants.email });
      if (inserted.length === 0) throw new TutorOffboardingError("That admin can already remove tutors.", 409);
    } else {
      const removed = await tx.delete(grants).where(eq(grants.email, email)).returning({ email: grants.email });
      if (removed.length === 0) throw new TutorOffboardingError("That admin was not allowed to remove tutors.", 404);
    }
    await tx.insert(schema.tutorOffboardingAccessAuditLog).values({ action: input.action, email, actorEmail: input.actorEmail });
    return listGrants(tx);
  });
}
