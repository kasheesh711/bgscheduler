import { z } from "zod";
import { calculateFeedbackDeadline } from "@/lib/post-class-feedback/policy";
import type { FeedbackFieldAnswers, FeedbackFieldMapping } from "@/lib/post-class-feedback/types";
import { POST_CLASS_FEEDBACK_FIELDS } from "@/lib/post-class-feedback/types";
import {
  DEFAULT_FEEDBACK_FIELD_MAPPINGS,
  mapAnswersToFields,
  normalizeWiseFeedbackAnswers,
  normalizeWiseFeedbackQuestions,
  resolveFeedbackFieldMapping,
} from "@/lib/post-class-feedback/wise";
import type { WiseFeedbackAnswer, WiseFeedbackQuestion } from "@/lib/wise/types";
import { GENERIC_GUEST_WORDS, parseStudentName } from "./prompt";
import { AUTOWRITER_ROSTER, rosterAccountIds, rosterTutor } from "./roster";
import {
  AUTOWRITER_DEADLINE_MARGIN_MS,
  AUTOWRITER_ATTENDANCE_SETTLE_MINUTES,
  AUTOWRITER_GUEST_STUDENT_MIN_PERCENT,
  AUTOWRITER_MIN_ATTENDANCE_PERCENT,
  AUTOWRITER_MIN_SUMMARY_CHARACTERS,
  type AiSummary,
  type AutowriterStudent,
  type GateInput,
  type GateResult,
  type SubmissionState,
  type WiseFeedbackPostBody,
} from "./types";

// ---------------------------------------------------------------------------
// Wise session detail (GET /user/classes/{cid}/sessions/{sid} with
// showSessionFiles) — only the fields the autowriter relies on.
// ---------------------------------------------------------------------------

const UserRefSchema = z.union([
  z.string(),
  z.object({ _id: z.string(), name: z.string().optional() }).passthrough(),
]);

const QuestionSchema = z.object({
  _id: z.string().optional(),
  questionId: z.string().optional(),
  questionText: z.string().optional(),
  text: z.string().optional(),
  title: z.string().optional(),
  type: z.string().optional(),
  required: z.boolean().optional(),
}).passthrough();

const AnswerSchema = z.object({
  _id: z.string().optional(),
  questionId: z.string().optional(),
  questionText: z.string().optional(),
  type: z.string().optional(),
  answer: z.unknown().optional(),
}).passthrough();

const SubmissionSchema = z.object({
  _id: z.string().optional(),
  profile: z.string().nullable().optional(),
  answers: z.array(AnswerSchema).default([]),
  sessionStatus: z.string().nullable().optional(),
  creditsConsumed: z.number().nullable().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  metadata: z.object({ autoSubmitted: z.boolean().optional() }).passthrough().nullable().optional(),
  userId: UserRefSchema.nullable().optional(),
}).passthrough();

const ParticipantSchema = z.object({
  wiseUserId: z.string().optional(),
  name: z.string().optional(),
  isTeacher: z.boolean().optional(),
  inMeetingDuration: z.number().optional(),
  duration: z.number().optional(),
  absolutePercentAttendance: z.number().optional(),
}).passthrough();

const SummarySchema = z.object({
  summaryOverview: z.string().optional(),
  summaryDetails: z.array(z.object({
    label: z.string().optional(),
    summary: z.string().optional(),
  }).passthrough()).default([]),
  meetingUUID: z.string().optional(),
}).passthrough();

