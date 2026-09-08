/** Apply the additive work schema and resume the leave-source backlog.
 * First use --migrate-only, deploy the new cron code, then use --apply --deployed --passes=1.
 * Source imports and summaries are written; no parent messages or Wise mutations.
 */
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import * as schema from "../src/lib/db/schema";
import type { Database } from "../src/lib/db";
import { syncLeaveRequests } from "../src/lib/leave-requests/sync";

async function main() {
  const migrateOnly = process.argv.includes("--migrate-only");
  if (!migrateOnly && (!process.argv.includes("--apply") || !process.argv.includes("--deployed"))) throw new Error("Use --migrate-only first. After deploying the new cron code, pass --apply --deployed to recover and resume. Recovering before deployment lets the old cron send catch-up emails.");
  const passes = Number(process.argv.find((arg) => arg.startsWith("--passes="))?.split("=")[1] ?? 1);
  if (!Number.isInteger(passes) || passes < 1 || passes > 10) throw new Error("--passes must be between 1 and 10.");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  try {
    const db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: "drizzle" });
    const before = await db.execute(sql`select count(*)::int as requests, max(source_row_number)::int as last_source_row from leave_requests`);
    console.log(JSON.stringify({ event: "schema_ready", before: before.rows }));
    if (migrateOnly) return;
    for (let pass = 1; pass <= passes; pass++) {
      const result = await syncLeaveRequests(db as unknown as Database, { triggerType: "manual", suppressNotifications: true });
      console.log(JSON.stringify({ event: "pass_complete", pass, ...result }));
      const counts = await db.execute(sql`select n.status, count(*)::int as count from leave_normalizations n join leave_requests r on r.id=n.request_id and r.current_normalization_key=n.input_key group by n.status`);
      console.log(JSON.stringify({ event: "normalization_status", counts: counts.rows }));
      if (result.processing?.serviceError || (!result.processing?.remaining && !result.reconciliation?.remaining)) break;
    }
  } finally { await pool.end(); }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "Leave recovery failed."); process.exitCode = 1; });
