import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedbackFieldAnswers } from "@/lib/post-class-feedback/types";
import { AUTOWRITER_MODELS } from "../../config";
import type { OpenRouterCallResult } from "../../openrouter";
import type { ReplayRecord } from "../../replay";
import { fieldsHash } from "../../submit";
import { auditCacheFile } from "../audit";
import { AUDIT_VERSION, type AuditIssue, type AuditResult } from "../audit-schema";
import { NIGHTLY_CAPS, type NightlyCaps } from "../caps";
import type { ClaudeCall, ClaudeOutcome } from "../claude-runner";
import { judgeCandidate, type JudgeCandidateResult } from "../judge-candidate";
import { NightlyLedger } from "../ledger";
import { nightlyPaths, readJsonFile, readJsonl, writeJsonAtomic } from "../paths";
import { readProposalFiles, verifyProposal } from "../proposals";
import type { BundleFile, NightContext, TargetsFile } from "../steps";
import type { AuditRecord, ClaudeProof, PrecheckFinding } from "../types";
import {
  confirmCriticals,
  needsKevinReasons,
  postedStampOf,
  quotesOverlap,
  readReplayRecords,
  replayCandidate,
  stepVerify,
  type VerifyClassRecord,
  type VerifyDeps,
} from "../verify";
import { PIM_CORRECTED, PIM_FIELDS, SID, nightlyBundle, nightlyTarget } from "./nightly-fixtures";

/** Synthetic people, lessons and texts only (the repository is public). */
const SID_B = "6a0000000000000000000a02";
const NIGHT = "2026-10-02";
const SENTENCE = "She hesitated on the second word problem, but once we drew a bar model she set up the subtraction correctly and checked her answer.";
const KEY = Buffer.alloc(32, 3);
const PROOF: ClaudeProof = {
  argv: ["-p"], cliVersion: "2.1.287", models: ["claude-opus-5-5"], opusOutputTokens: 900, inputTokens: 9000, outputTokens: 900,
  costUsd: 0.4, durationMs: 60_000, effort: "max",
};
/** A replay draft that rewrites the second performance sentence. */
const REPLAY_FIELDS: FeedbackFieldAnswers = {
  ...PIM_FIELDS,
  performance: "Pim found the lowest common multiple for most questions without help and rewrote each fraction carefully. On the second word problem we drew a bar model together before she wrote the subtraction.",
};

let dir: string;
let clock: number;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nightly-verify-"));
  clock = new Date("2026-10-02T22:30:00Z").getTime();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function context(caps: Partial<NightlyCaps> = {}, patch: Partial<NightContext> = {}): NightContext {
  return {
    night: NIGHT,
    paths: nightlyPaths(path.join(dir, "state"), NIGHT),
    caps: { ...NIGHTLY_CAPS, ...caps },
    now: () => new Date(clock),
    deadline: new Date("2026-10-02T23:50:00Z"),
    stopFiles: [path.join(dir, "STOP")],
    home: dir,
    ...patch,
  };
}

function issue(patch: Partial<AuditIssue> = {}): AuditIssue {
  return {
    id: "i1", claimIds: ["c2"], field: "performance", quote: SENTENCE, mode: "M06", severity: "major", criticalCategory: null,
    rootStage: "writer", defense: "judge_list", mechanism: "Praise the transcript does not show.", evidence: [],
    minimalFix: { action: "delete_span", from: SENTENCE, to: null }, confidence: "high", ...patch,
  };
}

function auditResult(patch: Partial<AuditResult> = {}): AuditResult {
  return {
    verdict: "accurate", claims: [], issues: [], omissions: [],
    homework: { feedbackStatesHomework: false, tutorSetHomework: "no", evidence: [] },
    names: { studentCalled: ["Pim"], otherPeopleNamed: [] }, candidateReview: [],
    evidenceQuality: { transcript: "full", speakerLabels: "verified", summaryVsTranscript: "agrees", notes: [] },
    priorIssueReview: null, summaryLine: "synthetic", ...patch,
  };
}

