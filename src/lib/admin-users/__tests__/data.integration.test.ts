import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { Session } from "next-auth";
import { startTestDb, stopTestDb, truncateAll } from "@/tests/integration/db-helper";
import type { Database } from "@/lib/db";
import { adminUsers, adminUserAccessAuditLog } from "@/lib/db/schema";
import { validateSessionAccess } from "@/lib/auth-session";

vi.mock("server-only", () => ({}));

import { listAdminUsers, updateAdminUserAccess } from "../data";

let handle: Awaited<ReturnType<typeof startTestDb>>;
let db: Database;
const owner = "kevin@example.com";
const target = "aoeng@example.com";
const env = { SUPER_ADMIN_EMAILS: owner };

beforeAll(async () => { handle = await startTestDb(); db = handle.db as unknown as Database; });
afterAll(async () => { if (handle) await stopTestDb(handle); });
beforeEach(async () => {
  await truncateAll(handle.db);
  await handle.db.insert(adminUsers).values([{ email: owner }, { email: target, name: "Aoeng", allowedPages: ["/sales-dashboard"] }]);
});

function update(overrides: Partial<Parameters<typeof updateAdminUserAccess>[0]> = {}) {
  return updateAdminUserAccess({ actorEmail: owner, actorAccessVersion: 0, email: target, disabled: true, expectedVersion: 0, db, env, ...overrides });
}

function session(version: number): Session {
  return { user: { email: target, role: "admin", adminAccessVersion: version, allowedPages: null }, expires: "2099-01-01" };
}

describe("account access transactions and session revocation in Postgres", () => {
  it("atomically toggles access and appends normalized actor/before/after evidence", async () => {
    const changed = await update({ actorEmail: " KEVIN@EXAMPLE.COM ", email: "AOENG@EXAMPLE.COM" });
    expect(changed).toMatchObject({ disabled: true, accessVersion: 1, isOwner: false });
    const [audit] = await handle.db.select().from(adminUserAccessAuditLog);
    expect(audit).toMatchObject({ actorEmail: owner, targetEmail: target, beforeValue: { disabled: false, accessVersion: 0 }, afterValue: { disabled: true, accessVersion: 1 }, version: 1 });
    const [user] = await handle.db.select().from(adminUsers).where(eq(adminUsers.email, target));
    expect(user.allowedPages).toEqual(["/sales-dashboard"]);
  });

  it("allows only one concurrent edit at a given version with no extra audit row", async () => {
    const results = await Promise.allSettled([update(), update()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { status: 409 } });
    expect(await handle.db.select().from(adminUserAccessAuditLog)).toHaveLength(1);
  });

  it("blocks old sessions immediately and after re-enable, while a fresh login succeeds", async () => {
    expect(await validateSessionAccess(session(0), db)).not.toBeNull();
    await update();
    expect(await validateSessionAccess(session(0), db)).toBeNull();
    await update({ disabled: false, expectedVersion: 1 });
    expect(await validateSessionAccess(session(0), db)).toBeNull();
    expect(await validateSessionAccess(session(2), db)).not.toBeNull();
  });

  it("protects every configured owner from disable, enable and no-op requests", async () => {
    await expect(update({ email: owner })).rejects.toMatchObject({ status: 403 });
    await expect(update({ email: owner, disabled: false })).rejects.toMatchObject({ status: 403 });
    expect(await handle.db.select().from(adminUserAccessAuditLog)).toHaveLength(0);
  });

  it("rechecks current owner authority and unknown targets inside the transaction", async () => {
    await expect(update({ actorEmail: target })).rejects.toMatchObject({ status: 403 });
    await expect(update({ actorAccessVersion: 9 })).rejects.toMatchObject({ status: 403 });
    await expect(update({ email: "missing@example.com" })).rejects.toMatchObject({ status: 404 });
    await handle.db.update(adminUsers).set({ disabled: true }).where(eq(adminUsers.email, owner));
    await expect(update()).rejects.toMatchObject({ status: 403 });
  });

  it("rolls back the account change when the audit insert fails", async () => {
    await handle.db.insert(adminUserAccessAuditLog).values({ actorEmail: owner, targetEmail: target, beforeValue: { disabled: false, accessVersion: 0 }, afterValue: { disabled: true, accessVersion: 1 }, version: 1 });
    await expect(update()).rejects.toThrow();
    const [user] = await handle.db.select().from(adminUsers).where(eq(adminUsers.email, target));
    expect(user).toMatchObject({ disabled: false, accessVersion: 0 });
    expect(await handle.db.select().from(adminUserAccessAuditLog)).toHaveLength(1);
  });

  it("enforces append-only audit records at the database boundary", async () => {
    await update();
    await expect(handle.db.execute(sql`update admin_user_access_audit_log set actor_email = 'forged@example.com'`)).rejects.toThrow();
    await expect(handle.db.execute(sql`delete from admin_user_access_audit_log`)).rejects.toThrow();
    expect(await handle.db.select().from(adminUserAccessAuditLog)).toHaveLength(1);
  });

  it("lists current state and leaves unchanged normal accounts at the same version", async () => {
    await update({ disabled: false });
    const rows = await listAdminUsers(db, env);
    expect(rows.find((row) => row.email === owner)?.isOwner).toBe(true);
    expect(rows.find((row) => row.email === target)).toMatchObject({ disabled: false, accessVersion: 0 });
    expect(await handle.db.select().from(adminUserAccessAuditLog)).toHaveLength(0);
  });
});
