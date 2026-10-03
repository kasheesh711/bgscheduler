import { beforeEach, describe, expect, it, vi } from "vitest";
import { deflateSync } from "node:zlib";
const mocks = vi.hoisted(() => ({ get: vi.fn(), handle: vi.fn(), asset: vi.fn() }));
vi.mock("@vercel/blob", () => ({ get: mocks.get, del: vi.fn() }));
vi.mock("@vercel/blob/client", () => ({ handleUpload: mocks.handle }));
vi.mock("../store", () => ({ assetForScope: mocks.asset }));
import { PDFDocument } from "pdf-lib";
import { readMediaBytes, uploadHandler, validateMedia } from "../files";
const asset = { id: "22222222-2222-4222-8222-222222222222", captureId: "11111111-1111-4111-8111-111111111111", pathname: "class-capture/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222", mime: "audio/webm", size: 8, status: "pending", createdAt: new Date() };
beforeEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); mocks.asset.mockResolvedValue(asset); });

const signature = Buffer.from("89504e470d0a1a0a", "hex");
function chunk(type: string, data: Buffer = Buffer.alloc(0)) {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  result.write(type, 4, "ascii");
  data.copy(result, 8);
  let crc = 0xffffffff;
  for (const byte of result.subarray(4, result.length - 4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}
function header(width = 1, height = 1, patch: { depth?: number; color?: number; compression?: number; filter?: number; interlace?: number } = {}) {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0); data.writeUInt32BE(height, 4);
  data[8] = patch.depth ?? 8; data[9] = patch.color ?? 6;
  data[10] = patch.compression ?? 0; data[11] = patch.filter ?? 0; data[12] = patch.interlace ?? 0;
  return chunk("IHDR", data);
}
const pixel = () => chunk("IDAT", deflateSync(Buffer.from([0, 255, 255, 255, 255])));
const png = (parts = [header(), pixel(), chunk("IEND")]) => Buffer.concat([signature, ...parts]);
function jpegHeader(width: number, height: number) {
  const data = Buffer.alloc(19);
  data.writeUInt16BE(0xffc0, 0); data.writeUInt16BE(17, 2); data[4] = 8;
  data.writeUInt16BE(height, 5); data.writeUInt16BE(width, 7); data[9] = 3;
  data.set([1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0], 10);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), data, Buffer.from([0xff, 0xd9])]);
}
function harmlessDecoder() {
  const embedPng = vi.fn().mockResolvedValue({ width: 1, height: 1 });
  const embedJpg = vi.fn().mockResolvedValue({ width: 1, height: 1 });
  const create = vi.spyOn(PDFDocument, "create").mockResolvedValue({ embedPng, embedJpg } as never);
  return { create, embedPng, embedJpg };
}
describe("private capture files", () => {
  it("accepts only persisted paths and size-bounded private streams", async () => {
    await expect(readMediaBytes({ ...asset, pathname: "https://attacker.invalid/secret" } as never)).rejects.toThrow("path");
    mocks.get.mockResolvedValue({ statusCode: 200, blob: { size: 8 }, stream: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(9)); c.close(); } }) });
    await expect(readMediaBytes(asset as never)).rejects.toThrow("size");
    expect(mocks.get).toHaveBeenCalledWith(asset.pathname, { access: "private", useCache: false, abortSignal: expect.any(AbortSignal) });
  });
  it("binds upload authorization to the current user, exact path/type/size and pending intent", async () => {
    mocks.handle.mockImplementation(async ({ onBeforeGenerateToken }) => onBeforeGenerateToken(asset.pathname, asset.id));
    const result = await uploadHandler(new Request("https://example.invalid"), { type: "blob.generate-client-token", payload: { pathname: asset.pathname, clientPayload: asset.id, multipart: true } }, { email: "synthetic@example.invalid", keys: ["tutor"] });
    expect(result).toMatchObject({ maximumSizeInBytes: 8, allowedContentTypes: ["audio/webm"], allowOverwrite: false, addRandomSuffix: false });
    mocks.asset.mockResolvedValue({ ...asset, status: "ready" });
    await expect(uploadHandler(new Request("https://example.invalid"), {} as never, { email: "synthetic@example.invalid", keys: ["Synthetic Tutor"] })).rejects.toThrow("pending");
  });
});

