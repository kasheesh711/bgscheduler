import { and, desc, eq, gte, inArray, lte, min } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import type { PriorFeedbackComparison } from "@/lib/post-class-feedback/similarity";
import type { FeedbackFieldAnswers } from "@/lib/post-class-feedback/types";
import {
  AUTOWRITER_JUDGE_EFFORTS,
  AUTOWRITER_JUDGE_TIMEOUT_MS,
  AUTOWRITER_MAX_TRANSCRIBE_ERRORS,
  AUTOWRITER_MAX_WRITER_ERRORS,
  AUTOWRITER_MODELS,
  AUTOWRITER_THAI_SUMMARY_SHARE,
  AUTOWRITER_TRANSCRIBE_POLL_MS,
  AUTOWRITER_TRANSCRIBE_TIMEOUT_MS,
  AUTOWRITER_TRANSCRIPT_FIRST_FALLBACK_MS,
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
import { callOpenRouter, callWithRateLimitRetries, type OpenRouterCallResult } from "./openrouter";
import { runWritingPipeline, type PipelineResult } from "./pipeline";
import { PROMPT_VERSION, chooseStudentDisplayName, classDetailsBlock, describeClass, redactForModel } from "./prompt";
import { AUTOWRITER_TEACHER_ALLOWLIST, AUTOWRITER_TUTORS, rosterTutor, type AutowriterTutor } from "./roster";
import { mapWithConcurrency } from "./run";
import {
  detailTeacherId,
  detailTeacherName,
  evaluateSessionGates,
  extractAiSummary,
  parseAutowriterSessionDetail,
  recordingForTranscription,
  recordingTooShort,
  scheduledWindow,
  studentParticipants,
  tutorSelfNames,
  zoomTranscriptUrl,
  type AutowriterSessionDetail,
} from "./session";
import { sonioxCostUsd, type SonioxClient, type SonioxToken } from "./soniox";
import { fieldsHash, type WiseFeedbackOps } from "./submit";
import { buildTranscriptEvidence, parseZoomVtt, sonioxJobInput, thaiShare, type ZoomCue } from "./transcript";
import { AUTOWRITER_MIN_SUMMARY_CHARACTERS, type SummaryFallbackCause } from "./types";
import { finalizeFields, parseModelOutput } from "./validate";

/**
 * Replay (read-only): what transcript first would have done with recent classes, before its switch is turned on.
 * Per class: Wise's session detail (one GET), a Soniox transcript of the recording (the job is deleted in `finally`
 * as soon as its transcript is fetched), the transcript draft with its judge at `medium` and `high` on the same
 * messages (production's pipeline: both must pass); a summary draft, judged the same way; and both judge levels on
 * the draft actually posted, against the transcript.
 * Nothing here can write: Wise is reachable only through the one session-detail GET (`ReplayWiseReads`), no database
 * handle is passed in (the caller hands over what it read with `loadReplaySample`), and model calls are kept in memory.
 */

/** The only Wise call the replay can make. */
export type ReplayWiseReads = Pick<WiseFeedbackOps, "getSessionDetailById">;

type CallModel = typeof callOpenRouter;

/** One class to replay, as read (SELECT only) from the autowriter's rows. */
export interface ReplaySample {
  wiseSessionId: string;
  /** The autowriter row's state, or null for a session named on the command line without a row. */
  rowState: string | null;
  /** The draft the autowriter posted (or stored in shadow) for the class, as first posted. */
  postedFields: FeedbackFieldAnswers | null;
  /** `pre_correction_version`: a one-time correction replaced the post; this is the original, from Class Feedback. */
  postedSource: "row" | "pre_correction_version" | "corrected_row" | null;
  /**
   * When Wise announced the class's recording (its first `RecordingCompletedEvent`, from the activity feed or a
   * webhook delivery), if it did. Wise stops listing a recording about a day after class (seen 30 Sep): a class whose
   * recording was published and is gone now cannot be replayed, and is not a fallback production would make.
   */
  recordingPublishedAt?: string | null;
}

/**
 * A transcript collected earlier (the nightly audit's cache, `cache/<sid>/transcript.json`): the production job's,
 * or a re-transcription's. Replaying from it needs no Soniox job at all.
 */
export interface CachedTranscript {
  text: string;
  tokens: SonioxToken[];
  audioDurationMs: number | null;
  source?: string;
}

/** A stand-in for a cache-only replay: not a Soniox client (no key, no network) — every call is refused. */
export function refusingSoniox(): SonioxClient {
  const refuse = async (): Promise<never> => {
    throw new Error("soniox_disabled:replay_from_cache");
  };
  return { create: refuse, get: refuse, transcript: refuse, remove: refuse, list: refuse };
}

export interface ReplayDeps {
  wise: ReplayWiseReads;
  /**
   * Transcribes a class that has no cached transcript. A cache-only replay passes `refusingSoniox()`: no key, no
   * network, and every call refused.
   */
  soniox: SonioxClient;
  apiKey: string;
  /** A cached transcript for the class: used instead of a Soniox job (`soniox.create` is never called for it). */
  transcriptSource?: (wiseSessionId: string) => Promise<CachedTranscript | null>;
  /** With a cache: a class without a cached transcript is `skip:no_cached_transcript` — no model call, no Soniox job. */
  requireCachedTranscript?: boolean;
  /**
   * With `requireCachedTranscript`: instead of skipping a class with no cached transcript, take production's summary
   * route for it (fallback `speakers_unclear`, the reason summary-only posts were written on 2 Oct). No Soniox job.
   * Used to replay summary-only posts through a changed writer/judge.
   */
  summaryWhenNoCachedTranscript?: boolean;
  /** Passes to run besides the transcript draft (both on by default). */
  passes?: { summaryDraft?: boolean; postedJudge?: boolean };
  /** What a draft must not copy (production: `loadTutorPriorFeedback`). */
  priorFeedback: (tutor: AutowriterTutor) => Promise<PriorFeedbackComparison[]>;
  /** Zoom's WEBVTT (tests inject a fake). */
  fetchText?: (url: string) => Promise<string>;
  callModel?: CallModel;
  sleep?: (ms: number) => Promise<void>;
  /** The spread of the wait before a rate-limited model call is tried again (tests inject a fixed one). */
  random?: () => number;
  /** Keep the rendered transcript in the record. Off by default: lesson text stays out of the files. */
  keepTranscripts?: boolean;
  /** Longest wait for one Soniox job (default: production's, `AUTOWRITER_TRANSCRIBE_TIMEOUT_MS`). */
  transcribeTimeoutMs?: number;
  pollMs?: number;
}

export interface ReplayCall {
  purpose: "transcript_draft" | "summary_draft" | "posted_draft";
  role: "writer" | "judge";
  model: string;
  /** The reasoning effort asked for; every draft is judged once per effort in `AUTOWRITER_JUDGE_EFFORTS`. */
  effort: string;
  ok: boolean;
  error: string | null;
  provider: string | null;
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  costUsd: number | null;
  /** Judge calls: the verdict, or null when a reply came back but did not parse. */
  verdict?: JudgeOutput | null;
}

export interface ReplayDraft {
  /** `draft`, `hold:<reasons>` or `error:<message>`. */
  outcome: string;
  arm: string | null;
  /**
   * The writer model (and the host that served it) of the draft — or, for a hold or an error, of the last writer
   * call. Whatever `AUTOWRITER_MODELS` names; never assumed.
   */
  writerModel: string | null;
  writerProvider: string | null;
  /** The draft (name restored), also when it was held. Stays in the local run files, never in the summary. */
  fields: FeedbackFieldAnswers | null;
  judgeHigh: JudgeOutput | null;
  judgeMedium: JudgeOutput | null;
}

export interface ReplayRecord {
  wiseSessionId: string;
  tutor: string | null;
  classEndAt: string | null;
  scheduledMinutes: number | null;
  rowState: string | null;
  /** What transcript first would do: `draft`, `hold:<reason>`, `fallback:<cause>`, `skip:<reason>` or `error:<message>`. */
  outcome: string;
  /** After a fallback, what the summary path gives: `draft`, `hold:<reason>` or `retry:no_summary`. */
  afterFallback: string | null;
  soniox: {
    jobIds: string[];
    attempts: number;
    audioMinutes: number | null;
    costUsd: number | null;
    turnaroundSeconds: number | null;
    /** Jobs whose delete failed (the production reaper removes them after 2 h; listed for a person to check). */
    undeletedJobs: string[];
    error: string | null;
  } | null;
  speakers: { method: string; labels: string; shares: Record<string, number> } | null;
  transcriptCharacters: number | null;
  transcriptDraft: ReplayDraft | null;
  summary: { characters: number; thaiShare: number } | null;
  summaryDraft: ReplayDraft | null;
  /** The posted draft, judged at both levels against the transcript (the verdict is their union). */
  posted: { source: string; verdict: StoredJudgeVerdict | null; problems: string[]; error: string | null } | null;
  calls: ReplayCall[];
  /** Only with `keepTranscripts`. */
  transcript?: string;
}

/** Budget the pipeline sees: generous, so every call gets its production time-out (writer 180 s, judge 120 or 240 s). */
const REPLAY_BUDGET_MS = 15 * 60 * 1000;
/** Tries of one transcript draft: enough for the writer to fail three times in a row (`writer_failed`). */
const REPLAY_TRANSCRIPT_TRIES = AUTOWRITER_MAX_WRITER_ERRORS;
/** Between tries of a transcript draft whose model call failed (production waits 10 minutes; the replay cannot). */
const REPLAY_WRITER_RETRY_PAUSE_MS = 30_000;

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function emptyRecord(sample: ReplaySample): ReplayRecord {
  return {
    wiseSessionId: sample.wiseSessionId, tutor: null, classEndAt: null, scheduledMinutes: null, rowState: sample.rowState,
    outcome: "error:unfinished", afterFallback: null, soniox: null, speakers: null, transcriptCharacters: null,
    transcriptDraft: null, summary: null, summaryDraft: null, posted: null, calls: [],
  };
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

/**
 * Every model call, kept in memory with its tokens, latency and (judge) verdict. The pipeline itself judges every
 * draft at both efforts on the same messages (v5), so the two can be compared on the same draft from its own calls.
 * A rate-limited call tried again in the same run (production's retries) is one entry per attempt.
 * `writerContents` keeps the writer's replies to show a held draft.
 */
function recordingCaller(deps: ReplayDeps, record: ReplayRecord, purpose: ReplayCall["purpose"], options: {
  writerContents?: string[];
} = {}): CallModel {
  const call = deps.callModel ?? callOpenRouter;
  return async (request) => {
    const result: OpenRouterCallResult = await call(request);
    const role = request.schemaName === "feedback_faithfulness" ? "judge" as const : "writer" as const;
    record.calls.push({
      purpose, role, model: request.model, effort: request.effort, ok: result.ok,
      error: result.ok ? null : result.error, provider: result.provider, latencyMs: result.latencyMs,
      promptTokens: result.usage?.promptTokens ?? null, completionTokens: result.usage?.completionTokens ?? null,
      reasoningTokens: result.usage?.reasoningTokens ?? null, costUsd: result.usage?.costUsd ?? null,
      ...(role === "judge" ? { verdict: result.ok ? parseJudgeOutput(result.content) : null } : {}),
    });
    if (role === "writer" && result.ok) options.writerContents?.push(result.content);
    return result;
  };
}

function lastVerdict(record: ReplayRecord, purpose: ReplayCall["purpose"], effort: JudgeEffort): JudgeOutput | null {
  const judged = record.calls.filter((call) => call.purpose === purpose && call.role === "judge" && call.effort === effort && call.verdict);
  return judged.at(-1)?.verdict ?? null;
}

function draftOf(result: PipelineResult, record: ReplayRecord, purpose: ReplayCall["purpose"], writerContents: string[], displayName: string): ReplayDraft {
  const judgeHigh = result.kind === "draft" ? result.judge.levels.high : lastVerdict(record, purpose, "high");
  const judgeMedium = result.kind === "draft" ? result.judge.levels.medium : lastVerdict(record, purpose, "medium");
  // The pipeline returns the first draft that passes, so the last writer call wrote it (or was the last to try).
  const writer = record.calls.filter((call) => call.purpose === purpose && call.role === "writer").at(-1);
  const writerModel = writer?.model ?? null;
  const writerProvider = writer?.provider ?? null;
  if (result.kind === "draft") {
    return { outcome: "draft", arm: result.arm, writerModel, writerProvider, fields: result.fields, judgeHigh, judgeMedium };
  }
  // A held draft is still worth reading: the last writer reply, name restored.
  const parsed = writerContents.length > 0 ? parseModelOutput(writerContents.at(-1)!) : null;
  return {
    outcome: result.kind === "held" ? `hold:${result.reasons.join("; ").slice(0, 600)}` : `error:${result.error}`,
    arm: null,
    writerModel,
    writerProvider,
    fields: parsed?.ok ? finalizeFields(parsed.output, displayName) : null,
    judgeHigh,
    judgeMedium,
  };
}

async function removeJob(soniox: SonioxClient, jobId: string, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await soniox.remove(jobId);
      return true;
    } catch {
      if (attempt < 3) await sleep(2_000);
    }
  }
  return false;
}

