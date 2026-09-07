import "server-only";

import { sql } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { getDb, type Database } from "@/lib/db";
import { adminUsers } from "@/lib/db/schema";
import { isSuperAdminEmail } from "./policy";
import { AdminUsersAccessError, type AdminAccessEnvironment } from "./types";

/** Owner designation and enabled, current admin access are both required. */
export async function requireSuperAdmin(db?: Database, env: AdminAccessEnvironment = process.env) {
  const session = await auth();
  const email = session?.user?.email?.trim().toLowerCase();
  if (!email) throw new AdminUsersAccessError("Unauthorized", 401);
  if (session?.user?.role !== "admin" || !isSuperAdminEmail(email, env)) {
    throw new AdminUsersAccessError("Only the website owner can manage access", 403);
  }
  const [admin] = await (db ?? getDb()).select({
    disabled: adminUsers.disabled,
    accessVersion: adminUsers.accessVersion,
  }).from(adminUsers).where(sql`lower(btrim(${adminUsers.email})) = ${email}`).limit(1);
  if (!admin || admin.disabled || admin.accessVersion !== session.user.adminAccessVersion) {
    throw new AdminUsersAccessError("Owner account access is no longer current", 403);
  }
  return { email, accessVersion: admin.accessVersion };
}
