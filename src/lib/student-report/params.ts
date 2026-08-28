import { z } from "zod";

export const REPORT_MAX_STUDENTS = 8;

export const reportParamsSchema = z.object({
  students: z.array(z.string().min(1)).min(1).max(REPORT_MAX_STUDENTS),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // Tutor feedback is included unless the URL carries feedback=0, so every
  // pre-existing report URL keeps meaning "with feedback".
  includeFeedback: z.enum(["0", "1"]).default("1").transform((value) => value !== "0"),
}).refine((value) => value.from <= value.to, {
  message: "from must be on or before to",
});

export type ReportParams = z.infer<typeof reportParamsSchema>;

/**
 * Folds raw search params into the report schema's input shape.
 * The repeated `student` key becomes `students`; single-value keys use their
 * first value when repeated. The URL key for feedback is `feedback`.
 */
export function normalizeReportParams(
  raw: Record<string, string | string[] | undefined>,
): unknown {
  const student = raw.student;
  return {
    students: Array.isArray(student) ? student : student === undefined ? [] : [student],
    from: Array.isArray(raw.from) ? raw.from[0] : raw.from,
    to: Array.isArray(raw.to) ? raw.to[0] : raw.to,
    includeFeedback: Array.isArray(raw.feedback) ? raw.feedback[0] : raw.feedback,
  };
}

/**
 * Builds the canonical report query string without a leading question mark.
 * `feedback=0` is emitted only when feedback is explicitly excluded, keeping
 * default-on URLs byte-identical to pre-feedback ones.
 */
export function buildReportSearch(input: {
  studentKeys: readonly string[];
  from: string;
  to: string;
  includeFeedback?: boolean;
}): string {
  return [
    ...input.studentKeys.map((studentKey) => `student=${encodeURIComponent(studentKey)}`),
    `from=${encodeURIComponent(input.from)}`,
    `to=${encodeURIComponent(input.to)}`,
    ...(input.includeFeedback === false ? ["feedback=0"] : []),
  ].join("&");
}
