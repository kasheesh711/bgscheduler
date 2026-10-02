import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NIGHTLY_FILE_MODE, appendJsonl, ensureDir, nightlyHome } from "./paths";
import type { ClaudeProof } from "./types";

/**
 * Every reasoning step of the nightly audit is one `claude -p` call pinned to Opus 5.5 at max effort on the owner's
 * Claude Code subscription: no tools, no MCP, no CLAUDE.md or hooks (`--safe-mode`), no session left behind, a JSON
 * schema, a hard budget, the prompt on stdin, an empty working directory and an environment stripped to the basics
 * (never ANTHROPIC_API_KEY — the subscription's OAuth login is used — and never a database, Wise, OpenRouter or Soniox
 * secret). The output is trusted only with proof that Opus 5.5 produced it (`modelUsage`); anything else fails closed.
 * Every call is logged to `<night>/claude-calls.jsonl` without the prompt.
 */

export const CLAUDE_MODEL = "claude-opus-5-5";
export const CLAUDE_EFFORT = "max";
export const CLAUDE_DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
/** Output by another model above this is not "helper noise": the answer is not Opus 5.5's. */
const OTHER_MODEL_OUTPUT_LIMIT = 500;
/**
 * A VISIBLE answer (output minus thinking) longer than this is a runaway, not an audit. Thinking is not counted: at max
 * effort a long lesson can think for more than 60k tokens (2 Oct), and the call's spend is already bounded by
 * `--max-budget-usd`.
 */
const MAX_OPUS_OUTPUT_TOKENS = 60_000;
const MAX_STDOUT_BYTES = 20 * 1024 * 1024;
const KILL_GRACE_MS = 10_000;
/**
 * After the `claude` process exits, its pipes normally close at once ("close"). A grandchild that inherited them can keep
 * them open: the call is settled this long after the exit anyway, with the output read so far.
 */
const EXIT_GRACE_MS = 5_000;

/** The only variables a `claude -p` child gets. */
export const CLAUDE_ENV_ALLOWLIST = ["HOME", "PATH", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TERM"] as const;

/** Flags that would change auth or the model behind our back: never passed. */
const FORBIDDEN_FLAGS = ["--bare", "--fallback-model", "--resume", "--continue", "--dangerously-skip-permissions"];

/**
 * Whether `claude --version` names a CLI new enough for these flags (`--safe-mode`, `--permission-prompts`, `--effort
 * max`, `modelUsage` in the JSON envelope): 2.1.x or later. "2.1.287 (Claude Code)" → true.
 */
export function claudeVersionSupported(version: string | null): boolean {
  const match = /(\d+)\.(\d+)\.(\d+)/u.exec(version ?? "");
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 2 || (major === 2 && minor >= 1);
}

export function claudeChildEnv(parent: Record<string, string | undefined> = process.env): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const key of CLAUDE_ENV_ALLOWLIST) {
    const value = parent[key];
    if (typeof value === "string" && value !== "") env[key] = value;
  }
  return env as unknown as NodeJS.ProcessEnv;
}

/** The empty working directory every call runs in (`~/.bgscheduler-nightly/claude-cwd`, 0700). */
export function claudeCwd(home?: string): string {
  const dir = path.join(nightlyHome(home), "claude-cwd");
  ensureDir(dir);
  return dir;
}

export function buildClaudeArgs(call: { schema: Record<string, unknown>; budgetUsd: number; systemPromptFile: string }): string[] {
  if (!(call.budgetUsd > 0) || !Number.isFinite(call.budgetUsd)) throw new Error("A claude call needs a positive budget");
  const args = [
    "-p",
    "--model", CLAUDE_MODEL,
    "--effort", CLAUDE_EFFORT,
    "--tools", "",
    "--output-format", "json",
    "--json-schema", JSON.stringify(call.schema),
    "--max-budget-usd", String(call.budgetUsd),
    "--no-session-persistence",
    "--permission-prompts", "none",
    "--strict-mcp-config",
    "--safe-mode",
    "--system-prompt-file", call.systemPromptFile,
  ];
  assertSafeClaudeArgs(args);
  return args;
}

