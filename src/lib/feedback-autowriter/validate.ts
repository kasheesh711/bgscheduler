import { validateIsebFormat, type FeedbackFormatGuide } from "./format";
import { z } from "zod";
import { postClassDeductionExemption } from "@/lib/post-class-feedback/deduction-exemption";
import { assessFeedbackContent, isPlaceholderFeedback } from "@/lib/post-class-feedback/policy";
import { assessAiSuspect, type PriorFeedbackComparison } from "@/lib/post-class-feedback/similarity";
import {
  POST_CLASS_FEEDBACK_FIELDS,
  POST_CLASS_REQUIRED_FIELDS,
  type FeedbackFieldAnswers,
} from "@/lib/post-class-feedback/types";
import { validateStyleFormat, type FeedbackStyleGuide } from "./style";
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

/** Whitespace as every draft posts it: `\n` line ends, no trailing blanks, at most one empty line, trimmed. */
export function tidyFeedbackText(value: string): string {
  return value.replace(/\r\n?/gu, "\n").replace(/[ \t]+\n/gu, "\n").replace(/\n{3,}/gu, "\n\n").trim();
}

/** Model placeholders → the student's name, with whitespace tidied for Wise. */
export function finalizeFields(output: ModelOutput, studentDisplayName: string): FeedbackFieldAnswers {
  const fields = {} as FeedbackFieldAnswers;
  for (const field of POST_CLASS_FEEDBACK_FIELDS) {
    fields[field] = tidyFeedbackText(restoreStudentName(output[field], studentDisplayName));
  }
  return fields;
}

const PLACEHOLDER_TOKEN = /\[(?:STUDENT_\d+|TUTOR)\]/u;
/**
 * Markdown the writer is told not to use: a heading, `**…**`, or `__…__` / `___…___` around text. A fill-in blank is
 * plain text ("quick checks such as I am ___ for adjectives"): the 30 Sep replay held a sound transcript draft over one.
 */
const MARKDOWN = /(?:^|\n)\s*#{1,6}\s|\*\*|(?<![_\p{L}\p{N}])_{2,3}(?=[^\s_])[\s\S]*?[^\s_]_{2,3}(?![_\p{L}\p{N}])/u;

/**
 * The checks of a feedback text that need nothing but the text, shared by `validateFeedbackDraft` and the agent
 * correction (`correctionTextProblems`), in two groups (a draft's style and format checks sit between them):
 * - `form`: a leftover placeholder token (`[STUDENT_1]`, `[TUTOR]`), Thai text (feedback is English for everyone:
 *   Thai means text copied from a Thai summary or transcript), Wise's answer limit, markdown, and a required field
 *   that is placeholder text;
 * - `content`: Class Feedback's content bar (`policy:*`, `field:*`), and wording that makes the class exempt from
 *   deduction (`attendance_wording:*`: an absent student or a cancelled class makes Class Feedback mark the session
 *   ineligible).
 * `thaiSource` is the text the Thai check reads (default: `fields`): a draft passes the model's own text, because the
 * student's Wise name, restored afterwards, may itself be Thai. `styleGuide` reports markdown as the style guide's
 * `style:prohibited_format:<field>` rather than `markdown:<field>`.
 */
export function feedbackTextChecks(fields: FeedbackFieldAnswers, options: {
  thaiSource?: FeedbackFieldAnswers;
  styleGuide?: boolean;
} = {}): { form: string[]; content: string[] } {
  const thaiSource = options.thaiSource ?? fields;
  const form: string[] = [];
  for (const field of POST_CLASS_FEEDBACK_FIELDS) {
    const value = fields[field];
    if (PLACEHOLDER_TOKEN.test(value)) form.push(`placeholder_token:${field}`);
    if (/[\u0e00-\u0e7f]/u.test(thaiSource[field])) form.push(`thai_text:${field}`);
    if ([...value].length > WISE_FEEDBACK_ANSWER_MAX_CHARACTERS) form.push(`too_long:${field}`);
    if (MARKDOWN.test(value)) form.push(options.styleGuide ? `style:prohibited_format:${field}` : `markdown:${field}`);
  }
  for (const field of POST_CLASS_REQUIRED_FIELDS) {
    if (isPlaceholderFeedback(fields[field])) form.push(`placeholder_text:${field}`);
  }

  const content: string[] = [];
  const assessed = assessFeedbackContent(fields);
  if (!assessed.compliant) content.push(...assessed.violationReasons.map((reason) => `policy:${reason}`));
  if (assessed.failedFields.length > 0) content.push(...assessed.failureReasons.map((reason) => `field:${reason}`));
  const exemption = postClassDeductionExemption({ feedbackFields: [fields] });
  if (exemption) content.push(`attendance_wording:${exemption.reason}:${exemption.field ?? "?"}`);
  return { form, content };
}

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
  styleGuide?: FeedbackStyleGuide | null;
  formatGuide?: FeedbackFormatGuide | null;
  lessonRecord?: string;
}): { ok: true } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  const { output, fields } = input;
  if (!output.studentAttended) reasons.push("model_reports_student_not_attended");
  if (!output.lessonHappened) reasons.push("model_reports_no_lesson");

  // Thai is checked on the model's own text: the student's Wise name, restored afterwards, may itself be Thai.
  const text = feedbackTextChecks(fields, { thaiSource: output, styleGuide: Boolean(input.styleGuide) });
  reasons.push(...text.form);
  if (input.formatGuide) reasons.push(...validateIsebFormat(fields));
  if (input.styleGuide || input.formatGuide) reasons.push(...validateStyleFormat(fields, input.lessonRecord ?? ""));
  reasons.push(...text.content);

  const suspect = assessAiSuspect(fields, {
    studentNames: [input.studentFullName],
    tutorNames: [...input.tutorNames],
    priorFeedback: [...input.priorFeedback],
  });
  // Mimi's approved format has short numbered fields. Only this presentation heuristic is replaced
  // by the guide's structural checks; placeholders, padding and copy detection still reject the draft.
  if (suspect.suspect) reasons.push(...suspect.reasons
    .filter((reason) => !((input.styleGuide || input.formatGuide) && reason === "short_required_field"))
    .map((reason) => `ai_suspect:${reason}`));

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons: [...new Set(reasons)] };
}