/**
 * Transcribe the recording like production (same job input), up to the production failure count. Each job is
 * deleted in `finally` — after its transcript is fetched, on a Soniox error, a time-out or any exception.
 */
async function transcribe(deps: ReplayDeps, input: Parameters<SonioxClient["create"]>[0]): Promise<{
  transcript: { text: string; tokens: SonioxToken[] } | null;
  audioDurationMs: number | null;
  soniox: NonNullable<ReplayRecord["soniox"]>;
}> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = deps.transcribeTimeoutMs ?? AUTOWRITER_TRANSCRIBE_TIMEOUT_MS;
  const stat: NonNullable<ReplayRecord["soniox"]> = {
    jobIds: [], attempts: 0, audioMinutes: null, costUsd: null, turnaroundSeconds: null, undeletedJobs: [], error: null,
  };
  for (let attempt = 1; attempt <= AUTOWRITER_MAX_TRANSCRIBE_ERRORS; attempt += 1) {
    stat.attempts = attempt;
    let jobId: string | null = null;
    try {
      const started = Date.now();
      jobId = (await deps.soniox.create(input)).id;
      stat.jobIds.push(jobId);
      for (;;) {
        let status: Awaited<ReturnType<SonioxClient["get"]>> | null = null;
        try {
          status = await deps.soniox.get(jobId);
        } catch (error) {
          // One failed check is not a failed job; the time-out bounds it.
          stat.error = `soniox_status:${message(error)}`;
        }
        if (status?.status === "completed") {
          const transcript = await deps.soniox.transcript(jobId);
          stat.turnaroundSeconds = Math.round((Date.now() - started) / 1000);
          stat.audioMinutes = status.audioDurationMs === null ? null : round2(status.audioDurationMs / 60_000);
          stat.costUsd = status.audioDurationMs === null ? null : sonioxCostUsd(status.audioDurationMs);
          stat.error = null;
          return { transcript, audioDurationMs: status.audioDurationMs, soniox: stat };
        }
        if (status?.status === "error") throw new Error(`soniox_error:${status.errorMessage ?? "unknown"}`);
        if (Date.now() - started > timeoutMs) throw new Error("soniox_timeout");
        await sleep(deps.pollMs ?? AUTOWRITER_TRANSCRIBE_POLL_MS);
      }
    } catch (error) {
      stat.error = message(error);
    } finally {
      if (jobId && !(await removeJob(deps.soniox, jobId, sleep))) stat.undeletedJobs.push(jobId);
    }
  }
  return { transcript: null, audioDurationMs: null, soniox: stat };
}

