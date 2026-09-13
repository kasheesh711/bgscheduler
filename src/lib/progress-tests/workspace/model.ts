import { z } from "zod";

export const WORKSPACE_VERSION = 1;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const SOURCE_TYPES = ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "image/jpeg", "image/png"] as const;
export const questionSchema = z.object({
  id: z.string().min(1).max(80), text: z.string().min(1).max(15000), topic: z.string().max(500),
  maxMarks: z.number().positive().max(1000), rubric: z.string().max(15000),
  sourcePage: z.number().int().positive().nullable(), needsVisual: z.boolean(),
}).strict();
export const paperSchema = z.object({
  title: z.string().min(1).max(300), instructions: z.string().max(10000),
  questions: z.array(questionSchema).min(1).max(200), warnings: z.array(z.string().max(1000)).max(100),
}).strict().superRefine((p, ctx) => {
  if (new Set(p.questions.map(q => q.id)).size !== p.questions.length)
    ctx.addIssue({ code: "custom", message: "Question identifiers must be unique" });
});
export type Paper = z.infer<typeof paperSchema>;
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
export type FeedbackEvidence = { id: string; sessionId: string; date: string; text: string };
export type Review = { marks: Mark[]; report: Report; feedback: FeedbackEvidence[]; priorReviewIds: string[]; model: string | null; promptVersion: string; submissionId: string; paperVersionId: string };
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
  return { earned, possible, percent: Math.round(earned / possible * 1000) / 10 };
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
