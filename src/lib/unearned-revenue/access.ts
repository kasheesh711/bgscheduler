import "server-only";

import { and, asc, eq, notInArray, sql } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { withUnearnedRevenueTransaction } from "./transaction";
import type { UnearnedRevenueAccessRow, UnearnedRevenueCapability } from "./types";

export const UNEARNED_REVENUE_CAPABILITIES = ["viewer", "access_manager"] as const;

const CAPABILITY_ORDER = new Map<UnearnedRevenueCapability, number>(
  UNEARNED_REVENUE_CAPABILITIES.map((capability, index) => [capability, index]),
);

export class UnearnedRevenueAccessError extends Error {
  constructor(
    message: string,
    public readonly status: 401 | 403 | 404 | 409 | 422,
  ) {
    super(message);
    this.name = "UnearnedRevenueAccessError";
  }
}

export interface UnearnedRevenueUser {
  email: string;
  name: string;
  capabilities: UnearnedRevenueCapability[];
}

export function normalizeUnearnedRevenueEmail(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function isCapability(value: string): value is UnearnedRevenueCapability {
  return (UNEARNED_REVENUE_CAPABILITIES as readonly string[]).includes(value);
}

export function normalizeUnearnedRevenueCapabilities(
  capabilities: readonly string[],
): UnearnedRevenueCapability[] {
  const unique = new Set<UnearnedRevenueCapability>();
  for (const capability of capabilities) {
    if (isCapability(capability)) unique.add(capability);
  }
  if (unique.size > 0) unique.add("viewer");
  return [...unique].sort(
    (left, right) => (CAPABILITY_ORDER.get(left) ?? 0) - (CAPABILITY_ORDER.get(right) ?? 0),
  );
}

export function nextUnearnedRevenueCapabilityVersion(
  currentVersion: number,
  nowMs: number,
): number {
  return Math.max(Math.floor(nowMs / 1_000), currentVersion + 1);
}

export function assertUnearnedRevenueCapabilityReplacementAllowed(input: {
  actorEmail: string;
  targetEmail: string;
  actorCapabilities: readonly UnearnedRevenueCapability[];
  currentCapabilities: readonly UnearnedRevenueCapability[];
  nextCapabilities: readonly UnearnedRevenueCapability[];
  accessManagerCount: number;
  currentVersion: number;
  expectedVersion: number;
}): void {
  if (!input.actorCapabilities.includes("access_manager")) {
    throw new UnearnedRevenueAccessError("Access manager capability required", 403);
  }
  if (input.currentVersion !== input.expectedVersion) {
    throw new UnearnedRevenueAccessError("Access grants changed since this view loaded", 409);
  }
  const actor = normalizeUnearnedRevenueEmail(input.actorEmail);
  const target = normalizeUnearnedRevenueEmail(input.targetEmail);
  const removesManager = input.currentCapabilities.includes("access_manager")
    && !input.nextCapabilities.includes("access_manager");
  if (actor === target && removesManager) {
    throw new UnearnedRevenueAccessError(
      "Ask another access manager to remove your access-manager capability",
      422,
    );
  }
  if (removesManager && input.accessManagerCount <= 1) {
    throw new UnearnedRevenueAccessError("At least one access manager is required", 422);
  }
}

/** Capabilities are always read from Postgres; no finance grant is trusted from a JWT. */
export async function getUnearnedRevenueCapabilities(
  email: string | null | undefined,
  db: Database = getDb(),
): Promise<UnearnedRevenueCapability[]> {
  const normalized = normalizeUnearnedRevenueEmail(email);
  if (!normalized) return [];
  const rows = await db
    .select({ capability: schema.unearnedRevenueAccessGrants.capability })
    .from(schema.unearnedRevenueAccessGrants)
    .innerJoin(
      schema.adminUsers,
      sql<boolean>`lower(btrim(${schema.adminUsers.email})) = lower(btrim(${schema.unearnedRevenueAccessGrants.email}))`,
    )
    .where(sql<boolean>`lower(btrim(${schema.unearnedRevenueAccessGrants.email})) = ${normalized}`);
  return normalizeUnearnedRevenueCapabilities(rows.map((row) => row.capability));
}

export async function requireUnearnedRevenueCapability(
  capability: UnearnedRevenueCapability = "viewer",
  db: Database = getDb(),
): Promise<UnearnedRevenueUser> {
  const session = await auth();
  const email = normalizeUnearnedRevenueEmail(session?.user?.email);
  const name = session?.user?.name?.trim() || email;
  if (!email || !name) throw new UnearnedRevenueAccessError("Unauthorized", 401);
  if (session?.user?.role && session.user.role !== "admin") {
    throw new UnearnedRevenueAccessError("Forbidden", 403);
  }
  const capabilities = await getUnearnedRevenueCapabilities(email, db);
  if (!capabilities.includes(capability)) {
    throw new UnearnedRevenueAccessError("Forbidden", 403);
  }
  return { email, name, capabilities };
}

function rowVersion(input: { createdAt: Date; updatedAt?: Date | null; auditVersion?: number | null }): number {
  return Math.max(
    Math.floor(input.createdAt.getTime() / 1_000),
    input.updatedAt ? Math.floor(input.updatedAt.getTime() / 1_000) : 0,
    input.auditVersion ?? 0,
  );
}

export async function listUnearnedRevenueAccessRows(
  db: Database = getDb(),
): Promise<UnearnedRevenueAccessRow[]> {
  const [admins, grants, auditVersions] = await Promise.all([
    db.select({ email: schema.adminUsers.email, name: schema.adminUsers.name, createdAt: schema.adminUsers.createdAt })
      .from(schema.adminUsers).orderBy(asc(schema.adminUsers.email)),
    db.select({
      email: schema.unearnedRevenueAccessGrants.email,
      capability: schema.unearnedRevenueAccessGrants.capability,
      updatedAt: schema.unearnedRevenueAccessGrants.updatedAt,
    }).from(schema.unearnedRevenueAccessGrants),
    db.select({
      email: schema.unearnedRevenueAccessAuditLog.targetEmail,
      version: sql<number>`max(${schema.unearnedRevenueAccessAuditLog.version})`,
    }).from(schema.unearnedRevenueAccessAuditLog)
      .groupBy(schema.unearnedRevenueAccessAuditLog.targetEmail),
  ]);
  const grantsByEmail = new Map<string, typeof grants>();
  for (const grant of grants) {
    const email = normalizeUnearnedRevenueEmail(grant.email);
    grantsByEmail.set(email, [...(grantsByEmail.get(email) ?? []), grant]);
  }
  const auditsByEmail = new Map(auditVersions.map((row) => [normalizeUnearnedRevenueEmail(row.email), Number(row.version)]));
  return admins.map((admin) => {
    const email = normalizeUnearnedRevenueEmail(admin.email);
    const userGrants = grantsByEmail.get(email) ?? [];
    return {
      email,
      name: admin.name,
      capabilities: normalizeUnearnedRevenueCapabilities(userGrants.map((row) => row.capability)),
      version: rowVersion({
        createdAt: admin.createdAt,
        updatedAt: userGrants.reduce<Date | null>(
          (latest, row) => !latest || row.updatedAt > latest ? row.updatedAt : latest,
          null,
        ),
        auditVersion: auditsByEmail.get(email),
      }),
    };
  });
}

export async function replaceUnearnedRevenueCapabilities(input: {
  actorEmail: string;
  targetEmail: string;
  capabilities: readonly string[];
  expectedVersion: number;
  note?: string | null;
  db?: Database;
}): Promise<UnearnedRevenueCapability[]> {
  const db = input.db ?? getDb();
  const actorEmail = normalizeUnearnedRevenueEmail(input.actorEmail);
  const targetEmail = normalizeUnearnedRevenueEmail(input.targetEmail);
  if (!actorEmail || !targetEmail) {
    throw new UnearnedRevenueAccessError("Actor and target email are required", 422);
  }
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new UnearnedRevenueAccessError("Expected version is required", 409);
  }

  return withUnearnedRevenueTransaction(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('unearned_revenue_access_grants'))`);
    await tx.execute(sql`
      select id from admin_users
      where lower(btrim(email)) in (${actorEmail}, ${targetEmail})
      for key share
    `);

    const [actorAdmin, targetAdmin, actorCapabilities, currentRows, managerRows, lastAudit] = await Promise.all([
      tx.select({ email: schema.adminUsers.email }).from(schema.adminUsers)
        .where(sql<boolean>`lower(btrim(${schema.adminUsers.email})) = ${actorEmail}`).limit(1).then((rows) => rows[0]),
      tx.select({ email: schema.adminUsers.email, createdAt: schema.adminUsers.createdAt }).from(schema.adminUsers)
        .where(sql<boolean>`lower(btrim(${schema.adminUsers.email})) = ${targetEmail}`).limit(1).then((rows) => rows[0]),
      getUnearnedRevenueCapabilities(actorEmail, tx),
      tx.select({ capability: schema.unearnedRevenueAccessGrants.capability, updatedAt: schema.unearnedRevenueAccessGrants.updatedAt })
        .from(schema.unearnedRevenueAccessGrants)
        .where(sql<boolean>`lower(btrim(${schema.unearnedRevenueAccessGrants.email})) = ${targetEmail}`),
      tx.select({ email: schema.unearnedRevenueAccessGrants.email }).from(schema.unearnedRevenueAccessGrants)
        .innerJoin(schema.adminUsers, sql<boolean>`lower(btrim(${schema.adminUsers.email})) = lower(btrim(${schema.unearnedRevenueAccessGrants.email}))`)
        .where(eq(schema.unearnedRevenueAccessGrants.capability, "access_manager")),
      tx.select({ version: schema.unearnedRevenueAccessAuditLog.version })
        .from(schema.unearnedRevenueAccessAuditLog)
        .where(eq(schema.unearnedRevenueAccessAuditLog.targetEmail, targetEmail))
        .orderBy(sql`${schema.unearnedRevenueAccessAuditLog.version} desc`).limit(1).then((rows) => rows[0]),
    ]);
    if (!actorAdmin) throw new UnearnedRevenueAccessError("Actor must be an allowlisted admin", 403);
    if (!targetAdmin) throw new UnearnedRevenueAccessError("Target must be an allowlisted admin", 404);

    const currentCapabilities = normalizeUnearnedRevenueCapabilities(currentRows.map((row) => row.capability));
    const nextCapabilities = normalizeUnearnedRevenueCapabilities(input.capabilities);
    const currentVersion = rowVersion({
      createdAt: targetAdmin.createdAt,
      updatedAt: currentRows.reduce<Date | null>(
        (latest, row) => !latest || row.updatedAt > latest ? row.updatedAt : latest,
        null,
      ),
      auditVersion: lastAudit?.version,
    });
    assertUnearnedRevenueCapabilityReplacementAllowed({
      actorEmail,
      targetEmail,
      actorCapabilities,
      currentCapabilities,
      nextCapabilities,
      accessManagerCount: new Set(managerRows.map((row) => normalizeUnearnedRevenueEmail(row.email))).size,
      currentVersion,
      expectedVersion: input.expectedVersion,
    });

    const nextVersion = nextUnearnedRevenueCapabilityVersion(currentVersion, Date.now());
    const changedAt = new Date(nextVersion * 1_000);
    if (nextCapabilities.length > 0) {
      await tx.insert(schema.unearnedRevenueAccessGrants).values(nextCapabilities.map((item) => ({
        email: targetEmail,
        capability: item,
        grantedByEmail: actorEmail,
        updatedAt: changedAt,
      }))).onConflictDoUpdate({
        target: [schema.unearnedRevenueAccessGrants.email, schema.unearnedRevenueAccessGrants.capability],
        set: { grantedByEmail: actorEmail, updatedAt: changedAt },
      });
    }
    if (nextCapabilities.length === 0) {
      await tx.delete(schema.unearnedRevenueAccessGrants)
        .where(eq(schema.unearnedRevenueAccessGrants.email, targetEmail));
    } else {
      await tx.delete(schema.unearnedRevenueAccessGrants).where(and(
        eq(schema.unearnedRevenueAccessGrants.email, targetEmail),
        notInArray(schema.unearnedRevenueAccessGrants.capability, nextCapabilities),
      ));
    }
    await tx.insert(schema.unearnedRevenueAccessAuditLog).values({
      targetEmail,
      action: "capabilities_replaced",
      actorEmail,
      beforeValue: { capabilities: currentCapabilities, version: currentVersion },
      afterValue: { capabilities: nextCapabilities, version: nextVersion },
      version: nextVersion,
      note: input.note?.trim() || null,
    });
    return nextCapabilities;
  });
}
