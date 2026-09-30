import { eq, sql } from "drizzle-orm";
import type { ScheduleEmailSender } from "@/lib/classrooms/schedule-email";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { calculateFeedbackDeadline } from "@/lib/post-class-feedback/policy";
import type { PriorFeedbackComparison } from "@/lib/post-class-feedback/similarity";
import type { FeedbackFieldAnswers, FeedbackFieldMapping } from "@/lib/post-class-feedback/types";
import { sendAlertDigest } from "./alerts";
import { resolveBilling } from "./billing";
import {
  AUTOWRITER_EVENT_DEADLINE_MS,
  AUTOWRITER_GENERATION_LEASE_MS,
  AUTOWRITER_MAX_GENERIC_ERRORS,
  AUTOWRITER_MAX_TRANSCRIBE_ERRORS,
  AUTOWRITER_MAX_WRITER_ERRORS,
  AUTOWRITER_MIN_POST_BUDGET_MS,
  AUTOWRITER_NO_RECORDING_ALERT_MS,
  AUTOWRITER_NO_SUMMARY_ALERT_MS,
  AUTOWRITER_NO_SUMMARY_HANDOVER_MINUTES,
  AUTOWRITER_POST_IN_FLIGHT_ATTEMPTS,
  AUTOWRITER_POST_IN_FLIGHT_WAIT_MS,
  AUTOWRITER_RECORDING_RECHECK_MS,
  AUTOWRITER_RETRY_DELAY_MS,
  AUTOWRITER_SONIOX_CLEANUP_MAX,
  AUTOWRITER_SONIOX_REAPER_AGE_MS,
  AUTOWRITER_SONIOX_RETAIN_MS,
  AUTOWRITER_STALE_POSTING_MS,
  AUTOWRITER_SWEEP_MIN_REMAINING_MS,
  AUTOWRITER_THAI_SUMMARY_SHARE,
  AUTOWRITER_TRANSCRIBE_POLL_MS,
  AUTOWRITER_TRANSCRIBE_TIMEOUT_MS,
  AUTOWRITER_TRANSCRIBE_WAIT_MS,
  AUTOWRITER_TRANSCRIBING_RECHECK_MS,
  AUTOWRITER_TRANSCRIPT_FIRST_FALLBACK_MS,
  AUTOWRITER_ZOOM_TRANSCRIPT_RECHECK_MS,
  AUTOWRITER_ZOOM_TRANSCRIPT_WAIT_MS,
} from "./config";
import { JUDGE_PROMPT_VERSION, passingStoredVerdict, type StoredJudgeVerdict } from "./judge";
import { runWritingPipeline, type PipelineResult } from "./pipeline";
import { PROMPT_VERSION, chooseStudentDisplayName, describeClass, type EvidenceKind } from "./prompt";
import { AUTOWRITER_ROSTER, AUTOWRITER_TEACHER_ALLOWLIST, rosterAccountIds, rosterTutor, type AutowriterTutor } from "./roster";
import { loadCandidateShortlist, loadFieldMappings, loadPriorFeedback } from "./run";
import {
  classifyGateReason,
  classifyTeacherSubmission,
  detailClassId,
  detailTeacherId,
  detailTeacherName,
  evaluateSessionGates,
  extractAiSummary,
  parseAutowriterSessionDetail,
  planFeedbackForm,
  recordingForTranscription,
  recordingTooShort,
  scheduledWindow,
  studentParticipants,
  tutorSelfNames,
  zoomTranscriptUrl,
  type AutowriterSessionDetail,
} from "./session";
import {
  WAITING_STATES,
  acquireSweepLease,
  activeSonioxJobIds,
  claimGeneration,
  clearSonioxTranscription,
  ensureSessionRow,
  expireOverdueRows,
  flagNoRecording,
  haltAutowriter,
  listDueRows,
  listPendingAlerts,
  listRowsInState,
  listSonioxCleanup,
  stampSonioxRetention,
  markAlertsSent,
  noteSonioxRecorded,
  readControl,
  readSessionRow,
  recentAutowriterPosts,
  reconcilePostedRow,
  recordCall,
  recordTranscriptionCall,
  releaseGeneration,
  releaseShadowDraft,
  releaseSweepLease,
  sessionSubmitStore,
  setSonioxTranscription,
  stuckPostInFlight,
  updateLeasedTeacher,
  type AlertKind,
  type AutowriterControl,
  type AutowriterSessionRow,
} from "./store";
import {
  classifySubmitEvents,
  creditProblems,
  fieldsHash,
  submitFeedbackGuarded,
  verifyStoredSubmission,
  type SubmitOutcome,
  type WiseFeedbackOps,
} from "./submit";
import { SonioxError, sonioxCostUsd, type SonioxClient } from "./soniox";
import { buildTranscriptEvidence, parseZoomVtt, sonioxJobInput, thaiShare, type ZoomCue } from "./transcript";
import { AUTOWRITER_DEADLINE_MARGIN_MS, type BillingPlan, type ModelArm, type SubmissionState, type SummaryFallbackCause } from "./types";

export interface AutowriterDeps {
  db: Database;
  ops: WiseFeedbackOps;
  apiKey: string | null;
  /** The Wise user behind the API key; confirming submit events must be theirs. */
  apiActorId: string | null;
  /** False on preview deployments: never POST from there. */
  writesAllowedHere: boolean;
  /** Epoch ms by which this invocation must have finished. */
  deadlineMs: number;
  alertRecipients?: readonly string[];
  /** Email relay for the alert digest (tests inject a fake). */
  alertSender?: ScheduleEmailSender;
  /** Second pass (Soniox transcript) switched on (`FEEDBACK_AUTOWRITER_TRANSCRIPTS_ENABLED`). */
  transcriptsEnabled?: boolean;
  soniox?: SonioxClient | null;
  /**
   * Transcript first (`FEEDBACK_AUTOWRITER_TRANSCRIPT_FIRST`): every class that passes the gates is handed to the
   * second pass, and the summary is only the fallback. Acts only while the second pass is on (`transcriptsEnabled`
   * and `soniox`).
   */
  transcriptFirst?: boolean;
  /** Fetches Zoom's WEBVTT (tests inject a fake). */
  fetchText?: (url: string) => Promise<string>;
  now?: () => Date;
  callModel?: Parameters<typeof runWritingPipeline>[0]["callModel"];
  sleep?: (ms: number) => Promise<void>;
}

export type ProcessResult =
  | "preview" | "mode_off" | "halted" | "tutor_off" | "not_roster" | "not_found" | "busy_or_not_due" | "already_handled"
  | "blocked_by_stuck_post" | "awaiting_recording" | "transcribing" | "summary_fallback"
  | "retry" | "skipped_scope" | "skipped_human" | "held" | "expired" | "infra" | "would_submit"
  | "verified" | "awaiting_event" | "unverified" | "rate_limited" | "rejected" | "unknown_outcome" | "verify_failed"
  | "not_claimed" | "aborted";

export interface ProcessOutcome {
  wiseSessionId: string;
  result: ProcessResult;
  detail?: string;
}

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const NO_SUMMARY_REASONS = new Set(["no_ai_summary", "ai_summary_too_short"]);
/** Alert kinds about an actual Wise write: emailed in every mode. */
const POST_ALERT_KINDS = new Set<AlertKind>(["rejected", "unknown_outcome", "verify_failed"]);

function clock(deps: AutowriterDeps): Date {
  return deps.now ? deps.now() : new Date();
}

function remaining(deps: AutowriterDeps): number {
  return deps.deadlineMs - Date.now();
}

async function readDetail(ops: WiseFeedbackOps, wiseSessionId: string, wiseClassId: string | null): Promise<AutowriterSessionDetail | null> {
  try {
    const raw = wiseClassId
      ? await ops.getSessionDetail(wiseClassId, wiseSessionId)
      : await ops.getSessionDetailById(wiseSessionId);
    return parseAutowriterSessionDetail(raw);
  } catch {
    return null;
  }
}

function minutesSinceEnd(detail: AutowriterSessionDetail, now: Date): number {
  return (now.getTime() - scheduledWindow(detail).end.getTime()) / 60_000;
}

/**
 * Handle one Wise session end to end. Safe to call concurrently from the
 * webhook and the cron: only the holder of the generation lease works on it,
 * and only a valid lease under a live, un-halted control row may POST.
 */