async function zoomCues(deps: ReplayDeps, detail: AutowriterSessionDetail): Promise<ZoomCue[]> {
  const url = zoomTranscriptUrl(detail);
  if (!url) return [];
  try {
    return parseZoomVtt(await (deps.fetchText ?? fetchText)(url));
  } catch {
    // Production waits up to 20 minutes for Zoom's transcript, then goes ahead on talk share: the same as none.
    return [];
  }
}

/**
 * The posted draft, judged as production judges a transcript draft — at every effort, on the same messages, passing
 * only when all do — against the transcript; names redacted as for any judge call. One try per level (a rate-limited
 * call is tried again first, as in production).
 */
async function judgePostedDraft(deps: ReplayDeps, record: ReplayRecord, input: {
  fields: FeedbackFieldAnswers;
  source: string;
  rendered: string;
  speakerLabels: "verified" | "inferred";
  names: { studentFullName: string; studentAliases: readonly string[]; tutorNames: readonly string[] };
  classDetails: readonly string[];
}): Promise<NonNullable<ReplayRecord["posted"]>> {
  const redact = (text: string) => redactForModel(text, input.names);
  const judge = AUTOWRITER_MODELS.judge;
  const call = recordingCaller(deps, record, "posted_draft");
  const messages = buildJudgeMessages({
    redactedSummary: redact(input.rendered),
    classDetails: classDetailsBlock(input.classDetails, input.names),
    placeholderFields: {
      topics: redact(input.fields.topics),
      performance: redact(input.fields.performance),
      improvement: redact(input.fields.improvement),
      homework: redact(input.fields.homework),
    },
    evidence: "transcript",
    speakerLabels: input.speakerLabels,
    otherPeople: [],
  });
  const replies = (await Promise.all(AUTOWRITER_JUDGE_EFFORTS.map((effort) => callWithRateLimitRetries({
    call,
    request: {
      apiKey: deps.apiKey,
      model: judge.model,
      provider: judge.provider,
      messages,
      schemaName: "feedback_faithfulness",
      schema: JUDGE_JSON_SCHEMA,
      effort,
      maxTokens: 32_000,
      timeoutMs: AUTOWRITER_JUDGE_TIMEOUT_MS.transcript,
    },
    remainingMs: () => REPLAY_BUDGET_MS,
    sleep: deps.sleep,
    random: deps.random,
  })))).map((made) => made.call);
  const verdicts = replies.map((reply) => reply.ok ? parseJudgeOutput(reply.content) : null);
  const failed = verdicts.findIndex((verdict) => !verdict);
  if (failed >= 0) {
    const reply = replies[failed];
    return {
      source: input.source, verdict: null, problems: [],
      error: `judge:${AUTOWRITER_JUDGE_EFFORTS[failed]}:${reply.ok ? "judge_unparseable" : reply.error}`,
    };
  }
  const verdict = combineJudgeVerdicts(Object.fromEntries(
    AUTOWRITER_JUDGE_EFFORTS.map((effort, index) => [effort, verdicts[index]]),
  ) as Record<JudgeEffort, JudgeOutput>);
  return { source: input.source, verdict, problems: judgeProblems(verdict), error: null };
}

/**
 * Replay one class the way transcript first would handle it now. Never throws: an unexpected error ends the record
 * as `error:<message>` with everything gathered so far; a Soniox job is already deleted by then.
 */
export async function replayClass(deps: ReplayDeps, sample: ReplaySample): Promise<ReplayRecord> {
  const record = emptyRecord(sample);
  try {
    await replayInto(deps, sample, record);
  } catch (error) {
    record.outcome = `error:${message(error)}`;
  }
  return record;
}

