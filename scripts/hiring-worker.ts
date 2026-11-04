import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { Pool } from "pg";
import { z } from "zod";
import { loadEnvConfig } from "@next/env";
import { getDb } from "../src/lib/db";
import { hiringCandidates, hiringOutbox, hiringSettings } from "../src/lib/db/schema";
import { eq } from "drizzle-orm";
import {
  LEGACY_SEEK_JOB_ID,
  configSchema,
  runtimeWritesAllowed,
  subscriptionAuthSchema,
} from "../src/lib/hiring/model";
import { settings } from "../src/lib/hiring/service";
import { importApplication, observeSeekState } from "../src/lib/hiring/sources";
import { keepResume } from "../src/lib/hiring/resume-files";
import { runHiringCycle, sendOneRefusal } from "../src/lib/hiring/worker";
import { requestDelivery } from "../src/lib/hiring/dispatch";
import { mergeSourceSummaries } from "../src/lib/hiring/seek-view";
import { assessmentOutputSchema, preScreenOutputSchema, assessWithBriefs, ASSESSMENT_SYSTEM, PRE_SCREEN_SYSTEM } from "../src/lib/hiring/scoring";
import {
  runClaude,
  killChildren,
  claudeChildEnv,
  type ClaudeRunnerDeps,
} from "../src/lib/feedback-autowriter/nightly/claude-runner";
import { connectSeek, importSeek } from "./hiring-seek";

