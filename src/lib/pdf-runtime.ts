import path from "node:path";
import { readFile } from "node:fs/promises";

/**
 * One pdf.js browser runtime file (worker, character map, standard font, wasm) by its bare name, or null.
 * The name is matched against fixed patterns, so a caller can never reach another path. The route checks access.
 */
export async function pdfRuntimeAsset(asset: string): Promise<Response | null> {
  let relative: string, mime: string;
  if (asset === "worker.mjs") { relative = "build/pdf.worker.min.mjs"; mime = "text/javascript"; }
  // The legacy build runs on older Safari and phones, which the main build does not.
  else if (asset === "worker-legacy.mjs") { relative = "legacy/build/pdf.worker.min.mjs"; mime = "text/javascript"; }
  else if (/^[A-Za-z0-9_-]+\.bcmap$/.test(asset)) { relative = `cmaps/${asset}`; mime = "application/octet-stream"; }
  else if (/^[A-Za-z0-9_-]+\.(?:pfb|ttf)$/.test(asset)) { relative = `standard_fonts/${asset}`; mime = "application/octet-stream"; }
  else if (/^[A-Za-z0-9_-]+\.(?:wasm|js)$/.test(asset)) { relative = `wasm/${asset}`; mime = asset.endsWith("wasm") ? "application/wasm" : "text/javascript"; }
  else return null;
  const bytes = await readFile(path.join(process.cwd(), "node_modules/pdfjs-dist", relative)).catch(() => null);
  if (!bytes) return null;
  return new Response(new Uint8Array(bytes), { headers: { "Content-Type": mime, "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" } });
}
