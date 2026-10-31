import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Pool } from "pg";
import { z } from "zod";
import { loadEnvConfig } from "@next/env";
import { getDb } from "../src/lib/db";
import { settings } from "../src/lib/hiring/service";
import { assessCandidates } from "../src/lib/hiring/worker";
import { subscriptionAuthSchema } from "../src/lib/hiring/model";
import { assessmentSchema, ASSESSMENT_SYSTEM } from "../src/lib/hiring/scoring";
import { runClaude, claudeChildEnv } from "../src/lib/feedback-autowriter/nightly/claude-runner";

async function main() {
  loadEnvConfig(process.cwd());
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const lease = await pool.connect();
  try {
    const lock = await lease.query("select pg_try_advisory_lock(hashtext('hiring-worker')) as locked");
    if (!lock.rows[0]?.locked) throw new Error("Another hiring worker is running.");
    subscriptionAuthSchema.parse(JSON.parse(execFileSync("claude", ["auth", "status"], { encoding: "utf8", env: claudeChildEnv() })));
    const cliVersion = execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
    const home = path.join(os.homedir(), ".bgscheduler-hiring");
    const cwd = path.join(home, "model-cwd");
    fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const db = getDb();
    let total = 0;
    for (;;) {
      const { config } = await settings(db);
      if (config.enabled || config.deliveryEnabled) throw new Error("Pause live hiring and messages before review scoring.");
      const calls = await assessCandidates(db, config, async (source, key) => {
        const result = await runClaude({ purpose: "hiring-review-score", key, system: ASSESSMENT_SYSTEM, user: source, schema: z.toJSONSchema(assessmentSchema, { target: "draft-07" }), budgetUsd: 3 }, { cwd, cliVersion, callsLog: path.join(home, "model-calls.jsonl") });
        if (result.kind !== "success") throw new Error(`Subscription scoring stopped: ${result.kind}`);
        return result.value;
      }, 10, true);
      total += calls;
      const progress = { at: new Date().toISOString(), mode: "score only", calls: total, complete: calls === 0 };
      fs.writeFileSync(path.join(home, "scoring-progress.json"), JSON.stringify(progress), { mode: 0o600 });
      console.log(JSON.stringify(progress));
      if (!calls) break;
    }
  } finally {
    await lease.query("select pg_advisory_unlock(hashtext('hiring-worker'))");
    lease.release();
    await pool.end();
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Scoring failed."); process.exitCode = 1; });
