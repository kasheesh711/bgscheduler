import { createHash } from "node:crypto";
import path from "node:path";
import { AUDIT_PROMPT_VERSION, buildAuditPrompt, evidenceTextOf } from "./audit-prompt";
import { AUDIT_JSON_SCHEMA, AUDIT_VERSION, parseAuditResult, type CheckedAuditResult } from "./audit-schema";
import { stopFilePresent, writeStopFile } from "./caps";
import { ledgerOutcome, type ClaudeCall, type ClaudeOutcome } from "./claude-runner";
import { EXIT, NightlyStop } from "./exit";
import type { NightlyLedger } from "./ledger";
import { appendJsonl, readJsonFile, writeJsonAtomic } from "./paths";
import { auditKey } from "./select";
import type { BundleFile } from "./steps";
import type { AuditRecord, EvidenceGrade } from "./types";

/**
 * One Opus 5.5 max audit per posted text: cached per class, text hash, audit version and evidence hash
 * (`audits/<sid>/<fieldsSha256>.a<AUDIT_VERSION>.<bundleHash12>.json`, 0600), reserved in the spend ledger before the
 * call, validated by `parseAuditResult` (zod + fail-closed post-checks). One retry after 30 s, for an invalid or
 * unparseable answer or a CLI error only; a budget, time-out or auth failure is not retried; a usage limit or auth
 * failure ends the stage, and so do two failures in a row. A key whose answers were invalid or unparseable twice is never
 * tried again until AUDIT_VERSION changes; infrastructure failures (`infra:*`) never count toward that.
 * Every audit (and failure) is appended to the metadata-only `ledger.jsonl`: ids, hashes, modes, verdicts, cost.
 */

export const AUDIT_RETRY_DELAY_MS = 30_000;
export const AUDIT_TIMEOUT_MS = 20 * 60 * 1000;

export interface AuditStageDeps {
  night: string;
  auditsDir: string;
  /** Metadata-only audit ledger (`ledger.jsonl`). */
  ledgerJsonl: string;
  ledger: Pick<NightlyLedger, "reserve" | "settle" | "attempts">;
  run: (call: ClaudeCall) => Promise<ClaudeOutcome>;
  concurrency: number;
  perAuditUsd: number;
  deadline: Date | null;
  stopFiles: readonly string[];
  now: () => Date;
  sleep?: (ms: number) => Promise<void>;
  retryDelayMs?: number;
  timeoutMs?: number;
  /** Home override for the STOP file written on a breach (tests). */
  home?: string;
  log?: (line: string) => void;
}

export interface AuditStageResult {
  /** This stage's audits: cached and new successes, and final failures (result null). */
  records: AuditRecord[];
  audited: number;
  cached: number;
  failed: number;
  skipped: Array<{ wiseSessionId: string; reason: string }>;
  stop: NightlyStop | null;
  calls: number;
  /** Calls whose answer carried proof of Opus 5.5 (every success does). */
  opusProven: number;
  costUsd: number;
}

function safeHashPart(value: string): string {
  return /^[0-9a-f]{8,128}$/iu.test(value) ? value : createHash("sha256").update(value).digest("hex");
}

/** Where a class's audit of one text, audit version and evidence is cached. */
export function auditCacheFile(auditsDir: string, input: { wiseSessionId: string; fieldsSha256: string; bundleHash: string; auditVersion?: number }): string {
  if (!/^[0-9a-f]{24}$/iu.test(input.wiseSessionId)) throw new Error("Not a Wise session id");
  return path.join(auditsDir, input.wiseSessionId,
    `${safeHashPart(input.fieldsSha256)}.a${input.auditVersion ?? AUDIT_VERSION}.${safeHashPart(input.bundleHash).slice(0, 12)}.json`);
}

/** The cached audit of a bundle, when it succeeded. */
export function cachedAudit(auditsDir: string, file: BundleFile): AuditRecord | null {
  const record = readJsonFile<AuditRecord>(auditCacheFile(auditsDir, {
    wiseSessionId: file.target.wiseSessionId, fieldsSha256: file.target.fieldsSha256, bundleHash: file.bundle.hash,
  }));
  return record?.result ? record : null;
}

