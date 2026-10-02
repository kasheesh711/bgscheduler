import { createHash } from "node:crypto";
import type { FeedbackFieldAnswers, FeedbackFieldMapping } from "@/lib/post-class-feedback/types";
import { POST_CLASS_FEEDBACK_FIELDS } from "@/lib/post-class-feedback/types";
import { AUTOWRITER_MIN_POST_BUDGET_MS, AUTOWRITER_POST_TIMEOUT_MS } from "./config";
import {
  buildFeedbackPostBody,
  classifyTeacherSubmission,
  detailClassId,
  detailTeacherId,
  evaluateSessionGates,
  existingAnswersMatchForm,
  parseAutowriterSessionDetail,
  planFeedbackForm,
  storedTeacherFields,
  studentParticipants,
  teacherSubmissionSnapshot,
  type AutowriterSessionDetail,
} from "./session";
import type { BillingPlan, GateInput, ModelArm, SubmissionState, WiseFeedbackPostBody } from "./types";

/** Result of the single feedback POST. Only `sent` means Wise answered 2xx. */
export type PostResult =
  | { kind: "sent"; status: number }
  | { kind: "rate_limited"; status: 429 }
  | { kind: "rejected"; status: number; body: string }
  | { kind: "unknown"; error: string };

export interface SubmitFeedbackEvent {
  at: Date;
  autoSubmitted: boolean | null;
  actorId: string | null;
  actorRole: string | null;
}

export interface WiseFeedbackOps {
  getSessionDetail(classId: string, sessionId: string): Promise<unknown>;
  /** Same detail shape, addressed by session id only (webhooks carry no class id). */
  getSessionDetailById(sessionId: string): Promise<unknown>;
  /** Exactly one request, never retried. Must not throw for HTTP status codes. */
  postFeedback(classId: string, sessionId: string, body: WiseFeedbackPostBody): Promise<PostResult>;
  /** This session's entries in the student's Wise credit history (strictly parsed). */
  getSessionCreditEntries(classId: string, studentId: string, sessionId: string): Promise<Array<{ credit: number }>>;
  /** SessionFeedbackSubmittedEvent rows for this session at or after `since`. */
  findFeedbackEvents(classId: string, sessionId: string, since: Date): Promise<SubmitFeedbackEvent[]>;
}

export type PostFinishState = "awaiting_event" | "verified" | "rejected" | "unknown_outcome" | "verify_failed" | "pending";

/** `post_in_flight`: another session's POST is still unresolved; anything else refused the claim. */
export type ClaimPostResult = { claimed: true } | { claimed: false; reason: "post_in_flight" | "conditions" };

/** Persistence for one session's POST; implemented on Postgres in `store.ts`. */
export interface SubmitStore {
  /**
   * Atomic `generating → posting` claim: this worker's lease is still valid,
   * the control row is live and not halted, the teacher Wise showed in the
   * fresh read is the stored one and switched on, and no other POST is in flight.
   */
  claimPost(input: {
    bodyHash: string;
    fieldsSha256: string;
    fields: FeedbackFieldAnswers;
    billing: BillingPlan;
    arm: ModelArm;
    teacherId: string;
    freshReadAt: Date;
  }): Promise<ClaimPostResult>;
  finish(state: PostFinishState, detail: Record<string, unknown>): Promise<void>;
  /** Global halt: no further POSTs by anyone until an owner resumes. */
  halt(reason: string): Promise<void>;
}

export interface SubmitPlan {
  sessionId: string;
  classId: string;
  arm: ModelArm;
  fields: FeedbackFieldAnswers;
  billing: BillingPlan;
  /** The submission state observed when the draft was generated. */
  expected: SubmissionState;
  mappings: readonly FeedbackFieldMapping[];
}