export const AutowriterSessionDetailSchema = z.object({
  _id: z.string(),
  classId: z.union([z.string(), z.object({ _id: z.string() }).passthrough()]),
  className: z.string().optional(),
  classSubject: z.string().nullable().optional(),
  /** Session title, e.g. "Live Session - NVR": at BeGifted the only field naming the subject. */
  title: z.string().nullable().optional(),
  type: z.string().optional(),
  classType: z.string().optional(),
  meetingStatus: z.string().optional(),
  scheduledStartTime: z.string(),
  scheduledEndTime: z.string(),
  userId: UserRefSchema,
  participants: z.array(ParticipantSchema).default([]),
  feedbackForm: z.object({
    _id: z.string().optional(),
    profile: z.string().optional(),
    enabled: z.boolean().optional(),
    questions: z.array(QuestionSchema).default([]),
  }).passthrough().nullable().optional(),
  feedbackSubmissions: z.array(SubmissionSchema).default([]),
  rawMeetingSummary: z.array(SummarySchema).nullable().optional(),
  /** Composite MP4 per recording part; appears hours after class (needs `showSessionFiles`). */
  rawRecordings: z.array(z.object({
    url: z.string().optional(),
    partIndex: z.number().optional(),
    duration: z.number().optional(),
  }).passthrough()).nullable().optional(),
  /** Zoom WEBVTT transcript per part; cues carry speaker display names. */
  rawTranscript: z.array(z.object({
    url: z.string().optional(),
    file: z.object({ path: z.string().optional() }).passthrough().nullable().optional(),
  }).passthrough()).nullable().optional(),
}).passthrough();

export type AutowriterSessionDetail = z.infer<typeof AutowriterSessionDetailSchema>;
type Submission = z.infer<typeof SubmissionSchema>;

/** Parse the `data` object of a Wise session-detail response. Throws on drift. */
export function parseAutowriterSessionDetail(response: unknown): AutowriterSessionDetail {
  const data = (response as { data?: unknown } | null)?.data ?? response;
  return AutowriterSessionDetailSchema.parse(data);
}

function refId(value: z.infer<typeof UserRefSchema> | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value._id;
}

export function detailTeacherName(detail: AutowriterSessionDetail): string | null {
  return typeof detail.userId === "string" ? null : detail.userId.name?.trim() || null;
}

/**
 * The one composite recording Soniox can fetch. Several parts (the meeting was
 * restarted) are not stitched: the class is left to a person.
 */
export function recordingForTranscription(detail: AutowriterSessionDetail):
  | { ok: true; url: string; durationSeconds: number | null }
  | { ok: false; reason: "recording_not_ready" | "recording_multiple_parts" } {
  const parts = (detail.rawRecordings ?? []).filter((part) => part.url);
  if (parts.length === 0) return { ok: false, reason: "recording_not_ready" };
  if (parts.length > 1) return { ok: false, reason: "recording_multiple_parts" };
  return { ok: true, url: parts[0].url!, durationSeconds: typeof parts[0].duration === "number" ? parts[0].duration : null };
}

/** Share of the scheduled lesson a recording must cover to stand for the whole lesson. */
export const MIN_RECORDING_COVERAGE = 0.7;

/** A recording that stopped early would be written up as the whole lesson. */
export function recordingTooShort(durationSeconds: number | null, scheduledMinutes: number): boolean {
  return durationSeconds !== null && durationSeconds > 0 && scheduledMinutes > 0 &&
    durationSeconds < scheduledMinutes * 60 * MIN_RECORDING_COVERAGE;
}

/** Zoom's transcript file, used only to tell tutor from student (single part only). */
export function zoomTranscriptUrl(detail: AutowriterSessionDetail): string | null {
  const parts = detail.rawTranscript ?? [];
  if (parts.length !== 1) return null;
  return parts[0].url ?? parts[0].file?.path ?? null;
}

export function detailClassId(detail: AutowriterSessionDetail): string {
  return typeof detail.classId === "string" ? detail.classId : detail.classId._id;
}

export function detailTeacherId(detail: AutowriterSessionDetail): string | null {
  return refId(detail.userId);
}

/**
 * The class's name as Class Feedback would mirror it (Wise `className`, else
 * `classId.name`; at BeGifted usually the student's name), else the first
 * student with a Wise account. The dashboard shows it until the mirror row exists.
 */
export function detailClassName(detail: AutowriterSessionDetail): string | null {
  const classIdName = typeof detail.classId === "string" ? undefined : detail.classId.name;
  for (const name of [detail.className, classIdName]) {
    if (typeof name === "string" && name.trim()) return name.trim();
  }
  return studentParticipants(detail).find((student) => student.wiseUserId && student.name)?.name ?? null;
}

