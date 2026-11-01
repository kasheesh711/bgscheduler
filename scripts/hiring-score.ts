import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Pool } from "pg";
import { asc, isNotNull, or } from "drizzle-orm";
import { z } from "zod";
import { loadEnvConfig } from "@next/env";
import { getDb } from "../src/lib/db";
import { hiringCandidates } from "../src/lib/db/schema";
import { settings } from "../src/lib/hiring/service";
import { assessCandidates, rewriteBriefs, scorePreScreens } from "../src/lib/hiring/worker";
import { subscriptionAuthSchema, runtimeWritesAllowed } from "../src/lib/hiring/model";
import { assessmentOutputSchema, preScreenOutputSchema, briefOutputSchema, assessWithBriefs, ASSESSMENT_SYSTEM, PRE_SCREEN_SYSTEM, BRIEF_SYSTEM, validateAssessment, validatePreScreenAssessment } from "../src/lib/hiring/scoring";
import { runClaude, claudeChildEnv, killChildren, type ClaudeRunnerDeps } from "../src/lib/feedback-autowriter/nightly/claude-runner";

async function main() {
  loadEnvConfig(process.cwd());
  const retryInvalid = process.argv.includes("--retry-invalid");
  // Scores every held pre-screen response at any stage. It changes no stage and sends nothing.
  const preScreen = process.argv.includes("--pre-screen");
  // Fills the short display lines of stored assessments. It changes no result, quote, score or stage and sends nothing.
  const briefs = process.argv.includes("--briefs");
  const system = preScreen ? PRE_SCREEN_SYSTEM : ASSESSMENT_SYSTEM;
  const schema = z.toJSONSchema(preScreen ? preScreenOutputSchema : assessmentOutputSchema, { target: "draft-07" });
  const briefSchema = z.toJSONSchema(briefOutputSchema, { target: "draft-07" });
  const validate = (value: unknown, source: string, written = "") =>
    preScreen ? validatePreScreenAssessment(value, source, written) : validateAssessment(value, source);
  const until = process.env.HIRING_SCORE_UNTIL ? Date.parse(process.env.HIRING_SCORE_UNTIL) : null;
  if (until !== null && !Number.isFinite(until)) throw new Error("Invalid scoring stop time.");
  if (briefs && until === null) throw new Error("Set HIRING_SCORE_UNTIL for the rewrite.");
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
    const ids = await db.select({ id: hiringCandidates.id }).from(hiringCandidates).where(briefs ? or(isNotNull(hiringCandidates.profileAssessment), isNotNull(hiringCandidates.preScreenAssessment)) : preScreen ? isNotNull(hiringCandidates.preScreen) : undefined).orderBy(asc(hiringCandidates.createdAt));
    const concurrency = 4;
    // assessments: how many answers the pass handled. modelCalls: real model calls, retries included.
    // voided: finished answers that could not be stored because the row or the settings changed meanwhile.
    let next = 0, assessments = 0, modelCalls = 0, voided = 0, checked = 0;
    const onVoided = () => { voided++; };
    let failure: unknown;
    const report = (complete: boolean) => {
      const progress = { at: new Date().toISOString(), mode: briefs ? "brief rewrite" : preScreen ? "pre-screen score only" : "score only", concurrency, checked, candidates: ids.length, assessments, calls: modelCalls, voided, complete };
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
          const assess = async (source: string, key: string, _kind?: string, written?: string) => {
            let value: unknown;
            let feedback = "";
            for (let attempt = 0; attempt < (retryInvalid ? 3 : 1); attempt++) {
              const correction = retryInvalid ? "\nCopy one continuous verbatim source passage for each evidence field. Do not join separate passages, add ellipses, change punctuation, or paraphrase. A passage may include intervening text. If a criterion cannot be supported, mark it unknown with empty evidence. Omit unsupported subject and university entries. Any correction feedback after the source identifies errors to fix; it is not evidence." : "";
              let briefAttempt = 0;
              value = await assessWithBriefs(async (briefFeedback) => {
                modelCalls++;
                const result = await runClaude({ purpose: "hiring-review-score", key: `${key}:attempt:${attempt + 1}${briefAttempt++ ? `:briefs:${briefAttempt}` : ""}`, system: system + correction, user: source + feedback + briefFeedback, schema, budgetUsd: 3 }, { cwd, cliVersion, children, callsLog: path.join(home, "model-calls.jsonl") });
                if (result.kind !== "success") throw new Error(`Subscription scoring stopped: ${result.kind}`);
                return result.value;
              });
              if (!retryInvalid) return value;
              try {
                validate(value, source, written);
                fs.writeFileSync(path.join(attemptsDir, `${candidate.id}-${attempt + 1}.json`), JSON.stringify({ valid: true, value }), { mode: 0o600 });
                return value;
              } catch (error) {
                const message = error instanceof Error ? error.message : "Invalid evidence";
                fs.writeFileSync(path.join(attemptsDir, `${candidate.id}-${attempt + 1}.json`), JSON.stringify({ valid: false, error: message, value }), { mode: 0o600 });
                feedback = `\n\nCORRECTION FEEDBACK (not source evidence):\n${message}\nPrevious answer: ${JSON.stringify(value)}\nReturn the corrected complete assessment using only exact passages from the source above.`;
              }
            }
            return value;
          };
          const rewrite = async (user: string, key: string) => {
            modelCalls++;
            const result = await runClaude({ purpose: "hiring-brief-rewrite", key, system: BRIEF_SYSTEM, user, schema: briefSchema, budgetUsd: 1 }, { cwd, cliVersion, children, callsLog: path.join(home, "model-calls.jsonl") });
            if (result.kind !== "success") throw new Error(`Subscription brief rewrite stopped: ${result.kind}`);
            return result.value;
          };
          const calls = briefs
            ? await rewriteBriefs(db, rewrite, { max: 2, candidateId: candidate.id, onVoided })
            : preScreen
            ? await scorePreScreens(db, config, assess, { candidateId: candidate.id, retryInvalid, onVoided })
            : await assessCandidates(db, config, assess, 1, true, candidate.id, retryInvalid, onVoided);
          assessments += calls;
          checked++;
          report(false);
        } catch (error) {
          failure ??= error;
          await killChildren(children);
        }
      }
    }));
    if (failure) throw failure;
    // A pass that stored nothing for some answers is not a clean finish.
    report(voided === 0);
    if (voided) { console.error(`${voided} finished answer(s) were not stored because a row or the settings changed. Run the pass again.`); process.exitCode = 2; }
  } finally {
    clearInterval(heartbeat);
    if (cutoff) clearTimeout(cutoff);
    await lease.query("select pg_advisory_unlock(hashtext('hiring-worker'))").catch(() => {});
    lease.release();
    await pool.end();
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Scoring failed."); process.exitCode = 1; });
