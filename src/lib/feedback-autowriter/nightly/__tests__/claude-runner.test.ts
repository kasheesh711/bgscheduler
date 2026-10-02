import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_ENV_ALLOWLIST,
  assertSafeClaudeArgs,
  buildClaudeArgs,
  claudeChildEnv,
  claudeVersionSupported,
  killChildren,
  parseClaudeEnvelope,
  runClaude,
  type ChildLike,
  type SpawnLike,
} from "../claude-runner";
import { readJsonl } from "../paths";

const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
const CONTEXT = { argv: ["-p"], cliVersion: "2.1.287 (Claude Code)", durationMs: 1_000 };

function envelope(patch: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    terminal_reason: "completed",
    stop_reason: "tool_use",
    num_turns: 2,
    duration_ms: 42_000,
    total_cost_usd: 0.4312,
    structured_output: { ok: true },
    usage: { input_tokens: 10, cache_creation_input_tokens: 5000, cache_read_input_tokens: 0, output_tokens: 900 },
    modelUsage: {
      "claude-opus-5-5": {
        inputTokens: 10, outputTokens: 900, cacheReadInputTokens: 0, cacheCreationInputTokens: 5000, costUSD: 0.4312,
        thinkingTokens: 700, canonicalModel: "claude-opus-5-5", provider: "firstParty", costBasis: "list",
      },
    },
    ...patch,
  });
}

describe("claude argv and environment", () => {
  it("pins Opus 5.5 at max effort, no tools, safe mode, budget, schema and the system prompt file", () => {
    expect(buildClaudeArgs({ schema: SCHEMA, budgetUsd: 1.5, systemPromptFile: "/tmp/system.txt" })).toEqual([
      "-p", "--model", "claude-opus-5-5", "--effort", "max", "--tools", "", "--output-format", "json",
      "--json-schema", JSON.stringify(SCHEMA), "--max-budget-usd", "1.5", "--no-session-persistence",
      "--permission-prompts", "none", "--strict-mcp-config", "--safe-mode", "--system-prompt-file", "/tmp/system.txt",
    ]);
    expect(() => buildClaudeArgs({ schema: SCHEMA, budgetUsd: 0, systemPromptFile: "/tmp/x" })).toThrow(/budget/u);
  });

  it("never allows --bare, a fallback model, another model or effort", () => {
    const args = buildClaudeArgs({ schema: SCHEMA, budgetUsd: 1, systemPromptFile: "/tmp/x" });
    expect(args).not.toContain("--bare");
    expect(args).not.toContain("--fallback-model");
    expect(() => assertSafeClaudeArgs([...args, "--bare"])).toThrow(/Forbidden/u);
    expect(() => assertSafeClaudeArgs([...args, "--fallback-model", "sonnet"])).toThrow(/Forbidden/u);
    expect(() => assertSafeClaudeArgs(args.map((arg) => (arg === "claude-opus-5-5" ? "sonnet" : arg)))).toThrow(/Opus 5.5/u);
    expect(() => assertSafeClaudeArgs(args.map((arg) => (arg === "max" ? "high" : arg)))).toThrow(/max effort/u);
    expect(() => assertSafeClaudeArgs(args.filter((arg) => arg !== "--safe-mode"))).toThrow(/--safe-mode/u);
  });

  it("accepts only a claude CLI 2.1.x or later", () => {
    expect(claudeVersionSupported("2.1.287 (Claude Code)")).toBe(true);
    expect(claudeVersionSupported("2.1.0")).toBe(true);
    expect(claudeVersionSupported("2.2.1 (Claude Code)")).toBe(true);
    expect(claudeVersionSupported("3.0.0")).toBe(true);
    expect(claudeVersionSupported("2.0.99 (Claude Code)")).toBe(false);
    expect(claudeVersionSupported("1.9.0")).toBe(false);
    expect(claudeVersionSupported("")).toBe(false);
    expect(claudeVersionSupported(null)).toBe(false);
  });

  it("passes the child only an allowlisted environment: no API key, no secrets, no nested-session markers", () => {
    const env = claudeChildEnv({
      HOME: "/Users/someone", PATH: "/usr/bin", USER: "someone", LOGNAME: "someone", SHELL: "/bin/zsh", LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8", TMPDIR: "/tmp/", TERM: "xterm",
      ANTHROPIC_API_KEY: "sk-ant-secret", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SSE_PORT: "1",
      DATABASE_URL: "postgres://secret", WISE_API_KEY: "w", WISE_USER_ID: "u", OPENROUTER_API_KEY: "o", SONIOX_API_KEY: "s",
      NODE_OPTIONS: "--inspect",
    });
    expect(Object.keys(env).sort()).toEqual([...CLAUDE_ENV_ALLOWLIST].sort());
    expect(JSON.stringify(env)).not.toMatch(/secret|sk-ant/u);
  });
});

