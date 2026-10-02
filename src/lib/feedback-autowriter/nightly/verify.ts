import { createHash } from "node:crypto";
import path from "node:path";
import type { PriorFeedbackComparison } from "@/lib/post-class-feedback/similarity";
import { POST_CLASS_FEEDBACK_FIELDS, type FeedbackFieldAnswers } from "@/lib/post-class-feedback/types";
import { normalizeFields } from "../first-shot";
import { JUDGE_PROMPT_VERSION } from "../judge";
import { chooseStudentDisplayName } from "../prompt";
import type { ReplayRecord } from "../replay";
import { fieldsHash } from "../submit";
import { AUDIT_TIMEOUT_MS } from "./audit";
import { AUDIT_PROMPT_VERSION, buildAuditPrompt, evidenceTextOf } from "./audit-prompt";
import {
  AUDIT_JSON_SCHEMA,
  AUDIT_VERSION,
  normaliseForQuote,
  parseAuditResult,
  type AuditIssue,
  type AuditResult,
} from "./audit-schema";
import { writeStopFile } from "./caps";
import type { ClaudeCall, ClaudeOutcome } from "./claude-runner";
import { EXIT, NightlyStop } from "./exit";
import type { JudgeCandidateResult } from "./judge-candidate";
import type { NightlyLedger } from "./ledger";
import { MAX_LENGTH_RATIO, MIN_LENGTH_RATIO, applyMinimalFixes, lengthRatio, occurrences } from "./minimal-fix";
import { failureMode } from "./modes";
import { readJsonFile, writeJsonAtomic } from "./paths";
import { runPrechecks } from "./prechecks";
import {
  readProposalFiles,
  verifyProposal,
  writeProposal,
  type CorrectionProposal,
  type ProposalCheck,
} from "./proposals";
import { guidedStamp } from "./select";
import { nightAuditRecords, readNightBundles, readTargets, stopBeforeStep, type BundleFile, type NightContext, type StepResult } from "./steps";
import { correctionTextProblems, guidesFromStamp, type TextProblemInput } from "./text-problems";
import type { AuditRecord, EvidenceBundle, PrecheckFinding } from "./types";

/**
 * `verify` (quick 261003-12b): for each audited class of the night with a major or critical issue in a text-fixable
 * failure mode, find a corrected text that passes every check, and write it as a signed proposal for `correct`.
 *
 * - Never for billing or scope (M13, M14, `billing_status`, `should_not_have_posted`) or a mode no text can fix: those
 *   classes are listed as needing Kevin. Nor for a class a correction would be refused for anyway (no first-shot row,
 *   Wise's text edited, a person's save, an open owner flag): listed as blocked. Neither costs anything.
 * - A critical issue must first be confirmed by a second, independent Opus 5.5 max audit of the posted text (a fresh
 *   call) reporting a critical issue on an overlapping quote of the same field; otherwise the class needs Kevin.
 * - Candidate A is the fixed pipeline's replay draft (`<replay-dir>/records.json`; never for a guided post — the
 *   replay cannot rebuild style guides or Atom evidence); candidate B, the fallback, is the posted text with the
 *   audit's minimal fixes applied exactly (`minimal-fix.ts`).
 * - A candidate passes only when every check passes, cheapest first, stopping at the first failure: its length (0.6–
 *   1.6× the post), production's text checks (`correctionTextProblems`: validators with the class's own post left
 *   out of the copy check, meta words, identity), the student's display name, both production GLM judge levels, and
 *   one Opus 5.5 max re-audit of the candidate with the prior issues (verdict accurate or cosmetic, no major
 *   omission, every prior major or critical issue gone, no other person named, homework only when the tutor set it).
 * Every paid call is reserved in the ledger first and cached under `verify/calls/`: a candidate is re-audited at
 * most once, ever, and nothing is retried in a loop. At most `maxCorrectionsPerNight` proposals a night.
 */

export const NEEDS_KEVIN_MODES: ReadonlySet<string> = new Set(["M13", "M14"]);
const NEEDS_KEVIN_CATEGORIES: ReadonlySet<string> = new Set(["billing_status", "should_not_have_posted"]);

export type VerifyClassStatus = "proposed" | "needs_kevin" | "no_candidate" | "blocked";

export interface CandidateRecord {
  source: CorrectionProposal["source"];
  /** The candidate text (local file only); null when there was none. */
  fields: FeedbackFieldAnswers | null;
  fieldsHash: string | null;
  evidence: CorrectionProposal["evidence"];
  arm: string | null;
  checks: ProposalCheck[];
  passed: boolean;
  /** Why there was no text to check (`guided_post`, `no_replay_record`, `fix_no_match:i2`, …). */
  unavailable: string | null;
}

