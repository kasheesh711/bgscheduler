import { get } from "@vercel/blob";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import { classCaptureAssets as assets, classCaptures as captures } from "@/lib/db/schema";
import { assetForScope, captureForScope, type StoredAsset } from "./store";
import { CaptureError, assertMediaBytes } from "./model";
import type { CaptureScope } from "./sessions";

export async function readMediaBytes(asset: StoredAsset): Promise<Buffer> {
  if (!/^class-capture\/[a-f0-9-]{36}\/[a-f0-9-]{36}$/.test(asset.pathname)) throw new CaptureError(400, "Invalid stored media path.");
  const blob = await get(asset.pathname, { access: "private", useCache: false });
  if (!blob || blob.statusCode !== 200) throw new CaptureError(409, "The upload is not complete. Retry the upload or check again.");
  if (blob.blob.size !== asset.size) { await blob.stream.cancel(); throw new CaptureError(400, "Uploaded file size does not match the authorized size."); }
  const reader = blob.stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > asset.size) throw new CaptureError(400, "Uploaded file exceeds its authorized size.");
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  if (size !== asset.size) throw new CaptureError(400, "Uploaded file size is incomplete.");
  return Buffer.concat(chunks);
}

const MAX_IMAGE_PIXELS = 24_000_000;

function assertImageDimensions(width: number, height: number) {
  if (width <= 0 || height <= 0 || width > 0x7fffffff || height > 0x7fffffff ||
    width > Math.floor(MAX_IMAGE_PIXELS / height)) throw new Error("image dimensions");
}

/** Validate allocation-driving headers before UPNG can allocate a pixel buffer. */
function preflightPng(bytes: Buffer): Buffer {
  if (bytes.length < 33 || bytes.readUInt32BE(8) !== 13 || bytes.toString("latin1", 12, 16) !== "IHDR") throw new Error("PNG header");
  assertImageDimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
  const depth = bytes[24], color = bytes[25];
  const depths: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (!depths[color]?.includes(depth) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] > 1) throw new Error("PNG format");
  const pixels = [bytes.subarray(0, 8)];
  let offset = 8, dataBytes = 0, paletteEntries = 0;
  let seenData = false, endedData = false, seenTransparency = false;
  while (offset < bytes.length) {
    if (bytes.length - offset < 12) throw new Error("PNG truncated chunk");
    const length = bytes.readUInt32BE(offset), type = bytes.toString("latin1", offset + 4, offset + 8);
    if (length > bytes.length - offset - 12 || !/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type)) throw new Error("PNG chunk");
    const next = offset + length + 12;
    if (["acTL", "fcTL", "fdAT"].includes(type)) throw new Error("Animated PNG is not supported");
    if (type === "IHDR") {
      if (offset !== 8 || length !== 13) throw new Error("PNG duplicate header");
    } else if (type === "PLTE") {
      if (seenData || paletteEntries || [0, 4].includes(color) || !length || length > 768 || length % 3 ||
        (color === 3 && length / 3 > 2 ** depth)) throw new Error("PNG palette");
      paletteEntries = length / 3;
    } else if (type === "tRNS") {
      const validLength = color === 0 ? length === 2 : color === 2 ? length === 6 : color === 3 && length > 0 && length <= paletteEntries;
      if (seenData || seenTransparency || !validLength) throw new Error("PNG transparency");
      seenTransparency = true;
    } else if (type === "IDAT") {
      if (endedData || (color === 3 && !paletteEntries)) throw new Error("PNG image data");
      seenData = true;
      dataBytes += length;
    } else if (type === "IEND") {
      if (length !== 0 || !dataBytes || next !== bytes.length) throw new Error("PNG end");
      pixels.push(bytes.subarray(offset, next));
      return Buffer.concat(pixels);
    } else if (type[0] === type[0].toUpperCase()) {
      throw new Error("PNG unknown critical chunk");
    }
    if (seenData && type !== "IDAT") endedData = true;
    // Text/EXIF and other ancillary metadata are unnecessary for pixel validation.
    // In particular, UPNG's text terminator scans are not bounded to their chunk.
    if (["IHDR", "PLTE", "tRNS", "IDAT"].includes(type)) pixels.push(bytes.subarray(offset, next));
    offset = next;
  }
  throw new Error("PNG missing end");
}

function preflightJpeg(bytes: Buffer) {
  const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) throw new Error("JPEG marker");
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) throw new Error("JPEG truncated marker");
    const marker = bytes[offset++];
    if (marker === 0 || marker === 1 || (marker >= 0xd0 && marker <= 0xda) || offset + 2 > bytes.length) throw new Error("JPEG frame missing");
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || length > bytes.length - offset) throw new Error("JPEG truncated segment");
    if (frameMarkers.has(marker)) {
      if (length < 8 || ![8, 12, 16].includes(bytes[offset + 2]) || ![1, 3, 4].includes(bytes[offset + 7]) ||
        length !== 8 + 3 * bytes[offset + 7]) throw new Error("JPEG frame");
      assertImageDimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
      return;
    }
    offset += length;
  }
  throw new Error("JPEG frame missing");
}

export async function validateMedia(bytes: Buffer, mime: string) {
  assertMediaBytes(bytes, mime);
  if (mime.startsWith("image/")) {
    try {
      let pixels = bytes;
      if (mime === "image/png") pixels = preflightPng(bytes);
      else preflightJpeg(bytes);
      // pdf-lib's JPEG reader uses the underlying ArrayBuffer without its offset.
      const input = Uint8Array.from(pixels);
      const { PDFDocument } = await import("pdf-lib");
      const pdf = await PDFDocument.create();
      const image = mime === "image/png" ? await pdf.embedPng(input) : await pdf.embedJpg(input);
      assertImageDimensions(image.width, image.height);
    } catch { throw new CaptureError(400, "Use a readable JPG or PNG worksheet of at most 24 megapixels."); }
  }
}
export async function finalizeAsset(scope: CaptureScope, captureId: string, assetId: string, db: Database = getDb()) {
  const asset = await assetForScope(scope, assetId, db);
  if (asset.captureId !== captureId) throw new CaptureError(404, "Evidence not found in this class.");
  if (asset.status !== "pending") return;
  const bytes = await readMediaBytes(asset);
  await validateMedia(bytes, asset.mime);
  await captureForScope(scope, captureId, db);
  await db.update(assets).set({ status: "ready" }).where(and(eq(assets.id, assetId), isNull(assets.discardedAt), eq(assets.status, "pending"),
    sql`exists (select 1 from class_captures c where c.id = ${assets.captureId} and c.deleted_at is null and c.expires_at > now())`));
  await db.update(captures).set({ reviewed: false }).where(eq(captures.id, captureId));
}
export async function uploadHandler(request: Request, body: HandleUploadBody, scope: CaptureScope) {
  // No callback required: the browser explicitly finalizes, and retry checks the private object.
  return handleUpload({ request, body, onBeforeGenerateToken: async (pathname, payload) => {
    if (!payload || !/^[a-f0-9-]{36}$/.test(payload)) throw new CaptureError(400, "Invalid upload intent.");
    const asset = await assetForScope(scope, payload);
    if (asset.pathname !== pathname || asset.status !== "pending") throw new CaptureError(409, "This upload intent is not pending. Refresh its status.");
    return { allowedContentTypes: [asset.mime], maximumSizeInBytes: asset.size, addRandomSuffix: false, allowOverwrite: false,
      validUntil: Date.now() + 5 * 60_000, cacheControlMaxAge: 60 };
  } });
}