/** Refuses argv that drops the model pin, the effort or the safety flags, or adds a forbidden flag. */
export function assertSafeClaudeArgs(args: readonly string[]): void {
  const forbidden = args.find((arg) => FORBIDDEN_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`)));
  if (forbidden) throw new Error(`Forbidden claude flag: ${forbidden}`);
  const valueOf = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  if (valueOf("--model") !== CLAUDE_MODEL) throw new Error("claude call not pinned to Opus 5.5");
  if (valueOf("--effort") !== CLAUDE_EFFORT) throw new Error("claude call not at max effort");
  if (valueOf("--tools") !== "") throw new Error("claude call must have no tools");
  for (const flag of ["-p", "--safe-mode", "--strict-mcp-config", "--no-session-persistence"]) {
    if (!args.includes(flag)) throw new Error(`claude call is missing ${flag}`);
  }
}

/** The argv as logged: the JSON schema replaced by its hash (the prompt is never in argv). */
export function loggableArgs(args: readonly string[]): string[] {
  return args.map((arg, index) => args[index - 1] === "--json-schema"
    ? `<json-schema sha256:${createHash("sha256").update(arg).digest("hex").slice(0, 16)}>` : arg);
}

export type ClaudeOutcomeKind = "success" | "cli_error" | "budget_exceeded" | "usage_limited" | "auth" | "timeout" | "unparseable";

/**
 * How a `claude -p` call is settled in the spend ledger. Only "invalid" (an answer that failed validation) and
 * "unparseable" (no usable JSON) are the key's own failures and count toward `failed_twice`; every other failure is
 * `infra:<kind>` (CLI error, time-out, budget, usage limit, auth) and never does — the next run tries the key again.
 */
export function ledgerOutcome(kind: ClaudeOutcomeKind, valid: boolean): string {
  if (kind === "success") return valid ? "success" : "invalid";
  if (kind === "unparseable") return "unparseable";
  return `infra:${kind}`;
}

export type ClaudeOutcome =
  | { kind: "success"; value: unknown; proof: ClaudeProof }
  | { kind: Exclude<ClaudeOutcomeKind, "success">; reason: string; proof: ClaudeProof | null };

interface ModelUsageEntry {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
  canonicalModel?: string;
}

interface Envelope {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  api_error_status?: number | null;
  result?: string;
  errors?: string[];
  duration_ms?: number;
  total_cost_usd?: number;
  structured_output?: unknown;
  modelUsage?: Record<string, ModelUsageEntry>;
}

const AUTH_PATTERN = /invalid api key|run \/login|not logged in|log ?in again|authenticat|oauth|unauthori[sz]ed|\b401\b|\b403\b|forbidden/iu;
const USAGE_PATTERN = /usage limit|hit your (?:usage )?limit|limit reached|rate.?limit|\b429\b|quota|out of (?:extra )?usage/iu;

function isOpusKey(key: string, entry: ModelUsageEntry | undefined): boolean {
  return key === CLAUDE_MODEL || /^claude-opus-5-5(?:\[[^\]]*\]|-\d{8})$/u.test(key) || entry?.canonicalModel === CLAUDE_MODEL;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Parse the CLI's stdout: one JSON object (the last JSON line when something printed before it). */
function readEnvelope(stdout: string): Envelope | null {
  const text = stdout.trim();
  if (!text) return null;
  const candidates = [text, ...text.split("\n").reverse().map((line) => line.trim()).filter((line) => line.startsWith("{"))];
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) return value as Envelope;
    } catch {
      // Not this one.
    }
  }
  return null;
}

/** The proof a call carries: its argv, the CLI version, the models it used, tokens and cost. */
export function proofOf(envelope: Envelope | null, input: { argv: readonly string[]; cliVersion: string | null; durationMs: number }): ClaudeProof | null {
  if (!envelope) return null;
  const usage = envelope.modelUsage && typeof envelope.modelUsage === "object" ? envelope.modelUsage : {};
  const models = Object.keys(usage);
  const opusKey = models.find((key) => isOpusKey(key, usage[key]));
  return {
    argv: loggableArgs(input.argv),
    cliVersion: input.cliVersion,
    models,
    opusOutputTokens: opusKey ? num(usage[opusKey]?.outputTokens) : 0,
    inputTokens: models.reduce((sum, key) => sum + num(usage[key]?.inputTokens) + num(usage[key]?.cacheReadInputTokens) + num(usage[key]?.cacheCreationInputTokens), 0),
    outputTokens: models.reduce((sum, key) => sum + num(usage[key]?.outputTokens), 0),
    costUsd: typeof envelope.total_cost_usd === "number" && Number.isFinite(envelope.total_cost_usd) ? envelope.total_cost_usd : null,
    durationMs: typeof envelope.duration_ms === "number" ? envelope.duration_ms : input.durationMs,
    effort: "max",
  };
}

/**
 * The CLI's own error line of an error envelope: `result` only when the envelope is an error and it is a short, plain
 * line ("API Error: 401 …", "You've hit your limit · resets 5am") — never the model's answer, which is long or JSON.
 */
function cliErrorLine(envelope: Envelope): string {
  const result = envelope.result?.trim() ?? "";
  if (envelope.is_error !== true || result.length === 0 || result.length > 600) return "";
  return /^(?:\{|\[|```)/u.test(result) ? "" : result;
}

function unfence(text: string): string {
  return text.trim().replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "");
}

