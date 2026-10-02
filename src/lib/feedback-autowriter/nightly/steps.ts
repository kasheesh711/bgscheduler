import fs from "node:fs";
import path from "node:path";
import type { Database } from "@/lib/db";
import type { PriorFeedbackComparison } from "@/lib/post-class-feedback/similarity";
import { auditBundles, cachedAudit } from "./audit";
import { AUDIT_VERSION } from "./audit-schema";
import { activeWiseCooldown, stopFilePresent, type NightlyCaps } from "./caps";
import {
  buildEvidenceBundle,
  collectRawEvidence,
  evidenceNotes,
  type CollectDeps,
  type RawEvidence,
} from "./evidence";
import type { ClaudeCall, ClaudeOutcome } from "./claude-runner";
import { EXIT, NightlyStop, type ExitCode } from "./exit";
import type { NightlyLedger } from "./ledger";
import { applyAgentFlags, planAgentFlags } from "./flags";
import { appendJsonl, readJsonFile, readJsonl, writeJsonAtomic, writeTextAtomic, type NightlyPaths } from "./paths";
import { runPrechecks } from "./prechecks";
import {
  classReportLine,
  groupByMode,
  loadWatchdog,
  mergeClassReport,
  modeHistory,
  renderReportMarkdown,
  renderSummaryMarkdown,
  type ClassReport,
  type NightCosts,
  type WatchdogResult,
} from "./report";
import { pruneNightly } from "./retention";
import { auditedKeys, auditKey, chooseTargets, loadNightlyTargets, type TargetChoice } from "./select";
import { fixBriefFile, renderPlanMarkdown, synthesizeNight } from "./synthesis";
import type { AuditRecord, EvidenceBundle, NightlyTarget, PrecheckFinding } from "./types";

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

// ---------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------

