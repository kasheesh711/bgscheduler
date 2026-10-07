import { assessAiSuspect, type PriorFeedbackComparison } from "@/lib/post-class-feedback/similarity";
import {
  POST_CLASS_FEEDBACK_FIELDS,
  type FeedbackFieldAnswers,
  type FeedbackFieldMapping,
} from "@/lib/post-class-feedback/types";
import { AUTOWRITER_POST_TIMEOUT_MS } from "./config";
import { sqlStateOf } from "./db-errors";
import {
  buildFeedbackPostBody,
  detailClassId,
  detailTeacherId,
  existingAnswersMatchForm,
  parseAutowriterSessionDetail,
  planFeedbackForm,
  storedTeacherFields,
  studentParticipants,
  teacherSubmissionSnapshot,
  type AutowriterSessionDetail,
  type FormPlan,
} from "./session";
import {
  classifySubmitEvents,
  creditProblems,
  feedbackBodyHash,
  fieldsHash,
  isReadFailure,
  verifyStoredSubmission,
  type PostResult,
  type SubmitFeedbackEvent,
  type WiseFeedbackOps,
} from "./submit";
import type { BillingPlan, SubmissionState } from "./types";
import { feedbackTextChecks, tidyFeedbackText } from "./validate";

/**
 * Guarded agent correction (quick 261003-12b): the nightly agent edits the text of one autowriter post that is
 * already in Wise — once per class, ever, and only while Wise still shows exactly our first shot. Everything is
 * read and checked before the one POST, which is made under a lock that stops every other autowriter POST (the
 * control row halted with a lock reason while the sweep lease is held: `correction-store.ts`). Wise access and
 * persistence are injected, so the executor can move in-app later unchanged. No lesson text ever goes into a
 * reason, a verification record, a halt or an incident: only codes, ids and times.
 *
 * Clocks: Wise's event times are only ever compared with database times — the events and session reads under the
 * lock and the POST's end are read off the database clock (`store.databaseNow`), its start is the posts row's own
 * `post_started_at` — and recovery reuses exactly those. This machine's clock decides only the window, the budgets
 * and the waits, and the store refuses the lock (`clock_skew`) when it is more than 2 s off the database's.
 */

/** The actor recorded on the posts row and on every control-row write the nightly agent makes. */
export const AGENT_CORRECTION_ACTOR = "agent:feedback-autowriter-nightly";
/** The pre-POST part under the lock must finish within this long of taking it (the autowriter is halted meanwhile). */
export const CORRECTION_LOCK_BUDGET_MS = 180_000;
/**
 * How long to poll Wise for our own submit event after the POST, and how often. Not seen by then: the lock is kept
 * (`awaiting_event_locked`) until recovery settles the correction by reads alone.
 */
export const CORRECTION_EVENT_WAIT_MS = 5 * 60_000;
export const CORRECTION_EVENT_POLL_MS = 20_000;
/** Wait before reading back what Wise stored. */
export const CORRECTION_READ_BACK_DELAY_MS = 3_000;
/** Read-back that only failed to read Wise: re-read this often, this many times, for at most this long — then halt. */
export const CORRECTION_READ_RETRY_INTERVAL_MS = 30_000;
export const CORRECTION_READ_RETRIES = 8;
export const CORRECTION_READ_RETRY_WINDOW_MS = 4 * 60_000;
/** A correction's reason is codes plus one line: never lesson text, never long. */
export const CORRECTION_MAX_REASON_CHARACTERS = 500;
/** Slack for Wise's event clock against ours. */
const EVENT_SKEW_MS = 5_000;

/**
 * One agent correction per class, ever: the posts table's unique `dedupe_key` index enforces it. The key is taken
 * when the posts row is claimed, before the POST, and posts rows are append-only — so a correction that ends
 * `not_sent` (Wise answered 429 and nothing changed, or the lock was lost or the budget spent between the claim and
 * the POST) uses up the class's one correction too. Accepted (review finding L2): a person can still edit in Wise.
 */
export function agentCorrectionDedupeKey(wiseSessionId: string): string {
  return `agent-correction:${wiseSessionId}`;
}

/**
 * Whether a correction may start now: UTC minute 10–15 or 40–45 (Bangkok has the same minutes). Clear of every cron
 * that touches the autowriter or Wise's feedback: sync-wise :00/:30, the autowriter backstop :08/:22/:38/:52, the
 * review job :27, the Atom collector :06/:21/:36/:51 and the Wise activity sync :02/:17/:32/:47. A run gives the
 * sweep lease back when it ends; one that dies keeps it (and so skips the backstop sweeps) for at most the lease,
 * 20 minutes (`CORRECTION_LOCK_LEASE_MS`), longer than any run.
 */
export function inCorrectionWindow(now: Date): boolean {
  const minute = now.getUTCMinutes();
  return (minute >= 10 && minute <= 15) || (minute >= 40 && minute <= 45);
}

/** When the correction window `now` is in closes (minute 16 or 46, second 0); null outside a window. */
export function correctionWindowEnd(now: Date): Date | null {
  if (!inCorrectionWindow(now)) return null;
  const end = new Date(now);
  end.setUTCMinutes(now.getUTCMinutes() < 30 ? 16 : 46, 0, 0);
  return end;
}

/** The post being corrected: our first shot, as Wise still shows it. */
export interface CorrectionBase {
  fields: FeedbackFieldAnswers;
  fieldsSha256: string;
  /** The teacher submission our first shot completed (Wise keeps its id when it is edited). */
  submissionId: string;
  billing: BillingPlan;
  /**
   * When the first shot was posted (its posts row's `post_started_at`). Checked against that row (within a minute);
   * the saves since the first shot are then looked for from the row's own time, never the plan's.
   */
  firstShotPostedAt: Date;
}

