import type { PriorFeedbackComparison } from "@/lib/post-class-feedback/similarity";
import type { FeedbackFieldAnswers } from "@/lib/post-class-feedback/types";
import { AUTOWRITER_MODELS, type AutowriterModelConfig } from "./config";
import {
  JUDGE_JSON_SCHEMA,
  JUDGE_PROMPT_VERSION,
  buildJudgeMessages,
  judgeProblems,
  parseJudgeOutput,
  type JudgeOutput,
} from "./judge";
import { callOpenRouter, type OpenRouterCallResult } from "./openrouter";
import {
  FEEDBACK_JSON_SCHEMA,
  PROMPT_VERSION,
  buildFeedbackMessages,
  classDetailsBlock,
  otherPeopleNamed,
  redactForModel,
  type EvidenceKind,
  type SpeakerLabels,
} from "./prompt";
import type { AiSummary, ModelArm } from "./types";
import { finalizeFields, parseModelOutput, validateFeedbackDraft, type ModelOutput } from "./validate";

export interface PipelineSession {
  wiseSessionId: string;
  studentFullName: string;
  /** Other names the student appeared under (a guest join); redacted like the full name. */
  studentAliases?: readonly string[];
  studentDisplayName: string;
  /** `describeClass` lines; the writer and the judge both get them. */
  classDetails: readonly string[];
  /**
   * What `summary.text` holds: Wise's AI summary, or a rendered Soniox transcript.
   * Transcripts can carry Thai-script names our redaction cannot see, so they
   * only ever go to zero-retention routes — as every writer and the judge are.
   */
  evidence?: EvidenceKind;
  /** Transcript mode: whether Zoom confirmed the TUTOR/STUDENT labels. */
  speakerLabels?: SpeakerLabels;
  scheduledMinutes: number;
  summary: AiSummary;
}

export interface CallRecord {
  wiseSessionId: string;
  role: "writer" | "judge";
  arm: ModelArm;
  requestedModel: string;
  promptVersion: number;
  call: OpenRouterCallResult;
  result: Record<string, unknown>;
}

export type PipelineResult =
  | { kind: "draft"; arm: ModelArm; output: ModelOutput; fields: FeedbackFieldAnswers; judge: JudgeOutput }
  | { kind: "held"; reasons: string[] }
  | { kind: "infra"; error: string };

/**
 * A failure of the service rather than of the text: missing key, credit limit,
 * host outage, rate limit, time-out, a provider-side generation error, or a
 * request we built wrong. These keep the session pending (retry) instead of
 * holding it for a person — and never send the summary on to the fallback host.
 * Content failures (truncation, content filter, moderation 403, context length)
 * are the text's problem and may go to the fallback writer.
 */
export function isInfraFailure(call: Extract<OpenRouterCallResult, { ok: false }>): boolean {
  if (call.error === "finish_reason_error" || call.error === "finish_reason_missing") return true;
  if (call.error.startsWith("finish_reason_") || call.error === "empty_content") return false;
  if (call.httpStatus === 403) return false;
  if (call.httpStatus === 400 && /context|too long|maximum.{0,20}tokens|token limit/iu.test(call.error)) return false;
  return true;
}

/** The judge gets one immediate second try per draft before the session is retried later. */
const JUDGE_ATTEMPTS = 2;

/** The infra error for our own function running out of time before a model call: not a failure of the models. */
export const FUNCTION_BUDGET_EXHAUSTED = "function_budget_exhausted";

/** Pinned routes must be served exactly as pinned; anything else is an infra failure. */
export function routeMismatch(config: AutowriterModelConfig, call: OpenRouterCallResult): string | null {
  if (!config.expectProvider && !config.expectModel) return null;
  if (config.expectProvider && call.provider !== config.expectProvider) return `provider_mismatch:${call.provider ?? "none"}`;
  if (config.expectModel && call.model !== config.expectModel) return `model_mismatch:${call.model ?? "none"}`;
  return null;
}

type CallModel = typeof callOpenRouter;

/**
 * Sol writes → deterministic validation → GLM judge (faithfulness) → accepted.
 * Any content failure falls back to Luna (validated and GLM-judged the same
 * way), for a summary and a transcript alike: every route has zero data
 * retention. Infra failures stop immediately so the session is retried later.
 */
