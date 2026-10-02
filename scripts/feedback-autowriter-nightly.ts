/**
 * Nightly Opus 5.5 audit of the feedback autowriter's posts (quick 261003-12b). Audits every verified autowriter post
 * of ONE Bangkok day (default: the day of now − 12 h) and never writes to Wise. Tutor-written feedback is never read.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/feedback-autowriter-nightly.ts <command> [--night=YYYY-MM-DD] [--json]
 *
 * Commands (each prints ONE JSON line {ok, stop, next, summary} with --json; steps checkpoint into
 * <state root>/<night>/run.json and are idempotent — cache-first, so running one again repeats no Wise read or paid call):
 *   status                         run state, lock, STOP files, Wise cooldown, tonight's spend (reads only)
 *   preflight [--supervised]       STOP files, lock, a clean tree of reviewed code (HEAD on origin/main, or the
 *                                  runnerSha pinned in the owner config; --supervised overrides, recorded),
 *                                  environment, node ≥ 22, claude CLI ≥ 2.1; writes run.json
 *   select [--sessions=a,b] [--force]
 *                                  the night's verified autowriter posts to audit (database SELECTs only), merged into
 *                                  any earlier selection of the night (a class is never dropped), plus posts of the two
 *                                  previous nights verified after their selection and never audited (late); refused
 *                                  until an hour after the night ends unless --force
 *   collect [--retranscribe] [--soniox-usd=<n>] [--sessions=a,b]
 *                                  evidence per class, cache-first: one paced Wise session-detail GET, the production
 *                                  Soniox transcript read-only, Zoom captions; --retranscribe makes our OWN Soniox job
 *                                  for a transcript post whose production transcript is gone (reserved first, deleted
 *                                  after; --soniox-usd raises the night's Soniox cap up to 5 for this run)
 *   audit [--smoke] [--plan] [--sessions=a,b]
 *                                  one `claude -p` Opus 5.5 max audit per collected class (no tools, safe mode, JSON
 *                                  schema, $1.50 budget, prompt on stdin); --smoke: one tiny synthetic call printing
 *                                  the proof (model, effort, login, cost); --plan: the estimate only, nothing spawned
 *   report [--no-synthesis]        merged findings, failure modes, the production spend/retry watchdog (SELECT only),
 *                                  one Opus synthesis call → report.md, summary.md, plan.md, fix-brief.json
 *   flag [--apply]                 one `agent` flag per major/critical class (+ a critical_flag incident for a
 *                                  high-confidence critical); a DRY RUN unless --apply — the only database write
 *   run [--apply-flags] [--retranscribe] [--soniox-usd=<n>] [--no-synthesis] [--force]
 *                                  preflight → select → collect → audit → report (→ flag with --apply-flags); preflight
 *                                  and select run every time (the night's posts may have grown), so every later step
 *                                  runs again from its cache; any stop ends with a partial report, never a retry;
 *                                  then prune (not after a STOP file)
 *   prune [--dry-run]              delete local evidence older than 7 days (cache, audits, old nights' real data)
 *   costs [--days=7]               the last nights' spend from the local cost ledger
 * Global: --no-deadline (supervised runs only: ignore the 06:50 Bangkok stop); --supervised (preflight and run: allow
 * reviewed code that is not on origin/main yet, recorded in run.json).
 *
 * State lives outside every worktree: $BGS_NIGHTLY_ROOT, default ~/.bgscheduler-nightly/nightly (0700 dirs, 0600 files).
 * Kill switches: ~/.bgscheduler-nightly/STOP and /Users/kevinhsieh/Developer/Scheduling/.feedback-autowriter/STOP.
 * Owner config (may only tighten caps): ~/.bgscheduler-nightly/config.json.
 * Exit codes: 0 ok/nothing, 1 error, 2 usage/config, 3 caps, 4 model usage/auth, 5 Wise throttled, 6 guard refused,
 * 7 STOP/lock/deadline, 10 SAFETY.
 */