/** One class's verification (`verify/<sid>.json`, 0600, real data): written once the class is decided. */
export interface VerifyClassRecord {
  wiseSessionId: string;
  night: string;
  fieldsSha256: string;
  status: VerifyClassStatus;
  /** Codes only. */
  reasons: string[];
  issues: Array<{ id: string; mode: string; severity: string; field: string; confidence: string }>;
  confirmation: { outcome: string; confirmed: string[]; unconfirmed: string[] } | null;
  candidates: CandidateRecord[];
  proposalFile: string | null;
  at: string;
}

export interface VerifyDeps {
  ledger: Pick<NightlyLedger, "reserve" | "settle" | "attempts">;
  /** One `claude -p` Opus 5.5 max call (re-audits and critical confirmations). */
  run: (call: ClaudeCall) => Promise<ClaudeOutcome>;
  /** Both production GLM judge levels on a candidate (production: `judgeCandidate`, which reserves each call). */
  judge: (input: { key: string; fields: FeedbackFieldAnswers; bundle: EvidenceBundle }) => Promise<JudgeCandidateResult>;
  /** The tutor's prior feedback for the copy check (production: `loadTutorPriorFeedback`). */
  priorFeedback: (file: BundleFile) => Promise<PriorFeedbackComparison[]>;
  /** Display names of the tutor's other students. */
  otherStudentNames: (file: BundleFile) => Promise<string[]>;
  /** The night's replay of the fixed pipeline, or null (candidate B only). */
  replay: readonly ReplayRecord[] | null;
  hmacKey: Buffer;
  /** The fix branch or PR behind tonight's corrections (non-empty). */
  rootCauseRef: string;
  sessionIds?: readonly string[];
  /** The commit verify runs from, stamped on each proposal. */
  commit?: string | null;
}

// ---------------------------------------------------------------------------
// Pure parts
// ---------------------------------------------------------------------------

/** The issues a correction is for: major and critical, in the audit's order. */
export function seriousIssues(result: Pick<AuditResult, "issues">): AuditIssue[] {
  return result.issues.filter((issue) => issue.severity === "critical" || issue.severity === "major");
}

/** Why no text can fix the class (billing, scope, a mode without a text fix): the owner decides. Codes only. */
export function needsKevinReasons(issues: readonly AuditIssue[], prechecks: readonly PrecheckFinding[] = []): string[] {
  const reasons: string[] = [];
  for (const issue of issues) {
    const mode = failureMode(issue.mode);
    if (NEEDS_KEVIN_MODES.has(issue.mode) || !mode?.textFixable) reasons.push(`not_text_fixable:${issue.id}:${issue.mode}`);
    else if (issue.criticalCategory && NEEDS_KEVIN_CATEGORIES.has(issue.criticalCategory)) reasons.push(`not_text_fixable:${issue.id}:${issue.criticalCategory}`);
  }
  // The deterministic billing and scope floors count whether or not the audit repeated them.
  for (const finding of prechecks) {
    if (!finding.candidate && (finding.severity === "critical" || finding.severity === "major") && finding.mode && NEEDS_KEVIN_MODES.has(finding.mode)) {
      reasons.push(`precheck:${finding.code}`);
    }
  }
  return [...new Set(reasons)];
}

/** The post as audited, four fields. */
export function postedFieldsOf(file: Pick<BundleFile, "bundle">): FeedbackFieldAnswers {
  return normalizeFields(file.bundle.postedFields);
}

/** The student's full and display names, or null when unknown. */
export function studentNamesOf(file: Pick<BundleFile, "bundle" | "target">): { full: string; display: string } | null {
  const full = file.bundle.studentFullName?.trim() || file.target.studentFullName?.trim() || "";
  if (!full) return null;
  const display = file.bundle.studentDisplayName?.trim() || chooseStudentDisplayName(full);
  return display ? { full, display } : null;
}

/** Why a correction of the class would be refused anyway (checked again by `correct` and the executor). */
export function blockedReasons(file: BundleFile): string[] {
  const reasons: string[] = [];
  if (file.target.firstShotPostId === null) reasons.push("no_first_shot_row");
  if (file.bundle.wiseTextMatchesPost === false) reasons.push("wise_text_edited");
  if (file.target.humanSavedSincePost) reasons.push("human_save_since_post");
  if (file.target.ownerFlagOpen) reasons.push("owner_flag_open");
  if (!studentNamesOf(file)) reasons.push("student_unknown");
  if (fieldsHash(postedFieldsOf(file)) !== file.target.fieldsSha256) reasons.push("posted_hash_mismatch");
  return reasons;
}

