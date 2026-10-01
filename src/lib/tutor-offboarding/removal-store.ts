import { asc, desc, eq, inArray } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import { tutorOffboardingRuns as runs, tutorOffboardingRunAccounts as accounts } from "@/lib/db/schema";
import type { RemovalRunDetail, RemovalAccount, RemovalRun } from "./removal-types";

export function serializeRemovalRun(row: typeof runs.$inferSelect, rows: Array<typeof accounts.$inferSelect>): RemovalRunDetail {
  return { ...row, status: row.status as RemovalRun["status"], mode: row.mode as RemovalRun["mode"],
    createdAt: row.createdAt.toISOString(), previewExpiresAt: row.previewExpiresAt.toISOString(),
    appliedAt: row.appliedAt?.toISOString() ?? null, finishedAt: row.finishedAt?.toISOString() ?? null,
    accounts: rows.map(a => ({ ...a, status: a.status as RemovalAccount["status"], plan: a.plan as RemovalAccount["plan"],
      sentAt: a.sentAt?.toISOString() ?? null, verifiedAt: a.verifiedAt?.toISOString() ?? null })) };
}
export async function getRemovalRun(runId: string, db: Database = getDb()): Promise<RemovalRunDetail | null> {
  const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  if (!row) return null;
  return serializeRemovalRun(row, await db.select().from(accounts).where(eq(accounts.runId, runId)).orderBy(asc(accounts.displayName), asc(accounts.wiseTeacherId)));
}
export async function listRemovalRuns(db: Database = getDb()): Promise<RemovalRunDetail[]> {
  const rows = await db.select().from(runs).orderBy(desc(runs.createdAt)).limit(100);
  if (!rows.length) return [];
  const items = await db.select().from(accounts).where(inArray(accounts.runId, rows.map(r => r.id))).orderBy(asc(accounts.displayName), asc(accounts.wiseTeacherId));
  return rows.map(r => serializeRemovalRun(r, items.filter(a => a.runId === r.id)));
}
