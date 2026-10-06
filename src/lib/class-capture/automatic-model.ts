import { z } from "zod";
import type { DraftFields } from "./model";

export const segmentSchema = z.object({ text: z.string(), startMs: z.number(), endMs: z.number().optional(), speaker: z.string().optional() });
export type TranscriptSegment = z.infer<typeof segmentSchema>;
export const photoFindingsSchema = z.object({
  questions: z.array(z.string().max(1500)).max(30),
  studentWork: z.array(z.string().max(1500)).max(30),
  markings: z.array(z.string().max(1000)).max(30),
  uncertainties: z.array(z.string().max(500)).max(10),
}).strict();
export type PhotoFindings = z.infer<typeof photoFindingsSchema>;
export const evidenceItemSchema = z.object({
  field: z.enum(["topicsCovered", "demonstratedUnderstanding", "difficulties", "homeworkNextSteps"]),
  sourceId: z.string().max(120), quote: z.string().min(1).max(2000),
  startMs: z.number().nonnegative().nullable(),
}).strict();
export type DraftEvidence = { sources: z.infer<typeof evidenceItemSchema>[]; questions: string[] };
export type DraftProposal = { fields: DraftFields; evidence: DraftEvidence; revision: number };
export type AutomaticProgress = {
  consented: boolean; revision: number; completedRevision: number;
  status: "waiting" | "processing" | "writing" | "ready" | "attention";
  recording: boolean; expectedUploads: string[]; error: string | null;
  proposal: DraftProposal | null; evidence: DraftEvidence | null;
};
export function automaticCaptureEnabled(env: Record<string, string | undefined> = process.env) {
  return env.ENABLE_CLASS_CAPTURE === "true" && env.CLASS_CAPTURE_AUTOMATIC_WORKFLOW === "true";
}