async function replayInto(deps: ReplayDeps, sample: ReplaySample, record: ReplayRecord): Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // A cached transcript replaces the Soniox job; without one a cache-only replay skips the class before any call.
  const cached = deps.transcriptSource ? await deps.transcriptSource(sample.wiseSessionId) : null;
  if (!cached && deps.requireCachedTranscript && !deps.summaryWhenNoCachedTranscript) {
    record.outcome = "skip:no_cached_transcript";
    return;
  }
  let detail: AutowriterSessionDetail;
  try {
    detail = parseAutowriterSessionDetail(await deps.wise.getSessionDetailById(sample.wiseSessionId));
  } catch (error) {
    record.outcome = `skip:wise_read_failed:${message(error)}`;
    return;
  }
  const window = scheduledWindow(detail);
  record.classEndAt = window.end.toISOString();
  record.scheduledMinutes = window.minutes;
  const tutor = rosterTutor(detailTeacherId(detail));
  record.tutor = tutor?.canonicalKey ?? null;
  // The gates as they stood before anyone wrote the feedback: no submission yet (a tutor or the autowriter has
  // written it since), attendance settled, and — transcript first — no summary needed.
  const gates = evaluateSessionGates({ ...detail, feedbackSubmissions: [] }, {
    now: new Date(window.end.getTime() + 61 * 60_000), allowlist: AUTOWRITER_TEACHER_ALLOWLIST, requireSummary: false,
  });
  if (!gates.ok) {
    record.outcome = `skip:gate:${gates.reason}`;
    return;
  }
  const [student] = studentParticipants(detail);
  if (!student?.name || !tutor) {
    record.outcome = "hold:missing_student_or_tutor";
    return;
  }
  const names = {
    studentFullName: student.name,
    studentAliases: student.joinedAsGuest ? [student.joinedAsGuest] : [],
    tutorNames: tutor.tutorNames,
  };
  const classDetails = describeClass({ programme: detail.classSubject, title: detail.title });
  const displayName = chooseStudentDisplayName(student.name);
  const session = {
    wiseSessionId: sample.wiseSessionId,
    canonicalTutorKey: tutor.canonicalKey,
    studentFullName: student.name,
    studentAliases: names.studentAliases,
    studentDisplayName: displayName,
    classDetails,
    scheduledMinutes: window.minutes,
  };
  const priorFeedback = await deps.priorFeedback(tutor);
  const summary = extractAiSummary(detail);
  const usableSummary = summary && [...summary.text].length >= AUTOWRITER_MIN_SUMMARY_CHARACTERS ? summary : null;
  record.summary = summary ? { characters: [...summary.text].length, thaiShare: round2(thaiShare(summary.text)) } : null;

  // 1. The transcript route, in production's order.
  let fallback: SummaryFallbackCause | null = null;
  const recording = recordingForTranscription(detail);
  let transcribed: Awaited<ReturnType<typeof transcribe>> | null = null;
  if (cached) {
    // Collected while the recording was still listed: Wise may have dropped it since. Its length still counts.
    if (recording.ok && recordingTooShort(recording.durationSeconds, window.minutes)) {
      record.outcome = "hold:recording_too_short";
    } else {
      transcribed = {
        transcript: { text: cached.text, tokens: cached.tokens },
        audioDurationMs: cached.audioDurationMs,
        soniox: {
          jobIds: [], attempts: 0, audioMinutes: cached.audioDurationMs === null ? null : round2(cached.audioDurationMs / 60_000),
          costUsd: null, turnaroundSeconds: null, undeletedJobs: [], error: null,
        },
      };
    }
  } else if (deps.requireCachedTranscript && deps.summaryWhenNoCachedTranscript) {
    // Cache-only replay of a summary-only post: production's route for it, never a Soniox job.
    fallback = "speakers_unclear";
  } else if (!recording.ok && recording.reason === "recording_not_ready" && sample.recordingPublishedAt) {
    // Published (production transcribes within the hour) but no longer listed by Wise: not replayable.
    record.outcome = "skip:recording_gone";
    return;
  } else if (!recording.ok) {
    fallback = recording.reason === "recording_multiple_parts" ? "recording_multiple_parts" : "no_recording";
  } else if (recordingTooShort(recording.durationSeconds, window.minutes)) {
    record.outcome = "hold:recording_too_short";
  } else {
    transcribed = await transcribe(deps, sonioxJobInput({
      wiseSessionId: sample.wiseSessionId, audioUrl: recording.url, detail, tutorNames: tutor.tutorNames, studentName: student.name,
    }));
  }
  if (transcribed) {
    record.soniox = transcribed.soniox;
    if (!transcribed.transcript) {
      fallback = "soniox_failed";
    } else {
      const evidence = buildTranscriptEvidence({
        transcript: transcribed.transcript, audioDurationMs: transcribed.audioDurationMs, scheduledMinutes: window.minutes,
        zoomCues: await zoomCues(deps, detail), teacherName: detailTeacherName(detail), alsoTeacher: tutorSelfNames(detail),
      });
      record.speakers = { method: evidence.speakers.method, labels: evidence.speakerLabels, shares: evidence.speakers.shares };
      record.transcriptCharacters = evidence.rendered.length;
      if (deps.keepTranscripts) record.transcript = evidence.rendered;
      if (evidence.tooShort) {
        record.outcome = `hold:${evidence.tooShort}`;
      } else if (evidence.speakers.method === "unclear") {
        fallback = "speakers_unclear";
      } else {
        const writerContents: string[] = [];
        const write = () => runWritingPipeline({
          apiKey: deps.apiKey,
          session: { ...session, summary: { text: evidence.rendered, meetingUUIDs: [] }, evidence: "transcript", speakerLabels: evidence.speakerLabels },
          tutorNames: tutor.tutorNames,
          priorFeedback,
          record: async () => {},
          remainingMs: () => REPLAY_BUDGET_MS,
          callModel: recordingCaller(deps, record, "transcript_draft", { writerContents }),
          sleep: deps.sleep,
          random: deps.random,
        });
        // Production retries a transcript draft whose model call failed every 10 minutes. After the third run in a
        // row that ends in a writer failure it writes the class from the summary (`writer_failed`); a judge failure
        // just retries, and a run that ends in one starts that count again; our account's failures (a rate limit,
        // no credit) never count. The replay tries up to three times, a short pause apart, and a call still failing
        // on the last try ends as `error:<who>:…`.
        let writerFailures = 0;
        let tryFrom = record.calls.length;
        let result = await write();
        for (let tries = 1; ; tries += 1) {
          if (result.kind === "infra" && result.stage === "writer" && result.modelFailure) writerFailures += 1;
          else if (result.kind === "infra" && result.stage === "judge") writerFailures = 0;
          if (result.kind !== "infra" || tries >= REPLAY_TRANSCRIPT_TRIES) break;
          await sleep(REPLAY_WRITER_RETRY_PAUSE_MS);
          // The draft, its verdicts and its writer are the last try's.
          tryFrom = record.calls.length;
          writerContents.length = 0;
          result = await write();
        }
        record.transcriptDraft = draftOf(result, { ...record, calls: record.calls.slice(tryFrom) }, "transcript_draft", writerContents, displayName);
        if (writerFailures >= AUTOWRITER_MAX_WRITER_ERRORS) fallback = "writer_failed";
        else record.outcome = record.transcriptDraft.outcome;
      }
      // The draft actually posted for this class, judged against what was said — only on a transcript production
      // would write from (a short one, or one without clear speakers, could flag a sound draft).
      if (sample.postedFields && deps.passes?.postedJudge !== false) {
        const unusable = evidence.tooShort ?? (evidence.speakers.method === "unclear" ? "speakers_unclear" : null);
        record.posted = unusable
          ? { source: sample.postedSource ?? "row", verdict: null, problems: [], error: `transcript_not_usable:${unusable}` }
          : await judgePostedDraft(deps, record, {
            fields: sample.postedFields, source: sample.postedSource ?? "row", rendered: evidence.rendered,
            speakerLabels: evidence.speakerLabels, names, classDetails,
          });
      }
    }
  }

  // 2. A summary draft for every class: the fallback's evidence, and the comparison for the others.
  const summaryPass = deps.passes?.summaryDraft !== false;
  if (usableSummary && summaryPass) {
    const writerContents: string[] = [];
    const result = await runWritingPipeline({
      apiKey: deps.apiKey,
      session: { ...session, summary: usableSummary },
      tutorNames: tutor.tutorNames,
      priorFeedback,
      record: async () => {},
      remainingMs: () => REPLAY_BUDGET_MS,
      callModel: recordingCaller(deps, record, "summary_draft", { writerContents }),
      sleep: deps.sleep,
      random: deps.random,
    });
    record.summaryDraft = draftOf(result, record, "summary_draft", writerContents, displayName);
  }
  if (fallback) {
    record.outcome = `fallback:${fallback}`;
    // What the summary path does after a fallback (processLeased): never back to the transcript.
    record.afterFallback = !usableSummary ? "retry:no_summary"
      : thaiShare(usableSummary.text) >= AUTOWRITER_THAI_SUMMARY_SHARE ? "hold:thai_summary_no_transcript"
        : !summaryPass ? "skip:summary_draft_off"
          : record.summaryDraft?.outcome ?? "error:no_summary_draft";
  }
}