export function scheduledWindow(detail: AutowriterSessionDetail): { start: Date; end: Date; minutes: number } {
  const start = new Date(detail.scheduledStartTime);
  const end = new Date(detail.scheduledEndTime);
  return { start, end, minutes: Math.round((end.getTime() - start.getTime()) / 60_000) };
}

// ---------------------------------------------------------------------------
// Summary, submissions, attendance
// ---------------------------------------------------------------------------

/** Wise's AI meeting summary as plain text, or null when Wise has none yet. */
export function extractAiSummary(detail: AutowriterSessionDetail): AiSummary | null {
  const parts: string[] = [];
  const meetingUUIDs: string[] = [];
  for (const summary of detail.rawMeetingSummary ?? []) {
    if (summary.meetingUUID) meetingUUIDs.push(summary.meetingUUID);
    const overview = summary.summaryOverview?.trim();
    if (overview) parts.push(`Overview: ${overview}`);
    for (const item of summary.summaryDetails) {
      const text = item.summary?.trim();
      if (!text) continue;
      const label = item.label?.trim();
      parts.push(label ? `${label}: ${text}` : text);
    }
  }
  const text = parts.join("\n\n").trim();
  return text ? { text, meetingUUIDs } : null;
}

function answerText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

function isBlankSubmission(submission: Submission): boolean {
  return submission.answers.every((answer) => answerText(answer.answer).trim() === "");
}

function teacherSubmissions(detail: AutowriterSessionDetail): Submission[] {
  return detail.feedbackSubmissions.filter((submission) => submission.profile === "teacher");
}

/**
 * none: nobody submitted. auto_blank: Wise's own blank auto-submission, the
 * only existing submission the pilot may complete (the Wise web app lets a
 * teacher edit exactly these). Everything else is human and never touched.
 */
export function classifyTeacherSubmission(detail: AutowriterSessionDetail): SubmissionState {
  const submissions = teacherSubmissions(detail);
  if (submissions.length === 0) return { kind: "none" };
  if (submissions.length > 1) {
    return { kind: "ambiguous", reason: `${submissions.length} teacher submissions` };
  }
  const [submission] = submissions;
  const blank = isBlankSubmission(submission);
  if (blank && submission.metadata?.autoSubmitted === true) {
    if (!submission._id) return { kind: "ambiguous", reason: "auto-submission without id" };
    return {
      kind: "auto_blank",
      submissionId: submission._id,
      sessionStatus: submission.sessionStatus ?? null,
      creditsConsumed: submission.creditsConsumed ?? null,
    };
  }
  return { kind: "human", submissionId: submission._id ?? null, blank };
}

/** Student-profile submissions must not carry billing fields (PCF reads them). */
export function nonTeacherBillingEvidence(detail: AutowriterSessionDetail): boolean {
  return detail.feedbackSubmissions.some((submission) =>
    submission.profile !== "teacher" &&
    (submission.sessionStatus != null || submission.creditsConsumed != null));
}

function normalizePersonName(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim();
}

/**
 * The session's tutor as they may appear among the participants. Tutors
 * sometimes join their own class again — from their other Wise account, or
 * from another device as a Zoom guest under their own name (Peat, 29 Sep:
 * "Kasidej Jungrakangthong" and "Peat" beside his teacher account) — and are
 * not students.
 */
function tutorSelf(detail: AutowriterSessionDetail): { accounts: Set<string>; names: Set<string>; rawNames: string[] } {
  const teacherId = detailTeacherId(detail);
  const tutor = rosterTutor(teacherId);
  const accounts = new Set(tutor ? rosterAccountIds(tutor.canonicalKey) : []);
  if (teacherId) accounts.add(teacherId);
  const names = new Set<string>();
  const rawNames: string[] = [];
  const add = (name: string | null | undefined) => {
    if (!name?.trim() || names.has(normalizePersonName(name))) return;
    names.add(normalizePersonName(name));
    rawNames.push(name.trim());
  };
  add(detailTeacherName(detail));
  if (tutor) {
    for (const account of AUTOWRITER_ROSTER) if (account.canonicalKey === tutor.canonicalKey) add(account.displayName);
    for (const name of tutor.tutorNames) add(name);
    for (const name of tutor.selfNames ?? []) add(name);
  }
  return { accounts, names, rawNames };
}