/** One collected and audited class: its target, bundle, prechecks and cached audit. */
function seed(ctx: NightContext, input: {
  sid?: string;
  issues?: AuditIssue[];
  target?: Parameters<typeof nightlyTarget>[0];
  bundle?: Parameters<typeof nightlyBundle>[0];
  prechecks?: PrecheckFinding[];
  audited?: boolean;
} = {}): BundleFile {
  const sid = input.sid ?? SID;
  const file: BundleFile = {
    target: nightlyTarget({ wiseSessionId: sid, fieldsSha256: fieldsHash(PIM_FIELDS), ...input.target }),
    bundle: nightlyBundle({ wiseSessionId: sid, hash: `${sid.slice(-4)}bbbbbbbbbbbbbbbb`, ...input.bundle }),
    prechecks: input.prechecks ?? [],
    notes: [],
    status: { collectedAt: "", rowMeta: "read", iseb: "not_guided", detail: "fetched", soniox: "fetched", zoom: "none", retranscribe: "not_needed" },
    collectedAt: "",
  };
  const targets = readJsonFile<TargetsFile>(ctx.paths.targetsJson) ?? { night: NIGHT, auditVersion: AUDIT_VERSION, selectedAt: "", chosen: [], skipped: [] };
  writeJsonAtomic(ctx.paths.targetsJson, { ...targets, chosen: [...targets.chosen.filter((t) => t.wiseSessionId !== sid), file.target] });
  writeJsonAtomic(path.join(ctx.paths.bundlesDir, `${sid}.json`), file);
  if (input.audited !== false) {
    const issues = input.issues ?? [issue()];
    const record: AuditRecord = {
      wiseSessionId: sid, fieldsSha256: file.target.fieldsSha256, auditVersion: AUDIT_VERSION, promptVersion: 1, bundleHash: file.bundle.hash,
      grade: file.bundle.grade, result: auditResult({ verdict: issues.some((item) => item.severity === "critical") ? "critical" : "major", issues }),
      failure: null, proof: PROOF, at: "",
    };
    writeJsonAtomic(auditCacheFile(ctx.paths.auditsDir, { wiseSessionId: sid, fieldsSha256: file.target.fieldsSha256, bundleHash: file.bundle.hash }), record);
  }
  return file;
}

const success = (value: AuditResult, costUsd = 0.4): ClaudeOutcome => ({ kind: "success", value, proof: { ...PROOF, costUsd } });
/** A re-audit that finds the candidate accurate and the prior issue gone. */
const cleanReaudit = (patch: Partial<AuditResult> = {}) =>
  success(auditResult({ priorIssueReview: [{ id: "i1", stillPresent: false, note: "removed" }], ...patch }));

function judgeResult(patch: Partial<JudgeCandidateResult> = {}): JudgeCandidateResult {
  return {
    faithful: true, verdict: null, problems: [], error: null, evidence: "transcript", calls: 2, costUsd: 0.004, capStop: null, breached: [], ...patch,
  };
}

function replayRecord(patch: Partial<ReplayRecord> = {}): ReplayRecord {
  return {
    wiseSessionId: SID, tutor: "Kevin", classEndAt: null, scheduledMinutes: 60, rowState: "verified", outcome: "draft", afterFallback: null,
    soniox: null, speakers: null, transcriptCharacters: 1000, summary: null, summaryDraft: null, posted: null, calls: [],
    transcriptDraft: { outcome: "draft", arm: "sol", writerModel: "openai/gpt-6.1-sol", writerProvider: "Azure", fields: REPLAY_FIELDS, judgeHigh: null, judgeMedium: null },
    ...patch,
  };
}

function harness(ctx: NightContext, patch: Partial<VerifyDeps> & {
  reaudit?: (call: ClaudeCall) => ClaudeOutcome;
  confirm?: (call: ClaudeCall) => ClaudeOutcome;
} = {}) {
  const ledger = NightlyLedger.open(ctx.paths.root, NIGHT, ctx.caps, { now: () => new Date(clock) });
  const run = vi.fn(async (call: ClaudeCall): Promise<ClaudeOutcome> => {
    if (call.purpose === "confirm") return (patch.confirm ?? (() => success(auditResult())))(call);
    return (patch.reaudit ?? (() => cleanReaudit()))(call);
  });
  const judge = vi.fn<VerifyDeps["judge"]>(async () => judgeResult());
  const deps: VerifyDeps = {
    ledger, run, judge,
    priorFeedback: async () => [],
    otherStudentNames: async () => [],
    replay: null,
    hmacKey: KEY,
    rootCauseRef: "fix/autowriter-audit-m06",
    commit: "abc1234",
    ...patch,
  };
  return { deps, run: deps.run as typeof run, judge: deps.judge as typeof judge, ledger };
}

function classRecord(ctx: NightContext, sid = SID): VerifyClassRecord | null {
  return readJsonFile<VerifyClassRecord>(path.join(ctx.paths.verifyDir, `${sid}.json`));
}

