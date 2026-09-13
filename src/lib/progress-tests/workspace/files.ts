import { createHash, randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { get, put } from "@vercel/blob";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { getDb, type Database } from "@/lib/db";
import { ptFiles } from "@/lib/db/schema";
import { assertOwner, MAX_FILE_BYTES, WorkspaceError } from "./model";
import { scopeForEmail, type Scope } from "./access";

export type StoredFile = typeof ptFiles.$inferSelect;
export async function fileForScope(scope: Scope, id: string, db: Database = getDb()) {
  const [file] = await db.select().from(ptFiles).where(eq(ptFiles.id, id)).limit(1);
  if (!file) throw new WorkspaceError(404, "File not found.");
  assertOwner(scope.keys, file.ownerKey);
  return file;
}
export async function readBlobBytes(file: StoredFile, limit = MAX_FILE_BYTES): Promise<Buffer> {
  // Only persisted pathnames are accepted, never an arbitrary callback/browser URL.
  if (!/^progress-tests\/[a-f0-9-]{36}\/[a-z-]+$/.test(file.pathname)) throw new WorkspaceError(400, "Invalid stored file path.");
  const blob = await get(file.pathname, { access: "private", useCache: false });
  if (!blob || blob.statusCode !== 200) throw new WorkspaceError(409, "The file is not available yet. Retry in a moment.");
  if (blob.blob.size > limit) { await blob.stream.cancel(); throw new WorkspaceError(400, "The file exceeds the size limit."); }
  const reader = blob.stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw new WorkspaceError(400, "The file exceeds the size limit.");
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return Buffer.concat(chunks);
}
export async function validateSource(bytes: Buffer, mime: string) {
  const { PDFDocument } = await import("pdf-lib");
  if (mime === "application/pdf") {
    if (!bytes.subarray(0, 1024).includes(Buffer.from("%PDF-"))) throw new WorkspaceError(400, "The file is not a PDF.");
    try {
      const pdf = await PDFDocument.load(bytes);
      if (pdf.getPageCount() > 100 || pdf.getPageCount() < 1) throw new Error("page limit");
      return pdf.getPageCount();
    } catch { throw new WorkspaceError(400, "Use a readable, unencrypted PDF with 1–100 pages."); }
  } else if (mime === "image/png" || mime === "image/jpeg") {
    try {
      const pdf = await PDFDocument.create();
      const img = mime === "image/png" ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
      if (img.width * img.height > 40_000_000) throw new Error("image dimensions");
      return 1;
    } catch { throw new WorkspaceError(400, "Use a valid JPG or PNG of at most 40 megapixels."); }
  } else if (mime.includes("wordprocessingml")) {
    const { default: JSZip } = await import("jszip");
    try {
      const zip = await JSZip.loadAsync(bytes);
      const entries = Object.values(zip.files);
      const total = entries.reduce((sum, entry) => sum + ((entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0), 0);
      if (entries.length > 3000 || total > 100 * 1024 * 1024 || !zip.file("word/document.xml") || !zip.file("[Content_Types].xml")) throw new Error("invalid document");
      if (entries.some(e => /vbaProject|activeX|embeddings\//i.test(e.name))) throw new Error("embedded active content");
    } catch { throw new WorkspaceError(400, "This DOCX contains unsupported or oversized content. Export a visual PDF and upload it instead."); }
  } else throw new WorkspaceError(400, "Unsupported file type.");
}
export async function finalizeUpload(scope: Scope, id: string, db: Database = getDb()) {
  const file = await fileForScope(scope, id, db);
  if (file.status === "ready") return { id: file.id, status: "ready", pageCount: file.pageCount };
  if (file.status !== "pending") throw new WorkspaceError(409, "Create a new upload for this file.");
  const bytes = await readBlobBytes(file);
  if (bytes.length !== file.size) throw new WorkspaceError(400, "Uploaded size differs from the authorized file.");
  const pageCount = await validateSource(bytes, file.mime) ?? null;
  await db.update(ptFiles).set({ sha256: createHash("sha256").update(bytes).digest("hex"), status: "ready", pageCount }).where(and(eq(ptFiles.id, id), eq(ptFiles.status, "pending")));
  return { id, status: "ready", pageCount };
}
export async function uploadHandler(request: Request, body: HandleUploadBody, scope?: Scope) {
  return handleUpload({ request, body,
    onBeforeGenerateToken: async (pathname, payload) => {
      if (!scope) throw new WorkspaceError(401, "Sign in to upload a file.");
      const id = String(payload ?? "");
      if (!/^[a-f0-9-]{36}$/.test(id)) throw new WorkspaceError(400, "Invalid upload intent.");
      const file = await fileForScope(scope, id);
      if (file.pathname !== pathname || file.status !== "pending" || Date.now() - file.createdAt.getTime() > 30 * 60_000) throw new WorkspaceError(409, "This upload authorization expired. Select the file again.");
      const origin = process.env.PROGRESS_TEST_PUBLIC_ORIGIN || process.env.NEXTAUTH_URL || "https://bgscheduler.vercel.app";
      return { allowedContentTypes: [file.mime], maximumSizeInBytes: file.size, addRandomSuffix: false, allowOverwrite: false,
        validUntil: Date.now() + 15 * 60_000, tokenPayload: JSON.stringify({ id: file.id, email: scope.user.email }),
        callbackUrl: new URL("/api/internal/progress-tests/uploads", origin).toString() };
    },
    // handleUpload verifies the Blob callback signature BEFORE calling this.
    onUploadCompleted: async ({ blob, tokenPayload }) => {
      const payload = JSON.parse(tokenPayload || "{}") as { id?: string; email?: string };
      if (!payload.id || !payload.email) throw new WorkspaceError(400, "Missing upload authorization.");
      const current = await scopeForEmail(payload.email);
      const file = await fileForScope(current, payload.id);
      if (blob.pathname !== file.pathname) throw new WorkspaceError(400, "Upload path mismatch.");
      await finalizeUpload(current, file.id);
    },
  });
}
export async function storeGenerated(ownerKey: string, name: string, bytes: Buffer, db: Database = getDb()) {
  if (bytes.length > MAX_FILE_BYTES) throw new WorkspaceError(400, "Generated PDF exceeds 25 MB. Reduce the source image sizes.");
  const { PDFDocument } = await import("pdf-lib");
  const pageCount = (await PDFDocument.load(bytes)).getPageCount();
  const id = randomUUID();
  const pathname = `progress-tests/${id}/generated`;
  await put(pathname, bytes, { access: "private", contentType: "application/pdf", addRandomSuffix: false, allowOverwrite: false });
  const [file] = await db.insert(ptFiles).values({ id, ownerKey, name, mime: "application/pdf", size: bytes.length, pageCount, pathname, purpose: "generated", status: "ready", sha256: createHash("sha256").update(bytes).digest("hex") }).returning();
  return file;
}
