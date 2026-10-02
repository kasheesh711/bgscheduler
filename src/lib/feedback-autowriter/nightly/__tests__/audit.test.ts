import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auditBundles, auditCacheFile, cachedAudit, planAudit, smokeCall, type AuditStageDeps } from "../audit";
import { AUDIT_VERSION, type AuditResult } from "../audit-schema";
import { NIGHTLY_CAPS } from "../caps";
import type { ClaudeCall, ClaudeOutcome } from "../claude-runner";
import { NightlyLedger } from "../ledger";
import { readJsonl } from "../paths";
import type { BundleFile } from "../steps";
import type { ClaudeProof } from "../types";
import { PIM_FIELDS, nightlyBundle, nightlyTarget } from "./nightly-fixtures";

const SID_A = "6a0000000000000000000a01";
const SID_B = "6a0000000000000000000a02";
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nightly-audit-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const PROOF: ClaudeProof = {
  argv: ["-p"], cliVersion: "2.1.287", models: ["claude-opus-5-5"], opusOutputTokens: 1200, inputTokens: 9000, outputTokens: 1200,
  costUsd: 0.41, durationMs: 60_000, effort: "max",
};

/** An audit that finds one major homework issue, quoting the synthetic post. */
function auditResult(patch: Partial<AuditResult> = {}): AuditResult {
  return {
    verdict: "accurate",
    claims: [],
    issues: [],
    omissions: [],
    homework: { feedbackStatesHomework: false, tutorSetHomework: "no", evidence: [] },
    names: { studentCalled: ["Pim"], otherPeopleNamed: [] },
    candidateReview: [],
    evidenceQuality: { transcript: "full", speakerLabels: "verified", summaryVsTranscript: "agrees", notes: [] },
    priorIssueReview: null,
    summaryLine: "No issues.",
    ...patch,
  };
}

function file(sid: string, patch: Partial<BundleFile> = {}): BundleFile {
  return {
    target: nightlyTarget({ wiseSessionId: sid, fieldsSha256: `${sid.slice(-4)}aaaaaaaa` }),
    bundle: nightlyBundle({ wiseSessionId: sid, hash: `${sid.slice(-4)}bbbbbbbbbbbbbbbb` }),
    prechecks: [],
    notes: [],
    status: { collectedAt: "", rowMeta: "read", iseb: "not_guided", detail: "fetched", soniox: "fetched", zoom: "none", retranscribe: "not_needed" },
    collectedAt: "",
    ...patch,
  };
}

function deps(run: (call: ClaudeCall) => Promise<ClaudeOutcome>, patch: Partial<AuditStageDeps> = {}) {
  const ledger = NightlyLedger.open(dir, "2026-10-02", { ...NIGHTLY_CAPS });
  const value: AuditStageDeps = {
    night: "2026-10-02",
    auditsDir: path.join(dir, "audits"),
    ledgerJsonl: path.join(dir, "ledger.jsonl"),
    ledger,
    run,
    concurrency: 2,
    perAuditUsd: 1.5,
    deadline: null,
    stopFiles: [path.join(dir, "STOP")],
    now: () => new Date("2026-10-02T19:30:00Z"),
    sleep: vi.fn(async () => undefined),
    home: dir,
    ...patch,
  };
  return { deps: value, ledger };
}

const success = (value: unknown = auditResult()): ClaudeOutcome => ({ kind: "success", value, proof: PROOF });