describe("parseClaudeEnvelope", () => {
  it("reads structured output and proves Opus 5.5 from modelUsage", () => {
    const outcome = parseClaudeEnvelope(envelope(), "", 0, CONTEXT);
    expect(outcome).toEqual({
      kind: "success",
      value: { ok: true },
      proof: {
        argv: ["-p"], cliVersion: "2.1.287 (Claude Code)", models: ["claude-opus-5-5"], opusOutputTokens: 900,
        inputTokens: 5010, outputTokens: 900, costUsd: 0.4312, durationMs: 42_000, effort: "max",
      },
    });
  });

  it("falls back to the result text (code fences stripped) only when there is no structured output", () => {
    const outcome = parseClaudeEnvelope(envelope({ structured_output: undefined, result: "```json\n{\"ok\":false}\n```" }), "", 0, CONTEXT);
    expect(outcome).toMatchObject({ kind: "success", value: { ok: false } });
    expect(parseClaudeEnvelope(envelope({ structured_output: undefined, result: "not json" }), "", 0, CONTEXT)).toMatchObject({ kind: "unparseable" });
  });

  it("fails closed without Opus 5.5 usage, with another model's output, or a runaway answer", () => {
    expect(parseClaudeEnvelope(envelope({ modelUsage: {} }), "", 0, CONTEXT)).toMatchObject({ kind: "cli_error", reason: "model_proof:no_opus_usage" });
    expect(parseClaudeEnvelope(envelope({ modelUsage: { "claude-sonnet-5-5": { outputTokens: 2_000 } } }), "", 0, CONTEXT))
      .toMatchObject({ kind: "usage_limited", reason: "model_fallback:claude-sonnet-5-5" });
    expect(parseClaudeEnvelope(envelope({
      modelUsage: { "claude-opus-5-5": { outputTokens: 900 }, "claude-haiku-4-5": { outputTokens: 501 } },
    }), "", 0, CONTEXT)).toMatchObject({ kind: "cli_error", reason: "model_proof:other_model_output:claude-haiku-4-5" });
    expect(parseClaudeEnvelope(envelope({
      modelUsage: { "claude-opus-5-5": { outputTokens: 900 }, "claude-haiku-4-5": { outputTokens: 120 } },
    }), "", 0, CONTEXT)).toMatchObject({ kind: "success" });
    expect(parseClaudeEnvelope(envelope({ modelUsage: { "claude-opus-5-5": { outputTokens: 60_001 } } }), "", 0, CONTEXT))
      .toMatchObject({ kind: "cli_error", reason: "oversized_output" });
    // A dated or canonical alias of the same model still proves it.
    expect(parseClaudeEnvelope(envelope({ modelUsage: { "opus-alias": { outputTokens: 10, canonicalModel: "claude-opus-5-5" } } }), "", 0, CONTEXT))
      .toMatchObject({ kind: "success" });
  });

  it("classifies budget, usage limits, auth, schema retries and CLI errors", () => {
    expect(parseClaudeEnvelope(envelope({ subtype: "error_max_budget_usd", is_error: true }), "", 1, CONTEXT)).toMatchObject({ kind: "budget_exceeded" });
    expect(parseClaudeEnvelope(envelope({ is_error: true, api_error_status: 429, result: "API Error" }), "", 1, CONTEXT)).toMatchObject({ kind: "usage_limited" });
    expect(parseClaudeEnvelope(envelope({ is_error: true, result: "You've hit your limit · resets 5am" }), "", 1, CONTEXT)).toMatchObject({ kind: "usage_limited" });
    expect(parseClaudeEnvelope(envelope({ is_error: true, result: "Invalid API key · Please run /login" }), "", 1, CONTEXT)).toMatchObject({ kind: "auth" });
    expect(parseClaudeEnvelope(envelope({ is_error: true, api_error_status: 401 }), "", 1, CONTEXT)).toMatchObject({ kind: "auth" });
    expect(parseClaudeEnvelope(envelope({ subtype: "error_max_structured_output_retries", is_error: true }), "", 1, CONTEXT)).toMatchObject({ kind: "unparseable" });
    expect(parseClaudeEnvelope(envelope({ subtype: "error_during_execution", is_error: true }), "", 1, CONTEXT)).toMatchObject({ kind: "cli_error", reason: "error_during_execution" });
    expect(parseClaudeEnvelope("", "Error: Not logged in", 1, CONTEXT)).toMatchObject({ kind: "auth" });
    expect(parseClaudeEnvelope("", "boom", 1, CONTEXT)).toMatchObject({ kind: "cli_error", reason: "exit_1" });
    expect(parseClaudeEnvelope("", "", 0, CONTEXT)).toMatchObject({ kind: "unparseable" });
    expect(parseClaudeEnvelope(envelope(), "", null, { ...CONTEXT, timedOut: true })).toMatchObject({ kind: "timeout" });
    expect(parseClaudeEnvelope(`warning: something\n${envelope()}`, "", 0, CONTEXT)).toMatchObject({ kind: "success" });
  });
});

