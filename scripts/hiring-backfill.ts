import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { loadEnvConfig } from "@next/env";
import { getDb } from "../src/lib/db";
import * as s from "../src/lib/db/schema";
import { runtimeWritesAllowed } from "../src/lib/hiring/model";
import { settings } from "../src/lib/hiring/service";
import { importMissingTracker, reconcileTracker } from "../src/lib/hiring/sources";
import { countOrphanResumes, createBackfillStep, parseBackfillArgs } from "../src/lib/hiring/backfill";
import { backfillSeek, SEEK_PAUSE_MS } from "./hiring-seek";

/** One-time passes over SEEK and the tracker. Counts are printed; names, emails and file names never are. */
async function main() {
  loadEnvConfig(process.cwd());
  const args = parseBackfillArgs(process.argv.slice(2), process.env);
  const db = getDb();
  const { config } = await settings(db);
  if (args.mode === "tracker-report") {
    const result = await reconcileTracker(db, config);
    console.log(JSON.stringify({ sourcing: result.sourcing, scheduling: result.scheduling, missingRows: result.missing.length, noEmail: result.noEmail }));
    return;
  }
  if (!runtimeWritesAllowed()) throw new Error("Set HIRING_WRITES_ENABLED only after the release checks.");
  if (config.enabled || config.deliveryEnabled) throw new Error("Pause live hiring and messages before this pass.");
  // The same lock as the worker and the scoring pass, so they cannot run together.
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, keepAlive: true });
  const lease = await pool.connect();
  let lost = false;
  lease.on("error", () => { lost = true; });
  const heartbeat = setInterval(() => { void lease.query("select 1").catch(() => { lost = true; }); }, 60000);
  heartbeat.unref();
  try {
    const lock = await lease.query("select pg_try_advisory_lock(hashtext('hiring-worker')) as locked");
    if (!lock.rows[0]?.locked) throw new Error("Another hiring worker is running.");
    if (args.mode === "tracker-import") {
      console.log(JSON.stringify({ added: await importMissingTracker(db, config) }));
      return;
    }
    let stopping = false;
    process.on("SIGINT", () => { stopping = true; });
    process.on("SIGTERM", () => { stopping = true; });
    const stored = async () => Number((await db.select({ n: sql<number>`count(${s.hiringCandidates.resumePath})` }).from(s.hiringCandidates))[0].n);
    const seen = async () => (await settings(db)).config.seenWorkRights.length;
    const [filesBefore, answersBefore] = [await stored(), await seen()];
    const step = createBackfillStep({
      db,
      until: args.until!,
      limit: args.limit,
      pause: SEEK_PAUSE_MS,
      shouldStop: () => stopping || lost,
    });
    let read = 0, skipped = 0, stoppedEarly = false;
    try {
      const outcome = await backfillSeek(path.join(os.homedir(), ".bgscheduler-hiring", "seek-profile"), config.seekJobId, async (id, load) => {
        const result = await step(id, load);
        if (result === "read") read++;
        else if (result === "skipped") skipped++;
        return result;
      });
      stoppedEarly = outcome.stopped;
    } finally {
      // Printed even when the pass fails part-way, because each candidate was saved as it was read.
      const [filesAfter, answersAfter] = [await stored(), await seen()];
      const noFile = await db.$count(s.hiringCandidates, sql`${s.hiringCandidates.resumePath} is null and ${s.hiringCandidates.resumeStoredAt} is null and jsonb_array_length(${s.hiringCandidates.sourceIds}) > 0`);
      const orphanFiles = await countOrphanResumes(db).catch(() => null);
      console.log(JSON.stringify({ read, skipped, stoppedEarly, filesStored: filesAfter - filesBefore, newWorkRightsAnswers: answersAfter - answersBefore, candidatesWithNoFile: noFile, orphanFiles }));
    }
  } finally {
    clearInterval(heartbeat);
    await lease.query("select pg_advisory_unlock(hashtext('hiring-worker'))").catch(() => {});
    lease.release();
    await pool.end();
  }
}
main().catch((error) => {
  const message = error instanceof Error ? error.message : "Backfill failed.";
  console.error(message.startsWith("Usage:") ? message : message.split("\n", 1)[0].slice(0, 300));
  process.exitCode = 1;
});