/** Replay classes a few at a time (Soniox jobs run in parallel; Wise reads are paced by the client). */
export async function runReplay(deps: ReplayDeps, samples: readonly ReplaySample[], options: {
  concurrency?: number;
  onRecord?: (record: ReplayRecord, index: number) => void;
  /** Stop starting classes once the model calls of finished classes cost this much (classes in flight still finish). */
  maxModelUsd?: number;
} = {}): Promise<ReplayRecord[]> {
  let spentUsd = 0;
  return mapWithConcurrency(samples, Math.max(1, options.concurrency ?? 3), async (sample, index) => {
    if (options.maxModelUsd !== undefined && spentUsd >= options.maxModelUsd) {
      const skipped = { ...emptyRecord(sample), outcome: "skip:model_budget" };
      options.onRecord?.(skipped, index);
      return skipped;
    }
    const record = await replayClass(deps, sample);
    spentUsd += sum(record.calls.map((call) => call.costUsd));
    options.onRecord?.(record, index);
    return record;
  });
}

// ---------------------------------------------------------------------------
// Sample (reads only)
// ---------------------------------------------------------------------------

/**
 * Finished classes that passed the scope gates: the autowriter posted, stored or held them, or the tutor wrote
 * first. The replay re-checks attendance and student count itself (and skips a class that would not pass).
 */
const REPLAY_ROW_STATES = ["verified", "awaiting_event", "would_submit", "held", "skipped_human", "expired"];
/** Rows whose `fields` are a draft the autowriter posted or stored in shadow. */
const DRAFT_ROW_STATES = new Set(["verified", "awaiting_event", "would_submit"]);

/**
 * The replay's classes (SELECT only): the sessions named, then the most recent `perTutor` in-scope classes of each
 * roster tutor (both accounts) that ended in the last `days` days and at least the fallback time ago, so Wise has
 * had its chance to publish the recording.
 */
export async function loadReplaySample(db: Database, input: {
  sessionIds: readonly string[];
  perTutor: number;
  days: number;
  now: Date;
}): Promise<ReplaySample[]> {
  const S = schema.feedbackAutowriterSessions;
  type Row = typeof S.$inferSelect;
  const rows = new Map<string, Row | null>();
  for (const id of input.sessionIds) rows.set(id, null);
  if (input.sessionIds.length > 0) {
    for (const row of await db.select().from(S).where(inArray(S.wiseSessionId, [...input.sessionIds]))) rows.set(row.wiseSessionId, row);
  }
  if (input.perTutor > 0) {
    const since = new Date(input.now.getTime() - input.days * 24 * 60 * 60 * 1000);
    const endedBy = new Date(input.now.getTime() - AUTOWRITER_TRANSCRIPT_FIRST_FALLBACK_MS);
    for (const tutor of AUTOWRITER_TUTORS) {
      const recent = await db.select().from(S).where(and(
        inArray(S.wiseTeacherUserId, [...tutor.wiseUserIds]),
        inArray(S.state, REPLAY_ROW_STATES as Array<Row["state"]>),
        gte(S.scheduledEndAt, since),
        lte(S.scheduledEndAt, endedBy),
      )).orderBy(desc(S.scheduledEndAt)).limit(input.perTutor);
      for (const row of recent) if (!rows.has(row.wiseSessionId)) rows.set(row.wiseSessionId, row);
    }
  }
  const published = await recordingsPublished(db, [...rows.keys()]);
  const samples: ReplaySample[] = [];
  for (const [wiseSessionId, row] of rows) {
    const draft = row && row.fields && DRAFT_ROW_STATES.has(row.state) ? row.fields as unknown as FeedbackFieldAnswers : null;
    const original = row && draft ? await originalPost(db, row, draft) : null;
    samples.push({
      wiseSessionId,
      rowState: row?.state ?? null,
      postedFields: original?.fields ?? null,
      postedSource: original?.source ?? null,
      recordingPublishedAt: published.get(wiseSessionId)?.toISOString() ?? null,
    });
  }
  return samples;
}

/** The first `RecordingCompletedEvent` per session, from Wise's activity feed and our webhook deliveries (SELECT only). */
async function recordingsPublished(db: Database, sessionIds: readonly string[]): Promise<Map<string, Date>> {
  const first = new Map<string, Date>();
  if (sessionIds.length === 0) return first;
  const note = (sessionId: string | null, at: Date | null) => {
    if (!sessionId || !at) return;
    const known = first.get(sessionId);
    if (!known || at < known) first.set(sessionId, at);
  };
  const A = schema.wiseActivityEvents;
  for (const row of await db.select({ sessionId: A.sessionId, at: min(A.eventTimestamp) }).from(A)
    .where(and(eq(A.eventName, "RecordingCompletedEvent"), inArray(A.sessionId, [...sessionIds])))
    .groupBy(A.sessionId)) note(row.sessionId, row.at);
  const W = schema.wiseWebhookEvents;
  for (const row of await db.select({ sessionId: W.wiseSessionId, at: min(W.receivedAt) }).from(W)
    .where(and(eq(W.eventName, "RecordingCompletedEvent"), inArray(W.wiseSessionId, [...sessionIds])))
    .groupBy(W.wiseSessionId)) note(row.sessionId, row.at);
  return first;
}