describe("stepVerify: candidates", () => {
  it("proposes the minimal fix when every check passes: signed, 0600, codes-only reason, reserved before the re-audit", async () => {
    const ctx = context();
    seed(ctx);
    const h = harness(ctx, {
      reaudit: (call) => {
        // The re-audit is reserved on disk before the call starts, and audits the candidate against the prior issue.
        const reserved = readJsonl<{ type: string; kind: string; key: string }>(ctx.paths.spendJsonl)
          .filter((line) => line.type === "reserve" && line.kind === "opus_reaudit");
        expect(reserved.map((line) => line.key)).toEqual([`reaudit:${SID}:${fieldsHash(PIM_CORRECTED)}:a${AUDIT_VERSION}`]);
        expect(call.user).toContain("<prior_issues>");
        const feedback = call.user.slice(call.user.indexOf("<feedback>"), call.user.indexOf("</feedback>"));
        expect(feedback).toContain(PIM_CORRECTED.performance);
        expect(feedback).not.toContain("She hesitated on the second word problem");
        return cleanReaudit();
      },
    });
    const result = await stepVerify(ctx, h.deps);
    expect(result).toMatchObject({ ok: true, exitCode: 0, next: "correct", summary: { proposed: [{ wiseSessionId: SID, source: "minimal_fix" }], proposalsTonight: 1 } });
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.judge).toHaveBeenCalledTimes(1);
    const [entry] = readProposalFiles(ctx.paths.proposalsDir);
    expect(fs.statSync(entry.file).mode & 0o777).toBe(0o600);
    const verified = verifyProposal(entry.value, KEY);
    expect(verified.ok).toBe(true);
    expect(verifyProposal(entry.value, Buffer.alloc(32, 9))).toEqual({ ok: false, reason: "signature_mismatch" });
    if (!verified.ok) return;
    expect(verified.proposal).toMatchObject({
      wiseSessionId: SID, fieldsSha256: fieldsHash(PIM_FIELDS), fields: PIM_CORRECTED, fieldsHash: fieldsHash(PIM_CORRECTED), source: "minimal_fix",
      evidence: "transcript", modes: ["M06"], severity: "major", rootCauseRef: "fix/autowriter-audit-m06",
    });
    expect(verified.proposal.reason).toMatch(/^M06 overstated_judgement \(major\): corrected from the audit's minimal fix/u);
    expect(verified.proposal.reason).not.toMatch(/hesitated|Pim/u);
    // Only versions and ids of the posted draft's stamp travel with the proposal (a stamp can carry judge quotes).
    expect(verified.proposal.pipeline).toMatchObject({ source: "minimal_fix", auditVersion: AUDIT_VERSION, verifyCommit: "abc1234", posted: { evidence: "transcript", promptVersion: 5 } });
    expect(verified.proposal.checks.map((item) => `${item.name}:${item.pass}`)).toEqual([
      "word_change:true", "length_ratio:true", "text_problems:true", "display_name:true", "judge:true", "reaudit:true",
      "reaudit_verdict:true", "reaudit_omissions:true", "reaudit_prior_issues:true", "reaudit_names:true", "reaudit_homework:true",
    ]);
    expect(classRecord(ctx)?.status).toBe("proposed");
  });

  it("prefers the fixed pipeline's replay draft, and falls back to the minimal fix when the draft fails a check", async () => {
    const ctx = context();
    seed(ctx);
    const first = harness(ctx, { replay: [replayRecord()] });
    expect((await stepVerify(ctx, first.deps)).summary.proposed).toEqual([{ wiseSessionId: SID, source: "replay" }]);
    const [entry] = readProposalFiles(ctx.paths.proposalsDir);
    const verified = verifyProposal(entry.value, KEY);
    expect(verified.ok && verified.proposal).toMatchObject({ source: "replay", evidence: "transcript", arm: "sol", fields: REPLAY_FIELDS });

    const ctx2 = context({}, { paths: nightlyPaths(path.join(dir, "state2"), NIGHT) });
    seed(ctx2);
    const second = harness(ctx2, { replay: [replayRecord()] });
    second.judge.mockImplementation(async (input: { fields: FeedbackFieldAnswers }) => judgeResult(
      fieldsHash(input.fields) === fieldsHash(REPLAY_FIELDS) ? { faithful: false, problems: ["synthetic"] } : {},
    ));
    expect((await stepVerify(ctx2, second.deps)).summary.proposed).toEqual([{ wiseSessionId: SID, source: "minimal_fix" }]);
    const record = classRecord(ctx2);
    expect(record?.candidates.map((candidate) => `${candidate.source}:${candidate.passed}`)).toEqual(["replay:false", "minimal_fix:true"]);
    expect(record?.candidates[0].checks.at(-1)).toMatchObject({ name: "judge", pass: false, detail: "problems:1" });
  });

  it("reads the replay's records.json and refuses one it cannot use", () => {
    const replayDir = path.join(dir, "replay");
    expect(readReplayRecords(replayDir)).toEqual({ ok: false, reason: "replay_records_unreadable" });
    writeJsonAtomic(path.join(replayDir, "records.json"), [replayRecord()]);
    expect(readReplayRecords(replayDir)).toMatchObject({ ok: true, records: [{ wiseSessionId: SID, outcome: "draft" }] });
    writeJsonAtomic(path.join(replayDir, "records.json"), [replayRecord(), { outcome: "draft" }]);
    expect(readReplayRecords(replayDir)).toEqual({ ok: false, reason: "replay_records_malformed" });
  });

  it("never offers the replay for a guided post, and takes the summary draft after a transcript fallback", () => {
    const file = { target: nightlyTarget({ guided: true }), bundle: nightlyBundle() } as BundleFile;
    expect(replayCandidate(replayRecord(), file)).toEqual({ ok: false, reason: "guided_post" });
    const plain = { target: nightlyTarget(), bundle: nightlyBundle({ pipeline: { styleGuide: null, formatGuide: null, atomEvidenceHash: null } }) } as BundleFile;
    expect(replayCandidate(replayRecord(), plain)).toMatchObject({ ok: true, evidence: "transcript" });
    const fellBack = replayRecord({
      outcome: "fallback:no_recording", afterFallback: "draft", transcriptDraft: null,
      summaryDraft: { outcome: "draft", arm: "luna", writerModel: "openai/gpt-6-luna", writerProvider: null, fields: REPLAY_FIELDS, judgeHigh: null, judgeMedium: null },
    });
    expect(replayCandidate(fellBack, plain)).toMatchObject({ ok: true, evidence: "summary", arm: "luna" });
    // A held draft is never a candidate, and the reason keeps no quotes.
    expect(replayCandidate(replayRecord({ outcome: "hold:sol:unfaithful:a quote from the lesson" }), plain)).toEqual({ ok: false, reason: "replay_outcome:hold" });
    expect(replayCandidate(undefined, plain)).toEqual({ ok: false, reason: "no_replay_record" });
  });

  it("refuses a candidate on each check alone, and spends nothing past the first failure", async () => {
    const noFix = [issue({ minimalFix: null })];
    const cases: Array<{ name: string; fields?: FeedbackFieldAnswers; patch?: Parameters<typeof harness>[1]; issues?: AuditIssue[]; calls: { judge: number; run: number } }> = [
      { name: "length_ratio", fields: { ...REPLAY_FIELDS, improvement: `${REPLAY_FIELDS.improvement} ${REPLAY_FIELDS.improvement} ${REPLAY_FIELDS.improvement}` }, calls: { judge: 0, run: 0 } },
      { name: "text_problems", fields: { ...REPLAY_FIELDS, topics: `${REPLAY_FIELDS.topics} We also watched the Zoom recording.` }, calls: { judge: 0, run: 0 } },
      { name: "display_name", fields: { ...REPLAY_FIELDS, performance: "She found the lowest common multiple for most questions without help and rewrote each fraction carefully, then drew a bar model.", improvement: REPLAY_FIELDS.improvement.replaceAll("Pim", "She") }, calls: { judge: 0, run: 0 } },
      { name: "judge", patch: {}, calls: { judge: 1, run: 0 } },
      { name: "reaudit_verdict", patch: { reaudit: () => cleanReaudit({ verdict: "major", issues: [issue({ id: "i9", quote: "rewrote each fraction carefully", minimalFix: null })] }) }, calls: { judge: 1, run: 1 } },
      { name: "reaudit_omissions", patch: { reaudit: () => cleanReaudit({ verdict: "major", omissions: [{ what: "main_topic_missing", detail: "x", evidence: [], severity: "major" }] }) }, calls: { judge: 1, run: 1 } },
      { name: "reaudit_prior_issues", patch: { reaudit: () => cleanReaudit({ priorIssueReview: [{ id: "i1", stillPresent: true, note: "still" }] }) }, calls: { judge: 1, run: 1 } },
      { name: "reaudit_prior_issues", patch: { reaudit: () => cleanReaudit({ priorIssueReview: null }) }, calls: { judge: 1, run: 1 } },
      { name: "reaudit_names", patch: { reaudit: () => cleanReaudit({ names: { studentCalled: ["Pim"], otherPeopleNamed: ["Tawan"] } }) }, calls: { judge: 1, run: 1 } },
      { name: "reaudit_names", patch: { reaudit: () => cleanReaudit({ names: { studentCalled: ["Pimchanok"], otherPeopleNamed: [] } }) }, calls: { judge: 1, run: 1 } },
      { name: "reaudit_homework", patch: { reaudit: () => cleanReaudit({ homework: { feedbackStatesHomework: true, tutorSetHomework: "unclear", evidence: [] } }) }, calls: { judge: 1, run: 1 } },
      { name: "reaudit", patch: { reaudit: () => ({ kind: "cli_error", reason: "exit_1", proof: null }) }, calls: { judge: 1, run: 1 } },
      { name: "reaudit", patch: { reaudit: () => success({ verdict: "accurate" } as AuditResult) }, calls: { judge: 1, run: 1 } },
    ];
    for (const [index, item] of cases.entries()) {
      const ctx = context({}, { paths: nightlyPaths(path.join(dir, `case-${index}`), NIGHT) });
      // Text-level checks run on the replay draft alone (the audit's issue has no minimal fix); model checks on the minimal fix.
      seed(ctx, { issues: item.fields ? noFix : undefined });
      const h = harness(ctx, { replay: item.fields ? [replayRecord({ transcriptDraft: { ...replayRecord().transcriptDraft!, fields: item.fields } })] : null, ...item.patch });
      if (item.name === "judge") h.judge.mockImplementation(async () => judgeResult({ faithful: false, problems: ["x"] }));
      const result = await stepVerify(ctx, h.deps);
      expect(result.summary.proposed, item.name).toEqual([]);
      const record = classRecord(ctx);
      expect(record?.status, item.name).toBe("no_candidate");
      const tried = record!.candidates.find((candidate) => candidate.fields !== null)!;
      const failed = tried.checks.filter((check) => !check.pass).map((check) => check.name);
      // The re-audit's own checks are all recorded (a major omission also raises its verdict); the rest stop at the first.
      if (item.name.startsWith("reaudit_")) expect(failed, `${index}:${item.name}`).toContain(item.name);
      else expect(failed, `${index}:${item.name}`).toEqual([item.name]);
      expect(h.judge, item.name).toHaveBeenCalledTimes(item.calls.judge);
      expect(h.run, item.name).toHaveBeenCalledTimes(item.calls.run);
      expect(readProposalFiles(ctx.paths.proposalsDir), item.name).toEqual([]);
    }
  });

  it("refuses a minimal fix whose span is gone, ambiguous or too large", async () => {
    for (const [fix, reason] of [
      [{ action: "delete_span", from: "a sentence the post does not have", to: null }, "minimal_fix:fix_no_match:i1"],
      [{ action: "delete_span", from: "the", to: null }, "minimal_fix:fix_ambiguous:i1"],
      [{ action: "clear_field", from: PIM_FIELDS.improvement, to: null }, "minimal_fix:too_many_words_changed:37%"],
    ] as const) {
      const ctx = context({}, { paths: nightlyPaths(path.join(dir, `fix-${reason}`), NIGHT) });
      seed(ctx, { issues: [issue({ field: fix.action === "clear_field" ? "improvement" : "performance", minimalFix: { ...fix } })] });
      const h = harness(ctx);
      await stepVerify(ctx, h.deps);
      expect(classRecord(ctx)).toMatchObject({ status: "no_candidate", reasons: [reason] });
      expect(h.run).not.toHaveBeenCalled();
      expect(h.judge).not.toHaveBeenCalled();
    }
  });
});

