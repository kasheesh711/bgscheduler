import { z } from "zod";

export const REPORT_MAX_STUDENTS = 8;

export const reportParamsSchema = z.object({
  students: z.array(z.string().min(1)).min(1).max(REPORT_MAX_STUDENTS),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).refine((value) => value.from <= value.to, {
  message: "from must be on or before to",
});

export type ReportParams = z.infer<typeof reportParamsSchema>;

/**
 * Folds raw search params into the report schema's input shape.
 * The repeated `student` key becomes `students`; date arrays use their first value.
 */
export function normalizeReportParams(
  raw: Record<string, string | string[] | undefined>,
): unknown {
  const student = raw.student;
  return {
    students: Array.isArray(student) ? student : student === undefined ? [] : [student],
    from: Array.isArray(raw.from) ? raw.from[0] : raw.from,
    to: Array.isArray(raw.to) ? raw.to[0] : raw.to,
  };
}

/** Builds the canonical report query string without a leading question mark. */
export function buildReportSearch(input: {
  studentKeys: readonly string[];
  from: string;
  to: string;
}): string {
  return [
    ...input.studentKeys.map((studentKey) => `student=${encodeURIComponent(studentKey)}`),
    `from=${encodeURIComponent(input.from)}`,
    `to=${encodeURIComponent(input.to)}`,
  ].join("&");
}
