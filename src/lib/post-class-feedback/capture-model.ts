import { z } from "zod";
import { feedbackProofExclusion } from "./feedback-proof";
import { PostClassValidationError } from "./errors";

export const captureInput = z.object({
  wiseSessionId: z.string().min(1).max(200), tutorKey: z.string().min(1).max(200), tutorName: z.string().min(1).max(300),
  students: z.array(z.string().min(1).max(300)).min(1).max(100), subject: z.string().max(300),
  deadlineAt: z.iso.datetime(), observedAt: z.iso.datetime(), capturedAt: z.iso.datetime(),
  mode: z.enum(["deadline", "current"]), state: z.enum(["missing", "present", "uncheckable"]),
  note: z.string().max(2000).default(""),
});
export type CaptureInput = z.infer<typeof captureInput>;
export type CaptureBinding = Pick<CaptureInput, "wiseSessionId" | "tutorKey" | "tutorName" | "students" | "subject" | "deadlineAt">;

export function assertCaptureBinding(expected: CaptureBinding, actual: CaptureBinding) {
  for (const key of ["wiseSessionId", "tutorKey", "tutorName", "subject", "deadlineAt"] as const) {
    if (expected[key] !== actual[key]) throw new PostClassValidationError(`The captured ${key} does not match the current class.`);
  }
  if (JSON.stringify([...expected.students].sort()) !== JSON.stringify([...actual.students].sort())) {
    throw new PostClassValidationError("The captured students do not match the current class.");
  }
}
export function captureTiming(deadline: Date, captured: Date, mode: CaptureInput["mode"]) {
  if (!Number.isFinite(deadline.getTime()) || !Number.isFinite(captured.getTime()) || captured < deadline) {
    throw new PostClassValidationError("Capture time must be at or after the feedback deadline.");
  }
  if (mode === "current") return "later_check" as const;
  return captured.getTime() <= deadline.getTime() + 15 * 60_000 + 1 ? "within_window" as const : "late" as const;
}
export function captureConflict(state: CaptureInput["state"], observed: Date, events: readonly {
  actorRole: string | null; autoSubmitted: boolean | null; eventTimestamp: Date;
}[]) {
  return state === "missing" && events.some(event => feedbackProofExclusion(event) === null && event.eventTimestamp <= observed);
}
export function screenshotMime(bytes: Buffer) {
  if (!bytes.length || bytes.length > 4 * 1024 * 1024) throw new PostClassValidationError("Select an image no larger than 4 MB.");
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  throw new PostClassValidationError("The screenshot must be a PNG or JPEG image.");
}
export function submissionDuringCapture(state: CaptureInput["state"], observed: Date, captured: Date, events: readonly {
  actorRole: string | null; autoSubmitted: boolean | null; eventTimestamp: Date;
}[]) {
  return state === "missing" && events.some(event => feedbackProofExclusion(event) === null && event.eventTimestamp > observed && event.eventTimestamp <= captured);
}
