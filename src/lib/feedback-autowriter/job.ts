import { eq, sql } from "drizzle-orm";
import type { ScheduleEmailSender } from "@/lib/classrooms/schedule-email";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { calculateFeedbackDeadline } from "@/lib/post-class-feedback/policy";
import type { FeedbackFieldAnswers, FeedbackFieldMapping } from "@/lib/post-class-feedback/types";
import { sendAlertDigest } from "./alerts";
import { resolveBilling } from "./billing";
import {
  AUTOWRITER_EVENT_DEADLINE_MS,
  AUTOWRITER_GENERATION_LEASE_MS,
  AUTOWRITER_MIN_POST_BUDGET_MS,
  AUTOWRITER_NO_SUMMARY_ALERT_MS,
  AUTOWRITER_POST_IN_FLIGHT_ATTEMPTS,
  AUTOWRITER_POST_IN_FLIGHT_WAIT_MS,
  AUTOWRITER_RETRY_DELAY_MS,
  AUTOWRITER_STALE_POSTING_MS,
  AUTOWRITER_SWEEP_MIN_REMAINING_MS,
} from "./config";
import { runWritingPipeline, type PipelineResult } from "./pipeline";
import { chooseStudentDisplayName, describeClass } from "./prompt";
import { AUTOWRITER_ROSTER, AUTOWRITER_TEACHER_ALLOWLIST, rosterTutor } from "./roster";
import { loadCandidateShortlist, loadFieldMappings, loadPriorFeedback } from "./run";
import {
  classifyGateReason,
  classifyTeacherSubmission,
  detailClassId,
  detailTeacherId,
  evaluateSessionGates,
  extractAiSummary,
  parseAutowriterSessionDetail,
  planFeedbackForm,
  scheduledWindow,
  studentParticipants,
  type AutowriterSessionDetail,
} from "./session";
import {
  acquireSweepLease,
  claimGeneration,
  ensureSessionRow,
  expireOverdueRows,
  haltAutowriter,
  listDueRows,
  listPendingAlerts,
  listRowsInState,
  markAlertsSent,
  readControl,
  readSessionRow,
  recentAutowriterPosts,
  reconcilePostedRow,
  recordCall,
  releaseGeneration,
  releaseShadowDraft,
  releaseSweepLease,
  sessionSubmitStore,
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
import { AUTOWRITER_DEADLINE_MARGIN_MS, type BillingPlan, type SubmissionState } from "./types";

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
  now?: () => Date;
  callModel?: Parameters<typeof runWritingPipeline>[0]["callModel"];
  sleep?: (ms: number) => Promise<void>;
}

export type ProcessResult =
  | "preview" | "mode_off" | "halted" | "tutor_off" | "not_roster" | "not_found" | "busy_or_not_due" | "already_handled"
  | "blocked_by_stuck_post"
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
  if (row && row.state !== "pending" && row.state !== "generating") return out("already_handled", row.state);
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

  try {
    return await processLeased(deps, {
      row, token, control, trigger: input.trigger, mappings: input.mappings, release, out,
      waitForReadyMs: input.waitForReadyMs ?? 0,
    });
  } catch (error) {
    await release({ state: "pending", reason: `error:${error instanceof Error ? error.message.slice(0, 120) : "unknown"}`, retryInMs: AUTOWRITER_RETRY_DELAY_MS, countRetry: true });
    return out("infra", error instanceof Error ? error.message.slice(0, 200) : "unknown error");
  }
}

type Release = (to: Parameters<typeof releaseGeneration>[3]) => Promise<boolean>;
type Out = (result: ProcessResult, detail?: string) => ProcessOutcome;

/**
 * Settle a failed gate (from the first read or the pre-POST fresh read):
 * retry later, hand back to the tutor, or hold / expire with an alert.
 */