/** Every name the session's tutor may appear under (their Wise names and roster name variants). */
export function tutorSelfNames(detail: AutowriterSessionDetail): string[] {
  return tutorSelf(detail).rawNames;
}

/** BeGifted titles in-person classes "In-Person Session - …" / "On-site Session - …". */
const IN_PERSON_TITLE = /^\s*(?:in[\s-]?person|on[\s-]?site)\s+session\b/iu;

/**
 * The session's students: every non-teacher participant except the tutor
 * themselves — their other Wise account, or a guest (no Wise account) under
 * one of their names. Anyone else, named or not, still counts (fail closed:
 * an unknown guest makes a one-to-one class look like two students) — except
 * the guest standing in for the student (`guestStandsInForStudent`).
 */
export function studentParticipants(detail: AutowriterSessionDetail): AutowriterStudent[] {
  const self = tutorSelf(detail);
  const students = detail.participants
    .filter((participant) => participant.isTeacher !== true)
    .filter((participant) => !(participant.wiseUserId && self.accounts.has(participant.wiseUserId)))
    .filter((participant) => Boolean(participant.wiseUserId) || !participant.name?.trim() ||
      !self.names.has(normalizePersonName(participant.name)))
    .map((participant) => ({
      wiseUserId: participant.wiseUserId ?? null,
      name: participant.name?.trim() ?? "",
      inMeetingSeconds: participant.inMeetingDuration ?? participant.duration ?? null,
      absolutePercentAttendance: participant.absolutePercentAttendance ?? null,
    }));
  return guestStandsInForStudent(detail, students) ?? students;
}

/**
 * A one-to-one student who joined through a Zoom link as a guest instead of
 * their Wise account (Mimi, 29 Sep: a guest under the student's nickname and
 * surname at 94% while their Wise account shows 0 minutes). Owner rule: when the only other
 * participant besides the Wise account is one guest, the Wise account attended
 * under the minimum, and the guest and the tutor both stayed at least
 * `AUTOWRITER_GUEST_STUDENT_MIN_PERCENT` of the class, the guest is the student.
 * A guest whose name is the student's own (`guestNamedAsStudent`) only needs the
 * usual `AUTOWRITER_MIN_ATTENDANCE_PERCENT` (owner rule, 2 Oct: a guest "emmieeee"
 * at 65% beside the account "Emmika (Emmie.Wi) …" at 0 minutes is the student).
 * The tutor's bar is unchanged. The Wise account stays the student billed,
 * credit-checked and named; the guest's attendance counts. Anything else: null
 * (no stand-in).
 */
function guestStandsInForStudent(detail: AutowriterSessionDetail, students: readonly AutowriterStudent[]): AutowriterStudent[] | null {
  if (detail.classType !== "ONE_TO_ONE" || students.length !== 2) return null;
  const account = students.find((student) => student.wiseUserId);
  const guest = students.find((student) => !student.wiseUserId);
  if (!account || !guest) return null;
  const minutes = scheduledWindow(detail).minutes;
  const accountPercent = studentAttendancePercent(account, minutes);
  const guestPercent = studentAttendancePercent(guest, minutes);
  // The tutor's best entry (Wise may list them twice), read like a student's attendance.
  const teacherPercents = detail.participants
    .filter((participant) => participant.isTeacher === true)
    .map((participant) => studentAttendancePercent({
      wiseUserId: participant.wiseUserId ?? null,
      name: participant.name ?? "",
      inMeetingSeconds: participant.inMeetingDuration ?? participant.duration ?? null,
      absolutePercentAttendance: participant.absolutePercentAttendance ?? null,
    }, minutes))
    .filter((value): value is number => value !== null);
  const teacherPercent = teacherPercents.length > 0 ? Math.max(...teacherPercents) : null;
  if (accountPercent === null || accountPercent >= AUTOWRITER_MIN_ATTENDANCE_PERCENT) return null;
  const guestBar = guestNamedAsStudent(guest.name, account.name)
    ? AUTOWRITER_MIN_ATTENDANCE_PERCENT
    : AUTOWRITER_GUEST_STUDENT_MIN_PERCENT;
  if (guestPercent === null || guestPercent < guestBar) return null;
  if (teacherPercent === null || teacherPercent < AUTOWRITER_GUEST_STUDENT_MIN_PERCENT) return null;
  return [{
    ...account,
    inMeetingSeconds: guest.inMeetingSeconds,
    absolutePercentAttendance: guestPercent,
    // "" for a nameless guest: still the stand-in, but nothing to redact.
    joinedAsGuest: guest.name.trim(),
  }];
}

