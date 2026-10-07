import { z } from "zod";
import { AtomActivitySchema, type AtomActivity, type AtomSubject } from "./types";
import { bangkokDate } from "./evidence";

export class AtomCollectionError extends Error {
  constructor(readonly code: "authentication_failed" | "response_changed" | "source_contradiction" | "collection_failed", readonly stage?: string) {
    super(code);
    this.name = "AtomCollectionError";
  }
}
/**
 * A contradiction labelled with the failed check, the activity kind and Atom's own activity id (an opaque `_digits`
 * id, never a name or a value from the payload), so a failed run says which record to look at. A count mismatch also
 * carries the question counts on both sides.
 */
function contradiction(check: string, ref: Pick<AtomActivityReference, "kind" | "id">, counts?: string): AtomCollectionError {
  return new AtomCollectionError("source_contradiction",
    `${check}:${ref.kind}:${/^_[0-9]+$/u.test(ref.id) ? ref.id : "id"}${counts ? `|${counts}` : ""}`);
}
/** Only count disagreements between Atom's two views of one record; never a student, identity or subject check. */
export function isSkippableContradiction(error: unknown): error is AtomCollectionError {
  return error instanceof AtomCollectionError && error.code === "source_contradiction" && /^list_vs_transcript_/u.test(error.stage ?? "");
}
export const ATOM_SUBJECT_IDS: Readonly<Record<number, AtomSubject>> = {
  235: "english", 236: "verbal_reasoning", 237: "maths", 238: "non_verbal_reasoning",
};
const id = z.string().regex(/^_[0-9]+$/u);
const date = z.string().datetime({ offset: true });
const nullableDate = date.nullable();
const ListTest = z.object({
  id_mock_test: id, id_student: id, name: z.string().min(1), completed: z.boolean(),
  started: nullableDate, finished: nullableDate, id_course_subject: z.number().nullable(),
  score: z.number().nullable(), totalQuestions: z.number().int().nonnegative(),
  questionsCorrect: z.number().int().nonnegative().nullable(), questionsAnswered: z.number().int().nonnegative().nullable(),
}).passthrough();
const ListPractice = z.object({
  id_practice_full: id, id_full_student: id, customPracticeName: z.string().nullable(),
  completed: z.boolean(), started: nullableDate, dateFinished: nullableDate,
  id_course_subject: z.number(), questions: z.number().int().nonnegative(),
  questionsAnswered: z.number().int().nonnegative(), tutorMode: z.boolean(),
}).passthrough();
const ListIsland = z.object({
  title: z.string().min(1), id_course_subject: z.number(), status: z.string(),
  sessions: z.array(z.object({ id_question_session: id, completed: nullableDate, started: nullableDate }).passthrough()),
}).passthrough();
export interface AtomActivityReference {
  id: string; studentId: string; name: string; subject: AtomSubject; kind: AtomActivity["kind"];
  completedAt: string; startedAt: string;
  expectedCorrect?: number | null; expectedAttempted?: number | null; expectedTotal?: number; expectedSas?: number | null;
  assisted?: boolean;
}

/** Whole lists are validated before date selection. Shape drift is never an empty successful result. */
export function parseActivityIndex(kind: AtomActivity["kind"], raw: unknown, studentId: string, dates: ReadonlySet<string>): AtomActivityReference[] {
  const inRange = (start: string | null, end: string | null) => !!start && !!end &&
    [...dates].some(day => bangkokDate(start) <= day && bangkokDate(end) >= day);
  try {
    if (kind === "test") return ListTest.array().max(20_000).parse(raw).flatMap(row => {
      if (row.id_student !== studentId) throw new AtomCollectionError("source_contradiction", "index_student:test");
      const subject = row.id_course_subject === null ? null : ATOM_SUBJECT_IDS[row.id_course_subject];
      if (!row.completed || !subject || !inRange(row.started, row.finished)) return [];
      return [{ id: row.id_mock_test, studentId, name: row.name, subject, kind, completedAt: row.finished!, startedAt: row.started!,
        expectedCorrect: row.questionsCorrect, expectedAttempted: row.questionsAnswered, expectedTotal: row.totalQuestions, expectedSas: row.score }];
    });
    if (kind === "practice") return ListPractice.array().max(20_000).parse(raw).flatMap(row => {
      if (row.id_full_student !== studentId) throw new AtomCollectionError("source_contradiction", "index_student:practice");
      const subject = ATOM_SUBJECT_IDS[row.id_course_subject];
      if (!row.completed || !subject || !inRange(row.started, row.dateFinished)) return [];
      return [{ id: row.id_practice_full, studentId, name: row.customPracticeName || "Extra practice", subject, kind,
        completedAt: row.dateFinished!, startedAt: row.started!, expectedAttempted: row.questionsAnswered,
        expectedTotal: row.questions, assisted: row.tutorMode }];
    });
    return ListIsland.array().max(20_000).parse(raw).flatMap(row => {
      const subject = ATOM_SUBJECT_IDS[row.id_course_subject];
      if (!subject || row.status !== "completed") return [];
      return row.sessions.filter(session => inRange(session.started, session.completed)).map(session => ({
        id: session.id_question_session, studentId, name: row.title, subject, kind,
        startedAt: session.started!, completedAt: session.completed!,
      }));
    });
  } catch (error) {
    if (error instanceof AtomCollectionError) throw error;
    throw new AtomCollectionError("response_changed", `index_${kind}:${error instanceof z.ZodError ? error.issues[0]?.path.join(".") : "invalid"}`);
  }
}

