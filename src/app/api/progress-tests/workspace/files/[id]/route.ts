import { get } from "@vercel/blob";
import { requireWorkspace } from "@/lib/progress-tests/workspace/access";
import { fileForScope, finalizeUpload } from "@/lib/progress-tests/workspace/files";
import { privateJson, requestJson, uuidParam, workspaceError } from "@/lib/progress-tests/workspace/http";
import { WorkspaceError } from "@/lib/progress-tests/workspace/model";
export const maxDuration = 300;
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const file = await fileForScope(await requireWorkspace(), uuidParam((await context.params).id));
    if (file.status !== "ready") throw new WorkspaceError(409, "The upload has not finished validation.");
    const blob = await get(file.pathname, { access: "private" });
    if (!blob || blob.statusCode !== 200) throw new WorkspaceError(404, "File unavailable.");
    return new Response(blob.stream, { headers: { "Content-Type": file.mime, "Content-Length": String(blob.blob.size), "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox", "Content-Disposition": `${file.mime.includes("wordprocessingml") || new URL(request.url).searchParams.get("download") === "1" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g, "%27")}` } });
  } catch (error) { return workspaceError(error); }
}
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try { const scope = await requireWorkspace(); await requestJson(request); return privateJson(await finalizeUpload(scope, uuidParam((await context.params).id))); }
  catch (error) { return workspaceError(error); }
}