describe("stepVerify: the 2 Oct night's evidence shapes", () => {
  it("judges a retranscribed transcript post against its transcript, a summary post against its summary, and never replays a guided post", async () => {
    const ctx = context();
    const SID_C = "6a0000000000000000000a03";
    const unguided = { styleGuide: null, formatGuide: null, atomEvidenceHash: null, lessonEvidenceHash: null, evidence: "transcript" };
    seed(ctx, {
      target: { pipeline: unguided },
      bundle: {
        grade: "retranscribed", pipeline: unguided,
        transcript: { text: "[00:00] TUTOR: Fractions today.\n[00:05] STUDENT: Twelve.", source: "retranscribed_soniox", speakerMethod: "zoom_alignment", speakerLabels: "verified" },
      },
    });
    seed(ctx, {
      sid: SID_B,
      target: { evidence: "summary", pipeline: { ...unguided, evidence: "summary" } },
      bundle: { grade: "exact", transcript: null, postedEvidenceKind: "summary", pipeline: { ...unguided, evidence: "summary" } },
    });
    seed(ctx, {
      sid: SID_C,
      target: { guided: true, pipeline: { ...unguided, atomEvidenceHash: "atom-hash", lessonEvidenceHash: "lesson-hash" } },
      bundle: {
        grade: "exact", pipeline: { ...unguided, atomEvidenceHash: "atom-hash", lessonEvidenceHash: "lesson-hash" },
        transcript: { text: "Lesson record (synthetic).", source: "iseb_record", speakerMethod: "zoom_alignment", speakerLabels: "verified" },
      },
    });
    const passing = JSON.stringify({ faithful: true, unsupported: [], misattributed: [], homeworkNotSet: [] });
    const modes = new Map<string, string>();
    const callModel = vi.fn(async (request: { messages: Array<{ content: string }> }): Promise<OpenRouterCallResult> => {
      const content = request.messages[1].content;
      modes.set(content.includes("Lesson transcript:") ? (content.includes("Lesson record (synthetic).") ? "iseb" : "transcript") : "summary", "seen");
      return {
        ok: true, content: passing, model: AUTOWRITER_MODELS.judge.expectModel, provider: AUTOWRITER_MODELS.judge.expectProvider, generationId: "g",
        finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, reasoningTokens: 0, cachedTokens: 0, costUsd: 0.001 }, latencyMs: 1,
      };
    });
    const h = harness(ctx, { replay: [replayRecord(), replayRecord({ wiseSessionId: SID_B }), replayRecord({ wiseSessionId: SID_C })] });
    h.deps.judge = (input) => judgeCandidate({ apiKey: "k", ledger: h.ledger, key: input.key, callModel: callModel as never }, input);
    const result = await stepVerify(ctx, h.deps);
    expect(result.summary.proposed).toEqual(expect.arrayContaining([
      { wiseSessionId: SID, source: "replay" }, { wiseSessionId: SID_B, source: "replay" }, { wiseSessionId: SID_C, source: "minimal_fix" },
    ]));
    expect([...modes.keys()].toSorted()).toEqual(["iseb", "summary", "transcript"]);
    expect(classRecord(ctx, SID_C)?.candidates[0]).toMatchObject({ source: "replay", unavailable: "guided_post" });
  });
});