/** Everything `correctionTextProblems` needs about a class except the text (shared with `correct`). */
export function textProblemContext(file: BundleFile, extra: {
  priorFeedback: readonly PriorFeedbackComparison[];
  otherStudentNames: readonly string[];
}): Omit<TextProblemInput, "fields"> | null {
  const names = studentNamesOf(file);
  if (!names) return null;
  const { bundle, target } = file;
  return {
    wiseSessionId: target.wiseSessionId,
    studentFullName: names.full,
    studentDisplayName: names.display,
    studentAliases: bundle.studentAliases,
    tutorNames: bundle.tutorNames,
    classDetails: bundle.classDetails,
    priorFeedback: extra.priorFeedback,
    otherStudentNames: extra.otherStudentNames,
    ...guidesFromStamp(target.pipeline),
    lessonRecord: (bundle.transcript?.text ?? bundle.wiseSummary ?? "") + (target.pipeline?.atomEvidenceHash ? "\nAtom learning" : ""),
  };
}

/** Whether two quotes of one field cover some of the same text (compared as the audit compares quotes). */
export function quotesOverlap(fieldText: string, a: string, b: string): boolean {
  const text = normaliseForQuote(fieldText);
  const spans = (quote: string) => {
    const needle = normaliseForQuote(quote);
    return occurrences(text, needle).map((start) => [start, start + needle.length] as const);
  };
  const left = spans(a);
  const right = spans(b);
  return left.some(([s1, e1]) => right.some(([s2, e2]) => s1 < e2 && s2 < e1));
}

/** The critical issues a second audit confirms: a critical issue of its own in the same field, on an overlapping quote. */
export function confirmCriticals(original: readonly AuditIssue[], second: Pick<AuditResult, "issues">, posted: FeedbackFieldAnswers): {
  confirmed: string[];
  unconfirmed: string[];
} {
  const confirmed: string[] = [];
  const unconfirmed: string[] = [];
  for (const issue of original.filter((item) => item.severity === "critical")) {
    const field = posted[issue.field] ?? "";
    const match = second.issues.some((other) => other.severity === "critical" && other.field === issue.field && quotesOverlap(field, issue.quote, other.quote));
    (match ? confirmed : unconfirmed).push(issue.id);
  }
  return { confirmed, unconfirmed };
}

export type ReplayCandidate =
  | { ok: true; fields: FeedbackFieldAnswers; evidence: "transcript" | "summary"; arm: string | null; writerModel: string | null }
  | { ok: false; reason: string };

function wellFormedFields(value: unknown): value is FeedbackFieldAnswers {
  return typeof value === "object" && value !== null && POST_CLASS_FEEDBACK_FIELDS.every((field) => typeof (value as Record<string, unknown>)[field] === "string");
}

/**
 * Candidate A: the transcript draft when the replay's transcript route drafted, the summary draft when it fell back
 * and the summary path drafted. Never for a guided post. Reasons are codes (a replay outcome's first part only: the
 * rest can quote the judge).
 */
export function replayCandidate(record: ReplayRecord | undefined, file: BundleFile): ReplayCandidate {
  if (file.target.guided || guidedStamp(file.target.pipeline) || guidedStamp(file.bundle.pipeline)) return { ok: false, reason: "guided_post" };
  if (!record) return { ok: false, reason: "no_replay_record" };
  const outcome = record.outcome.split(":")[0];
  if (record.outcome === "draft" && record.transcriptDraft?.outcome === "draft" && wellFormedFields(record.transcriptDraft.fields)) {
    return { ok: true, fields: normalizeFields(record.transcriptDraft.fields), evidence: "transcript", arm: record.transcriptDraft.arm, writerModel: record.transcriptDraft.writerModel };
  }
  if (outcome === "fallback" && record.summaryDraft?.outcome === "draft" && wellFormedFields(record.summaryDraft.fields)) {
    return { ok: true, fields: normalizeFields(record.summaryDraft.fields), evidence: "summary", arm: record.summaryDraft.arm, writerModel: record.summaryDraft.writerModel };
  }
  return { ok: false, reason: `replay_outcome:${outcome}` };
}

/** The posts row's reason: mode codes and one line, never lesson text. */
export function proposalReason(issues: readonly AuditIssue[], source: CorrectionProposal["source"]): string {
  const modes = [...new Set(issues.map((issue) => `${issue.mode} ${failureMode(issue.mode)?.slug ?? "unknown"} (${issue.severity})`))];
  const from = source === "replay" ? "the fixed pipeline's replay draft" : "the audit's minimal fix";
  return `${modes.join("; ")}: corrected from ${from}, verified by both judge levels and an Opus re-audit`.slice(0, 500);
}

const check = (name: string, pass: boolean, detail: string): ProposalCheck => ({ name, pass, detail: detail.slice(0, 300) });

