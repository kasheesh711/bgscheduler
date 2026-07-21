import { createHash } from "node:crypto";
import type {
  WiseFeedbackAnswer,
  WiseFeedbackQuestion,
  WiseFeedbackSubmission,
  WiseSession,
  WiseSessionDetail,
  WiseUserReference,
} from "@/lib/wise/types";
import { getWiseSessionClassId, getWiseSessionClassName } from "@/lib/wise/types";
import type {
  FeedbackEventEvidence,
  FeedbackFieldAnswers,
  FeedbackFieldMapping,
  FeedbackProvenance,
  FeedbackVersion,
  ParsedPostClassSession,
  PostClassFeedbackField,
  PostClassParticipant,
  ResolvedFeedbackFieldMapping,
  WiseFeedbackAnswerInput,
  WiseFeedbackQuestionInput,
} from "./types";
import { POST_CLASS_FEEDBACK_FIELDS, POST_CLASS_REQUIRED_FIELDS } from "./types";

/** A response-shape change that may affect every Wise session in the run. */
export class PostClassWiseSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostClassWiseSchemaError";
  }
}

/** Bad or incomplete evidence isolated to one otherwise valid Wise session. */
export class PostClassSessionDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostClassSessionDataError";
  }
}

export const DEFAULT_FEEDBACK_FIELD_MAPPINGS: readonly FeedbackFieldMapping[] = [
  { field: "topics", questionText: "Topics covered" },
  { field: "performance", questionText: "How the student did in class" },
  { field: "improvement", questionText: "Need more work on" },
  { field: "homework", questionText: "Homework and due date" },
] as const;

const EMPTY_FIELDS: FeedbackFieldAnswers = {
  topics: "",
  performance: "",
  improvement: "",
  homework: "",
};

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function exactStringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value
      .map(exactStringValue)
      .filter((item) => item.length > 0)
      .join("\n");
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["text", "value", "label", "answer"] as const) {
      if (key in record) {
        const projected = exactStringValue(record[key]);
        if (projected) return projected;
      }
    }
    return JSON.stringify(value);
  }
  return "";
}

function canonicalJsonValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalJsonValue(nested)]),
    );
  }
  return value === undefined ? null : String(value);
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function booleanValue(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.trim().toLowerCase() === "true") return true;
    if (value.trim().toLowerCase() === "false") return false;
  }
  return null;
}