export type SubmitOutcome =
  | { status: "verified"; bodyHash: string; event: SubmitFeedbackEvent }
  | { status: "awaiting_event"; bodyHash: string }
  /** Sent, but the read-back could not be completed: the row stays `posting` for reconciliation. */
  | { status: "unverified"; problems: string[] }
  | { status: "preflight_ok"; bodyHash: string }
  | { status: "not_claimed"; reason: "post_in_flight" | "conditions" }
  /** `gate`: the reason came from `evaluateSessionGates` on the fresh read. */
  | { status: "aborted_precheck"; reason: string; gate?: boolean }
  | { status: "rate_limited" }
  | { status: "rejected"; httpStatus: number; body: string }
  | { status: "unknown_outcome"; error: string; problems: string[] }
  | { status: "verify_failed"; problems: string[] };

export function feedbackBodyHash(body: WiseFeedbackPostBody): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

export function fieldsHash(fields: FeedbackFieldAnswers): string {
  return createHash("sha256")
    .update(JSON.stringify(POST_CLASS_FEEDBACK_FIELDS.map((field) => fields[field] ?? "")))
    .digest("hex");
}

function sameSubmission(expected: SubmissionState, current: SubmissionState): boolean {
  if (expected.kind === "auto_blank" && current.kind === "auto_blank") {
    return expected.submissionId === current.submissionId &&
      expected.sessionStatus === current.sessionStatus &&
      expected.creditsConsumed === current.creditsConsumed;
  }
  return false;
}

/** Problems with the stored submission after the POST; empty means verified. */
export function verifyStoredSubmission(
  after: AutowriterSessionDetail,
  plan: Pick<SubmitPlan, "fields" | "billing" | "expected" | "mappings">,
): string[] {
  const problems: string[] = [];
  const snapshot = teacherSubmissionSnapshot(after);
  if (snapshot.count !== 1) problems.push(`teacher_submissions_${snapshot.count}`);
  if (plan.expected.kind === "auto_blank" && snapshot.submissionId !== plan.expected.submissionId) {
    problems.push("submission_id_changed");
  }
  if (snapshot.autoSubmitted) problems.push("still_flagged_auto_submitted");
  if (snapshot.sessionStatus !== plan.billing.sessionStatus) problems.push(`status_${snapshot.sessionStatus ?? "missing"}`);
  if (snapshot.creditsConsumed !== plan.billing.creditsConsumed) problems.push(`credits_${snapshot.creditsConsumed ?? "missing"}`);
  if (after.meetingStatus !== "ENDED") problems.push(`meeting_${after.meetingStatus ?? "unknown"}`);
  const stored = storedTeacherFields(after, plan.mappings);
  if (!stored) {
    problems.push("stored_fields_unreadable");
  } else {
    for (const field of POST_CLASS_FEEDBACK_FIELDS) {
      if (stored[field] !== plan.fields[field]) problems.push(`field_mismatch:${field}`);
    }
  }
  return problems;
}

