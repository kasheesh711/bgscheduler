import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Database } from "@/lib/db";
import type { PriorFeedbackComparison } from "@/lib/post-class-feedback/similarity";
import { addDays, bangkokDayBounds } from "../quality";
import { parseAutowriterSessionDetail, recordingForTranscription } from "../session";
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
import { claudeVersionSupported, type ClaudeCall, type ClaudeOutcome } from "./claude-runner";
import { EXIT, NightlyStop, type ExitCode } from "./exit";
import type { NightlyLedger } from "./ledger";
import { applyAgentFlags, countAgentFlags, planAgentFlags } from "./flags";
import { appendJsonl, nightlyPaths, readJsonFile, readJsonl, writeJsonAtomic, writeTextAtomic, type NightlyPaths } from "./paths";
import { runPrechecks } from "./prechecks";
import {
  auditCounts,
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
import { auditedKeys, auditKey, chooseTargets, latePickups, loadNightlyTargets, type TargetChoice } from "./select";
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
  code?: { head: string | null; branch: string | null; dirty: boolean; onMain?: boolean | null } | null;
  claudeCliVersion?: string | null;
  caps?: NightlyCaps;
  /** The last preflight passed only because of `--supervised` (code not on origin/main and not pinned). */
  supervised?: boolean;
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
  /** `onMain`: HEAD is reachable from origin/main (null: origin/main unknown — treated as not). */
  code: { head: string | null; branch: string | null; dirty: boolean; onMain?: boolean | null } | null;
  claudeCliVersion: string | null;
  lock: { ok: true } | { ok: false; reason: string; holder: unknown };
  /** The commit the owner pinned in `~/.bgscheduler-nightly/config.json` (`runnerSha`), if any. */
  pinnedSha?: string | null;
  /** `--supervised`: the owner is watching this run from reviewed code that is not on origin/main yet. */
  supervised?: boolean;
}

/**
 * STOP, the deadline, the lock, a clean tree of reviewed code (HEAD on origin/main, the owner's pinned `runnerSha`, or
 * an explicit `--supervised`, which is recorded), the environment, node ≥ 22 and a working `claude` CLI (2.1.x or
 * later); writes `run.json`.
 */
