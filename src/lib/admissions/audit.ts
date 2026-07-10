// Admissions Case Management — append-only audit writes + transactional pairing,
// plus the paginated read behind the admin audit-trail view (design §4
// `/audit/[caseId]`).
//
// Design: docs/casemanagementsystem_design.md §3 (admissions_audit_log is
// append-only; sensitive mutations commit atomically with their audit row).
// The transaction discipline copies src/lib/payroll/sync.ts: try the Drizzle
// driver's transaction first, and when the neon-http driver rejects it, fall
// back to a node-postgres Pool with explicit BEGIN/COMMIT/ROLLBACK.

import { count, desc, eq } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import type { Pool } from "pg";
import * as schema from "@/lib/db/schema";
import type { CaseRole } from "./types";

/** Field-level jsonb diff persisted to admissions_audit_log.diff. */
export type AdmissionsFieldDiff = Record<string, { old: unknown; new: unknown }>;

/** One append-only audit entry (admissions_audit_log row minus id/createdAt). */
export interface AdmissionsAuditEntry {
  /** Case scope; null for cross-case/admin actions (e.g. registry edits). */
  caseId: string | null;
  actorEmail: string;
  actorRole: CaseRole;
  entityType: string;
  entityId: string;
  action: string;
  diff?: AdmissionsFieldDiff | null;
}

/**
 * Narrow write surface usable both against the plain Database singleton and
 * inside a transaction callback (either driver).
 */
export type AdmissionsWriteDb = Pick<Database, "select" | "insert" | "update" | "delete">;

let admissionsWritePool: Pool | null = null;

// `pg` (and the node-postgres drizzle adapter below) are loaded lazily so this
// module stays importable from client-component graphs — a static import drags
// node builtins (dns/net/tls) into the browser bundle and breaks `next build`.
async function getAdmissionsWritePool(): Promise<Pool> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  if (!admissionsWritePool) {
    const { Pool: PgPool } = await import("pg");
    admissionsWritePool = new PgPool({ connectionString: databaseUrl, max: 1 });
  }
  return admissionsWritePool;
}

function isNeonHttpTransactionUnsupported(error: unknown): boolean {
  return error instanceof Error && /No transactions support in neon-http driver/i.test(error.message);
}

/**
 * Inserts one append-only audit row. Throws on failure so that callers inside
 * withAuditedTransaction roll the paired mutation back; fire-and-forget
 * callers (low-stakes writes like task ticks) must attach their own
 * `.catch(console.error)`.
 */
export async function writeAuditLog(db: AdmissionsWriteDb, entry: AdmissionsAuditEntry): Promise<void> {
  await db.insert(schema.admissionsAuditLog).values({
    caseId: entry.caseId,
    actorEmail: entry.actorEmail.trim().toLowerCase(),
    actorRole: entry.actorRole,
    entityType: entry.entityType,
    entityId: entry.entityId,
    action: entry.action,
    diff: entry.diff ?? null,
  });
}

/**
 * Runs `fn` inside a database transaction so a mutation and its audit row
 * commit or roll back atomically (design §3 "Transactions").
 *
 * 1. Attempt the Drizzle driver transaction (`db.transaction`).
 * 2. When the neon-http driver rejects transactions, fall back to a dedicated
 *    node-postgres Pool (max 1, module-cached) — same pattern as payroll sync.
 * 3. Fallback path: BEGIN → fn(tx) → COMMIT; any throw triggers ROLLBACK
 *    (best-effort) and re-throws; the client is always released.
 *
 * @returns whatever `fn` resolves to.
 */