describe("worksheet image preflight", () => {
  it.each([[6000, 4001], [0xffffffff, 0xffffffff], [0, 1], [1, 0]])("rejects an unsafe PNG IHDR %dx%d before any decoder allocation", async (width, height) => {
    const decoder = harmlessDecoder();
    // Header only: never manufacture or decompress a large image in this test.
    await expect(validateMedia(png([header(width, height)]), "image/png")).rejects.toMatchObject({ status: 400 });
    expect(decoder.create).not.toHaveBeenCalled();
  });

  it.each([
    () => png([chunk("IHDR", Buffer.alloc(12)), pixel(), chunk("IEND")]),
    () => png([pixel(), header(), chunk("IEND")]),
    () => png([header(), header(100000, 100000), pixel(), chunk("IEND")]),
    () => png([header(1, 1, { depth: 3 }), pixel(), chunk("IEND")]),
    () => png([header(1, 1, { color: 1 }), pixel(), chunk("IEND")]),
    () => png([header(1, 1, { compression: 1 }), pixel(), chunk("IEND")]),
    () => png([header(1, 1, { filter: 1 }), pixel(), chunk("IEND")]),
    () => png([header(1, 1, { interlace: 2 }), pixel(), chunk("IEND")]),
    () => png([header(), chunk("IDAT", Buffer.from([1]))]),
    () => Buffer.concat([png(), Buffer.from([0])]),
    () => { const data = png(); data.writeUInt32BE(0x7fffffff, 33); return data; },
    () => { const data = png(); data[12] |= 0x80; return data; },
    () => { const data = chunk("tEXt"); data[4] |= 0x80; return png([header(), data, pixel(), chunk("IEND")]); },
  ])("rejects invalid structural PNG headers before decoding", async fixture => {
    const decoder = harmlessDecoder();
    await expect(validateMedia(fixture(), "image/png")).rejects.toMatchObject({ status: 400 });
    expect(decoder.create).not.toHaveBeenCalled();
  });

  it.each(["acTL", "fcTL", "fdAT"])("rejects APNG %s chunks before frame decoding", async type => {
    const decoder = harmlessDecoder();
    await expect(validateMedia(png([header(), pixel(), chunk(type, Buffer.alloc(26)), chunk("IEND")]), "image/png")).rejects.toMatchObject({ status: 400 });
    expect(decoder.create).not.toHaveBeenCalled();
  });

  it("accepts a synthetic one-pixel PNG through the real decoder", async () => {
    await expect(validateMedia(png(), "image/png")).resolves.toBeUndefined();
  });

  it("bounds dimensions inclusively at 24 megapixels", async () => {
    const decoder = harmlessDecoder();
    await expect(validateMedia(png([header(6000, 4000), pixel(), chunk("IEND")]), "image/png")).resolves.toBeUndefined();
    expect(decoder.embedPng).toHaveBeenCalledOnce();
  });

  it("does not pass unnecessary text metadata into the pixel decoder", async () => {
    const decoder = harmlessDecoder();
    // UPNG scans text terminators without a chunk bound. Pixel validation needs
    // none of that metadata, especially a malformed field with no terminator.
    await validateMedia(png([header(), chunk("iTXt", Buffer.from("no terminator")), pixel(), chunk("IEND")]), "image/png");
    expect(Buffer.from(decoder.embedPng.mock.calls[0][0]).includes(Buffer.from("iTXt"))).toBe(false);
  });

  it.each([[65000, 65000], [0, 1], [1, 0]])("rejects unsafe JPEG frame dimensions %dx%d before embedding", async (width, height) => {
    const decoder = harmlessDecoder();
    await expect(validateMedia(jpegHeader(width, height), "image/jpeg")).rejects.toMatchObject({ status: 400 });
    expect(decoder.create).not.toHaveBeenCalled();
  });

  it("rejects truncated JPEG segments before embedding", async () => {
    const decoder = harmlessDecoder();
    await expect(validateMedia(jpegHeader(1, 1).subarray(0, 12), "image/jpeg")).rejects.toMatchObject({ status: 400 });
    expect(decoder.create).not.toHaveBeenCalled();
  });

  it("passes a bounded JPEG header with a dedicated byte buffer to the embedder", async () => {
    const decoder = harmlessDecoder();
    await validateMedia(jpegHeader(6000, 4000), "image/jpeg");
    const data = decoder.embedJpg.mock.calls[0][0] as Uint8Array;
    expect(data.byteOffset).toBe(0);
    expect(data.buffer.byteLength).toBe(data.byteLength);
  });
});
