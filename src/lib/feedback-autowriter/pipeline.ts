import type { PriorFeedbackComparison } from "@/lib/post-class-feedback/similarity";
import type { FeedbackFieldAnswers } from "@/lib/post-class-feedback/types";
import {
  AUTOWRITER_CALL_DEADLINE_MARGIN_MS,
  AUTOWRITER_JUDGE_EFFORTS,
  AUTOWRITER_JUDGE_TIMEOUT_MS,
  AUTOWRITER_MODELS,
  AUTOWRITER_WRITER_TIMEOUT_MS,
  type AutowriterModelConfig,
} from "./config";
import {
  JUDGE_JSON_SCHEMA,
  JUDGE_PROMPT_VERSION,
  buildJudgeMessages,
  combineJudgeVerdicts,
  judgeProblems,
  parseJudgeOutput,
  type JudgeEffort,
  type JudgeOutput,
  type StoredJudgeVerdict,
} from "./judge";
import { callOpenRouter, callWithRateLimitRetries, type OpenRouterCallResult } from "./openrouter";
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

/**
 * One request to a model. A call that was rate limited and tried again in the same run (`callWithRateLimitRetries`)
 * is one record per attempt: the attempts after the first carry `result.rateLimitRetry` (1, 2 or 3).
 */
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
  | { kind: "draft"; arm: ModelArm; output: ModelOutput; fields: FeedbackFieldAnswers; judge: StoredJudgeVerdict }
  | { kind: "held"; reasons: string[] }
  /**
   * Retried later. `stage`: whose call failed or could not start — the writer's, or the judge's (the writer had
   * then delivered a draft that passed validation). `modelFailure`: the model failed on this evidence (a time-out,
   * a reply that is not JSON, a provider error, an unusable route, a judge that gives no verdict) — not our
   * function's time, our OpenRouter account (a bad key, no credit, rate limited) or our connection. Transcript
   * first counts only the writer's model failures (`writer_failed`, owner decision 30 Sep).
   */
  | { kind: "infra"; error: string; modelFailure: boolean; stage: "writer" | "judge" };

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

/** Each judge level gets one immediate second try per draft before the session is retried later. */
const JUDGE_ATTEMPTS = 2;

/** The infra error for our own function running out of time before a model call: not a failure of the models. */
export const FUNCTION_BUDGET_EXHAUSTED = "function_budget_exhausted";

/**
 * OpenRouter statuses about our account or its capacity rather than the model's answer: a bad key, no credit, rate
 * limited (our own limit, or the model's upstream one — which OpenRouter reports inside a 200 response).
 */
const ACCOUNT_STATUSES = new Set([401, 402, 429]);

/**
 * An infra failure of a model call → a retry. It is the model's (`modelFailure`) unless it is about our account or
 * our connection, or it is a time-out on a call our function's remaining time had cut short.
 */
function callFailure(
  who: string,
  call: Extract<OpenRouterCallResult, { ok: false }>,
  shortened: boolean,
  stage: "writer" | "judge",
): PipelineResult {
  const ours = (call.httpStatus !== null && ACCOUNT_STATUSES.has(call.httpStatus)) || call.error.startsWith("network_")
    || (call.error === "timeout" && shortened);
  return { kind: "infra", error: `${who}:${call.error}`, modelFailure: !ours, stage };
}

type Stop = { stop: PipelineResult };

/** Pinned routes must be served exactly as pinned; anything else is an infra failure. */
export function routeMismatch(config: AutowriterModelConfig, call: OpenRouterCallResult): string | null {
  if (!config.expectProvider && !config.expectModel) return null;
  if (config.expectProvider && call.provider !== config.expectProvider) return `provider_mismatch:${call.provider ?? "none"}`;
  if (config.expectModel && call.model !== config.expectModel) return `model_mismatch:${call.model ?? "none"}`;
  return null;
}

type CallModel = typeof callOpenRouter;