export function stepPreflight(ctx: NightContext, facts: PreflightFacts): StepResult {
  const stop = stopBeforeStep(ctx);
  if (stop) return stoppedResult(ctx, "preflight", stop);
  const problems: string[] = [];
  const nodeMajor = Number(facts.nodeVersion.replace(/^v/u, "").split(".")[0]);
  if (!(nodeMajor >= 22)) problems.push(`node_${facts.nodeVersion}_below_22`);
  if (facts.missingEnv.length > 0) problems.push(`env_missing:${facts.missingEnv.join(",")}`);
  if (!facts.code) problems.push("not_a_git_checkout");
  else if (facts.code.dirty) problems.push("dirty_tree");
  // Unattended runs only run reviewed code: anything on origin/main, or the one commit the owner pinned.
  const pinned = Boolean(facts.pinnedSha && facts.code?.head?.toLowerCase().startsWith(facts.pinnedSha.toLowerCase()));
  const runner = { onMain: facts.code?.onMain ?? null, pinned, supervised: facts.supervised === true };
  if (facts.code && !runner.onMain && !pinned && !runner.supervised) problems.push("runner_not_on_main");
  // Every reasoning step is a `claude -p` call: without a working, recent CLI the night cannot audit anything.
  if (!facts.claudeCliVersion) problems.push("claude_cli_missing");
  else if (!claudeVersionSupported(facts.claudeCliVersion)) problems.push("claude_cli_unsupported");
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
    runner,
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
    supervised: runner.supervised,
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

/** Days before the audited night whose late-verified posts are picked up. */
export const LATE_PICKUP_NIGHTS = 2;
/** Selection waits this long after the night ends (24:00 Bangkok) for its last posts, unless forced. */
export const SELECT_AFTER_NIGHT_END_MS = 60 * 60 * 1000;

/**
 * The night's posts to audit (SELECT only): refused until an hour after the night ended (unless `force`). Each selection
 * is merged into the earlier one — a class once selected is never dropped — and posts of the previous nights that
 * were verified after their own selection and never audited are added as late targets.
 */
export async function stepSelect(ctx: NightContext, deps: {
  db: Database;
  ledger: Pick<NightlyLedger, "attempts">;
  sessionIds?: readonly string[];
  /** Select before the night is over (an hour after 24:00 Bangkok). */
  force?: boolean;
}): Promise<StepResult> {
  const stop = stopBeforeStep(ctx);
  if (stop) return stoppedResult(ctx, "select", stop);
  const nightOver = bangkokDayBounds(ctx.night).end.getTime() + SELECT_AFTER_NIGHT_END_MS;
  if (!deps.force && ctx.now().getTime() < nightOver) {
    const summary = { step: "select", night: ctx.night, reason: `the night is not over until ${new Date(nightOver).toISOString()} (use --force)` };
    recordStep(ctx, "select", { status: "failed", stop: "night_not_over", summary });
    return result({ ok: false, stop: "night_not_over", next: "select", summary, exitCode: EXIT.guardRefused });
  }
  const audited = auditedKeys(ctx.paths.ledgerJsonl);
  const wanted = deps.sessionIds && deps.sessionIds.length > 0 ? new Set(deps.sessionIds) : null;
  const targets = await loadNightlyTargets(deps.db, { night: ctx.night, sessionIds: deps.sessionIds });
  const late: NightlyTarget[] = [];
  for (let back = 1; back <= LATE_PICKUP_NIGHTS; back += 1) {
    const earlierNight = addDays(ctx.night, -back);
    const earlier = readTargets(nightlyPaths(ctx.paths.root, earlierNight));
    if (!earlier) continue;
    const posts = await loadNightlyTargets(deps.db, { night: earlierNight, sessionIds: deps.sessionIds });
    late.push(...latePickups({ posts, night: earlierNight, earlier, audited, auditVersion: AUDIT_VERSION }));
  }
  const previous = (readTargets(ctx.paths)?.chosen ?? []).filter((target) => !wanted || wanted.has(target.wiseSessionId));
  const choice = chooseTargets({
    targets,
    late,
    previous,
    audited,
    failures: (key) => deps.ledger.attempts(key).failed,
    auditVersion: AUDIT_VERSION,
    maxTargets: ctx.caps.maxTargets,
  });
  // With --sessions, the rest of an earlier selection is kept as it was.
  const others = wanted ? (readTargets(ctx.paths)?.chosen ?? []).filter((target) => !wanted.has(target.wiseSessionId)) : [];
  const file: TargetsFile = {
    night: ctx.night, auditVersion: AUDIT_VERSION, selectedAt: ctx.now().toISOString(),
    chosen: [...choice.chosen, ...others], skipped: choice.skipped,
  };
  writeJsonAtomic(ctx.paths.targetsJson, file);
  const chosen = file.chosen;
  const summary = {
    step: "select",
    night: ctx.night,
    posts: targets.length,
    chosen: chosen.length,
    ...choice.counts,
    overCap: choice.skipped.length,
    byEvidence: { transcript: chosen.filter((t) => t.evidence === "transcript").length, summary: chosen.filter((t) => t.evidence === "summary").length },
    approvedByOwner: chosen.filter((t) => t.verdict === "approve").length,
    // Audited all the same; only a later correction needs the first-shot row.
    noFirstShotRow: chosen.filter((t) => t.firstShotPostId === null).length,
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
  /**
   * Why collection is incomplete for now (a Wise read or a production Soniox read failed, the job had not finished):
   * the class is not audited until a later collect gets it. Empty or absent: complete.
   */
  transient?: string[];
  /** Whether better evidence may still come (a transient failure, or a recording still listed to re-transcribe). */
  improvable?: boolean;
  /** Display names of the tutor's other students (local; the fix brief must never contain them). */
  otherStudentNames?: string[];
}

/** Recordings stay listed in Wise for about a day after class. */
const RECORDING_LISTED_MS = 24 * 60 * 60 * 1000;

/** Transient collection failures of one class (empty: none). */
export function transientFailures(status: RawEvidence["status"]): string[] {
  const reasons: string[] = [];
  if (status.detail === "failed") reasons.push("wise_detail_failed");
  if (status.soniox === "error") reasons.push("soniox_read_failed");
  if (status.soniox === "not_finished") reasons.push("soniox_job_not_finished");
  return reasons;
}

/**
 * Whether the evidence may still get better: a transient failure, no Soniox key to read the production transcript,
 * or a transcript post with no transcript whose recording Wise still lists (a re-transcription could recover it).
 */
export function evidenceImprovable(input: { target: NightlyTarget; bundle: EvidenceBundle; raw: RawEvidence; now: Date }): boolean {
  if (transientFailures(input.raw.status).length > 0 || input.raw.status.soniox === "no_client") return true;
  if (input.target.evidence !== "transcript" || input.bundle.transcript) return false;
  if (input.raw.status.retranscribe === "done") return false;
  let recordingListed = false;
  try {
    recordingListed = input.raw.detail !== null && recordingForTranscription(parseAutowriterSessionDetail(input.raw.detail)).ok;
  } catch {
    recordingListed = false;
  }
  return recordingListed && input.now.getTime() < new Date(input.target.scheduledEndAt).getTime() + RECORDING_LISTED_MS;
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
  /** Classes collected with a transient failure: not audited until a later collect completes them. */
  const incomplete: string[] = [];
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
      const otherStudentNames = await deps.otherStudentNames(target);
      const prechecks = runPrechecks({
        bundle, target, raw, otherStudentNames,
        priorFeedback: await deps.priorFeedback(target),
      });
      const transient = transientFailures(raw.status);
      const file: BundleFile = {
        target, bundle, prechecks, notes: evidenceNotes(raw, bundle), status: raw.status, collectedAt: ctx.now().toISOString(),
        transient, improvable: evidenceImprovable({ target, bundle, raw, now: ctx.now() }), otherStudentNames,
      };
      if (transient.length > 0) incomplete.push(`${target.wiseSessionId}:${transient.join(",")}`);
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
    incomplete,
    undeletedSonioxJobs: undeleted,
  };
  if (stopped) {
    recordStep(ctx, "collect", { status: "stopped", stop: stopped.reason, summary });
    return result({ ok: false, stop: stopped.reason, next: "collect", summary, exitCode: stopped.exitCode });
  }
  // Every class collected (with whatever evidence it has): done. A class that failed outright is left for a re-run;
  // a Soniox job of ours that could not be deleted is listed for a person (the production reaper removes it in 2 h).
  const status = collected < chosen.length || undeleted.length > 0 || incomplete.length > 0 ? "partial" : "done";
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
    skippedReasons: Object.fromEntries([...new Set(stage.skipped.map((item) => item.reason))].map((reason) => [reason, stage.skipped.filter((item) => item.reason === reason).length])),
    verdicts,
    calls: stage.calls,
    proof: `Opus5.5max ${stage.opusProven}/${stage.calls}`,
    costUsd: Math.round(stage.costUsd * 10_000) / 10_000,
  };
  if (stage.stop) {
    recordStep(ctx, "audit", { status: "stopped", stop: stage.stop.reason, summary });
    return result({ ok: false, stop: stage.stop.reason, next: "report", summary, exitCode: stage.stop.exitCode });
  }
  // A class skipped for incomplete collection is audited by a later run, once collect completes it.
  const waiting = stage.skipped.some((item) => item.reason === "collection_incomplete");
  const state = recordStep(ctx, "audit", { status: waiting ? "partial" : "done", stop: null, summary });
  return result({ summary, next: waiting ? "report" : nextStep(state, "audit") });
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

/** What the night's synthesis was made from: the audited texts, their evidence and verdicts. */
export function synthesisInputHash(records: readonly AuditRecord[]): string {
  const keys = records.filter((record) => record.result)
    .map((record) => `${record.wiseSessionId}:${record.fieldsSha256}:${record.bundleHash}:${record.auditVersion}:${record.result!.verdict}`)
    .sort();
  return createHash("sha256").update(keys.join("\n")).digest("hex");
}

function synthesisCacheFile(paths: NightlyPaths): string {
  return path.join(paths.nightDir, "synthesis.json");
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
  // The synthesis is paid for once per set of audits: a report re-run over the same audits reuses it.
  const synthesisInput = synthesisInputHash(records);
  const previous = readJsonFile<{ inputHash: string; summaryLine: string; fixPick: string | null; brief: boolean }>(synthesisCacheFile(ctx.paths));
  if (deps.run && previous && previous.inputHash === synthesisInput && fs.existsSync(ctx.paths.planMd)) {
    synthesisLine = previous.summaryLine;
    synthesis = { ran: false, reused: true, ok: true, fixPick: previous.fixPick, brief: previous.brief, costUsd: 0 };
  } else if (deps.run && !pastDeadline && records.some((record) => record.result)) {
    const outcome = await synthesizeNight({ ledger: deps.ledger, run: deps.run, perSynthesisUsd: ctx.caps.perSynthesisUsd }, {
      night: ctx.night, records, files, reports, modes,
    });
    if (outcome.ok) {
      writeTextAtomic(ctx.paths.planMd, renderPlanMarkdown(ctx.night, outcome.result));
      const brief = fixBriefFile(ctx.night, outcome.result);
      if (brief) writeJsonAtomic(ctx.paths.fixBriefJson, brief);
      synthesisLine = outcome.result.summaryLine;
      synthesis = { ran: true, ok: true, fixPick: outcome.result.fixPick?.mode ?? null, brief: Boolean(brief), costUsd: outcome.costUsd };
      writeJsonAtomic(synthesisCacheFile(ctx.paths), {
        inputHash: synthesisInput, summaryLine: outcome.result.summaryLine, fixPick: outcome.result.fixPick?.mode ?? null, brief: Boolean(brief),
      });
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
  const counts = auditCounts(reports);
  const severities: Record<string, number> = {};
  for (const report of reports) {
    const key = report.severity ?? (report.auditVerdict ? report.auditVerdict === "insufficient_evidence" ? "insufficient_evidence" : "accurate" : "not_audited");
    severities[key] = (severities[key] ?? 0) + 1;
  }
  const summary = {
    step: "report",
    night: ctx.night,
    classes: reports.length,
    audited: counts.audited,
    notAudited: counts.notAudited,
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
  // A report written before collection and the audits finished is partial: a resumed run writes it again.
  const complete = state.steps.collect?.status === "done" && state.steps.audit?.status === "done";
  const next = recordStep(ctx, "report", { status: complete ? "done" : "partial", stop: null, summary: { ...summary, partial: !complete } });
  return result({ summary: { ...summary, partial: !complete }, next: complete ? nextStep(next, "report") : nextStep(next) });
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
  // The night's cap is counted in the database: flags raised by earlier runs of this night count too.
  const already = await countAgentFlags(deps.db, reports.map((report) => report.wiseSessionId));
  const applied = await applyAgentFlags(deps.db, plan.items, { maxNew: Math.max(0, ctx.caps.maxFlagsPerNight - already) });
  const summary = {
    step: "flag", night: ctx.night, dryRun: false, planned: items, alreadyRaised: already,
    inserted: applied.inserted, existing: applied.existing, incidents: applied.incidents, overCap: [...plan.overCap, ...applied.overCap],
  };
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
  const nights = [...latest.values()].filter((line) => line.night! > addDays(ctx.night, -days)).sort((a, b) => a.night!.localeCompare(b.night!));
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


// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

/**
 * The whole night, from the first unfinished step. A step is skipped only when it is done and no step before it ran
 * in this invocation: once a step runs (new targets, a new audit), every later step runs again — the report is always
 * rewritten after a new audit. `always` names steps that run every time. A step that stops ends the run — never a
 * retry loop — after a partial report when the stop came after selection (not for a STOP file: STOP means stop); a
 * collect stopped by Wise throttling or a cap still lets the classes already collected be audited and reported.
 */
export async function runNight(ctx: Pick<NightContext, "paths" | "night" | "now" | "log">, input: {
  order: readonly StepName[];
  steps: Partial<Record<StepName, () => Promise<StepResult> | StepResult>>;
  partialReport: () => Promise<StepResult>;
  always?: ReadonlySet<StepName>;
}): Promise<StepResult> {
  const steps: Record<string, unknown> = {};
  const brief = (step: StepResult) => ({ ok: step.ok, stop: step.stop, exitCode: step.exitCode, summary: step.summary });
  const ended = (failure: StepResult): StepResult => ({
    ok: false, stop: failure.stop, next: failure.next, exitCode: failure.exitCode, summary: { step: "run", night: ctx.night, steps },
  });
  let ranBefore = false;
  /** A collect stop that still lets the classes collected so far be audited and reported (Wise throttled, a cap). */
  let softStop: StepResult | null = null;
  for (const name of input.order) {
    const done = readRunState(ctx).steps[name]?.status === "done";
    if (done && !ranBefore && !input.always?.has(name)) {
      steps[name] = "done earlier";
      continue;
    }
    const handler = input.steps[name];
    if (!handler) continue;
    ctx.log?.(`run: ${name}`);
    const outcome = await handler();
    ranBefore = true;
    steps[name] = brief(outcome);
    if (!outcome.ok) {
      if (name === "collect" && SOFT_COLLECT_STOPS.has(outcome.exitCode)) {
        softStop = outcome;
        continue;
      }
      const reportable = !["preflight", "select", "report"].includes(name) && outcome.stop !== "stop_file";
      if (reportable) steps.report = brief(await input.partialReport());
      // The first stop is the run's: a soft collect stop before this one still names the run's end.
      return ended(softStop ?? outcome);
    }
  }
  if (softStop) return ended(softStop);
  return { ok: true, stop: null, next: null, exitCode: EXIT.ok, summary: { step: "run", night: ctx.night, steps } };
}

/** Collect stops after which the classes already collected are still audited and reported: Wise throttled, a cap. */
const SOFT_COLLECT_STOPS = new Set<ExitCode>([EXIT.wiseThrottled, EXIT.caps]);