describe("stepVerify: who is never corrected", () => {
  it("lists billing, scope and modes no text can fix as needing Kevin, at no cost", async () => {
    expect(needsKevinReasons([issue({ mode: "M13", severity: "critical", criticalCategory: "billing_status" })])).toEqual(["not_text_fixable:i1:M13"]);
    expect(needsKevinReasons([issue({ mode: "M14", severity: "critical", criticalCategory: "should_not_have_posted" })])).toEqual(["not_text_fixable:i1:M14"]);
    expect(needsKevinReasons([issue({ mode: "M04", severity: "critical", criticalCategory: "should_not_have_posted" })])).toEqual(["not_text_fixable:i1:should_not_have_posted"]);
    expect(needsKevinReasons([issue({ mode: "M16" })])).toEqual(["not_text_fixable:i1:M16"]);
    expect(needsKevinReasons([issue()], [{ code: "billing_drift", severity: "critical", candidate: false, detail: "", mode: "M13" }])).toEqual(["precheck:billing_drift"]);
    expect(needsKevinReasons([issue()])).toEqual([]);

    const ctx = context();
    seed(ctx, { issues: [issue(), issue({ id: "i2", mode: "M13", severity: "critical", criticalCategory: "billing_status", minimalFix: null })] });
    const h = harness(ctx);
    const result = await stepVerify(ctx, h.deps);
    expect(result.summary.needsKevin).toEqual([{ wiseSessionId: SID, reasons: ["not_text_fixable:i2:M13"] }]);
    expect(h.run).not.toHaveBeenCalled();
    expect(h.judge).not.toHaveBeenCalled();
  });

  it("blocks a class a correction would be refused for, at no cost", async () => {
    const ctx = context();
    seed(ctx, { target: { firstShotPostId: null, ownerFlagOpen: true, humanSavedSincePost: true }, bundle: { wiseTextMatchesPost: false } });
    const h = harness(ctx);
    const result = await stepVerify(ctx, h.deps);
    expect(result.summary.blocked).toEqual([{ wiseSessionId: SID, reasons: ["no_first_shot_row", "wise_text_edited", "human_save_since_post", "owner_flag_open"] }]);
    expect(h.run).not.toHaveBeenCalled();
  });

  it("skips classes without an audit or without a major or critical issue", async () => {
    const ctx = context();
    seed(ctx, { audited: false });
    seed(ctx, { sid: SID_B, issues: [issue({ severity: "cosmetic", mode: "M17" })] });
    const result = await stepVerify(ctx, harness(ctx).deps);
    expect(result.summary).toMatchObject({ classes: 2, skipped: { not_audited: 1, nothing_to_correct: 1, over_cap: 0, proposal_exists: 0 }, proposed: [] });
  });
});