/** A name word compared loosely: case-folded, stretched letters collapsed ("emmieeee" and "Emmie" are both "emie"). */
function nameKey(word: string): string {
  return word.normalize("NFKC").toLocaleLowerCase("en-US").replace(/(\p{L})\1+/gu, "$1");
}

/** Shorter name words ("Wi", "Ka") are too common to say who someone is. */
const MIN_NAME_KEY_LENGTH = 3;

/**
 * Device-model and account-label words that are also common Thai nicknames: a Zoom
 * guest "iPad Air" or "Redmi Note 12" is a device, not a student nicknamed Air or Note.
 * Kept out of `GENERIC_GUEST_WORDS`, which redaction reads (an alias "Air" must still be redacted).
 */
const DEVICE_MODEL_WORDS = new Set([
  "air", "mini", "max", "pro", "plus", "note", "ultra", "lite", "fold", "flip", "tab", "book", "se", "online", "onsite",
]);

/**
 * Parent, sibling and grandparent words: a guest "Mae Aim" or "Aim's Mom" is someone
 * else's name for the device, not the student's own (owner rule, 2 Oct). Kept separate
 * from `GENERIC_GUEST_WORDS`, which also drops these words but only as filler.
 */
const FAMILY_GUEST_WORDS = new Set([
  "mom", "mum", "mommy", "mummy", "mother", "mama", "mae", "dad", "daddy", "father", "papa", "pa", "ma", "family",
  "sister", "sis", "brother", "bro", "aunt", "auntie", "uncle", "grandma", "grandpa", "granny", "nanny", "son", "daughter",
]);

/**
 * The Thai family words, matched as a word's start since Thai is often written without
 * spaces ("แม่เอม"). Not น้อง, the usual prefix for the child themselves ("น้องเอม"), nor
 * the short ambiguous ตา, อา, น้า, พี่.
 */
const THAI_FAMILY_PREFIXES = ["แม่", "พ่อ", "ยาย", "ย่า", "ปู่", "ป้า", "ลุง"];

/**
 * Whether a guest's name is the student's own: one of its words — a possessive
 * as the bare name, never a device or model word ("iPad Air") — equals the
 * student's first name, nickname or surname, compared by `nameKey`. Whole words
 * only, never a prefix. A nameless guest is not named as anyone, nor is a name
 * with a family word in it ("Mae Aim", "Aim's Mom", "แม่เอม"): a parent's or
 * sibling's name for the device keeps the stricter guest bar (owner rule, 2 Oct).
 * A surname-only match ("Nattapong Kaewmanee") counts, on purpose (owner rule, 2 Oct).
 */