export interface CorrectionPlan {
  wiseSessionId: string;
  wiseClassId: string;
  wiseTeacherUserId: string;
  base: CorrectionBase;
  /** The corrected text, and its `fieldsHash`. */
  fields: FeedbackFieldAnswers;
  fieldsSha256: string;
  /** Failure-mode codes plus one line — no lesson text (stored on the posts row). */
  reason: string;
  /**
   * The audit finding behind the correction (stored on the posts row). Required: null or blank is refused
   * (`root_cause_missing`); the type keeps null only so a plan read from JSON is checked here, not trusted.
   */
  rootCauseRef: string | null;
  /** What produced the corrected text (commit, prompt and judge versions…): stored on the posts row. */
  pipeline: Record<string, unknown>;
  evidence: "summary" | "transcript";
  arm: string | null;
  mappings: readonly FeedbackFieldMapping[];
}

/** Wise access a correction needs: the reads, and the one feedback POST. */
export type CorrectionWiseOps = Pick<WiseFeedbackOps, "getSessionDetail" | "postFeedback" | "getSessionCreditEntries" | "findFeedbackEvents">;

export type CorrectionSettleOutcome = "verified" | "awaiting_event" | "not_sent" | "rejected" | "unknown_outcome" | "verify_failed";

/** The session row's text moves to the corrected text, compare-and-swap on the base text's hash. */
export interface CorrectionSessionUpdate {
  fields: FeedbackFieldAnswers;
  fieldsSha256: string;
  fromSha256: string;
  at: Date;
  reason: string;
}

/** The held lock; `release()` is false when the control row stays halted (someone halted it on top of the lock). */
export interface CorrectionLock {
  /** Whether the lock is still ours on the database clock: live, our exact halt, our lease not expired, tutor on. */
  isHeld(): Promise<boolean>;
  release(): Promise<boolean>;
  /** This machine's clock just before the halt: the lock budget runs from it. */
  haltedAtMs?: number;
}

export interface CorrectionLockOptions {
  /** Waiting for a running sweep stops before this (the end of the correction window): no halt after it. */
  waitUntil?: Date;
  /** Checked between waits; STOP ends the wait at once (`stop_requested`). */
  stopRequested?: () => boolean;
}

/** The posts row's start: what recovery needs to read Wise back later (`verification` while unsettled). */
export interface CorrectionPostStartInput {
  bodyHash: string;
  /** The events read under the lock: the POST window starts here. */
  eventsReadAt?: Date;
  /** The session read under the lock, the last read before the POST. */
  freshReadAt?: Date;
  studentWiseUserId?: string;
  baselineCredits?: number[];
}

/**
 * A store refused the posts-row claim on purpose (the lock or a precondition no longer holds): nothing was written,
 * nothing must be sent. `reason` is a refusal code (`lock:lost`, `row_changed`, `owner_flag_open`, …).
 */
export class CorrectionRefusedError extends Error {
  constructor(readonly reason: string) {
    super(`correction refused: ${reason}`);
    this.name = "CorrectionRefusedError";
  }
}

/** What the database says before anything else. Reads only. */
export interface CorrectionPreconditions {
  /** Refusal codes; empty: every precondition holds. */
  problems: string[];
  /** The first shot's POST start as its posts row records it (database clock): saves since then are looked for. */
  firstShotPostedAt: Date | null;
}

/** Persistence and locking of a correction; implemented on Postgres in `correction-store.ts`. */
export interface CorrectionStore {
  preconditions(plan: CorrectionPlan, now: Date): Promise<CorrectionPreconditions>;
  /**
   * Stop every other autowriter POST until released. Refused (`clock_skew`, nothing left behind) when this machine's
   * clock is more than 2 s off the database's when the lock is taken. A backstop sweep holding the lease is waited for
   * (up to 5 min, never past `waitUntil`; `sweep_running` after that), without halting anything meanwhile.
   */
  lock(plan: CorrectionPlan, options?: CorrectionLockOptions): Promise<{ ok: true; lock: CorrectionLock } | { ok: false; reason: string }>;
  /** The database clock: every time compared with Wise's event times is read from it. */
  databaseNow(): Promise<Date>;
  /**
   * The posts row (`posting`, database-clock `post_started_at`) — written before the POST, so the POST's event is
   * always explained. Throws `CorrectionRefusedError` when the lock or a precondition no longer holds.
   */
  recordPostStart(plan: CorrectionPlan, input: CorrectionPostStartInput): Promise<{ postId: string; postStartedAt: Date }>;
  settle(postId: string, input: {
    outcome: CorrectionSettleOutcome;
    verification: Record<string, unknown>;
    session?: CorrectionSessionUpdate;
  }): Promise<void>;
  /** Global halt: no autowriter POST by anyone until an owner resumes. */
  halt(reason: string): Promise<void>;
  incident(input: { dedupeKey: string; summary: string; detail: Record<string, unknown>; wiseSessionId: string }): Promise<void>;
}

export type CorrectionRefusalStage = "plan" | "db" | "wise" | "lock" | "window";

/**
 * On an outcome that released the lock: the release's compare-and-swap did not fire — someone halted the autowriter
 * on top of the lock (an owner pause, an anomaly halt), so it stays halted until an owner resumes.
 */
export interface ReleaseReport {
  productionStillHalted?: true;
}

export type CorrectionOutcome =
  | { status: "preflight_ok"; bodyHash: string; guards: string[] }
  | ({ status: "refused"; stage: CorrectionRefusalStage; reason: string } & ReleaseReport)
  | ({ status: "verified"; postId: string; bodyHash: string } & ReleaseReport)
  /**
   * The corrected text verified in Wise, but our own submit event not seen within `CORRECTION_EVENT_WAIT_MS`: the
   * posts row is `awaiting_event` and the lock is KEPT (the autowriter stays halted) — a late stranger's save inside
   * the POST window could still make it a halt. Run recover once the lease is over: `recoverStaleCorrections`
   * settles it by reads alone, then `releaseStaleCorrectionLock` lifts the lock.
   */
  | { status: "awaiting_event_locked"; postId: string; bodyHash: string }
  /** Nothing reached Wise. The class's one correction is used up all the same (`agentCorrectionDedupeKey`). */
  | ({ status: "not_sent"; postId: string; reason: string } & ReleaseReport)
  /** Halted, settled and reported: a person must look at the class in Wise. The lock is never released. */
  | { status: "safety"; postId: string | null; problems: string[] };