import { execFileSync } from "node:child_process";
import { getDb, type Database } from "@/lib/db";
import { loadTutorPriorFeedback } from "@/lib/feedback-autowriter/job";
import { planAudit, smokeCall } from "@/lib/feedback-autowriter/nightly/audit";
import {
  activeWiseCooldown,
  effectiveCaps,
  loadOwnerConfig,
  stopFilePresent,
  stopFiles,
  writeStopFile,
  type NightlyCaps,
} from "@/lib/feedback-autowriter/nightly/caps";
import { claudeCwd, ledgerOutcome, readClaudeCliVersion, runClaude, type ClaudeRunnerDeps } from "@/lib/feedback-autowriter/nightly/claude-runner";
import { createWiseReadGate, dbEvidenceSources, readOnlySoniox } from "@/lib/feedback-autowriter/nightly/evidence";
import { EXIT, exitCodeForStop, type ExitCode } from "@/lib/feedback-autowriter/nightly/exit";
import { NightlyLedger } from "@/lib/feedback-autowriter/nightly/ledger";
import { acquireLock, lockHolder } from "@/lib/feedback-autowriter/nightly/lock";
import { isNightLabel, nightDeadline, nightLabel, nightlyPaths, nightlyRoot } from "@/lib/feedback-autowriter/nightly/paths";
import { loadOtherStudentNames } from "@/lib/feedback-autowriter/nightly/prechecks";
import {
  readNightBundles,
  readRunState,
  readTargets,
  runNight,
  stepAudit,
  stepCollect,
  stepCosts,
  stepFlag,
  stepPreflight,
  stepPrune,
  stepReport,
  stepSelect,
  stopBeforeStep,
  type NightContext,
  type StepResult,
} from "@/lib/feedback-autowriter/nightly/steps";
import { createNightlyWiseReader } from "@/lib/feedback-autowriter/nightly/wise-reader";
import { rosterTutor } from "@/lib/feedback-autowriter/roster";
import { createSonioxClient } from "@/lib/feedback-autowriter/soniox";
import type { PriorFeedbackComparison } from "@/lib/post-class-feedback/similarity";
import { loadPayoutScriptEnvironment } from "./lib/payout-script";

loadPayoutScriptEnvironment();

const COMMANDS = ["status", "preflight", "select", "collect", "audit", "report", "flag", "run", "prune", "costs"] as const;
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

