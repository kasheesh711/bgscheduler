import { assertMediaBytes, AUDIO_TYPES, PHOTO_TYPES, MAX_AUDIO_BYTES, MAX_DEBRIEF_BYTES, MAX_PHOTO_BYTES, type CaptureAsset, type DraftFields } from "@/lib/class-capture/model";

export type CaptureAvailability = { enabled: boolean; storage: boolean; transcription: boolean; drafting: boolean };
export type LocalMedia = { id: string; kind: CaptureAsset["kind"]; name: string; blob: Blob; incomplete?: boolean };
export const EMPTY_DRAFT: DraftFields = { topicsCovered: "", demonstratedUnderstanding: "", difficulties: "", homeworkNextSteps: "" };
export const DRAFT_LABELS: Record<keyof DraftFields, string> = {
  topicsCovered: "Topics covered", demonstratedUnderstanding: "Demonstrated understanding", difficulties: "Difficulties", homeworkNextSteps: "Homework & next steps",
};

export function canonicalMime(type: string): string {
  const mime = type.split(";")[0].trim().toLowerCase();
  return ({ "audio/x-m4a": "audio/mp4", "audio/m4a": "audio/mp4", "video/mp4": "audio/mp4", "audio/x-wav": "audio/wav" } as Record<string, string>)[mime] ?? mime;
}

/** iOS Files may omit the MIME type. The extension is only a hint: verify bytes too. */
export async function prepareLocalFile(file: File, kind: CaptureAsset["kind"]): Promise<Blob> {
  let mime = canonicalMime(file.type);
  if (kind !== "worksheet" && (!mime || mime === "application/octet-stream")) {
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    mime = ({ m4a: "audio/mp4", mp4: "audio/mp4", webm: "audio/webm", ogg: "audio/ogg", wav: "audio/wav" } as Record<string, string>)[extension] ?? mime;
  }
  const blob = file.slice(0, file.size, mime);
  const invalid = validateLocalFile(blob, kind);
  if (invalid) throw new Error(invalid);
  if (kind !== "worksheet") assertMediaBytes(new Uint8Array(await blob.slice(0, 12).arrayBuffer()), mime);
  return blob;
}

export function validateLocalFile(blob: Blob, kind: CaptureAsset["kind"]): string | null {
  const mime = canonicalMime(blob.type);
  const allowed: readonly string[] = kind === "worksheet" ? PHOTO_TYPES : AUDIO_TYPES;
  const limit = kind === "worksheet" ? MAX_PHOTO_BYTES : kind === "debrief" ? MAX_DEBRIEF_BYTES : MAX_AUDIO_BYTES;
  if (!blob.size) return "This file is empty. Choose another file.";
  if (!allowed.includes(mime)) return kind === "worksheet" ? "Choose a JPG or PNG photo." : "Choose a WebM, MP4/M4A, Ogg or WAV audio file.";
  if (blob.size > limit) return `This file is too large. The limit is ${Math.round(limit / 1024 / 1024)} MB.`;
  return null;
}

export function formatBytes(bytes: number): string { return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
export function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
export function feedbackText(fields: DraftFields): string {
  return (Object.entries(DRAFT_LABELS) as [keyof DraftFields, string][]).map(([key, label]) => `${label}\n${fields[key].trim()}`).join("\n\n");
}

export class CaptureRequestError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
export async function captureRequest<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/class-capture${path}`, {
      method, credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(60_000),
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new CaptureRequestError(0, "The connection was interrupted. Your local files are kept on this device. Reconnect and retry.");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const fallback = response.status === 409 ? "This draft changed in another tab. Reload it before trying again." : response.status === 410 ? "This capture has expired. Start a new capture for the class." : response.status === 401 || response.status === 403 ? "Your access could not be confirmed. Sign in again or contact your administrator." : "This action could not be completed. Please retry.";
    throw new CaptureRequestError(response.status, typeof data.error === "string" ? data.error : fallback);
  }
  return data as T;
}

const POINTER_KEY = "begifted-class-capture:current";
/** Only an opaque ID, owner and expiry are stored here; never student names, transcript or draft text. */
export function saveCapturePointer(ownerEmail: string, captureId: string, expiresAt: string): void {
  try { localStorage.setItem(POINTER_KEY, JSON.stringify({ ownerEmail: ownerEmail.toLowerCase().trim(), captureId, expiresAt })); } catch { /* IndexedDB still provides file recovery. */ }
}
export function loadCapturePointer(ownerEmail: string): string | null {
  try {
    const value = JSON.parse(localStorage.getItem(POINTER_KEY) ?? "null");
    if (value?.ownerEmail === ownerEmail.toLowerCase().trim() && typeof value.captureId === "string" && new Date(value.expiresAt).getTime() > Date.now()) return value.captureId;
    localStorage.removeItem(POINTER_KEY);
  } catch { /* Private browsing may deny local storage. */ }
  return null;
}
export function clearCapturePointer(): void { try { localStorage.removeItem(POINTER_KEY); } catch { /* No persisted pointer. */ } }