/**
 * What the AI-suspect and copy checks need: the checks every first shot passed (`validateFeedbackDraft`). Required —
 * a correction is never checked without them.
 */
export interface CorrectionAiSuspectInput {
  /** The student's Wise names: the full name and the display name the text uses. */
  studentNames: readonly string[];
  /** The tutor's names, as the first shot was checked with. */
  tutorNames: readonly string[];
  /** The tutor's recent feedback, keyed by Wise session id; the class's own is never compared with. */
  priorFeedback: readonly PriorFeedbackComparison[];
  /** The class follows a style or format guide: its short numbered fields are no AI-suspect sign (as for a draft). */
  styleGuided?: boolean;
}

export interface CorrectPostInput {
  ops: CorrectionWiseOps;
  store: CorrectionStore;
  plan: CorrectionPlan;
  /** The Wise user behind the API key (`WISE_USER_ID`): its saves are ours. */
  apiActorId: string;
  allowlist: ReadonlySet<string>;
  disabledTutors: readonly string[];
  /** The AI-suspect and copy checks' context (required: see `correctionTextProblems`). */
  aiSuspect: CorrectionAiSuspectInput;
  /** The caller's own text checks (a style or format guide's, …); each code is refused as `text:<code>`. */
  textProblems: (fields: FeedbackFieldAnswers) => string[];
  /** Every read and check, but no lock, no posts row and no POST. */
  dryRun?: boolean;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  stopRequested?: () => boolean;
  lockBudgetMs?: number;
  eventWaitMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}

/** A database error by its SQLSTATE (never its message: it can carry query parameters, i.e. lesson text). */
function failureName(error: unknown): string {
  return sqlStateOf(error) ?? errorName(error);
}

/**
 * Problems with a corrected text before any lock — every check its first shot passed as a draft, and more:
 * - whitespace no draft ever posts (Wise may store it otherwise, and the read-back would then halt);
 * - the draft's context-free checks (`feedbackTextChecks`): leftover placeholder tokens and placeholder text, Thai
 *   text (the student's own names aside: a Wise name may be Thai), Wise's length limit (a longer answer is a certain
 *   4xx, i.e. a halt), markdown, Class Feedback's content bar, and absence or cancellation wording — a correction
 *   must never create a deduction, nor make Class Feedback mark the session ineligible;
 * - the AI-suspect and copy checks against the tutor's prior feedback (`aiSuspect`, required; the class's own
 *   feedback is never compared with);
 * - the caller's own checks (a style or format guide's, …).
 */
export function correctionTextProblems(fields: FeedbackFieldAnswers, input: {
  wiseSessionId: string;
  aiSuspect: CorrectionAiSuspectInput;
  textProblems: (fields: FeedbackFieldAnswers) => string[];
}): string[] {
  const { aiSuspect } = input;
  const problems: string[] = [];
  for (const field of POST_CLASS_FEEDBACK_FIELDS) {
    if (fields[field] !== tidyFeedbackText(fields[field])) problems.push(`untidy:${field}`);
  }
  // A draft's Thai check reads the model's text before the student's name is restored; here the names are taken out.
  const names = aiSuspect.studentNames.filter((name) => name.trim() !== "").toSorted((a, b) => b.length - a.length);
  const withoutNames = Object.fromEntries(POST_CLASS_FEEDBACK_FIELDS.map((field) =>
    [field, names.reduce((text, name) => text.replaceAll(name, " "), fields[field])])) as unknown as FeedbackFieldAnswers;
  const text = feedbackTextChecks(fields, { thaiSource: withoutNames });
  problems.push(...text.form, ...text.content);
  const suspect = assessAiSuspect(fields, {
    studentNames: [...aiSuspect.studentNames],
    tutorNames: [...aiSuspect.tutorNames],
    priorFeedback: aiSuspect.priorFeedback.filter((prior) => prior.key !== input.wiseSessionId),
  });
  if (suspect.suspect) {
    problems.push(...suspect.reasons
      .filter((reason) => !(aiSuspect.styleGuided === true && reason === "short_required_field"))
      .map((reason) => `ai_suspect:${reason}`));
  }
  problems.push(...input.textProblems(fields));
  return [...new Set(problems)];
}

/** The AI-suspect context names a student and a tutor, and carries a prior-feedback list (which may be empty). */
function aiSuspectInputComplete(input: CorrectionAiSuspectInput | undefined): boolean {
  const names = (list: unknown) => Array.isArray(list) && list.every((name) => typeof name === "string") &&
    list.some((name: string) => name.trim() !== "");
  return Boolean(input) && names(input?.studentNames) && names(input?.tutorNames) && Array.isArray(input?.priorFeedback);
}

/** Exactly the four feedback fields: nothing else is hashed, posted or stored. */
export function exactFeedbackFields(fields: FeedbackFieldAnswers): FeedbackFieldAnswers {
  return Object.fromEntries(POST_CLASS_FEEDBACK_FIELDS.map((field) => [field, fields[field]])) as unknown as FeedbackFieldAnswers;
}

