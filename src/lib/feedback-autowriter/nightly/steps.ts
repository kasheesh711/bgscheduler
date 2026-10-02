import fs from "node:fs";
import path from "node:path";
import type { Database } from "@/lib/db";
import type { PriorFeedbackComparison } from "@/lib/post-class-feedback/similarity";
import { AUDIT_VERSION } from "./audit-schema";
import { activeWiseCooldown, stopFilePresent, type NightlyCaps } from "./caps";
import {
  buildEvidenceBundle,
  collectRawEvidence,
  evidenceNotes,
  type CollectDeps,
  type RawEvidence,
} from "./evidence";
import { EXIT, NightlyStop, type ExitCode } from "./exit";
import type { NightlyLedger } from "./ledger";
import { readJsonFile, writeJsonAtomic, type NightlyPaths } from "./paths";
import { runPrechecks } from "./prechecks";
import { auditedKeys, auditKey, chooseTargets, loadNightlyTargets, type TargetChoice } from "./select";
import type { EvidenceBundle, NightlyTarget, PrecheckFinding } from "./types";

/**
 * The nightly run as a resumable state machine: every step checkpoints into `<night>/run.json` and prints one JSON
 * line `{ok, stop, next, summary}`. A finished step is never repeated (a resumed run starts at the first unfinished
 * one); a stopped step keeps what it did and ends the run with a partial result — never a retry loop.
 */

export const STEP_ORDER = ["preflight", "select", "collect", "audit", "report", "flag"] as const;
export type StepName = (typeof STEP_ORDER)[number];

export interface StepRecord {
  status: "done" | "partial" | "stopped" | "failed";
  at: string;
  pid: number;
  stop: string | null;
  summary: Record<string, unknown>;
}

export interface RunState {
  night: string;
  createdAt: string;
  updatedAt: string;
  auditVersion: number;
  steps: Partial<Record<StepName, StepRecord>>;
  /** Preflight facts: the code that ran, the CLI version, the caps in force. */
  code?: { head: string | null; branch: string | null; dirty: boolean } | null;
  claudeCliVersion?: string | null;
  caps?: NightlyCaps;
}

export interface StepResult {
  ok: boolean;
  stop: string | null;
  next: string | null;
  summary: Record<string, unknown>;
  exitCode: ExitCode;
}

export interface NightContext {
  night: string;
  paths: NightlyPaths;
  caps: NightlyCaps;
  now: () => Date;
  /** null with `--no-deadline` (supervised runs only). */
  deadline: Date | null;
  stopFiles: readonly string[];
  /** Home override (tests): the cooldown file lives in `<home>/.bgscheduler-nightly/`. */
  home?: string;
  log?: (line: string) => void;
}

export function readRunState(ctx: Pick<NightContext, "paths" | "night" | "now">): RunState {
  const existing = readJsonFile<RunState>(ctx.paths.runJson);
  if (existing && existing.night === ctx.night) return existing;
  const at = ctx.now().toISOString();
  return { night: ctx.night, createdAt: at, updatedAt: at, auditVersion: AUDIT_VERSION, steps: {} };
}

export function recordStep(ctx: Pick<NightContext, "paths" | "night" | "now">, step: StepName, record: Omit<StepRecord, "at" | "pid">, patch: Partial<RunState> = {}): RunState {
  const state = { ...readRunState(ctx), ...patch };
  const at = ctx.now().toISOString();
  state.steps = { ...state.steps, [step]: { ...record, at, pid: process.pid } };
  state.updatedAt = at;
  writeJsonAtomic(ctx.paths.runJson, state);
  return state;
}

/** The first step of the night that is not done (null: the night is complete). */
export function nextStep(state: RunState, from: StepName | null = null): StepName | null {
  const start = from ? STEP_ORDER.indexOf(from) + 1 : 0;
  for (const step of STEP_ORDER.slice(start)) {
    if (state.steps[step]?.status !== "done") return step;
  }
  return null;
}

