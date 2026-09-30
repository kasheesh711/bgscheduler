import { randomUUID } from "node:crypto";
import type { PriorFeedbackComparison } from "@/lib/post-class-feedback/similarity";
import type { FeedbackFieldAnswers } from "@/lib/post-class-feedback/types";
import {
  AUTOWRITER_CALL_DEADLINE_MARGIN_MS,
  AUTOWRITER_JUDGE_EFFORTS,
  AUTOWRITER_JUDGE_TIMEOUT_MS,
  AUTOWRITER_MODELS,
  AUTOWRITER_WRITER_TIMEOUT_MS,
  type AutowriterModelConfig,
  type AutowriterModelRoute,
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
import { callOpenRouter, callWithRateLimitRetries, isRateLimited, type OpenRouterCallResult } from "./openrouter";
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
 * is one record per attempt: the attempts after the first carry `result.rateLimitRetry` (1, 2 or 3). The records of
 * a call are written when it ends, so each rate-limited attempt also says when its request was really sent
 * (`result.attemptAt`, ISO), the wait OpenRouter asked for when it named one (`retryAfterMs`) and the wait that
 * followed (`waitedMs`; none after the last attempt, unless its retry was given up only after the wait).
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
   * first counts only the writer's model failures (`writer_failed`, owner decision 30 Sep). `rateLimited`: the call
   * was still rate limited when the run gave up on it — a sweep then makes no in-run retries at that stage for its
   * other classes. `judgeAnswered`: earlier in this run the judges gave their verdict on a draft (they rejected the
   * first writer's, and the run went on to the fallback writer) — so the judge's failures in a row ended there, however
   * the run then ended (`judgeFailed` in job.ts).
   */
  | { kind: "infra"; error: string; modelFailure: boolean; stage: "writer" | "judge"; rateLimited?: true; judgeAnswered?: true };

/**
 * In-run retries of a rate-limited call, per stage: the writers' route and the judge's are limited apart, so a sweep
 * that met a lasting limit at one stage keeps its retries at the other.
 */
export type RateLimitRetries = Record<"writer" | "judge", boolean>;

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
  return { kind: "infra", error: `${who}:${call.error}`, modelFailure: !ours, stage, ...(isRateLimited(call) ? { rateLimited: true as const } : {}) };
}

type Stop = { stop: PipelineResult };

/** Pinned routes must be served exactly as pinned; anything else is an infra failure. */
export function routeMismatch(config: AutowriterModelRoute, call: OpenRouterCallResult): string | null {
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
  /**
   * False for a stage: no in-run retries of its calls — a rate-limited one is returned at once, as before them. A
   * sweep passes it once one of its classes has ended still rate limited at that stage (the limit lasts; the waits
   * would only keep its other classes out).
   */
  rateLimitRetries?: RateLimitRetries;
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
   * attempt; the returned `record` stores the last one, with what the pipeline made of its reply. `abandon` (a judge
   * level): asked before each retry wait and again after it; true once a retry can no longer change the outcome.
   */
  const run = async (
    config: AutowriterModelConfig,
    role: "writer" | "judge",
    messages: Array<{ role: "system" | "user"; content: string }>,
    preferredTimeoutMs: number,
    record: (call: OpenRouterCallResult, result: Record<string, unknown>) => Promise<void>,
    abandon?: () => boolean,
  ) => {
    const availableMs = input.remainingMs() - AUTOWRITER_CALL_DEADLINE_MARGIN_MS;
    // A judge never starts without its full time-out: cut short by our deadline it could not finish (owner decision,
    // 30 Sep). A writer may start with less (at least 30 s).
    if (role === "judge" ? availableMs < preferredTimeoutMs : availableMs < 30_000) return { kind: "budget" as const };
    const timeoutMs = Math.min(preferredTimeoutMs, availableMs);
    // A rate limit is tried again here, in this run, with the same request and time-out — while the wait and that
    // time-out still fit our deadline (owner decision, 30 Sep).
    const { call, startedAt, rateLimited, abandoned, waitedMs: lastWaitedMs } = await callWithRateLimitRetries({
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
      retries: input.rateLimitRetries?.[role],
      abandon,
      sleep: input.sleep,
      random: input.random,
    });
    // Every attempt was a request: each is its own call record, and a retry says which retry it was. These records
    // are written now, after the waits, so a rate-limited attempt says itself when its request was sent — the
    // coverage figures read "when we started writing" from it — and what was waited.
    const marked = (retry: number, result: Record<string, unknown>) => retry > 0 ? { ...result, rateLimitRetry: retry } : result;
    const limit = (limited: { error: string; retryAfterMs?: number }, sentAt: number) => ({
      error: limited.error,
      attemptAt: new Date(sentAt).toISOString(),
      ...(limited.retryAfterMs !== undefined ? { retryAfterMs: limited.retryAfterMs } : {}),
    });
    for (const [retry, { startedAt: sentAt, waitedMs, ...limited }] of rateLimited.entries()) {
      await record(limited, marked(retry, { ...limit(limited, sentAt), waitedMs }));
    }
    return {
      kind: "call" as const,
      call,
      shortened: timeoutMs < preferredTimeoutMs,
      abandoned,
      // The last attempt waited too when its retry was given up only after the wait (`abandon`, asked again then).
      record: (result: Record<string, unknown>) => record(call, marked(rateLimited.length, isRateLimited(call)
        ? { ...result, ...limit(call, startedAt), ...(lastWaitedMs !== undefined ? { waitedMs: lastWaitedMs } : {}) }
        : result)),
    };
  };

  // The judges have given their verdict on a draft in this run (they rejected it, and the fallback writer went on):
  // a failure that ends the run after that says so, for the count of the judge's failures in a row.
  let judgeAnswered = false;
  const ended = (result: PipelineResult): PipelineResult =>
    judgeAnswered && result.kind === "infra" ? { ...result, judgeAnswered: true } : result;

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
    if (written.kind === "budget") return ended({ kind: "infra", error: FUNCTION_BUDGET_EXHAUSTED, modelFailure: false, stage: "writer" });
    const writeCall = written.call;
    const recordWriter = written.record;

    if (!writeCall.ok) {
      await recordWriter({ error: writeCall.error });
      if (isInfraFailure(writeCall)) return ended(callFailure(writer.arm, writeCall, written.shortened, "writer"));
      reasons.push(`${writer.arm}:${writeCall.error}`);
      continue;
    }
    const writerMismatch = routeMismatch(writer, writeCall);
    if (writerMismatch) {
      await recordWriter({ error: writerMismatch });
      return ended({ kind: "infra", error: `${writer.arm}:${writerMismatch}`, modelFailure: true, stage: "writer" });
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
    // Once one level has rejected the draft or stopped the run, nothing the other level does can let the draft pass:
    // it then makes no second try and no further in-run retry (`decided`, below).
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
    // The draft every level judged, so the dashboard counts a rejected draft once: the writer's generation id, or a
    // key of our own when the reply carries none (each level's call would otherwise count as a draft of its own).
    const judgedGeneration = writeCall.generationId ?? `draft:${randomUUID()}`;
    // A level has rejected this draft (an unfaithful verdict) or stopped the run. Set before that level's call is
    // recorded, so the other level finds it however the two replies interleave.
    let decided = false;
    const stop = (result: PipelineResult): Stop => {
      decided = true;
      return { stop: result };
    };
    const judgeLevel = async (effort: JudgeEffort): Promise<{ verdict: JudgeOutput } | Stop | { leftOff: true }> => {
      const config: AutowriterModelConfig = { ...AUTOWRITER_MODELS.judge, effort };
      let failure = "";
      for (let attempt = 0; attempt < JUDGE_ATTEMPTS; attempt += 1) {
        // No second try once the other level has decided: whatever it gave, the draft would not pass.
        if (attempt > 0 && decided) return { leftOff: true };
        const judged = await run(config, "judge", judgeMessages, AUTOWRITER_JUDGE_TIMEOUT_MS[evidence], (call, result) => input.record({
          wiseSessionId: session.wiseSessionId, role: "judge", arm: config.arm, requestedModel: config.model,
          promptVersion: JUDGE_PROMPT_VERSION, call,
          result: { effort, ...result, judgedArm: writer.arm, judgedGeneration, evidence },
        }), () => decided);
        if (judged.kind === "budget") return stop({ kind: "infra", error: FUNCTION_BUDGET_EXHAUSTED, modelFailure: false, stage: "judge" });
        const judgeCall = judged.call;
        const recordJudge = judged.record;
        if (!judgeCall.ok) {
          // A rate limit that was not tried again only because the other level had decided is no failure of this level.
          const failed = !judged.abandoned && isInfraFailure(judgeCall)
            ? stop(callFailure(`judge:${effort}`, judgeCall, judged.shortened, "judge"))
            : null;
          await recordJudge({ error: judgeCall.error });
          if (failed) return failed;
          if (judged.abandoned) return { leftOff: true };
          failure = `judge_${judgeCall.error}`;
          continue;
        }
        const judgeMismatch = routeMismatch(config, judgeCall);
        if (judgeMismatch) {
          const stopped = stop({ kind: "infra", error: `judge:${effort}:${judgeMismatch}`, modelFailure: true, stage: "judge" });
          await recordJudge({ error: judgeMismatch });
          return stopped;
        }
        const verdict = parseJudgeOutput(judgeCall.content);
        if (verdict && !verdict.faithful) decided = true;
        // The three lists as returned, plus the flat `judgeProblems` list the hold reason and the dashboard use.
        await recordJudge(verdict ? { ...verdict, problems: judgeProblems(verdict) } : { error: "judge_unparseable" });
        if (verdict) return { verdict };
        failure = "judge_unparseable";
      }
      return stop({ kind: "infra", error: `judge:${effort}:${failure || "no_verdict"}`, modelFailure: true, stage: "judge" });
    };
    // Every level settles before anything is returned. A thrown error (the model client never throws) propagates as
    // before; otherwise the first level (in effort order) that stopped decides the retry.
    const outcomes = await Promise.allSettled(AUTOWRITER_JUDGE_EFFORTS.map(judgeLevel));
    const levels: Partial<Record<JudgeEffort, JudgeOutput>> = {};
    let stopped: PipelineResult | null = null;
    for (const [index, level] of outcomes.entries()) {
      if (level.status === "rejected") throw level.reason;
      if ("stop" in level.value) stopped ??= level.value.stop;
      else if ("verdict" in level.value) levels[AUTOWRITER_JUDGE_EFFORTS[index]] = level.value.verdict;
    }
    if (stopped) return ended(stopped);
    // No level stopped: the judges decided this draft, passing or rejecting it.
    judgeAnswered = true;
    // Fail closed: a draft passes only on a verdict from every level (no cast: a level without one cannot be combined).
    // A level that left off gave none — it left off because another level had rejected the draft (had that one
    // stopped, the stop was returned above) — so the draft is rejected on the verdicts given.
    const { medium, high } = levels;
    const verdict = medium && high ? combineJudgeVerdicts({ medium, high }) : null;
    if (!verdict?.faithful) {
      const problems = verdict ? judgeProblems(verdict) : [...new Set([medium, high].flatMap((given) => given ? judgeProblems(given) : []))];
      reasons.push(`${writer.arm}:unfaithful:${problems.slice(0, 3).join(" | ").slice(0, 300)}`);
      continue;
    }
    return { kind: "draft", arm: writer.arm, output: parsed.output, fields, judge: verdict };
  }
  return { kind: "held", reasons };
}
