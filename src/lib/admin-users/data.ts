import "server-only";

import { and, asc, eq, sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import { adminUsers, adminUserAccessAuditLog } from "@/lib/db/schema";
import { isSuperAdminEmail } from "./policy";
import { withAdminAccessTransaction } from "./transaction";
import { AdminUsersAccessError, type AdminAccessEnvironment, type AdminUserAccessRow } from "./types";

function accessRow(row: typeof adminUsers.$inferSelect, env: AdminAccessEnvironment): AdminUserAccessRow {
  return {
    email: row.email,
    name: row.name,
    disabled: row.disabled,
    accessVersion: row.accessVersion,
    isOwner: isSuperAdminEmail(row.email, env),
  };
}

export async function listAdminUsers(db: Database = getDb(), env: AdminAccessEnvironment = process.env): Promise<AdminUserAccessRow[]> {
  const rows = await db.select().from(adminUsers).orderBy(asc(adminUsers.email));
  return rows.map((row) => accessRow(row, env));
}

/** Expected versions, current owner authority and audit history commit together. */
export async function updateAdminUserAccess(input: {
  actorEmail: string;
  actorAccessVersion: number;
  email: string;
  disabled: boolean;
  expectedVersion: number;
  db?: Database;
  env?: AdminAccessEnvironment;
}): Promise<AdminUserAccessRow> {
  const actorEmail = input.actorEmail.trim().toLowerCase();
  const targetEmail = input.email.trim().toLowerCase();
  const env = input.env ?? process.env;
  if (!isSuperAdminEmail(actorEmail, env)) throw new AdminUsersAccessError("Only the website owner can manage access", 403);
  // Every owner row is immutable through this UI, including no-op/re-enable
  // requests. Recovery of a disabled configured owner is an operator action.
  if (isSuperAdminEmail(targetEmail, env)) throw new AdminUsersAccessError("Website owner access cannot be changed here", 403);

  return withAdminAccessTransaction(input.db ?? getDb(), async (tx) => {
    // Stable lock order avoids deadlocks for concurrent requests. Locking the
    // actor too prevents an account change racing authorization mid-request.
    await tx.execute(sql`
      select id from admin_users
      where lower(btrim(email)) in (${actorEmail}, ${targetEmail})
      order by id for update
    `);
    const [actor] = await tx.select().from(adminUsers)
      .where(sql`lower(btrim(${adminUsers.email})) = ${actorEmail}`).limit(1);
    if (!actor || actor.disabled || actor.accessVersion !== input.actorAccessVersion) {
      throw new AdminUsersAccessError("Owner account access is no longer current", 403);
    }
    const [target] = await tx.select().from(adminUsers)
      .where(sql`lower(btrim(${adminUsers.email})) = ${targetEmail}`).limit(1);
    if (!target) throw new AdminUsersAccessError("Website account not found", 404);
    if (target.accessVersion !== input.expectedVersion) {
      throw new AdminUsersAccessError("Access changed since this list loaded. Refresh and try again.", 409);
    }
    if (target.disabled === input.disabled) return accessRow(target, env);
    const version = target.accessVersion + 1;
    const [updated] = await tx.update(adminUsers).set({ disabled: input.disabled, accessVersion: version })
      .where(and(eq(adminUsers.id, target.id), eq(adminUsers.accessVersion, input.expectedVersion)))
      .returning();
    if (!updated) throw new AdminUsersAccessError("Access changed since this list loaded. Refresh and try again.", 409);
    await tx.insert(adminUserAccessAuditLog).values({
      targetEmail,
      actorEmail,
      beforeValue: { disabled: target.disabled, accessVersion: target.accessVersion },
      afterValue: { disabled: updated.disabled, accessVersion: version },
      version,
    });
    return accessRow(updated, env);
  });
}