/** The re-audit's verdict on a candidate, as checks. */
export function reauditChecks(result: AuditResult, input: {
  prior: readonly AuditIssue[];
  displayName: string;
  candidate: FeedbackFieldAnswers;
}): ProposalCheck[] {
  const checks: ProposalCheck[] = [];
  checks.push(check("reaudit_verdict", result.verdict === "accurate" || result.verdict === "cosmetic", result.verdict));
  const majorOmissions = result.omissions.filter((omission) => omission.severity === "major");
  checks.push(check("reaudit_omissions", majorOmissions.length === 0, majorOmissions.map((omission) => omission.what).join(",") || "none"));
  const review = new Map((result.priorIssueReview ?? []).map((entry) => [entry.id, entry.stillPresent]));
  const remaining = input.prior.filter((issue) => review.get(issue.id) !== false).map((issue) => `${issue.id}:${review.has(issue.id) ? "present" : "not_reviewed"}`);
  checks.push(check("reaudit_prior_issues", remaining.length === 0, remaining.join(",") || `${input.prior.length} gone`));
  const display = input.displayName.toLocaleLowerCase("en-US");
  const otherForms = result.names.studentCalled.filter((name) => name.trim().toLocaleLowerCase("en-US") !== display);
  checks.push(check(
    "reaudit_names",
    otherForms.length === 0 && result.names.otherPeopleNamed.length === 0,
    `student_forms:${otherForms.length},other_people:${result.names.otherPeopleNamed.length}`,
  ));
  const homeworkPresent = input.candidate.homework.trim() !== "" || result.homework.feedbackStatesHomework;
  checks.push(check(
    "reaudit_homework",
    !homeworkPresent || result.homework.tutorSetHomework === "yes",
    `present:${homeworkPresent},tutor_set:${result.homework.tutorSetHomework}`,
  ));
  return checks;
}

/** The posted draft's stamp, versions and ids only (a stamp can also carry the production judge's quotes). */
export function postedStampOf(pipeline: Record<string, unknown> | null): Record<string, string | number> {
  const kept: Record<string, string | number> = {};
  for (const key of ["promptVersion", "judgeVersion", "evidence", "arm", "commitSha", "postedFromCommit"]) {
    const value = pipeline?.[key];
    if ((typeof value === "string" && value.length <= 80) || (typeof value === "number" && Number.isFinite(value))) kept[key] = value;
  }
  return kept;
}

function nameUsed(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u").test(text);
}

// ---------------------------------------------------------------------------
// Paid calls (reserved, cached, never repeated)
// ---------------------------------------------------------------------------

interface VerifyState {
  ctx: NightContext;
  deps: VerifyDeps;
  /** Classes with a valid proposal already (an earlier run): never verified again. */
  proposed: ReadonlySet<string>;
  stop: NightlyStop | null;
  opusCalls: number;
  judgeCalls: number;
  claudeUsd: number;
  openrouterUsd: number;
  proposals: number;
}

type NotCalled = { kind: "not_called"; reason: string };

function callCacheFile(ctx: NightContext, key: string): string {
  return path.join(ctx.paths.verifyDir, "calls", `${createHash("sha256").update(key).digest("hex").slice(0, 40)}.json`);
}

/** Outcomes that are the account's, not the call's: never cached, so a later run may make the call. */
const ACCOUNT_OUTCOMES = new Set(["usage_limited", "auth"]);

function raise(state: VerifyState, stop: NightlyStop): never {
  if (!state.stop || (stop.exitCode === EXIT.safety && state.stop.exitCode !== EXIT.safety)) state.stop = stop;
  throw stop;
}

function checkStops(state: VerifyState): void {
  if (state.stop) throw state.stop;
  const stop = stopBeforeStep(state.ctx);
  if (stop) raise(state, stop);
}

function breach(state: VerifyState, breached: readonly string[], what: string): void {
  if (breached.length === 0) return;
  writeStopFile(`nightly verify breached ${breached.join(", ")} (${what})`, state.ctx.home, state.ctx.now());
  raise(state, new NightlyStop(`breach:${breached.join(",")}`, EXIT.safety));
}

/** One Opus 5.5 max call: cached by key, reserved first, never made twice for the same key. */
async function opusCall(state: VerifyState, input: {
  key: string;
  kind: "opus_audit" | "opus_reaudit";
  purpose: string;
  budgetUsd: number;
  prompt: { system: string; user: string };
}): Promise<ClaudeOutcome | NotCalled> {
  const file = callCacheFile(state.ctx, input.key);
  const cached = readJsonFile<{ key: string; outcome: ClaudeOutcome }>(file);
  if (cached?.key === input.key) return cached.outcome;
  const prior = state.deps.ledger.attempts(input.key);
  if (prior.failed + prior.succeeded > 0) return { kind: "not_called", reason: "already_attempted" };
  checkStops(state);
  const reserved = state.deps.ledger.reserve(input.kind, { key: input.key, estimateUsd: input.budgetUsd });
  if (!reserved.ok) raise(state, new NightlyStop(reserved.reason, EXIT.caps));
  state.opusCalls += 1;
  const outcome = await state.deps.run({
    purpose: input.purpose, key: input.key, system: input.prompt.system, user: input.prompt.user, schema: AUDIT_JSON_SCHEMA,
    budgetUsd: input.budgetUsd, timeoutMs: AUDIT_TIMEOUT_MS,
  });
  const costUsd = outcome.proof?.costUsd ?? null;
  state.claudeUsd += costUsd ?? 0;
  const { breached } = state.deps.ledger.settle(reserved.id, { actualUsd: costUsd, outcome: outcome.kind });
  if (!ACCOUNT_OUTCOMES.has(outcome.kind)) writeJsonAtomic(file, { key: input.key, at: state.ctx.now().toISOString(), outcome });
  breach(state, breached, input.purpose);
  if (ACCOUNT_OUTCOMES.has(outcome.kind)) raise(state, new NightlyStop(outcome.kind, EXIT.model));
  return outcome;
}