function result(input: Partial<StepResult> & { summary: Record<string, unknown> }): StepResult {
  return { ok: input.ok ?? true, stop: input.stop ?? null, next: input.next ?? null, summary: input.summary, exitCode: input.exitCode ?? EXIT.ok };
}

/** STOP files and the deadline, checked before every step. */
export function stopBeforeStep(ctx: NightContext): NightlyStop | null {
  if (stopFilePresent(ctx.stopFiles)) return new NightlyStop("stop_file", EXIT.stopped);
  if (ctx.deadline && ctx.now().getTime() >= ctx.deadline.getTime()) return new NightlyStop("deadline", EXIT.stopped);
  return null;
}

export function stoppedResult(ctx: NightContext, step: StepName, stop: NightlyStop, summary: Record<string, unknown> = {}): StepResult {
  recordStep(ctx, step, { status: "stopped", stop: stop.reason, summary });
  return result({ ok: false, stop: stop.reason, next: step, summary: { step, night: ctx.night, ...summary }, exitCode: stop.exitCode });
}

// ---------------------------------------------------------------------------
// preflight
// ---------------------------------------------------------------------------

export interface PreflightFacts {
  nodeVersion: string;
  missingEnv: string[];
  optionalEnvMissing: string[];
  code: { head: string | null; branch: string | null; dirty: boolean } | null;
  claudeCliVersion: string | null;
  lock: { ok: true } | { ok: false; reason: string; holder: unknown };
}

/** STOP, the deadline, the lock, a clean tree, the environment and node ≥ 22; writes `run.json`. */
export function stepPreflight(ctx: NightContext, facts: PreflightFacts): StepResult {
  const stop = stopBeforeStep(ctx);
  if (stop) return stoppedResult(ctx, "preflight", stop);
  const problems: string[] = [];
  const nodeMajor = Number(facts.nodeVersion.replace(/^v/u, "").split(".")[0]);
  if (!(nodeMajor >= 22)) problems.push(`node_${facts.nodeVersion}_below_22`);
  if (facts.missingEnv.length > 0) problems.push(`env_missing:${facts.missingEnv.join(",")}`);
  if (!facts.code) problems.push("not_a_git_checkout");
  else if (facts.code.dirty) problems.push("dirty_tree");
  if (!facts.lock.ok) {
    const summary = { step: "preflight", night: ctx.night, lock: facts.lock };
    recordStep(ctx, "preflight", { status: "stopped", stop: "locked", summary });
    return result({ ok: false, stop: "locked", next: "preflight", summary, exitCode: EXIT.stopped });
  }
  const cooldown = activeWiseCooldown(ctx.now(), ctx.home);
  const summary = {
    step: "preflight",
    night: ctx.night,
    deadline: ctx.deadline?.toISOString() ?? null,
    nodeVersion: facts.nodeVersion,
    code: facts.code,
    claudeCliVersion: facts.claudeCliVersion,
    optionalEnvMissing: facts.optionalEnvMissing,
    wiseCooldownUntil: cooldown?.toISOString() ?? null,
    problems,
  };
  if (problems.length > 0) {
    recordStep(ctx, "preflight", { status: "failed", stop: problems[0], summary });
    return result({ ok: false, stop: problems[0], next: "preflight", summary, exitCode: EXIT.guardRefused });
  }
  const state = recordStep(ctx, "preflight", { status: "done", stop: null, summary }, {
    code: facts.code, claudeCliVersion: facts.claudeCliVersion, caps: ctx.caps, auditVersion: AUDIT_VERSION,
  });
  return result({ summary, next: nextStep(state, "preflight") });
}

// ---------------------------------------------------------------------------
// select
// ---------------------------------------------------------------------------

export interface TargetsFile extends TargetChoice {
  night: string;
  auditVersion: number;
  selectedAt: string;
}

export function readTargets(paths: NightlyPaths): TargetsFile | null {
  return readJsonFile<TargetsFile>(paths.targetsJson);
}

