import { sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { withDatabaseTransaction } from "@/lib/db/transaction";

export type DailyRefreshKind = "shared" | "progress";
export const DAILY_SLOTS = { shared: [380, 410, 440], progress: [445, 475, 505] } as const;
const tables = { shared: "credit_control_sync_runs", progress: "progress_test_sync_runs" } as const;

export function bangkokDailyWindow(now: Date, kind: DailyRefreshKind) {
  const local = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  const day = local.toISOString().slice(0, 10);
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  const slot = DAILY_SLOTS[kind].find(value => minute >= value && minute < value + 10);
  const start = new Date(`${day}T00:00:00+07:00`);
  const due = new Date(start.getTime() + DAILY_SLOTS[kind][0] * 60_000);
  return { day, slot, start, due };
}

export function dailySkip(reason: string) {
  return { success: true as const, skipped: true as const, reason, message: reason };
}

export async function hasTodayRefresh(db: Database, kind: DailyRefreshKind, now: Date): Promise<boolean> {
  const { due } = bangkokDailyWindow(now, kind);
  const table = sql.raw(tables[kind]);
  const promoted = kind === "shared" ? sql`and promoted_snapshot_id is not null` : sql``;
  const result = await db.execute(sql`select id from ${table} where status = 'success' and started_at >= ${due} and finished_at <= ${now} ${promoted} limit 1`);
  return result.rows.length > 0;
}

/** The transaction covers eligibility AND acquisition, never the Wise work. */
export async function claimDailyRefresh<T extends { syncRunId: string; skipped?: boolean }>(
  db: Database, kind: DailyRefreshKind, now: Date, claim: (tx: Database) => Promise<T>,
): Promise<T | ReturnType<typeof dailySkip>> {
  const { day, slot, start } = bangkokDailyWindow(now, kind);
  if (slot === undefined) return dailySkip("outside_daily_refresh_window");
  return withDatabaseTransaction(db, async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`daily-refresh:${kind}`}))`);
    if (await hasTodayRefresh(tx, kind, now)) return dailySkip("daily_refresh_complete");
    const table = sql.raw(tables[kind]);
    const attempts = await tx.execute(sql`select metadata from ${table} where started_at >= ${start} and metadata->>'dailyDate' = ${day} and metadata->>'dailyTrigger' = 'cron'`);
    if (attempts.rows.length >= 3 || attempts.rows.some(row => String((row.metadata as Record<string, unknown>)?.dailySlot) === String(slot))) {
      return dailySkip("daily_attempt_already_recorded");
    }
    if (kind === "progress" && !await hasTodayRefresh(tx, "shared", now)) return dailySkip("waiting_for_today_shared_snapshot");
    const guard = await claim(tx);
    if (!guard.skipped) {
      const metadata = JSON.stringify({ dailyDate: day, dailySlot: slot, dailyTrigger: "cron" });
      await tx.execute(sql`update ${table} set metadata = coalesce(metadata, '{}'::jsonb) || ${metadata}::jsonb where id = ${guard.syncRunId}::uuid`);
    }
    return guard;
  });
}