/** Both judge levels on one candidate: cached by key, never sent twice. */
async function judgeCall(state: VerifyState, input: { key: string; fields: FeedbackFieldAnswers; bundle: EvidenceBundle }): Promise<JudgeCandidateResult | NotCalled> {
  const file = callCacheFile(state.ctx, input.key);
  const cached = readJsonFile<{ key: string; result: JudgeCandidateResult }>(file);
  if (cached?.key === input.key) return cached.result;
  const attempted = ["medium", "high"].some((effort) => {
    const prior = state.deps.ledger.attempts(`${input.key}:${effort}`);
    return prior.failed + prior.succeeded > 0;
  });
  if (attempted) return { kind: "not_called", reason: "already_attempted" };
  checkStops(state);
  const result = await state.deps.judge(input);
  state.judgeCalls += result.calls;
  state.openrouterUsd += result.costUsd;
  if (!result.capStop) writeJsonAtomic(file, { key: input.key, at: state.ctx.now().toISOString(), result });
  breach(state, result.breached, "judge");
  if (result.capStop) raise(state, new NightlyStop(result.capStop, EXIT.caps));
  return result;
}

// ---------------------------------------------------------------------------
// One class
// ---------------------------------------------------------------------------

function verifyRecordFile(ctx: NightContext, wiseSessionId: string): string {
  if (!/^[0-9a-f]{24}$/iu.test(wiseSessionId)) throw new Error("Not a Wise session id");
  return path.join(ctx.paths.verifyDir, `${wiseSessionId}.json`);
}

interface Candidate {
  source: CorrectionProposal["source"];
  fields: FeedbackFieldAnswers;
  evidence: CorrectionProposal["evidence"];
  arm: string | null;
  extraChecks: ProposalCheck[];
  pipeline: Record<string, unknown>;
}

/** Every check of one candidate, cheapest first, stopping at the first failure. */
async function checkCandidate(state: VerifyState, input: {
  file: BundleFile;
  record: AuditRecord & { result: AuditResult };
  serious: readonly AuditIssue[];
  candidate: Candidate;
  context: Omit<TextProblemInput, "fields">;
}): Promise<ProposalCheck[]> {
  const { file, candidate, context } = input;
  const posted = postedFieldsOf(file);
  const hash = fieldsHash(candidate.fields);
  const sid = file.target.wiseSessionId;
  const checks: ProposalCheck[] = [...input.candidate.extraChecks];
  const failed = () => checks.some((item) => !item.pass);
  if (failed()) return checks;

  const ratio = lengthRatio(posted, candidate.fields);
  checks.push(check("length_ratio", ratio >= MIN_LENGTH_RATIO && ratio <= MAX_LENGTH_RATIO, ratio.toFixed(2)));
  if (failed()) return checks;

  let problems: string[];
  try {
    problems = correctionTextProblems({ ...context, fields: candidate.fields }).map((problem) => `${problem.code}${problem.field ? `@${problem.field}` : ""}`);
  } catch (error) {
    problems = [`check_failed:${error instanceof Error ? error.name : "Error"}`];
  }
  checks.push(check("text_problems", problems.length === 0, problems.join(",") || "none"));
  if (failed()) return checks;

  const combined = POST_CLASS_FEEDBACK_FIELDS.map((field) => candidate.fields[field]).join("\n");
  checks.push(check("display_name", nameUsed(combined, context.studentDisplayName), "deterministic"));
  if (failed()) return checks;

  const judged = await judgeCall(state, { key: `judge:${sid}:${hash}`, fields: candidate.fields, bundle: file.bundle });
  if ("kind" in judged) {
    checks.push(check("judge", false, judged.reason));
    return checks;
  }
  checks.push(check(
    "judge",
    judged.faithful,
    judged.error ?? (judged.faithful ? `medium+high faithful (${judged.evidence})` : `problems:${judged.problems.length}`),
  ));
  if (failed()) return checks;

  // The candidate's own deterministic findings (its text problems are none by now: only the billing floors remain).
  const prechecks = runPrechecks({
    bundle: { ...file.bundle, postedFields: { ...candidate.fields } },
    target: { ...file.target, fields: { ...candidate.fields } },
    otherStudentNames: context.otherStudentNames ?? [],
    priorFeedback: context.priorFeedback,
  }).filter((finding) => finding.severity !== "info");
  const reaudit = await opusCall(state, {
    key: `reaudit:${sid}:${hash}:a${AUDIT_VERSION}`,
    kind: "opus_reaudit",
    purpose: "reaudit",
    budgetUsd: state.ctx.caps.perReauditUsd,
    prompt: buildAuditPrompt({ bundle: file.bundle, prechecks, priorIssues: input.record.result.issues, fields: { ...candidate.fields } }),
  });
  if (reaudit.kind !== "success") {
    checks.push(check("reaudit", false, reaudit.kind === "not_called" ? reaudit.reason : `${reaudit.kind}:${reaudit.reason}`));
    return checks;
  }
  const parsed = parseAuditResult(reaudit.value, {
    postFields: { ...candidate.fields }, evidenceText: evidenceTextOf(file.bundle), grade: file.bundle.grade,
  });
  if (!parsed.ok) {
    checks.push(check("reaudit", false, "invalid"));
    return checks;
  }
  checks.push(check("reaudit", true, `Opus5.5max ${reaudit.proof.models.join("+")}`));
  checks.push(...reauditChecks(parsed.result, { prior: input.serious, displayName: context.studentDisplayName, candidate: candidate.fields }));
  return checks;
}