/**
 * Sol writes → deterministic validation → GLM judge (faithfulness) at `medium` and `high` → accepted.
 * Any content failure falls back to Luna (validated and judged the same
 * way), for a summary and a transcript alike: every route has zero data
 * retention. Infra failures stop immediately so the session is retried later —
 * except that a rate-limited call is first tried again in this run (a few
 * seconds apart, while the function's time allows): still rate limited after
 * that, it is the same infra failure as before.
 */
export async function runWritingPipeline(input: {
  apiKey: string;
  session: PipelineSession;
  tutorNames: readonly string[];
  priorFeedback: readonly PriorFeedbackComparison[];
  record: (record: CallRecord) => Promise<void>;
  remainingMs: () => number;
  callModel?: CallModel;
  /** The wait before a rate-limited call is tried again, and its random spread (tests inject both). */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
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

  /**
   * The one place a model is called — writer, fallback writer and each judge level alike. `record` stores one
   * attempt; the returned `record` stores the last one, with what the pipeline made of its reply.
   */
  const run = async (
    config: AutowriterModelConfig,
    role: "writer" | "judge",
    messages: Array<{ role: "system" | "user"; content: string }>,
    preferredTimeoutMs: number,
    record: (call: OpenRouterCallResult, result: Record<string, unknown>) => Promise<void>,
  ) => {
    const availableMs = input.remainingMs() - AUTOWRITER_CALL_DEADLINE_MARGIN_MS;
    // A judge never starts without its full time-out: cut short by our deadline it could not finish (owner decision,
    // 30 Sep). A writer may start with less (at least 30 s).
    if (role === "judge" ? availableMs < preferredTimeoutMs : availableMs < 30_000) return { kind: "budget" as const };
    const timeoutMs = Math.min(preferredTimeoutMs, availableMs);
    // A rate limit is tried again here, in this run, with the same request and time-out — while the wait and that
    // time-out still fit our deadline (owner decision, 30 Sep).
    const { call, rateLimited } = await callWithRateLimitRetries({
      call: callModel,
      request: {
        apiKey: input.apiKey,
        model: config.model,
        provider: config.provider,
        messages,
        schemaName: role === "writer" ? "post_class_feedback" : "feedback_faithfulness",
        schema: role === "writer" ? FEEDBACK_JSON_SCHEMA : JUDGE_JSON_SCHEMA,
        effort: config.effort,
        maxTokens: 32_000,
        timeoutMs,
      },
      remainingMs: input.remainingMs,
      sleep: input.sleep,
      random: input.random,
    });
    // Every attempt was a request: each is its own call record, and a retry says which retry it was.
    const marked = (retry: number, result: Record<string, unknown>) => retry > 0 ? { ...result, rateLimitRetry: retry } : result;
    for (const [retry, limited] of rateLimited.entries()) await record(limited, marked(retry, { error: limited.error }));
    return {
      kind: "call" as const,
      call,
      shortened: timeoutMs < preferredTimeoutMs,
      record: (result: Record<string, unknown>) => record(call, marked(rateLimited.length, result)),
    };
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
    }), AUTOWRITER_WRITER_TIMEOUT_MS, (call, result) => input.record({
      wiseSessionId: session.wiseSessionId, role: "writer", arm: writer.arm, requestedModel: writer.model,
      promptVersion: PROMPT_VERSION, call, result: { ...result, evidence },
    }));
    if (written.kind === "budget") return { kind: "infra", error: FUNCTION_BUDGET_EXHAUSTED, modelFailure: false, stage: "writer" };
    const writeCall = written.call;
    const recordWriter = written.record;

    if (!writeCall.ok) {
      await recordWriter({ error: writeCall.error });
      if (isInfraFailure(writeCall)) return callFailure(writer.arm, writeCall, written.shortened, "writer");
      reasons.push(`${writer.arm}:${writeCall.error}`);
      continue;
    }
    const writerMismatch = routeMismatch(writer, writeCall);
    if (writerMismatch) {
      await recordWriter({ error: writerMismatch });
      return { kind: "infra", error: `${writer.arm}:${writerMismatch}`, modelFailure: true, stage: "writer" };
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

    // Judge v5 (owner decision, 30 Sep): every level in AUTOWRITER_JUDGE_EFFORTS judges the draft in parallel, on the
    // same messages, and the draft passes only when every level passes it. Each level is today's single judge: a
    // failed call retries the class later, a reply it cannot use gets one more try at that level. A judge that fails
    // to give a verdict says nothing about the draft, so it never triggers the fallback writer.
    const judgeMessages = buildJudgeMessages({
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
    });
    // The writer generation both levels judged, so the dashboard counts a rejected draft once.
    const judgedGeneration = writeCall.generationId;
    const judgeLevel = async (effort: JudgeEffort): Promise<{ verdict: JudgeOutput } | Stop> => {
      const config: AutowriterModelConfig = { ...AUTOWRITER_MODELS.judge, effort };
      let failure = "";
      for (let attempt = 0; attempt < JUDGE_ATTEMPTS; attempt += 1) {
        const judged = await run(config, "judge", judgeMessages, AUTOWRITER_JUDGE_TIMEOUT_MS[evidence], (call, result) => input.record({
          wiseSessionId: session.wiseSessionId, role: "judge", arm: config.arm, requestedModel: config.model,
          promptVersion: JUDGE_PROMPT_VERSION, call,
          result: { effort, ...result, judgedArm: writer.arm, judgedGeneration, evidence },
        }));
        if (judged.kind === "budget") return { stop: { kind: "infra", error: FUNCTION_BUDGET_EXHAUSTED, modelFailure: false, stage: "judge" } };
        const judgeCall = judged.call;
        const recordJudge = judged.record;
        if (!judgeCall.ok) {
          await recordJudge({ error: judgeCall.error });
          if (isInfraFailure(judgeCall)) return { stop: callFailure(`judge:${effort}`, judgeCall, judged.shortened, "judge") };
          failure = `judge_${judgeCall.error}`;
          continue;
        }
        const judgeMismatch = routeMismatch(config, judgeCall);
        if (judgeMismatch) {
          await recordJudge({ error: judgeMismatch });
          return { stop: { kind: "infra", error: `judge:${effort}:${judgeMismatch}`, modelFailure: true, stage: "judge" } };
        }
        const verdict = parseJudgeOutput(judgeCall.content);
        // The three lists as returned, plus the flat `judgeProblems` list the hold reason and the dashboard use.
        await recordJudge(verdict ? { ...verdict, problems: judgeProblems(verdict) } : { error: "judge_unparseable" });
        if (verdict) return { verdict };
        failure = "judge_unparseable";
      }
      return { stop: { kind: "infra", error: `judge:${effort}:${failure || "no_verdict"}`, modelFailure: true, stage: "judge" } };
    };
    // Both levels settle before anything is decided. A thrown error (the model client never throws) propagates as
    // before; otherwise the first level (in effort order) that stopped decides the retry.
    const settled = await Promise.allSettled(AUTOWRITER_JUDGE_EFFORTS.map(judgeLevel));
    const levels: Partial<Record<JudgeEffort, JudgeOutput>> = {};
    let stopped: PipelineResult | null = null;
    for (const [index, level] of settled.entries()) {
      if (level.status === "rejected") throw level.reason;
      if ("stop" in level.value) stopped ??= level.value.stop;
      else levels[AUTOWRITER_JUDGE_EFFORTS[index]] = level.value.verdict;
    }
    if (stopped) return stopped;
    const verdict = combineJudgeVerdicts(levels as Record<JudgeEffort, JudgeOutput>);
    if (!verdict.faithful) {
      reasons.push(`${writer.arm}:unfaithful:${judgeProblems(verdict).slice(0, 3).join(" | ").slice(0, 300)}`);
      continue;
    }
    return { kind: "draft", arm: writer.arm, output: parsed.output, fields, judge: verdict };
  }
  return { kind: "held", reasons };
}
