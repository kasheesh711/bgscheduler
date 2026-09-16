import { z } from "zod";
import { SitInError } from "./model";

export const RATINGS = [10, 7, 4, 1] as const;
export const RATING_LABELS = [
  "Excellent",
  "Satisfactory",
  "Needs improvement",
  "Unsatisfactory",
];
export type Rubric = {
  version: string;
  sections: Array<{
    title: string;
    criteria: Array<{ id: string; title: string; guidance: string[] }>;
  }>;
};
export const RUBRIC: Rubric = {
  version: "begifted-sit-in-v1",
  sections: [
    {
      title: "Content Knowledge",
      criteria: [
        {
          id: "accuracy",
          title: "Accuracy of information",
          guidance: [
            "Accurate, relevant and aligned with the curriculum.",
            "Mostly accurate and relevant, with minor errors or omissions.",
            "Some inaccurate or irrelevant information.",
            "Information is largely incorrect or irrelevant.",
          ],
        },
        {
          id: "understanding",
          title: "Conceptual understanding",
          guidance: [
            "Deep understanding, explained clearly and concisely.",
            "Sound understanding, with some difficulty explaining complex ideas.",
            "Superficial understanding of key concepts.",
            "Fundamental concepts are not understood.",
          ],
        },
        {
          id: "clarity",
          title: "Clarity of explanation",
          guidance: [
            "Clear explanations, relevant examples and effective answers to learner questions.",
            "Generally clear explanations; occasional further clarification needed.",
            "Explanations are often confusing or unclear.",
            "Explanations and answers do not support understanding.",
          ],
        },
      ],
    },
    {
      title: "Teaching Delivery",
      criteria: [
        {
          id: "engagement",
          title: "Engaging presentation",
          guidance: [
            "A structured, dynamic lesson sustains learner engagement.",
            "Reasonable engagement, with inconsistent energy or interest.",
            "Delivery is monotonous or frequently loses attention.",
            "Delivery fails to engage the learner.",
          ],
        },
        {
          id: "interaction",
          title: "Interaction with learners",
          guidance: [
            "Questions, discussion and activities actively involve each learner.",
            "Attempts to involve learners, with limited engagement.",
            "Learners rarely participate and mainly listen passively.",
            "No meaningful learner involvement.",
          ],
        },
        {
          id: "pace",
          title: "Pace and timing",
          guidance: [
            "Effective pace covers the planned learning without rushing or avoidable delays.",
            "Appropriate pace with minor timing issues.",
            "Time management leaves some learning incomplete.",
            "Poor timing leaves substantial planned learning uncovered.",
          ],
        },
      ],
    },
    {
      title: "Classroom Management",
      criteria: [
        {
          id: "structure",
          title: "Organization and structure",
          guidance: [
            "A well-organized lesson and clear structure support understanding.",
            "An organized lesson with a mostly clear structure.",
            "Uneven organization causes confusion.",
            "Poor organization disrupts learning.",
          ],
        },
        {
          id: "materials",
          title: "Use of teaching materials",
          guidance: [
            "Resources effectively improve understanding and engagement.",
            "Resources are used adequately, with occasional inconsistencies.",
            "Resources are unclear or add little learning value.",
            "Resource choice or use hinders understanding.",
          ],
        },
      ],
    },
    {
      title: "Assessment and Feedback",
      criteria: [
        {
          id: "assessment",
          title: "Formative assessment",
          guidance: [
            "Well-designed checks accurately establish each learner's understanding.",
            "Checks are included but lack variety or clear alignment.",
            "Checks are limited or poorly aligned with learning objectives.",
            "No meaningful checks of understanding.",
          ],
        },
        {
          id: "feedback",
          title: "Feedback quality",
          guidance: [
            "Insightful, constructive feedback is personalized to the learner.",
            "Helpful feedback that could be more specific or detailed.",
            "Vague feedback offers little help for improvement.",
            "Minimal or irrelevant feedback.",
          ],
        },
      ],
    },
  ],
};
export const reportDataSchema = z
  .object({
    scores: z
      .record(
        z.string().max(100),
        z.union([z.literal(10), z.literal(7), z.literal(4), z.literal(1)]),
      )
      .default({}),
    notes: z.record(z.string().max(100), z.string().max(2000)).default({}),
    strengths: z.string().max(5000),
    priorities: z.string().max(5000),
    nextSteps: z.string().max(5000),
    occurred: z.boolean(),
  })
  .strict();
export type ReportData = z.infer<typeof reportDataSchema>;
export const EMPTY_REPORT: ReportData = {
  scores: {},
  notes: {},
  strengths: "",
  priorities: "",
  nextSteps: "",
  occurred: false,
};
export const reportCommandSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    submit: z.boolean(),
    data: reportDataSchema,
  })
  .strict();
export function reportScore(
  rubric: Rubric,
  input: ReportData,
  submit = false,
): number | null {
  const data = reportDataSchema.parse(input);
  const ids = rubric.sections.flatMap((s) => s.criteria.map((c) => c.id));
  if (
    Object.keys(data.scores).some((id) => !ids.includes(id)) ||
    Object.keys(data.notes).some((id) => !ids.includes(id))
  ) {
    throw new SitInError(400, "The answers do not match this report's rubric.");
  }
  const complete = ids.every((id) => data.scores[id] !== undefined);
  if (
    submit &&
    (!complete ||
      !data.occurred ||
      !data.strengths.trim() ||
      !data.priorities.trim() ||
      !data.nextSteps.trim())
  ) {
    throw new SitInError(
      400,
      "Complete all ten ratings, the three report sections, and confirm that the observation occurred.",
    );
  }
  return complete
    ? ids.reduce((total, id) => total + data.scores[id], 0)
    : null;
}
