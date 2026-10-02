/**
 * Nightly Opus 5.5 audit of the feedback autowriter's posts (quick 261003-12b). Audits every verified autowriter post
 * of ONE Bangkok day (default: the day of now − 12 h) and never writes to Wise. Tutor-written feedback is never read.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/feedback-autowriter-nightly.ts <command> [--night=YYYY-MM-DD] [--json]
 *
 * Commands (each prints ONE JSON line {ok, stop, next, summary} with --json; steps checkpoint into
 * <state root>/<night>/run.json and are idempotent — a finished step is not repeated):
 *   status                         run state, lock, STOP files, Wise cooldown, tonight's spend (reads only)
 *   preflight                      STOP files, lock, clean tree, environment, node ≥ 22; writes run.json
 *   select [--sessions=a,b] [--force]
 *                                  the night's verified autowriter posts to audit (database SELECTs only)
 *   collect [--retranscribe] [--soniox-usd=<n>] [--sessions=a,b]
 *                                  evidence per class, cache-first: one paced Wise session-detail GET, the production
 *                                  Soniox transcript read-only, Zoom captions; --retranscribe makes our OWN Soniox job
 *                                  for a transcript post whose production transcript is gone (reserved first, deleted
 *                                  after; --soniox-usd raises the night's Soniox cap up to 5 for this run)
 * Global: --no-deadline (supervised runs only: ignore the 06:50 Bangkok stop).
 *
 * State lives outside every worktree: $BGS_NIGHTLY_ROOT, default ~/.bgscheduler-nightly/nightly (0700 dirs, 0600 files).
 * Kill switches: ~/.bgscheduler-nightly/STOP and /Users/kevinhsieh/Developer/Scheduling/.feedback-autowriter/STOP.
 * Owner config (may only tighten caps): ~/.bgscheduler-nightly/config.json.
 * Exit codes: 0 ok/nothing, 1 error, 2 usage/config, 3 caps, 4 model usage/auth, 5 Wise throttled, 6 guard refused,
 * 7 STOP/lock/deadline, 10 SAFETY.
 */
import { execFileSync } from "node:child_process";
import { getDb } from "@/lib/db";
import { loadTutorPriorFeedback } from "@/lib/feedback-autowriter/job";
import {
  activeWiseCooldown,
  effectiveCaps,
  loadOwnerConfig,
  stopFilePresent,
  stopFiles,
  type NightlyCaps,
} from "@/lib/feedback-autowriter/nightly/caps";
import {
  createWiseReadGate,
  dbEvidenceSources,
  readOnlySoniox,
} from "@/lib/feedback-autowriter/nightly/evidence";
import { EXIT, type ExitCode } from "@/lib/feedback-autowriter/nightly/exit";
import { NightlyLedger } from "@/lib/feedback-autowriter/nightly/ledger";
import { acquireLock, lockHolder } from "@/lib/feedback-autowriter/nightly/lock";
import { isNightLabel, nightDeadline, nightLabel, nightlyPaths, nightlyRoot } from "@/lib/feedback-autowriter/nightly/paths";
import { loadOtherStudentNames } from "@/lib/feedback-autowriter/nightly/prechecks";
import {
  readRunState,
  readTargets,
  stepCollect,
  stepPreflight,
  stepSelect,
  type NightContext,
  type StepResult,
} from "@/lib/feedback-autowriter/nightly/steps";
import { createNightlyWiseReader } from "@/lib/feedback-autowriter/nightly/wise-reader";
import { rosterTutor } from "@/lib/feedback-autowriter/roster";
import { createSonioxClient } from "@/lib/feedback-autowriter/soniox";
import type { PriorFeedbackComparison } from "@/lib/post-class-feedback/similarity";
import { loadPayoutScriptEnvironment } from "./lib/payout-script";

loadPayoutScriptEnvironment();

const COMMANDS = ["status", "preflight", "select", "collect"] as const;
type Command = (typeof COMMANDS)[number];

const REQUIRED_ENV = ["DATABASE_URL", "WISE_USER_ID", "WISE_API_KEY"] as const;
const OPTIONAL_ENV = ["SONIOX_API_KEY"] as const;