describe("stepVerify: critical issues", () => {
  const critical = issue({ mode: "M01", severity: "critical", criticalCategory: "wrong_person" });

  it("needs a second, fresh Opus audit of the post confirming a critical issue on an overlapping quote", async () => {
    const ctx = context();
    seed(ctx, { issues: [critical] });
    const h = harness(ctx, {
      confirm: (call) => {
        // The posted text, audited without prior issues.
        expect(call.user).not.toContain("<prior_issues>");
        expect(call.user).toContain("She hesitated on the second word problem");
        return success(auditResult({ verdict: "critical", issues: [issue({ id: "i1", mode: "M04", severity: "critical", criticalCategory: "invented_content", quote: "once we drew a bar model she set up the subtraction" })] }));
      },
      reaudit: () => cleanReaudit(),
    });
    const result = await stepVerify(ctx, h.deps);
    expect(result.summary.proposed).toEqual([{ wiseSessionId: SID, source: "minimal_fix" }]);
    expect(h.run.mock.calls.map(([call]) => call.purpose)).toEqual(["confirm", "reaudit"]);
    const ledger = readJsonl<{ type: string; kind: string; key: string }>(ctx.paths.spendJsonl).filter((line) => line.type === "reserve");
    expect(ledger.map((line) => line.kind)).toEqual(["opus_audit", "opus_reaudit"]);
    expect(classRecord(ctx)?.confirmation).toEqual({ outcome: "success", confirmed: ["i1"], unconfirmed: [] });
    const [entry] = readProposalFiles(ctx.paths.proposalsDir);
    const verified = verifyProposal(entry.value, KEY);
    expect(verified.ok && verified.proposal).toMatchObject({ severity: "critical", criticalCategory: "wrong_person" });
  });

  it("downgrades an unconfirmed critical to needing Kevin: no candidate is tried", async () => {
    const outcomes: Array<[string, ClaudeOutcome, string]> = [
      ["major only", success(auditResult({ verdict: "major", issues: [issue({ severity: "major" })] })), "critical_unconfirmed:i1"],
      ["another field", success(auditResult({ verdict: "critical", issues: [issue({ severity: "critical", mode: "M01", criticalCategory: "wrong_person", field: "topics", quote: "Today we worked on adding" })] })), "critical_unconfirmed:i1"],
      ["no overlap", success(auditResult({ verdict: "critical", issues: [issue({ severity: "critical", mode: "M01", criticalCategory: "wrong_person", quote: "rewrote each fraction carefully" })] })), "critical_unconfirmed:i1"],
      ["failed", { kind: "cli_error", reason: "exit_1", proof: null }, "critical_unconfirmed:cli_error"],
    ];
    for (const [name, outcome, reason] of outcomes) {
      const ctx = context({}, { paths: nightlyPaths(path.join(dir, name), NIGHT) });
      seed(ctx, { issues: [critical] });
      const h = harness(ctx, { confirm: () => outcome });
      const result = await stepVerify(ctx, h.deps);
      expect(result.summary.needsKevin, name).toEqual([{ wiseSessionId: SID, reasons: [reason] }]);
      expect(h.run, name).toHaveBeenCalledTimes(1);
      expect(h.judge, name).not.toHaveBeenCalled();
    }
  });

  it("compares quotes the way the audit does", () => {
    const posted = PIM_FIELDS;
    expect(quotesOverlap(posted.performance, "drew a bar model", "a bar model she set up")).toBe(true);
    expect(quotesOverlap(posted.performance, "DREW  a bar model", "bar model")).toBe(true);
    expect(quotesOverlap(posted.performance, "rewrote each fraction", "drew a bar model")).toBe(false);
    expect(confirmCriticals([issue({ severity: "critical" })], { issues: [] }, posted)).toEqual({ confirmed: [], unconfirmed: ["i1"] });
  });
});

