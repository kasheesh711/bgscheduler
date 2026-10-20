import { ATOM_MODEL_RULES } from "./atom/evidence";
import { z } from "zod";
import type { FeedbackFieldAnswers } from "@/lib/post-class-feedback/types";
import { AUTOWRITER_JUDGE_EFFORTS } from "./config";
import { otherPeopleLine, speakerLabelNote, type EvidenceKind, type SpeakerLabels } from "./prompt";

/**
 * v7: check missing homework, attribution and subject accuracy. Run at every effort in
 * `AUTOWRITER_JUDGE_EFFORTS` on
 * byte-identical messages; a draft passes only when every level passes it. Stored drafts and call records carry this
 * number, so a draft judged at one level (v4 and before) is never reused as if both had passed it.
 */
export const JUDGE_PROMPT_VERSION = 7;

export type JudgeEffort = (typeof AUTOWRITER_JUDGE_EFFORTS)[number];

export const JUDGE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["faithful", "unsupported", "misattributed", "homeworkNotSet", "missingHomework"],
  properties: {
    faithful: { type: "boolean", description: "True only when all four lists are empty." },
    unsupported: {
      type: "array",
      items: { type: "string" },
      description: "Short quotes of claims about this lesson that the lesson record does not support.",
    },
    misattributed: {
      type: "array",
      items: { type: "string" },
      description: "Short quotes of what the feedback says [STUDENT_1] did or said that the lesson record says about [TUTOR] or another person.",
    },
    missingHomework: {
      type: "array",
      items: { type: "string" },
      description: "Short quotes of explicit final homework instructions missing from, or materially reduced in, the homework field. Quote the lesson record, not the draft.",
    },
    homeworkNotSet: {
      type: "array",
      items: { type: "string" },
      description: "Short quotes of homework, tasks or due dates the feedback says were set that the tutor did not clearly set.",
    },
  },
} as const;

/** Strict: a verdict missing any of the four lists is unparseable, so the draft is never accepted on it (fail closed). */
export const JudgeOutputSchema = z.object({
  faithful: z.boolean(),
  unsupported: z.array(z.string()),
  misattributed: z.array(z.string()),
  homeworkNotSet: z.array(z.string()),
  missingHomework: z.array(z.string()),
}).strict();

export type JudgeOutput = z.infer<typeof JudgeOutputSchema>;

/**
 * The verdict stored with a draft since v5 (`metadata.judge`): every level's complete v4 verdict as returned
 * (`levels`), and at the top level their union — what hold reasons and the dashboard read, as they read a single
 * v4 verdict. Strict: a single-judge verdict (no `levels`) does not parse.
 */
export const StoredJudgeVerdictSchema = JudgeOutputSchema.extend({
  levels: z.object({ medium: JudgeOutputSchema, high: JudgeOutputSchema }).strict(),
}).strict();

export type StoredJudgeVerdict = z.infer<typeof StoredJudgeVerdictSchema>;

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
  "List every problem of these four kinds. Quote the feedback except for missingHomework, where you quote the lesson instruction:",
  "- unsupported: a factual claim about THIS lesson — topics, what the student did or got wrong, scores, materials, dates — " +
    `that the ${evidence} does not state or clearly imply.` +
    (evidence === "transcript" ? " Claiming the student understood or solved something the transcript only shows the tutor explaining is unsupported." : ""),
  "- misattributed: something the feedback says [STUDENT_1] did, said, finished, got wrong or did not finish, " +
    `when the ${evidence} says it about [TUTOR] or about another person.`,
  "- homeworkNotSet: homework, a task or a due date the feedback says was set — everything under \"Homework and due date\", " +
    `and any such statement in another field — unless the ${evidence} clearly shows the tutor setting it for [STUDENT_1] to do after this lesson. ` +
    "Work only described as remaining, unfinished or still to complete was not set. " +
    "Check the tutor's later instructions for changed question ranges, time limits and optional work. " +
    "A timed attempt does not require completing every question, and optional extension questions must not become required." +
    // Owner decision (30 Sep): Wise's "Next steps: …" line (`extractAiSummary`) is the summary's advice, not the tutor's.
    (evidence === "summary" ? " A \"Next steps\" line in the summary is the summary's own suggestion, not homework the tutor set." : ""),
  "- missingHomework: read the whole lesson, especially its closing instructions. List each explicit final assignment omitted from the homework field, " +
    "including a task left only in improvement, or a missing material question range, target or required frequency. Use the tutor's last version. " +
    "Do not require optional practice, conditional punishments, unassigned unfinished work or automatic summary recommendations. Quote the assignment in the lesson record.",
  "Check attribution at the level of each step: a student naming an operation does not establish that they supplied its result. " +
    "A tutor's answer, prompt, correction or explanation, or a student's yes or repetition after it, does not prove independent student work. " +
    "Apply this to summaries too; do not turn ambiguous attribution into a claim of student mastery.",
  "Check scientific terms, calculations and final results for correctness as well as source support. Recompute numerical results, " +
    "including sample spaces and units. A wrong statement remains wrong when the tutor said it: list it in unsupported. " +
    "For an unclear transcription of a term, paper or title, reject invented specificity; generic supported wording is safer. " +
    "Do not reject clearly labelled incorrect student answers or an explicit correction of the tutor's error.",
  "General advice, encouragement and suggested practice (including practice before the next lesson) are fine and must not be listed, " +
    "unless they are presented as homework the tutor set.",
  "faithful is true only when all four lists are empty.",
].join("\n");

