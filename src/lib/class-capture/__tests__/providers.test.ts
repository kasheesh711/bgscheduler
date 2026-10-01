import { afterEach, describe, expect, it, vi } from "vitest";
import { createCaptureSpeechClient } from "../providers";

const OLD = "2026-09-29T00:00:00Z";
const NEW = "2026-10-01T12:00:00Z";
const BEFORE = new Date("2026-09-30T00:00:00Z");
const REFERENCE = "bg-capture:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
afterEach(() => vi.restoreAllMocks());

function provider(responses: Array<{ status?: number; body?: unknown; fail?: boolean }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error("Unexpected provider request");
    if (next.fail) throw new Error("sensitive provider transport details");
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status ?? 200 });
  });
  return { client: createCaptureSpeechClient("synthetic-key", fetchImpl as typeof fetch), calls };
}

describe("capture speech provider", () => {
  it("uploads private bytes as authenticated multipart and creates a Thai/English file job without a public URL", async () => {
    const { client, calls } = provider([{ status: 201, body: { id: "file-1" } }, { status: 201, body: { id: "job-1" } }]);
    expect(await client.upload(new Uint8Array([26, 69, 223, 163]), "audio/webm", REFERENCE)).toBe("file-1");
    expect(await client.create("file-1", REFERENCE)).toBe("job-1");
    const form = calls[0].init.body as FormData;
    const file = form.get("file") as File;
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([26, 69, 223, 163]);
    expect(file.type).toBe("audio/webm");
    expect(file.name).toBe(`${REFERENCE}.webm`);
    expect(form.get("client_reference_id")).toBe(REFERENCE);
    expect(new Headers(calls[0].init.headers).get("authorization")).toBe("Bearer synthetic-key");
    expect(new Headers(calls[0].init.headers).has("content-type")).toBe(false);
    expect(JSON.parse(String(calls[1].init.body))).toEqual({
      model: "stt-async-v5", file_id: "file-1", language_hints: ["th", "en"],
      enable_speaker_diarization: true, enable_language_identification: true, client_reference_id: REFERENCE,
    });
  });

  it("rejects foreign references, non-audio MIME and empty bytes before transport", async () => {
    const { client, calls } = provider([]);
    await expect(client.upload(new Uint8Array([1]), "audio/webm", "another-app:1")).rejects.toThrow();
    await expect(client.upload(new Uint8Array([1]), "image/jpeg", REFERENCE)).rejects.toThrow();
    await expect(client.upload(new Uint8Array(), "audio/webm", REFERENCE)).rejects.toThrow();
    await expect(client.create("file-1", "bg-capture:")).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("reads mixed-language transcription and deletes both object types idempotently", async () => {
    const { client, calls } = provider([
      { body: { status: "completed" } },
      { body: { text: "วันนี้เรียน fractions", tokens: [] } },
      { status: 204 }, { status: 404, body: { error: "already gone" } },
    ]);
    expect(await client.get("job-1")).toEqual({ status: "completed" });
    expect(await client.transcript("job-1")).toBe("วันนี้เรียน fractions");
    await client.removeJob("job-1");
    await client.removeFile("file-1");
    expect(calls.slice(2).map(call => [call.init.method, call.url])).toEqual([
      ["DELETE", "https://api.soniox.com/v1/transcriptions/job-1"],
      ["DELETE", "https://api.soniox.com/v1/files/file-1"],
    ]);
  });

  it("never retries a create with an uncertain outcome and never exposes provider error bodies", async () => {
    const { client, calls } = provider([{ fail: true }]);
    await expect(client.create("file-1", REFERENCE)).rejects.toMatchObject({ name: "CaptureSpeechError", uncertain: true });
    expect(calls).toHaveLength(1);
    const failed = provider([{ status: 402, body: { error: "real student and secret key" } }]);
    await expect(failed.client.get("job-1")).rejects.toMatchObject({ name: "CaptureSpeechError", status: 402, message: "Speech provider request failed (402)." });
  });

  it("exposes the provider-measured duration for the caller's post-transcription review", async () => {
    const { client } = provider([{ body: { status: "completed", audio_duration_ms: 180_001 } }]);
    expect(await client.get("job-1")).toEqual({ status: "completed", audioDurationMs: 180_001 });
  });

  it("reaps only old capture jobs/files, follows opaque cursors, and deletes jobs before files", async () => {
    const { client, calls } = provider([
      { body: { transcriptions: [
        { id: "ours-old", created_at: OLD, client_reference_id: REFERENCE, file_id: "file-old", status: "completed" },
        { id: "online-other", created_at: OLD, client_reference_id: "autowriter:1", file_id: "file-other", status: "completed" },
        { id: "ours-new", created_at: NEW, client_reference_id: REFERENCE, file_id: "file-new", status: "completed" },
      ], next_page_cursor: "next & page" } },
      { body: { transcriptions: [], next_page_cursor: null } },
      { status: 204 },
      { body: { files: [
        { id: "file-old", filename: `${REFERENCE}.webm`, created_at: OLD },
        { id: "file-other", filename: "autowriter.webm", created_at: OLD },
        { id: "file-new", filename: `${REFERENCE}.webm`, created_at: NEW },
        { id: "bad-date", filename: `${REFERENCE}.webm`, created_at: "invalid" },
      ], next_page_cursor: null } },
      { status: 204 },
    ]);
    expect(await client.reapOrphans(BEFORE)).toBe(2);
    expect(calls[1].url).toContain("cursor=next+%26+page");
    expect(calls.filter(call => call.init.method === "DELETE").map(call => call.url)).toEqual([
      "https://api.soniox.com/v1/transcriptions/ours-old", "https://api.soniox.com/v1/files/file-old",
    ]);
  });

  it("keeps a referenced file if its processing job cannot yet be deleted", async () => {
    const { client, calls } = provider([
      { body: { transcriptions: [{ id: "busy", created_at: OLD, client_reference_id: REFERENCE, file_id: "busy-file", status: "processing" }], next_page_cursor: null } },
      { status: 400, body: { error: "currently processing" } },
      { body: { files: [{ id: "busy-file", filename: `${REFERENCE}.webm`, created_at: OLD }], next_page_cursor: null } },
    ]);
    await expect(client.reapOrphans(BEFORE)).rejects.toMatchObject({ name: "CaptureSpeechError" });
    expect(calls.some(call => call.init.method === "DELETE" && call.url.endsWith("/files/busy-file"))).toBe(false);
  });

  it("caps paginated scans and refuses an unsafe future deletion cutoff", async () => {
    const { client, calls } = provider(Array.from({ length: 10 }, (_, i) => ({ body: {
      ...(i < 5 ? { transcriptions: [] } : { files: [] }), next_page_cursor: `page-${i}`,
    } })));
    await expect(client.reapOrphans(BEFORE)).rejects.toMatchObject({ name: "CaptureSpeechError", status: 503 });
    expect(calls).toHaveLength(10);
    await expect(client.reapOrphans(new Date(Date.now() + 60_000))).rejects.toThrow();
    expect(calls).toHaveLength(10);
  });

  it("stops a slow orphan scan within its budget so the existing cron can keep running", async () => {
    let now = Date.parse("2026-10-01T12:00:00Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetchImpl = vi.fn(async () => {
      now += 30_000;
      return new Response(JSON.stringify({ transcriptions: [], next_page_cursor: "another-page" }));
    });
    const client = createCaptureSpeechClient("synthetic-key", fetchImpl as typeof fetch);
    await expect(client.reapOrphans(BEFORE)).rejects.toMatchObject({ name: "CaptureSpeechError", status: 503 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("never calls a capped deletion scan complete when old capture files remain", async () => {
    const { client, calls } = provider([
      { body: { transcriptions: [], next_page_cursor: null } },
      { body: { files: Array.from({ length: 21 }, (_, i) => ({ id: `file-${i}`, filename: `${REFERENCE}.webm`, created_at: OLD })), next_page_cursor: null } },
      ...Array.from({ length: 20 }, () => ({ status: 204 })),
    ]);
    await expect(client.reapOrphans(BEFORE)).rejects.toMatchObject({ status: 503 });
    expect(calls.filter(call => call.init.method === "DELETE")).toHaveLength(20);
  });
  it("does not start a cleanup request after the shared deadline", async () => {
    const fetchImpl = vi.fn();
    const client = createCaptureSpeechClient("synthetic-key", fetchImpl as typeof fetch, { deadlineMs: Date.now() - 1 });
    await expect(client.removeJob("job-1")).rejects.toMatchObject({ status: 503 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