describe("auditBundles", () => {
  it("audits each class once with the pinned prompt, caches it, and logs metadata only", async () => {
    const run = vi.fn(async (call: ClaudeCall) => {
      expect(call).toMatchObject({ purpose: "audit", budgetUsd: 1.5 });
      expect(call.user).toContain("<feedback>");
      return success(auditResult({
        verdict: "major",
        issues: [{
          id: "i1", claimIds: [], field: "performance", quote: "She hesitated on the second word problem", mode: "M06", severity: "major",
          criticalCategory: null, rootStage: "writer", defense: "judge_list", mechanism: "Judgement not in the evidence.", evidence: [],
          minimalFix: { action: "delete_span", from: "She hesitated on the second word problem", to: null }, confidence: "medium",
        }],
        summaryLine: "1 issue: overstated judgement (major)",
      }));
    });
    const { deps: auditDeps, ledger } = deps(run);
    const result = await auditBundles(auditDeps, [file(SID_A), file(SID_B)]);
    expect(result).toMatchObject({ audited: 2, cached: 0, failed: 0, calls: 2, opusProven: 2, stop: null });
    expect(result.costUsd).toBeCloseTo(0.82);
    expect(ledger.used("opus_audit")).toEqual({ count: 2, usd: 0.82 });
    const cache = auditCacheFile(auditDeps.auditsDir, { wiseSessionId: SID_A, fieldsSha256: "0a01aaaaaaaa", bundleHash: "0a01bbbbbbbbbbbbbbbb" });
    expect(path.basename(cache)).toBe(`0a01aaaaaaaa.a${AUDIT_VERSION}.0a01bbbbbbbb.json`);
    expect(fs.statSync(cache).mode & 0o777).toBe(0o600);
    const lines = readJsonl<Record<string, unknown>>(auditDeps.ledgerJsonl);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      type: "audit", verdict: "major", outcome: "success", issues: [{ mode: "M06", severity: "major", confidence: "medium", rootStage: "writer", defense: "judge_list" }],
      models: ["claude-opus-5-5"], costUsd: 0.41,
    });
    // No feedback or lesson text in the metadata ledger.
    expect(JSON.stringify(lines)).not.toMatch(/hesitated|word problem|Pim/u);

    // A second stage reuses the cache: no call.
    const again = await auditBundles(auditDeps, [file(SID_A), file(SID_B)]);
    expect(again).toMatchObject({ audited: 0, cached: 2, calls: 0 });
    expect(run).toHaveBeenCalledTimes(2);
    expect(cachedAudit(auditDeps.auditsDir, file(SID_A))?.result?.verdict).toBe("major");
    // New evidence (another bundle hash) is a new audit.
    expect(cachedAudit(auditDeps.auditsDir, file(SID_A, { bundle: nightlyBundle({ wiseSessionId: SID_A, hash: "ffffffffffffffffffff" }) }))).toBeNull();
  });

  it("retries an unparseable answer once after 30 s, then records the failure", async () => {
    const run = vi.fn(async (): Promise<ClaudeOutcome> => success({ not: "an audit" }));
    const { deps: auditDeps, ledger } = deps(run, { concurrency: 1 });
    const result = await auditBundles(auditDeps, [file(SID_A)]);
    expect(run).toHaveBeenCalledTimes(2);
    expect(auditDeps.sleep).toHaveBeenCalledWith(30_000);
    expect(result).toMatchObject({ audited: 0, failed: 1 });
    expect(result.records[0].failure).toMatch(/^invalid:schema/u);
    expect(ledger.attempts(`audit:6a0000000000000000000a01:0a01aaaaaaaa:a${AUDIT_VERSION}`)).toMatchObject({ total: 2, failed: 2 });
    // Failed twice: never tried again at this version.
    run.mockClear();
    expect(await auditBundles(auditDeps, [file(SID_A)])).toMatchObject({ skipped: [{ wiseSessionId: SID_A, reason: "failed_twice" }], calls: 0 });
    expect(run).not.toHaveBeenCalled();
  });

  it("does not retry a budget or time-out failure, and stops after two failures in a row", async () => {
    const run = vi.fn(async (): Promise<ClaudeOutcome> => ({ kind: "budget_exceeded", reason: "max_budget_usd", proof: { ...PROOF, costUsd: 1.5 } }));
    const { deps: auditDeps } = deps(run, { concurrency: 1 });
    const result = await auditBundles(auditDeps, [file(SID_A), file(SID_B), file("6a0000000000000000000a03")]);
    expect(run).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ failed: 2, stop: { reason: "claude_errors", exitCode: 4 } });
  });

  it("stops the stage on a usage limit or an auth failure", async () => {
    const run = vi.fn(async (): Promise<ClaudeOutcome> => ({ kind: "usage_limited", reason: "usage_limited_429", proof: null }));
    const { deps: auditDeps } = deps(run, { concurrency: 1 });
    const result = await auditBundles(auditDeps, [file(SID_A), file(SID_B)]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.stop).toMatchObject({ reason: "usage_limited", exitCode: 4 });
  });

  it("refuses to start a call over a cap, and writes STOP when a call breached one", async () => {
    const capped = NightlyLedger.open(path.join(dir, "capped"), "2026-10-02", { ...NIGHTLY_CAPS, maxClaudeUsdNight: 1 });
    const run = vi.fn(async () => success());
    const { deps: auditDeps } = deps(run, { ledger: capped });
    expect(await auditBundles(auditDeps, [file(SID_A)])).toMatchObject({ calls: 0, stop: { reason: "cap:claude_usd_night", exitCode: 3 } });
    expect(run).not.toHaveBeenCalled();

    const tight = NightlyLedger.open(path.join(dir, "tight"), "2026-10-02", { ...NIGHTLY_CAPS, maxClaudeUsdNight: 1.6 });
    const pricey = vi.fn(async (): Promise<ClaudeOutcome> => ({ kind: "success", value: auditResult(), proof: { ...PROOF, costUsd: 1.9 } }));
    const breach = await auditBundles({ ...auditDeps, ledger: tight, run: pricey }, [file(SID_A), file(SID_B)]);
    expect(breach.stop).toMatchObject({ reason: "breach:claude_usd_night", exitCode: 10 });
    expect(fs.readFileSync(path.join(dir, ".bgscheduler-nightly", "STOP"), "utf8")).toMatch(/claude_usd_night/u);
  });

  it("stops before a call when a STOP file appears or the deadline passed", async () => {
    const run = vi.fn(async () => success());
    fs.writeFileSync(path.join(dir, "STOP"), "");
    const { deps: auditDeps } = deps(run);
    expect(await auditBundles(auditDeps, [file(SID_A)])).toMatchObject({ calls: 0, stop: { reason: "stop_file" } });
    fs.rmSync(path.join(dir, "STOP"));
    expect(await auditBundles({ ...auditDeps, deadline: new Date("2026-10-02T19:00:00Z") }, [file(SID_A)])).toMatchObject({ stop: { reason: "deadline" } });
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects an audit whose quotes are not in the post (fail closed, kept as an issue without a fix)", async () => {
    const run = vi.fn(async () => success(auditResult({
      verdict: "cosmetic",
      issues: [{
        id: "i1", claimIds: [], field: "topics", quote: "words that are not in the post", mode: "M17", severity: "cosmetic",
        criticalCategory: null, rootStage: "writer", defense: "none", mechanism: "x", evidence: [],
        minimalFix: { action: "delete_span", from: "words that are not in the post", to: null }, confidence: "low",
      }],
    })));
    const { deps: auditDeps } = deps(run);
    const result = await auditBundles(auditDeps, [file(SID_A)]);
    const checked = result.records[0].result as unknown as { postCheck: { quoteMismatchIssues: string[] }; issues: Array<{ minimalFix: unknown }> };
    expect(checked.postCheck.quoteMismatchIssues).toEqual(["i1"]);
    expect(checked.issues[0].minimalFix).toBeNull();
  });
});

describe("planAudit and the smoke call", () => {
  it("estimates without spawning anything", async () => {
    const run = vi.fn(async () => success());
    const { deps: auditDeps } = deps(run);
    await auditBundles(auditDeps, [file(SID_A)]);
    expect(planAudit(auditDeps, [file(SID_A), file(SID_B)])).toEqual({ toAudit: 1, cached: 1, failedTwice: 0, maxUsd: 3 });
  });

  it("makes the smoke call tiny and cheap", () => {
    expect(smokeCall("smoke:1")).toMatchObject({ purpose: "smoke", key: "smoke:1", budgetUsd: 0.5 });
    expect(PIM_FIELDS.topics.length).toBeGreaterThan(0);
  });
});