/** The night's posts to audit (SELECT only), skipping texts audited at this version and keys that failed twice. */
export async function stepSelect(ctx: NightContext, deps: {
  db: Database;
  ledger: Pick<NightlyLedger, "attempts">;
  sessionIds?: readonly string[];
  force?: boolean;
}): Promise<StepResult> {
  const stop = stopBeforeStep(ctx);
  if (stop) return stoppedResult(ctx, "select", stop);
  const state = readRunState(ctx);
  const existing = readTargets(ctx.paths);
  if (!deps.force && state.steps.select?.status === "done" && existing) {
    const summary = { step: "select", night: ctx.night, chosen: existing.chosen.length, skipped: existing.skipped.length, cached: true };
    return result({ summary, next: nextStep(state, "select") });
  }
  const targets = await loadNightlyTargets(deps.db, { night: ctx.night, sessionIds: deps.sessionIds });
  const choice = chooseTargets({
    targets,
    audited: auditedKeys(ctx.paths.ledgerJsonl),
    failures: (key) => deps.ledger.attempts(key).failed,
    auditVersion: AUDIT_VERSION,
    maxTargets: ctx.caps.maxTargets,
  });
  const file: TargetsFile = { night: ctx.night, auditVersion: AUDIT_VERSION, selectedAt: ctx.now().toISOString(), ...choice };
  writeJsonAtomic(ctx.paths.targetsJson, file);
  const summary = {
    step: "select",
    night: ctx.night,
    posts: targets.length,
    chosen: choice.chosen.length,
    skipped: Object.fromEntries(["already_audited", "failed_twice", "over_cap"].map((reason) => [reason, choice.skipped.filter((item) => item.reason === reason).length])),
    byEvidence: { transcript: choice.chosen.filter((t) => t.evidence === "transcript").length, summary: choice.chosen.filter((t) => t.evidence === "summary").length },
    approvedByOwner: choice.chosen.filter((t) => t.verdict === "approve").length,
  };
  const next = recordStep(ctx, "select", { status: "done", stop: null, summary });
  return result({ summary, next: nextStep(next, "select") });
}

// ---------------------------------------------------------------------------
// collect
// ---------------------------------------------------------------------------

/** One class's collected evidence and prechecks (`<night>/bundles/<sid>.json`, 0600, real data). */
export interface BundleFile {
  target: NightlyTarget;
  bundle: EvidenceBundle;
  prechecks: PrecheckFinding[];
  notes: string[];
  status: RawEvidence["status"];
  collectedAt: string;
}

export function bundleFile(paths: NightlyPaths, wiseSessionId: string): string {
  if (!/^[0-9a-f]{24}$/iu.test(wiseSessionId)) throw new Error("Not a Wise session id");
  return path.join(paths.bundlesDir, `${wiseSessionId}.json`);
}

export function readBundleFile(paths: NightlyPaths, wiseSessionId: string): BundleFile | null {
  return readJsonFile<BundleFile>(bundleFile(paths, wiseSessionId));
}

export interface CollectStepDeps {
  collect: Omit<CollectDeps, "cacheDir">;
  /** The tutor's prior feedback for the copy check (production: `loadTutorPriorFeedback`), cached per tutor. */
  priorFeedback: (target: NightlyTarget) => Promise<PriorFeedbackComparison[]>;
  otherStudentNames: (target: NightlyTarget) => Promise<string[]>;
  sessionIds?: readonly string[];
}

/**
 * Evidence for every chosen class (cache-first; Wise read at most once per class), then its bundle and prechecks.
 * A stop (STOP, deadline, Wise 429, a cap) ends the stage with what was collected; a later run resumes from the cache.
 */