export async function runWritingPipeline(input: {
  apiKey: string;
  session: PipelineSession;
  tutorNames: readonly string[];
  priorFeedback: readonly PriorFeedbackComparison[];
  record: (record: CallRecord) => Promise<void>;
  remainingMs: () => number;
  callModel?: CallModel;
}): Promise<PipelineResult> {
  const callModel = input.callModel ?? callOpenRouter;
  const { session } = input;
  const reasons: string[] = [];
  const names = { studentFullName: session.studentFullName, studentAliases: session.studentAliases, tutorNames: input.tutorNames };
  const redactedSummary = redactForModel(session.summary.text, names);
  const redactedClassDetails = classDetailsBlock(session.classDetails, names);
  const evidence: EvidenceKind = session.evidence ?? "summary";
  // One list for both models: the writer is told these people are never [STUDENT_1], the judge checks it.
  const otherPeople = evidence === "summary"
    ? otherPeopleNamed(redactedSummary, session.studentFullName, session.classDetails, session.studentAliases)
    : [];

  const run = async (config: AutowriterModelConfig, role: "writer" | "judge", messages: Array<{ role: "system" | "user"; content: string }>, preferredTimeoutMs: number) => {
    const timeoutMs = Math.min(preferredTimeoutMs, input.remainingMs() - 45_000);
    if (timeoutMs < 30_000) return { kind: "budget" as const };
    const call = await callModel({
      apiKey: input.apiKey,
      model: config.model,
      provider: config.provider,
      messages,
      schemaName: role === "writer" ? "post_class_feedback" : "feedback_faithfulness",
      schema: role === "writer" ? FEEDBACK_JSON_SCHEMA : JUDGE_JSON_SCHEMA,
      effort: config.effort,
      maxTokens: 32_000,
      timeoutMs,
    });
    return { kind: "call" as const, call };
  };

  // Every writer is on a zero-retention route, so transcripts get the fallback too.
  const writers: AutowriterModelConfig[] = [AUTOWRITER_MODELS.writer, AUTOWRITER_MODELS.fallbackWriter];
  for (const writer of writers) {
    const written = await run(writer, "writer", buildFeedbackMessages({
      studentFullName: session.studentFullName,
      studentAliases: session.studentAliases,
      tutorNames: input.tutorNames,
      classDetails: session.classDetails,
      scheduledMinutes: session.scheduledMinutes,
      summary: session.summary,
      evidence,
      speakerLabels: session.speakerLabels,
      otherPeople,
    }), 180_000);
    if (written.kind === "budget") return { kind: "infra", error: FUNCTION_BUDGET_EXHAUSTED };
    const writeCall = written.call;
    const recordWriter = (result: Record<string, unknown>) => input.record({
      wiseSessionId: session.wiseSessionId, role: "writer", arm: writer.arm, requestedModel: writer.model,
      promptVersion: PROMPT_VERSION, call: writeCall, result: { ...result, evidence },
    });

    if (!writeCall.ok) {
      await recordWriter({ error: writeCall.error });
      if (isInfraFailure(writeCall)) return { kind: "infra", error: `${writer.arm}:${writeCall.error}` };
      reasons.push(`${writer.arm}:${writeCall.error}`);
      continue;
    }
    const writerMismatch = routeMismatch(writer, writeCall);
    if (writerMismatch) {
      await recordWriter({ error: writerMismatch });
      return { kind: "infra", error: `${writer.arm}:${writerMismatch}` };
    }
    const parsed = parseModelOutput(writeCall.content);
    if (!parsed.ok) {
      await recordWriter({ error: parsed.reason });
      reasons.push(`${writer.arm}:${parsed.reason}`);
      continue;
    }
    const fields = finalizeFields(parsed.output, session.studentDisplayName);
    const validation = validateFeedbackDraft({
      output: parsed.output,
      fields,
      studentFullName: session.studentFullName,
      tutorNames: input.tutorNames,
      priorFeedback: input.priorFeedback.filter((prior) => prior.key !== session.wiseSessionId),
    });
    await recordWriter(validation.ok ? { validation: "ok" } : { validation: validation.reasons });
    if (!validation.ok) {
      reasons.push(...validation.reasons.map((reason) => `${writer.arm}:${reason}`));
      continue;
    }

    // A judge that fails to give a verdict says nothing about the draft, so it
    // never triggers the fallback writer: one more try, then retry later.
    const judgeConfig = AUTOWRITER_MODELS.judge as AutowriterModelConfig;
    let verdict: JudgeOutput | null = null;
    let judgeFailure = "";
    for (let attempt = 0; attempt < JUDGE_ATTEMPTS && !verdict; attempt += 1) {
      const judged = await run(judgeConfig, "judge", buildJudgeMessages({
        redactedSummary,
        evidence,
        speakerLabels: session.speakerLabels,
        otherPeople,
        classDetails: redactedClassDetails,
        placeholderFields: {
          topics: parsed.output.topics,
          performance: parsed.output.performance,
          improvement: parsed.output.improvement,
          homework: parsed.output.homework,
        },
      }), 120_000);
      if (judged.kind === "budget") return { kind: "infra", error: FUNCTION_BUDGET_EXHAUSTED };
      const judgeCall = judged.call;
      const recordJudge = (result: Record<string, unknown>) => input.record({
        wiseSessionId: session.wiseSessionId, role: "judge", arm: judgeConfig.arm, requestedModel: judgeConfig.model,
        promptVersion: JUDGE_PROMPT_VERSION, call: judgeCall, result: { ...result, judgedArm: writer.arm, evidence },
      });
      if (!judgeCall.ok) {
        await recordJudge({ error: judgeCall.error });
        if (isInfraFailure(judgeCall)) return { kind: "infra", error: `judge:${judgeCall.error}` };
        judgeFailure = `judge_${judgeCall.error}`;
        continue;
      }
      const judgeMismatch = routeMismatch(judgeConfig, judgeCall);
      if (judgeMismatch) {
        await recordJudge({ error: judgeMismatch });
        return { kind: "infra", error: `judge:${judgeMismatch}` };
      }
      verdict = parseJudgeOutput(judgeCall.content);
      // The three lists as returned, plus the flat `judgeProblems` list the hold reason and the dashboard use.
      await recordJudge(verdict ? { ...verdict, problems: judgeProblems(verdict) } : { error: "judge_unparseable" });
      if (!verdict) judgeFailure = "judge_unparseable";
    }
    if (!verdict) return { kind: "infra", error: `judge:${judgeFailure || "no_verdict"}` };
    if (!verdict.faithful) {
      reasons.push(`${writer.arm}:unfaithful:${judgeProblems(verdict).slice(0, 3).join(" | ").slice(0, 300)}`);
      continue;
    }
    return { kind: "draft", arm: writer.arm, output: parsed.output, fields, judge: verdict };
  }
  return { kind: "held", reasons };
}