/** The metadata line for `ledger.jsonl` (no text: modes, severities, verdict, cost). */
export function auditLedgerLine(night: string, record: AuditRecord, extra: { costUsd: number | null; outcome: string; improvable?: boolean }): Record<string, unknown> {
  return {
    type: "audit",
    night,
    at: record.at,
    key: auditKey({ wiseSessionId: record.wiseSessionId, fieldsSha256: record.fieldsSha256, auditVersion: record.auditVersion }),
    wiseSessionId: record.wiseSessionId,
    fieldsSha256: record.fieldsSha256,
    auditVersion: record.auditVersion,
    promptVersion: record.promptVersion,
    bundleHash: record.bundleHash,
    grade: record.grade,
    verdict: record.result?.verdict ?? null,
    // insufficient_evidence is not final while the evidence may still improve: such a class is not "audited" yet.
    final: !(record.result?.verdict === "insufficient_evidence" && extra.improvable === true),
    failure: record.failure,
    outcome: extra.outcome,
    issues: (record.result?.issues ?? []).map((issue) => ({
      mode: issue.mode, severity: issue.severity, confidence: issue.confidence, rootStage: issue.rootStage, defense: issue.defense,
    })),
    omissions: (record.result?.omissions ?? []).map((omission) => ({ what: omission.what, severity: omission.severity })),
    costUsd: extra.costUsd,
    models: record.proof?.models ?? [],
    opusOutputTokens: record.proof?.opusOutputTokens ?? 0,
  };
}

async function mapLimited<T>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<void>, stopped: () => boolean): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      if (stopped()) return;
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  });
  await Promise.all(lanes);
}

/** Audit every bundle not audited yet; see the module comment for the retry and stop rules. */
export async function auditBundles(deps: AuditStageDeps, files: readonly BundleFile[]): Promise<AuditStageResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const out: AuditStageResult = {
    records: [], audited: 0, cached: 0, failed: 0, skipped: [], stop: null, calls: 0, opusProven: 0, costUsd: 0,
  };
  let failuresInARow = 0;
  // The first stop ends the stage; a breach (a cap passed after the fact) outranks any other reason.
  const stopStage = (stop: NightlyStop) => {
    if (!out.stop || (stop.exitCode === EXIT.safety && out.stop.exitCode !== EXIT.safety)) out.stop = stop;
  };
  const checkStops = (): NightlyStop | null => {
    if (stopFilePresent(deps.stopFiles)) return new NightlyStop("stop_file", EXIT.stopped);
    if (deps.deadline && deps.now().getTime() >= deps.deadline.getTime()) return new NightlyStop("deadline", EXIT.stopped);
    return null;
  };

  await mapLimited(files, deps.concurrency, async (file) => {
    const sid = file.target.wiseSessionId;
    const key = auditKey({ wiseSessionId: sid, fieldsSha256: file.target.fieldsSha256, auditVersion: AUDIT_VERSION });
    // Never audited: a class whose collection failed transiently (a later collect completes it), or with no evidence.
    if (file.transient && file.transient.length > 0) {
      out.skipped.push({ wiseSessionId: sid, reason: "collection_incomplete" });
      return;
    }
    if (file.bundle.grade === "none") {
      out.skipped.push({ wiseSessionId: sid, reason: "no_evidence" });
      return;
    }
    const cached = cachedAudit(deps.auditsDir, file);
    if (cached) {
      out.records.push(cached);
      out.cached += 1;
      return;
    }
    if (deps.ledger.attempts(key).failed >= 2) {
      out.skipped.push({ wiseSessionId: sid, reason: "failed_twice" });
      return;
    }
    const prompt = buildAuditPrompt({ bundle: file.bundle, prechecks: file.prechecks });
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const stop = checkStops();
      if (stop) {
        stopStage(stop);
        return;
      }
      if (out.stop) return;
      const reserved = deps.ledger.reserve("opus_audit", { key, estimateUsd: deps.perAuditUsd });
      if (!reserved.ok) {
        stopStage(new NightlyStop(reserved.reason, EXIT.caps));
        return;
      }
      out.calls += 1;
      const outcome = await deps.run({
        purpose: "audit", key, system: prompt.system, user: prompt.user, schema: AUDIT_JSON_SCHEMA,
        budgetUsd: deps.perAuditUsd, timeoutMs: deps.timeoutMs ?? AUDIT_TIMEOUT_MS,
      });
      let result: CheckedAuditResult | null = null;
      let failure: string | null = null;
      if (outcome.kind === "success") {
        out.opusProven += 1;
        const checked = parseAuditResult(outcome.value, {
          postFields: file.bundle.postedFields, evidenceText: evidenceTextOf(file.bundle), grade: file.bundle.grade,
        });
        if (checked.ok) result = weakEvidenceVerdict(checked.result, file.bundle.grade);
        else failure = `invalid:${checked.reason}`.slice(0, 300);
      } else {
        failure = `${outcome.kind}:${outcome.reason}`.slice(0, 300);
      }
      // Only an invalid or unparseable answer counts toward failed_twice; infrastructure failures settle as infra:*.
      const settledOutcome = ledgerOutcome(outcome.kind, result !== null);
      const costUsd = outcome.proof?.costUsd ?? null;
      out.costUsd += costUsd ?? 0;
      const { breached } = deps.ledger.settle(reserved.id, { actualUsd: costUsd, outcome: settledOutcome });
      if (breached.length > 0) {
        writeStopFile(`nightly audit breached ${breached.join(", ")}`, deps.home, deps.now());
        stopStage(new NightlyStop(`breach:${breached.join(",")}`, EXIT.safety));
      }
      const record: AuditRecord = {
        wiseSessionId: sid,
        fieldsSha256: file.target.fieldsSha256,
        auditVersion: AUDIT_VERSION,
        promptVersion: AUDIT_PROMPT_VERSION,
        bundleHash: file.bundle.hash,
        grade: file.bundle.grade,
        result,
        failure,
        proof: outcome.proof,
        at: deps.now().toISOString(),
      };
      if (result) {
        writeJsonAtomic(auditCacheFile(deps.auditsDir, { wiseSessionId: sid, fieldsSha256: file.target.fieldsSha256, bundleHash: file.bundle.hash }), record);
        appendJsonl(deps.ledgerJsonl, auditLedgerLine(deps.night, record, { costUsd, outcome: settledOutcome, improvable: file.improvable }));
        out.records.push(record);
        out.audited += 1;
        failuresInARow = 0;
        deps.log?.(`audit ${sid}: ${result.verdict} (${result.issues.length} issue(s), $${(costUsd ?? 0).toFixed(3)})`);
        return;
      }
      deps.log?.(`audit ${sid}: attempt ${attempt} failed (${failure})`);
      if (outcome.kind === "usage_limited" || outcome.kind === "auth") {
        appendJsonl(deps.ledgerJsonl, auditLedgerLine(deps.night, record, { costUsd, outcome: settledOutcome, improvable: file.improvable }));
        out.records.push(record);
        out.failed += 1;
        stopStage(new NightlyStop(outcome.kind, EXIT.model));
        return;
      }
      const retryable = settledOutcome === "invalid" || settledOutcome === "unparseable" || outcome.kind === "cli_error";
      if (retryable && attempt === 1 && !out.stop) {
        await sleep(deps.retryDelayMs ?? AUDIT_RETRY_DELAY_MS);
        continue;
      }
      appendJsonl(deps.ledgerJsonl, auditLedgerLine(deps.night, record, { costUsd, outcome: settledOutcome, improvable: file.improvable }));
      out.records.push(record);
      out.failed += 1;
      failuresInARow += 1;
      if (failuresInARow >= 2) stopStage(new NightlyStop("claude_errors", EXIT.model));
      return;
    }
  }, () => out.stop !== null);
  return out;
}

