import { z } from "zod";

export const ATOM_SCHEMA_VERSION = 1;
export const ATOM_MAX_AGE_MS = 45 * 60 * 1000;
export const AtomSubjectSchema = z.enum(["english", "maths", "verbal_reasoning", "non_verbal_reasoning", "science"]);
export type AtomSubject = z.infer<typeof AtomSubjectSchema>;
const timestamp = z.string().datetime({ offset: true });
const id = z.string().min(1).max(160);

/** This is the validated boundary, never a raw Atom response or browser state. */
export const AtomActivitySchema = z.object({
  id,
  studentId: id,
  kind: z.enum(["test", "practice", "exam_topic"]),
  name: z.string().min(1).max(300),
  subject: AtomSubjectSchema,
  sourceUrl: z.string().url().refine(url => {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "app.atomlearning.com" && !parsed.username && !parsed.password;
  }),
  completedAt: timestamp,
  purpose: z.enum(["classwork", "homework", "unknown"]),
  /** Only populated from an explicit, staff-approved tutor relationship, never a name guess. */
  wiseTeacherUserId: id.nullable(),
  totalQuestions: z.number().int().nonnegative(),
  answers: z.array(z.object({
    questionId: id,
    answeredAt: timestamp,
    correct: z.boolean(),
    seconds: z.number().finite().nonnegative().nullable(),
    assisted: z.boolean().nullable(),
  }).strict()).max(2000),
  sas: z.number().finite().nonnegative().nullable(),
  modelledTopicEstimates: z.array(z.object({
    topic: z.string().min(1).max(200),
    percent: z.number().min(0).max(100),
  }).strict()).max(200),
}).strict().superRefine((value, ctx) => {
  const ids = new Set(value.answers.map(answer => answer.questionId));
  if (ids.size !== value.answers.length || ids.size > value.totalQuestions) {
    ctx.addIssue({ code: "custom", message: "Question identities or counts conflict." });
  }
  if (value.answers.some(answer => Date.parse(answer.answeredAt) > Date.parse(value.completedAt))) {
    ctx.addIssue({ code: "custom", message: "An answer is later than completion." });
  }
});
export type AtomActivity = z.infer<typeof AtomActivitySchema>;

export interface AtomStudentLink {
  id: string;
  revision: number;
  wiseStudentId: string;
  atomStudentId: string;
  approvedBy: string;
  approvedAt: string;
  active: boolean;
}
export interface AtomSnapshot {
  id: string;
  studentId: string;
  collectedAt: string;
  activities: AtomActivity[];
  sourceHash: string;
}
export interface AtomLesson {
  sessionId: string;
  studentId: string;
  teacherId: string;
  subject: AtomSubject | null;
  start: string;
  end: string;
}
export type AtomOmissionReason =
  | "disabled" | "rollout_not_approved" | "student_unmapped" | "no_matching_activity" | "ambiguous_overlap"
  | "stale_data" | "collection_failed" | "authentication_failed" | "response_changed"
  | "subject_unresolved" | "homework" | "other_tutor" | "outside_lesson"
  | "timestamps_unavailable" | "lesson_roster_unavailable" | "wrong_student";

export interface MatchedAtomActivity {
  id: string;
  name: string;
  kind: AtomActivity["kind"];
  sourceUrl: string;
  match: "lesson_window" | "explicit_reference";
  reference: string | null;
  portion: "whole_activity" | "matched_portion";
  firstAnswerAt: string;
  lastAnswerAt: string;
  questionIds: string[];
  correctAnswers: number;
  attemptedQuestions: number;
  /** Full activity size, never the denominator of a partial activity score. */
  totalQuestions: number;
  seconds: number | null;
  assistance: "assisted" | "not_marked_assisted" | "unknown";
  sas: number | null;
  modelledTopicEstimates: AtomActivity["modelledTopicEstimates"];
}
export interface AtomLessonEvidence {
  version: 1;
  sessionId: string;
  studentId: string;
  subject: AtomSubject | null;
  lessonStart: string;
  lessonEnd: string;
  mapping: Pick<AtomStudentLink, "id" | "revision" | "wiseStudentId" | "atomStudentId"> | null;
  snapshot: { id: string; sourceHash: string; collectedAt: string } | null;
  status: "matched" | "omitted" | "contradiction";
  activities: MatchedAtomActivity[];
  omissions: { activityId: string | null; reason: AtomOmissionReason }[];
  contradictions: string[];
  hash: string;
}
/** Owner acceptance of server retrieval, without claiming a local shutdown test. */
export type AtomCloudProofReview = {
  method: "scheduled_cloud_run";
  runId: string;
  comparisonHash: string;
  approvedBy: string;
  approvedAt: string;
  note: string;
  computerOffConfirmed: false;
};