export function guestNamedAsStudent(guestName: string, studentName: string): boolean {
  const { firstName, nickname } = parseStudentName(studentName);
  const surname = studentName.replace(/\s*\([^)]*\)\s*/gu, " ").replace(/\s+(?:online|onsite)\s*$/iu, "")
    .trim().split(/\s+/u).slice(1).at(-1) ?? null;
  const studentKeys = new Set([firstName, nickname, surname]
    .filter((word): word is string => Boolean(word?.trim()))
    .map(nameKey)
    .filter((key) => [...key].length >= MIN_NAME_KEY_LENGTH));
  if (studentKeys.size === 0) return false;
  const words = guestName.normalize("NFKC").split(/[^\p{L}\p{M}'’]+/u)
    .map((word) => word.replace(/['’]s?$/u, "").replace(/['’]/gu, ""))
    .filter((word) => word !== "");
  if (words.some((word) => FAMILY_GUEST_WORDS.has(word.toLocaleLowerCase("en-US")) ||
    THAI_FAMILY_PREFIXES.some((prefix) => word.startsWith(prefix)))) return false;
  return words
    .filter((word) => !GENERIC_GUEST_WORDS.has(word.toLocaleLowerCase("en-US")) &&
      !DEVICE_MODEL_WORDS.has(word.toLocaleLowerCase("en-US")))
    .map(nameKey)
    .some((key) => [...key].length >= MIN_NAME_KEY_LENGTH && studentKeys.has(key));
}

/** One Wise account and one guest, not (yet) a stand-in: attendance may still be arriving. */
function accountAndGuest(students: readonly AutowriterStudent[]): boolean {
  return students.length === 2 && students.filter((student) => student.wiseUserId).length === 1;
}

export function studentAttendancePercent(student: AutowriterStudent, scheduledMinutes: number): number | null {
  if (student.absolutePercentAttendance !== null) return student.absolutePercentAttendance;
  if (student.inMeetingSeconds === null || scheduledMinutes <= 0) return null;
  return Math.round((student.inMeetingSeconds / (scheduledMinutes * 60)) * 100);
}

// ---------------------------------------------------------------------------
// Feedback form mapping and POST body
// ---------------------------------------------------------------------------

export interface FormPlan {
  /** Field for each form question, in Wise form order (answers are positional). */
  fieldOrder: Array<keyof FeedbackFieldAnswers>;
}

/**
 * The Wise web app posts answers positionally in form order, so every form
 * question must map to exactly one feedback field; an unmapped or ambiguous
 * question would shift every answer after it.
 */
export function planFeedbackForm(
  detail: AutowriterSessionDetail,
  mappings: readonly FeedbackFieldMapping[] = DEFAULT_FEEDBACK_FIELD_MAPPINGS,
): { ok: true; plan: FormPlan } | { ok: false; reason: string } {
  if (!detail.feedbackForm || detail.feedbackForm.enabled === false) {
    return { ok: false, reason: "feedback_form_missing_or_disabled" };
  }
  const questions = normalizeWiseFeedbackQuestions(detail.feedbackForm.questions as WiseFeedbackQuestion[]);
  if (questions.length !== detail.feedbackForm.questions.length) {
    return { ok: false, reason: "feedback_form_question_without_text" };
  }
  const mapping = resolveFeedbackFieldMapping(questions, mappings);
  if (mapping.status !== "ready" || mapping.ambiguousFields.length > 0 || mapping.unmappedQuestionIds.length > 0) {
    return { ok: false, reason: `feedback_form_mapping_${mapping.status}:${mapping.reason ?? "unmapped_questions"}` };
  }
  const fieldOrder: Array<keyof FeedbackFieldAnswers> = [];
  for (const question of questions) {
    const field = POST_CLASS_FEEDBACK_FIELDS.find((candidate) => mapping.byField[candidate] === question);
    if (!field) return { ok: false, reason: "feedback_form_question_unmapped" };
    fieldOrder.push(field);
  }
  if (new Set(fieldOrder).size !== fieldOrder.length) {
    return { ok: false, reason: "feedback_form_duplicate_field" };
  }
  return { ok: true, plan: { fieldOrder } };
}

export function buildFeedbackPostBody(
  plan: FormPlan,
  fields: FeedbackFieldAnswers,
  billing: { sessionStatus: string; creditsConsumed: number },
): WiseFeedbackPostBody {
  return {
    answers: plan.fieldOrder.map((field) => ({ answer: fields[field] ?? "" })),
    sessionStatus: billing.sessionStatus,
    creditsConsumed: billing.creditsConsumed,
  };
}

/** The fields Wise currently stores on the single teacher submission. */
export function storedTeacherFields(
  detail: AutowriterSessionDetail,
  mappings: readonly FeedbackFieldMapping[] = DEFAULT_FEEDBACK_FIELD_MAPPINGS,
): FeedbackFieldAnswers | null {
  const submissions = teacherSubmissions(detail);
  if (submissions.length !== 1 || !detail.feedbackForm) return null;
  const questions = normalizeWiseFeedbackQuestions(detail.feedbackForm.questions as WiseFeedbackQuestion[]);
  const mapping = resolveFeedbackFieldMapping(questions, mappings);
  const answers = normalizeWiseFeedbackAnswers(submissions[0].answers as WiseFeedbackAnswer[]);
  return mapAnswersToFields(answers, mapping);
}

/**
 * Answers are posted positionally, so the submission being completed must
 * already line up with the form: same number of answers, and each answer's
 * question id or text equal to the form question at that position.
 */
export function existingAnswersMatchForm(detail: AutowriterSessionDetail): boolean {
  const submissions = teacherSubmissions(detail);
  if (submissions.length !== 1 || !detail.feedbackForm) return false;
  const questions = detail.feedbackForm.questions;
  const existing = submissions[0].answers;
  if (existing.length === 0) return true;
  if (existing.length !== questions.length) return false;
  const text = (value: string | undefined) => (value ?? "").normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim();
  return existing.every((answer, index) => {
    const question = questions[index];
    const questionId = question._id ?? question.questionId;
    if (answer.questionId && questionId) return answer.questionId === questionId;
    return text(answer.questionText) !== "" && text(answer.questionText) === text(question.questionText ?? question.text ?? question.title);
  });
}

export function teacherSubmissionSnapshot(detail: AutowriterSessionDetail): {
  count: number;
  submissionId: string | null;
  sessionStatus: string | null;
  creditsConsumed: number | null;
  autoSubmitted: boolean;
} {
  const submissions = teacherSubmissions(detail);
  const first = submissions[0];
  return {
    count: submissions.length,
    submissionId: first?._id ?? null,
    sessionStatus: first?.sessionStatus ?? null,
    creditsConsumed: first?.creditsConsumed ?? null,
    autoSubmitted: first?.metadata?.autoSubmitted === true,
  };
}

// ---------------------------------------------------------------------------
// Gates — every failure leaves the session for the tutor.
// ---------------------------------------------------------------------------

export function evaluateSessionGates(
  detail: AutowriterSessionDetail,
  input: GateInput,
): GateResult {
  const teacherId = detailTeacherId(detail);
  if (!teacherId || !input.allowlist.has(teacherId)) return { ok: false, reason: "teacher_not_allowlisted" };
  if (detail.type !== "SCHEDULED") return { ok: false, reason: `session_type_${detail.type ?? "unknown"}` };
  // Second guard for in-person classes: the title, in case Wise's type disagrees (~0.5% of sessions).
  if (IN_PERSON_TITLE.test(detail.title ?? "")) return { ok: false, reason: "session_type_in_person_title" };
  if (detail.classType !== "ONE_TO_ONE") return { ok: false, reason: `class_type_${detail.classType ?? "unknown"}` };
  if (detail.meetingStatus !== "ENDED") return { ok: false, reason: `meeting_${detail.meetingStatus ?? "unknown"}` };

  const window = scheduledWindow(detail);
  if (!(window.end.getTime() < input.now.getTime())) return { ok: false, reason: "class_not_finished" };
  const deadline = calculateFeedbackDeadline(window.end);
  if (deadline.getTime() - input.now.getTime() < AUTOWRITER_DEADLINE_MARGIN_MS && input.deadlineRecoverySessionId !== detail._id) {
    return { ok: false, reason: "deadline_passed_or_too_close" };
  }

  const submission = classifyTeacherSubmission(detail);
  if (submission.kind === "human") return { ok: false, reason: submission.blank ? "human_blank_submission" : "human_submission" };
  if (submission.kind === "ambiguous") return { ok: false, reason: `submission_ambiguous:${submission.reason}` };
  if (nonTeacherBillingEvidence(detail)) return { ok: false, reason: "non_teacher_submission_with_billing" };

  const students = studentParticipants(detail);
  // A guest may yet turn out to stand in for the student once Wise has computed attendance: not final yet.
  if (accountAndGuest(students)) return { ok: false, reason: "student_count_2_guest" };
  if (students.length !== 1) return { ok: false, reason: `student_count_${students.length}` };
  // The one student must be the Wise user the session bills (the POST checks their credit): a guest join is not.
  if (!students[0].wiseUserId) return { ok: false, reason: "student_not_wise_user" };
  const attendance = studentAttendancePercent(students[0], window.minutes);
  if (attendance === null) return { ok: false, reason: "attendance_unknown" };
  // Wise may report a fractional percentage: the reason names the whole percent, rounded down (42.5 → attendance_42pct),
  // so `classifyGateReason` and the coverage table (`^attendance_\d+pct$`) see it; the threshold compares the raw value.
  if (attendance < AUTOWRITER_MIN_ATTENDANCE_PERCENT) return { ok: false, reason: `attendance_${Math.floor(attendance)}pct` };

  // The second pass writes from a transcript instead, so the summary is not required there.
  if (input.requireSummary === false) return { ok: true };
  const summary = extractAiSummary(detail);
  if (!summary) return { ok: false, reason: "no_ai_summary" };
  if ([...summary.text].length < AUTOWRITER_MIN_SUMMARY_CHARACTERS) return { ok: false, reason: "ai_summary_too_short" };
  return { ok: true };
}

/**
 * What a gate failure means for an unattended run:
 * - retry: Wise isn't ready yet (class running, summary or auto-blank not there yet);
 * - scope: not an online one-to-one class of a roster tutor — the tutor's own job, no alert;
 * - human: a person already submitted — never touched again;
 * - person: needs a human decision (absence, partial attendance, form/billing drift) — alert;
 * - expired: too close to (or past) the deadline — alert.
 * `minutesSinceEnd` below AUTOWRITER_ATTENDANCE_SETTLE_MINUTES turns "no student"
 * and "low attendance" into retries: Wise may not have computed them yet.
 */
export type GateDisposition = "retry" | "scope" | "human" | "person" | "expired";

export function classifyGateReason(reason: string, context: { minutesSinceEnd?: number } = {}): GateDisposition {
  const settling = context.minutesSinceEnd !== undefined && context.minutesSinceEnd < AUTOWRITER_ATTENDANCE_SETTLE_MINUTES;
  if (reason === "student_count_0" || reason === "student_not_wise_user" || /^attendance_\d+pct$/u.test(reason)) {
    return settling ? "retry" : "person";
  }
  // Settled and still an account plus a guest who did not stand in: a class for two, out of scope as before.
  if (reason === "student_count_2_guest") return settling ? "retry" : "scope";
  if (reason === "deadline_passed_or_too_close") return "expired";
  if (reason === "human_submission" || reason === "human_blank_submission") return "human";
  if (reason === "teacher_not_allowlisted") return "scope";
  if (reason.startsWith("session_type_") || reason.startsWith("class_type_")) return "scope";
  if (reason.startsWith("meeting_")) {
    return /^meeting_(CANCELLED|CANCELED|NO_SHOW|MISSED|DELETED)$/u.test(reason) ? "scope" : "retry";
  }
  if (reason === "class_not_finished" || reason === "attendance_unknown") return "retry";
  if (reason === "no_ai_summary" || reason === "ai_summary_too_short") return "retry";
  if (reason === "submission_none_not_enabled_in_pilot") return "retry";
  if (/^student_count_\d+$/u.test(reason)) return Number(reason.slice("student_count_".length)) >= 2 ? "scope" : "person";
  return "person";
}