async function main() {
  if (Number(process.versions.node.split(".")[0]) < 24)
    throw new Error("Use Node.js 24 or newer for the hiring worker.");
  const mode = process.argv[2];
  if (!["--connect-seek", "--once", "--watch", "--send-one"].includes(mode)) {
    console.log(
      "Usage: npm run hiring:worker -- --connect-seek | --once | --watch | --send-one <candidate id>\nConnect once, then use --watch for a 15-minute cycle. No model API key is used.\n--send-one sends one pre-screen form that a click queued, and nothing else.",
    );
    return;
  }
  loadEnvConfig(process.cwd());
  const home = path.join(os.homedir(), ".bgscheduler-hiring");
  const profile = path.join(home, "seek-profile");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  if (mode === "--connect-seek") {
    const { config } = await settings();
    await connectSeek(profile, config.seekJobs.find((j) => j.active)?.jobId ?? LEGACY_SEEK_JOB_ID);
    return;
  }
  if (!runtimeWritesAllowed())
    throw new Error(
      "Set HIRING_WRITES_ENABLED only after the release checks and live-send approval.",
    );
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const lease = await pool.connect();
  const lock = await lease.query(
    "select pg_try_advisory_lock(hashtext('hiring-worker')) as locked",
  );
  if (!lock.rows[0]?.locked) {
    lease.release();
    await pool.end();
    throw new Error("Another hiring worker is running.");
  }
  const children: NonNullable<ClaudeRunnerDeps["children"]> = new Set();
  let stop = false;
  const stopWorker = () => {
    stop = true;
    void killChildren(children);
  };
  process.on("SIGINT", stopWorker);
  process.on("SIGTERM", stopWorker);
  const cwd = path.join(home, "model-cwd");
  fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const db = getDb();
  try {
    if (mode === "--send-one") {
      const id = z.uuid().parse(process.argv[3]);
      const key = `${id}:pre-screen`;
      const [candidate] = await db.select({ stage: hiringCandidates.stage }).from(hiringCandidates).where(eq(hiringCandidates.id, id));
      const form = async () => (await db.select({ status: hiringOutbox.status }).from(hiringOutbox).where(eq(hiringOutbox.key, key)))[0]?.status;
      const refusal = sendOneRefusal(candidate?.stage, await form());
      if (refusal) throw new Error(refusal);
      const { sent } = await requestDelivery({ mode: "one", key });
      console.log(JSON.stringify({ sent, status: await form() }));
      return;
    }
    do {
      try {
        const { config } = await settings(db);
        // A stored config that breaks a rule stops the worker with a message Kevin can act on. A save repairs it.
        const rules = configSchema.safeParse(config);
        if (!rules.success)
          throw new Error(
            `A saved rule has a problem: ${rules.error.issues[0]?.message ?? "invalid setting"} Fix it in Rules and setup.`,
          );
        if (!config.enabled) throw new Error("Hiring is paused in Scheduling.");
        const bookingMessages = await requestDelivery({ mode: "bookings" });
        subscriptionAuthSchema.parse(
          JSON.parse(
            execFileSync("claude", ["auth", "status"], {
              encoding: "utf8",
              env: claudeChildEnv(),
            }),
          ),
        );
        const rows = await db
          .select({ ids: hiringCandidates.sourceIds })
          .from(hiringCandidates);
        // One known-id set and one import budget for all jobs, so a person seen in one job is not imported again from another.
        const known = new Set(rows.flatMap((r) => r.ids));
        const campaigns = [];
        let budget = 40;
        for (const { jobId } of config.seekJobs.filter((j) => j.active)) {
          const read = await importSeek(
            profile,
            jobId,
            known,
            (value) => importApplication(value, db),
            (id, status, contacted) =>
              observeSeekState(id, status, contacted, db),
            (candidateId, file) => keepResume(candidateId, file, db),
            budget,
          );
          budget -= read.imported;
          campaigns.push({ jobId, ...read });
        }
        const imported = mergeSourceSummaries(campaigns);
        const cliVersion = execFileSync("claude", ["--version"], {
          encoding: "utf8",
        }).trim();
        const result = await runHiringCycle(db, async (source, key, kind) => {
          if (stop) throw new Error("Worker stopped.");
          // The call asks for the short lines too. A line over its limit is asked again with the exact count.
          let attempt = 0;
          return assessWithBriefs(async (feedback) => {
            const outcome = await runClaude(
              {
                purpose: "hiring-assessment",
                key: attempt++ ? `${key}:briefs:${attempt}` : key,
                system: kind === "pre-screen" ? PRE_SCREEN_SYSTEM : ASSESSMENT_SYSTEM,
                user: source + feedback,
                schema: z.toJSONSchema(kind === "pre-screen" ? preScreenOutputSchema : assessmentOutputSchema, { target: "draft-07" }),
                budgetUsd: 3,
                timeoutMs: 180000,
              },
              {
                cwd,
                cliVersion,
                callsLog: path.join(home, "model-calls.jsonl"),
                children,
              },
            );
            if (outcome.kind !== "success")
              throw new Error(`Subscription assessment stopped: ${outcome.kind}`);
            return outcome.value;
          });
        });
        await db
          .update(hiringSettings)
          .set({ workerSummary: imported })
          .where(eq(hiringSettings.id, "default"));
        const delivery = await requestDelivery({ mode: "all" });
        console.log(
          JSON.stringify({
            ...imported,
            ...result,
            sent: delivery.sent,
            bookingMessages: bookingMessages.sent,
          }),
        );
      } catch (error) {
        const cause =
          error instanceof Error && error.cause instanceof Error
            ? error.cause
            : error;
        const message = (
          cause instanceof Error ? cause.message : "Hiring worker failed."
        ).split("\n", 1)[0].slice(0, 300);
        await db
          .update(hiringSettings)
          .set({ workerError: message })
          .where(eq(hiringSettings.id, "default"))
          .catch(() => {});
        if (mode === "--once") throw new Error(message);
        console.error(message);
      }
      if (mode === "--watch" && !stop)
        for (let i = 0; i < 90 && !stop; i++)
          await new Promise((resolve) => setTimeout(resolve, 10000));
    } while (mode === "--watch" && !stop);
  } finally {
    await killChildren(children);
    await lease.query("select pg_advisory_unlock(hashtext('hiring-worker'))");
    lease.release();
    await pool.end();
  }
}
main().catch((error) => {
  console.error(
    (error instanceof Error ? error.message : "Hiring worker failed.")
      .split("\n", 1)[0]
      .slice(0, 300),
  );
  process.exitCode = 1;
});