/**
 * What a finished `claude -p` process means. Fails closed: a "success" is only an answer that parses AND whose
 * `modelUsage` shows Opus 5.5 — with no other model writing more than a few hundred tokens and no runaway length.
 */
export function parseClaudeEnvelope(stdout: string, stderr: string, code: number | null, context: {
  argv: readonly string[];
  cliVersion: string | null;
  durationMs: number;
  timedOut?: boolean;
}): ClaudeOutcome {
  const envelope = readEnvelope(stdout);
  const proof = proofOf(envelope, context);
  if (context.timedOut) return { kind: "timeout", reason: "timeout", proof };
  if (!envelope) {
    // stdout without an envelope may be the model's own words: only stderr says why the CLI failed.
    if (AUTH_PATTERN.test(stderr)) return { kind: "auth", reason: "auth", proof: null };
    if (USAGE_PATTERN.test(stderr)) return { kind: "usage_limited", reason: "usage_limited", proof: null };
    return code === 0
      ? { kind: "unparseable", reason: "no_json_envelope", proof: null }
      : { kind: "cli_error", reason: `exit_${code ?? "signal"}`, proof: null };
  }
  const subtype = envelope.subtype ?? "";
  const errorText = [cliErrorLine(envelope), ...(Array.isArray(envelope.errors) ? envelope.errors : []), stderr].join("\n");
  if (subtype === "error_max_budget_usd") return { kind: "budget_exceeded", reason: "max_budget_usd", proof };
  if (envelope.is_error === true || (subtype !== "" && subtype !== "success")) {
    const status = envelope.api_error_status ?? null;
    if (status === 401 || status === 403 || AUTH_PATTERN.test(errorText)) return { kind: "auth", reason: `auth${status ? `_${status}` : ""}`, proof };
    if (status === 429 || USAGE_PATTERN.test(errorText)) return { kind: "usage_limited", reason: `usage_limited${status ? `_${status}` : ""}`, proof };
    if (subtype === "error_max_structured_output_retries") return { kind: "unparseable", reason: subtype, proof };
    return { kind: "cli_error", reason: subtype || "is_error", proof };
  }
  let value: unknown = envelope.structured_output;
  if (value === undefined || value === null) {
    try {
      value = JSON.parse(unfence(envelope.result ?? ""));
    } catch {
      return { kind: "unparseable", reason: "result_not_json", proof };
    }
  }
  if (!value || typeof value !== "object") return { kind: "unparseable", reason: "result_not_object", proof };
  // Proof of model, fail closed.
  const usage = envelope.modelUsage ?? {};
  const models = Object.keys(usage);
  const opusKey = models.find((key) => isOpusKey(key, usage[key]));
  const others = models.filter((key) => key !== opusKey && num(usage[key]?.outputTokens) > OTHER_MODEL_OUTPUT_LIMIT);
  if (!opusKey) {
    // Another model wrote the answer: the subscription fell back (an Opus limit). Stop, never trust it.
    if (others.length > 0) return { kind: "usage_limited", reason: `model_fallback:${others.join(",")}`, proof };
    return { kind: "cli_error", reason: "model_proof:no_opus_usage", proof };
  }
  if (others.length > 0) return { kind: "cli_error", reason: `model_proof:other_model_output:${others.join(",")}`, proof };
  const visibleOutput = num(usage[opusKey]?.outputTokens) - num(usage[opusKey]?.thinkingTokens);
  if (visibleOutput > MAX_OPUS_OUTPUT_TOKENS) return { kind: "cli_error", reason: "oversized_output", proof };
  return { kind: "success", value, proof: proof! };
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

export interface ChildLike {
  stdin: { write(data: string): unknown; end(): unknown; on?(event: "error", listener: (error: Error) => void): unknown } | null;
  stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnLike = (command: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildLike;

const defaultSpawn: SpawnLike = (command, args, options) =>
  nodeSpawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });

export interface ClaudeCall {
  /** What the call is for, in the log: audit, reaudit, synthesis, smoke. */
  purpose: string;
  /** Idempotency key it serves (audit key), in the log. */
  key: string;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  budgetUsd: number;
  timeoutMs?: number;
}

export interface ClaudeRunnerDeps {
  cwd: string;
  cliVersion: string | null;
  /** `<night>/claude-calls.jsonl`; null: no log (tests). */
  callsLog: string | null;
  spawn?: SpawnLike;
  claudeBin?: string;
  parentEnv?: Record<string, string | undefined>;
  now?: () => Date;
  /** Where the system prompt file is written for `--system-prompt-file` (default: a fresh temp dir). */
  tempDir?: string;
  /** How long after the process exits its output may still arrive before the call is settled (tests shorten it). */
  exitGraceMs?: number;
  /** Every `claude` process still running, so a signal handler can kill them before the lock is released. */
  children?: Set<ChildLike>;
}

/**
 * Stop every running `claude` call: SIGTERM, then SIGKILL for any still running after `graceMs`. Resolves once the set is
 * empty (each call removes its process when it settles) or the second signal was sent. Returns how many were running.
 */
export async function killChildren(children: Set<ChildLike>, options: { graceMs?: number; pollMs?: number } = {}): Promise<number> {
  const running = [...children];
  if (running.length === 0) return 0;
  for (const child of running) child.kill("SIGTERM");
  const until = Date.now() + (options.graceMs ?? 3_000);
  while (children.size > 0 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 100));
  for (const child of children) child.kill("SIGKILL");
  return running.length;
}