/**
 * Judge input is the REDACTED summary, the redacted class details and the
 * model's placeholder output — never the name-restored fields — so no student
 * name reaches the judge host. In summary mode it also gets the writer's line
 * naming the other people in the summary (`otherPeopleNamed`).
 */
export function buildJudgeMessages(input: {
  redactedSummary: string;
  atomEvidence?: string;
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
    { role: "system", content: judgeSystemPrompt(evidence, input.speakerLabels ?? "inferred") + (input.atomEvidence ? "\n" + ATOM_MODEL_RULES + "\nWhen the sources explicitly contradict each other, add SOURCE_CONTRADICTION: followed by the conflicting claims to unsupported, even if the draft omits the conflict. Do not judge style or formatting." : "") },
    {
      role: "user",
      content: `Class details (from the school's system — true):\n${input.classDetails || "- (none)"}\n\n${people ? `${people}\n\n` : ""}` +
        `${evidence === "summary" ? "Lesson summary" : "Lesson transcript"}:\n${input.redactedSummary}${input.atomEvidence ? `\n\nFrozen Atom lesson evidence:\n${input.atomEvidence}` : ""}\n\nFeedback:\n${feedback}`,
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
 * Every problem a verdict lists, as one list for hold reasons, call records and the dashboard: "wrong person: …"
 * first, then "homework not set: …", then the unsupported claims as quoted — so a hold reason cut to its first
 * three problems (pipeline.ts) or an alert cut to 200 characters (alerts.ts) never hides the two v4 kinds behind
 * unsupported claims. A stored v3 verdict has no misattributed or homeworkNotSet list: pass empty ones and its
 * unsupported quotes come back unchanged.
 */
export function judgeProblems(verdict: Pick<JudgeOutput, "unsupported" | "misattributed" | "homeworkNotSet"> & Partial<Pick<JudgeOutput, "missingHomework">>): string[] {
  return [
    ...verdict.misattributed.map((quote) => `wrong person: ${quote}`),
    ...verdict.homeworkNotSet.map((quote) => `homework not set: ${quote}`),
    ...(verdict.missingHomework ?? []).map((quote) => `homework missing: ${quote}`),
    ...verdict.unsupported,
  ];
}

/**
 * v5: one verdict from every level's. Each list is the union of the levels' lists in effort order, without repeats
 * (quotes that differ only in surrounding or repeated whitespace are one); `faithful` only when every level said so
 * and the union is empty.
 */
export function combineJudgeVerdicts(levels: Record<JudgeEffort, JudgeOutput>): StoredJudgeVerdict {
  const union = (list: (verdict: JudgeOutput) => string[]) => {
    const seen = new Set<string>();
    return AUTOWRITER_JUDGE_EFFORTS.flatMap((effort) => list(levels[effort])).filter((quote) => {
      const key = quote.trim().replace(/\s+/gu, " ");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const lists = {
    unsupported: union((verdict) => verdict.unsupported),
    misattributed: union((verdict) => verdict.misattributed),
    homeworkNotSet: union((verdict) => verdict.homeworkNotSet),
    missingHomework: union((verdict) => verdict.missingHomework),
  };
  return {
    faithful: AUTOWRITER_JUDGE_EFFORTS.every((effort) => levels[effort].faithful) && judgeProblems(lists).length === 0,
    ...lists,
    levels: { medium: levels.medium, high: levels.high },
  };
}

/**
 * A stored verdict that passed its draft at every level, or null — fail closed: a single-judge verdict (v4 and
 * before, no `levels`), an incomplete one, or one that lists any problem at any level. The one test a stored draft
 * must pass before it is reused (with the version stamps; `requeueShadowDrafts` in store.ts applies the same test).
 */
export function passingStoredVerdict(value: unknown): StoredJudgeVerdict | null {
  const parsed = StoredJudgeVerdictSchema.safeParse(value);
  if (!parsed.success) return null;
  const verdicts = [parsed.data, ...AUTOWRITER_JUDGE_EFFORTS.map((effort) => parsed.data.levels[effort])];
  return verdicts.every((verdict) => verdict.faithful && judgeProblems(verdict).length === 0) ? parsed.data : null;
}
