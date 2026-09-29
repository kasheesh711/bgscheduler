import { z } from "zod";
import type { FeedbackFieldAnswers } from "@/lib/post-class-feedback/types";
import { otherPeopleLine, speakerLabelNote, type EvidenceKind, type SpeakerLabels } from "./prompt";

export const JUDGE_PROMPT_VERSION = 4;

export const JUDGE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["faithful", "unsupported", "misattributed", "homeworkNotSet"],
  properties: {
    faithful: { type: "boolean", description: "True only when all three lists are empty." },
    unsupported: {
      type: "array",
      items: { type: "string" },
      description: "Short quotes of claims about this lesson that the summary does not support.",
    },
    misattributed: {
      type: "array",
      items: { type: "string" },
      description: "Short quotes of what the feedback says [STUDENT_1] did or said that the lesson record says about [TUTOR] or another person.",
    },
    homeworkNotSet: {
      type: "array",
      items: { type: "string" },
      description: "Short quotes of homework, tasks or due dates the feedback says were set that the tutor did not clearly set.",
    },
  },
} as const;

/** Strict: a verdict missing any of the three lists is unparseable, so the draft is never accepted on it (fail closed). */
export const JudgeOutputSchema = z.object({
  faithful: z.boolean(),
  unsupported: z.array(z.string()),
  misattributed: z.array(z.string()),
  homeworkNotSet: z.array(z.string()),
}).strict();

export type JudgeOutput = z.infer<typeof JudgeOutputSchema>;

/**
 * v4 (30 Sep): a judge that only looked for unsupported claims passed a draft that gave another student's words to
 * ours and a "homework" line the tutor never set, so it now lists those two kinds separately. It is still never given
 * style guides or examples: it checks facts, not tone.
 */
const judgeSystemPrompt = (evidence: EvidenceKind, labels: SpeakerLabels) => [
  evidence === "summary"
    ? "You check a tutor's post-class feedback against an automatic summary of the same lesson."
    : `You check a tutor's post-class feedback against an automatic transcript of the same lesson (it may mix Thai and English). ${speakerLabelNote(labels)}`,
  // A transcript can still hold the student's own name (Thai script, mis-heard), so only the summary gets the absolute rule.
  "The student's and the tutor's names are replaced by [STUDENT_1] and [TUTOR]; that is expected." +
    (evidence === "summary" ? " Any other name in the summary is someone else, never [STUDENT_1]." : ""),
  ...(evidence === "transcript"
    ? ["Only lines labelled STUDENT are the student's own words; anyone named in the lesson who is clearly not the student is someone else, never [STUDENT_1]."]
    : []),
  "The class details come from the school's system and are true: naming the programme, exam or subject they give is supported.",
  "List every problem of these three kinds, quoting the feedback's own words:",
  "- unsupported: a factual claim about THIS lesson — topics, what the student did or got wrong, scores, materials, dates — " +
    `that the ${evidence} does not state or clearly imply.` +
    (evidence === "transcript" ? " Claiming the student understood or solved something the transcript only shows the tutor explaining is unsupported." : ""),
  "- misattributed: something the feedback says [STUDENT_1] did, said, finished, got wrong or did not finish, " +
    `when the ${evidence} says it about [TUTOR] or about another person.`,
  "- homeworkNotSet: homework, a task or a due date the feedback says was set — everything under \"Homework and due date\", " +
    `and any such statement in another field — unless the ${evidence} clearly shows the tutor setting it for [STUDENT_1] to do after this lesson. ` +
    "Work only described as remaining, unfinished or still to complete was not set.",
  "General advice, encouragement and suggested practice (including practice before the next lesson) are fine and must not be listed, " +
    "unless they are presented as homework the tutor set.",
  "faithful is true only when all three lists are empty.",
].join("\n");

/**
 * Judge input is the REDACTED summary, the redacted class details and the
 * model's placeholder output — never the name-restored fields — so no student
 * name reaches the judge host. In summary mode it also gets the writer's line
 * naming the other people in the summary (`otherPeopleNamed`).
 */
export function buildJudgeMessages(input: {
  redactedSummary: string;
  /** Already redacted `classDetailsBlock` text (may be empty). */
  classDetails: string;
  placeholderFields: FeedbackFieldAnswers;
  evidence?: EvidenceKind;
  speakerLabels?: SpeakerLabels;
  /**
   * Summary mode: the same `otherPeopleNamed` list the writer got (required, so a caller cannot give the writer the
   * hint and the judge none); ignored for a transcript.
   */
  otherPeople: readonly string[];
}): Array<{ role: "system" | "user"; content: string }> {
  const evidence = input.evidence ?? "summary";
  const feedback = [
    `Topics covered: ${input.placeholderFields.topics}`,
    `How the student did in class: ${input.placeholderFields.performance}`,
    `Need more work on: ${input.placeholderFields.improvement}`,
    `Homework and due date: ${input.placeholderFields.homework || "(empty)"}`,
  ].join("\n");
  const people = evidence === "summary" ? otherPeopleLine(input.otherPeople) : null;
  return [
    { role: "system", content: judgeSystemPrompt(evidence, input.speakerLabels ?? "inferred") },
    {
      role: "user",
      content: `Class details (from the school's system — true):\n${input.classDetails || "- (none)"}\n\n${people ? `${people}\n\n` : ""}` +
        `${evidence === "summary" ? "Lesson summary" : "Lesson transcript"}:\n${input.redactedSummary}\n\nFeedback:\n${feedback}`,
    },
  ];
}

/** The judge's reply, or null when it is not a complete v4 verdict. */
export function parseJudgeOutput(content: string): JudgeOutput | null {
  const unfenced = content.trim().replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "");
  try {
    const parsed = JudgeOutputSchema.safeParse(JSON.parse(unfenced));
    if (!parsed.success) return null;
    // A judge that says faithful but lists problems is contradicting itself: treat as unfaithful.
    return { ...parsed.data, faithful: parsed.data.faithful && judgeProblems(parsed.data).length === 0 };
  } catch {
    return null;
  }
}

/**
 * Every problem a verdict lists, as one list for hold reasons, call records and the dashboard: unsupported claims
 * as quoted, then "wrong person: …" and "homework not set: …". A stored v3 verdict has no misattributed or
 * homeworkNotSet list: pass empty ones and its unsupported quotes come back unchanged.
 */
export function judgeProblems(verdict: Pick<JudgeOutput, "unsupported" | "misattributed" | "homeworkNotSet">): string[] {
  return [
    ...verdict.unsupported,
    ...verdict.misattributed.map((quote) => `wrong person: ${quote}`),
    ...verdict.homeworkNotSet.map((quote) => `homework not set: ${quote}`),
  ];
}
