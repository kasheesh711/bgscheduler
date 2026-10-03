import type { FeedbackFieldAnswers } from "@/lib/post-class-feedback/types";
import { AUTOWRITER_JUDGE_EFFORTS, AUTOWRITER_JUDGE_TIMEOUT_MS, AUTOWRITER_MODELS } from "./config";
import {
  JUDGE_JSON_SCHEMA,
  buildJudgeMessages,
  combineJudgeVerdicts,
  judgeProblems,
  parseJudgeOutput,
  type JudgeEffort,
  type JudgeOutput,
  type StoredJudgeVerdict,
} from "./judge";
import { callOpenRouter, callWithRateLimitRetries } from "./openrouter";
import { routeMismatch } from "./pipeline";
import { classDetailsBlock, otherPeopleNamed, redactForModel, type EvidenceKind, type SpeakerLabels } from "./prompt";

/**
 * A finished draft (names restored), judged the way production judges a draft (judge v5): every level in
 * `AUTOWRITER_JUDGE_EFFORTS`, in parallel, on byte-identical messages, passing only when every level passes it. The
 * judge sees only redacted text — the lesson record, the class details and the draft with the student's and tutors'
 * names replaced (`redactForModel`) — and, against a summary, the same `otherPeopleNamed` list production gives it.
 * Used offline only: by the replay (the draft actually posted) and by the nightly verification of a correction.
 */

type CallModel = typeof callOpenRouter;

export interface DraftJudgeInput {
  apiKey: string;
  /** The draft as posted or proposed, names restored. */
  fields: FeedbackFieldAnswers;
  /** What the draft is checked against, unredacted: a rendered transcript or Wise's summary. */
  record: string;
  /**
   * The frozen Atom evidence the writer was given (`atomModelEvidence`, unredacted) for an ISEB post: redacted and
   * handed to the judge exactly as production's pipeline does, with its Atom rules. Absent for every other post.
   */
  atomEvidence?: string | null;
  evidence: EvidenceKind;
  speakerLabels?: SpeakerLabels;
  names: { studentFullName: string; studentAliases: readonly string[]; tutorNames: readonly string[] };
  classDetails: readonly string[];
  /** The model client every level's call goes through (it may record or reserve each attempt). */
  call: CallModel;
  remainingMs: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /**
   * Production's pinned-route rule: a reply served by another host or model than `AUTOWRITER_MODELS.judge` pins is no
   * verdict (`judge:<effort>:provider_mismatch:…`). Off for the replay, which has always taken any reply.
   */
  requirePinnedRoute?: boolean;
}

export interface DraftJudgeResult {
  /** Every level's verdict combined; null when a level gave none. */
  verdict: StoredJudgeVerdict | null;
  problems: string[];
  /** The first level (in effort order) without a verdict: `judge:<effort>:<error>`. */
  error: string | null;
}

/** One try per level (a rate-limited call is first tried again, as in production); fail closed on any level. */
export async function judgeDraftAtEveryLevel(input: DraftJudgeInput): Promise<DraftJudgeResult> {
  const redact = (text: string) => redactForModel(text, input.names);
  const judge = AUTOWRITER_MODELS.judge;
  const redactedRecord = redact(input.record);
  const messages = buildJudgeMessages({
    redactedSummary: redactedRecord,
    ...(input.atomEvidence ? { atomEvidence: redact(input.atomEvidence) } : {}),
    classDetails: classDetailsBlock(input.classDetails, input.names),
    placeholderFields: {
      topics: redact(input.fields.topics),
      performance: redact(input.fields.performance),
      improvement: redact(input.fields.improvement),
      homework: redact(input.fields.homework),
    },
    evidence: input.evidence,
    speakerLabels: input.speakerLabels,
    // Production's list for a summary (the writer was told the same); a transcript has none.
    otherPeople: input.evidence === "summary"
      ? otherPeopleNamed(redactedRecord, input.names.studentFullName, input.classDetails, input.names.studentAliases)
      : [],
  });
  const replies = (await Promise.all(AUTOWRITER_JUDGE_EFFORTS.map((effort) => callWithRateLimitRetries({
    call: input.call,
    request: {
      apiKey: input.apiKey,
      model: judge.model,
      provider: judge.provider,
      messages,
      schemaName: "feedback_faithfulness",
      schema: JUDGE_JSON_SCHEMA,
      effort,
      maxTokens: 32_000,
      timeoutMs: AUTOWRITER_JUDGE_TIMEOUT_MS[input.evidence],
    },
    remainingMs: input.remainingMs,
    sleep: input.sleep,
    random: input.random,
  })))).map((made) => made.call);
  const failures = replies.map((reply): string | null => {
    if (!reply.ok) return reply.error;
    const mismatch = input.requirePinnedRoute ? routeMismatch(judge, reply) : null;
    if (mismatch) return mismatch;
    return parseJudgeOutput(reply.content) ? null : "judge_unparseable";
  });
  const failed = failures.findIndex((failure) => failure !== null);
  if (failed >= 0) {
    return { verdict: null, problems: [], error: `judge:${AUTOWRITER_JUDGE_EFFORTS[failed]}:${failures[failed]}` };
  }
  const verdicts = replies.map((reply) => (reply.ok ? parseJudgeOutput(reply.content) : null) as JudgeOutput);
  const verdict = combineJudgeVerdicts(Object.fromEntries(
    AUTOWRITER_JUDGE_EFFORTS.map((effort, index) => [effort, verdicts[index]]),
  ) as Record<JudgeEffort, JudgeOutput>);
  return { verdict, problems: judgeProblems(verdict), error: null };
}
