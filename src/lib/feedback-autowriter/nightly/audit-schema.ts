import { z } from "zod";
import {
  FAILURE_MODE_IDS,
  ROOT_STAGES,
  failureMode,
  maxSeverity,
  severityRank,
  type FailureSeverity,
} from "./modes";
import type { EvidenceGrade } from "./types";

/**
 * What the nightly Opus audit returns for one posted text, and what its synthesis returns for one night
 * (quick 261003-12b). The model's JSON is validated twice: by `--json-schema` in the CLI (shape only), then here with
 * zod plus deterministic post-checks that only ever make a result stricter (fail closed):
 * - every quote said to come from the feedback must really be in it, and every evidence quote must really be in the
 *   evidence (a "supported" claim whose evidence cannot be found becomes unsupported);
 * - an unsupported, contradicted or misattributed claim that no issue covers gets an issue of its own;
 * - severities are raised to their failure mode's floor, and the verdict to the worst issue.
 * Bump `AUDIT_VERSION` whenever the schema or these rules change: cached audits are keyed by it.
 * v2 (3 Oct): the CLI's `--json-schema` carries no lengths, id patterns or item caps (they are stripped for structured
 * output), so the first live audit was rejected for "claim_1"-style ids and a fifth evidence quote. The model's JSON is
 * now normalised before zod (`normaliseAuditOutput`: ids renumbered, lists and strings clipped) and the prompt states
 * the limits; only structural problems still fail.
 * v3 (10 Oct): invalidate audits that did not use the post's recorded format and style guides.
 */
export const AUDIT_VERSION = 3;

/** Every list and string limit of `AuditResultSchema`, stated in the prompt and applied by `normaliseAuditOutput`. */
export const AUDIT_LIMITS = {
  claims: 40, evidencePerItem: 4, issues: 20, omissions: 5, omissionEvidence: 3, homeworkEvidence: 2, claimIdsPerIssue: 10,
  studentCalled: 5, otherPeopleNamed: 10, candidateReview: 20, notes: 5, priorIssueReview: 20,
  quote: 400, gloss: 300, locator: 40, claimText: 600, issueQuote: 600, mechanism: 500, fixText: 600, omissionDetail: 300,
  reason: 300, note: 200, name: 60, code: 80, summaryLine: 160, priorNote: 300, priorId: 8,
} as const;

export const FEEDBACK_FIELDS = ["topics", "performance", "improvement", "homework"] as const;

export type AuditedField = (typeof FEEDBACK_FIELDS)[number];

const SEVERITIES = ["critical", "major", "cosmetic"] as const;
const CRITICAL_CATEGORIES = ["wrong_person", "billing_status", "invented_content", "should_not_have_posted"] as const;

const EvidenceQuoteSchema = z.object({
  source: z.enum(["transcript", "summary", "zoom", "class_details", "atom"]),
  /** "mm:ss" in a transcript, a paragraph or line number in a summary; null when there is none. */
  locator: z.string().max(40).nullable(),
  speaker: z.enum(["TUTOR", "STUDENT", "OTHER", "UNKNOWN"]).nullable(),
  /** Verbatim from the evidence, in its original language. */
  quote: z.string().min(1).max(400),
  /** English gloss of a Thai quote; null for English. */
  gloss: z.string().max(300).nullable(),
}).strict();

const ClaimSchema = z.object({
  id: z.string().regex(/^c\d{1,3}$/),
  field: z.enum(FEEDBACK_FIELDS),
  /** Verbatim from the posted field. */
  text: z.string().min(1).max(600),
  kind: z.enum(["topic", "student_action", "student_result", "judgement", "homework", "suggestion", "other"]),
  verdict: z.enum(["supported", "partly_supported", "unsupported", "contradicted", "misattributed", "advice_ok"]),
  evidence: z.array(EvidenceQuoteSchema).max(4),
}).strict();

