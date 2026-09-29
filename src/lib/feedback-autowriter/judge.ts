import { z } from "zod";
import type { FeedbackFieldAnswers } from "@/lib/post-class-feedback/types";
import { speakerLabelNote, type EvidenceKind, type SpeakerLabels } from "./prompt";

export const JUDGE_PROMPT_VERSION = 3;

export const JUDGE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["faithful", "unsupported"],
  properties: {
    faithful: { type: "boolean", description: "True only when unsupported is empty." },
    unsupported: {
      type: "array",
      items: { type: "string" },
      description: "Short quotes of claims about this lesson that the summary does not support.",
    },
  },
} as const;

export const JudgeOutputSchema = z.object({
  faithful: z.boolean(),
  unsupported: z.array(z.string()),
}).strict();

export type JudgeOutput = z.infer<typeof JudgeOutputSchema>;

const judgeSystemPrompt = (evidence: EvidenceKind, labels: SpeakerLabels) => [
  evidence === "summary"
    ? "You check a tutor's post-class feedback against an automatic summary of the same lesson."
    : `You check a tutor's post-class feedback against an automatic transcript of the same lesson (it may mix Thai and English). ${speakerLabelNote(labels)}`,
  "List every factual claim about THIS lesson in the feedback — topics, what the student did or got wrong, scores,",
  `materials, homework, dates — that the ${evidence} does not state or clearly imply.`,
  ...(evidence === "transcript"
    ? ["Claiming the student understood or solved something the transcript only shows the tutor explaining is unsupported."]
    : []),
  "General advice, encouragement and suggested practice are fine and must not be listed.",
  "The class details come from the school's system and are true: naming the programme, exam or subject they give is supported.",
  `Every other claim about this lesson must be supported by the ${evidence}.`,
  "Names are replaced by [STUDENT_1] and [TUTOR]; that is expected.",
  "faithful is true only when the list is empty.",
].join("\n");

/**
 * Judge input is the REDACTED summary, the redacted class details and the
 * model's placeholder output — never the name-restored fields — so no student
 * name reaches the judge host.
 */
export function buildJudgeMessages(input: {
  redactedSummary: string;
  /** Already redacted `classDetailsBlock` text (may be empty). */
  classDetails: string;
  placeholderFields: FeedbackFieldAnswers;
  evidence?: EvidenceKind;
  speakerLabels?: SpeakerLabels;
}): Array<{ role: "system" | "user"; content: string }> {
  const evidence = input.evidence ?? "summary";
  const feedback = [
    `Topics covered: ${input.placeholderFields.topics}`,
    `How the student did in class: ${input.placeholderFields.performance}`,
    `Need more work on: ${input.placeholderFields.improvement}`,
    `Homework and due date: ${input.placeholderFields.homework || "(empty)"}`,
  ].join("\n");
  return [
    { role: "system", content: judgeSystemPrompt(evidence, input.speakerLabels ?? "verified") },
    {
      role: "user",
      content: `Class details (from the school's system — true):\n${input.classDetails || "- (none)"}\n\n` +
        `${evidence === "summary" ? "Lesson summary" : "Lesson transcript"}:\n${input.redactedSummary}\n\nFeedback:\n${feedback}`,
    },
  ];
}

export function parseJudgeOutput(content: string): JudgeOutput | null {
  const unfenced = content.trim().replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "");
  try {
    const parsed = JudgeOutputSchema.safeParse(JSON.parse(unfenced));
    if (!parsed.success) return null;
    // A judge that says faithful but lists claims is contradicting itself: treat as unfaithful.
    return { faithful: parsed.data.faithful && parsed.data.unsupported.length === 0, unsupported: parsed.data.unsupported };
  } catch {
    return null;
  }
}
