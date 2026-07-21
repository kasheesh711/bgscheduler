import "server-only";

import { and, asc, eq, notInArray, sql } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { withPostClassTransaction } from "./transaction";

export const POST_CLASS_FEEDBACK_ROUTE = "/post-class-feedback";

export const POST_CLASS_CAPABILITIES = [
  "viewer",
  "reviewer",
  "finance",
  "access_manager",
] as const;

export type PostClassCapability = (typeof POST_CLASS_CAPABILITIES)[number];

const CAPABILITY_ORDER = new Map<PostClassCapability, number>(
  POST_CLASS_CAPABILITIES.map((capability, index) => [capability, index]),
);

export class PostClassAccessError extends Error {
  constructor(
    message: string,
    public readonly status: 401 | 403 | 404 | 409 | 422,
  ) {
    super(message);
    this.name = "PostClassAccessError";
  }
}

export interface PostClassUser {
  email: string;
  name: string;
  role: "admin";
  capabilities: PostClassCapability[];
}

export interface PostClassAccessRow {
  email: string;
  name: string | null;
  capabilities: PostClassCapability[];
}

function normalizeEmail(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function isPostClassCapability(value: string): value is PostClassCapability {
  return (POST_CLASS_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * Produces a stable capability set. Any action capability implies viewer so a
 * user cannot be granted a workflow action while being unable to inspect its
 * evidence. An empty set is still allowed when another access manager revokes
 * feature access entirely.
 */
export function normalizePostClassCapabilities(
  capabilities: readonly string[],
): PostClassCapability[] {
  const unique = new Set<PostClassCapability>();
  for (const capability of capabilities) {
    if (isPostClassCapability(capability)) unique.add(capability);
  }
  if (unique.size > 0) unique.add("viewer");
  return [...unique].sort(
    (left, right) => (CAPABILITY_ORDER.get(left) ?? 0) - (CAPABILITY_ORDER.get(right) ?? 0),
  );
}

function storedAccessVersion(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const version = Number(value);
  return Number.isSafeInteger(version) && version >= 0 ? version : null;
}

export function nextPostClassCapabilityVersion(currentVersion: number, nowMs: number): number {
  return Math.max(Math.floor(nowMs / 1_000), currentVersion + 1);
}

/**
 * Pure guard shared by the API mutation and tests. Self-removal of
 * access_manager is intentionally forbidden: another access manager must make
 * that change, which prevents an accidental save from locking the current user
 * out of the Settings screen. The last manager can never be removed. The
 * client version is checked after taking the role-matrix transaction lock.
 */
export function assertPostClassCapabilityReplacementAllowed(input: {
  actorEmail: string;
  targetEmail: string;
  actorCapabilities: readonly PostClassCapability[];
  currentCapabilities: readonly PostClassCapability[];
  nextCapabilities: readonly PostClassCapability[];
  activeAccessManagerCount: number;
  currentVersion: number;
  expectedVersion: number;
}): void {
  const actorEmail = normalizeEmail(input.actorEmail);
  const targetEmail = normalizeEmail(input.targetEmail);
  const current = normalizePostClassCapabilities(input.currentCapabilities);
  const next = normalizePostClassCapabilities(input.nextCapabilities);

  if (!input.actorCapabilities.includes("access_manager")) {
    throw new PostClassAccessError("Access manager capability required", 403);
  }
  if (input.currentVersion !== input.expectedVersion) {
    throw new PostClassAccessError(
      "Capabilities changed since this settings view was loaded",
      409,
    );
  }

  const removesManager = current.includes("access_manager") && !next.includes("access_manager");
  if (actorEmail === targetEmail && removesManager) {
    throw new PostClassAccessError(
      "Ask another access manager to remove your access-manager capability",
      422,
    );
  }
  if (removesManager && input.activeAccessManagerCount <= 1) {
    throw new PostClassAccessError("At least one access manager is required", 422);
  }
}

/** Always reads grants from Postgres; capabilities are deliberately not JWT claims. */
export async function getPostClassCapabilities(
  email: string | null | undefined,
  db: Database = getDb(),
): Promise<PostClassCapability[]> {
  const normalized = normalizeEmail(email);
  if (!normalized) return [];

  const rows = await db
    .select({ capability: schema.postClassAccessGrants.capability })
    .from(schema.postClassAccessGrants)
    .innerJoin(
      schema.adminUsers,
      sql<boolean>`lower(btrim(${schema.adminUsers.email})) = lower(btrim(${schema.postClassAccessGrants.email}))`,
    )
    .where(sql<boolean>`lower(btrim(${schema.postClassAccessGrants.email})) = ${normalized}`);

  return normalizePostClassCapabilities(rows.map((row) => row.capability));
}

/**
 * Requires an authenticated admin plus a fresh feature capability. Feature
 * grants supersede legacy allowedPages for this route so every allowlisted
 * admin seeded as viewer can inspect the workspace, including restricted admins.
 */
export async function requirePostClassCapability(
  capability: PostClassCapability = "viewer",
  db: Database = getDb(),
): Promise<PostClassUser> {
  const session = await auth();
  const email = normalizeEmail(session?.user?.email);
  const name = session?.user?.name?.trim() || email;
  if (!email || !name) {
    throw new PostClassAccessError("Unauthorized", 401);
  }
  // Older Auth.js sessions issued before the role claim existed have no role;
  // the fresh DB grant remains authoritative for those sessions. An explicit
  // non-admin role (currently teacher) always fails closed.
  if (session?.user?.role && session.user.role !== "admin") {
    throw new PostClassAccessError("Forbidden", 403);
  }

  const capabilities = await getPostClassCapabilities(email, db);
  if (!capabilities.includes(capability)) {
    throw new PostClassAccessError("Forbidden", 403);
  }

  return { email, name, role: "admin", capabilities };
}

/** Lists the allowlisted-admin matrix used by the Settings role editor. */
export async function listPostClassAccessRows(
  db: Database = getDb(),
): Promise<PostClassAccessRow[]> {
  const [admins, grants] = await Promise.all([
    db
      .select({ email: schema.adminUsers.email, name: schema.adminUsers.name })
      .from(schema.adminUsers)
      .orderBy(asc(schema.adminUsers.email)),
    db
      .select({
        email: schema.postClassAccessGrants.email,
        capability: schema.postClassAccessGrants.capability,
      })
      .from(schema.postClassAccessGrants),
  ]);

  const capabilitiesByEmail = new Map<string, PostClassCapability[]>();
  for (const grant of grants) {
    const email = normalizeEmail(grant.email);
    const values = capabilitiesByEmail.get(email) ?? [];
    values.push(grant.capability);
    capabilitiesByEmail.set(email, values);
  }

  return admins.map((admin) => {
    const email = normalizeEmail(admin.email);
    return {
      email,
      name: admin.name,
      capabilities: normalizePostClassCapabilities(capabilitiesByEmail.get(email) ?? []),
    };
  });
}

/**
 * Replaces one allowlisted admin's feature capabilities and records the change.
 * New grants are inserted before obsolete grants are removed, avoiding a
 * transient last-manager gap. The Settings UI's expected version is checked
 * under the same transaction lock that protects the replacement.
 */
export async function replacePostClassCapabilities(input: {
  actorEmail: string;
  targetEmail: string;
  capabilities: readonly string[];
  expectedVersion: number;
  note?: string | null;
  db?: Database;
}): Promise<PostClassCapability[]> {
  const db = input.db ?? getDb();
  const actorEmail = normalizeEmail(input.actorEmail);
  const targetEmail = normalizeEmail(input.targetEmail);
  if (!actorEmail || !targetEmail) {
    throw new PostClassAccessError("Actor and target email are required", 422);
  }
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new PostClassAccessError(
      "Expected version is required for concurrent access changes",
      409,
    );
  }

  return withPostClassTransaction(db, async (tx) => {
    // Serialize the small role matrix so two managers cannot concurrently
    // remove one another and both observe the same stale manager count.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('post_class_access_grants'))`);
    // Keep actor/target allowlist membership stable until the grant mutation
    // commits. Deletes from admin_users conflict with this key-share lock.
    await tx.execute(sql`
      select id
      from admin_users
      where lower(btrim(email)) in (${actorEmail}, ${targetEmail})
      for key share
    `);

    const [actorAdmin, targetAdmin] = await Promise.all([
      tx
        .select({
          email: schema.adminUsers.email,
          createdAt: schema.adminUsers.createdAt,
        })
        .from(schema.adminUsers)
        .where(sql<boolean>`lower(btrim(${schema.adminUsers.email})) = ${actorEmail}`)
        .limit(1)
        .then((rows) => rows[0]),
      tx
        .select({
          email: schema.adminUsers.email,
          createdAt: schema.adminUsers.createdAt,
        })
        .from(schema.adminUsers)
        .where(sql<boolean>`lower(btrim(${schema.adminUsers.email})) = ${targetEmail}`)
        .limit(1)
        .then((rows) => rows[0]),
    ]);
    if (!actorAdmin) {
      throw new PostClassAccessError("Actor must be an allowlisted admin", 403);
    }
    if (!targetAdmin) {
      throw new PostClassAccessError("Target must be an allowlisted admin", 404);
    }

    const [actorCapabilities, currentGrantRows, managerRows, accessAuditVersion] = await Promise.all([
      getPostClassCapabilities(actorEmail, tx),
      tx.select({
        capability: schema.postClassAccessGrants.capability,
        updatedAt: schema.postClassAccessGrants.updatedAt,
      }).from(schema.postClassAccessGrants)
        .where(sql<boolean>`lower(btrim(${schema.postClassAccessGrants.email})) = ${targetEmail}`),
      tx
      .select({ email: schema.postClassAccessGrants.email })
      .from(schema.postClassAccessGrants)
      .innerJoin(
        schema.adminUsers,
        sql<boolean>`lower(btrim(${schema.adminUsers.email})) = lower(btrim(${schema.postClassAccessGrants.email}))`,
      )
      .where(eq(schema.postClassAccessGrants.capability, "access_manager")),
      tx.select({
        version: sql<string | null>`max(case
          when jsonb_typeof(${schema.postClassConfigAuditLog.afterValue}->'version') = 'number'
          then (${schema.postClassConfigAuditLog.afterValue}->>'version')::bigint
          else null
        end)::text`,
      })
        .from(schema.postClassConfigAuditLog)
        .where(and(
          eq(schema.postClassConfigAuditLog.entityType, "access_grant"),
          sql<boolean>`lower(btrim(${schema.postClassConfigAuditLog.entityKey})) = ${targetEmail}`,
        ))
        .then((rows) => rows[0]?.version ?? null),
    ]);
    const currentCapabilities = normalizePostClassCapabilities(
      currentGrantRows.map((row) => row.capability),
    );
    const timestampVersion = Math.floor(Math.max(
      targetAdmin.createdAt.getTime(),
      ...currentGrantRows.map((row) => row.updatedAt.getTime()),
    ) / 1_000);
    const currentVersion = Math.max(
      timestampVersion,
      storedAccessVersion(accessAuditVersion) ?? 0,
    );
    const nextCapabilities = normalizePostClassCapabilities(input.capabilities);

    assertPostClassCapabilityReplacementAllowed({
      actorEmail,
      targetEmail,
      actorCapabilities,
      currentCapabilities,
      nextCapabilities,
      activeAccessManagerCount: new Set(managerRows.map((row) => normalizeEmail(row.email))).size,
      currentVersion,
      expectedVersion: input.expectedVersion,
    });

    const nextVersion = nextPostClassCapabilityVersion(currentVersion, Date.now());
    const mutationAt = new Date(nextVersion * 1_000);

    if (nextCapabilities.length > 0) {
      await tx
        .insert(schema.postClassAccessGrants)
        .values(nextCapabilities.map((capability) => ({
          email: targetEmail,
          capability,
          grantedByEmail: actorEmail,
          updatedAt: mutationAt,
        })))
        .onConflictDoUpdate({
          target: [
            schema.postClassAccessGrants.email,
            schema.postClassAccessGrants.capability,
          ],
          set: { grantedByEmail: actorEmail, updatedAt: mutationAt },
        });
    }

    if (nextCapabilities.length === 0) {
      await tx
        .delete(schema.postClassAccessGrants)
        .where(eq(schema.postClassAccessGrants.email, targetEmail));
    } else {
      await tx
        .delete(schema.postClassAccessGrants)
        .where(and(
          eq(schema.postClassAccessGrants.email, targetEmail),
          notInArray(schema.postClassAccessGrants.capability, nextCapabilities),
        ));
    }

    await tx.insert(schema.postClassConfigAuditLog).values({
      entityType: "access_grant",
      entityKey: targetEmail,
      action: "capabilities_replaced",
      actorEmail,
      beforeValue: { capabilities: currentCapabilities, version: currentVersion },
      afterValue: { capabilities: nextCapabilities, version: nextVersion },
      note: input.note?.trim() || null,
    });

    return nextCapabilities;
  });
}