const MinimalFixSchema = z.object({
  action: z.enum(["delete_span", "replace_span", "clear_field"]),
  /** Verbatim from the posted field. */
  from: z.string().min(1).max(600),
  /** The replacement for `replace_span`; null otherwise. Never adds a fact the evidence does not show. */
  to: z.string().max(600).nullable(),
}).strict();

const IssueSchema = z.object({
  id: z.string().regex(/^i\d{1,2}$/),
  claimIds: z.array(z.string().max(8)).max(10),
  field: z.enum(FEEDBACK_FIELDS),
  /** Verbatim from the posted field. */
  quote: z.string().min(1).max(600),
  mode: z.enum(FAILURE_MODE_IDS),
  severity: z.enum(SEVERITIES),
  criticalCategory: z.enum(CRITICAL_CATEGORIES).nullable(),
  rootStage: z.enum(ROOT_STAGES),
  /** The existing guard that should have caught it: none means a new guard is needed. */
  defense: z.enum(["none", "prompt_rule", "judge_list", "validator"]),
  /** Why it happened, in plain words. */
  mechanism: z.string().min(1).max(500),
  /** What the lesson actually shows; empty when nothing in the evidence supports the text at all. */
  evidence: z.array(EvidenceQuoteSchema).max(4),
  minimalFix: MinimalFixSchema.nullable(),
  confidence: z.enum(["high", "medium", "low"]),
}).strict();

const OmissionSchema = z.object({
  what: z.enum(["main_topic_missing", "homework_set_not_reported", "other"]),
  detail: z.string().max(300),
  evidence: z.array(EvidenceQuoteSchema).max(3),
  severity: z.enum(["major", "cosmetic"]),
}).strict();

export const AuditResultSchema = z.object({
  verdict: z.enum(["accurate", "cosmetic", "major", "critical", "insufficient_evidence"]),
  claims: z.array(ClaimSchema).max(40),
  issues: z.array(IssueSchema).max(20),
  omissions: z.array(OmissionSchema).max(5),
  homework: z.object({
    feedbackStatesHomework: z.boolean(),
    tutorSetHomework: z.enum(["yes", "no", "unclear"]),
    evidence: z.array(EvidenceQuoteSchema).max(2),
  }).strict(),
  names: z.object({
    /** Every name the feedback uses for the student. */
    studentCalled: z.array(z.string().max(60)).max(5),
    /** Every other person the feedback names. */
    otherPeopleNamed: z.array(z.string().max(60)).max(10),
  }).strict(),
  /** One entry per deterministic candidate the auditor was asked to confirm. */
  candidateReview: z.array(z.object({
    code: z.string().max(80),
    confirmed: z.boolean(),
    reason: z.string().max(300),
  }).strict()).max(20),
  evidenceQuality: z.object({
    transcript: z.enum(["full", "partial", "absent"]),
    speakerLabels: z.enum(["verified", "inferred_ok", "suspect_swap", "unusable", "not_applicable"]),
    summaryVsTranscript: z.enum(["agrees", "conflicts", "no_summary", "no_transcript"]),
    notes: z.array(z.string().max(200)).max(5),
  }).strict(),
  /** Re-audits only: whether each earlier issue is still present in the new text. */
  priorIssueReview: z.array(z.object({
    id: z.string().max(8),
    stillPresent: z.boolean(),
    note: z.string().max(300),
  }).strict()).max(20).nullable(),
  /** One line for the morning report; never a name or a quote. */
  summaryLine: z.string().max(160),
}).strict();

export type AuditResult = z.infer<typeof AuditResultSchema>;
export type AuditIssue = AuditResult["issues"][number];
export type AuditClaim = AuditResult["claims"][number];
export type AuditVerdict = AuditResult["verdict"];