/** One Opus 5.5 max audit per collected class not audited yet (see audit.ts). */
export async function stepAudit(ctx: NightContext, deps: {
  ledger: Pick<NightlyLedger, "reserve" | "settle" | "attempts">;
  run: (call: ClaudeCall) => Promise<ClaudeOutcome>;
  sessionIds?: readonly string[];
  sleep?: (ms: number) => Promise<void>;
  retryDelayMs?: number;
}): Promise<StepResult> {
  const stop = stopBeforeStep(ctx);
  if (stop) return stoppedResult(ctx, "audit", stop);
  const targets = readTargets(ctx.paths);
  const wanted = deps.sessionIds && deps.sessionIds.length > 0 ? new Set(deps.sessionIds) : null;
  const files = readNightBundles(ctx.paths, targets).filter((file) => !wanted || wanted.has(file.target.wiseSessionId));
  if (!targets || (targets.chosen.length > 0 && files.length === 0)) {
    const summary = { step: "audit", night: ctx.night, reason: "nothing collected yet" };
    return result({ ok: false, stop: "no_bundles", next: targets ? "collect" : "select", summary, exitCode: EXIT.usage });
  }
  const stage = await auditBundles({
    night: ctx.night,
    auditsDir: ctx.paths.auditsDir,
    ledgerJsonl: ctx.paths.ledgerJsonl,
    ledger: deps.ledger,
    run: deps.run,
    concurrency: ctx.caps.auditConcurrency,
    perAuditUsd: ctx.caps.perAuditUsd,
    deadline: ctx.deadline,
    stopFiles: ctx.stopFiles,
    now: ctx.now,
    sleep: deps.sleep,
    retryDelayMs: deps.retryDelayMs,
    home: ctx.home,
    log: ctx.log,
  }, files);
  const verdicts: Record<string, number> = {};
  for (const record of stage.records) {
    const verdict = record.result?.verdict ?? "failed";
    verdicts[verdict] = (verdicts[verdict] ?? 0) + 1;
  }
  const summary = {
    step: "audit",
    night: ctx.night,
    bundles: files.length,
    audited: stage.audited,
    cached: stage.cached,
    failed: stage.failed,
    skipped: stage.skipped.length,
    verdicts,
    calls: stage.calls,
    proof: `Opus5.5max ${stage.opusProven}/${stage.calls}`,
    costUsd: Math.round(stage.costUsd * 10_000) / 10_000,
  };
  if (stage.stop) {
    recordStep(ctx, "audit", { status: "stopped", stop: stage.stop.reason, summary });
    return result({ ok: false, stop: stage.stop.reason, next: "report", summary, exitCode: stage.stop.exitCode });
  }
  const state = recordStep(ctx, "audit", { status: "done", stop: null, summary });
  return result({ summary, next: nextStep(state, "audit") });
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

interface AuditLedgerLine {
  type?: string;
  key?: string;
  verdict?: string | null;
  failure?: string | null;
  at?: string;
  bundleHash?: string;
  grade?: string;
  costUsd?: number | null;
}

/** Each collected class with its audit: the cached success, else its last recorded failure, else none. */
export function nightAuditRecords(ctx: Pick<NightContext, "paths">, files: readonly BundleFile[]): Array<{ file: BundleFile; record: AuditRecord | null }> {
  const failures = new Map<string, AuditLedgerLine>();
  for (const line of readJsonl<AuditLedgerLine>(ctx.paths.ledgerJsonl)) {
    if (line.type === "audit" && line.key && line.verdict === null && line.failure) failures.set(line.key, line);
  }
  return files.map((file) => {
    const cached = cachedAudit(ctx.paths.auditsDir, file);
    if (cached) return { file, record: cached };
    const failed = failures.get(bundleAuditKey(file));
    return {
      file,
      record: failed ? {
        wiseSessionId: file.target.wiseSessionId, fieldsSha256: file.target.fieldsSha256, auditVersion: AUDIT_VERSION, promptVersion: 0,
        bundleHash: file.bundle.hash, grade: file.bundle.grade, result: null, failure: failed.failure ?? "failed", proof: null, at: failed.at ?? "",
      } : null,
    };
  });
}

/** The night's merged class reports (prechecks + audits). */
export function nightReports(ctx: Pick<NightContext, "paths">): { files: BundleFile[]; records: AuditRecord[]; reports: ClassReport[] } {
  const files = readNightBundles(ctx.paths, readTargets(ctx.paths));
  const pairs = nightAuditRecords(ctx, files);
  return {
    files,
    records: pairs.flatMap((pair) => (pair.record ? [pair.record] : [])),
    reports: pairs.map((pair) => mergeClassReport(pair.file, pair.record)),
  };
}

interface CallLogLine {
  outcome?: string;
  models?: string[];
}

/** Tonight's spend and proof from the ledgers. */
export function nightCosts(ctx: Pick<NightContext, "paths">, ledger: Pick<NightlyLedger, "totals">): NightCosts {
  const totals = ledger.totals();
  const calls = readJsonl<CallLogLine>(ctx.paths.claudeCallsJsonl);
  const claudeKinds = ["opus_audit", "opus_reaudit", "opus_synthesis", "opus_fix"] as const;
  return {
    claudeUsd: Math.round(claudeKinds.reduce((sum, kind) => sum + totals[kind].usd, 0) * 10_000) / 10_000,
    claudeCalls: calls.length,
    opusProven: calls.filter((call) => call.outcome === "success" && (call.models ?? []).some((model) => model.startsWith("claude-opus-5-5"))).length,
    sonioxUsd: Math.round(totals.soniox.usd * 10_000) / 10_000,
    openrouterUsd: Math.round(totals.openrouter.usd * 10_000) / 10_000,
    wiseReads: totals.wise_read.count,
  };
}

/**
 * Merge, group, watchdog, optionally the synthesis (Opus, one call), then `report.md`, `summary.md`, `plan.md`,
 * `fix-brief.json`, the ledger's class lines and the night's cost line. Runs after a stopped audit too (a partial
 * report); only a STOP file prevents it, and the synthesis is skipped once the deadline has passed.
 */
export async function stepReport(ctx: NightContext, deps: {
  db: Database | null;
  ledger: Pick<NightlyLedger, "reserve" | "settle" | "totals">;
  run: ((call: ClaudeCall) => Promise<ClaudeOutcome>) | null;
  cliVersion: string | null;
}): Promise<StepResult> {
  if (stopFilePresent(ctx.stopFiles)) return stoppedResult(ctx, "report", new NightlyStop("stop_file", EXIT.stopped));
  const state = readRunState(ctx);
  const { files, records, reports } = nightReports(ctx);
  const at = ctx.now().toISOString();
  for (const report of reports) appendJsonl(ctx.paths.ledgerJsonl, classReportLine(ctx.night, report, at, AUDIT_VERSION));
  const modes = groupByMode(reports, modeHistory(ctx.paths.ledgerJsonl, ctx.night));
  const notes: string[] = [];
  let watchdog: WatchdogResult | null = null;
  if (deps.db) {
    try {
      watchdog = await loadWatchdog(deps.db, { night: ctx.night });
    } catch (error) {
      notes.push(`watchdog failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 120)}`);
    }
  }
  let synthesisLine: string | null = null;
  let synthesis: Record<string, unknown> = { ran: false };
  let stop: NightlyStop | null = null;
  const pastDeadline = ctx.deadline !== null && ctx.now().getTime() >= ctx.deadline.getTime();
  if (deps.run && !pastDeadline && records.some((record) => record.result)) {
    const outcome = await synthesizeNight({ ledger: deps.ledger, run: deps.run, perSynthesisUsd: ctx.caps.perSynthesisUsd }, {
      night: ctx.night, records, files, reports, modes,
    });
    if (outcome.ok) {
      writeTextAtomic(ctx.paths.planMd, renderPlanMarkdown(ctx.night, outcome.result));
      const brief = fixBriefFile(ctx.night, outcome.result);
      if (brief) writeJsonAtomic(ctx.paths.fixBriefJson, brief);
      synthesisLine = outcome.result.summaryLine;
      synthesis = { ran: true, ok: true, fixPick: outcome.result.fixPick?.mode ?? null, brief: Boolean(brief), costUsd: outcome.costUsd };
    } else {
      synthesis = { ran: true, ok: false, reason: outcome.reason, costUsd: outcome.costUsd };
      notes.push(`synthesis failed: ${outcome.reason}`);
      stop = outcome.stop;
    }
  } else if (deps.run && pastDeadline) {
    notes.push("synthesis skipped: past the deadline");
  }
  const costs = nightCosts(ctx, deps.ledger);
  const input = {
    night: ctx.night, generatedAt: at, code: state.code ?? null, cliVersion: deps.cliVersion ?? state.claudeCliVersion ?? null,
    reports, modes, watchdog, costs, synthesisLine, notes,
  };
  writeTextAtomic(ctx.paths.reportMd, renderReportMarkdown(input));
  writeTextAtomic(ctx.paths.summaryMd, renderSummaryMarkdown(input));
  appendJsonl(ctx.paths.costsJsonl, { night: ctx.night, at, ...costs, watchdogDayUsd: watchdog?.dayTotalUsd ?? null });
  const severities: Record<string, number> = {};
  for (const report of reports) {
    const key = report.severity ?? (report.auditVerdict ? report.auditVerdict === "insufficient_evidence" ? "insufficient_evidence" : "accurate" : "not_audited");
    severities[key] = (severities[key] ?? 0) + 1;
  }
  const summary = {
    step: "report",
    night: ctx.night,
    classes: reports.length,
    severities,
    modes: modes.map((group) => ({ mode: group.mode, classes: group.classes })),
    watchdogOutliers: watchdog?.outliers.length ?? null,
    watchdogDayOutlier: watchdog?.dayOutlier ?? null,
    synthesis,
    proof: `Opus5.5max ${costs.opusProven}/${costs.claudeCalls}`,
    costs,
    files: { report: ctx.paths.reportMd, summary: ctx.paths.summaryMd, plan: synthesis.ok ? ctx.paths.planMd : null },
  };
  if (stop) {
    recordStep(ctx, "report", { status: "partial", stop: stop.reason, summary });
    return result({ ok: false, stop: stop.reason, next: null, summary, exitCode: stop.exitCode });
  }
  const next = recordStep(ctx, "report", { status: "done", stop: null, summary });
  return result({ summary, next: nextStep(next, "report") });
}

// ---------------------------------------------------------------------------
// flag
// ---------------------------------------------------------------------------

/** Agent flags for the night's major/critical classes: a dry run unless `apply`. */
export async function stepFlag(ctx: NightContext, deps: { db: Database | null; apply: boolean }): Promise<StepResult> {
  const stop = stopBeforeStep(ctx);
  if (stop) return stoppedResult(ctx, "flag", stop);
  const { reports } = nightReports(ctx);
  const plan = planAgentFlags(reports, { auditVersion: AUDIT_VERSION, maxFlags: ctx.caps.maxFlagsPerNight });
  const items = plan.items.map((item) => ({ wiseSessionId: item.wiseSessionId, severity: item.severity, modes: item.modes, incident: item.incident }));
  if (!deps.apply || !deps.db) {
    const summary = { step: "flag", night: ctx.night, dryRun: true, planned: items, overCap: plan.overCap };
    writeJsonAtomic(path.join(ctx.paths.nightDir, "flags.json"), { ...summary, at: ctx.now().toISOString() });
    return result({ summary, next: "flag" });
  }
  const applied = await applyAgentFlags(deps.db, plan.items);
  const summary = { step: "flag", night: ctx.night, dryRun: false, planned: items, overCap: plan.overCap, ...applied };
  writeJsonAtomic(path.join(ctx.paths.nightDir, "flags.json"), { ...summary, at: ctx.now().toISOString() });
  const state = recordStep(ctx, "flag", { status: "done", stop: null, summary });
  return result({ summary, next: nextStep(state, "flag") });
}

// ---------------------------------------------------------------------------
// prune and costs
// ---------------------------------------------------------------------------

export function stepPrune(ctx: NightContext, options: { dryRun?: boolean } = {}): StepResult {
  const pruned = pruneNightly(ctx.paths.root, { now: ctx.now(), dryRun: options.dryRun, home: ctx.home });
  return result({
    summary: {
      step: "prune", dryRun: Boolean(options.dryRun), cacheDirs: pruned.cacheDirs.length, auditDirs: pruned.auditDirs.length,
      nightFiles: pruned.nightFiles.length,
    },
  });
}

interface CostLine extends Partial<NightCosts> {
  night?: string;
  at?: string;
}

/** The last `days` nights' costs (the latest line per night) and their totals. */
export function stepCosts(ctx: NightContext, days: number): StepResult {
  const latest = new Map<string, CostLine>();
  for (const line of readJsonl<CostLine>(ctx.paths.costsJsonl)) if (line.night) latest.set(line.night, line);
  const nights = [...latest.values()].filter((line) => line.night! > addDaysIso(ctx.night, -days)).sort((a, b) => a.night!.localeCompare(b.night!));
  const sum = (key: keyof NightCosts) => Math.round(nights.reduce((total, line) => total + (Number(line[key]) || 0), 0) * 10_000) / 10_000;
  return result({
    summary: {
      step: "costs",
      days,
      nights: nights.map((line) => ({ night: line.night, claudeUsd: line.claudeUsd, claudeCalls: line.claudeCalls, opusProven: line.opusProven, sonioxUsd: line.sonioxUsd, wiseReads: line.wiseReads })),
      totals: { claudeUsd: sum("claudeUsd"), claudeCalls: sum("claudeCalls"), sonioxUsd: sum("sonioxUsd"), openrouterUsd: sum("openrouterUsd"), wiseReads: sum("wiseReads") },
    },
  });
}

function addDaysIso(night: string, days: number): string {
  const date = new Date(`${night}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

/**
 * The whole night, from the first unfinished step. A step that stops ends the run — never a retry loop — after a
 * partial report when the stop came after selection (not for a STOP file: STOP means stop).
 */
export async function runNight(ctx: Pick<NightContext, "paths" | "night" | "now" | "log">, input: {
  order: readonly StepName[];
  steps: Partial<Record<StepName, () => Promise<StepResult> | StepResult>>;
  partialReport: () => Promise<StepResult>;
}): Promise<StepResult> {
  const steps: Record<string, unknown> = {};
  const brief = (step: StepResult) => ({ ok: step.ok, stop: step.stop, exitCode: step.exitCode, summary: step.summary });
  for (const name of input.order) {
    if (readRunState(ctx).steps[name]?.status === "done") {
      steps[name] = "done earlier";
      continue;
    }
    const handler = input.steps[name];
    if (!handler) continue;
    ctx.log?.(`run: ${name}`);
    const outcome = await handler();
    steps[name] = brief(outcome);
    if (!outcome.ok) {
      const reportable = !["preflight", "select", "report"].includes(name) && outcome.stop !== "stop_file";
      if (reportable) steps.report = brief(await input.partialReport());
      return { ok: false, stop: outcome.stop, next: outcome.next, exitCode: outcome.exitCode, summary: { step: "run", night: ctx.night, steps } };
    }
  }
  return { ok: true, stop: null, next: null, exitCode: EXIT.ok, summary: { step: "run", night: ctx.night, steps } };
}