/**
 * A one-time correction (`metadata.corrections`, 30 Sep) replaced a post's text in Wise and on the row, keeping only
 * hashes. The original is the Class Feedback version whose four fields hash to the first correction's `fromSha256`.
 */
async function originalPost(db: Database, row: { wiseSessionId: string; metadata: Record<string, unknown> }, fields: FeedbackFieldAnswers): Promise<{
  fields: FeedbackFieldAnswers;
  source: NonNullable<ReplaySample["postedSource"]>;
}> {
  const corrections = row.metadata.corrections;
  const fromSha256 = Array.isArray(corrections) ? (corrections[0] as { fromSha256?: unknown } | undefined)?.fromSha256 : undefined;
  if (typeof fromSha256 !== "string") return { fields, source: "row" };
  const V = schema.postClassFeedbackVersions;
  const versions = await db.select({ topics: V.topics, performance: V.performance, improvement: V.improvement, homework: V.homework })
    .from(V)
    .innerJoin(schema.postClassSessions, eq(schema.postClassSessions.id, V.sessionId))
    .where(and(eq(schema.postClassSessions.wiseSessionId, row.wiseSessionId), eq(V.profile, "teacher")));
  const match = versions.find((version) => fieldsHash(version) === fromSha256);
  return match ? { fields: match, source: "pre_correction_version" } : { fields, source: "corrected_row" };
}

// ---------------------------------------------------------------------------
// Summary (no lesson text)
// ---------------------------------------------------------------------------

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sum(values: ReadonlyArray<number | null>): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

/** The arms a hold reason can start a part with: every model `AUTOWRITER_MODELS` names (the writer may change). */
const WRITER_ARM_PART = new RegExp(
  `; (?:${[...new Set((Object.values(AUTOWRITER_MODELS) as AutowriterModelRoute[]).map((config) => config.arm))].join("|")}):`,
  "u",
);

/**
 * A hold or error reason without the judge's quotes (lesson text): `hold:<arm>:unfaithful:<quotes>; <arm>:unfaithful:<quotes>`
 * → `hold:<arm>:unfaithful; <arm>:unfaithful`. The quotes may contain "; " themselves, so everything after an
 * `:unfaithful:` is dropped up to the next writer's part (`; <arm>:`, for any arm in `AUTOWRITER_MODELS`).
 */
export function reasonCategory(reason: string): string {
  let kept = "";
  let rest = reason;
  for (;;) {
    const at = rest.indexOf(":unfaithful:");
    if (at < 0) return (kept + rest).slice(0, 160);
    kept += `${rest.slice(0, at)}:unfaithful`;
    const next = rest.slice(at).search(WRITER_ARM_PART);
    if (next < 0) return kept.slice(0, 160);
    rest = rest.slice(at + next);
  }
}

function verdictFlags(verdict: JudgeOutput | null): string {
  if (!verdict) return "—";
  if (verdict.faithful) return "faithful";
  return `unfaithful (u${verdict.unsupported.length}/m${verdict.misattributed.length}/h${verdict.homeworkNotSet.length})`;
}

export interface ReplaySummary {
  classes: number;
  /** Classes the transcript route was decided for (not skipped, no error). */
  decided: number;
  outcomes: { draft: number; hold: number; fallback: number; skip: number; error: number };
  holdRate: number | null;
  fallbackRate: number | null;
  holds: Array<{ reason: string; count: number }>;
  fallbacks: Array<{ cause: string; count: number; afterFallback: string[] }>;
  /** Classes not replayed, by reason (gates, a recording Wise no longer lists, a failed read). */
  skips: Array<{ reason: string; count: number }>;
  judge: {
    high: { calls: number; parseFailures: number; errors: number; p50LatencyMs: number | null; p90LatencyMs: number | null; meanReasoningTokens: number | null; costUsd: number };
    medium: { calls: number; parseFailures: number; errors: number; p50LatencyMs: number | null; p90LatencyMs: number | null; meanReasoningTokens: number | null; costUsd: number };
    /** Transcript drafts judged at both efforts: how often they agree on faithful / unfaithful. */
    pairs: number;
    agree: number;
    onlyHighUnfaithful: number;
    onlyMediumUnfaithful: number;
  };
  soniox: {
    jobs: number;
    audioMinutes: number;
    costUsd: number;
    perTranscribedClassUsd: number | null;
    p50TurnaroundSeconds: number | null;
    p90TurnaroundSeconds: number | null;
    undeletedJobs: string[];
  };
  /** Writer calls per draft and model: latency of the answered calls, and each failure (error codes only). */
  writers: Array<{
    purpose: ReplayCall["purpose"];
    model: string;
    calls: number;
    errors: number;
    p50LatencyMs: number | null;
    p90LatencyMs: number | null;
    costUsd: number;
    failures: Array<{ error: string; count: number }>;
  }>;
  modelCostUsd: number;
  posted: {
    judged: number;
    flagged: number;
    misattributed: number;
    homeworkNotSet: number;
    unsupported: number;
    /** Not judged: the transcript was too short or its speakers unclear. */
    notJudged: number;
    /** A judge call that failed or did not parse. */
    parseFailures: number;
  };
  acceptance: {
    transcriptHoldsAtMost15Percent: boolean | null;
    fallbacksAtMost20Percent: boolean | null;
    noJudgeParseFailures: boolean;
    judgeP90AtMost90Seconds: boolean | null;
    sonioxAboutTenCentsPerClass: boolean | null;
  };
}

