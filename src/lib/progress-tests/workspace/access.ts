import { and, eq, sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import { tutorContacts, adminUsers } from "@/lib/db/schema";
import { hasPageAccess } from "../page-access";
import type { AppSessionUser } from "../types";
import { assertOwner, WorkspaceError, workspaceEnabled } from "./model";

export type Scope = { user: AppSessionUser; keys: string[] | null };

/** Exact, active contact bindings only. Display-name matching is not an access grant. */
export async function scopeForEmail(email: string, db: Database = getDb()): Promise<Scope> {
  const normalized = email.trim().toLowerCase();
  const [admin] = await db.select().from(adminUsers).where(sql`lower(btrim(${adminUsers.email})) = ${normalized}`).limit(1);
  if (admin) {
    if (admin.disabled || !hasPageAccess(admin.allowedPages, "/progress-tests")) throw new WorkspaceError(403, "Access has been revoked.");
    return { user: { email: normalized, name: admin.name || normalized, role: "admin" }, keys: null };
  }
  const contacts = await db.select().from(tutorContacts).where(and(eq(tutorContacts.active, true), sql`(lower(btrim(${tutorContacts.onsiteEmail})) = ${normalized} or lower(btrim(${tutorContacts.onlineEmail})) = ${normalized})`));
  const keys = [...new Set(contacts.map(c => c.canonicalKey))];
  if (keys.length !== 1) throw new WorkspaceError(403, "Your tutor identity needs an administrator to review it.");
  return { user: { email: normalized, name: contacts[0].displayName, role: "teacher" }, keys };
}

export async function requireWorkspace(): Promise<Scope> {
  if (!workspaceEnabled()) throw new WorkspaceError(503, "The tutor workspace has not been enabled.");
  const { requireProgressTestsSession } = await import("../api");
  const user = await requireProgressTestsSession();
  const scope = await scopeForEmail(user.email);
  if (scope.user.role !== user.role) throw new WorkspaceError(403, "Sign in again to refresh your access.");
  return scope;
}

export async function chooseOwner(scope: Scope, requested?: string, db: Database = getDb()) {
  const owner = requested || scope.keys?.[0];
  if (!owner) throw new WorkspaceError(400, "Select a tutor first.");
  assertOwner(scope.keys, owner);
  const [contact] = await db.select({ id: tutorContacts.id }).from(tutorContacts).where(and(eq(tutorContacts.canonicalKey, owner), eq(tutorContacts.active, true))).limit(1);
  if (!contact) throw new WorkspaceError(400, "This tutor identity is no longer active.");
  return owner;
}