class UsageError extends Error {}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function sessionIdsOption(): string[] {
  const ids = (option("sessions") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  const invalid = ids.filter((id) => !/^[0-9a-f]{24}$/iu.test(id));
  if (invalid.length > 0) throw new UsageError(`Not Wise session ids: ${invalid.join(", ")}`);
  return ids;
}

function print(result: StepResult): void {
  const line = { ok: result.ok, stop: result.stop, next: result.next, summary: { ...result.summary, exitCode: result.exitCode } };
  if (flag("json")) process.stdout.write(`${JSON.stringify(line)}\n`);
  else process.stdout.write(`${JSON.stringify(line, null, 2)}\n`);
  process.exitCode = result.exitCode;
}

function fail(stop: string, exitCode: ExitCode, summary: Record<string, unknown> = {}): StepResult {
  return { ok: false, stop, next: null, summary, exitCode };
}

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function codeFacts(): { head: string | null; branch: string | null; dirty: boolean } | null {
  const head = git(["rev-parse", "HEAD"]);
  if (!head) return null;
  return { head, branch: git(["rev-parse", "--abbrev-ref", "HEAD"]), dirty: (git(["status", "--porcelain", "--untracked-files=no"]) ?? "x") !== "" };
}

/** `claude --version`, with the same scrubbed environment the audit calls get. */
function claudeCliVersion(): string | null {
  try {
    const env: Record<string, string> = {};
    for (const key of ["HOME", "PATH", "USER", "LOGNAME", "SHELL", "LANG", "TMPDIR", "TERM"]) {
      if (process.env[key]) env[key] = process.env[key]!;
    }
    return execFileSync("claude", ["--version"], {
      encoding: "utf8", env: env as NodeJS.ProcessEnv, timeout: 20_000, stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

function contextFor(night: string, caps: NightlyCaps): NightContext {
  const root = nightlyRoot();
  return {
    night,
    paths: nightlyPaths(root, night),
    caps,
    now: () => new Date(),
    deadline: flag("no-deadline") ? null : nightDeadline(night, caps.deadlineBangkok),
    stopFiles: stopFiles(),
    log: (line) => process.stderr.write(`${line}\n`),
  };
}

function status(ctx: NightContext): StepResult {
  const state = readRunState(ctx);
  const ledger = NightlyLedger.open(ctx.paths.root, ctx.night, ctx.caps);
  const targets = readTargets(ctx.paths);
  return {
    ok: true,
    stop: stopFilePresent(ctx.stopFiles) ? "stop_file" : null,
    next: null,
    exitCode: EXIT.ok,
    summary: {
      step: "status",
      night: ctx.night,
      root: ctx.paths.root,
      deadline: ctx.deadline?.toISOString() ?? null,
      steps: Object.fromEntries(Object.entries(state.steps).map(([step, record]) => [step, { status: record?.status, stop: record?.stop, at: record?.at }])),
      targets: targets ? { chosen: targets.chosen.length, skipped: targets.skipped.length } : null,
      lock: lockHolder(ctx.paths.lockFile),
      stopFile: stopFilePresent(ctx.stopFiles),
      wiseCooldownUntil: activeWiseCooldown()?.toISOString() ?? null,
      spend: ledger.totals(),
      claude: ledger.claudeUsd(),
    },
  };
}

async function main(): Promise<void> {
  const command = process.argv[2] as Command | undefined;
  if (!command || !COMMANDS.includes(command)) throw new UsageError(`Usage: feedback-autowriter-nightly <${COMMANDS.join("|")}> [--night=YYYY-MM-DD] [--json]`);
  const night = option("night") ?? nightLabel(new Date());
  if (!isNightLabel(night)) throw new UsageError(`--night must be a date (YYYY-MM-DD): ${night}`);
  const config = loadOwnerConfig();
  if (!config.ok) {
    print(fail("owner_config", EXIT.usage, { reason: config.reason }));
    return;
  }
  const sonioxUsd = option("soniox-usd");
  if (sonioxUsd !== undefined && !Number.isFinite(Number(sonioxUsd))) throw new UsageError("--soniox-usd must be a number");
  const { caps } = effectiveCaps({ config: config.caps, sonioxUsdFlag: sonioxUsd === undefined ? null : Number(sonioxUsd) });
  const ctx = contextFor(night, caps);

  if (command === "status") {
    print(status(ctx));
    return;
  }

  const lock = acquireLock(ctx.paths.lockFile, { command: process.argv.slice(2).join(" ") });
  if (!lock.ok) {
    print(fail("locked", EXIT.stopped, { step: command, night, lock: { reason: lock.reason, holder: lock.holder, file: lock.file } }));
    return;
  }
  const inFlight = new Set<string>();
  let releaseOnSignal = true;
  const onSignal = (signal: NodeJS.Signals) => {
    if (!releaseOnSignal) return;
    releaseOnSignal = false;
    const pending = [...inFlight];
    const key = process.env.SONIOX_API_KEY?.trim();
    const cleanup = pending.length > 0 && key
      ? Promise.allSettled(pending.map((id) => createSonioxClient(key).remove(id)))
      : Promise.resolve([]);
    void cleanup.then((results) => {
      const left = pending.filter((_, index) => (results as PromiseSettledResult<unknown>[])[index]?.status === "rejected");
      process.stderr.write(`${signal}: stopped${left.length ? `; Soniox jobs NOT deleted: ${left.join(", ")}` : ""}\n`);
      lock.release();
      process.exit(130);
    });
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    if (command === "preflight") {
      const missingEnv = REQUIRED_ENV.filter((name) => !process.env[name]?.trim());
      print(stepPreflight(ctx, {
        nodeVersion: process.version,
        missingEnv: [...missingEnv],
        optionalEnvMissing: OPTIONAL_ENV.filter((name) => !process.env[name]?.trim()),
        code: codeFacts(),
        claudeCliVersion: claudeCliVersion(),
        lock: { ok: true },
      }));
      return;
    }
    const db = getDb();
    const ledger = NightlyLedger.open(ctx.paths.root, night, caps);
    if (command === "select") {
      print(await stepSelect(ctx, { db, ledger, sessionIds: sessionIdsOption(), force: flag("force") }));
      return;
    }
    if (command === "collect") {
      const sonioxKey = process.env.SONIOX_API_KEY?.trim() || null;
      if (flag("retranscribe") && !sonioxKey) throw new UsageError("--retranscribe needs SONIOX_API_KEY");
      const priorByTutor = new Map<string, Promise<PriorFeedbackComparison[]>>();
      const now = new Date();
      const gate = createWiseReadGate({ ledger, pacingMs: caps.wisePacingMs, deadline: ctx.deadline, stopFiles: ctx.stopFiles });
      print(await stepCollect(ctx, {
        sessionIds: sessionIdsOption(),
        collect: {
          sources: dbEvidenceSources(db),
          wise: createNightlyWiseReader(),
          gate,
          soniox: sonioxKey ? readOnlySoniox(createSonioxClient(sonioxKey)) : null,
          fetchText,
          retranscribe: flag("retranscribe") && sonioxKey ? {
            client: createSonioxClient(sonioxKey),
            ledger,
            inFlight,
            shouldStop: () => (stopFilePresent(ctx.stopFiles) ? "stop_file" : ctx.deadline && Date.now() >= ctx.deadline.getTime() ? "deadline" : null),
          } : null,
        },
        priorFeedback: (target) => {
          const tutor = rosterTutor(target.wiseTeacherUserId);
          if (!tutor) return Promise.resolve([]);
          if (!priorByTutor.has(tutor.canonicalKey)) priorByTutor.set(tutor.canonicalKey, loadTutorPriorFeedback(db, tutor, now));
          return priorByTutor.get(tutor.canonicalKey)!;
        },
        otherStudentNames: (target) => loadOtherStudentNames(db, { tutorKey: target.tutorKey, excludeClassId: target.wiseClassId || null, now }),
      }));
      return;
    }
  } finally {
    releaseOnSignal = false;
    lock.release();
  }
}

main().catch((error) => {
  if (error instanceof UsageError) {
    print(fail("usage", EXIT.usage, { error: error.message }));
    return;
  }
  // Never print secrets: the error's name and first line only.
  const message = error instanceof Error ? `${error.name}: ${error.message.split("\n")[0].slice(0, 300)}` : "unknown error";
  print(fail("error", EXIT.error, { error: message }));
});