export function summarizeReplay(records: readonly ReplayRecord[]): ReplaySummary {
  const kind = (record: ReplayRecord) => record.outcome.split(":")[0] as keyof ReplaySummary["outcomes"];
  const outcomes = { draft: 0, hold: 0, fallback: 0, skip: 0, error: 0 };
  for (const record of records) outcomes[kind(record)] = (outcomes[kind(record)] ?? 0) + 1;
  const decided = outcomes.draft + outcomes.hold + outcomes.fallback;
  const tally = (keys: string[]) => {
    const counts = new Map<string, number>();
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
    return [...counts.entries()].toSorted((a, b) => b[1] - a[1]);
  };

  const calls = records.flatMap((record) => record.calls);
  const judgeStats = (effort: JudgeEffort) => {
    const judged = calls.filter((call) => call.role === "judge" && call.effort === effort);
    const answered = judged.filter((call) => call.ok);
    return {
      calls: judged.length,
      parseFailures: answered.filter((call) => !call.verdict).length,
      errors: judged.filter((call) => !call.ok).length,
      p50LatencyMs: percentile(answered.map((call) => call.latencyMs), 50),
      p90LatencyMs: percentile(answered.map((call) => call.latencyMs), 90),
      meanReasoningTokens: mean(answered.flatMap((call) => call.reasoningTokens === null ? [] : [call.reasoningTokens])),
      costUsd: sum(judged.map((call) => call.costUsd)),
    };
  };
  const pairs = records.flatMap((record) => record.transcriptDraft?.judgeHigh && record.transcriptDraft.judgeMedium
    ? [{ high: record.transcriptDraft.judgeHigh.faithful, medium: record.transcriptDraft.judgeMedium.faithful }] : []);

  const transcribed = records.filter((record) => record.soniox && record.soniox.costUsd !== null);
  const sonioxCost = sum(records.map((record) => record.soniox?.costUsd ?? null));
  const turnarounds = records.flatMap((record) => record.soniox?.turnaroundSeconds ?? []);
  const high = judgeStats("high");
  const medium = judgeStats("medium");
  const posted = records.flatMap((record) => record.posted ? [record.posted] : []);
  const perClass = transcribed.length > 0 ? sonioxCost / transcribed.length : null;
  const holdRate = decided > 0 ? outcomes.hold / decided : null;
  const fallbackRate = decided > 0 ? outcomes.fallback / decided : null;

  return {
    classes: records.length,
    decided,
    outcomes,
    holdRate,
    fallbackRate,
    holds: tally(records.filter((record) => kind(record) === "hold").map((record) => reasonCategory(record.outcome.slice("hold:".length))))
      .map(([reason, count]) => ({ reason, count })),
    fallbacks: tally(records.filter((record) => kind(record) === "fallback").map((record) => record.outcome.slice("fallback:".length)))
      .map(([cause, count]) => ({
        cause,
        count,
        afterFallback: records.filter((record) => record.outcome === `fallback:${cause}`).map((record) => reasonCategory(record.afterFallback ?? "—")),
      })),
    skips: tally(records.filter((record) => kind(record) === "skip").map((record) => reasonCategory(record.outcome.slice("skip:".length))))
      .map(([reason, count]) => ({ reason, count })),
    judge: {
      high,
      medium,
      pairs: pairs.length,
      agree: pairs.filter((pair) => pair.high === pair.medium).length,
      onlyHighUnfaithful: pairs.filter((pair) => !pair.high && pair.medium).length,
      onlyMediumUnfaithful: pairs.filter((pair) => pair.high && !pair.medium).length,
    },
    soniox: {
      jobs: records.reduce((total, record) => total + (record.soniox?.jobIds.length ?? 0), 0),
      audioMinutes: round2(sum(records.map((record) => record.soniox?.audioMinutes ?? null))),
      costUsd: sonioxCost,
      perTranscribedClassUsd: perClass,
      p50TurnaroundSeconds: percentile(turnarounds, 50),
      p90TurnaroundSeconds: percentile(turnarounds, 90),
      undeletedJobs: records.flatMap((record) => record.soniox?.undeletedJobs ?? []),
    },
    writers: [...new Map(calls.filter((call) => call.role === "writer")
      .map((call) => [`${call.purpose}|${call.model}`, { purpose: call.purpose, model: call.model }])).values()].map(({ purpose, model }) => {
      const made = calls.filter((call) => call.role === "writer" && call.purpose === purpose && call.model === model);
      const answered = made.filter((call) => call.ok);
      return {
        purpose,
        model,
        calls: made.length,
        errors: made.length - answered.length,
        p50LatencyMs: percentile(answered.map((call) => call.latencyMs), 50),
        p90LatencyMs: percentile(answered.map((call) => call.latencyMs), 90),
        costUsd: sum(made.map((call) => call.costUsd)),
        failures: tally(made.flatMap((call) => call.ok ? [] : [call.error ?? "unknown"])).map(([error, count]) => ({ error, count })),
      };
    }),
    modelCostUsd: sum(calls.map((call) => call.costUsd)),
    posted: {
      judged: posted.filter((entry) => !(entry.error?.startsWith("transcript_not_usable") ?? false)).length,
      flagged: posted.filter((entry) => entry.verdict && !entry.verdict.faithful).length,
      misattributed: posted.filter((entry) => (entry.verdict?.misattributed.length ?? 0) > 0).length,
      homeworkNotSet: posted.filter((entry) => (entry.verdict?.homeworkNotSet.length ?? 0) > 0).length,
      unsupported: posted.filter((entry) => (entry.verdict?.unsupported.length ?? 0) > 0).length,
      notJudged: posted.filter((entry) => entry.error?.startsWith("transcript_not_usable") ?? false).length,
      parseFailures: posted.filter((entry) => !entry.verdict && !(entry.error?.startsWith("transcript_not_usable") ?? false)).length,
    },
    acceptance: {
      transcriptHoldsAtMost15Percent: holdRate === null ? null : holdRate <= 0.15,
      fallbacksAtMost20Percent: fallbackRate === null ? null : fallbackRate <= 0.2,
      noJudgeParseFailures: high.parseFailures === 0 && medium.parseFailures === 0,
      judgeP90AtMost90Seconds: high.p90LatencyMs === null ? null : high.p90LatencyMs <= 90_000,
      // "About $0.10 a class": within $0.05–$0.20 per transcribed class.
      sonioxAboutTenCentsPerClass: perClass === null ? null : perClass >= 0.05 && perClass <= 0.2,
    },
  };
}

function fmt(value: number | null, digits = 1, unit = ""): string {
  return value === null ? "—" : `${value.toFixed(digits)}${unit}`;
}