/**
 * An "accurate" verdict that checked no claim against only secondary evidence (Wise's summary or Zoom's captions for a
 * transcript post) or none proves nothing: it is insufficient evidence.
 */
export function weakEvidenceVerdict(result: CheckedAuditResult, grade: EvidenceGrade): CheckedAuditResult {
  if (result.verdict !== "accurate" || result.claims.length > 0 || (grade !== "secondary_only" && grade !== "none")) return result;
  return {
    ...result,
    verdict: "insufficient_evidence",
    evidenceQuality: { ...result.evidenceQuality, notes: [...result.evidenceQuality.notes, "no claim checked on weak evidence"].slice(-5) },
  };
}

/** What auditing the bundles would cost at most, without spawning anything (`audit --plan`). */
export function planAudit(deps: Pick<AuditStageDeps, "auditsDir" | "ledger" | "perAuditUsd">, files: readonly BundleFile[]): {
  toAudit: number;
  cached: number;
  failedTwice: number;
  maxUsd: number;
} {
  let toAudit = 0;
  let cached = 0;
  let failedTwice = 0;
  for (const file of files) {
    if ((file.transient && file.transient.length > 0) || file.bundle.grade === "none") continue;
    if (cachedAudit(deps.auditsDir, file)) cached += 1;
    else if (deps.ledger.attempts(auditKey({ wiseSessionId: file.target.wiseSessionId, fieldsSha256: file.target.fieldsSha256, auditVersion: AUDIT_VERSION })).failed >= 2) failedTwice += 1;
    else toAudit += 1;
  }
  // Each audit may be retried once.
  return { toAudit, cached, failedTwice, maxUsd: Math.round(toAudit * 2 * deps.perAuditUsd * 100) / 100 };
}

/** The smoke call: one tiny synthetic prompt that proves the model, the effort and the subscription login. */
export const SMOKE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "word"],
  properties: { ok: { type: "boolean" }, word: { type: "string" } },
} as const;

export function smokeCall(key: string): ClaudeCall {
  return {
    purpose: "smoke",
    key,
    system: "You are a connectivity check. Reply only with the JSON object the schema asks for.",
    user: "Set ok to true and word to \"pong\".",
    schema: SMOKE_SCHEMA as unknown as Record<string, unknown>,
    budgetUsd: 0.5,
    timeoutMs: 5 * 60 * 1000,
  };
}