/** Whether HEAD is reachable from origin/main (the local ref; null when it does not exist). */
function headOnMain(): boolean | null {
  if (git(["rev-parse", "--verify", "--quiet", "origin/main"]) === null) return null;
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", "HEAD", "origin/main"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function codeFacts(): { head: string | null; branch: string | null; dirty: boolean; onMain: boolean | null } | null {
  const head = git(["rev-parse", "HEAD"]);
  if (!head) return null;
  return {
    head,
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
    dirty: (git(["status", "--porcelain", "--untracked-files=no"]) ?? "x") !== "",
    onMain: headOnMain(),
  };
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

function contextFor(night: string, caps: NightlyCaps): NightContext {
  return {
    night,
    paths: nightlyPaths(nightlyRoot(), night),
    caps,
    now: () => new Date(),
    deadline: flag("no-deadline") ? null : nightDeadline(night, caps.deadlineBangkok),
    stopFiles: stopFiles(),
    log: (line) => process.stderr.write(`${line}\n`),
  };
}

/** Everything one invocation shares: the context, the spend ledger, the database (lazily), the claude runner. */
class Session {
  private dbHandle: Database | null = null;
  private runner: ClaudeRunnerDeps | null = null;
  readonly ledger: NightlyLedger;
  /** Our own Soniox jobs in flight (re-transcription), deleted by the signal handler. */
  readonly inFlight = new Set<string>();

  constructor(readonly ctx: NightContext, readonly runnerSha: string | null) {
    // A call that cost more than it reserved and passed a cap stops every later step (and the next night) until the
    // owner deletes the STOP file.
    this.ledger = NightlyLedger.open(ctx.paths.root, ctx.night, ctx.caps, {
      onBreach: (breached) => {
        writeStopFile(`nightly spend passed a cap after the fact: ${breached.join(", ")} (night ${ctx.night})`);
      },
    });
  }

  get db(): Database {
    this.dbHandle ??= getDb();
    return this.dbHandle;
  }

  /** The claude runner; `claude --version` is read once per invocation. */
  claude(): ClaudeRunnerDeps {
    this.runner ??= { cwd: claudeCwd(), cliVersion: readClaudeCliVersion(), callsLog: this.ctx.paths.claudeCallsJsonl };
    return this.runner;
  }
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

function preflight(session: Session): StepResult {
  return stepPreflight(session.ctx, {
    nodeVersion: process.version,
    missingEnv: REQUIRED_ENV.filter((name) => !process.env[name]?.trim()),
    optionalEnvMissing: OPTIONAL_ENV.filter((name) => !process.env[name]?.trim()),
    code: codeFacts(),
    claudeCliVersion: session.claude().cliVersion,
    lock: { ok: true },
    pinnedSha: session.runnerSha,
    supervised: flag("supervised"),
  });
}

async function collect(session: Session): Promise<StepResult> {
  const { ctx, ledger } = session;
  const sonioxKey = process.env.SONIOX_API_KEY?.trim() || null;
  if (flag("retranscribe") && !sonioxKey) throw new UsageError("--retranscribe needs SONIOX_API_KEY");
  const db = session.db;
  const now = new Date();
  const priorByTutor = new Map<string, Promise<PriorFeedbackComparison[]>>();
  return stepCollect(ctx, {
    sessionIds: sessionIdsOption(),
    collect: {
      sources: dbEvidenceSources(db),
      wise: createNightlyWiseReader(),
      gate: createWiseReadGate({ ledger, pacingMs: ctx.caps.wisePacingMs, deadline: ctx.deadline, stopFiles: ctx.stopFiles }),
      soniox: sonioxKey ? readOnlySoniox(createSonioxClient(sonioxKey)) : null,
      fetchText,
      retranscribe: flag("retranscribe") && sonioxKey ? {
        client: createSonioxClient(sonioxKey),
        ledger,
        inFlight: session.inFlight,
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
  });
}

/** `audit`, `audit --smoke`, `audit --plan`: no database or Wise access, only `claude -p`. */
async function audit(session: Session): Promise<StepResult> {
  const { ctx, ledger } = session;
  if (flag("smoke")) {
    const stop = stopBeforeStep(ctx);
    if (stop) return fail(stop.reason, stop.exitCode, { step: "audit-smoke", night: ctx.night });
    const key = `smoke:${new Date().toISOString()}`;
    const call = smokeCall(key);
    const reserved = ledger.reserve("opus_audit", { key, estimateUsd: call.budgetUsd });
    if (!reserved.ok) return fail(reserved.reason, EXIT.caps, { step: "audit-smoke", night: ctx.night });
    const runner = session.claude();
    const outcome = await runClaude(call, runner);
    ledger.settle(reserved.id, { actualUsd: outcome.proof?.costUsd ?? null, outcome: ledgerOutcome(outcome.kind, true) });
    const ok = outcome.kind === "success";
    return {
      ok,
      stop: ok ? null : outcome.kind,
      next: null,
      exitCode: ok ? EXIT.ok : exitCodeForStop(outcome.kind === "usage_limited" || outcome.kind === "auth" ? outcome.kind : "error"),
      summary: {
        step: "audit-smoke", night: ctx.night, outcome: outcome.kind, reason: ok ? null : outcome.reason, value: ok ? outcome.value : null,
        cliVersion: runner.cliVersion, proof: outcome.proof,
      },
    };
  }
  const targets = readTargets(ctx.paths);
  const sessionIds = new Set(sessionIdsOption());
  const files = readNightBundles(ctx.paths, targets).filter((file) => sessionIds.size === 0 || sessionIds.has(file.target.wiseSessionId));
  if (flag("plan")) {
    const plan = planAudit({ auditsDir: ctx.paths.auditsDir, ledger, perAuditUsd: ctx.caps.perAuditUsd }, files);
    const claude = ledger.claudeUsd();
    return {
      ok: true,
      stop: null,
      next: "audit",
      exitCode: EXIT.ok,
      summary: {
        step: "audit-plan", night: ctx.night, bundles: files.length, ...plan, claudeUsdTonight: claude.night, claudeUsdWeek: claude.week,
        caps: { maxClaudeUsdNight: ctx.caps.maxClaudeUsdNight, maxClaudeUsdWeek: ctx.caps.maxClaudeUsdWeek, maxOpusCalls: ctx.caps.maxOpusCalls },
        fitsTonight: claude.night + plan.toAudit * ctx.caps.perAuditUsd <= ctx.caps.maxClaudeUsdNight,
      },
    };
  }
  const runner = session.claude();
  return stepAudit(ctx, { ledger, run: (call) => runClaude(call, runner), sessionIds: [...sessionIds] });
}

async function report(session: Session, options: { synthesis: boolean }): Promise<StepResult> {
  const runner = options.synthesis ? session.claude() : null;
  let db: Database | null = null;
  try {
    db = session.db;
  } catch {
    db = null;
  }
  return stepReport(session.ctx, {
    db,
    ledger: session.ledger,
    run: runner ? (call) => runClaude(call, runner) : null,
    cliVersion: runner?.cliVersion ?? null,
  });
}

/**
 * preflight → select → collect → audit → report (→ flag), from the first unfinished step; a stop ends with a partial
 * report. Then local evidence older than 7 days is deleted (not after a STOP file: STOP means stop).
 */
async function runAll(session: Session): Promise<StepResult> {
  const { ctx } = session;
  const result = await runNight(ctx, {
    order: ["preflight", "select", "collect", "audit", "report", ...(flag("apply-flags") ? ["flag" as const] : [])],
    steps: {
      preflight: () => preflight(session),
      select: () => stepSelect(ctx, { db: session.db, ledger: session.ledger, force: flag("force") }),
      collect: () => collect(session),
      audit: () => audit(session),
      report: () => report(session, { synthesis: !flag("no-synthesis") }),
      flag: () => stepFlag(ctx, { db: session.db, apply: true }),
    },
    partialReport: () => report(session, { synthesis: false }),
    // Checked and re-selected every run: the code may have changed, and posts may have been verified since.
    always: new Set(["preflight", "select"]),
  });
  if (result.stop === "stop_file" || stopFilePresent(ctx.stopFiles)) return result;
  return { ...result, summary: { ...result.summary, prune: stepPrune(ctx).summary } };
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
  let caps: NightlyCaps;
  try {
    caps = effectiveCaps({ config: config.caps, sonioxUsdFlag: sonioxUsd === undefined ? null : Number(sonioxUsd) }).caps;
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const ctx = contextFor(night, caps);

  if (command === "status") {
    print(status(ctx));
    return;
  }
  if (command === "costs") {
    const days = Number(option("days") ?? "7");
    if (!Number.isInteger(days) || days < 1 || days > 90) throw new UsageError("--days must be a whole number from 1 to 90");
    print(stepCosts(ctx, days));
    return;
  }

  const lock = acquireLock(ctx.paths.lockFile, { command: process.argv.slice(2).join(" ") });
  if (!lock.ok) {
    print(fail("locked", EXIT.stopped, { step: command, night, lock: { reason: lock.reason, holder: lock.holder, file: lock.file } }));
    return;
  }
  const session = new Session(ctx, config.runnerSha);
  let handled = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (handled) return;
    handled = true;
    const pending = [...session.inFlight];
    const key = process.env.SONIOX_API_KEY?.trim();
    const cleanup = pending.length > 0 && key ? Promise.allSettled(pending.map((id) => createSonioxClient(key).remove(id))) : Promise.resolve([]);
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
    if (command === "preflight") print(preflight(session));
    else if (command === "select") print(await stepSelect(ctx, { db: session.db, ledger: session.ledger, sessionIds: sessionIdsOption(), force: flag("force") }));
    else if (command === "collect") print(await collect(session));
    else if (command === "audit") print(await audit(session));
    else if (command === "report") print(await report(session, { synthesis: !flag("no-synthesis") }));
    else if (command === "flag") print(await stepFlag(ctx, { db: flag("apply") ? session.db : null, apply: flag("apply") }));
    else if (command === "run") print(await runAll(session));
    else if (command === "prune") print(stepPrune(ctx, { dryRun: flag("dry-run") }));
  } finally {
    handled = true;
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
