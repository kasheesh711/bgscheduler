import { z } from "zod";
import { postClassDeductionExemption } from "@/lib/post-class-feedback/deduction-exemption";
import { assessFeedbackContent, isPlaceholderFeedback } from "@/lib/post-class-feedback/policy";
import { assessAiSuspect, type PriorFeedbackComparison } from "@/lib/post-class-feedback/similarity";
import {
  POST_CLASS_FEEDBACK_FIELDS,
  POST_CLASS_REQUIRED_FIELDS,
  type FeedbackFieldAnswers,
} from "@/lib/post-class-feedback/types";
import { restoreStudentName } from "./prompt";
import { WISE_FEEDBACK_ANSWER_MAX_CHARACTERS } from "./types";

export const ModelOutputSchema = z.object({
  topics: z.string(),
  performance: z.string(),
  improvement: z.string(),
  homework: z.string(),
  studentAttended: z.boolean(),
  lessonHappened: z.boolean(),
}).strict();

export type ModelOutput = z.infer<typeof ModelOutputSchema>;

export function parseModelOutput(content: string): { ok: true; output: ModelOutput } | { ok: false; reason: string } {
  const unfenced = content.trim().replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "");
  let json: unknown;
  try {
    json = JSON.parse(unfenced);
  } catch {
    return { ok: false, reason: "output_not_json" };
  }
  const parsed = ModelOutputSchema.safeParse(json);
  return parsed.success ? { ok: true, output: parsed.data } : { ok: false, reason: "output_schema_mismatch" };
}

function tidy(value: string): string {
  return value.replace(/\r\n?/gu, "\n").replace(/[ \t]+\n/gu, "\n").replace(/\n{3,}/gu, "\n\n").trim();
}

/** Model placeholders → the student's name, with whitespace tidied for Wise. */
export function finalizeFields(output: ModelOutput, studentDisplayName: string): FeedbackFieldAnswers {
  const fields = {} as FeedbackFieldAnswers;
  for (const field of POST_CLASS_FEEDBACK_FIELDS) {
    fields[field] = tidy(restoreStudentName(output[field], studentDisplayName));
  }
  return fields;
}

const PLACEHOLDER_TOKEN = /\[(?:STUDENT_\d+|TUTOR)\]/u;
/**
 * Markdown the writer is told not to use: a heading, `**…**`, or `__…__` around text. A fill-in blank is plain text
 * ("quick checks such as I am ___ for adjectives"): the 30 Sep replay held a sound transcript draft over one.
 */
const MARKDOWN = /(?:^|\n)\s*#{1,6}\s|\*\*|(?<![_\p{L}\p{N}])__(?=[^\s_])[^\n]*?[^\s_]__(?![_\p{L}\p{N}])/u;

/**
 * Everything the post-class policy would object to, plus the autowriter's own
 * guards. Any reason rejects the draft; the session is left for the tutor.
 */
export function validateFeedbackDraft(input: {
  output: ModelOutput;
  fields: FeedbackFieldAnswers;
  studentFullName: string;
  tutorNames: readonly string[];
  priorFeedback: readonly PriorFeedbackComparison[];
}): { ok: true } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  const { output, fields } = input;
  if (!output.studentAttended) reasons.push("model_reports_student_not_attended");
  if (!output.lessonHappened) reasons.push("model_reports_no_lesson");

  for (const field of POST_CLASS_FEEDBACK_FIELDS) {
    const value = fields[field];
    if (PLACEHOLDER_TOKEN.test(value)) reasons.push(`placeholder_token:${field}`);
    // Feedback is English for everyone; Thai text means the model copied from a Thai summary or transcript.
    // Checked on the model's own text: the student's Wise name, restored afterwards, may itself be Thai.
    if (/[\u0e00-\u0e7f]/u.test(output[field])) reasons.push(`thai_text:${field}`);
    if ([...value].length > WISE_FEEDBACK_ANSWER_MAX_CHARACTERS) reasons.push(`too_long:${field}`);
    if (MARKDOWN.test(value)) reasons.push(`markdown:${field}`);
  }
  for (const field of POST_CLASS_REQUIRED_FIELDS) {
    if (isPlaceholderFeedback(fields[field])) reasons.push(`placeholder_text:${field}`);
  }

  const content = assessFeedbackContent(fields);
  if (!content.compliant) reasons.push(...content.violationReasons.map((reason) => `policy:${reason}`));
  if (content.failedFields.length > 0) reasons.push(...content.failureReasons.map((reason) => `field:${reason}`));

  const exemption = postClassDeductionExemption({ feedbackFields: [fields] });
  if (exemption) reasons.push(`attendance_wording:${exemption.reason}:${exemption.field ?? "?"}`);

  const suspect = assessAiSuspect(fields, {
    studentNames: [input.studentFullName],
    tutorNames: [...input.tutorNames],
    priorFeedback: [...input.priorFeedback],
  });
  if (suspect.suspect) reasons.push(...suspect.reasons.map((reason) => `ai_suspect:${reason}`));

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons: [...new Set(reasons)] };
}
