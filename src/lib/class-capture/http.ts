import { z } from "zod";
import { CaptureError, captureEnabled } from "./model";

export const privateHeaders = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex, nofollow" };
export const captureJson = (body: unknown, status = 200) => Response.json(body, { status, headers: privateHeaders });
export function requireCaptureEnabled() {
  if (!captureEnabled() || process.env.CLASS_CAPTURE_RETENTION_ENABLED !== "true") throw new CaptureError(503, "Class capture is paused until private storage and retention cleanup are enabled.");
}
export async function captureRequest(request: Request): Promise<unknown> {
  if (request.headers.get("origin") !== new URL(request.url).origin) throw new CaptureError(403, "Invalid request origin.");
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new CaptureError(415, "Send a JSON request.");
  const reader = request.body?.getReader();
  if (!reader) throw new CaptureError(400, "A request body is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 65536) throw new CaptureError(413, "The request is too large.");
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new CaptureError(400, "Invalid JSON."); }
}
export function captureError(error: unknown) {
  if (error instanceof CaptureError) return captureJson({ error: error.message }, error.status);
  if (error instanceof z.ZodError) return captureJson({ error: error.issues[0]?.message || "Invalid request." }, 400);
  // Never log SQL values, transcript, filenames, provider payloads, or credentials.
  console.error("[class-capture] request failed", error instanceof Error ? error.name : "UnknownError");
  return captureJson({ error: "Class capture is temporarily unavailable. Your local recording is still on this device; retry when ready." }, 503);
}