async function settleGate(input: {
  reason: string;
  detail: AutowriterSessionDetail;
  row: AutowriterSessionRow;
  now: Date;
  release: Release;
  out: Out;
  draftPatch?: Partial<Parameters<Release>[0]>;
}): Promise<ProcessOutcome> {
  const { reason, detail, row, now, release, out } = input;
  const disposition = classifyGateReason(reason, { minutesSinceEnd: minutesSinceEnd(detail, now) });
  if (disposition === "retry") {
    const endedAt = row.scheduledEndAt ?? scheduledWindow(detail).end;
    const noSummaryLate = NO_SUMMARY_REASONS.has(reason) && now.getTime() - endedAt.getTime() >= AUTOWRITER_NO_SUMMARY_ALERT_MS;
    await release({ state: "pending", reason, retryInMs: AUTOWRITER_RETRY_DELAY_MS, countRetry: true, alertKind: noSummaryLate ? "no_summary" : null });
    return out("retry", reason);
  }
  const state = disposition === "scope" ? "skipped_scope" : disposition === "human" ? "skipped_human" : disposition === "expired" ? "expired" : "held";
  const alertKind: AlertKind | null = state === "held" ? "held" : state === "expired" ? "expired" : null;
  await release({ state, reason, alertKind, ...(state === "held" ? input.draftPatch ?? {} : {}) });
  return out(state, reason);
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
  // the next cron tick.
  for (;;) {
    detail = await readDetail(ops, row.wiseSessionId, row.wiseClassId);
    if (!detail) {
      await release({ state: "pending", reason: "wise_read_failed", retryInMs: AUTOWRITER_RETRY_DELAY_MS, countRetry: true });
      return out("infra", "wise_read_failed");
    }
    now = clock(deps);
    const gates = evaluateSessionGates(detail, { now, allowlist: AUTOWRITER_TEACHER_ALLOWLIST });
    submission = classifyTeacherSubmission(detail);
    gateReason = !gates.ok ? gates.reason : submission.kind === "none" ? "submission_none_not_enabled_in_pilot" : null;
    const retrying = gateReason !== null && classifyGateReason(gateReason, { minutesSinceEnd: minutesSinceEnd(detail, now) }) === "retry";
    if (!retrying || Date.now() + 20_000 > waitUntil) break;
    await sleep(20_000);
  }

  // Wise may have moved the class to another teacher since the row was made:
  // the stored teacher is what the per-tutor switch and the POST claim check.
  const freshTeacher = detailTeacherId(detail);
  if (freshTeacher && freshTeacher !== row.wiseTeacherUserId) {
    await updateLeasedTeacher(db, row.wiseSessionId, input.token, freshTeacher);
    row = { ...row, wiseTeacherUserId: freshTeacher };
    if (input.control.disabledTutors.includes(freshTeacher)) {
      await release({ state: "pending", reason: "tutor_off", retryInMs: AUTOWRITER_RETRY_DELAY_MS });
      return out("tutor_off", "teacher changed to a switched-off tutor");
    }
  }

  if (gateReason) return settleGate({ reason: gateReason, detail, row, now, release, out });

  const mappings = input.mappings ?? await loadFieldMappings(db);
  const form = planFeedbackForm(detail, mappings);
  if (!form.ok) {
    await release({ state: "held", reason: form.reason, alertKind: "held" });
    return out("held", form.reason);
  }
  const window = scheduledWindow(detail);
  const billing = resolveBilling({ submission, scheduledMinutes: window.minutes });
  if (!billing.ok) {
    await release({ state: "held", reason: `billing:${billing.reason}`, alertKind: "held" });
    return out("held", billing.reason);
  }
  const summary = extractAiSummary(detail);
  const [student] = studentParticipants(detail);
  const tutor = rosterTutor(freshTeacher);
  if (!summary || !student?.name || !tutor) {
    await release({ state: "held", reason: "missing_summary_student_or_tutor", alertKind: "held" });
    return out("held", "missing_summary_student_or_tutor");
  }
  if (!deps.apiKey) {
    await release({ state: "pending", reason: "infra:OPENROUTER_API_KEY missing", retryInMs: AUTOWRITER_RETRY_DELAY_MS, countRetry: true });
    return out("infra", "OPENROUTER_API_KEY missing");
  }

  const priors = [
    ...(await loadPriorFeedback(db, { canonicalTutorKey: tutor.canonicalKey, now })),
    ...(await recentAutowriterPosts(db, tutor.wiseUserId, new Date(now.getTime() - NINETY_DAYS_MS))),
  ];
  const result: PipelineResult = await runWritingPipeline({
    apiKey: deps.apiKey,
    session: {
      wiseSessionId: row.wiseSessionId,
      studentFullName: student.name,
      studentDisplayName: chooseStudentDisplayName(summary.text, student.name),
      classDetails: describeClass({ programme: detail.classSubject, title: detail.title }),
      scheduledMinutes: window.minutes,
      summary,
    },
    tutorNames: tutor.tutorNames,
    priorFeedback: priors,
    record: (record) => recordCall(db, record),
    remainingMs: () => remaining(deps),
    callModel: deps.callModel,
  });
  if (result.kind === "infra") {
    await release({ state: "pending", reason: `infra:${result.error}`, retryInMs: AUTOWRITER_RETRY_DELAY_MS, countRetry: true });
    return out("infra", result.error);
  }
  if (result.kind === "held") {
    await release({ state: "held", reason: result.reasons.join("; ").slice(0, 900), countAttempt: true, alertKind: "held" });
    return out("held", result.reasons.join("; "));
  }

  const draftPatch = {
    arm: result.arm,
    fields: result.fields,
    fieldsSha256: fieldsHash(result.fields),
    billing: billing.plan,
    metadata: { judge: result.judge },
  };
  if (input.control.mode !== "live") {
    // Atomic with the mode: a switch to live while this draft was being written
    // sends the row back to `pending` instead of stranding it in `would_submit`.
    const stored = await releaseShadowDraft(db, row.wiseSessionId, input.token, draftPatch);
    return stored === "pending" ? out("retry", "mode_switched_to_live") : out("would_submit", result.arm);
  }
  if (!deps.apiActorId) {
    await release({ state: "pending", reason: "infra:WISE_USER_ID missing", retryInMs: AUTOWRITER_RETRY_DELAY_MS, countRetry: true });
    return out("infra", "WISE_USER_ID missing");
  }

  // Only one POST may be in flight institution-wide; wait briefly for another
  // session's POST to settle, redoing every pre-POST read each time.
  let outcome: SubmitOutcome;
  for (let attempt = 1; ; attempt += 1) {
    outcome = await submitFeedbackGuarded({
      ops,
      store: sessionSubmitStore(db, row.wiseSessionId, input.token, { expected: submission, judge: result.judge }),
      plan: {
        sessionId: row.wiseSessionId,
        classId: row.wiseClassId!,
        arm: result.arm,
        fields: result.fields,
        billing: billing.plan,
        expected: submission,
        mappings,
      },
      gateInput: { now: clock(deps), allowlist: AUTOWRITER_TEACHER_ALLOWLIST },
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
      // teacher changed / lease lost: nothing was sent.
      await release({
        state: "pending",
        reason: outcome.reason === "post_in_flight" ? "post_in_flight" : "post_not_claimed",
        retryInMs: outcome.reason === "post_in_flight" ? 60_000 : AUTOWRITER_RETRY_DELAY_MS,
        ...draftPatch,
      });
      return out("not_claimed", outcome.reason);
    case "preflight_ok":
      return out("aborted", "unexpected preflight");
    case "aborted_precheck": {
      const reason = outcome.reason;
      if (outcome.gate) {
        return settleGate({ reason, detail, row, now: clock(deps), release, out, draftPatch });
      }
      if (/^(detail_read_failed|credits_read_failed|function_budget)/u.test(reason)) {
        await release({ state: "pending", reason, retryInMs: AUTOWRITER_RETRY_DELAY_MS, countRetry: true });
        return out("retry", reason);
      }
      if (reason === "submission_changed_to_human") {
        await release({ state: "skipped_human", reason });
        return out("skipped_human", reason);
      }
      await release({ state: "held", reason, alertKind: "held", ...draftPatch });
      return out("held", reason);
    }
  }
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
    const [student] = studentParticipants(detail);
    if (!student?.wiseUserId) {
      problems.push("student_id_missing");
    } else {
      try {
        problems.push(...creditProblems(await ops.getSessionCreditEntries(row.wiseClassId, student.wiseUserId, row.wiseSessionId), billing));
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

/** Mark a stored webhook delivery processed (best effort). */
export async function markWebhookProcessed(db: Database, id: string, outcome: string): Promise<void> {
  await db.update(schema.wiseWebhookEvents).set({ processedAt: sql`now()`, outcome: outcome.slice(0, 200) })
    .where(eq(schema.wiseWebhookEvents.id, id));
}