export async function withAuditedTransaction<T>(
  fn: (tx: AdmissionsWriteDb) => Promise<T>,
  db: Database = getDb(),
): Promise<T> {
  try {
    return await db.transaction((tx) => fn(tx as AdmissionsWriteDb));
  } catch (error) {
    if (!isNeonHttpTransactionUnsupported(error)) throw error;
  }

  const pool = await getAdmissionsWritePool();
  const client = await pool.connect();
  const { drizzle: drizzleNodePostgres } = await import("drizzle-orm/node-postgres");
  try {
    await client.query("BEGIN");
    const txDb = drizzleNodePostgres(client, { schema }) as unknown as AdmissionsWriteDb;
    const result = await fn(txDb);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Builds the jsonb diff `{field: {old, new}}` for an update, restricted to
 * `fields`, skipping unchanged values.
 *
 * - A `nextValues[field]` of `undefined` means "not part of this update" and
 *   is skipped (partial-update semantics); explicit `null` is a real change.
 * - Dates compare by epoch; plain objects/arrays compare structurally (JSON);
 *   everything else compares strictly.
 * - An absent old value is recorded as `old: null` (jsonb-safe).
 *
 * @returns the diff object; empty (`{}`) when nothing changed.
 */
export function computeFieldDiff(
  oldValues: Record<string, unknown>,
  nextValues: Record<string, unknown>,
  fields: readonly string[],
): AdmissionsFieldDiff {
  const diff: AdmissionsFieldDiff = {};
  for (const field of fields) {
    const next = nextValues[field];
    if (next === undefined) continue;
    const old = oldValues[field];
    if (isSameFieldValue(old, next)) continue;
    diff[field] = { old: old === undefined ? null : old, new: next };
  }
  return diff;
}

/** Default number of audit rows per page in the admin audit-trail view. */
export const AUDIT_LOG_DEFAULT_PAGE_SIZE = 50;

/** Hard cap on audit rows per page (protects the read path from huge scans). */
export const AUDIT_LOG_MAX_PAGE_SIZE = 200;

/** One serialized admissions_audit_log row (read side of the audit trail). */
export interface AdmissionsAuditLogEntryDto {
  id: string;
  caseId: string | null;
  actorEmail: string;
  actorRole: string;
  entityType: string;
  entityId: string;
  action: string;
  diff: AdmissionsFieldDiff | null;
  createdAt: string;
}

/** One page of a case's audit trail, newest first. */
export interface AdmissionsAuditLogPage {
  entries: AdmissionsAuditLogEntryDto[];
  page: number;
  pageSize: number;
  totalCount: number;
}

/**
 * Reads one page of a case's audit trail (admin-only view, design §4
 * `/audit/[caseId]`), newest first. Read-only — the table stays append-only.
 *
 * 1. Clamp pagination: page ≥ 1; 1 ≤ pageSize ≤ AUDIT_LOG_MAX_PAGE_SIZE
 *    (defaults 1 / AUDIT_LOG_DEFAULT_PAGE_SIZE) so hostile query params can
 *    never drive a negative offset or an unbounded scan.
 * 2. Count the case's audit rows for the pager total.
 * 3. Fetch the requested page ordered createdAt DESC, id DESC (stable order
 *    for same-timestamp rows; uses admissions_audit_log_case_created_idx).
 * 4. Serialize timestamps to ISO strings and default a missing diff to null.
 *
 * @returns the page of entries plus the clamped pagination echo and total count.
 */
export async function listCaseAuditLog(
  caseId: string,
  pagination: { page?: number; pageSize?: number } = {},
  db: Database = getDb(),
): Promise<AdmissionsAuditLogPage> {
  const page = Math.max(1, Math.trunc(pagination.page ?? 1));
  const pageSize = Math.min(
    AUDIT_LOG_MAX_PAGE_SIZE,
    Math.max(1, Math.trunc(pagination.pageSize ?? AUDIT_LOG_DEFAULT_PAGE_SIZE)),
  );

  const countRows = await db
    .select({ value: count() })
    .from(schema.admissionsAuditLog)
    .where(eq(schema.admissionsAuditLog.caseId, caseId));
  const totalCount = countRows[0]?.value ?? 0;

  const rows = await db
    .select()
    .from(schema.admissionsAuditLog)
    .where(eq(schema.admissionsAuditLog.caseId, caseId))
    .orderBy(desc(schema.admissionsAuditLog.createdAt), desc(schema.admissionsAuditLog.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return {
    entries: rows.map((row) => ({
      id: row.id,
      caseId: row.caseId,
      actorEmail: row.actorEmail,
      actorRole: row.actorRole,
      entityType: row.entityType,
      entityId: row.entityId,
      action: row.action,
      diff: row.diff ?? null,
      createdAt: row.createdAt.toISOString(),
    })),
    page,
    pageSize,
    totalCount,
  };
}

function isSameFieldValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}