/** Decide one class (see the module comment); throws a NightlyStop to end the step. */
async function verifyClass(state: VerifyState, file: BundleFile, record: AuditRecord | null): Promise<VerifyClassRecord | { skipped: string }> {
  const { ctx, deps } = state;
  const sid = file.target.wiseSessionId;
  if (!record?.result) return { skipped: "not_audited" };
  const audited = record as AuditRecord & { result: AuditResult };
  const serious = seriousIssues(audited.result);
  if (serious.length === 0) return { skipped: "nothing_to_correct" };
  const recordFile = verifyRecordFile(ctx, sid);
  const previous = readJsonFile<VerifyClassRecord>(recordFile);
  if (previous && previous.fieldsSha256 === file.target.fieldsSha256) return previous;
  if (state.proposed.has(sid)) return { skipped: "proposal_exists" };

  const base: VerifyClassRecord = {
    wiseSessionId: sid,
    night: ctx.night,
    fieldsSha256: file.target.fieldsSha256,
    status: "no_candidate",
    reasons: [],
    issues: serious.map((issue) => ({ id: issue.id, mode: issue.mode, severity: issue.severity, field: issue.field, confidence: issue.confidence })),
    confirmation: null,
    candidates: [],
    proposalFile: null,
    at: ctx.now().toISOString(),
  };
  const decide = (patch: Partial<VerifyClassRecord>): VerifyClassRecord => {
    const decided = { ...base, ...patch, at: ctx.now().toISOString() };
    writeJsonAtomic(recordFile, decided);
    return decided;
  };

  const kevin = needsKevinReasons(serious, file.prechecks);
  if (kevin.length > 0) return decide({ status: "needs_kevin", reasons: kevin });
  const blocked = blockedReasons(file);
  if (blocked.length > 0) return decide({ status: "blocked", reasons: blocked });
  if (state.proposals >= ctx.caps.maxCorrectionsPerNight) return { skipped: "over_cap" };

  const posted = postedFieldsOf(file);
  const criticals = serious.filter((issue) => issue.severity === "critical");
  if (criticals.length > 0) {
    const second = await opusCall(state, {
      key: `confirm:${sid}:${file.target.fieldsSha256}:a${AUDIT_VERSION}`,
      kind: "opus_audit",
      purpose: "confirm",
      budgetUsd: ctx.caps.perAuditUsd,
      prompt: buildAuditPrompt({ bundle: file.bundle, prechecks: file.prechecks }),
    });
    const parsed = second.kind === "success"
      ? parseAuditResult(second.value, { postFields: file.bundle.postedFields, evidenceText: evidenceTextOf(file.bundle), grade: file.bundle.grade })
      : null;
    if (!parsed?.ok) {
      const outcome = second.kind === "success" ? "invalid" : second.kind === "not_called" ? second.reason : second.kind;
      return decide({
        status: "needs_kevin",
        reasons: [`critical_unconfirmed:${outcome}`],
        confirmation: { outcome, confirmed: [], unconfirmed: criticals.map((issue) => issue.id) },
      });
    }
    const confirmation = confirmCriticals(serious, parsed.result, posted);
    base.confirmation = { outcome: "success", ...confirmation };
    if (confirmation.unconfirmed.length > 0) {
      return decide({ status: "needs_kevin", reasons: confirmation.unconfirmed.map((id) => `critical_unconfirmed:${id}`) });
    }
  }

  const priorFeedback = await deps.priorFeedback(file);
  const otherStudentNames = await deps.otherStudentNames(file);
  const context = textProblemContext(file, { priorFeedback, otherStudentNames });
  if (!context) return decide({ status: "blocked", reasons: ["student_unknown"] });

  const pipelineBase = {
    auditVersion: AUDIT_VERSION, auditPromptVersion: AUDIT_PROMPT_VERSION, judgePromptVersion: JUDGE_PROMPT_VERSION,
    verifyCommit: deps.commit ?? null, auditBundleHash: record.bundleHash, posted: postedStampOf(file.target.pipeline),
  };
  const candidates: Candidate[] = [];
  const unavailable: CandidateRecord[] = [];
  const offline = (source: Candidate["source"], reason: string): CandidateRecord => ({
    source, fields: null, fieldsHash: null, evidence: file.target.evidence, arm: file.target.arm, checks: [], passed: false, unavailable: reason,
  });
  if (deps.replay) {
    const replay = replayCandidate(deps.replay.find((entry) => entry.wiseSessionId === sid), file);
    if (!replay.ok) unavailable.push(offline("replay", replay.reason));
    else if (fieldsHash(replay.fields) === file.target.fieldsSha256) unavailable.push(offline("replay", "replay_unchanged"));
    else {
      candidates.push({
        source: "replay", fields: replay.fields, evidence: replay.evidence, arm: replay.arm, extraChecks: [],
        pipeline: { ...pipelineBase, source: "replay", replayDraft: replay.evidence, writerModel: replay.writerModel, arm: replay.arm },
      });
    }
  }
  const fixed = applyMinimalFixes(posted, serious);
  if (!fixed.ok) unavailable.push(offline("minimal_fix", fixed.reason));
  else {
    candidates.push({
      source: "minimal_fix", fields: fixed.fields, evidence: file.target.evidence, arm: file.target.arm,
      extraChecks: [check("word_change", true, `${Math.round(fixed.wordShare * 100)}%`)],
      pipeline: { ...pipelineBase, source: "minimal_fix", fixes: fixed.applied },
    });
  }

  // A confirmed critical travels with the proposal as a check of its own (`correct` requires it).
  const confirmed = base.confirmation?.confirmed.length ? [check("critical_confirmation", true, `confirmed:${base.confirmation.confirmed.join(",")}`)] : [];
  const tried: CandidateRecord[] = [...unavailable];
  for (const candidate of candidates) {
    const checks = [...confirmed, ...await checkCandidate(state, { file, record: audited, serious, candidate, context })];
    const passed = checks.length > 0 && checks.every((item) => item.pass);
    const hash = fieldsHash(candidate.fields);
    tried.push({ source: candidate.source, fields: candidate.fields, fieldsHash: hash, evidence: candidate.evidence, arm: candidate.arm, checks, passed, unavailable: null });
    if (!passed) continue;
    // The cap is taken now, before anything is awaited again.
    if (state.proposals >= ctx.caps.maxCorrectionsPerNight) return { skipped: "over_cap" };
    state.proposals += 1;
    const proposal: CorrectionProposal = {
      version: 1,
      night: ctx.night,
      wiseSessionId: sid,
      fieldsSha256: file.target.fieldsSha256,
      fields: candidate.fields,
      fieldsHash: hash,
      source: candidate.source,
      evidence: candidate.evidence,
      arm: candidate.arm,
      issues: serious.map((issue) => ({ id: issue.id, mode: issue.mode, severity: issue.severity as "critical" | "major" })),
      modes: [...new Set(serious.map((issue) => issue.mode))].sort(),
      severity: criticals.length > 0 ? "critical" : "major",
      criticalCategory: criticals.find((issue) => issue.criticalCategory)?.criticalCategory ?? null,
      checks,
      reason: proposalReason(serious, candidate.source),
      rootCauseRef: deps.rootCauseRef,
      pipeline: candidate.pipeline,
      createdAt: ctx.now().toISOString(),
    };
    const proposalFile = writeProposal(ctx.paths.proposalsDir, proposal, deps.hmacKey);
    return decide({ status: "proposed", reasons: [candidate.source], candidates: tried, proposalFile });
  }
  const firstFailures = tried.map((candidate) => `${candidate.source}:${candidate.unavailable ?? candidate.checks.find((item) => !item.pass)?.name ?? "unchecked"}`);
  return decide({ status: "no_candidate", reasons: firstFailures, candidates: tried });
}