export async function processSession(deps: AutowriterDeps, input: {
  wiseSessionId: string;
  wiseClassId?: string | null;
  trigger: "webhook" | "cron" | "cli";
  control?: AutowriterControl;
  mappings?: readonly FeedbackFieldMapping[];
  /** Webhooks: keep re-reading Wise this long while it is not ready yet (summary lags the meeting end by ~20–80 s). */
  waitForReadyMs?: number;
}): Promise<ProcessOutcome> {
  const { db } = deps;
  const out = (result: ProcessResult, detail?: string): ProcessOutcome => ({ wiseSessionId: input.wiseSessionId, result, detail });
  // A preview deployment may share the production database: it never touches state.
  if (!deps.writesAllowedHere) return out("preview");
  const control = input.control ?? await readControl(db);
  if (control.mode === "off") return out("mode_off");
  // Halted: no drafting either (no model calls, no summaries sent) until an owner resumes.
  if (control.haltedAt) return out("halted");

  let row = await readSessionRow(db, input.wiseSessionId);
  if (row && row.state !== "generating" && !(WAITING_STATES as readonly string[]).includes(row.state)) return out("already_handled", row.state);
  if (!row) {
    // Most webhook deliveries are other tutors' classes: answer from the
    // Class Feedback mirror when it already knows the teacher, without a Wise read.
    const [known] = await db.select({ teacherId: schema.postClassSessions.wiseTeacherUserId })
      .from(schema.postClassSessions)
      .where(eq(schema.postClassSessions.wiseSessionId, input.wiseSessionId))
      .limit(1);
    if (known?.teacherId && !AUTOWRITER_TEACHER_ALLOWLIST.has(known.teacherId)) return out("not_roster");
    const detail = await readDetail(deps.ops, input.wiseSessionId, input.wiseClassId ?? null);
    if (!detail) return out("not_found");
    const teacherId = detailTeacherId(detail);
    if (!teacherId || !AUTOWRITER_TEACHER_ALLOWLIST.has(teacherId)) return out("not_roster");
    const window = scheduledWindow(detail);
    await ensureSessionRow(db, {
      wiseSessionId: input.wiseSessionId,
      wiseClassId: detailClassId(detail),
      wiseTeacherUserId: teacherId,
      scheduledEndAt: window.end,
      deadlineAt: calculateFeedbackDeadline(window.end),
      trigger: input.trigger,
    });
    row = await readSessionRow(db, input.wiseSessionId);
    if (!row) return out("not_found");
  }
  if (row.wiseTeacherUserId && control.disabledTutors.includes(row.wiseTeacherUserId)) return out("tutor_off");
  if (!row.wiseClassId) return out("not_found", "class id unknown");
  // A POST stuck waiting for reconciliation blocks every other POST: drafting
  // now would only spend model calls (and send the summary out) for nothing.
  if (control.mode === "live" && await stuckPostInFlight(db, AUTOWRITER_STALE_POSTING_MS)) return out("blocked_by_stuck_post");

  const token = await claimGeneration(db, input.wiseSessionId, AUTOWRITER_GENERATION_LEASE_MS, {
    ignoreRetryWait: input.trigger === "webhook",
  });
  if (!token) return out("busy_or_not_due");
  const release = (to: Parameters<typeof releaseGeneration>[3]) => releaseGeneration(db, input.wiseSessionId, token, to);

  let leased: AutowriterSessionRow | null = null;
  try {
    // Re-read under the lease: another worker may have moved the row since it
    // was first read (a new Soniox job, a stored draft, the second pass).
    leased = await readSessionRow(db, input.wiseSessionId);
    // Taken from us in between (an owner action, the rollback SQL): not ours to work on.
    if (!leased || leased.state !== "generating" || leased.leaseToken !== token) return out("busy_or_not_due", "lease_lost");
    return await processLeased(deps, {
      row: leased, token, control, trigger: input.trigger, mappings: input.mappings, release, out,
      waitForReadyMs: input.waitForReadyMs ?? 0,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 120) : "unknown";
    // Retried, but not until the deadline: the third unexpected error holds the class for a person. Counted from
    // the row as read under the lease (the first read may predate another worker's count).
    const counted = leased ?? row;
    const errors = (Number((counted.metadata as { genericErrors?: unknown }).genericErrors ?? 0) || 0) + 1;
    if (errors >= AUTOWRITER_MAX_GENERIC_ERRORS
      && await release({ state: "held", reason: `error:${message}`, alertKind: "held", countRetry: true, metadata: { genericErrors: errors } })) {
      return out("held", `error:${message}`);
    }
    // Below the cap, or the row had already left `generating` (the error came after a POST claim or a hold):
    // then neither release writes anything, and the error is reported as infra rather than as a hold.
    await release({ state: "pending", reason: `error:${message}`, retryInMs: AUTOWRITER_RETRY_DELAY_MS, countRetry: true, metadata: { genericErrors: errors } });
    return out("infra", error instanceof Error ? error.message.slice(0, 200) : "unknown error");
  }
}

/** The code running now: the Vercel deploy's commit, or the CLI's local checkout (`local:<sha>[+dirty]`). */
function currentCommit(): string | null {
  return process.env.VERCEL_GIT_COMMIT_SHA || process.env.AUTOWRITER_LOCAL_COMMIT || null;
}

/**
 * What produced a draft, stored with it and with the POST claim: the commit, the prompt and judge versions, the
 * model arm and the evidence. Changes that alter output without bumping a version (nicknames, the guest rule) are
 * still traceable by commit. A reused draft keeps the stamp of the attempt that wrote it.
 */
function pipelineStamp(evidence: EvidenceKind, arm: ModelArm): Record<string, unknown> {
  return {
    commitSha: currentCommit(),
    promptVersion: PROMPT_VERSION,
    judgeVersion: JUDGE_PROMPT_VERSION,
    arm,
    evidence,
  };
}

type Release = (to: Parameters<typeof releaseGeneration>[3]) => Promise<boolean>;
type Out = (result: ProcessResult, detail?: string) => ProcessOutcome;
/** A judged draft carried through a retry or hold; never the state decision itself. */
type DraftPatch = Pick<Parameters<Release>[0], "arm" | "fields" | "fieldsSha256" | "billing" | "metadata">;

/** Hand a class to the second pass: wait for Wise's recording, then write from its transcript. */
async function handOverToTranscript(
  release: Release,
  out: Out,
  reason: string,
  metadata: Record<string, unknown> = {},
  /** When to look again: the usual recording recheck unless given (0 = due now). */
  retryInMs: number = AUTOWRITER_RECORDING_RECHECK_MS,
): Promise<ProcessOutcome> {
  await release({
    state: "awaiting_recording",
    evidence: "transcript",
    reason,
    retryInMs,
    metadata: { handover: reason, ...metadata },
  });
  return out("awaiting_recording", reason);
}

/** Transcript first: the moment a class still without a recording falls back to the summary (epoch ms). */
function transcriptFirstFallbackAt(detail: AutowriterSessionDetail): number {
  return scheduledWindow(detail).end.getTime() + AUTOWRITER_TRANSCRIPT_FIRST_FALLBACK_MS;
}

/**
 * Transcript first: when a class still waiting for its recording is looked at again — the usual recheck, but never
 * after its fallback time, so a recording that never comes falls back on time. A `RecordingCompletedEvent` webhook
 * skips the wait either way.
 */
function recordingRecheckMs(detail: AutowriterSessionDetail, now: Date): number {
  return Math.max(0, Math.min(AUTOWRITER_RECORDING_RECHECK_MS, transcriptFirstFallbackAt(detail) - now.getTime()));
}

/** Handed over by transcript first and not fallen back yet: its transcript's failures go back to the summary. */
function mayFallBackToSummary(row: AutowriterSessionRow): boolean {
  const metadata = row.metadata as { handover?: unknown; summaryFallback?: unknown };
  return metadata.handover === "transcript_first" && !metadata.summaryFallback;
}

/**
 * Transcript first: the transcript cannot carry this class (no recording in time, a recording in several parts,
 * speakers that cannot be told apart, Soniox failing three times, the pass switched off, the writer failing three
 * times in a row on the transcript draft), so it goes back to Wise's summary: `pending`,
 * `evidence = summary`, due now, `metadata.summaryFallback {cause, at}`. Once only — a class that
 * fell back never hands over again (`mayHandOver` in processLeased) until an owner retry clears the flags. Any Soniox
 * job stays on the row; the sweep treats the class as done with it (review window, then deletion). A transcript
 * draft kept on the row (a recording that gained a second part, the pass switched off) is dropped with its verdict
 * and stamp: the summary path writes its own.
 */
async function fallBackToSummary(input: {
  release: Release;
  out: Out;
  cause: SummaryFallbackCause;
  now: Date;
  metadata?: Record<string, unknown>;
}): Promise<ProcessOutcome> {
  await input.release({
    state: "pending",
    evidence: "summary",
    reason: `summary_fallback:${input.cause}`,
    arm: null,
    fields: null,
    fieldsSha256: null,
    metadata: {
      ...(input.metadata ?? {}),
      judge: null,
      draftEvidence: null,
      pipeline: null,
      summaryFallback: { cause: input.cause, at: input.now.toISOString() },
    },
  });
  return input.out("summary_fallback", input.cause);
}

/**
 * Settle a failed gate (from the first read or the pre-POST fresh read):
 * retry later in `pending` (keeping any judged draft; both passes — Wise not
 * being ready is not a wait for the recording), hand back to the tutor, or
 * hold / expire with an alert. With the second pass on, a summary that still
 * has not arrived 30 min after class hands the class over to the transcript
 * pass instead of retrying.
 */
async function settleGate(input: {
  reason: string;
  detail: AutowriterSessionDetail;
  row: AutowriterSessionRow;
  now: Date;
  release: Release;
  out: Out;
  draftPatch?: DraftPatch;
  transcriptsEnabled?: boolean;
}): Promise<ProcessOutcome> {
  const { reason, detail, row, now, release, out } = input;
  const minutes = minutesSinceEnd(detail, now);
  const disposition = classifyGateReason(reason, { minutesSinceEnd: minutes });
  if (disposition === "retry") {
    if (input.transcriptsEnabled && NO_SUMMARY_REASONS.has(reason) && minutes >= AUTOWRITER_NO_SUMMARY_HANDOVER_MINUTES) {
      return handOverToTranscript(release, out, "no_usable_summary", { summaryGate: reason });
    }
    const endedAt = row.scheduledEndAt ?? scheduledWindow(detail).end;
    const noSummaryLate = NO_SUMMARY_REASONS.has(reason) && now.getTime() - endedAt.getTime() >= AUTOWRITER_NO_SUMMARY_ALERT_MS;
    await release({
      // A judged draft stopped by a "try later" gate at POST time (e.g. attendance not in yet) is kept for the next attempt.
      ...(input.draftPatch ?? {}),
      state: "pending",
      reason,
      retryInMs: AUTOWRITER_RETRY_DELAY_MS,
      countRetry: true,
      alertKind: noSummaryLate ? "no_summary" : null,
    });
    return out("retry", reason);
  }
  const state = disposition === "scope" ? "skipped_scope" : disposition === "human" ? "skipped_human" : disposition === "expired" ? "expired" : "held";
  const alertKind: AlertKind | null = state === "held" ? "held" : state === "expired" ? "expired" : null;
  await release({ ...(state === "held" ? input.draftPatch ?? {} : {}), state, reason, alertKind });
  return out(state, reason);
}

/**
 * Wise may have moved the class to another teacher since the row was made: the
 * stored teacher is what the per-tutor switch and the POST claim check.
 */
async function followTeacher(deps: AutowriterDeps, input: {
  row: AutowriterSessionRow;
  token: string;
  control: AutowriterControl;
  detail: AutowriterSessionDetail;
  release: Release;
  out: Out;
  /** Where the class waits while its (new) teacher is switched off. */
  retryState: "pending" | "awaiting_recording";
}): Promise<{ row: AutowriterSessionRow } | { outcome: ProcessOutcome }> {
  const fresh = detailTeacherId(input.detail);
  if (!fresh || fresh === input.row.wiseTeacherUserId) return { row: input.row };
  await updateLeasedTeacher(deps.db, input.row.wiseSessionId, input.token, fresh);
  if (input.control.disabledTutors.includes(fresh)) {
    await input.release({ state: input.retryState, reason: "tutor_off", retryInMs: AUTOWRITER_RETRY_DELAY_MS });
    return { outcome: input.out("tutor_off", "teacher changed to a switched-off tutor") };
  }
  return { row: { ...input.row, wiseTeacherUserId: fresh } };
}

/** Form plan and billing: deterministic, so a failure is final for either pass. */
async function planPost(deps: AutowriterDeps, input: {
  detail: AutowriterSessionDetail;
  submission: SubmissionState;
  mappings?: readonly FeedbackFieldMapping[];
  release: Release;
  out: Out;
}): Promise<{ mappings: readonly FeedbackFieldMapping[]; billing: BillingPlan } | { outcome: ProcessOutcome }> {
  const mappings = input.mappings ?? await loadFieldMappings(deps.db);
  const form = planFeedbackForm(input.detail, mappings);
  if (!form.ok) {
    await input.release({ state: "held", reason: form.reason, alertKind: "held" });
    return { outcome: input.out("held", form.reason) };
  }
  const billing = resolveBilling({ submission: input.submission, scheduledMinutes: scheduledWindow(input.detail).minutes });
  if (!billing.ok) {
    await input.release({ state: "held", reason: `billing:${billing.reason}`, alertKind: "held" });
    return { outcome: input.out("held", billing.reason) };
  }
  return { mappings, billing: billing.plan };
}

/**
 * Stored with the POST claim: the student whose credit is checked (reconciliation re-uses it rather than
 * re-deriving it from a later read), and the guest name when a guest join stood in for their account.
 */
function guestMetadata(student: { wiseUserId: string | null; joinedAsGuest?: string | null }): Record<string, unknown> {
  return {
    ...(student.wiseUserId ? { studentWiseUserId: student.wiseUserId } : {}),
    ...(typeof student.joinedAsGuest === "string" ? { studentJoinedAsGuest: student.joinedAsGuest || "(unnamed guest)" } : {}),
  };
}

/**
 * What a new draft must not copy: the tutor's last 90 days of feedback on all their accounts, and the autowriter's
 * own posts for them. Reads only; the replay validates its drafts against the same list.
 */
export async function loadTutorPriorFeedback(db: Database, tutor: Pick<AutowriterTutor, "canonicalKey">, now: Date): Promise<PriorFeedbackComparison[]> {
  return [
    ...(await loadPriorFeedback(db, { canonicalTutorKey: tutor.canonicalKey, now })),
    ...(await recentAutowriterPosts(db, rosterAccountIds(tutor.canonicalKey), new Date(now.getTime() - NINETY_DAYS_MS))),
  ];
}

async function processLeased(deps: AutowriterDeps, input: {
  row: AutowriterSessionRow;
  token: string;
  control: AutowriterControl;
  trigger: string;
  mappings?: readonly FeedbackFieldMapping[];
  release: Release;
  out: Out;
  waitForReadyMs: number;
}): Promise<ProcessOutcome> {
  if (input.row.evidence === "transcript") return processTranscript(deps, input);
  const secondPass = Boolean(deps.transcriptsEnabled && deps.soniox);
  // A class that fell back from the transcript stays on the summary (no loops) until an owner retry clears the flag.
  const fellBack = Boolean((input.row.metadata as { summaryFallback?: unknown }).summaryFallback);
  const mayHandOver = secondPass && !fellBack;
  // Transcript first: every class that passes the gates is handed over before the summary is used at all.
  const transcriptFirst = mayHandOver && Boolean(deps.transcriptFirst);
  const { db, ops } = deps;
  const { release, out } = input;
  let row = input.row;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const waitUntil = Date.now() + Math.min(input.waitForReadyMs, Math.max(0, remaining(deps) - AUTOWRITER_SWEEP_MIN_REMAINING_MS));

  let now = clock(deps);
  let detail: AutowriterSessionDetail | null = null;
  let submission: SubmissionState = { kind: "none" };
  let gateReason: string | null = null;
  // Webhook fast path: while Wise is merely not ready yet (summary, attendance,
  // auto-blank), keep the lease and re-read every 20 s instead of waiting for
  // the next cron tick. Transcript first never waits for the summary.
  for (;;) {
    detail = await readDetail(ops, row.wiseSessionId, row.wiseClassId);
    if (!detail) {
      await release({ state: "pending", reason: "wise_read_failed", retryInMs: AUTOWRITER_RETRY_DELAY_MS, countRetry: true });
      return out("infra", "wise_read_failed");
    }
    now = clock(deps);
    const gates = evaluateSessionGates(detail, { now, allowlist: AUTOWRITER_TEACHER_ALLOWLIST, requireSummary: !transcriptFirst });
    submission = classifyTeacherSubmission(detail);
    gateReason = !gates.ok ? gates.reason : submission.kind === "none" ? "submission_none_not_enabled_in_pilot" : null;
    const retrying = gateReason !== null && classifyGateReason(gateReason, { minutesSinceEnd: minutesSinceEnd(detail, now) }) === "retry";
    if (!retrying || Date.now() + 20_000 > waitUntil) break;
    await sleep(20_000);
  }

  const followed = await followTeacher(deps, { row, token: input.token, control: input.control, detail, release, out, retryState: "pending" });
  if ("outcome" in followed) return followed.outcome;
  row = followed.row;

  if (gateReason) {
    return settleGate({ reason: gateReason, detail, row, now, release, out, transcriptsEnabled: mayHandOver });
  }

  const planned = await planPost(deps, { detail, submission, mappings: input.mappings, release, out });
  if ("outcome" in planned) return planned.outcome;
  const summary = extractAiSummary(detail);
  const [student] = studentParticipants(detail);
  const tutor = rosterTutor(detailTeacherId(detail));
  if (transcriptFirst) {
    // After every gate (a class the tutor already wrote is skipped_human before any Soniox spend) and before
    // anything uses the summary.
    if (!student?.name || !tutor) {
      await release({ state: "held", reason: "missing_student_or_tutor", alertKind: "held" });
      return out("held", "missing_student_or_tutor");
    }
    // Due now when Wise already has the recording (in one part or several: the transcript pass decides);
    // otherwise the usual recheck, never later than the fallback time.
    const recording = recordingForTranscription(detail);
    return handOverToTranscript(release, out, "transcript_first", {
      // For analysis only: how much summary Wise had when the class was handed over.
      summaryAtHandover: summary
        ? { characters: [...summary.text].length, thaiShare: Math.round(thaiShare(summary.text) * 100) / 100 }
        : { characters: 0, thaiShare: null },
    }, recording.ok || recording.reason === "recording_multiple_parts" ? 0 : recordingRecheckMs(detail, now));
  }
  if (!summary || !student?.name || !tutor) {
    await release({ state: "held", reason: "missing_summary_student_or_tutor", alertKind: "held" });
    return out("held", "missing_summary_student_or_tutor");
  }
  // Wise's summary of a mostly-Thai lesson is built from Zoom's Thai transcript,
  // which loses the English terms: write from a Soniox transcript instead.
  const summaryThai = thaiShare(summary.text);
  if (summaryThai >= AUTOWRITER_THAI_SUMMARY_SHARE) {
    if (mayHandOver) return handOverToTranscript(release, out, "thai_summary", { summaryThaiShare: Math.round(summaryThai * 100) / 100 });
    // Back from the transcript, a mostly-Thai summary is still not good enough to write from: a person writes it.
    if (fellBack) {
      await release({
        state: "held", reason: "thai_summary_no_transcript", alertKind: "held",
        metadata: { summaryThaiShare: Math.round(summaryThai * 100) / 100 },
      });
      return out("held", "thai_summary_no_transcript");
    }
  }
  if (!deps.apiKey) {
    await release({ state: "pending", reason: "infra:OPENROUTER_API_KEY missing", retryInMs: AUTOWRITER_RETRY_DELAY_MS, countRetry: true });
    return out("infra", "OPENROUTER_API_KEY missing");
  }

  const result: PipelineResult = await runWritingPipeline({
    apiKey: deps.apiKey,
    session: {
      wiseSessionId: row.wiseSessionId,
      studentFullName: student.name,
      studentAliases: student.joinedAsGuest ? [student.joinedAsGuest] : [],
      studentDisplayName: chooseStudentDisplayName(student.name),
      classDetails: describeClass({ programme: detail.classSubject, title: detail.title }),
      scheduledMinutes: scheduledWindow(detail).minutes,
      summary,
    },
    tutorNames: tutor.tutorNames,
    priorFeedback: await loadTutorPriorFeedback(deps.db, tutor, now),
    record: (record) => recordCall(db, record),
    remainingMs: () => remaining(deps),
    callModel: deps.callModel,
  });
  if (result.kind === "infra") {
    await release({ state: "pending", reason: `infra:${result.error}`, retryInMs: AUTOWRITER_RETRY_DELAY_MS, countRetry: true });
    return out("infra", result.error);
  }
  if (result.kind === "held") {
    const reasons = result.reasons.join("; ").slice(0, 900);
    // The summary could not carry a faithful draft: the transcript usually can (never again after a fallback).
    if (mayHandOver) return handOverToTranscript(release, out, "summary_draft_held", { summaryHold: reasons });
    await release({ state: "held", reason: reasons, countAttempt: true, alertKind: "held" });
    return out("held", result.reasons.join("; "));
  }
  return postDraft(deps, {
    row, token: input.token, control: input.control, detail, submission, billing: planned.billing, mappings: planned.mappings,
    draft: { arm: result.arm, fields: result.fields, judge: result.judge }, evidence: "summary",
    extraMetadata: guestMetadata(student), release, out,
  });
}

/**
 * Shadow: store the judged draft. Live: the guarded POST, waiting briefly while
 * another session's POST is unsettled. Shared by both passes.
 */
async function postDraft(deps: AutowriterDeps, input: {
  row: AutowriterSessionRow;
  token: string;
  control: AutowriterControl;
  detail: AutowriterSessionDetail;
  submission: SubmissionState;
  billing: BillingPlan;
  mappings: readonly FeedbackFieldMapping[];
  draft: StoredDraft;
  evidence: EvidenceKind;
  extraMetadata?: Record<string, unknown>;
  release: Release;
  out: Out;
}): Promise<ProcessOutcome> {
  const { db, ops } = deps;
  const { row, release, out, draft, submission } = input;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // The draft exists: a retry waits for Wise or the POST slot, not for the recording (no `no_recording` alert).
  const pipeline = draft.pipeline ?? pipelineStamp(input.evidence, draft.arm);
  const draftPatch = {
    arm: draft.arm,
    fields: draft.fields,
    fieldsSha256: fieldsHash(draft.fields),
    billing: input.billing,
    metadata: { judge: draft.judge, draftEvidence: input.evidence, pipeline, ...(input.extraMetadata ?? {}) },
  };
  if (input.control.mode !== "live") {
    // Atomic with the mode: a switch to live while this draft was being written
    // sends the row back to `pending` instead of stranding it in `would_submit`.
    const stored = await releaseShadowDraft(db, row.wiseSessionId, input.token, draftPatch);
    return stored === "pending" ? out("retry", "mode_switched_to_live") : out("would_submit", draft.arm);
  }
  if (!deps.apiActorId) {
    await release({ ...draftPatch, state: "pending", reason: "infra:WISE_USER_ID missing", retryInMs: AUTOWRITER_RETRY_DELAY_MS, countRetry: true });
    return out("infra", "WISE_USER_ID missing");
  }
  const requireSummary = input.evidence === "summary";

  // Only one POST may be in flight institution-wide; wait briefly for another
  // session's POST to settle, redoing every pre-POST read each time.
  let outcome: SubmitOutcome;
  for (let attempt = 1; ; attempt += 1) {
    outcome = await submitFeedbackGuarded({
      ops,
      store: sessionSubmitStore(db, row.wiseSessionId, input.token, {
        expected: submission, judge: draft.judge, draftEvidence: input.evidence, pipeline, postedFromCommit: currentCommit(),
        ...(input.extraMetadata ?? {}),
      }),
      plan: {
        sessionId: row.wiseSessionId,
        classId: row.wiseClassId!,
        arm: draft.arm,
        fields: draft.fields,
        billing: input.billing,
        expected: submission,
        mappings: input.mappings,
      },
      gateInput: { now: clock(deps), allowlist: AUTOWRITER_TEACHER_ALLOWLIST, requireSummary },
      apiActorId: deps.apiActorId,
      remainingMs: () => remaining(deps),
      sleep: deps.sleep,
    });
    const blockedByOtherPost = outcome.status === "not_claimed" && outcome.reason === "post_in_flight";
    if (!blockedByOtherPost || attempt >= AUTOWRITER_POST_IN_FLIGHT_ATTEMPTS ||
      remaining(deps) < AUTOWRITER_MIN_POST_BUDGET_MS + AUTOWRITER_POST_IN_FLIGHT_WAIT_MS + 60_000) break;
    // The blocking POST now waits for the sweep: stop spending Wise reads on it.
    if (await stuckPostInFlight(db, AUTOWRITER_STALE_POSTING_MS)) break;
    await sleep(AUTOWRITER_POST_IN_FLIGHT_WAIT_MS);
  }

  switch (outcome.status) {
    case "verified":
    case "awaiting_event":
    case "rate_limited":
    case "rejected":
    case "unknown_outcome":
    case "verify_failed":
      return out(outcome.status);
    case "unverified":
      // Sent; the read-back failed. The row stays `posting` for the sweep to reconcile.
      return out("unverified", outcome.problems.join(", "));
    case "not_claimed":
      // Another POST still in flight, or paused / halted / not live / tutor off /
      // teacher changed / lease lost: nothing was sent. The judged draft is kept.
      await release({
        ...draftPatch,
        state: "pending",
        reason: outcome.reason === "post_in_flight" ? "post_in_flight" : "post_not_claimed",
        retryInMs: outcome.reason === "post_in_flight" ? 60_000 : AUTOWRITER_RETRY_DELAY_MS,
      });
      return out("not_claimed", outcome.reason);
    case "preflight_ok":
      return out("aborted", "unexpected preflight");
    case "aborted_precheck": {
      const reason = outcome.reason;
      if (outcome.gate) {
        return settleGate({ reason, detail: input.detail, row, now: clock(deps), release, out, draftPatch });
      }
      if (/^(detail_read_failed|credits_read_failed|function_budget)/u.test(reason)) {
        await release({ ...draftPatch, state: "pending", reason, retryInMs: AUTOWRITER_RETRY_DELAY_MS, countRetry: true });
        return out("retry", reason);
      }
      if (reason === "submission_changed_to_human") {
        await release({ state: "skipped_human", reason });
        return out("skipped_human", reason);
      }
      await release({ ...draftPatch, state: "held", reason, alertKind: "held" });
      return out("held", reason);
    }
  }
}

/** A judged draft on its way to a POST; `pipeline` is the stamp of the attempt that wrote it, when reused. */
type StoredDraft = { arm: ModelArm; fields: FeedbackFieldAnswers; judge: StoredJudgeVerdict; pipeline?: Record<string, unknown> };

/**
 * A judged transcript draft kept from an attempt whose POST did not go out — only when the current prompt and judge
 * wrote and passed it. v4 (30 Sep): a draft from an older version (or with no stamp) would skip the newer rules and
 * checks, so the class is written and judged again from its kept transcript instead. v5 (30 Sep): only a draft both
 * judge levels passed (`passingStoredVerdict`) — one judged at a single level is judged again, never posted on its
 * old verdict. `requeueShadowDrafts` (store.ts) applies the same test when it decides which drafts keep their
 * transcript's review window.
 */
function reusableTranscriptDraft(row: AutowriterSessionRow): StoredDraft | null {
  const metadata = row.metadata as { draftEvidence?: unknown; judge?: unknown; pipeline?: unknown };
  if (metadata.draftEvidence !== "transcript" || !row.fields || !row.arm) return null;
  const judge = passingStoredVerdict(metadata.judge);
  if (!judge) return null;
  const pipeline = metadata.pipeline && typeof metadata.pipeline === "object" ? metadata.pipeline as Record<string, unknown> : null;
  if (pipeline?.promptVersion !== PROMPT_VERSION || pipeline.judgeVersion !== JUDGE_PROMPT_VERSION) return null;
  return { arm: row.arm, fields: row.fields as unknown as FeedbackFieldAnswers, judge, pipeline };
}

/**
 * Second pass: write from a Soniox transcript of Wise's recording. The lease is
 * held throughout. The Soniox job id is stored as soon as it exists, so a retry
 * re-fetches instead of re-transcribing. Once the class is done with it the job
 * is kept for review for at most 72 h, then the sweep deletes it (and reaps jobs
 * nothing references).
 * Transcript first (`handover = transcript_first`): what the transcript cannot
 * carry — no recording by the fallback time, a recording in several parts,
 * speakers it cannot tell apart, three Soniox failures, the pass switched off,
 * three writer failures in a row on the transcript draft — goes back to the
 * summary once (`fallBackToSummary`). A recording or transcript
 * too short for the class, and a draft the validator or judge rejects, stay holds:
 * the better evidence could not support a draft.
 */
async function processTranscript(deps: AutowriterDeps, input: {
  row: AutowriterSessionRow;
  token: string;
  control: AutowriterControl;
  trigger: string;
  mappings?: readonly FeedbackFieldMapping[];
  release: Release;
  out: Out;
}): Promise<ProcessOutcome> {
  const { db, ops } = deps;
  const { release, out } = input;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let row = input.row;
  // Transcript first: what the transcript cannot carry goes back to the summary instead of to a person.
  const canFallBack = mayFallBackToSummary(row);
  // Where an infra retry waits: a stored judged draft needs only Wise (no `no_recording` alert); a submitted
  // job is followed up sooner than a recording that has not appeared yet.
  const backTo = reusableTranscriptDraft(row) ? "pending" as const
    : row.sonioxTranscriptionId ? "transcribing" as const : "awaiting_recording" as const;

  const detail = await readDetail(ops, row.wiseSessionId, row.wiseClassId);
  if (!detail) {
    await release({ state: backTo, reason: "wise_read_failed", retryInMs: AUTOWRITER_RETRY_DELAY_MS, countRetry: true });
    return out("infra", "wise_read_failed");
  }
  const now = clock(deps);
  const followed = await followTeacher(deps, { row, token: input.token, control: input.control, detail, release, out, retryState: "awaiting_recording" });
  if ("outcome" in followed) return followed.outcome;
  row = followed.row;

  const gates = evaluateSessionGates(detail, { now, allowlist: AUTOWRITER_TEACHER_ALLOWLIST, requireSummary: false });
  const submission = classifyTeacherSubmission(detail);
  const gateReason = !gates.ok ? gates.reason : submission.kind === "none" ? "submission_none_not_enabled_in_pilot" : null;
  // Wise is not ready (attendance, status, …): that is not a wait for the recording.
  if (gateReason) return settleGate({ reason: gateReason, detail, row, now, release, out });

  if (!deps.transcriptsEnabled || !deps.soniox) {
    // Switched off while the class waited: a transcript-first class is written from the summary after all.
    if (canFallBack) return fallBackToSummary({ release, out, cause: "transcript_pass_off", now });
    await release({ state: "held", reason: "transcript_pass_unavailable", alertKind: "held" });
    return out("held", "transcript_pass_unavailable");
  }
  const planned = await planPost(deps, { detail, submission, mappings: input.mappings, release, out });
  if ("outcome" in planned) return planned.outcome;
  const [student] = studentParticipants(detail);
  const tutor = rosterTutor(detailTeacherId(detail));
  if (!student?.name || !tutor) {
    await release({ state: "held", reason: "missing_student_or_tutor", alertKind: "held" });
    return out("held", "missing_student_or_tutor");
  }
  // Re-checked on every attempt: a recording that gained a second part would be half the lesson.
  const recording = recordingForTranscription(detail);
  if (!recording.ok && recording.reason === "recording_multiple_parts") {
    if (canFallBack) return fallBackToSummary({ release, out, cause: "recording_multiple_parts", now });
    await release({ state: "held", reason: recording.reason, alertKind: "held" });
    return out("held", recording.reason);
  }
  // A recording that stopped early would be written up as the whole lesson. Held only
  // when still short 30 min after it was first seen short (wall clock), in case Wise's
  // length was not final at the first read — a repeated webhook cannot shorten the wait.
  const scheduledMinutes = scheduledWindow(detail).minutes;
  if (recording.ok && recordingTooShort(recording.durationSeconds, scheduledMinutes)) {
    const seenAt = metadataDate((row.metadata as { recordingShortSeenAt?: unknown }).recordingShortSeenAt) ?? new Date();
    const waited = Date.now() - seenAt.getTime();
    const metadata = { recordingSeconds: recording.durationSeconds, recordingShortSeenAt: seenAt.toISOString() };
    if (waited < AUTOWRITER_RECORDING_RECHECK_MS) {
      await release({ state: "awaiting_recording", reason: "recording_too_short", retryInMs: AUTOWRITER_RECORDING_RECHECK_MS - waited, metadata });
      return out("awaiting_recording", "recording_too_short");
    }
    await release({ state: "held", reason: "recording_too_short", alertKind: "held", metadata });
    return out("held", "recording_too_short");
  }
  if (!deps.apiKey) {
    await release({ state: backTo, reason: "infra:OPENROUTER_API_KEY missing", retryInMs: AUTOWRITER_RETRY_DELAY_MS, countRetry: true });
    return out("infra", "OPENROUTER_API_KEY missing");
  }

  const soniox = deps.soniox;
  const stored = reusableTranscriptDraft(row);
  if (stored) {
    // The job id stays on the row: the sweep keeps it for review once the class is done with it.
    return postDraft(deps, {
      row, token: input.token, control: input.control, detail, submission, billing: planned.billing, mappings: planned.mappings,
      draft: stored, evidence: "transcript", extraMetadata: guestMetadata(student), release, out,
    });
  }

  const transcribeErrors = Number((row.metadata as { transcribeErrors?: unknown }).transcribeErrors ?? 0) || 0;
  const transcribeFailed = async (reason: string, options: { infra: boolean; keepJob: string | null }): Promise<ProcessOutcome> => {
    const errors = transcribeErrors + 1;
    if (errors >= AUTOWRITER_MAX_TRANSCRIBE_ERRORS) {
      // A job id kept here is kept for review like any finished class's, then deleted by the sweep.
      if (canFallBack) {
        return fallBackToSummary({ release, out, cause: "soniox_failed", now, metadata: { transcribeErrors: errors, sonioxFailure: reason } });
      }
      await release({ state: "held", reason, alertKind: "held", metadata: { transcribeErrors: errors } });
      return out("held", reason);
    }
    await release({
      state: options.keepJob ? "transcribing" : "awaiting_recording",
      reason,
      retryInMs: options.keepJob ? AUTOWRITER_TRANSCRIBING_RECHECK_MS : AUTOWRITER_RECORDING_RECHECK_MS,
      countRetry: true,
      sonioxTranscriptionId: options.keepJob,
      metadata: { transcribeErrors: errors },
    });
    return out(options.infra ? "infra" : "retry", reason);
  };

  // 1. The Soniox job: the one already submitted, or a new one on Wise's recording.
  let jobId = row.sonioxTranscriptionId;
  // When the polled job was submitted: now for a new job; a stored stamp only if it is this job's.
  const stamp = row.metadata as { sonioxSubmittedJob?: unknown; sonioxSubmittedAt?: unknown };
  let submittedAt = jobId && stamp.sonioxSubmittedJob === jobId ? metadataDate(stamp.sonioxSubmittedAt) : null;
  if (!jobId) {
    if (!recording.ok) {
      // Transcript first: still no recording at the fallback time → the summary (no `no_recording` alert);
      // until then the recheck never lands after that time.
      if (canFallBack && now.getTime() >= transcriptFirstFallbackAt(detail)) {
        return fallBackToSummary({ release, out, cause: "no_recording", now });
      }
      await release({
        state: "awaiting_recording", reason: recording.reason,
        retryInMs: canFallBack ? recordingRecheckMs(detail, now) : AUTOWRITER_RECORDING_RECHECK_MS,
      });
      return out("awaiting_recording", recording.reason);
    }
    try {
      jobId = (await soniox.create(sonioxJobInput({
        wiseSessionId: row.wiseSessionId, audioUrl: recording.url, detail, tutorNames: tutor.tutorNames, studentName: student.name,
      }))).id;
    } catch (error) {
      return transcribeFailed(`soniox_create:${error instanceof Error ? error.message.slice(0, 120) : "error"}`, { infra: true, keepJob: null });
    }
    submittedAt = new Date();
    await setSonioxTranscription(db, row.wiseSessionId, input.token, jobId);
  }

  // 2. Wait for it — webhooks wait up to ~3 min; the backstop only looks, so it never starves other classes.
  const started = Date.now();
  const waitMs = input.trigger === "cron"
    ? 0
    : Math.min(AUTOWRITER_TRANSCRIBE_WAIT_MS, Math.max(0, remaining(deps) - AUTOWRITER_SWEEP_MIN_REMAINING_MS));
  const maxPolls = Math.max(1, Math.ceil(waitMs / AUTOWRITER_TRANSCRIBE_POLL_MS));
  let status: Awaited<ReturnType<typeof soniox.get>> | null = null;
  let lastGetError: string | null = null;
  for (let polls = 1; ; polls += 1) {
    try {
      status = await soniox.get(jobId);
    } catch (error) {
      // An unknown job (deleted, expired) cannot finish: start over on a new one.
      if (error instanceof SonioxError && error.status === 404) {
        await clearSonioxTranscription(db, row.wiseSessionId, jobId);
        return transcribeFailed("soniox_job_missing", { infra: false, keepJob: null });
      }
      // A failed check after a good one keeps the good answer: only never reaching Soniox counts as an error.
      lastGetError = error instanceof Error ? error.message.slice(0, 120) : "error";
    }
    if (status?.status === "completed" || status?.status === "error") break;
    if (polls >= maxPolls || Date.now() - started + AUTOWRITER_TRANSCRIBE_POLL_MS > waitMs) break;
    await sleep(AUTOWRITER_TRANSCRIBE_POLL_MS);
  }
  if (!status) {
    // Soniox could not be asked (key, credit, outage): an error, counted toward the hold.
    return transcribeFailed(`soniox_status:${lastGetError ?? "unknown"}`, { infra: true, keepJob: jobId });
  }
  if (status.status === "queued" || status.status === "processing") {
    // Wall clock, like the stored submit time. An hour of audio took 2–7 min in the pilot.
    if (submittedAt && Date.now() - submittedAt.getTime() > AUTOWRITER_TRANSCRIBE_TIMEOUT_MS) {
      const gone = await soniox.remove(jobId).catch(() => null);
      if (gone) await clearSonioxTranscription(db, row.wiseSessionId, jobId);
      return transcribeFailed("soniox_timeout", { infra: true, keepJob: gone ? null : jobId });
    }
    await release({ state: "transcribing", reason: "transcription_in_progress", retryInMs: AUTOWRITER_TRANSCRIBING_RECHECK_MS, sonioxTranscriptionId: jobId });
    return out("transcribing", jobId);
  }
  if (status.status === "error") {
    const gone = await soniox.remove(jobId).catch(() => null);
    if (gone) await clearSonioxTranscription(db, row.wiseSessionId, jobId);
    await recordTranscriptionCall(db, {
      wiseSessionId: row.wiseSessionId, ok: false, audioDurationMs: status.audioDurationMs, latencyMs: Date.now() - started,
      costUsd: null, error: status.errorMessage ?? "error",
    });
    return transcribeFailed(`soniox_error:${(status.errorMessage ?? "unknown").slice(0, 120)}`, { infra: false, keepJob: gone ? null : jobId });
  }

  // 3. Fetch (the job stays at Soniox until the class's review window ends; re-fetching is free).
  let transcript: Awaited<ReturnType<typeof soniox.transcript>>;
  try {
    transcript = await soniox.transcript(jobId);
  } catch (error) {
    return transcribeFailed(`soniox_fetch:${error instanceof Error ? error.message.slice(0, 120) : "error"}`, { infra: true, keepJob: jobId });
  }
  const audioDurationMs = status.audioDurationMs ?? 0;
  if ((row.metadata as { sonioxRecordedJob?: unknown }).sonioxRecordedJob !== jobId) {
    await recordTranscriptionCall(db, {
      wiseSessionId: row.wiseSessionId, ok: true, audioDurationMs, latencyMs: Date.now() - started,
      costUsd: sonioxCostUsd(audioDurationMs),
    });
    await noteSonioxRecorded(db, row.wiseSessionId, jobId);
  }

  // 4. Who is who: Zoom's named cues when available, a clear talk-share split otherwise.
  let cues: ZoomCue[] = [];
  // Not published yet (or not readable right now) — as opposed to published without the teacher's name.
  let zoomPending = true;
  const vttUrl = zoomTranscriptUrl(detail);
  if (vttUrl) {
    try {
      cues = parseZoomVtt(await (deps.fetchText ?? fetchText)(vttUrl));
      zoomPending = false;
    } catch {
      cues = [];
    }
  }
  const evidence = buildTranscriptEvidence({
    transcript, audioDurationMs: status.audioDurationMs, scheduledMinutes,
    zoomCues: cues, teacherName: detailTeacherName(detail), alsoTeacher: tutorSelfNames(detail),
  });
  const { speakers, rendered, meta: transcriptMeta } = evidence;
  const holdFor = async (reason: string) => {
    await release({ state: "held", reason, alertKind: "held", metadata: { transcript: transcriptMeta } });
    return out("held", reason);
  };
  // Soniox's own audio length catches a recording Wise gave no length for; then the transcript's own length.
  if (evidence.tooShort) return holdFor(evidence.tooShort);
  // Zoom's named transcript follows the recording by a few minutes: wait for it (keeping the job) so the
  // labels are confirmed — only when it could name the tutor (Wise gives the teacher's name), only for a job
  // this row stamped, and only up to the wait from its submit time.
  const teacherName = detailTeacherName(detail);
  if (zoomPending && teacherName && submittedAt && Date.now() - submittedAt.getTime() < AUTOWRITER_ZOOM_TRANSCRIPT_WAIT_MS) {
    await release({
      state: "transcribing", reason: "zoom_transcript_pending", retryInMs: AUTOWRITER_ZOOM_TRANSCRIPT_RECHECK_MS,
      sonioxTranscriptionId: jobId, metadata: { transcript: transcriptMeta },
    });
    return out("transcribing", "zoom_transcript_pending");
  }
  if (speakers.method === "unclear") {
    // Transcript first: without knowing who said what the summary is the better evidence.
    if (canFallBack) return fallBackToSummary({ release, out, cause: "speakers_unclear", now, metadata: { transcript: transcriptMeta } });
    return holdFor("speakers_unclear");
  }

  // 5. Write and judge from the transcript (Sol, Luna fallback, GLM judge — zero-retention routes only).
  const result = await runWritingPipeline({
    apiKey: deps.apiKey,
    session: {
      wiseSessionId: row.wiseSessionId,
      studentFullName: student.name,
      studentAliases: student.joinedAsGuest ? [student.joinedAsGuest] : [],
      studentDisplayName: chooseStudentDisplayName(student.name),
      classDetails: describeClass({ programme: detail.classSubject, title: detail.title }),
      scheduledMinutes,
      summary: { text: rendered, meetingUUIDs: [] },
      evidence: "transcript",
      speakerLabels: evidence.speakerLabels,
    },
    tutorNames: tutor.tutorNames,
    priorFeedback: await loadTutorPriorFeedback(deps.db, tutor, now),
    record: (record) => recordCall(db, record),
    remainingMs: () => remaining(deps),
    callModel: deps.callModel,
  });
  if (result.kind === "infra") {
    // Transcript first (owner decisions, 30 Sep): the writer failing on the transcript draft (a time-out, a reply
    // that is not JSON, a provider error, an unusable route) is retried, but the third failure in a row writes the
    // class from the summary instead of retrying until the deadline. Only the writer's failures count: a judge
    // failure just retries, and since the writer then delivered a draft the count starts again. Wise and Soniox
    // errors count apart (above); our function's time, our OpenRouter account and our connection are not the
    // writer's failure (`modelFailure`) and leave the count as it is.
    const writerFailed = canFallBack && result.stage === "writer" && result.modelFailure;
    const writerDelivered = canFallBack && result.stage === "judge";
    const previousErrors = Number((row.metadata as { writerErrors?: unknown }).writerErrors ?? 0) || 0;
    const writerErrors = writerFailed ? previousErrors + 1 : writerDelivered ? 0 : previousErrors;
    if (writerFailed && writerErrors >= AUTOWRITER_MAX_WRITER_ERRORS) {
      return fallBackToSummary({
        release, out, cause: "writer_failed", now, metadata: { transcript: transcriptMeta, writerErrors, writerFailure: result.error },
      });
    }
    // The job is kept: the next attempt re-fetches the same transcript.
    await release({
      state: "transcribing", reason: `infra:${result.error}`, retryInMs: AUTOWRITER_RETRY_DELAY_MS, countRetry: true,
      sonioxTranscriptionId: jobId,
      metadata: { transcript: transcriptMeta, ...(writerFailed || writerDelivered ? { writerErrors } : {}) },
    });
    return out("infra", result.error);
  }
  if (result.kind === "held") return holdFor(result.reasons.join("; ").slice(0, 900));
  // The judged draft is stored with the job id; once the class is done, the sweep keeps the job for review only.
  return postDraft(deps, {
    row, token: input.token, control: input.control, detail, submission, billing: planned.billing, mappings: planned.mappings,
    draft: { arm: result.arm, fields: result.fields, judge: result.judge }, evidence: "transcript",
    // The writer delivered: a later failure (a requeued shadow draft written again) starts a new count.
    extraMetadata: { transcript: transcriptMeta, ...guestMetadata(student), ...(canFallBack ? { writerErrors: 0 } : {}) },
    release, out,
  });
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

// ---------------------------------------------------------------------------
// Reconciliation of rows that already POSTed
// ---------------------------------------------------------------------------

function expectedFromRow(row: AutowriterSessionRow): SubmissionState | null {
  const expected = (row.metadata as { expected?: SubmissionState }).expected;
  return expected?.kind === "auto_blank" ? expected : null;
}

function metadataDate(value: unknown): Date | null {
  const at = typeof value === "string" ? new Date(value) : null;
  return at && !Number.isNaN(at.getTime()) ? at : null;
}

function freshReadAtFromRow(row: AutowriterSessionRow): Date | null {
  return metadataDate((row.metadata as { freshReadAt?: unknown }).freshReadAt);
}

function postFinishedAtFromRow(row: AutowriterSessionRow): Date | null {
  return metadataDate((row.metadata as { post?: { postFinishedAt?: unknown } }).post?.postFinishedAt);
}

/**
 * Reads only, never a re-POST.
 * - `posting` (the worker died or its read-back failed): the stored submission,
 *   status, credits and the student's credit entry are checked again first.
 * - both states: the events are checked for a teacher/admin save inside the
 *   POST window (fresh read → POST response), then for our submit event. Later
 *   admin edits are outside the window and never re-checked against our text.
 * Every halt is written BEFORE the row leaves `posting`/`awaiting_event`, so the
 * single-POST lock can never open ahead of the halt; if the halt write fails
 * the row stays put and blocks every POST.
 * Reads that keep failing for 2 h after the POST → verify_failed + halt.
 * Returns `read_failed` when a read failed and there is still time.
 */
async function reconcileRow(deps: AutowriterDeps, row: AutowriterSessionRow, from: "posting" | "awaiting_event"): Promise<string> {
  const { db, ops } = deps;
  const settle = async (state: "unknown_outcome" | "verify_failed", haltReason: string, detail: Record<string, unknown>) => {
    await haltAutowriter(db, haltReason);
    await reconcilePostedRow(db, row.wiseSessionId, from, { state, detail });
    return state;
  };
  const expected = expectedFromRow(row);
  if (!row.wiseClassId || !row.fields || !row.billing || !expected || !row.postStartedAt || !deps.apiActorId) {
    return settle("unknown_outcome", `cannot reconcile ${row.wiseSessionId}`, { error: "row incomplete for reconciliation" });
  }
  const postStartedAt = row.postStartedAt;
  const overdue = clock(deps).getTime() - postStartedAt.getTime() > AUTOWRITER_EVENT_DEADLINE_MS;
  const giveUp = (problems: string[]) =>
    settle("verify_failed", `feedback POST on ${row.wiseSessionId} could not be verified: ${problems.join(", ")}`, { problems });

  if (from === "posting") {
    const detail = await readDetail(ops, row.wiseSessionId, row.wiseClassId);
    if (!detail) return overdue ? giveUp(["session_unreadable_2h_after_post"]) : "read_failed";
    const billing = row.billing as unknown as BillingPlan;
    const problems = verifyStoredSubmission(detail, {
      fields: row.fields as unknown as FeedbackFieldAnswers,
      billing,
      expected,
      mappings: await loadFieldMappings(db),
    });
    // The student credit-checked when the POST was claimed; a later read may pick participants differently.
    const claimedStudent = (row.metadata as { studentWiseUserId?: unknown }).studentWiseUserId;
    const studentId = typeof claimedStudent === "string" ? claimedStudent : studentParticipants(detail)[0]?.wiseUserId ?? null;
    if (!studentId) {
      problems.push("student_id_missing");
    } else {
      try {
        problems.push(...creditProblems(await ops.getSessionCreditEntries(row.wiseClassId, studentId, row.wiseSessionId), billing));
      } catch {
        return overdue ? giveUp(["credits_unreadable_2h_after_post"]) : "read_failed";
      }
    }
    if (problems.length > 0) {
      return settle("unknown_outcome", `post for ${row.wiseSessionId} not found as sent: ${problems.join(", ")}`, { problems });
    }
  }

  const freshReadAt = freshReadAtFromRow(row) ?? new Date(postStartedAt.getTime() - 60_000);
  let events;
  try {
    events = await ops.findFeedbackEvents(row.wiseClassId, row.wiseSessionId, new Date(freshReadAt.getTime() - 5_000));
  } catch {
    if (overdue) return giveUp(["events_unreadable_2h_after_post"]);
    // The stored submission is verified; the events (ours, and any save in the
    // POST window) are checked again on every sweep while `awaiting_event`.
    if (from === "posting") await reconcilePostedRow(db, row.wiseSessionId, from, { state: "awaiting_event", detail: { eventsReadFailed: true } });
    return "read_failed";
  }
  const found = classifySubmitEvents(events, {
    apiActorId: deps.apiActorId,
    freshReadAt,
    postStartedAt,
    postFinishedAt: postFinishedAtFromRow(row),
  });
  if (found.foreign.length > 0) return giveUp(["foreign_submit_event_in_post_window"]);
  if (found.ours) {
    await reconcilePostedRow(db, row.wiseSessionId, from, { state: "verified", detail: { event: { ...found.ours, at: found.ours.at.toISOString() } } });
    return "verified";
  }
  if (overdue) return giveUp(["no_submit_event_after_2h"]);
  if (from === "posting") await reconcilePostedRow(db, row.wiseSessionId, from, { state: "awaiting_event", detail: {} });
  return "awaiting_event";
}

// ---------------------------------------------------------------------------
// Sweep (backstop cron and manual runs)
// ---------------------------------------------------------------------------

export interface SweepResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string | null;
  error?: string;
  mode: AutowriterControl["mode"];
  halted: boolean;
  processed: Record<string, number>;
  reconciled: Record<string, number>;
  expired: number;
  alertsSent: number;
  alertsSuppressed: number;
  infraErrors: string[];
}

function tally(target: Record<string, number>, key: string) {
  target[key] = (target[key] ?? 0) + 1;
}

/**
 * 1. Reconcile POSTs whose outcome is not final (every mode, reads only).
 * 2. Expire what can no longer land before its deadline (not in `off`).
 * 3. Queue and process due sessions, most urgent first (not in `off`, not while halted).
 * 4. One alert digest. Outside `live`, alerts about drafts (held / expired /
 *    no summary) are recorded but not emailed — tutors still write their own.
 */
export async function runSweep(deps: AutowriterDeps): Promise<SweepResult> {
  const { db } = deps;
  const control = await readControl(db);
  const base = {
    mode: control.mode, halted: Boolean(control.haltedAt), processed: {}, reconciled: {}, expired: 0,
    alertsSent: 0, alertsSuppressed: 0, infraErrors: [] as string[],
  };
  if (!deps.writesAllowedHere) return { ...base, ok: true, skipped: true, reason: "Preview deployment: the autowriter never runs here." };
  const lease = await acquireSweepLease(db, Math.max(60_000, remaining(deps) + 60_000));
  if (!lease) return { ...base, ok: true, skipped: true, reason: "Another autowriter sweep holds the lease." };
  const processed: Record<string, number> = {};
  const reconciled: Record<string, number> = {};
  const infraErrors: string[] = [];
  let expired = 0;
  let alertError: string | null = null;
  let alertsSent = 0;
  let alertsSuppressed = 0;
  try {
    const now = clock(deps);
    // 1. Posts whose outcome is not final yet: reads only, never re-POST.
    const stalePosting = (await listRowsInState(db, ["posting"]))
      .filter((row) => row.postStartedAt && now.getTime() - row.postStartedAt.getTime() > AUTOWRITER_STALE_POSTING_MS);
    for (const row of [...stalePosting, ...(await listRowsInState(db, ["awaiting_event"]))]) {
      if (remaining(deps) < 60_000) break;
      const result = await reconcileRow(deps, row, row.state === "posting" ? "posting" : "awaiting_event");
      tally(reconciled, result);
      if (result === "read_failed") infraErrors.push(`${row.wiseSessionId}: Wise read failed while reconciling a ${row.state} row`);
    }

    if (control.mode !== "off") {
      // 2. Expire anything that can no longer land before its deadline.
      const settled = await expireOverdueRows(db, {
        cutoff: new Date(now.getTime() + AUTOWRITER_DEADLINE_MARGIN_MS),
        disabledTutors: control.disabledTutors,
      });
      expired = settled.expired;

      // 3. New and due sessions for roster tutors that are switched on.
      const enabledTutors = AUTOWRITER_ROSTER.map((tutor) => tutor.wiseUserId)
        .filter((id) => !control.disabledTutors.includes(id));
      for (const candidate of await loadCandidateShortlist(db, { teacherIds: enabledTutors, now })) {
        await ensureSessionRow(db, {
          wiseSessionId: candidate.wiseSessionId,
          wiseClassId: candidate.wiseClassId,
          wiseTeacherUserId: candidate.wiseTeacherUserId,
          scheduledEndAt: candidate.scheduledEndAt,
          deadlineAt: candidate.deadlineAt,
          trigger: "cron",
        });
      }
      if (!control.haltedAt) {
        const due = (await listDueRows(db))
          .filter((row) => !row.wiseTeacherUserId || !control.disabledTutors.includes(row.wiseTeacherUserId));
        const mappings = await loadFieldMappings(db);
        for (const row of due) {
          if (remaining(deps) < AUTOWRITER_SWEEP_MIN_REMAINING_MS) break;
          // Re-read the switches per session: a halt, pause or mode change made
          // while this sweep runs (e.g. by a webhook worker's POST) applies at once.
          const current = await readControl(db);
          if (current.haltedAt || current.mode === "off") break;
          if (row.wiseTeacherUserId && current.disabledTutors.includes(row.wiseTeacherUserId)) continue;
          const outcome = await processSession(deps, { wiseSessionId: row.wiseSessionId, wiseClassId: row.wiseClassId, trigger: "cron", control: current, mappings });
          tally(processed, outcome.result);
          if (outcome.result === "infra" && outcome.detail) infraErrors.push(`${row.wiseSessionId}: ${outcome.detail}`);
        }
      }
    }

    // 3b. Second pass housekeeping, within what is left of the budget.
    if (deps.soniox) await cleanUpSonioxJobs(deps, deps.soniox);
    // Still waiting for a recording 3 h after class: tell a person now, not at the deadline.
    await flagNoRecording(db, new Date(now.getTime() - AUTOWRITER_NO_RECORDING_ALERT_MS), control.disabledTutors);

    // 4. One alert digest for everything that needs a person.
    const alerts = await listPendingAlerts(db);
    if (alerts.length > 0) {
      const latest = await readControl(db);
      const emailed = latest.mode === "live" ? alerts : alerts.filter((alert) => POST_ALERT_KINDS.has(alert.kind));
      const suppressed = alerts.filter((alert) => !emailed.includes(alert));
      if (suppressed.length > 0) {
        await markAlertsSent(db, suppressed, `suppressed:${latest.mode}`);
        alertsSuppressed = suppressed.length;
      }
      if (emailed.length > 0) {
        const sent = await sendAlertDigest({
          alerts: emailed,
          recipients: deps.alertRecipients ?? [],
          halt: { haltedAt: latest.haltedAt, haltReason: latest.haltReason },
          sender: deps.alertSender,
        });
        if (sent.sent) {
          await markAlertsSent(db, emailed);
          alertsSent = emailed.length;
        } else {
          alertError = sent.error;
        }
      }
    }
  } finally {
    await releaseSweepLease(db, lease);
  }

  const after = await readControl(db);
  const halted = Boolean(after.haltedAt);
  const problems = [
    ...(halted ? [`Autowriter halted: ${after.haltReason ?? "no reason recorded"}`] : []),
    ...(infraErrors.length > 0 ? [`${infraErrors.length} infrastructure error(s): ${infraErrors.slice(0, 3).join(" | ")}`] : []),
    ...(alertError ? [`Alert digest not delivered: ${alertError}`] : []),
  ];
  return {
    ok: problems.length === 0,
    ...(problems.length > 0 ? { error: problems.join(" ").slice(0, 900) } : {}),
    mode: after.mode,
    halted,
    processed,
    reconciled,
    expired,
    alertsSent,
    alertsSuppressed,
    infraErrors,
  };
}

/**
 * Keep finished classes' Soniox jobs for review, then delete them: the first
 * sweep to see a class done with its job starts a 72 h window (owner decision,
 * 29 Sep), and a later sweep deletes the job once the window is over or the
 * class is triaged. Orphans no row references (a create that timed out after
 * Soniox accepted it, or a worker that died before storing the id) are reaped
 * too. Bounded per sweep; failures are retried next time.
 */
export async function cleanUpSonioxJobs(deps: AutowriterDeps, soniox: SonioxClient): Promise<void> {
  const { db } = deps;
  let budget = AUTOWRITER_SONIOX_CLEANUP_MAX;
  await stampSonioxRetention(db, AUTOWRITER_SONIOX_RETAIN_MS);
  for (const job of await listSonioxCleanup(db)) {
    if (budget <= 0 || remaining(deps) < 60_000) return;
    budget -= 1;
    const gone = await soniox.remove(job.sonioxTranscriptionId).catch(() => null);
    if (gone) await clearSonioxTranscription(db, job.wiseSessionId, job.sonioxTranscriptionId);
  }
  if (budget <= 0 || remaining(deps) < 60_000) return;
  const referenced = await activeSonioxJobIds(db);
  const listed = await soniox.list(100).catch(() => []);
  for (const job of listed) {
    if (budget <= 0 || remaining(deps) < 60_000) return;
    const ours = job.clientReferenceId !== null && /^[0-9a-f]{24}$/iu.test(job.clientReferenceId);
    // Wall clock: compared with Soniox's own creation time.
    const old = job.createdAt !== null && Date.now() - job.createdAt.getTime() > AUTOWRITER_SONIOX_REAPER_AGE_MS;
    if (!ours || !old || referenced.has(job.id)) continue;
    budget -= 1;
    await soniox.remove(job.id).catch(() => null);
  }
}

/** Mark a stored webhook delivery processed (best effort). */
export async function markWebhookProcessed(db: Database, id: string, outcome: string): Promise<void> {
  await db.update(schema.wiseWebhookEvents).set({ processedAt: sql`now()`, outcome: outcome.slice(0, 200) })
    .where(eq(schema.wiseWebhookEvents.id, id));
}