/** Wise must still hold exactly the one charge the auto-submission made. */
export function creditProblems(entries: Array<{ credit: number }>, billing: BillingPlan): string[] {
  if (entries.length !== 1) return [`session_credit_entries_${entries.length}`];
  if (entries[0].credit !== billing.creditsConsumed) return [`session_credit_${entries[0].credit}`];
  return [];
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Read-back problems that only say a Wise read failed. */
export function isReadFailure(problem: string): boolean {
  return /^(verify_read_failed|credits_reread_failed):/u.test(problem);
}


/**
 * Classify SessionFeedbackSubmittedEvent rows around one POST.
 * - ours: non-auto, by the API owner, at or after the POST started;
 * - foreign: non-auto, by anyone else except a student, between the fresh read
 *   and the POST's response (plus a few seconds of clock skew). A save inside
 *   that window either was overwritten by ours or overwrote ours. Later edits
 *   are on top of ours and are not evidence of an overwrite.
 */
export function classifySubmitEvents(events: readonly SubmitFeedbackEvent[], input: {
  apiActorId: string;
  freshReadAt: Date;
  postStartedAt: Date;
  /** When the POST response arrived; unknown → the POST's time-out bound. */
  postFinishedAt?: Date | null;
}): { ours: SubmitFeedbackEvent | undefined; foreign: SubmitFeedbackEvent[] } {
  const windowStart = input.freshReadAt.getTime() - 5_000;
  const windowEnd = (input.postFinishedAt?.getTime() ?? input.postStartedAt.getTime() + AUTOWRITER_POST_TIMEOUT_MS) + 5_000;
  const ours = events.find((event) => event.autoSubmitted !== true && event.actorId === input.apiActorId &&
    event.at.getTime() >= input.postStartedAt.getTime() - 5_000);
  const foreign = events.filter((event) => event.autoSubmitted !== true && event.actorId !== input.apiActorId &&
    (event.actorRole ?? "").toUpperCase() !== "STUDENT" &&
    event.at.getTime() >= windowStart && event.at.getTime() <= windowEnd);
  return { ours, foreign };
}

/**
 * Poll Wise's events for up to `waitMs` until our submit event shows up. `events` is the last list read (since the
 * fresh read, less the skew), so a caller can also look for more than one save by the API owner.
 */
export async function waitForSubmitEvents(ops: Pick<WiseFeedbackOps, "findFeedbackEvents">, input: {
  classId: string;
  sessionId: string;
  apiActorId: string;
  freshReadAt: Date;
  postStartedAt: Date;
  postFinishedAt: Date;
  waitMs: number;
  sleep: (ms: number) => Promise<void>;
}): Promise<{ ours: SubmitFeedbackEvent | undefined; foreign: SubmitFeedbackEvent[]; readFailed: boolean; events: SubmitFeedbackEvent[] }> {
  const waitUntil = Date.now() + input.waitMs;
  const since = new Date(input.freshReadAt.getTime() - 5_000);
  let found: { ours: SubmitFeedbackEvent | undefined; foreign: SubmitFeedbackEvent[] } = { ours: undefined, foreign: [] };
  let events: SubmitFeedbackEvent[] = [];
  let readFailed = false;
  for (;;) {
    try {
      events = await ops.findFeedbackEvents(input.classId, input.sessionId, since);
      found = classifySubmitEvents(events, input);
      readFailed = false;
    } catch {
      // Keep polling until the wait ends; the sweep reconciles later.
      readFailed = true;
    }
    if (found.ours || Date.now() >= waitUntil) break;
    await input.sleep(5_000);
  }
  return { ...found, readFailed, events };
}

/**
 * Complete Wise's blank auto-submission with the drafted feedback, never
 * anything a person wrote:
 *   credit baseline → fresh GET + every gate → store claim (lease, live, not
 *   halted, tutor on) → one POST (never retried) → GET verify + credit entry +
 *   a non-auto submit event by the API owner. A teacher/admin submit event by
 *   anyone else inside the POST window means a person may have been
 *   overwritten: halt. Unclear or unverified outcomes halt every later POST.
 * With `dryRun`, stops after the gates without claiming or posting.
 */
export async function submitFeedbackGuarded(input: {
  ops: WiseFeedbackOps;
  store: SubmitStore;
  plan: SubmitPlan;
  gateInput: GateInput;
  apiActorId: string;
  validateEvidence?: (detail: AutowriterSessionDetail) => Promise<boolean>;
  remainingMs: () => number;
  dryRun?: boolean;
  sleep?: (ms: number) => Promise<void>;
  eventWaitMs?: number;
}): Promise<SubmitOutcome> {
  const { ops, store, plan } = input;
  const sleep = input.sleep ?? defaultSleep;
  const abort = (reason: string): SubmitOutcome => ({ status: "aborted_precheck", reason });

  if (plan.expected.kind !== "auto_blank") return abort(`expected_${plan.expected.kind}_not_supported`);
  if (plan.billing.source !== "auto_blank_reuse" || plan.billing.expectedConsumedDelta !== 0) return abort("billing_plan_not_reuse");
  // Checked before the three reads below as well as before the claim: each read may take 45 s, and a POST that can
  // no longer be claimed needs none of them. The caller keeps the judged draft for the next run.
  const budgetTooSmall = () => !input.dryRun && input.remainingMs() < AUTOWRITER_MIN_POST_BUDGET_MS;
  if (budgetTooSmall()) return abort("function_budget_too_small_for_post");

  let before: AutowriterSessionDetail;
  try {
    before = parseAutowriterSessionDetail(await ops.getSessionDetail(plan.classId, plan.sessionId));
  } catch (error) {
    return abort(`detail_read_failed:${error instanceof Error ? error.name : "Error"}`);
  }
  const [student] = studentParticipants(before);
  if (!student?.wiseUserId) return abort("student_id_missing");
  // The slow, paced credit read happens BEFORE the fresh detail GET so the gap
  // between "still Wise's blank" and the POST stays as short as possible.
  try {
    const baseline = creditProblems(await ops.getSessionCreditEntries(plan.classId, student.wiseUserId, plan.sessionId), plan.billing);
    if (baseline.length > 0) return abort(`credit_baseline:${baseline.join(",")}`);
  } catch (error) {
    return abort(`credits_read_failed:${error instanceof Error ? error.name : "Error"}`);
  }

  const freshReadAt = new Date();
  try {
    before = parseAutowriterSessionDetail(await ops.getSessionDetail(plan.classId, plan.sessionId));
  } catch (error) {
    return abort(`detail_read_failed:${error instanceof Error ? error.name : "Error"}`);
  }
  if (before._id !== plan.sessionId || detailClassId(before) !== plan.classId) return abort("detail_id_mismatch");
  const form = planFeedbackForm(before, plan.mappings);
  if (!form.ok) return abort(form.reason);
  const missingFields = POST_CLASS_FEEDBACK_FIELDS.filter((field) =>
    plan.fields[field].trim() !== "" && !form.plan.fieldOrder.includes(field));
  if (missingFields.length > 0) return abort(`form_lacks_field:${missingFields.join(",")}`);
  if (!existingAnswersMatchForm(before)) return abort("existing_answers_not_in_form_order");
  const gates = evaluateSessionGates(before, input.gateInput);
  if (!gates.ok) return { status: "aborted_precheck", reason: gates.reason, gate: true };
  const teacherId = detailTeacherId(before);
  if (!teacherId) return abort("teacher_missing");
  const current = classifyTeacherSubmission(before);
  if (!sameSubmission(plan.expected, current)) return abort(`submission_changed_to_${current.kind}`);
  if (current.kind !== "auto_blank" ||
    current.sessionStatus !== plan.billing.sessionStatus ||
    current.creditsConsumed !== plan.billing.creditsConsumed) {
    return abort("billing_differs_from_current_submission");
  }

  const body = buildFeedbackPostBody(form.plan, plan.fields, plan.billing);
  const bodyHash = feedbackBodyHash(body);
  if (input.dryRun) return { status: "preflight_ok", bodyHash };
  if (budgetTooSmall()) return abort("function_budget_too_small_for_post");

  if (input.validateEvidence && !await input.validateEvidence(before)) return abort("iseb_evidence_changed");
  const claim = await store.claimPost({
    bodyHash,
    fieldsSha256: fieldsHash(plan.fields),
    fields: plan.fields,
    billing: plan.billing,
    arm: plan.arm,
    teacherId,
    freshReadAt,
  });
  if (!claim.claimed) return { status: "not_claimed", reason: claim.reason };
  const postStartedAt = new Date();

  const result = await ops.postFeedback(plan.classId, plan.sessionId, body);
  const postFinishedAt = new Date();

  const readBack = async (): Promise<{ problems: string[]; stillAutoBlank: boolean }> => {
    const problems: string[] = [];
    let stillAutoBlank = false;
    try {
      const after = parseAutowriterSessionDetail(await ops.getSessionDetail(plan.classId, plan.sessionId));
      stillAutoBlank = sameSubmission(plan.expected, classifyTeacherSubmission(after));
      problems.push(...verifyStoredSubmission(after, plan));
    } catch (error) {
      problems.push(`verify_read_failed:${error instanceof Error ? error.name : "Error"}`);
    }
    try {
      problems.push(...creditProblems(
        await ops.getSessionCreditEntries(plan.classId, student.wiseUserId!, plan.sessionId),
        plan.billing,
      ));
    } catch (error) {
      problems.push(`credits_reread_failed:${error instanceof Error ? error.name : "Error"}`);
    }
    return { problems, stillAutoBlank };
  };

  if (result.kind === "rate_limited") {
    await sleep(3_000);
    const check = await readBack();
    if (check.stillAutoBlank) {
      await store.finish("pending", { reason: "wise_rate_limited_not_sent" });
      return { status: "rate_limited" };
    }
    // Halt before leaving `posting`: the row is what keeps every other POST waiting.
    await store.halt(`unknown outcome after HTTP 429 on ${plan.sessionId}`);
    await store.finish("unknown_outcome", { error: "429 but submission changed", problems: check.problems });
    return { status: "unknown_outcome", error: "429 but submission changed", problems: check.problems };
  }
  // Not a clean 2xx: halt first so nothing else posts while we look.
  if (result.kind === "rejected") {
    await store.halt(`Wise rejected the feedback POST for ${plan.sessionId} (HTTP ${result.status})`);
    await sleep(3_000);
    const check = await readBack();
    await store.finish("rejected", { httpStatus: result.status, body: result.body, stillAutoBlank: check.stillAutoBlank });
    return { status: "rejected", httpStatus: result.status, body: result.body };
  }
  if (result.kind === "unknown") {
    await store.halt(`unknown outcome for the feedback POST on ${plan.sessionId}`);
    await sleep(3_000);
    const check = await readBack();
    await store.finish("unknown_outcome", { error: result.error, problems: check.problems });
    return { status: "unknown_outcome", error: result.error, problems: check.problems };
  }

  await sleep(3_000);
  const { problems } = await readBack();

  // Post-class counts feedback as on time through a non-auto submit event; ours
  // must be by the API owner. A teacher/admin event by anyone else between our
  // fresh read and our POST means a person saved feedback we may have replaced.
  const found = await waitForSubmitEvents(ops, {
    classId: plan.classId,
    sessionId: plan.sessionId,
    apiActorId: input.apiActorId,
    freshReadAt,
    postStartedAt,
    postFinishedAt,
    // Never wait into the function's last minute; the sweep reconciles instead.
    waitMs: Math.min(input.eventWaitMs ?? 20_000, Math.max(0, input.remainingMs() - 60_000)),
    sleep,
  });
  if (found.foreign.length > 0) problems.push("foreign_submit_event_in_post_window");

  // A read that failed is not evidence of a bad write: leave the row `posting`
  // (which also keeps every other POST waiting) for the sweep to reconcile.
  if (problems.length > 0 && problems.every(isReadFailure)) return { status: "unverified", problems };
  if (problems.length > 0) {
    // Halt before leaving `posting`: the row is what keeps every other POST waiting.
    await store.halt(`feedback POST on ${plan.sessionId} did not verify: ${problems.join(", ")}`);
    await store.finish("verify_failed", { httpStatus: result.status, problems });
    return { status: "verify_failed", problems };
  }
  const ours = found.ours;
  const timing = { postStartedAt: postStartedAt.toISOString(), postFinishedAt: postFinishedAt.toISOString() };
  if (!ours) {
    // The sweep keeps looking for our event and for a save inside the POST window.
    await store.finish("awaiting_event", { httpStatus: result.status, ...timing, eventsReadFailed: found.readFailed });
    return { status: "awaiting_event", bodyHash };
  }
  await store.finish("verified", { httpStatus: result.status, ...timing, event: { ...ours, at: ours.at.toISOString() } });
  return { status: "verified", bodyHash, event: ours };
}