export async function stepCollect(ctx: NightContext, deps: CollectStepDeps): Promise<StepResult> {
  const stop = stopBeforeStep(ctx);
  if (stop) return stoppedResult(ctx, "collect", stop);
  const targets = readTargets(ctx.paths);
  if (!targets) {
    const summary = { step: "collect", night: ctx.night, reason: "select has not run" };
    return result({ ok: false, stop: "no_targets", next: "select", summary, exitCode: EXIT.usage });
  }
  const wanted = deps.sessionIds && deps.sessionIds.length > 0 ? new Set(deps.sessionIds) : null;
  const chosen = targets.chosen.filter((target) => !wanted || wanted.has(target.wiseSessionId));
  const grades: Record<string, number> = {};
  const soniox: Record<string, number> = {};
  const retranscribe: Record<string, number> = {};
  const failures: string[] = [];
  const undeleted: string[] = [];
  let collected = 0;
  let stopped: NightlyStop | null = null;
  for (const target of chosen) {
    const before = stopBeforeStep(ctx);
    if (before) {
      stopped = before;
      break;
    }
    try {
      const raw = await collectRawEvidence({ ...deps.collect, cacheDir: ctx.paths.cacheDir }, target);
      const bundle = buildEvidenceBundle({ target, night: ctx.night, raw });
      const prechecks = runPrechecks({
        bundle, target, raw,
        otherStudentNames: await deps.otherStudentNames(target),
        priorFeedback: await deps.priorFeedback(target),
      });
      const file: BundleFile = {
        target, bundle, prechecks, notes: evidenceNotes(raw, bundle), status: raw.status, collectedAt: ctx.now().toISOString(),
      };
      writeJsonAtomic(bundleFile(ctx.paths, target.wiseSessionId), file);
      collected += 1;
      grades[bundle.grade] = (grades[bundle.grade] ?? 0) + 1;
      soniox[raw.status.soniox] = (soniox[raw.status.soniox] ?? 0) + 1;
      const retranscribeKey = raw.status.retranscribe.split(":")[0];
      retranscribe[retranscribeKey] = (retranscribe[retranscribeKey] ?? 0) + 1;
      if (raw.status.undeletedSonioxJob) undeleted.push(raw.status.undeletedSonioxJob);
      if (raw.status.detail === "failed") failures.push(`${target.wiseSessionId}:wise_detail`);
      ctx.log?.(`collect ${target.wiseSessionId}: ${bundle.grade} (detail ${raw.status.detail}, soniox ${raw.status.soniox}, zoom ${raw.status.zoom})`);
    } catch (error) {
      if (error instanceof NightlyStop) {
        stopped = error;
        break;
      }
      failures.push(`${target.wiseSessionId}:${(error instanceof Error ? error.message : String(error)).slice(0, 120)}`);
    }
  }
  const summary = {
    step: "collect",
    night: ctx.night,
    targets: chosen.length,
    collected,
    grades,
    soniox,
    retranscribe,
    wiseReads: deps.collect.gate.reads,
    failures,
    undeletedSonioxJobs: undeleted,
  };
  if (stopped) {
    recordStep(ctx, "collect", { status: "stopped", stop: stopped.reason, summary });
    return result({ ok: false, stop: stopped.reason, next: "collect", summary, exitCode: stopped.exitCode });
  }
  // Every class collected (with whatever evidence it has): done. A class that failed outright is left for a re-run;
  // a Soniox job of ours that could not be deleted is listed for a person (the production reaper removes it in 2 h).
  const status = collected < chosen.length || undeleted.length > 0 ? "partial" : "done";
  const state = recordStep(ctx, "collect", { status, stop: null, summary });
  return result({ summary, next: status === "done" ? nextStep(state, "collect") : "audit" });
}

/** Every bundle the collect step wrote for the night's chosen classes. */
export function readNightBundles(paths: NightlyPaths, targets: TargetsFile | null): BundleFile[] {
  if (!targets) return [];
  return targets.chosen.flatMap((target) => {
    const file = readBundleFile(paths, target.wiseSessionId);
    return file ? [file] : [];
  });
}

/** The audit key of a bundle's posted text. */
export function bundleAuditKey(file: BundleFile): string {
  return auditKey({ wiseSessionId: file.target.wiseSessionId, fieldsSha256: file.target.fieldsSha256, auditVersion: AUDIT_VERSION });
}

/** Whether a marker file exists (COLLECT_READY and friends). */
export function markerExists(file: string): boolean {
  return fs.existsSync(file);
}