// ---------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------

/**
 * The replay's records (`<dir>/records.json`, as `autowrite-online-feedback.ts --replay --out=<dir>` writes them), or
 * why they cannot be used.
 */
export function readReplayRecords(dir: string): { ok: true; records: ReplayRecord[] } | { ok: false; reason: string } {
  const value = readJsonFile<unknown>(path.join(dir, "records.json"));
  if (!Array.isArray(value)) return { ok: false, reason: "replay_records_unreadable" };
  const records = value.filter((entry): entry is ReplayRecord =>
    typeof entry === "object" && entry !== null && typeof (entry as { wiseSessionId?: unknown }).wiseSessionId === "string"
    && typeof (entry as { outcome?: unknown }).outcome === "string");
  if (records.length !== value.length) return { ok: false, reason: "replay_records_malformed" };
  return { ok: true, records };
}

/** Valid proposals already written tonight (they count toward the cap). */
function existingProposals(ctx: NightContext, key: Buffer): Set<string> {
  const found = new Set<string>();
  for (const entry of readProposalFiles(ctx.paths.proposalsDir)) {
    const verified = verifyProposal(entry.value, key);
    if (verified.ok && verified.proposal.wiseSessionId === entry.wiseSessionId) found.add(entry.wiseSessionId);
  }
  return found;
}