const Response = z.object({
  id_student: id, id_course_question: z.number().int(), id_course_subject: z.number(),
  answeredAt: date, correct: z.boolean(), noAttempt: z.boolean(), autoResponse: z.boolean(),
  tutorMode: z.boolean(), secondsTaken: z.number().finite().nonnegative(),
  id_homework: z.union([z.string(), z.number()]).nullable(),
}).passthrough();
const Transcript = z.object({
  id_question_session: id, id_student: id, name: z.string().nullable(),
  questionSessionType: z.enum(["mock_test", "practice", "learning_journey_practice_island"]),
  totalQuestions: z.number().int().nonnegative(), isScoredUsingMarks: z.literal(false),
  includesAiMarkedQuestions: z.literal(false),
  score: z.number().finite().nullable().optional(),
  subtopicScore: z.array(z.object({ title: z.string(), score: z.number().min(0).max(100) }).passthrough()).optional(),
  questions: z.array(z.object({ id_course_question: z.number().int(), responses: z.array(Response) }).passthrough()).max(2000),
}).passthrough();

export function normalizeAtomTranscript(raw: unknown, ref: AtomActivityReference): AtomActivity {
  try {
    const parsed = Transcript.parse(raw);
    if (parsed.id_student !== ref.studentId || parsed.id_question_session !== ref.id) throw contradiction("transcript_identity", ref);
    const sourceKind = { test: "mock_test", practice: "practice", exam_topic: "learning_journey_practice_island" }[ref.kind];
    if (sourceKind !== parsed.questionSessionType || parsed.questions.some(question => question.responses.some(response =>
      response.id_course_question !== question.id_course_question || response.id_student !== ref.studentId))) throw contradiction("transcript_kind_or_response", ref);
    const responses = parsed.questions.flatMap(question => question.responses.filter(response => !response.noAttempt && !response.autoResponse));
    if (responses.some(response => response.id_student !== ref.studentId || ATOM_SUBJECT_IDS[response.id_course_subject] !== ref.subject)) {
      throw contradiction("transcript_subject", ref);
    }
    // Multiple records for one question cannot silently inflate the attempted denominator.
    const answers = responses.map(response => ({
      questionId: String(response.id_course_question), answeredAt: response.answeredAt, correct: response.correct,
      seconds: response.secondsTaken, assisted: response.tutorMode || !!ref.assisted,
    }));
    const correct = answers.filter(answer => answer.correct).length;
    // Atom's list counts a skipped question as answered: on 7 Oct a practice listed 10 answered where the transcript
    // held 8 answers and 2 `noAttempt` responses (no duplicates, no automatic ones). Either count agrees with the list;
    // an answer recorded twice still contradicts it.
    const skipped = parsed.questions.flatMap(question => question.responses.filter(response => response.noAttempt && !response.autoResponse)).length;
    const mismatched = [
      ref.expectedTotal !== undefined && parsed.totalQuestions !== ref.expectedTotal ? "total" : null,
      ref.expectedCorrect != null && correct !== ref.expectedCorrect ? "correct" : null,
      ref.expectedAttempted != null && answers.length !== ref.expectedAttempted && answers.length + skipped !== ref.expectedAttempted ? "attempted" : null,
      ref.expectedSas != null && parsed.score !== ref.expectedSas ? "sas" : null,
    ].filter((field): field is string => field !== null);
    if (mismatched.length > 0) {
      // Question counts only (never SAS, an answer or a name), so the run says which side of the comparison is off: a
      // question answered twice, skipped or auto-filled answers, or a list that counts differently from the transcript.
      // `c=` is a correct-answer count; it reaches the owner's incident summary (email/LINE) like the activity id.
      const all = parsed.questions.flatMap(question => question.responses);
      const answeredQuestions = new Set(answers.map(answer => answer.questionId)).size;
      const shape = [
        `list:a=${ref.expectedAttempted ?? "-"},c=${ref.expectedCorrect ?? "-"},t=${ref.expectedTotal ?? "-"}`,
        `transcript:a=${answers.length},c=${correct},t=${parsed.totalQuestions},q=${answeredQuestions},` +
          `skip=${all.filter(response => response.noAttempt).length},auto=${all.filter(response => response.autoResponse).length}`,
      ].join("|");
      throw contradiction(`list_vs_transcript_${mismatched.join("+")}`, ref, shape);
    }
    return AtomActivitySchema.parse({
      id: ref.id, studentId: ref.studentId, kind: ref.kind, subject: ref.subject,
      name: parsed.name?.trim() || ref.name,
      sourceUrl: `https://app.atomlearning.com/tutor/transcript/${ref.id}`,
      completedAt: ref.completedAt, purpose: responses.some(response => response.id_homework !== null) ? "homework" : "unknown",
      wiseTeacherUserId: null, totalQuestions: parsed.totalQuestions, answers,
      sas: ref.kind === "test" ? parsed.score ?? null : null,
      modelledTopicEstimates: ref.kind === "test" ? (parsed.subtopicScore ?? []).map(topic => ({ topic: topic.title, percent: topic.score })) : [],
    });
  } catch (error) {
    if (error instanceof AtomCollectionError) throw error;
    throw new AtomCollectionError("response_changed", `transcript:${error instanceof z.ZodError ? error.issues[0]?.path.join(".") : "invalid"}`);
  }
}
