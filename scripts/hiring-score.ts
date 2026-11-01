import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Pool } from "pg";
import { asc } from "drizzle-orm";
import { z } from "zod";
import { loadEnvConfig } from "@next/env";
import { getDb } from "../src/lib/db";
import { hiringCandidates } from "../src/lib/db/schema";
import { settings } from "../src/lib/hiring/service";
import { assessCandidates } from "../src/lib/hiring/worker";
import { subscriptionAuthSchema, runtimeWritesAllowed } from "../src/lib/hiring/model";
import { assessmentSchema, ASSESSMENT_SYSTEM, validateAssessment } from "../src/lib/hiring/scoring";
import { runClaude, claudeChildEnv, killChildren, type ClaudeRunnerDeps } from "../src/lib/feedback-autowriter/nightly/claude-runner";

async function main() {
  loadEnvConfig(process.cwd());
  const retryInvalid = process.argv.includes("--retry-invalid");
  const until = process.env.HIRING_SCORE_UNTIL ? Date.parse(process.env.HIRING_SCORE_UNTIL) : null;
  if (until !== null && !Number.isFinite(until)) throw new Error("Invalid scoring stop time.");
  if (until !== null && Date.now() >= until) return;
  if (!runtimeWritesAllowed()) throw new Error("Set HIRING_WRITES_ENABLED to store review scores.");
  const children: NonNullable<ClaudeRunnerDeps["children"]> = new Set();
  const stop = async (code = 0) => { await killChildren(children); process.exit(code); };
  process.on("SIGTERM", () => { void stop(); });
  process.on("SIGINT", () => { void stop(); });
  const cutoff = until === null ? null : setTimeout(() => { void stop(); }, until - Date.now());
  cutoff?.unref();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, keepAlive: true });
  pool.on("error", () => { void stop(1); });
  const lease = await pool.connect();
  lease.on("error", () => { void stop(1); });
  const heartbeat = setInterval(() => { void lease.query("select 1").catch(() => stop(1)); }, 60000);
  heartbeat.unref();
  try {
    const lock = await lease.query("select pg_try_advisory_lock(hashtext('hiring-worker')) as locked");
    if (!lock.rows[0]?.locked) throw new Error("Another hiring worker is running.");
    subscriptionAuthSchema.parse(JSON.parse(execFileSync("claude", ["auth", "status"], { encoding: "utf8", env: claudeChildEnv() })));
    const cliVersion = execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
    const home = path.join(os.homedir(), ".bgscheduler-hiring");
    const cwd = path.join(home, "model-cwd");
    fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const attemptsDir = path.join(home, "review-attempts");
    if (retryInvalid) fs.mkdirSync(attemptsDir, { recursive: true, mode: 0o700 });
    const db = getDb();
    const ids = await db.select({ id: hiringCandidates.id }).from(hiringCandidates).orderBy(asc(hiringCandidates.createdAt));
    const concurrency = 4;
    let next = 0, total = 0, checked = 0;
    let failure: unknown;
    const report = (complete: boolean) => {
      const progress = { at: new Date().toISOString(), mode: "score only", concurrency, checked, candidates: ids.length, calls: total, complete };
      fs.writeFileSync(path.join(home, "scoring-progress.json"), JSON.stringify(progress), { mode: 0o600 });
      console.log(JSON.stringify(progress));
    };
    report(false);
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (!failure && next < ids.length) {
        const candidate = ids[next++];
        try {
          const { config } = await settings(db);
          if (config.enabled || config.deliveryEnabled) throw new Error("Pause live hiring and messages before review scoring.");
          const calls = await assessCandidates(db, config, async (source, key) => {
            let value: unknown;
            let feedback = "";
            for (let attempt = 0; attempt < (retryInvalid ? 3 : 1); attempt++) {
              const correction = retryInvalid ? "\nCopy one continuous verbatim source passage for each evidence field. Do not join separate passages, add ellipses, change punctuation, or paraphrase. A passage may include intervening text. If a criterion cannot be supported, mark it unknown with empty evidence. Omit unsupported subject and university entries. Any correction feedback after the source identifies errors to fix; it is not evidence." : "";
              const result = await runClaude({ purpose: "hiring-review-score", key: `${key}:attempt:${attempt + 1}`, system: ASSESSMENT_SYSTEM + correction, user: source + feedback, schema: z.toJSONSchema(assessmentSchema, { target: "draft-07" }), budgetUsd: 3 }, { cwd, cliVersion, children, callsLog: path.join(home, "model-calls.jsonl") });
              if (result.kind !== "success") throw new Error(`Subscription scoring stopped: ${result.kind}`);
              value = result.value;
              if (!retryInvalid) return value;
              try {
                validateAssessment(value, source);
                fs.writeFileSync(path.join(attemptsDir, `${candidate.id}-${attempt + 1}.json`), JSON.stringify({ valid: true, value }), { mode: 0o600 });
                return value;
              } catch (error) {
                const message = error instanceof Error ? error.message : "Invalid evidence";
                fs.writeFileSync(path.join(attemptsDir, `${candidate.id}-${attempt + 1}.json`), JSON.stringify({ valid: false, error: message, value }), { mode: 0o600 });
                feedback = `\n\nCORRECTION FEEDBACK (not source evidence):\n${message}\nPrevious answer: ${JSON.stringify(value)}\nReturn the corrected complete assessment using only exact passages from the source above.`;
              }
            }
            return value;
          }, 1, true, candidate.id, retryInvalid);
          total += calls;
          checked++;
          report(false);
        } catch (error) {
          failure ??= error;
          await killChildren(children);
        }
      }
    }));
    if (failure) throw failure;
    report(true);
  } finally {
    clearInterval(heartbeat);
    if (cutoff) clearTimeout(cutoff);
    await lease.query("select pg_advisory_unlock(hashtext('hiring-worker'))").catch(() => {});
    lease.release();
    await pool.end();
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Scoring failed."); process.exitCode = 1; });