function combinedBooleanFlags(values: unknown[]): boolean | null {
  const flags = values
    .map(booleanValue)
    .filter((value): value is boolean => value !== null);
  if (flags.some(Boolean)) return true;
  return flags.length > 0 ? false : null;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function assertOptionalArray(value: unknown, label: string): void {
  if (value !== undefined && value !== null && !Array.isArray(value)) {
    throw new PostClassWiseSchemaError(`Wise session detail ${label} was not an array.`);
  }
}

function validDate(value: unknown): Date | null {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function normalizeQuestionText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim();
}

export function normalizeWiseFeedbackQuestions(
  questions: WiseFeedbackQuestion[] | undefined,
): WiseFeedbackQuestionInput[] {
  return (questions ?? []).flatMap((question) => {
    const text = stringValue(question.questionText) ??
      stringValue(question.text) ??
      stringValue(question.title);
    if (!text) return [];
    return [{
      id: stringValue(question._id) ?? stringValue(question.questionId),
      text,
      type: stringValue(question.type),
      required: typeof question.required === "boolean" ? question.required : null,
    }];
  });
}

export function resolveFeedbackFieldMapping(
  questions: WiseFeedbackQuestionInput[],
  configuredMappings: readonly FeedbackFieldMapping[] = DEFAULT_FEEDBACK_FIELD_MAPPINGS,
): ResolvedFeedbackFieldMapping {
  const byField: Partial<Record<PostClassFeedbackField, WiseFeedbackQuestionInput>> = {};
  const ambiguousFields: PostClassFeedbackField[] = [];
  const usedQuestionIndexes = new Map<number, PostClassFeedbackField[]>();

  for (const field of POST_CLASS_FEEDBACK_FIELDS) {
    const rules = configuredMappings.filter((mapping) => mapping.field === field);
    const matches = questions
      .map((question, index) => ({ question, index }))
      .filter(({ question }) => rules.some((rule) => {
        if (rule.questionId && question.id === rule.questionId) return true;
        return Boolean(
          rule.questionText &&
          normalizeQuestionText(question.text) === normalizeQuestionText(rule.questionText),
        );
      }));
    if (matches.length === 1) {
      byField[field] = matches[0].question;
      const owners = usedQuestionIndexes.get(matches[0].index) ?? [];
      owners.push(field);
      usedQuestionIndexes.set(matches[0].index, owners);
    } else if (matches.length > 1) {
      ambiguousFields.push(field);
    }
  }

  for (const owners of usedQuestionIndexes.values()) {
    if (owners.length <= 1) continue;
    for (const owner of owners) {
      if (!ambiguousFields.includes(owner)) ambiguousFields.push(owner);
      delete byField[owner];
    }
  }

  const missingRequiredFields = POST_CLASS_REQUIRED_FIELDS.filter((field) => !byField[field]);
  const blockingAmbiguities = ambiguousFields.filter((field) =>
    POST_CLASS_REQUIRED_FIELDS.includes(field as (typeof POST_CLASS_REQUIRED_FIELDS)[number]));
  const usedIds = new Set(Object.values(byField).map((question) => question?.id).filter(Boolean));
  const unmappedQuestionIds = questions
    .filter((question) => !question.id || !usedIds.has(question.id))
    .map((question) => question.id ?? `text:${normalizeQuestionText(question.text)}`);
  const status = missingRequiredFields.length > 0 || blockingAmbiguities.length > 0
    ? "form_drift"
    : "ready";
  const reasons: string[] = [];
  if (missingRequiredFields.length > 0) {
    reasons.push(`missing required mapping: ${missingRequiredFields.join(", ")}`);
  }
  if (blockingAmbiguities.length > 0) {
    reasons.push(`ambiguous required mapping: ${blockingAmbiguities.join(", ")}`);
  }

  return {
    status,
    byField,
    missingRequiredFields,
    ambiguousFields,
    unmappedQuestionIds,
    reason: reasons.length > 0 ? reasons.join("; ") : null,
  };
}

export function normalizeWiseFeedbackAnswers(
  answers: WiseFeedbackAnswer[] | undefined,
): WiseFeedbackAnswerInput[] {
  return (answers ?? []).map((answer) => ({
    id: stringValue(answer._id),
    questionId: stringValue(answer.questionId),
    questionText: stringValue(answer.questionText),
    type: stringValue(answer.type),
    answer: exactStringValue(answer.answer),
    rawAnswer: answer.answer ?? null,
  }));
}

export function mapAnswersToFields(
  answers: WiseFeedbackAnswerInput[],
  mapping: ResolvedFeedbackFieldMapping,
): FeedbackFieldAnswers {
  const fields = { ...EMPTY_FIELDS };
  for (const field of POST_CLASS_FEEDBACK_FIELDS) {
    const question = mapping.byField[field];
    if (!question) continue;
    const normalizedQuestion = normalizeQuestionText(question.text);
    const matches = answers.filter((answer) =>
      Boolean(question.id && answer.questionId === question.id) ||
      Boolean(answer.questionText && normalizeQuestionText(answer.questionText) === normalizedQuestion));
    if (matches.length > 0) fields[field] = matches.at(-1)?.answer ?? "";
  }
  return fields;
}

export function hashFeedbackAnswers(answers: WiseFeedbackAnswerInput[]): string {
  const canonical = answers
    .map((answer) => ({
      questionId: answer.questionId ?? null,
      questionText: answer.questionText ?? null,
      type: answer.type ?? null,
      rawAnswer: canonicalJsonValue(
        Object.prototype.hasOwnProperty.call(answer, "rawAnswer")
          ? answer.rawAnswer
          : answer.answer,
      ),
    }))
    // Wise does not promise answer-array ordering. A transport-only reorder is
    // not a new content version.
    .toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

function eventForSubmission(
  submission: WiseFeedbackSubmission,
  events: FeedbackEventEvidence[],
): FeedbackEventEvidence | null {
  const submissionId = stringValue(submission._id);
  const sourceTimestamp = validDate(submission.updatedAt) ?? validDate(submission.createdAt);
  const direct = submissionId
    ? events.filter((event) => event.submissionId === submissionId)
    : [];
  if (direct.length > 0 && sourceTimestamp) {
    const byDistance = direct
      .map((event) => ({
        event,
        distance: Math.abs(event.eventTimestamp.getTime() - sourceTimestamp.getTime()),
      }))
      .filter(({ distance }) => distance <= 5 * 60 * 1000)
      .sort((left, right) => left.distance - right.distance);
    if (byDistance.length === 1 || (
      byDistance.length > 1 && byDistance[0].distance < byDistance[1].distance
    )) {
      return byDistance[0].event;
    }
    return null;
  }
  if (direct.length > 0) return null;
  if (events.length !== 1) return null;
  if (!sourceTimestamp) return null;
  return Math.abs(events[0].eventTimestamp.getTime() - sourceTimestamp.getTime()) <= 5 * 60 * 1000
    ? events[0]
    : null;
}

function provenanceFromEvent(event: FeedbackEventEvidence | null): FeedbackProvenance {
  if (!event || typeof event.autoSubmitted !== "boolean") return "unknown";
  return event.autoSubmitted ? "auto" : "manual";
}

function normalizeFeedbackVersion(
  submission: WiseFeedbackSubmission,
  mapping: ResolvedFeedbackFieldMapping,
  observedAt: Date,
  events: FeedbackEventEvidence[],
): FeedbackVersion {
  const answers = normalizeWiseFeedbackAnswers(submission.answers);
  // A mutable Wise submission can retain its original creation time after a
  // tutor edits it. Prefer the source's update timestamp for this exact
  // content version so a late edit can never inherit an earlier on-time date.
  const updatedAt = validDate(submission.updatedAt);
  const createdAt = validDate(submission.createdAt);
  const sourceCreatedAt = updatedAt ?? createdAt;
  const event = eventForSubmission(submission, events);
  const userRef = submission.userId;
  const actorWiseUserId = typeof userRef === "string"
    ? userRef
    : stringValue(userRef?._id) ?? event?.actorWiseUserId ?? null;
  const actorName = typeof userRef === "string"
    ? event?.actorName ?? null
    : stringValue(userRef?.name) ?? event?.actorName ?? null;
  return {
    submissionId: stringValue(submission._id),
    profile: stringValue(submission.profile),
    answers,
    fields: mapAnswersToFields(answers, mapping),
    contentHash: hashFeedbackAnswers(answers),
    sourceCreatedAt,
    // Wise submissions can mutate in place. `createdAt` alone cannot prove
    // when the currently observed content existed; only the version's
    // explicit `updatedAt` is treated as trustworthy timing evidence.
    sourceTimestampTrustworthy: updatedAt !== null,
    sourceTimestampKind: updatedAt ? "updated" : createdAt ? "created" : "unknown",
    observedAt,
    actorWiseUserId,
    actorName,
    provenance: provenanceFromEvent(event),
  };
}

function participantFromUnknown(value: string | WiseUserReference): PostClassParticipant | null {
  if (typeof value === "string") {
    return value.trim() ? { wiseStudentId: value, studentName: null } : null;
  }
  const id = stringValue(value._id);
  return id ? { wiseStudentId: id, studentName: stringValue(value.name) } : null;
}

function uniqueParticipants(values: Array<string | WiseUserReference>): PostClassParticipant[] {
  const byId = new Map<string, PostClassParticipant>();
  for (const value of values) {
    const participant = participantFromUnknown(value);
    if (participant) byId.set(participant.wiseStudentId, participant);
  }
  return [...byId.values()];
}

function maxCredits(submissions: WiseFeedbackSubmission[], detail: WiseSessionDetail): number | null {
  const values = [
    finiteNumber(detail.creditsConsumed),
    ...submissions.map((submission) => finiteNumber(submission.creditsConsumed)),
  ].filter((value): value is number => value !== null);
  return values.length > 0 ? Math.max(...values) : null;
}

export function parseWisePostClassSession(input: {
  candidateSession: WiseSession | null;
  detail: WiseSessionDetail;
  classId: string;
  sessionId: string;
  observedAt: Date;
  mappings?: readonly FeedbackFieldMapping[];
  events?: FeedbackEventEvidence[];
}): ParsedPostClassSession {
  const { candidateSession, detail } = input;
  const detailRecord = detail as Record<string, unknown>;
  const candidateRecord = candidateSession as Record<string, unknown> | null;
  const detailClass = objectRecord(detail.classId);
  const candidateClass = objectRecord(candidateSession?.classId);
  const feedbackForm = objectRecord(detail.feedbackForm);
  if (
    detailRecord.feedbackForm !== undefined &&
    detailRecord.feedbackForm !== null &&
    Object.keys(feedbackForm).length === 0 &&
    (typeof detailRecord.feedbackForm !== "object" || Array.isArray(detailRecord.feedbackForm))
  ) {
    throw new PostClassWiseSchemaError("Wise session detail feedbackForm was not an object.");
  }
  assertOptionalArray(feedbackForm.questions, "feedbackForm.questions");
  assertOptionalArray(detailRecord.feedbackSubmissions, "feedbackSubmissions");
  assertOptionalArray(detailRecord.students, "students");
  assertOptionalArray(detailRecord.participants, "participants");
  assertOptionalArray(candidateRecord?.students, "candidate students");
  assertOptionalArray(candidateRecord?.participants, "candidate participants");
  const questions = normalizeWiseFeedbackQuestions(detail.feedbackForm?.questions);
  const mapping = resolveFeedbackFieldMapping(
    questions,
    input.mappings ?? DEFAULT_FEEDBACK_FIELD_MAPPINGS,
  );
  const submissions = detail.feedbackSubmissions ?? [];
  const teacherSubmissions = submissions.filter((submission) =>
    stringValue(submission.profile)?.toLocaleLowerCase("en-US") === "teacher");
  const feedbackVersions = teacherSubmissions.map((submission) =>
    normalizeFeedbackVersion(submission, mapping, input.observedAt, input.events ?? []));
  const scheduledStartAt = validDate(detail.scheduledStartTime) ??
    validDate(candidateSession?.scheduledStartTime);
  const scheduledEndAt = validDate(detail.scheduledEndTime) ??
    validDate(candidateSession?.scheduledEndTime);
  if (!scheduledStartAt || !scheduledEndAt) {
    throw new PostClassSessionDataError(
      `Wise session ${input.sessionId} is missing valid scheduled times.`,
    );
  }

  const submissionSessionStatuses = submissions
    .map((submission) => stringValue(submission.sessionStatus))
    .filter((value): value is string => Boolean(value));
  const submissionRecords = submissions.map((submission) => submission as Record<string, unknown>);
  const participantsAuthoritative = Array.isArray(detailRecord.students) ||
    Array.isArray(detailRecord.participants);
  const complimentaryOrTrial = combinedBooleanFlags([
    detailRecord.isComplimentary,
    detailRecord.complimentary,
    detailRecord.isTrial,
    detailRecord.trial,
    detailClass.isComplimentary,
    detailClass.complimentary,
    detailClass.isTrial,
    detailClass.trial,
    candidateRecord?.isComplimentary,
    candidateRecord?.complimentary,
    candidateRecord?.isTrial,
    candidateRecord?.trial,
    candidateClass.isComplimentary,
    candidateClass.complimentary,
    candidateClass.isTrial,
    candidateClass.trial,
    ...submissionRecords.flatMap((submission) => [
      submission.isComplimentary,
      submission.complimentary,
      submission.isTrial,
      submission.trial,
    ]),
  ]);

  return {
    sessionId: stringValue(detail._id) ?? input.sessionId,
    classId: getWiseSessionClassId(detail) ??
      (candidateSession ? getWiseSessionClassId(candidateSession) : undefined) ??
      input.classId,
    className: getWiseSessionClassName(detail) ??
      (candidateSession ? getWiseSessionClassName(candidateSession) : undefined) ??
      null,
    scheduledStartAt,
    scheduledEndAt,
    meetingStatus: stringValue(detail.meetingStatus) ??
      stringValue(candidateSession?.meetingStatus),
    classType: stringValue(detailClass.classType) ??
      stringValue(detailRecord.classType) ??
      stringValue(candidateClass.classType) ??
      stringValue(candidateRecord?.classType),
    sessionType: stringValue(detail.type) ?? stringValue(candidateSession?.type),
    attendanceStatus: stringValue(detailRecord.attendanceStatus) ??
      stringValue(detailRecord.studentAttendanceStatus) ??
      stringValue(candidateRecord?.attendanceStatus),
    submissionSessionStatuses,
    complimentaryOrTrial,
    creditsConsumed: maxCredits(submissions, detail),
    participants: uniqueParticipants(
      participantsAuthoritative
        ? [...(detail.students ?? []), ...(detail.participants ?? [])]
        : [...(candidateSession?.students ?? []), ...(candidateSession?.participants ?? [])],
    ),
    participantsAuthoritative,
    questions,
    mapping,
    feedbackVersions,
  };
}
