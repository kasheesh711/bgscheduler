import { z } from "zod";

export const CAPTURE_RETENTION_MS = 24 * 60 * 60 * 1000;
export const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
export const MAX_DEBRIEF_BYTES = 10 * 1024 * 1024;
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
export const AUDIO_TYPES = ["audio/webm", "audio/mp4", "audio/ogg", "audio/wav"] as const;
export const PHOTO_TYPES = ["image/jpeg", "image/png"] as const;
export class CaptureError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = "CaptureError"; }
}
export function captureEnabled(env: Record<string, string | undefined> = process.env) {
  return env.ENABLE_CLASS_CAPTURE === "true";
}
export function availability(env: Record<string, string | undefined> = process.env) {
  const enabled = captureEnabled(env);
  const approved = enabled && env.CLASS_CAPTURE_PROCESSING_APPROVED === "true";
  const storage = enabled && !!env.BLOB_READ_WRITE_TOKEN?.trim();
  return { enabled, storage, transcription: approved && storage && !!env.SONIOX_API_KEY?.trim(), drafting: approved && !!env.OPENROUTER_API_KEY?.trim() };
}
export const consentSchema = z.object({
  participants: z.literal(true), guardian: z.enum(["confirmed", "not_required"]), processing: z.literal(true),
}).strict();
export type CaptureConsent = z.infer<typeof consentSchema>;
export type CaptureSession = {
  sessionId: string; classId: string; studentId: string; studentName: string; teacherKey: string;
  teacherName: string; title: string; startTime: string; endTime: string; wiseUrl: string;
};
export const draftFieldsSchema = z.object({
  topicsCovered: z.string().max(8000), demonstratedUnderstanding: z.string().max(8000),
  difficulties: z.string().max(8000), homeworkNextSteps: z.string().max(8000),
}).strict();
export type DraftFields = z.infer<typeof draftFieldsSchema>;
export type CaptureAsset = {
  id: string; kind: "recording" | "debrief" | "worksheet"; mime: string; size: number; pathname: string;
  status: "pending" | "ready" | "transcribing" | "transcribed" | "failed"; transcript: string | null; error: string | null;
};
export type CaptureView = {
  id: string; session: CaptureSession; topic: string; tutorNotes: string; consent: CaptureConsent;
  assets: CaptureAsset[]; draft: DraftFields | null; reviewed: boolean; expiresAt: string; version: number;
};
export const createCaptureSchema = z.object({
  id: z.uuid(), sessionId: z.string().min(1).max(200), studentId: z.string().min(1).max(200),
  topic: z.string().trim().min(1).max(500), consent: consentSchema,
}).strict();
export const patchCaptureSchema = z.object({
  version: z.number().int().nonnegative(), topic: z.string().trim().min(1).max(500), tutorNotes: z.string().max(12000),
  fields: draftFieldsSchema.optional(), reviewed: z.boolean().optional(), resetDraft: z.boolean().optional(),
}).strict();
export const assetInputSchema = z.object({
  id: z.uuid(), kind: z.enum(["recording", "debrief", "worksheet"]),
  mime: z.enum([...AUDIO_TYPES, ...PHOTO_TYPES]), size: z.number().int().positive().max(MAX_AUDIO_BYTES),
  worksheetPermission: z.literal(true).optional(),
}).strict().superRefine((asset, ctx) => {
  const photo = asset.kind === "worksheet";
  const allowed: readonly string[] = photo ? PHOTO_TYPES : AUDIO_TYPES;
  const limit = photo ? MAX_PHOTO_BYTES : asset.kind === "debrief" ? MAX_DEBRIEF_BYTES : MAX_AUDIO_BYTES;
  if (!allowed.includes(asset.mime) || asset.size > limit) ctx.addIssue({ code: "custom", message: "Unsupported type or size for this evidence." });
  if (photo && !asset.worksheetPermission) ctx.addIssue({ code: "custom", message: "Confirm permission to upload this worksheet." });
});
/** Container signatures are a first check; images are also decoded on the server. */
export function assertMediaBytes(bytes: Uint8Array, mime: string) {
  const hex = [...bytes.slice(0, 12)].map(n => n.toString(16).padStart(2, "0")).join("");
  const ascii = new TextDecoder().decode(bytes.slice(0, 12));
  const valid = mime === "audio/webm" ? hex.startsWith("1a45dfa3")
    : mime === "audio/ogg" ? ascii.startsWith("OggS")
    : mime === "audio/wav" ? ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WAVE"
    : mime === "audio/mp4" ? ascii.slice(4, 8) === "ftyp"
    : mime === "image/jpeg" ? hex.startsWith("ffd8ff")
    : mime === "image/png" ? hex.startsWith("89504e470d0a1a0a") : false;
  if (!valid) throw new CaptureError(400, "This file does not match its supported media type.");
}