/** What `parseAuditResult` adds to the model's JSON. */
export interface AuditPostCheck {
  /** Issue ids whose quote is not in the posted field (their minimal fix is dropped). */
  quoteMismatchIssues: string[];
  /** Claim ids marked supported whose evidence quotes are not in the evidence (now unsupported). */
  unverifiedSupport: string[];
  /** Issue ids this check added for uncovered unsupported claims. */
  addedIssues: string[];
  /** Issue ids whose severity was raised to their mode's floor. */
  raisedIssues: string[];
  /** Whether the verdict was raised to match the worst issue or omission. */
  verdictRaised: boolean;
}

export interface CheckedAuditResult extends AuditResult {
  postCheck: AuditPostCheck;
}

/**
 * Normalises text for "is this quote really there" checks: case, every kind of whitespace (Thai has no spaces between
 * words, and transcripts are re-rendered), curly quotes and dashes.
 */
export function normaliseForQuote(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, "\"")
    .replace(/[‐-―−]/g, "-")
    .replace(/…/g, "...")
    .replace(/[\s​‌‍﻿]+/g, "");
}

function contains(haystack: string, needle: string): boolean {
  const n = normaliseForQuote(needle);
  return n.length > 0 && normaliseForQuote(haystack).includes(n);
}

const INSUFFICIENT_GRADES: readonly EvidenceGrade[] = ["secondary_only", "none"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clipString(value: unknown, max: number, ellipsis = false): unknown {
  if (typeof value !== "string" || value.length <= max) return value;
  return ellipsis ? `${value.slice(0, max - 1)}…` : value.slice(0, max);
}

function clipList<T>(value: unknown, max: number, each: (item: unknown) => T = (item) => item as T): unknown {
  return Array.isArray(value) ? value.slice(0, max).map(each) : value;
}

function nullIfMissing(record: Record<string, unknown>, key: string): void {
  if (record[key] === undefined) record[key] = null;
}

function isBlank(value: unknown): boolean {
  return typeof value === "string" && value.trim() === "";
}

function dropBlankQuotes(value: unknown): unknown {
  return Array.isArray(value) ? value.filter((item) => !isRecord(item) || !isBlank(item.quote)) : value;
}

function normaliseQuote(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const quote = { ...value };
  // A prefix of a verbatim quote is still verbatim, so clipping keeps the quote checkable.
  quote.quote = clipString(quote.quote, AUDIT_LIMITS.quote);
  nullIfMissing(quote, "gloss");
  quote.gloss = clipString(quote.gloss, AUDIT_LIMITS.gloss);
  nullIfMissing(quote, "locator");
  quote.locator = clipString(quote.locator, AUDIT_LIMITS.locator);
  nullIfMissing(quote, "speaker");
  return quote;
}

/**
 * Makes the model's JSON fit `AuditResultSchema` where only presentation is off: claim ids become c1, c2, … and issue
 * ids i1, i2, … in order (issue `claimIds` follow; unknown ones are dropped), lists keep their first N items, strings are
 * clipped, and missing nullable keys become null. A minimal fix whose text would have to be clipped is dropped instead
 * (a clipped `from` would edit the wrong span). Structural problems (a wrong enum, a missing object) are left for zod.
 */
export function normaliseAuditOutput(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const out: Record<string, unknown> = { ...raw };
  const L = AUDIT_LIMITS;

  const claimIds = new Map<string, string>();
  // A claim with no text quotes nothing and cannot be checked: dropped before numbering (3 Oct: an empty quote failed a
  // whole paid audit). An evidence quote with no text is dropped; an issue keeps its place with a visible placeholder.
  if (Array.isArray(out.claims)) out.claims = out.claims.filter((item) => !isRecord(item) || !isBlank(item.text));
  out.claims = clipList(out.claims, L.claims, (item) => {
    if (!isRecord(item)) return item;
    const claim = { ...item };
    const next = `c${claimIds.size + 1}`;
    if (typeof claim.id === "string" && !claimIds.has(claim.id)) claimIds.set(claim.id, next);
    claim.id = next;
    claim.text = clipString(claim.text, L.claimText);
    claim.evidence = clipList(dropBlankQuotes(claim.evidence), L.evidencePerItem, normaliseQuote);
    return claim;
  });

  let issueNumber = 0;
  out.issues = clipList(out.issues, L.issues, (item) => {
    if (!isRecord(item)) return item;
    const issue = { ...item };
    issueNumber += 1;
    issue.id = `i${issueNumber}`;
    issue.claimIds = Array.isArray(issue.claimIds)
      ? [...new Set(issue.claimIds.map((id) => claimIds.get(String(id))).filter((id): id is string => Boolean(id)))].slice(0, L.claimIdsPerIssue)
      : [];
    issue.quote = isBlank(issue.quote) ? "(no quote given)" : clipString(issue.quote, L.issueQuote);
    issue.mechanism = isBlank(issue.mechanism) ? "(not given)" : clipString(issue.mechanism, L.mechanism);
    nullIfMissing(issue, "criticalCategory");
    issue.evidence = clipList(dropBlankQuotes(issue.evidence), L.evidencePerItem, normaliseQuote);
    if (issue.minimalFix === undefined) issue.minimalFix = null;
    if (isRecord(issue.minimalFix)) {
      const fix = { ...issue.minimalFix };
      if (fix.to === undefined) fix.to = null;
      const tooLong = (typeof fix.from === "string" && fix.from.length > L.fixText) || (typeof fix.to === "string" && fix.to.length > L.fixText);
      issue.minimalFix = tooLong ? null : fix;
    }
    return issue;
  });

  out.omissions = clipList(out.omissions, L.omissions, (item) => {
    if (!isRecord(item)) return item;
    const omission = { ...item };
    omission.detail = clipString(omission.detail, L.omissionDetail);
    omission.evidence = clipList(dropBlankQuotes(omission.evidence), L.omissionEvidence, normaliseQuote);
    return omission;
  });

  if (isRecord(out.homework)) {
    const homework = { ...out.homework };
    homework.evidence = clipList(dropBlankQuotes(homework.evidence), L.homeworkEvidence, normaliseQuote);
    out.homework = homework;
  }
  if (isRecord(out.names)) {
    const names = { ...out.names };
    names.studentCalled = clipList(names.studentCalled, L.studentCalled, (name) => clipString(name, L.name));
    names.otherPeopleNamed = clipList(names.otherPeopleNamed, L.otherPeopleNamed, (name) => clipString(name, L.name));
    out.names = names;
  }
  if (out.candidateReview === undefined) out.candidateReview = [];
  out.candidateReview = clipList(out.candidateReview, L.candidateReview, (item) => {
    if (!isRecord(item)) return item;
    return { ...item, code: clipString(item.code, L.code), reason: clipString(item.reason, L.reason) };
  });
  if (isRecord(out.evidenceQuality)) {
    const quality = { ...out.evidenceQuality };
    quality.notes = clipList(quality.notes, L.notes, (note) => clipString(note, L.note));
    out.evidenceQuality = quality;
  }
  if (out.priorIssueReview === undefined) out.priorIssueReview = null;
  out.priorIssueReview = clipList(out.priorIssueReview, L.priorIssueReview, (item) => {
    if (!isRecord(item)) return item;
    return { ...item, id: clipString(item.id, L.priorId), note: clipString(item.note, L.priorNote) };
  });
  out.summaryLine = clipString(out.summaryLine, L.summaryLine, true);
  return out;
}

/** Which failure mode an uncovered claim falls under, and how severe it is at least. */
function modeForUncoveredClaim(claim: AuditClaim): { mode: AuditIssue["mode"]; severity: FailureSeverity } {
  if (claim.verdict === "misattributed") return { mode: "M01", severity: "critical" };
  if (claim.kind === "homework") return { mode: "M03", severity: "major" };
  if (claim.kind === "judgement") return { mode: "M06", severity: "major" };
  if (claim.verdict === "contradicted") return { mode: "M05", severity: "major" };
  // An unsupported action, result or topic: invented or merely overstated is the owner's D-02 line, which the model
  // drew by not raising it; a person reviews it as major.
  return { mode: "M06", severity: "major" };
}

const FACTUAL_KINDS = new Set<AuditClaim["kind"]>(["topic", "student_action", "student_result", "judgement", "homework"]);
const FAILING_VERDICTS = new Set<AuditClaim["verdict"]>(["unsupported", "contradicted", "misattributed"]);

/**
 * Validates the model's audit and applies the deterministic post-checks above. `evidenceText` is every piece of
 * evidence the model was given (transcript, summary, captions, class details), joined. Returns a reason when the
 * output is not usable at all (the runner retries once on that).
 */
export function parseAuditResult(
  value: unknown,
  ctx: { postFields: Record<string, string>; evidenceText: string; grade: EvidenceGrade },
): { ok: true; result: CheckedAuditResult } | { ok: false; reason: string } {
  const parsed = AuditResultSchema.safeParse(normaliseAuditOutput(value));
  if (!parsed.success) return { ok: false, reason: `schema: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` };
  const result: AuditResult = structuredClone(parsed.data);

  if (result.verdict === "insufficient_evidence" && !INSUFFICIENT_GRADES.includes(ctx.grade)) {
    return { ok: false, reason: `insufficient_evidence claimed with ${ctx.grade} evidence` };
  }
  const issueIds = new Set(result.issues.map((issue) => issue.id));
  if (issueIds.size !== result.issues.length) return { ok: false, reason: "duplicate issue ids" };

  const postCheck: AuditPostCheck = { quoteMismatchIssues: [], unverifiedSupport: [], addedIssues: [], raisedIssues: [], verdictRaised: false };
  const fieldText = (field: AuditedField) => ctx.postFields[field] ?? "";

  // 1. Supported claims need evidence that is really there.
  for (const claim of result.claims) {
    if (claim.verdict !== "supported" && claim.verdict !== "partly_supported") continue;
    if (!FACTUAL_KINDS.has(claim.kind)) continue;
    const found = claim.evidence.some((quote) => contains(ctx.evidenceText, quote.quote));
    if (!found) {
      claim.verdict = "unsupported";
      postCheck.unverifiedSupport.push(claim.id);
    }
  }

  // 2. Issue quotes must be in the post; a fix built on a misquote is dropped, the issue is kept.
  for (const issue of result.issues) {
    if (!contains(fieldText(issue.field), issue.quote)) {
      postCheck.quoteMismatchIssues.push(issue.id);
      issue.minimalFix = null;
      continue;
    }
    if (issue.minimalFix && !contains(fieldText(issue.field), issue.minimalFix.from)) {
      postCheck.quoteMismatchIssues.push(issue.id);
      issue.minimalFix = null;
    }
  }

  // 3. Every failing factual claim is covered by an issue.
  const covered = new Set(result.issues.flatMap((issue) => issue.claimIds));
  let next = result.issues.length + 1;
  for (const claim of result.claims) {
    if (!FACTUAL_KINDS.has(claim.kind) || !FAILING_VERDICTS.has(claim.verdict) || covered.has(claim.id)) continue;
    const { mode, severity } = modeForUncoveredClaim(claim);
    let id = `i${next++}`;
    while (issueIds.has(id)) id = `i${next++}`;
    issueIds.add(id);
    result.issues.push({
      id,
      claimIds: [claim.id],
      field: claim.field,
      quote: claim.text,
      mode,
      severity,
      criticalCategory: severity === "critical" ? (failureMode(mode)?.criticalCategory ?? "invented_content") : null,
      rootStage: "writer",
      defense: "none",
      mechanism: `Added by the deterministic check: claim ${claim.id} is ${claim.verdict} and no issue covered it.`,
      evidence: [],
      minimalFix: null,
      confidence: "low",
    });
    postCheck.addedIssues.push(id);
  }

  // 4. Severity floors: a critical-by-definition mode is always critical, with its category.
  for (const issue of result.issues) {
    const mode = failureMode(issue.mode);
    if (!mode) continue;
    if (mode.defaultSeverity === "critical" && issue.severity !== "critical") {
      issue.severity = "critical";
      postCheck.raisedIssues.push(issue.id);
    }
    if (issue.severity === "critical" && issue.criticalCategory === null) {
      issue.criticalCategory = mode.criticalCategory ?? "invented_content";
    }
    if (issue.severity !== "critical") issue.criticalCategory = null;
  }

  // 5. The verdict is at least the worst issue or omission.
  if (result.verdict !== "insufficient_evidence") {
    let worst: FailureSeverity | null = null;
    for (const issue of result.issues) worst = worst ? maxSeverity(worst, issue.severity) : issue.severity;
    for (const omission of result.omissions) worst = worst ? maxSeverity(worst, omission.severity) : omission.severity;
    const declared: FailureSeverity | null = result.verdict === "accurate" ? null : result.verdict;
    if (worst && (declared === null || severityRank(worst) > severityRank(declared))) {
      result.verdict = worst;
      postCheck.verdictRaised = true;
    }
  }

  return { ok: true, result: { ...result, postCheck } };
}

/** The worst severity of a checked result, or null when it is accurate or the evidence was insufficient. */
export function worstSeverity(result: AuditResult): FailureSeverity | null {
  return result.verdict === "accurate" || result.verdict === "insufficient_evidence" ? null : result.verdict;
}

// ---------------------------------------------------------------------------
// Night synthesis
// ---------------------------------------------------------------------------

const ModeRefSchema = z.union([z.enum(FAILURE_MODE_IDS), z.string().regex(/^NEW:[a-z][a-z0-9_]{2,40}$/)]);

const SyntheticFieldsSchema = z.object({
  topics: z.string().max(800),
  performance: z.string().max(800),
  improvement: z.string().max(800),
  homework: z.string().max(400),
}).strict();

export const SynthesisResultSchema = z.object({
  failureModes: z.array(z.object({
    mode: ModeRefSchema,
    title: z.string().max(120),
    severity: z.enum(SEVERITIES),
    /** Wise session ids from the input (checked). */
    sessions: z.array(z.string().max(40)).max(60),
    /** How the failure happens, in plain words (local plan only). */
    mechanism: z.string().max(1200),
    rootStage: z.enum(ROOT_STAGES),
    proposedChange: z.string().max(1200),
    proposedFiles: z.array(z.string().max(120)).max(6),
    /** auto_allowed: the fix fits the nightly fixer's allowed files; needs_owner: a protected file or a policy call. */
    fixability: z.enum(["auto_allowed", "needs_owner", "not_code"]),
    confidence: z.enum(["high", "medium", "low"]),
  }).strict()).max(20),
  /** The one mode to fix tonight, or null. */
  fixPick: z.object({ mode: ModeRefSchema, reason: z.string().max(600) }).strict().nullable(),
  /** Sanitised hand-over to the fixer: invented names and an invented lesson only — never a real name or quote. */
  fixBrief: z.object({
    mode: ModeRefSchema,
    mechanism: z.string().max(1200),
    targetFiles: z.array(z.string().max(120)).max(6),
    syntheticFixture: z.object({
      evidenceKind: z.enum(["summary", "transcript"]),
      evidence: z.string().max(4000),
      badFeedback: SyntheticFieldsSchema,
      expectedBehaviour: z.string().max(800),
    }).strict(),
    acceptance: z.array(z.string().max(300)).max(8),
  }).strict().nullable(),
  longTermPlan: z.array(z.object({
    title: z.string().max(120),
    why: z.string().max(600),
    steps: z.array(z.string().max(400)).max(8),
    costImpact: z.string().max(300),
  }).strict()).max(10),
  judgeMisses: z.object({
    /** Posts the production judges passed although the audit found a major or critical issue. */
    count: z.number().int().min(0),
    modes: z.array(ModeRefSchema).max(20),
  }).strict(),
  /** One line for the morning report; never a name or a quote. */
  summaryLine: z.string().max(200),
}).strict();

export type SynthesisResult = z.infer<typeof SynthesisResultSchema>;

const MODE_ID = /^M(0[1-9]|1[0-7])$/;

/** A failure-mode reference as the schema wants it: a registry id, or `NEW:<slug>`. */
export function normaliseModeRef(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (MODE_ID.test(trimmed)) return trimmed;
  const embedded = trimmed.match(/\bM(0[1-9]|1[0-7])\b/);
  if (embedded) return embedded[0];
  const slug = trimmed.replace(/^NEW:/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^[^a-z]+/, "");
  return `NEW:${(slug.length >= 3 ? slug : `mode_${slug}`).slice(0, 41)}`;
}

/** The synthesis counterpart of `normaliseAuditOutput`: mode refs normalised, lists and strings clipped. */
export function normaliseSynthesisOutput(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const out: Record<string, unknown> = { ...raw };
  out.failureModes = clipList(out.failureModes, 20, (item) => {
    if (!isRecord(item)) return item;
    return {
      ...item,
      mode: normaliseModeRef(item.mode),
      title: clipString(item.title, 120),
      sessions: clipList(item.sessions, 60, (sid) => clipString(sid, 40)),
      mechanism: clipString(item.mechanism, 1200),
      proposedChange: clipString(item.proposedChange, 1200),
      proposedFiles: clipList(item.proposedFiles, 6, (file) => clipString(file, 120)),
    };
  });
  if (isRecord(out.fixPick)) out.fixPick = { ...out.fixPick, mode: normaliseModeRef(out.fixPick.mode), reason: clipString(out.fixPick.reason, 600) };
  if (out.fixPick === undefined) out.fixPick = null;
  if (out.fixBrief === undefined) out.fixBrief = null;
  if (isRecord(out.fixBrief)) {
    const brief: Record<string, unknown> = { ...out.fixBrief, mode: normaliseModeRef(out.fixBrief.mode) };
    brief.mechanism = clipString(brief.mechanism, 1200);
    brief.targetFiles = clipList(brief.targetFiles, 6, (file) => clipString(file, 120));
    brief.acceptance = clipList(brief.acceptance, 8, (line) => clipString(line, 300));
    if (isRecord(brief.syntheticFixture)) {
      const fixture: Record<string, unknown> = { ...brief.syntheticFixture };
      fixture.evidence = clipString(fixture.evidence, 4000);
      fixture.expectedBehaviour = clipString(fixture.expectedBehaviour, 800);
      if (isRecord(fixture.badFeedback)) {
        const bad = fixture.badFeedback;
        fixture.badFeedback = {
          ...bad,
          topics: clipString(bad.topics, 800),
          performance: clipString(bad.performance, 800),
          improvement: clipString(bad.improvement, 800),
          homework: clipString(bad.homework, 400),
        };
      }
      brief.syntheticFixture = fixture;
    }
    out.fixBrief = brief;
  }
  out.longTermPlan = clipList(out.longTermPlan, 10, (item) => {
    if (!isRecord(item)) return item;
    return {
      ...item,
      title: clipString(item.title, 120),
      why: clipString(item.why, 600),
      steps: clipList(item.steps, 8, (step) => clipString(step, 400)),
      costImpact: clipString(item.costImpact, 300),
    };
  });
  if (isRecord(out.judgeMisses)) {
    out.judgeMisses = { ...out.judgeMisses, modes: clipList(out.judgeMisses.modes, 20, normaliseModeRef) };
  }
  out.summaryLine = clipString(out.summaryLine, 200, true);
  return out;
}

/** Whole-word, case-insensitive search for any of `names` in `text` (Latin or Thai script). */
export function containsAnyName(text: string, names: readonly string[]): string | null {
  const haystack = text.normalize("NFC").toLowerCase();
  for (const raw of names) {
    const name = raw.normalize("NFC").trim().toLowerCase();
    if (name.length < 2) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Thai has no word spaces: any occurrence counts. Latin names need letter boundaries.
    const pattern = /[฀-๿]/.test(name)
      ? new RegExp(escaped, "u")
      : new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u");
    if (pattern.test(haystack)) return raw;
  }
  return null;
}

/**
 * Validates the night synthesis: sessions must be ones the model was given, and the fix brief (which leaves the
 * audit's private evidence for a public pull request) must not contain any real name or any ≥8-word run copied from
 * the evidence.
 */
export function parseSynthesisResult(
  value: unknown,
  ctx: { sessionIds: ReadonlySet<string>; realNames: readonly string[]; evidenceTexts: readonly string[] },
): { ok: true; result: SynthesisResult } | { ok: false; reason: string } {
  const parsed = SynthesisResultSchema.safeParse(normaliseSynthesisOutput(value));
  if (!parsed.success) return { ok: false, reason: `schema: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` };
  const result = parsed.data;
  for (const mode of result.failureModes) {
    const unknown = mode.sessions.find((sid) => !ctx.sessionIds.has(sid));
    if (unknown) return { ok: false, reason: `unknown session ${unknown}` };
  }
  if (result.fixBrief) {
    const briefText = JSON.stringify(result.fixBrief);
    const name = containsAnyName(briefText, ctx.realNames);
    if (name) return { ok: false, reason: "fix brief contains a real name" };
    const copied = copiedRun(briefText, ctx.evidenceTexts, 8);
    if (copied) return { ok: false, reason: "fix brief copies an 8-word run from the evidence" };
  }
  return { ok: true, result };
}

/** The first run of `minWords` consecutive words of `text` that also appears in any of `sources`, or null. */
export function copiedRun(text: string, sources: readonly string[], minWords: number): string | null {
  const words = (s: string) => s.normalize("NFC").toLowerCase().split(/[^\p{L}\p{N}']+/u).filter(Boolean);
  const target = words(text);
  if (target.length < minWords) return null;
  const sourceGrams = new Set<string>();
  for (const source of sources) {
    const w = words(source);
    for (let i = 0; i + minWords <= w.length; i++) sourceGrams.add(w.slice(i, i + minWords).join(" "));
  }
  for (let i = 0; i + minWords <= target.length; i++) {
    const gram = target.slice(i, i + minWords).join(" ");
    if (sourceGrams.has(gram)) return gram;
  }
  return null;
}

// ---------------------------------------------------------------------------
// JSON schemas for `claude -p --json-schema`
// ---------------------------------------------------------------------------

const KEPT_KEYWORDS = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "anyOf", "description", "const"]);

/** Strips a zod-generated JSON schema down to the keywords structured output reliably supports; zod checks the rest. */
export function simplifyJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(simplifyJsonSchema);
  if (schema === null || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (!KEPT_KEYWORDS.has(key)) continue;
    if (key === "properties" && value && typeof value === "object") {
      out.properties = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, simplifyJsonSchema(v)]));
    } else {
      out[key] = simplifyJsonSchema(value);
    }
  }
  return out;
}

export const AUDIT_JSON_SCHEMA = simplifyJsonSchema(z.toJSONSchema(AuditResultSchema)) as Record<string, unknown>;
export const SYNTHESIS_JSON_SCHEMA = simplifyJsonSchema(z.toJSONSchema(SynthesisResultSchema)) as Record<string, unknown>;
