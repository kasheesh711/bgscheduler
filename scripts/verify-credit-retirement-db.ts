/** Exercises real Postgres lease and daily-claim SQL using session-local TEMP tables only. */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { config } from "dotenv";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import type { Database } from "../src/lib/db";
import { createLiveMonthCache } from "../src/lib/student-schedule/live-cache";
import { claimDailyRefresh } from "../src/lib/credit-control/daily-refresh";
config({ path: ".env.local", quiet: true });
async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10_000, options: "-c statement_timeout=15000" });
  await client.connect();
  try {
    await client.query(readFileSync("drizzle/0082_student_schedule_live_cache.sql", "utf8").replace("CREATE TABLE IF NOT EXISTS", "CREATE TEMP TABLE"));
    const db = drizzle(client) as unknown as Database;
    const a = createLiveMonthCache(db), b = createLiveMonthCache(db);
    const key = "test:month", first = randomUUID(), second = randomUUID();
    assert.equal(await a.claim(key, first, new Date(), false, new Date()), true);
    assert.equal(await b.claim(key, second, new Date(), false, new Date()), false);
    assert.equal(await b.publish(key, second, [], new Date()), false);
    const observed = new Date();
    assert.equal(await a.publish(key, first, [], observed), true);
    assert.deepEqual((await b.read(key))?.sessions, []);
    assert.equal((await b.read(key))?.fetchedAt?.toISOString(), observed.toISOString());
    const later = new Date(Date.now() + 1_000);
    assert.equal(await b.claim(key, second, later, true, later), true);
    await b.fail(key, second);
    assert.deepEqual((await a.read(key))?.sessions, []);
    assert.equal(await a.claim(key, first, later, true, later), false);
    await client.query("CREATE TEMP TABLE credit_control_sync_runs (id uuid primary key default gen_random_uuid(), status text default 'running', started_at timestamptz, finished_at timestamptz, metadata jsonb, promoted_snapshot_id uuid)");
    const now = new Date("2026-09-10T23:20:00Z");
    const claim = async (tx: Database) => {
      const result = await tx.execute(sql`insert into credit_control_sync_runs (started_at) values (${now}) returning id`);
      return { syncRunId: String(result.rows[0].id) };
    };
    const firstRun = await claimDailyRefresh(db, "shared", now, claim);
    assert.ok("syncRunId" in firstRun);
    assert.ok("skipped" in await claimDailyRefresh(db, "shared", now, claim));
    await client.query("update credit_control_sync_runs set status='success', finished_at=$1, promoted_snapshot_id=gen_random_uuid()", [now]);
    assert.equal((await claimDailyRefresh(db, "shared", new Date("2026-09-10T23:50:00Z"), claim) as { reason: string }).reason, "daily_refresh_complete");
    console.log("PASS: real Postgres lease ownership, empty-month persistence, cooldown, preserved source time, and daily deduplication. Only TEMP tables were written.");
  } finally { await client.end(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Verification failed"); process.exitCode = 1; });
