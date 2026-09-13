import path from "node:path";
import { readFile } from "node:fs/promises";
import { requireWorkspace } from "@/lib/progress-tests/workspace/access";
import { workspaceError } from "@/lib/progress-tests/workspace/http";
import { WorkspaceError } from "@/lib/progress-tests/workspace/model";

/** Runtime assets only. No caller-controlled paths or source documents. */
export async function GET(_request: Request, context: { params: Promise<{ asset: string }> }) {
  try {
    await requireWorkspace();
    const { asset } = await context.params;
    let relative: string, mime: string;
    if (asset === "worker.mjs") { relative = "build/pdf.worker.min.mjs"; mime = "text/javascript"; }
    else if (/^[A-Za-z0-9_-]+\.bcmap$/.test(asset)) { relative = `cmaps/${asset}`; mime = "application/octet-stream"; }
    else if (/^[A-Za-z0-9_-]+\.(?:pfb|ttf)$/.test(asset)) { relative = `standard_fonts/${asset}`; mime = "application/octet-stream"; }
    else if (/^[A-Za-z0-9_-]+\.(?:wasm|js)$/.test(asset)) { relative = `wasm/${asset}`; mime = asset.endsWith("wasm") ? "application/wasm" : "text/javascript"; }
    else throw new WorkspaceError(404, "Runtime asset not found.");
    const bytes = await readFile(path.join(process.cwd(), "node_modules/pdfjs-dist", relative));
    return new Response(new Uint8Array(bytes), { headers: { "Content-Type": mime, "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" } });
  } catch (error) { return workspaceError(error); }
}