/** Refusal code for the plan itself (pure), or null. */
function planRefusal(
  plan: CorrectionPlan,
  input: Pick<CorrectPostInput, "apiActorId" | "aiSuspect" | "textProblems" | "stopRequested">,
): string | null {
  const wellFormed = (fields: FeedbackFieldAnswers | undefined) =>
    Boolean(fields) && POST_CLASS_FEEDBACK_FIELDS.every((field) => typeof fields?.[field] === "string");
  if (!wellFormed(plan.fields) || !wellFormed(plan.base?.fields)) return "fields_malformed";
  const extraKeys = (fields: FeedbackFieldAnswers) =>
    Object.keys(fields).some((key) => !(POST_CLASS_FEEDBACK_FIELDS as readonly string[]).includes(key));
  if (extraKeys(plan.fields) || extraKeys(plan.base.fields)) return "fields_extra_keys";
  if (fieldsHash(plan.fields) !== plan.fieldsSha256) return "hash_mismatch";
  if (fieldsHash(plan.base.fields) !== plan.base.fieldsSha256) return "base_hash_mismatch";
  if (plan.fieldsSha256 === plan.base.fieldsSha256) return "no_change";
  if (!plan.reason?.trim()) return "reason_missing";
  if ([...plan.reason].length > CORRECTION_MAX_REASON_CHARACTERS) return "reason_too_long";
  if (typeof plan.rootCauseRef !== "string" || !plan.rootCauseRef.trim()) return "root_cause_missing";
  if (!input.apiActorId) return "api_actor_missing";
  if (!aiSuspectInputComplete(input.aiSuspect)) return "ai_suspect_input_missing";
  let problems: string[];
  try {
    problems = correctionTextProblems(plan.fields, {
      wiseSessionId: plan.wiseSessionId,
      aiSuspect: input.aiSuspect,
      textProblems: input.textProblems,
    });
  } catch (error) {
    problems = [`check_failed:${errorName(error)}`];
  }
  if (problems.length > 0) return problems.map((problem) => `text:${problem}`).join(",");
  if (input.stopRequested?.()) return "stop_requested";
  return null;
}

type WiseStateCheck =
  | { ok: true; form: FormPlan; billing: { sessionStatus: string; creditsConsumed: number } }
  | { ok: false; reason: string };

/**
 * Wise still shows exactly our first shot, on the same submission and billing, for the same teacher, in a form the
 * corrected text fits — checked on the read before the lock (no halt for a correction that cannot go ahead) and
 * again on the fresh read under it.
 */
function checkWiseState(detail: AutowriterSessionDetail, context: {
  plan: CorrectionPlan;
  allowlist: ReadonlySet<string>;
  disabledTutors: readonly string[];
}): WiseStateCheck {
  const { plan } = context;
  const no = (reason: string): WiseStateCheck => ({ ok: false, reason });
  if (detail._id !== plan.wiseSessionId || detailClassId(detail) !== plan.wiseClassId) return no("id_mismatch");

  const form = planFeedbackForm(detail, plan.mappings);
  if (!form.ok) return no(`form:${form.reason}`);
  const unmapped = POST_CLASS_FEEDBACK_FIELDS.filter((field) => plan.fields[field] !== "" && !form.plan.fieldOrder.includes(field));
  if (unmapped.length > 0) return no(`form:form_lacks_field:${unmapped.join(",")}`);

  const snapshot = teacherSubmissionSnapshot(detail);
  if (snapshot.count !== 1) return no(`submission:count_${snapshot.count}`);
  // Answers are posted positionally: the one submission being edited must line up with the form.
  if (!existingAnswersMatchForm(detail)) return no("form:existing_answers_not_in_form_order");
  if (snapshot.submissionId !== plan.base.submissionId) return no("submission:id_changed");
  if (snapshot.autoSubmitted) return no("submission:auto_flagged");
  if (snapshot.sessionStatus === null || snapshot.creditsConsumed === null ||
    snapshot.sessionStatus !== plan.base.billing.sessionStatus || snapshot.creditsConsumed !== plan.base.billing.creditsConsumed) {
    return no("submission:billing_changed");
  }
  if (detail.meetingStatus !== "ENDED") return no(`submission:meeting_${detail.meetingStatus ?? "unknown"}`);

  const teacherId = detailTeacherId(detail);
  if (teacherId !== plan.wiseTeacherUserId) return no("teacher:changed");
  if (!context.allowlist.has(teacherId)) return no("teacher:not_allowlisted");
  if (context.disabledTutors.includes(teacherId)) return no("teacher:disabled");

  // Exactly the text of the last post, character for character: a person's edit is never overwritten.
  // (Null only for a count or form the checks above already refused.)
  const stored = storedTeacherFields(detail, plan.mappings);
  if (!stored || POST_CLASS_FEEDBACK_FIELDS.some((field) => stored[field] !== plan.base.fields[field])) {
    return no("wise_text_differs_from_last_post");
  }
  return { ok: true, form: form.plan, billing: { sessionStatus: snapshot.sessionStatus, creditsConsumed: snapshot.creditsConsumed } };
}

/** The one student with a Wise account (whose credit history the session bills), or why there is none. */
function soleStudentAccount(detail: AutowriterSessionDetail): { ok: true; wiseUserId: string } | { ok: false; reason: string } {
  const accounts = studentParticipants(detail).flatMap((student) => student.wiseUserId ? [student.wiseUserId] : []);
  if (accounts.length === 0) return { ok: false, reason: "student_id_missing" };
  if (accounts.length > 1) return { ok: false, reason: `student_count_${accounts.length}` };
  return { ok: true, wiseUserId: accounts[0] };
}

/**
 * Feedback saves since the first shot: only our API user's first-shot save may be there. Auto-submissions and
 * students (their own form, never the teacher's text) are not saves of the text.
 */
function savesSinceFirstShotRefusal(events: readonly SubmitFeedbackEvent[], apiActorId: string): string | null {
  const saves = events.filter((event) => event.autoSubmitted !== true && (event.actorRole ?? "").toUpperCase() !== "STUDENT");
  if (saves.some((event) => event.actorId !== apiActorId)) return "foreign_save_since_post";
  const ours = saves.length;
  if (ours > 1) return "extra_api_save";
  // Our own first-shot save is missing: the event read cannot be trusted to show anyone else's either.
  if (ours === 0) return "first_shot_save_missing";
  return null;
}