function pct(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 1000) / 10}%`;
}

/**
 * `summary.md` for a person: rates, acceptance, judge efforts, costs and one line per class. Verdicts are shown as
 * counts and hold reasons without the judge's quotes, so no lesson or feedback text is in it.
 */
export function renderReplayMarkdown(input: { summary: ReplaySummary; records: readonly ReplayRecord[]; commit: string | null; generatedAt: Date }): string {
  const { summary, records } = input;
  const yes = (value: boolean | null) => value === null ? "n/a" : value ? "yes" : "NO";
  const lines = [
    `# Transcript-first replay — ${input.generatedAt.toISOString()}`,
    "",
    `Code \`${input.commit ?? "unknown"}\`; writer v${PROMPT_VERSION} and judge v${JUDGE_PROMPT_VERSION} — writer \`${AUTOWRITER_MODELS.writer.model}\` ` +
      `(fallback \`${AUTOWRITER_MODELS.fallbackWriter.model}\`), judge \`${AUTOWRITER_MODELS.judge.model}\` at ` +
      `${AUTOWRITER_JUDGE_EFFORTS.map((effort) => `\`${effort}\``).join(" and ")} on the same messages (a draft passes only when every level passes it).`,
    `Read-only: Wise session-detail GETs, database SELECTs, Soniox jobs deleted after each transcript; nothing was posted.`,
    "",
    "## Outcomes (what transcript first would do)",
    "",
    "| Outcome | Classes |",
    "|---|---:|",
    ...Object.entries(summary.outcomes).map(([key, count]) => `| ${key} | ${count} |`),
    "",
    `- Decided (not skipped, no error): ${summary.decided} of ${summary.classes}.`,
    ...summary.skips.map((skip) => `  - skipped, ${skip.reason}: ${skip.count}`),
    `- Transcript holds: ${summary.outcomes.hold} (${pct(summary.holdRate)}) — acceptance ≤ 15%: **${yes(summary.acceptance.transcriptHoldsAtMost15Percent)}**`,
    ...summary.holds.map((hold) => `  - ${hold.reason}: ${hold.count}`),
    `- Fallbacks to the summary: ${summary.outcomes.fallback} (${pct(summary.fallbackRate)}) — acceptance ≤ 20%: **${yes(summary.acceptance.fallbacksAtMost20Percent)}**`,
    ...summary.fallbacks.map((fallback) => `  - ${fallback.cause}: ${fallback.count} → then ${fallback.afterFallback.join(", ")}`),
    `- Judge parse failures: high ${summary.judge.high.parseFailures}, medium ${summary.judge.medium.parseFailures} — acceptance 0: **${yes(summary.acceptance.noJudgeParseFailures)}**`,
    `- Judge p90 latency (high): ${fmt(summary.judge.high.p90LatencyMs === null ? null : summary.judge.high.p90LatencyMs / 1000, 1, " s")} — acceptance ≤ 90 s: **${yes(summary.acceptance.judgeP90AtMost90Seconds)}**`,
    `- Soniox per transcribed class: ${fmt(summary.soniox.perTranscribedClassUsd, 3, " USD")} — acceptance ≈ $0.10: **${yes(summary.acceptance.sonioxAboutTenCentsPerClass)}**`,
    "",
    "## Judge: high and medium on the same drafts",
    "",
    "| Effort | Calls | Parse failures | Errors | p50 latency | p90 latency | Mean reasoning tokens | Cost |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...(["high", "medium"] as const).map((effort) => {
      const stats = summary.judge[effort];
      return `| ${effort} | ${stats.calls} | ${stats.parseFailures} | ${stats.errors} | ${fmt(stats.p50LatencyMs === null ? null : stats.p50LatencyMs / 1000, 1, " s")} | ` +
        `${fmt(stats.p90LatencyMs === null ? null : stats.p90LatencyMs / 1000, 1, " s")} | ${fmt(stats.meanReasoningTokens, 0)} | $${stats.costUsd.toFixed(4)} |`;
    }),
    "",
    `Pairs: ${summary.judge.pairs}; same verdict ${summary.judge.agree}; unfaithful at high only ${summary.judge.onlyHighUnfaithful}; ` +
      `unfaithful at medium only ${summary.judge.onlyMediumUnfaithful}. (Pairs are transcript drafts; the rows above cover every judge call: ` +
      "transcript, summary and posted drafts.)",
    "",
    "## Writers",
    "",
    "| Draft | Model | Calls | Failed | p50 latency | p90 latency | Cost | Failures |",
    "|---|---|---:|---:|---:|---:|---:|---|",
    ...summary.writers.map((writer) => `| ${writer.purpose} | ${writer.model} | ${writer.calls} | ${writer.errors} | ` +
      `${fmt(writer.p50LatencyMs === null ? null : writer.p50LatencyMs / 1000, 1, " s")} | ` +
      `${fmt(writer.p90LatencyMs === null ? null : writer.p90LatencyMs / 1000, 1, " s")} | $${writer.costUsd.toFixed(4)} | ` +
      `${writer.failures.map((failure) => `${failure.error.replaceAll("|", "/")} ×${failure.count}`).join(", ") || "—"} |`),
    "",
    `## Posted drafts judged against the transcript (v${JUDGE_PROMPT_VERSION}: both levels)`,
    "",
    `Judged ${summary.posted.judged}; flagged ${summary.posted.flagged} (misattributed ${summary.posted.misattributed}, ` +
      `homework not set ${summary.posted.homeworkNotSet}, unsupported ${summary.posted.unsupported}); not judged (transcript not usable) ` +
      `${summary.posted.notJudged}; judge failed ${summary.posted.parseFailures}.`,
    "",
    "## Costs",
    "",
    `- Soniox: ${summary.soniox.jobs} job(s), ${summary.soniox.audioMinutes} audio minutes, $${summary.soniox.costUsd.toFixed(3)}; ` +
      `turnaround p50 ${fmt(summary.soniox.p50TurnaroundSeconds, 0, " s")}, p90 ${fmt(summary.soniox.p90TurnaroundSeconds, 0, " s")}.`,
    `- Models (OpenRouter, billed): $${summary.modelCostUsd.toFixed(4)}.`,
    `- Soniox jobs not deleted: ${summary.soniox.undeletedJobs.length === 0 ? "none" : summary.soniox.undeletedJobs.join(", ")}.`,
    "",
    "## Per class",
    "",
    "| Session | Tutor | Ended | Row | Outcome | Then | Audio min | Soniox $ | Turnaround | Speakers (T/S %) | Transcript writer | Judge high | Judge medium | Summary draft (writer) | Posted (source) |",
    "|---|---|---|---|---|---|---:|---:|---:|---|---|---|---|---|---|",
    ...records.map((record) => [
      record.wiseSessionId,
      record.tutor ?? "—",
      record.classEndAt?.slice(0, 16) ?? "—",
      record.rowState ?? "—",
      reasonCategory(record.outcome),
      record.afterFallback ? reasonCategory(record.afterFallback) : "",
      fmt(record.soniox?.audioMinutes ?? null, 1),
      record.soniox?.costUsd === null || record.soniox?.costUsd === undefined ? "—" : record.soniox.costUsd.toFixed(3),
      fmt(record.soniox?.turnaroundSeconds ?? null, 0, " s"),
      record.speakers ? `${record.speakers.method} (${record.speakers.shares.tutor}/${record.speakers.shares.student})` : "—",
      record.transcriptDraft?.writerModel ?? "—",
      verdictFlags(record.transcriptDraft?.judgeHigh ?? null),
      verdictFlags(record.transcriptDraft?.judgeMedium ?? null),
      record.summaryDraft ? `${reasonCategory(record.summaryDraft.outcome)} (${record.summaryDraft.writerModel ?? "—"})` : "—",
      record.posted ? `${record.posted.verdict ? verdictFlags(record.posted.verdict) : reasonCategory(record.posted.error ?? "—")} (${record.posted.source})` : "—",
    ].map((cell) => String(cell).replaceAll("|", "/")).join(" | ")).map((row) => `| ${row} |`),
    "",
    "Drafts, verdicts with their quotes and call records are in `records.json` next to this file (local, 0600); " +
      "transcripts only with `--keep-transcripts`.",
    "",
  ];
  return lines.join("\n");
}
