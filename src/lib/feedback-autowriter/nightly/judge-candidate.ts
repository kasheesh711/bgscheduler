import type { FeedbackFieldAnswers } from "@/lib/post-class-feedback/types";
import type { StoredJudgeVerdict } from "../judge";
import { judgeDraftAtEveryLevel } from "../judge-draft";
import { callOpenRouter, type OpenRouterCallResult } from "../openrouter";
import type { EvidenceKind, SpeakerLabels } from "../prompt";
import type { NightlyLedger } from "./ledger";
import type { EvidenceBundle } from "./types";

/**
 * The production GLM judge on a correction candidate (quick 261003-12b): both levels of `AUTOWRITER_JUDGE_EFFORTS`
 * must pass it, on the messages production builds (`judgeDraftAtEveryLevel`: redacted record, class details and text,
 * production's pinned route), against the class's evidence bundle — the transcript when there is one (the best
 * record of the lesson), else Wise's summary — and, for an ISEB post, the frozen Atom evidence its writer was given
 * (redacted, with the judge's Atom rules, as production judges such a draft). Every model call, retries of a rate
 * limit included, is reserved (`openrouter`) in the nightly ledger before it is sent and settled with what it cost; a
 * reservation the ledger refuses is never sent, and the candidate does not pass.
 */

/** What one judge call is reserved at (settled with OpenRouter's billed cost). */
export const JUDGE_CALL_ESTIMATE_USD = 0.05;
/** Time the calls of one candidate may take, production's rate-limit retries included. */
const JUDGE_BUDGET_MS = 15 * 60 * 1000;

type CallModel = typeof callOpenRouter;

export interface JudgeCandidateDeps {
  apiKey: string;
  ledger: Pick<NightlyLedger, "reserve" | "settle">;
  /** The candidate's ledger key (`judge:<sid>:<fieldsHash>`); each call is reserved as `<key>:<effort>`. */
  key: string;
  estimateUsd?: number;
  callModel?: CallModel;
  /** Time left for the calls (default 15 minutes); a rate-limited call is retried only while its time-out fits. */
  remainingMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface JudgeCandidateResult {
  /** Both levels gave a verdict, and both passed the text. */
  faithful: boolean;
  verdict: StoredJudgeVerdict | null;
  /** The levels' problems (quotes of the candidate: local files only). */
  problems: string[];
  /** Why there is no verdict: `no_evidence`, `student_unknown`, `judge:<effort>:<error>` (a refused reservation: `cap:…`). */
  error: string | null;
  evidence: EvidenceKind | null;
  calls: number;
  /** What the calls cost as billed (a call without a billed cost counts at its estimate in the ledger). */
  costUsd: number;
  /** A reservation the ledger refused: the caller stops the step. */
  capStop: string | null;
  /** Caps the recorded spend has now passed (a call cost more than reserved): the caller writes STOP. */
  breached: string[];
}

/** The record a candidate is judged against: the transcript when the bundle has one, else Wise's summary. */
export function judgeEvidenceOf(bundle: Pick<EvidenceBundle, "transcript" | "wiseSummary">): {
  evidence: EvidenceKind;
  record: string;
  speakerLabels?: SpeakerLabels;
} | null {
  if (bundle.transcript && bundle.transcript.text.trim()) {
    return {
      evidence: "transcript",
      record: bundle.transcript.text,
      speakerLabels: bundle.transcript.speakerLabels === "verified" ? "verified" : "inferred",
    };
  }
  if (bundle.wiseSummary && bundle.wiseSummary.trim()) return { evidence: "summary", record: bundle.wiseSummary };
  return null;
}

function refusedCall(reason: string): OpenRouterCallResult {
  return { ok: false, error: reason, httpStatus: null, model: null, provider: null, finishReason: null, usage: null, latencyMs: 0 };
}

/** Both production judge levels on one candidate text; see the module comment. Never throws for a model failure. */
export async function judgeCandidate(deps: JudgeCandidateDeps, input: {
  fields: FeedbackFieldAnswers;
  bundle: EvidenceBundle;
}): Promise<JudgeCandidateResult> {
  const out: JudgeCandidateResult = {
    faithful: false, verdict: null, problems: [], error: null, evidence: null, calls: 0, costUsd: 0, capStop: null, breached: [],
  };
  const source = judgeEvidenceOf(input.bundle);
  if (!source) return { ...out, error: "no_evidence" };
  const studentFullName = input.bundle.studentFullName?.trim();
  // Without the student's name nothing can be redacted: the judge would see it.
  if (!studentFullName) return { ...out, error: "student_unknown" };
  out.evidence = source.evidence;
  const callModel = deps.callModel ?? callOpenRouter;
  const estimateUsd = deps.estimateUsd ?? JUDGE_CALL_ESTIMATE_USD;
  const reserving: CallModel = async (request) => {
    const reserved = deps.ledger.reserve("openrouter", { key: `${deps.key}:${request.effort}`, estimateUsd });
    if (!reserved.ok) {
      out.capStop ??= reserved.reason;
      return refusedCall(reserved.reason);
    }
    out.calls += 1;
    let result: OpenRouterCallResult;
    try {
      result = await callModel(request);
    } catch (error) {
      deps.ledger.settle(reserved.id, { actualUsd: null, outcome: "error" });
      throw error;
    }
    const actualUsd = result.usage?.costUsd ?? null;
    out.costUsd += actualUsd ?? estimateUsd;
    const { breached } = deps.ledger.settle(reserved.id, {
      actualUsd,
      outcome: result.ok ? "success" : result.httpStatus === 429 ? "rate_limited" : "error",
    });
    for (const cap of breached) if (!out.breached.includes(cap)) out.breached.push(cap);
    return result;
  };
  const judged = await judgeDraftAtEveryLevel({
    apiKey: deps.apiKey,
    fields: input.fields,
    record: source.record,
    atomEvidence: input.bundle.atomEvidence ?? null,
    evidence: source.evidence,
    speakerLabels: source.speakerLabels,
    names: { studentFullName, studentAliases: input.bundle.studentAliases, tutorNames: input.bundle.tutorNames },
    classDetails: input.bundle.classDetails,
    call: reserving,
    remainingMs: deps.remainingMs ?? (() => JUDGE_BUDGET_MS),
    sleep: deps.sleep,
    random: deps.random,
    requirePinnedRoute: true,
  });
  out.costUsd = Math.round(out.costUsd * 1_000_000) / 1_000_000;
  return {
    ...out,
    verdict: judged.verdict,
    problems: judged.problems,
    error: judged.error,
    faithful: judged.error === null && judged.verdict?.faithful === true && judged.problems.length === 0,
  };
}