/** The same charges, in count and value (order-insensitive). */
function sameCreditEntries(a: ReadonlyArray<{ credit: number }>, b: ReadonlyArray<{ credit: number }>): boolean {
  const values = (entries: ReadonlyArray<{ credit: number }>) => entries.map((entry) => entry.credit).toSorted((x, y) => x - y);
  const left = values(a);
  const right = values(b);
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function creditList(entries: ReadonlyArray<{ credit: number }>): string {
  return `[${entries.map((entry) => entry.credit).join(",")}]`;
}

/** Wise still holds the base text on the same submission, billing unchanged. */
function baseStillInWise(detail: AutowriterSessionDetail, plan: CorrectionPlan): boolean {
  const snapshot = teacherSubmissionSnapshot(detail);
  const stored = storedTeacherFields(detail, plan.mappings);
  return snapshot.count === 1 && snapshot.submissionId === plan.base.submissionId && !snapshot.autoSubmitted &&
    snapshot.sessionStatus === plan.base.billing.sessionStatus && snapshot.creditsConsumed === plan.base.billing.creditsConsumed &&
    stored !== null && POST_CLASS_FEEDBACK_FIELDS.every((field) => stored[field] === plan.base.fields[field]);
}

/** A POST that did not answer: an HTTP status or an error name, never Wise's response text. */
function postErrorCode(error: string): string {
  const status = /^HTTP (\d{3})/u.exec(error)?.[1];
  return status ? `http_${status}` : `post_error:${error.split(/[:\s]/u)[0] || "Error"}`;
}

function serializeEvent(event: SubmitFeedbackEvent) {
  return { at: event.at.toISOString(), actorId: event.actorId, actorRole: event.actorRole, autoSubmitted: event.autoSubmitted };
}

interface ReadBack {
  /** Problems with the corrected text in Wise; empty when it landed exactly, billing and credit entries unchanged. */
  problems: string[];
  /** Some Wise read failed. */
  readFailed: boolean;
  /** Wise still shows the base text on the same submission and billing, with the baseline's credit entries. */
  baseIntact: boolean;
}

/**
 * Replace the text of a verified autowriter post in Wise, under every guard, with exactly one POST:
 *   1. the plan: hashes match the texts, the text changes, the reason is a short line, the corrected text passes
 *      every check its first shot passed as a draft (`correctionTextProblems`: the context-free draft checks, the
 *      AI-suspect and copy checks, Wise's limit) and the caller's checks; no STOP;
 *   2. the window (`inCorrectionWindow`) — not enforced on a dry run, which says so;
 *   3. the database preconditions (`store.preconditions`);
 *   4. Wise before the lock, reads only: the post as Wise shows it (`checkWiseState`), the one billed student, and
 *      the credit baseline — exactly the one charge;
 *   5. the lock (`store.lock`): every other autowriter POST stops until it is released;
 *   6. under the lock, fresh reads: no save since the first shot (from its posts row's time) but our own first-shot
 *      save, then the session — the same checks again, the same student; still within the lock budget; no STOP. A
 *      dry run makes these reads without the lock and returns `preflight_ok` here — it never locks, records or posts;
 *   7. the posts row (`store.recordPostStart`, which re-checks the lock), then — the lock confirmed again on the
 *      database clock (`lock.isHeld`) and the lock budget again on this machine's, nothing else in between, so a
 *      machine that slept since the claim never posts (`not_sent`) — ONE POST with the current billing in form
 *      order, never retried;
 *   8. read back after 3 s — the corrected text, the same submission, billing and credit entries — then poll every
 *      20 s, for up to 5 min, for our own submit event and for anyone else's save inside the POST window.
 * Settling: verified → the posts row and the session's text, then release; our event still not seen →
 * `awaiting_event` (same session update) and the lock is KEPT (`awaiting_event_locked`: until our event shows, a late
 * save could still turn it into a halt, so nothing else posts meanwhile; recover settles it by reads alone, then lifts
 * the lock); HTTP 429 with the base text still in Wise → `not_sent`, release, no retry (the class's one correction is
 * used up: `agentCorrectionDedupeKey`); read failures only → keep the lock and re-read every 30 s for up to 4 min.
 * Anything else — an unknown outcome, a 4xx, a read-back mismatch, changed credits, billing or submission, a
 * stranger's or an extra save — halts first (so the lock's compare-and-swap release can never undo it), settles the
 * posts row, records a critical incident and keeps the lock. Every outcome that releases the lock says when the
 * autowriter stays halted all the same (`productionStillHalted`). Throws only when the database fails while the lock
 * is held; the lock may then stay (run recover).
 */
export async function correctPostGuarded(input: CorrectPostInput): Promise<CorrectionOutcome> {
  const { ops, store } = input;
  const now = input.now ?? (() => new Date());
  const sleep = input.sleep ?? defaultSleep;
  const dryRun = input.dryRun === true;
  const lockBudgetMs = input.lockBudgetMs ?? CORRECTION_LOCK_BUDGET_MS;
  const guards: string[] = [];
  const refuse = (stage: CorrectionRefusalStage, reason: string): CorrectionOutcome => ({ status: "refused", stage, reason });

  // 1. The plan.
  const planProblem = planRefusal(input.plan, input);
  if (planProblem) return refuse("plan", planProblem);
  guards.push("plan");
  // Exactly the four fields from here on (extra keys were refused): nothing else is hashed, posted or stored.
  const plan: CorrectionPlan = {
    ...input.plan,
    fields: exactFeedbackFields(input.plan.fields),
    base: { ...input.plan.base, fields: exactFeedbackFields(input.plan.base.fields) },
  };
  const sid = plan.wiseSessionId;

  // 2. The window. Its end also bounds the wait for a running sweep (step 5).
  const windowAt = now();
  const windowEnd = correctionWindowEnd(windowAt);
  if (inCorrectionWindow(windowAt)) guards.push("window");
  else if (dryRun) guards.push("window (not enforced: dry run outside the window)");
  else return refuse("window", "outside_window");

  // 3. The database.
  let database: CorrectionPreconditions;
  try {
    database = await store.preconditions(plan, now());
  } catch (error) {
    return refuse("db", `preconditions_failed:${failureName(error)}`);
  }
  if (database.problems.length > 0) return refuse("db", database.problems.join(","));
  if (!database.firstShotPostedAt) return refuse("db", "first_shot_time_unknown");
  const firstShotPostedAt = database.firstShotPostedAt;
  guards.push("db_preconditions");

  // 4. Wise before the lock (reads only).
  const context = { plan, allowlist: input.allowlist, disabledTutors: input.disabledTutors };
  let before: AutowriterSessionDetail;
  try {
    before = parseAutowriterSessionDetail(await ops.getSessionDetail(plan.wiseClassId, sid));
  } catch (error) {
    return refuse("wise", `detail_read_failed:${errorName(error)}`);
  }
  const early = checkWiseState(before, context);
  if (!early.ok) return refuse("wise", early.reason);
  const student = soleStudentAccount(before);
  if (!student.ok) return refuse("wise", student.reason);
  let baseline: Array<{ credit: number }>;
  try {
    baseline = (await ops.getSessionCreditEntries(plan.wiseClassId, student.wiseUserId, sid)).map((entry) => ({ credit: entry.credit }));
  } catch (error) {
    return refuse("wise", `credits_read_failed:${errorName(error)}`);
  }
  const baselineProblems = creditProblems(baseline, plan.base.billing);
  if (baselineProblems.length > 0) return refuse("wise", baselineProblems.map((problem) => `credit_baseline:${problem}`).join(","));
  guards.push("wise_state_before_lock", "credit_baseline");

  // 5. The lock. Its budget runs from the halt: waiting for a running sweep before it is not part of it (nothing is
  // halted then), and that wait ends with the window, so the halt and the POST keep the window's timing.
  let lockStartedAt = now().getTime();
  let lock: CorrectionLock | null = null;
  if (dryRun) {
    guards.push("lock (not taken: dry run)");
  } else {
    // The reads since step 2 may have run past the window: then no halt at all.
    if (windowEnd && now().getTime() >= windowEnd.getTime()) return refuse("window", "window_closed");
    let locked: Awaited<ReturnType<CorrectionStore["lock"]>>;
    try {
      locked = await store.lock(plan, { waitUntil: windowEnd ?? undefined, stopRequested: input.stopRequested });
    } catch (error) {
      return refuse("lock", `lock:error:${failureName(error)}`);
    }
    if (!locked.ok) return refuse("lock", `lock:${locked.reason}`);
    lock = locked.lock;
    lockStartedAt = locked.lock.haltedAtMs ?? now().getTime();
    guards.push("lock");
  }
  const held = lock;
  /** Release the lock (if taken); the report says when the autowriter stays halted all the same. */
  const releaseLock = async (): Promise<ReleaseReport> => {
    if (!held || await held.release()) return {};
    return { productionStillHalted: true };
  };
  const refuseHeld = async (stage: CorrectionRefusalStage, reason: string): Promise<CorrectionOutcome> =>
    ({ status: "refused", stage, reason, ...await releaseLock() });

  // 6. The fresh reads, made AFTER the lock is taken (on a dry run, without it): the saves since the first shot, then
  // the session — the last read before the POST, so the text checked is as fresh as it can be. The POST window
  // starts at the events read, not the session read: a save between the two is never outside both.
  const unlocked = dryRun ? " (without the lock: dry run)" : "";
  let eventsReadAt: Date;
  try {
    eventsReadAt = await store.databaseNow();
  } catch (error) {
    return refuseHeld("db", `clock_read_failed:${failureName(error)}`);
  }
  let sinceFirstShot: SubmitFeedbackEvent[];
  try {
    sinceFirstShot = await ops.findFeedbackEvents(plan.wiseClassId, sid, new Date(firstShotPostedAt.getTime() - EVENT_SKEW_MS));
  } catch (error) {
    return refuseHeld("wise", `events_read_failed:${errorName(error)}`);
  }
  const savesProblem = savesSinceFirstShotRefusal(sinceFirstShot, input.apiActorId);
  if (savesProblem) return refuseHeld("wise", savesProblem);
  let freshReadAt: Date;
  try {
    freshReadAt = await store.databaseNow();
  } catch (error) {
    return refuseHeld("db", `clock_read_failed:${failureName(error)}`);
  }
  let fresh: AutowriterSessionDetail;
  try {
    fresh = parseAutowriterSessionDetail(await ops.getSessionDetail(plan.wiseClassId, sid));
  } catch (error) {
    return refuseHeld("wise", `detail_read_failed:${errorName(error)}`);
  }
  const current = checkWiseState(fresh, context);
  if (!current.ok) return refuseHeld("wise", current.reason);
  const freshStudent = soleStudentAccount(fresh);
  if (!freshStudent.ok) return refuseHeld("wise", freshStudent.reason);
  if (freshStudent.wiseUserId !== student.wiseUserId) return refuseHeld("wise", "student_changed");
  // The credit baseline was read before the lock (and a wait for a running sweep): read it again under the lock, so a
  // change by staff meanwhile is refused here rather than blamed on our POST at read-back.
  if (held) {
    let underLock: Array<{ credit: number }>;
    try {
      underLock = (await ops.getSessionCreditEntries(plan.wiseClassId, student.wiseUserId, sid)).map((entry) => ({ credit: entry.credit }));
    } catch (error) {
      return refuseHeld("wise", `credits_read_failed:${errorName(error)}`);
    }
    if (!sameCreditEntries(underLock, baseline)) return refuseHeld("wise", "credit_baseline_changed");
  }
  guards.push(`no_save_since_first_shot${unlocked}`, `wise_state_under_lock${unlocked}`);
  if (held) {
    if (now().getTime() - lockStartedAt >= lockBudgetMs) return refuseHeld("lock", "lock_budget");
    guards.push("lock_budget");
  }
  if (input.stopRequested?.()) return refuseHeld("plan", "stop_requested");
  guards.push("stop");

  // The current billing (equal to the base's, checked above), answers in the form's order.
  const body = buildFeedbackPostBody(current.form, plan.fields, current.billing);
  const bodyHash = feedbackBodyHash(body);
  if (!held) return { status: "preflight_ok", bodyHash, guards };

  // 7. The posts row first (its `post_started_at`, on the database clock, is the POST's start), then exactly one POST.
  let postId: string;
  let postStartedAt: Date;
  try {
    ({ postId, postStartedAt } = await store.recordPostStart(plan, {
      bodyHash,
      eventsReadAt,
      freshReadAt,
      studentWiseUserId: student.wiseUserId,
      baselineCredits: baseline.map((entry) => entry.credit),
    }));
  } catch (error) {
    if (error instanceof CorrectionRefusedError) return refuseHeld(error.reason.startsWith("lock:") ? "lock" : "db", error.reason);
    return refuseHeld("db", sqlStateOf(error) === "23505" ? "already_corrected" : `record_failed:${failureName(error)}`);
  }

  // Nothing was sent after all: the posts row settles `not_sent` (it still uses up the class's one correction).
  const abandonBeforePost = async (reason: string): Promise<CorrectionOutcome> => {
    const problems = [reason];
    try {
      await store.settle(postId, { outcome: "not_sent", verification: { notSent: reason, postStartedAt: postStartedAt.toISOString() } });
    } catch (error) {
      // Recovery settled it already (this machine slept past the lease), or the database failed: recovery finds it.
      problems.push(`settle_failed:${failureName(error)}`);
    }
    return { status: "not_sent", postId, reason: problems.join(","), ...await releaseLock() };
  };
  // The last checks before the POST, nothing in between: the lock is still ours on the database clock (the lease not
  // expired while this machine slept, no owner pause, resume or tutor switch), and the budget is not spent.
  let stillHeld: boolean;
  try {
    stillHeld = await held.isHeld();
  } catch (error) {
    return abandonBeforePost(`lock_check_failed:${failureName(error)}`);
  }
  if (!stillHeld) return abandonBeforePost("lock_lost");
  if (now().getTime() - lockStartedAt >= lockBudgetMs) return abandonBeforePost("lock_budget");
  let result: PostResult;
  try {
    result = await ops.postFeedback(plan.wiseClassId, sid, body);
  } catch (error) {
    result = { kind: "unknown", error: errorName(error) };
  }
  let postFinishedAt: Date | null;
  try {
    postFinishedAt = await store.databaseNow();
  } catch {
    // Unknown: the POST window then ends at the POST's time-out bound (`classifySubmitEvents`), never earlier.
    postFinishedAt = null;
  }
  const timing = {
    eventsReadAt: eventsReadAt.toISOString(),
    freshReadAt: freshReadAt.toISOString(),
    postStartedAt: postStartedAt.toISOString(),
    postFinishedAt: postFinishedAt?.toISOString() ?? null,
  };

  // 8. Read back.
  const expected: SubmissionState = {
    kind: "auto_blank",
    submissionId: plan.base.submissionId,
    sessionStatus: plan.base.billing.sessionStatus,
    creditsConsumed: plan.base.billing.creditsConsumed,
  };
  const readBack = async (): Promise<ReadBack> => {
    const readErrors: string[] = [];
    let after: AutowriterSessionDetail | null = null;
    try {
      after = parseAutowriterSessionDetail(await ops.getSessionDetail(plan.wiseClassId, sid));
    } catch (error) {
      readErrors.push(`verify_read_failed:${errorName(error)}`);
    }
    let entries: Array<{ credit: number }> | null = null;
    try {
      entries = await ops.getSessionCreditEntries(plan.wiseClassId, student.wiseUserId, sid);
    } catch (error) {
      readErrors.push(`credits_reread_failed:${errorName(error)}`);
    }
    const problems = [...readErrors];
    if (after) problems.push(...verifyStoredSubmission(after, { fields: plan.fields, billing: plan.base.billing, expected, mappings: plan.mappings }));
    const creditsSame = entries !== null && sameCreditEntries(entries, baseline);
    if (entries && !creditsSame) problems.push(`credit_entries_changed:${creditList(baseline)}->${creditList(entries)}`);
    return { problems, readFailed: readErrors.length > 0, baseIntact: after !== null && creditsSame && baseStillInWise(after, plan) };
  };
  // Only Wise reads failed: nothing is known yet, so the lock stays while Wise is read again.
  const readUntilKnown = async (unknown: (check: ReadBack) => boolean): Promise<ReadBack> => {
    let check = await readBack();
    const startedAt = now().getTime();
    for (let attempt = 0; unknown(check) && attempt < CORRECTION_READ_RETRIES &&
      now().getTime() - startedAt < CORRECTION_READ_RETRY_WINDOW_MS; attempt += 1) {
      await sleep(CORRECTION_READ_RETRY_INTERVAL_MS);
      check = await readBack();
    }
    return check;
  };

  let haltedFor: string | null = null;
  const halt = async (outcome: string, problems: readonly string[]) => {
    if (haltedFor !== null) return;
    haltedFor = outcome;
    await store.halt(`agent correction on ${sid} needs a person (${outcome}): ${problems.join(", ")}`);
  };
  // Halt (unless already) → settle → incident; the lock is kept, so the autowriter stays halted for the owner.
  const safety = async (
    outcome: "rejected" | "unknown_outcome" | "verify_failed",
    problems: string[],
    verification: Record<string, unknown>,
  ): Promise<CorrectionOutcome> => {
    await halt(outcome, problems);
    const reported = [...problems];
    try {
      await store.settle(postId, { outcome, verification: { ...timing, ...verification, problems } });
    } catch (error) {
      reported.push(`settle_failed:${failureName(error)}`);
    }
    try {
      await store.incident({
        dedupeKey: `correction_failed:${sid}`,
        wiseSessionId: sid,
        summary: `An agent correction did not verify (${outcome}: ${problems.join(", ")}). `
          + "The autowriter is halted: check the class in Wise, then resume.",
        detail: { postId, outcome, problems: reported, bodyHash, ...timing },
      });
    } catch (error) {
      reported.push(`incident_failed:${failureName(error)}`);
    }
    return { status: "safety", postId, problems: reported };
  };

  if (result.kind === "rejected" || result.kind === "unknown") {
    // Not a clean answer: halt before anything else, then read back for the record — the outcome is final either way.
    const outcome = result.kind === "rejected" ? "rejected" : "unknown_outcome";
    const code = result.kind === "rejected" ? `http_${result.status}` : postErrorCode(result.error);
    await halt(outcome, [code]);
    await sleep(CORRECTION_READ_BACK_DELAY_MS);
    const check = await readBack();
    return safety(outcome, [code, ...check.problems], {
      ...(result.kind === "rejected" ? { httpStatus: result.status } : {}),
      // Unknown (null) when a read failed.
      stillBase: check.readFailed ? null : check.baseIntact,
      landed: check.readFailed ? null : check.problems.length === 0,
    });
  }

  if (result.kind === "rate_limited") {
    await sleep(CORRECTION_READ_BACK_DELAY_MS);
    const check = await readUntilKnown((read) => read.readFailed);
    if (!check.readFailed && check.baseIntact) {
      // Wise refused it and nothing changed: not sent, never retried here.
      await store.settle(postId, { outcome: "not_sent", verification: { ...timing, httpStatus: 429, stillBase: true } });
      return { status: "not_sent", postId, reason: "wise_rate_limited", ...await releaseLock() };
    }
    const problems = ["http_429", check.readFailed ? "read_failed_after_retries" : "submission_changed_after_429", ...check.problems];
    return safety("unknown_outcome", problems, { httpStatus: 429, stillBase: false });
  }

  await sleep(CORRECTION_READ_BACK_DELAY_MS);
  const check = await readUntilKnown((read) => read.problems.length > 0 && read.problems.every(isReadFailure));
  if (check.problems.length > 0) {
    const onlyReads = check.problems.every(isReadFailure);
    return safety("verify_failed", onlyReads ? [...check.problems, "read_failed_after_retries"] : check.problems, {
      httpStatus: result.status,
      stillBase: check.baseIntact,
    });
  }

  // Our own submit event, and nobody else's save (nor a second API save) in the POST window — from the first of the
  // fresh reads to the POST's end — polled every 20 s for up to 5 min. A stranger's or a second save ends the wait.
  const waitMs = input.eventWaitMs ?? CORRECTION_EVENT_WAIT_MS;
  const windowEndMs = (postFinishedAt?.getTime() ?? postStartedAt.getTime() + AUTOWRITER_POST_TIMEOUT_MS) + EVENT_SKEW_MS;
  const waitStartedAt = now().getTime();
  let found: { ours: SubmitFeedbackEvent | undefined; foreign: SubmitFeedbackEvent[]; extra: SubmitFeedbackEvent[] } =
    { ours: undefined, foreign: [], extra: [] };
  let eventsReadFailed = false;
  for (;;) {
    try {
      const events = await ops.findFeedbackEvents(plan.wiseClassId, sid, new Date(eventsReadAt.getTime() - EVENT_SKEW_MS));
      const classified = classifySubmitEvents(events, { apiActorId: input.apiActorId, freshReadAt: eventsReadAt, postStartedAt, postFinishedAt });
      // A second save by the API user inside the window; later ones are on top of ours (`classifySubmitEvents`).
      const extra = events.filter((event) => event !== classified.ours && event.autoSubmitted !== true &&
        event.actorId === input.apiActorId && event.at.getTime() >= eventsReadAt.getTime() - EVENT_SKEW_MS &&
        event.at.getTime() <= windowEndMs);
      found = { ...classified, extra };
      eventsReadFailed = false;
    } catch {
      eventsReadFailed = true;
    }
    if (found.ours || found.foreign.length > 0 || found.extra.length > 0) break;
    if (now().getTime() - waitStartedAt >= waitMs) break;
    await sleep(CORRECTION_EVENT_POLL_MS);
  }
  const eventProblems = [
    ...(found.foreign.length > 0 ? ["foreign_submit_event_in_post_window"] : []),
    ...(found.extra.length > 0 ? [`extra_api_save_in_post_window:${found.extra.length}`] : []),
  ];
  if (eventProblems.length > 0) return safety("verify_failed", eventProblems, { httpStatus: result.status, landed: true });

  const ours = found.ours;
  const verification = {
    ...timing,
    httpStatus: result.status,
    landed: true,
    creditEntries: baseline.length,
    eventsReadFailed,
    event: ours ? serializeEvent(ours) : null,
  };
  try {
    await store.settle(postId, {
      outcome: ours ? "verified" : "awaiting_event",
      verification,
      session: { fields: plan.fields, fieldsSha256: plan.fieldsSha256, fromSha256: plan.base.fieldsSha256, at: now(), reason: plan.reason },
    });
  } catch (error) {
    // The text is in Wise but could not be recorded (e.g. the session row moved): a person must reconcile it.
    return safety("verify_failed", [`settle_failed:${failureName(error)}`], { httpStatus: result.status, landed: true });
  }
  // Not settled until our event shows: the lock stays, and recover settles it by reads alone, then lifts the lock.
  if (!ours) return { status: "awaiting_event_locked", postId, bodyHash };
  return { status: "verified", postId, bodyHash, ...await releaseLock() };
}