describe("stepVerify: caps, stops and the ledger", () => {
  it("writes at most maxCorrectionsPerNight proposals", async () => {
    const ctx = context({ maxCorrectionsPerNight: 1, auditConcurrency: 1 });
    seed(ctx);
    seed(ctx, { sid: SID_B });
    const result = await stepVerify(ctx, harness(ctx).deps);
    expect(result.summary).toMatchObject({ proposalsTonight: 1, overCap: [SID_B] });
    expect(readProposalFiles(ctx.paths.proposalsDir)).toHaveLength(1);
  });

  it("stops at a reservation the ledger refuses, before the call, and leaves the class undecided", async () => {
    const ctx = context({ maxClaudeUsdNight: 1 });
    seed(ctx);
    const h = harness(ctx);
    const result = await stepVerify(ctx, h.deps);
    expect(result).toMatchObject({ ok: false, stop: "cap:claude_usd_night", exitCode: 3, next: "verify" });
    expect(h.run).not.toHaveBeenCalled();
    expect(classRecord(ctx)).toBeNull();
  });

  it("reserves every judge call as openrouter before it is sent", async () => {
    const ctx = context();
    seed(ctx);
    const passing = JSON.stringify({ faithful: true, unsupported: [], misattributed: [], homeworkNotSet: [] });
    const callModel = vi.fn(async (): Promise<OpenRouterCallResult> => ({
      ok: true, content: passing, model: AUTOWRITER_MODELS.judge.expectModel, provider: AUTOWRITER_MODELS.judge.expectProvider, generationId: "g",
      finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, reasoningTokens: 0, cachedTokens: 0, costUsd: 0.001 }, latencyMs: 1,
    }));
    const h = harness(ctx);
    h.deps.judge = (input) => judgeCandidate({ apiKey: "k", ledger: h.ledger, key: input.key, callModel }, input);
    await stepVerify(ctx, h.deps);
    const reserved = readJsonl<{ type: string; kind: string; key: string }>(ctx.paths.spendJsonl).filter((line) => line.type === "reserve");
    expect(reserved.map((line) => `${line.kind}:${line.key.split(":").at(-1)}`).toSorted()).toEqual(["openrouter:high", "openrouter:medium", `opus_reaudit:a${AUDIT_VERSION}`]);
    expect(callModel).toHaveBeenCalledTimes(2);
  });

  it("never verifies a class with a valid proposal again, and keeps only a stamp's versions and ids", async () => {
    const ctx = context();
    seed(ctx);
    await stepVerify(ctx, harness(ctx).deps);
    fs.rmSync(path.join(ctx.paths.verifyDir, `${SID}.json`));
    const again = harness(ctx);
    expect((await stepVerify(ctx, again.deps)).summary).toMatchObject({ skipped: { proposal_exists: 1 }, proposalsTonight: 1 });
    expect(again.judge).not.toHaveBeenCalled();
    expect(postedStampOf({ promptVersion: 5, factualVerdicts: { unsupported: ["a quote"] }, commitSha: "abc", evidence: "summary" }))
      .toEqual({ promptVersion: 5, commitSha: "abc", evidence: "summary" });
  });

  it("never repeats a paid call: a re-run reuses decided classes, and a call a dead run reserved is not made again", async () => {
    const ctx = context();
    seed(ctx);
    const first = harness(ctx);
    await stepVerify(ctx, first.deps);
    const again = harness(ctx);
    const result = await stepVerify(ctx, again.deps);
    expect(again.run).not.toHaveBeenCalled();
    expect(again.judge).not.toHaveBeenCalled();
    expect(result.summary.proposed).toEqual([{ wiseSessionId: SID, source: "minimal_fix" }]);

    // A run that died during the re-audit left its reservation unsettled: the re-audit is never made again.
    const crashed = context({}, { paths: nightlyPaths(path.join(dir, "crashed"), NIGHT) });
    seed(crashed);
    fs.mkdirSync(crashed.paths.root, { recursive: true });
    fs.writeFileSync(crashed.paths.spendJsonl, `${JSON.stringify({
      type: "reserve", id: "dead-1", night: NIGHT, kind: "opus_reaudit", key: `reaudit:${SID}:${fieldsHash(PIM_CORRECTED)}:a${AUDIT_VERSION}`,
      estimateUsd: 1.5, at: new Date(clock).toISOString(),
    })}\n`);
    const resumed = harness(crashed);
    await stepVerify(crashed, resumed.deps);
    expect(resumed.run).not.toHaveBeenCalled();
    expect(classRecord(crashed)?.candidates[0].checks.at(-1)).toMatchObject({ name: "reaudit", pass: false, detail: "already_attempted" });
  });

  it("stops at a usage limit without caching it, so a later run can make the call", async () => {
    const ctx = context();
    seed(ctx);
    const limited = harness(ctx, { reaudit: () => ({ kind: "usage_limited", reason: "usage_limited", proof: null }) });
    expect(await stepVerify(ctx, limited.deps)).toMatchObject({ ok: false, stop: "usage_limited", exitCode: 4 });
    expect(classRecord(ctx)).toBeNull();
    const later = harness(ctx);
    expect((await stepVerify(ctx, later.deps)).summary.proposed).toEqual([{ wiseSessionId: SID, source: "minimal_fix" }]);
    expect(later.run).toHaveBeenCalledTimes(1);
  });

  it("writes STOP and exits 10 when a call's cost breaches a cap after the fact", async () => {
    const ctx = context();
    seed(ctx);
    const h = harness(ctx, { reaudit: () => cleanReaudit({}) });
    h.run.mockImplementation(async () => ({ ...cleanReaudit(), proof: { ...PROOF, costUsd: 30 } }) as ClaudeOutcome);
    const result = await stepVerify(ctx, h.deps);
    expect(result).toMatchObject({ ok: false, stop: "breach:claude_usd_night", exitCode: 10 });
    expect(fs.existsSync(path.join(dir, ".bgscheduler-nightly", "STOP"))).toBe(true);
    expect(readProposalFiles(ctx.paths.proposalsDir)).toEqual([]);
  });

  it("does nothing under a STOP file or past the deadline, and needs a root-cause reference", async () => {
    const ctx = context();
    seed(ctx);
    fs.writeFileSync(path.join(dir, "STOP"), "stop");
    const stopped = harness(ctx);
    expect(await stepVerify(ctx, stopped.deps)).toMatchObject({ ok: false, stop: "stop_file", exitCode: 7 });
    fs.rmSync(path.join(dir, "STOP"));
    const late = context({}, { deadline: new Date(clock - 1) });
    expect(await stepVerify(late, harness(late).deps)).toMatchObject({ ok: false, stop: "deadline", exitCode: 7 });
    expect(await stepVerify(ctx, { ...harness(ctx).deps, rootCauseRef: " " })).toMatchObject({ ok: false, stop: "root_cause_ref_missing", exitCode: 2 });
    expect(stopped.run).not.toHaveBeenCalled();
  });
});