/** One `claude -p` call: system prompt in a 0600 temp file, the prompt on stdin, killed after its time-out. */
export async function runClaude(call: ClaudeCall, deps: ClaudeRunnerDeps): Promise<ClaudeOutcome> {
  const now = deps.now ?? (() => new Date());
  // Validated before anything is written: a bad budget or flag throws with no temp file left behind.
  buildClaudeArgs({ schema: call.schema, budgetUsd: call.budgetUsd, systemPromptFile: "<pending>" });
  const tempRoot = deps.tempDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "bgs-nightly-"));
  const systemFile = path.join(tempRoot, `system-${randomBytes(6).toString("hex")}.txt`);
  const args = buildClaudeArgs({ schema: call.schema, budgetUsd: call.budgetUsd, systemPromptFile: systemFile });
  const started = Date.now();
  const timeoutMs = call.timeoutMs ?? CLAUDE_DEFAULT_TIMEOUT_MS;
  let outcome: ClaudeOutcome;
  let exitCode: number | null = null;
  try {
    fs.writeFileSync(systemFile, call.system, { encoding: "utf8", mode: NIGHTLY_FILE_MODE, flag: "wx" });
    const finished = await new Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }>((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      const child = (deps.spawn ?? defaultSpawn)(deps.claudeBin ?? "claude", args, { cwd: deps.cwd, env: claudeChildEnv(deps.parentEnv) });
      deps.children?.add(child);
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        deps.children?.delete(child);
        clearTimeout(timer);
        clearTimeout(killer);
        clearTimeout(exitGrace);
        resolve({ stdout, stderr, code, timedOut });
      };
      let killer: ReturnType<typeof setTimeout> | undefined;
      let exitGrace: ReturnType<typeof setTimeout> | undefined;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      }, timeoutMs);
      child.stdout?.on("data", (chunk) => {
        if (stdout.length < MAX_STDOUT_BYTES) stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        if (stderr.length < 64 * 1024) stderr += chunk.toString();
      });
      child.on("error", (error) => {
        stderr += `\nspawn_error: ${error.message}`;
        finish(null);
      });
      child.on("close", (code) => finish(code));
      child.on("exit", (code) => {
        exitGrace = setTimeout(() => finish(code), deps.exitGraceMs ?? EXIT_GRACE_MS);
      });
      child.stdin?.on?.("error", () => undefined);
      child.stdin?.write(call.user);
      child.stdin?.end();
    });
    exitCode = finished.code;
    outcome = parseClaudeEnvelope(finished.stdout, finished.stderr, finished.code, {
      argv: args, cliVersion: deps.cliVersion, durationMs: Date.now() - started, timedOut: finished.timedOut,
    });
  } finally {
    fs.rmSync(systemFile, { force: true });
    if (!deps.tempDir) fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  if (deps.callsLog) {
    appendJsonl(deps.callsLog, {
      at: now().toISOString(),
      purpose: call.purpose,
      key: call.key,
      argv: loggableArgs(args),
      cliVersion: deps.cliVersion,
      outcome: outcome.kind,
      reason: outcome.kind === "success" ? null : outcome.reason,
      exitCode,
      models: outcome.proof?.models ?? [],
      opusOutputTokens: outcome.proof?.opusOutputTokens ?? 0,
      inputTokens: outcome.proof?.inputTokens ?? 0,
      outputTokens: outcome.proof?.outputTokens ?? 0,
      costUsd: outcome.proof?.costUsd ?? null,
      durationMs: Date.now() - started,
      budgetUsd: call.budgetUsd,
    });
  }
  return outcome;
}

/** `claude --version` under the same scrubbed environment (null when it cannot run). Called once per run. */
export function readClaudeCliVersion(options: { claudeBin?: string; parentEnv?: Record<string, string | undefined> } = {}): string | null {
  const result = spawnSync(options.claudeBin ?? "claude", ["--version"], {
    encoding: "utf8", env: claudeChildEnv(options.parentEnv), timeout: 20_000, stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() || null : null;
}