describe("runClaude", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nightly-claude-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function fakeSpawn(behaviour: (input: { args: readonly string[]; stdin: string; child: FakeChild }) => void): { spawn: SpawnLike; calls: Array<{ command: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv; stdin: string; system: string | null }> } {
    const calls: Array<{ command: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv; stdin: string; system: string | null }> = [];
    const spawn: SpawnLike = (command, args, options) => {
      const child = new FakeChild();
      const systemFile = args[args.indexOf("--system-prompt-file") + 1];
      const call = { command, args, cwd: options.cwd, env: options.env, stdin: "", system: fs.existsSync(systemFile) ? fs.readFileSync(systemFile, "utf8") : null };
      calls.push(call);
      child.onEnd = (stdin) => {
        call.stdin = stdin;
        behaviour({ args, stdin, child });
      };
      return child;
    };
    return { spawn, calls };
  }

  class FakeChild extends EventEmitter implements ChildLike {
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    killed: string[] = [];
    onEnd: (stdin: string) => void = () => undefined;
    private buffer = "";
    stdin = {
      write: (data: string) => {
        this.buffer += data;
        return true;
      },
      end: () => {
        setImmediate(() => this.onEnd(this.buffer));
        return this;
      },
    };
    kill(signal?: NodeJS.Signals): boolean {
      this.killed.push(signal ?? "SIGTERM");
      setImmediate(() => this.emit("close", null, signal ?? "SIGTERM"));
      return true;
    }
    finish(stdout: string, code = 0) {
      this.stdout.emit("data", Buffer.from(stdout));
      this.emit("close", code, null);
    }
  }

  it("sends the prompt on stdin, the system prompt in a 0600 file it deletes afterwards, and logs no prompt", async () => {
    const { spawn, calls } = fakeSpawn(({ child }) => child.finish(envelope()));
    const log = path.join(dir, "night", "claude-calls.jsonl");
    const outcome = await runClaude({
      purpose: "audit", key: "audit:x:sha:a1", system: "SYSTEM RUBRIC", user: "USER PROMPT WITH LESSON TEXT", schema: SCHEMA, budgetUsd: 1.5,
    }, { cwd: dir, cliVersion: "2.1.287", callsLog: log, spawn, parentEnv: { HOME: "/h", PATH: "/p", ANTHROPIC_API_KEY: "k" } });
    expect(outcome.kind).toBe("success");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ command: "claude", cwd: dir, stdin: "USER PROMPT WITH LESSON TEXT", system: "SYSTEM RUBRIC" });
    expect(calls[0].env).toEqual({ HOME: "/h", PATH: "/p" });
    const systemFile = calls[0].args[calls[0].args.indexOf("--system-prompt-file") + 1];
    expect(fs.existsSync(systemFile)).toBe(false);
    const lines = readJsonl<Record<string, unknown>>(log);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ purpose: "audit", key: "audit:x:sha:a1", outcome: "success", models: ["claude-opus-5-5"], costUsd: 0.4312, cliVersion: "2.1.287" });
    expect(JSON.stringify(lines[0])).not.toMatch(/USER PROMPT|SYSTEM RUBRIC/u);
    expect(String((lines[0].argv as string[])[(lines[0].argv as string[]).indexOf("--json-schema") + 1])).toMatch(/^<json-schema sha256:/u);
  });

  it("kills a call that runs past its time-out", async () => {
    let child: FakeChild | null = null;
    const { spawn } = fakeSpawn(({ child: spawned }) => {
      child = spawned;
    });
    const outcome = await runClaude({ purpose: "audit", key: "k", system: "s", user: "u", schema: SCHEMA, budgetUsd: 1, timeoutMs: 20 }, {
      cwd: dir, cliVersion: null, callsLog: null, spawn,
    });
    expect(outcome).toMatchObject({ kind: "timeout" });
    expect(child!.killed).toContain("SIGTERM");
  });

  it("settles a call whose process exited even when its pipes never close", async () => {
    const { spawn } = fakeSpawn(({ child }) => {
      child.stdout.emit("data", Buffer.from(envelope()));
      // A grandchild keeps stdout open: "exit" but never "close".
      child.emit("exit", 0, null);
    });
    const outcome = await runClaude({ purpose: "audit", key: "k", system: "s", user: "u", schema: SCHEMA, budgetUsd: 1 }, {
      cwd: dir, cliVersion: null, callsLog: null, spawn, exitGraceMs: 20,
    });
    expect(outcome.kind).toBe("success");
  });

  it("tracks running calls so a signal handler can kill them: SIGTERM, then SIGKILL after the grace", async () => {
    const children = new Set<ChildLike>();
    let running: FakeChild | null = null;
    const { spawn } = fakeSpawn(({ child }) => {
      running = child;
    });
    const call = runClaude({ purpose: "audit", key: "k", system: "s", user: "u", schema: SCHEMA, budgetUsd: 1 }, {
      cwd: dir, cliVersion: null, callsLog: null, spawn, children,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(children.size).toBe(1);
    // A child that dies on SIGTERM leaves the set at once.
    expect(await killChildren(children, { graceMs: 1_000, pollMs: 5 })).toBe(1);
    expect(running!.killed).toEqual(["SIGTERM"]);
    expect(await call).toMatchObject({ kind: "cli_error" });
    expect(children.size).toBe(0);
    // One that ignores SIGTERM gets SIGKILL.
    const stubborn = { kill: vi.fn(() => true) } as unknown as ChildLike;
    const set = new Set<ChildLike>([stubborn]);
    expect(await killChildren(set, { graceMs: 20, pollMs: 5 })).toBe(1);
    expect(vi.mocked(stubborn.kill).mock.calls.map((args) => args[0])).toEqual(["SIGTERM", "SIGKILL"]);
    expect(await killChildren(new Set())).toBe(0);
  });

  it("reports a failed spawn as a CLI error", async () => {
    const spawn: SpawnLike = () => {
      const child = new FakeChild();
      setImmediate(() => child.emit("error", new Error("ENOENT claude")));
      return child;
    };
    expect(await runClaude({ purpose: "smoke", key: "k", system: "s", user: "u", schema: SCHEMA, budgetUsd: 1 }, { cwd: dir, cliVersion: null, callsLog: null, spawn }))
      .toMatchObject({ kind: "cli_error" });
  });
});
