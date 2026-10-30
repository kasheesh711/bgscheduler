import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { Pool } from "pg";
import { z } from "zod";
import { loadEnvConfig } from "@next/env";
import { getDb } from "../src/lib/db";
import { hiringCandidates, hiringSettings } from "../src/lib/db/schema";
import { eq } from "drizzle-orm";
import {
  configSchema,
  runtimeWritesAllowed,
  subscriptionAuthSchema,
} from "../src/lib/hiring/model";
import { settings } from "../src/lib/hiring/service";
import { importApplication, observeSeekState } from "../src/lib/hiring/sources";
import { deliverOutbox, runHiringCycle } from "../src/lib/hiring/worker";
import { assessmentSchema, ASSESSMENT_SYSTEM } from "../src/lib/hiring/scoring";
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
  if (!["--connect-seek", "--once", "--watch"].includes(mode)) {
    console.log(
      "Usage: npm run hiring:worker -- --connect-seek | --once | --watch\nConnect once, then use --watch for a 15-minute cycle. No model API key is used.",
    );
    return;
  }
  loadEnvConfig(process.cwd());
  const home = path.join(os.homedir(), ".bgscheduler-hiring");
  const profile = path.join(home, "seek-profile");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  if (mode === "--connect-seek") {
    await connectSeek(profile, process.env.HIRING_SEEK_JOB_ID || "94844236");
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
    do {
      try {
        const { config } = await settings(db);
        configSchema.parse(config);
        if (!config.enabled) throw new Error("Hiring is paused in Scheduling.");
        const bookingMessages = await deliverOutbox(db, config, 50, true);
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
        const imported = await importSeek(
          profile,
          config.seekJobId,
          new Set(rows.flatMap((r) => r.ids)),
          (value) => importApplication(value, db).then(() => {}),
          (id, status, contacted) =>
            observeSeekState(id, status, contacted, db),
        );
        const cliVersion = execFileSync("claude", ["--version"], {
          encoding: "utf8",
        }).trim();
        const result = await runHiringCycle(db, async (source, key) => {
          if (stop) throw new Error("Worker stopped.");
          const outcome = await runClaude(
            {
              purpose: "hiring-assessment",
              key,
              system: ASSESSMENT_SYSTEM,
              user: source,
              schema: z.toJSONSchema(assessmentSchema, { target: "draft-07" }),
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
        await db
          .update(hiringSettings)
          .set({ workerSummary: imported })
          .where(eq(hiringSettings.id, "default"));
        console.log(
          JSON.stringify({ ...imported, ...result, bookingMessages }),
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Hiring worker failed.";
        await db
          .update(hiringSettings)
          .set({ workerError: message.slice(0, 300) })
          .where(eq(hiringSettings.id, "default"))
          .catch(() => {});
        if (mode === "--once") throw error;
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
    error instanceof Error ? error.message : "Hiring worker failed.",
  );
  process.exitCode = 1;
});
