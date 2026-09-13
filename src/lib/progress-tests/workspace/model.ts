import { z } from "zod";

export const WORKSPACE_VERSION = 1;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const SOURCE_TYPES = ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "image/jpeg", "image/png"] as const;
export const paperBlockSchema = z.union([
  z.object({ kind: z.literal("text"), text: z.string().max(15000) }).strict(),
  z.object({ kind: z.literal("math"), latex: z.string().max(4000), display: z.boolean() }).strict(),
  z.object({ kind: z.literal("table"), headers: z.array(z.string().max(1000)).max(12), rows: z.array(z.array(z.string().max(2000)).max(12)).max(100) }).strict(),
  z.object({ kind: z.literal("figure"), page: z.number().int().positive(), box: z.array(z.number().min(0).max(1)).length(4), alt: z.string().max(1000) }).strict(),
  z.object({ kind: z.literal("part-marks"), label: z.string().min(1).max(80), marks: z.number().positive().max(1000) }).strict(),
  z.object({ kind: z.literal("working-area"), page: z.number().int().positive(), box: z.array(z.number().min(0).max(1)).length(4), lines: z.number().int().min(0).max(100) }).strict(),
]);
export type PaperBlock = z.infer<typeof paperBlockSchema>;
const coverageSchema = z.array(z.object({ page: z.number().int().positive(), purpose: z.enum(["questions", "instructions", "blank", "answer_key"]), questionIds: z.array(z.string()).max(200) }).strict()).max(100);
export const questionSchema = z.object({
  id: z.string().min(1).max(80), text: z.string().min(1).max(15000), topic: z.string().max(500),
  maxMarks: z.number().positive().max(1000), rubric: z.string().max(15000),
  sourcePage: z.number().int().positive().nullable(), needsVisual: z.boolean(),
  number: z.string().max(80).optional(), blocks: z.array(paperBlockSchema).max(100).optional(),
  answerLines: z.number().int().min(0).max(30).optional(), sourcePages: z.array(z.number().int().positive()).max(100).optional(),
}).strict();
export const paperSchema = z.object({
  title: z.string().min(1).max(300), instructions: z.string().max(10000),
  questions: z.array(questionSchema).min(1).max(200), warnings: z.array(z.string().max(1000)).max(100),
  coverage: coverageSchema.optional(),
  gradingWarnings: z.array(z.string().max(1000)).max(200).optional(),
}).strict().superRefine((p, ctx) => {
  if (new Set(p.questions.map(q => q.id)).size !== p.questions.length)
    ctx.addIssue({ code: "custom", message: "Question identifiers must be unique" });
});
export type Paper = z.infer<typeof paperSchema>;
export type OriginalPaper = { kind: "original"; title: string };
export type PaperContent = Paper | OriginalPaper;
export const isOriginalPaper = (paper: PaperContent): paper is OriginalPaper => "kind" in paper && paper.kind === "original";
export function structuredPaper(paper: PaperContent): Paper {
  if (isOriginalPaper(paper)) throw new WorkspaceError(409, "This original paper uses uploaded marked-PDF grading. No question extraction is required.");
  return paper;
}
export const formattedPaperSchema = z.object({ title: paperSchema.shape.title, instructions: paperSchema.shape.instructions, warnings: paperSchema.shape.warnings,
  questions: z.array(questionSchema.extend({ maxMarks: z.number().min(0.5).max(1000).nullable(), number: z.string().min(1).max(80), blocks: z.array(paperBlockSchema).min(1).max(100), answerLines: z.number().int().min(0).max(30), sourcePages: z.array(z.number().int().positive()).min(1).max(100) })).min(1).max(200),
  coverage: coverageSchema,
}).strict();
/** The optional second PDF is private rubric evidence, outside the first paper's page ledger. */
export function normalizeFormattedPaper(data: z.infer<typeof formattedPaperSchema>, pageCount: number, keyIncluded: boolean): Paper {
  const coverage = keyIncluded ? data.coverage.filter(p => p.purpose !== "answer_key" || (p.page <= pageCount && !data.coverage.some(other => other.page === p.page && other.purpose !== "answer_key"))) : data.coverage;
  return { ...data, coverage, questions: data.questions.map(q => ({ ...q, maxMarks: q.maxMarks ?? 0 })),
    gradingWarnings: data.questions.flatMap(q => {
      const warnings: string[] = [];
      if (q.maxMarks === null) warnings.push(`Question ${q.number}: no mark allocation was supplied. Add marks to the source paper or marking key before AI grading.`);
      const allocations = q.blocks.filter((b): b is Extract<PaperBlock, { kind: "part-marks" }> => b.kind === "part-marks");
      if (allocations.length && q.maxMarks !== null && Math.abs(allocations.reduce((sum, b) => sum + b.marks, 0) - q.maxMarks) > .001) warnings.push(`Question ${q.number}: subpart marks do not equal the question total. Check the source allocations before AI grading.`);
      if (!q.rubric.trim()) warnings.push(`Question ${q.number}: marking criteria are missing. Supply a marking key before AI grading.`);
      return warnings;
    }),
  };
}
/** Deterministic integrity checks supplement, rather than claim to replace, visual tutor review. */
export function paperCoverageWarnings(paper: Paper, pageCount: number): string[] {
  const warnings: string[] = [];
  const ids = new Set(paper.questions.map(q => q.id));
  if (ids.size !== paper.questions.length) warnings.push("Question identifiers are duplicated. Reformat the source.");
  const coverage = paper.coverage ?? [];
  if (coverage.length !== pageCount || new Set(coverage.map(p => p.page)).size !== pageCount || coverage.some(p => p.page > pageCount)) warnings.push("Some source pages could not be accounted for. Check and replace the source PDF.");
  for (const p of coverage) {
    if (p.questionIds.some(id => !ids.has(id)) || (p.purpose === "questions" && !p.questionIds.length)) warnings.push(`Question coverage on source page ${p.page} is incomplete.`);
  }
  for (const q of paper.questions) {
    if (!q.sourcePages?.length || q.sourcePages.some(page => page > pageCount || !coverage.some(p => p.page === page && p.questionIds.includes(q.id)))) warnings.push(`Check the source pages for question ${q.number ?? q.id}.`);
    if (q.needsVisual && !q.blocks?.some(b => b.kind === "figure")) warnings.push(`Question ${q.number ?? q.id} has an illustration that was not preserved.`);
    for (const b of q.blocks ?? []) if ((b.kind === "figure" || b.kind === "working-area") && (b.page > pageCount || b.box[2] <= b.box[0] || b.box[3] <= b.box[1])) warnings.push(`Question ${q.number ?? q.id} has an invalid source region.`);
  }
  return [...new Set(warnings)];
}
export const markSchema = z.object({
  questionId: z.string().min(1), marks: z.number().min(0).max(1000),
  explanation: z.string().max(10000), answerReference: z.string().max(2000), needsReview: z.boolean(),
}).strict();
export type Mark = z.infer<typeof markSchema>;
export const reportSchema = z.object({
  summary: z.string().max(10000), strengths: z.array(z.string().max(2000)).max(20),
  focusAreas: z.array(z.string().max(2000)).max(20), nextSteps: z.array(z.string().max(2000)).max(20),
  contextLimitations: z.string().max(3000),
}).strict();
export type Report = z.infer<typeof reportSchema>;
export function cleanReport(report: Report): Report {
  const lines = (values: string[]) => values.map(value => value.trim()).filter(Boolean);
  return { ...report, strengths: lines(report.strengths), focusAreas: lines(report.focusAreas), nextSteps: lines(report.nextSteps) };
}
/** PostgreSQL JSONB can reorder keys; draft equality must compare content. */
export function sameJsonValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => sameJsonValue(value, b[index]));
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  return Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key => Object.hasOwn(right, key) && sameJsonValue(left[key], right[key]));
}
export type FeedbackEvidence = { id: string; sessionId: string; date: string; text: string };
export type Review = { marks: Mark[]; report: Report; feedback: FeedbackEvidence[]; priorReviewIds: string[]; model: string | null; promptVersion: string; submissionId: string; paperVersionId: string };
export type UploadedReview = Omit<Review, "marks"> & { kind: "uploaded"; markedFileId: string; markedSha256: string; earned: number; possible: number };
export type ReviewData = Review | UploadedReview;
export const isUploadedReview = (review: ReviewData): review is UploadedReview => "kind" in review && review.kind === "uploaded";
export function scoreTotals(earned: number, possible: number) {
  if (!Number.isFinite(earned) || !Number.isFinite(possible) || possible <= 0 || earned < 0 || earned > possible)
    throw new WorkspaceError(400, "Enter a positive possible score and awarded marks between zero and that score.");
  return { earned, possible, percent: Math.round(earned / possible * 1000) / 10 };
}
export function reviewTotals(paper: PaperContent, review: ReviewData, approving = false) {
  return isUploadedReview(review) ? scoreTotals(review.earned, review.possible) : validateMarks(structuredPaper(paper), review.marks, approving);
}
export type PageRef = { fileId: string; page: number };
export type Submission = { fileIds: string[]; pageOrder?: PageRef[]; sessionId: string; submittedAt: string };
export type Preparation = { paperVersionId: string | null; topics: string; studentInformed: boolean };
export type Stage = "prepare" | "ready" | "awaiting_submission" | "tutor_review" | "approved";
export class WorkspaceError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function validateMarks(paper: Paper, marks: Mark[], approving = false) {
  const byId = new Map(marks.map(m => [m.questionId, m]));
  if (byId.size !== marks.length || marks.length !== paper.questions.length)
    throw new WorkspaceError(400, "Every question needs exactly one mark.");
  for (const q of paper.questions) {
    const m = byId.get(q.id);
    if (!m || !Number.isFinite(m.marks) || m.marks < 0 || m.marks > q.maxMarks)
      throw new WorkspaceError(400, `Check the mark for question ${q.id}.`);
    if (approving && m.needsReview) throw new WorkspaceError(409, "Resolve every flagged answer before approval.");
    if (approving && (!m.explanation.trim() || !m.answerReference.trim())) throw new WorkspaceError(409, "Add an explanation and answer reference for every reviewed mark.");
  }
  const earned = Math.round(marks.reduce((n, m) => n + m.marks, 0) * 100) / 100;
  const possible = Math.round(paper.questions.reduce((n, q) => n + q.maxMarks, 0) * 100) / 100;
  return scoreTotals(earned, possible);
}
export function assertOwner(keys: string[] | null, owner: string) {
  if (keys !== null && !keys.includes(owner)) throw new WorkspaceError(404, "Record not found.");
}
export function assertRevision(actual: number, expected: number) {
  if (actual !== expected) throw new WorkspaceError(409, "This record changed. Reload before saving.");
}
export function workspaceEnabled() { return process.env.PROGRESS_TEST_WORKSPACE_ENABLED === "true"; }
export function cyclePosition(count: number, cycle: number) { return Math.max(0, Math.min(8, count - (cycle - 1) * 8)); }
export function cycleNumbers(count: number) { return Array.from({ length: Math.floor(count / 8) + 1 }, (_, i) => i + 1); }
export function stageFor(count: number, cycle: number, prep: Preparation, hasSubmission: boolean, approved: boolean): Stage {
  if (approved) return "approved";
  if (hasSubmission) return "tutor_review";
  if (cyclePosition(count, cycle) >= 8) return "awaiting_submission";
  return prep.paperVersionId && prep.topics.trim() && prep.studentInformed ? "ready" : "prepare";
}
export const emptyReport = (): Report => ({ summary: "", strengths: [], focusAreas: [], nextSteps: [], contextLimitations: "" });