async function lanes<T>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<void>, stopped: () => boolean): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      if (stopped()) return;
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  }));
}

/** `verify`: see the module comment. Prints one summary; a stop keeps every class already decided. */
export async function stepVerify(ctx: NightContext, deps: VerifyDeps): Promise<StepResult> {
  const result = (input: Partial<StepResult> & { summary: Record<string, unknown> }): StepResult => ({
    ok: input.ok ?? true, stop: input.stop ?? null, next: input.next ?? null, summary: input.summary, exitCode: input.exitCode ?? EXIT.ok,
  });
  const early = stopBeforeStep(ctx);
  if (early) return result({ ok: false, stop: early.reason, next: "verify", exitCode: early.exitCode, summary: { step: "verify", night: ctx.night } });
  if (!deps.rootCauseRef.trim()) {
    return result({ ok: false, stop: "root_cause_ref_missing", exitCode: EXIT.usage, summary: { step: "verify", night: ctx.night } });
  }
  const targets = readTargets(ctx.paths);
  const wanted = deps.sessionIds && deps.sessionIds.length > 0 ? new Set(deps.sessionIds) : null;
  const files = readNightBundles(ctx.paths, targets).filter((file) => !wanted || wanted.has(file.target.wiseSessionId));
  const pairs = nightAuditRecords(ctx, files);
  const proposed = existingProposals(ctx, deps.hmacKey);
  const state: VerifyState = {
    ctx, deps, proposed, stop: null, opusCalls: 0, judgeCalls: 0, claudeUsd: 0, openrouterUsd: 0, proposals: proposed.size,
  };
  const decided: VerifyClassRecord[] = [];
  const skipped: Array<{ wiseSessionId: string; reason: string }> = [];
  await lanes(pairs, ctx.caps.auditConcurrency, async ({ file, record }) => {
    try {
      const outcome = await verifyClass(state, file, record);
      if ("skipped" in outcome) skipped.push({ wiseSessionId: file.target.wiseSessionId, reason: outcome.skipped });
      else decided.push(outcome);
      ctx.log?.(`verify ${file.target.wiseSessionId}: ${"skipped" in outcome ? `skipped (${outcome.skipped})` : `${outcome.status} ${outcome.reasons.join(",")}`}`);
    } catch (error) {
      // A stop leaves the class undecided: a later run takes it up again (its paid calls are never repeated). Any
      // other failure (a database read) skips the class only.
      if (!(error instanceof NightlyStop)) {
        skipped.push({ wiseSessionId: file.target.wiseSessionId, reason: `error:${error instanceof Error ? error.name : "Error"}` });
        ctx.log?.(`verify ${file.target.wiseSessionId}: error (${error instanceof Error ? error.message.slice(0, 120) : "unknown"})`);
      }
    }
  }, () => state.stop !== null);
  const list = (status: VerifyClassStatus) => decided.filter((item) => item.status === status)
    .map((item) => ({ wiseSessionId: item.wiseSessionId, reasons: item.reasons }));
  const summary = {
    step: "verify",
    night: ctx.night,
    classes: pairs.length,
    proposed: decided.filter((item) => item.status === "proposed").map((item) => ({ wiseSessionId: item.wiseSessionId, source: item.reasons[0] })),
    needsKevin: list("needs_kevin"),
    noCandidate: list("no_candidate"),
    blocked: list("blocked"),
    skipped: Object.fromEntries(["not_audited", "nothing_to_correct", "over_cap", "proposal_exists"].map((reason) => [reason, skipped.filter((item) => item.reason === reason).length])),
    errors: skipped.filter((item) => item.reason.startsWith("error:")),
    overCap: skipped.filter((item) => item.reason === "over_cap").map((item) => item.wiseSessionId),
    proposalsTonight: state.proposals,
    calls: { opus: state.opusCalls, judge: state.judgeCalls },
    costUsd: { claude: Math.round(state.claudeUsd * 10_000) / 10_000, openrouter: Math.round(state.openrouterUsd * 10_000) / 10_000 },
  };
  if (state.stop) return result({ ok: false, stop: state.stop.reason, next: "verify", exitCode: state.stop.exitCode, summary });
  return result({ summary, next: summary.proposed.length > 0 || state.proposals > 0 ? "correct" : null });
}
