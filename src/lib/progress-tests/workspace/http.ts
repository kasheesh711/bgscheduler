import { z } from "zod";
import { WorkspaceError } from "./model";

export function workspaceError(error: unknown) {
  if (error instanceof WorkspaceError) return privateJson({ error: error.message }, error.status);
  if (error instanceof z.ZodError) return privateJson({ error: error.issues[0]?.message || "Invalid request." }, 400);
  if (error instanceof Error && ["Unauthorized", "Forbidden"].includes(error.message)) return privateJson({ error: error.message }, error.message === "Unauthorized" ? 401 : 403);
  // Avoid including database queries, private document text or provider URLs.
  console.error("Progress Tests workspace request failed", error instanceof Error ? error.name : "UnknownError");
  return privateJson({ error: "This operation could not be completed. Please try again." }, 500);
}
export function privateJson(data: unknown, status = 200) { return Response.json(data, { status, headers: { "Cache-Control": "private, no-store" } }); }
export async function requestJson(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw new WorkspaceError(403, "Invalid request origin.");
  const text = await request.text();
  if (new TextEncoder().encode(text).length > 3_500_000) throw new WorkspaceError(413, "This request is too large. Upload source files directly.");
  try { return JSON.parse(text); } catch { throw new WorkspaceError(400, "Invalid JSON."); }
}
export const uuidParam = (value: string) => z.string().uuid().parse(value);
