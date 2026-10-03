import { z } from "zod";
import { createSonioxClient, SONIOX_API_BASE, SONIOX_MODEL, SonioxError } from "@/lib/feedback-autowriter/soniox";
import { AUDIO_TYPES, MAX_AUDIO_BYTES } from "./model";

const REFERENCE_PATTERN = /^bg-capture:[a-zA-Z0-9:_-]{1,200}$/;
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,200}$/;
const PAGE_LIMIT = 100;
const MAX_PAGES = 5;
const MAX_DELETIONS = 20;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class CaptureSpeechError extends Error {
  constructor(readonly status: number | null, readonly uncertain = false) {
    super(status === null ? "Speech provider request could not be confirmed." : `Speech provider request failed (${status}).`);
    this.name = "CaptureSpeechError";
  }
}

export interface CaptureSpeechClient {
  upload(bytes: Uint8Array, mime: string, reference: string): Promise<string>;
  create(fileId: string, reference: string): Promise<string>;
  /** Duration is provider-measured after processing starts, never a pre-spend limit guarantee. */
  get(id: string): Promise<{ status: "queued" | "processing" | "completed" | "error"; audioDurationMs?: number }>;
  transcript(id: string): Promise<string>;
  transcriptDetails?(id: string): Promise<{ text: string; tokens: import("@/lib/feedback-autowriter/soniox").SonioxToken[] }>;
  removeJob(id: string): Promise<void>;
  removeFile(id: string): Promise<void>;
  /** Count of deleted resources, not captures. Partial failure throws so cleanup can retry. */
  reapOrphans(before: Date): Promise<number>;
}

const idSchema = z.object({ id: z.string().regex(ID_PATTERN) });
const jobSchema = z.object({
  id: z.string().regex(ID_PATTERN), created_at: z.string().nullish(), client_reference_id: z.string().nullish(),
  file_id: z.string().nullish(),
});
const fileSchema = z.object({
  id: z.string().regex(ID_PATTERN), created_at: z.string().nullish(), filename: z.string(), client_reference_id: z.string().nullish(),
});
const jobPageSchema = z.object({ transcriptions: z.array(jobSchema).max(PAGE_LIMIT), next_page_cursor: z.string().max(4096).nullish() });
const filePageSchema = z.object({ files: z.array(fileSchema).max(PAGE_LIMIT), next_page_cursor: z.string().max(4096).nullish() });

function checkedId(id: string) {
  if (!ID_PATTERN.test(id)) throw new CaptureSpeechError(400);
  return encodeURIComponent(id);
}

function checkedReference(reference: string) {
  if (!REFERENCE_PATTERN.test(reference)) throw new CaptureSpeechError(400);
  return reference;
}

function parsed<T>(schema: z.ZodType<T>, value: unknown, uncertain = false): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new CaptureSpeechError(502, uncertain);
  return result.data;
}

/** Private file uploads; tracking references are NOT provider idempotency keys. Never retry POST here. */
export function createCaptureSpeechClient(apiKey: string, fetchImpl: typeof fetch = fetch, options: { deadlineMs?: number } = {}): CaptureSpeechClient {
  if (!apiKey.trim()) throw new CaptureSpeechError(503);
  const boundedFetch: typeof fetch = (input, init) => {
    const remaining = (options.deadlineMs ?? Infinity) - Date.now();
    if (remaining <= 0) throw new CaptureSpeechError(503);
    return fetchImpl(input, Number.isFinite(remaining) ? { ...init, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(Math.ceil(remaining))]) } : init);
  };
  const existing = createSonioxClient(apiKey, boundedFetch);

  async function request(path: string, init: RequestInit = {}, allowMissing = false): Promise<unknown> {
    const creates = init.method === "POST";
    const timeoutMs = Math.min(creates && path === "/files" ? 120_000 : 20_000, (options.deadlineMs ?? Infinity) - Date.now());
    if (timeoutMs <= 0) throw new CaptureSpeechError(503);
    let response: Response;
    try {
      response = await fetchImpl(`${SONIOX_API_BASE}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${apiKey}`, ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }) },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch { throw new CaptureSpeechError(null, creates); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (allowMissing && response.status === 404) return null;
      throw new CaptureSpeechError(response.status, creates && response.status >= 500);
    }
    if (response.status === 204) return null;
    const reader = response.body?.getReader();
    if (!reader) return null;
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw new CaptureSpeechError(502, creates);
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const text = new TextDecoder().decode(bytes);
      return text ? JSON.parse(text) : null;
    } catch (error) {
      if (error instanceof CaptureSpeechError) throw error;
      throw new CaptureSpeechError(502, creates);
    } finally { await reader.cancel().catch(() => undefined); }
  }

  async function sanitized<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); }
    catch (error) { throw new CaptureSpeechError(error instanceof SonioxError ? error.status : 502); }
  }

  const client: CaptureSpeechClient = {
    async upload(bytes, mime, reference) {
      checkedReference(reference);
      if (!(AUDIO_TYPES as readonly string[]).includes(mime) || bytes.byteLength < 1 || bytes.byteLength > MAX_AUDIO_BYTES) throw new CaptureSpeechError(400);
      const extensions: Record<string, string> = { "audio/webm": "webm", "audio/mp4": "m4a", "audio/ogg": "ogg", "audio/wav": "wav" };
      const body = new FormData();
      body.set("file", new Blob([Uint8Array.from(bytes).buffer], { type: mime }), `${reference}.${extensions[mime]}`);
      body.set("client_reference_id", reference);
      return parsed(idSchema, await request("/files", { method: "POST", body }), true).id;
    },
    async create(fileId, reference) {
      checkedId(fileId);
      checkedReference(reference);
      const body = JSON.stringify({
        model: SONIOX_MODEL, file_id: fileId, language_hints: ["th", "en"],
        enable_speaker_diarization: true, enable_language_identification: true, client_reference_id: reference,
      });
      return parsed(idSchema, await request("/transcriptions", { method: "POST", body }), true).id;
    },
    async get(id) {
      checkedId(id);
      const result = await sanitized(() => existing.get(id));
      return { status: result.status, ...(result.audioDurationMs === null ? {} : { audioDurationMs: result.audioDurationMs }) };
    },
    async transcriptDetails(id) {
      checkedId(id);
      return sanitized(() => existing.transcript(id));
    },
    async transcript(id) {
      checkedId(id);
      const result = await sanitized(() => existing.transcript(id));
      return result.text;
    },
    async removeJob(id) {
      await request(`/transcriptions/${checkedId(id)}`, { method: "DELETE" }, true);
    },
    async removeFile(id) { await request(`/files/${checkedId(id)}`, { method: "DELETE" }, true); },
    async reapOrphans(before) {
      const cutoff = before.getTime();
      if (!Number.isFinite(cutoff) || cutoff > Date.now()) throw new CaptureSpeechError(400);
      const deadline = Math.min(Date.now() + 45_000, options.deadlineMs ?? Infinity);
      const checkBudget = () => {
        // Leave room for the next request's 20s timeout; do not spend the whole shared cron deadline here.
        if (Date.now() + 20_000 > deadline) throw new CaptureSpeechError(503);
      };
      const old = (date: string | null | undefined) => typeof date === "string" && Number.isFinite(Date.parse(date)) && Date.parse(date) < cutoff;
      const jobs: z.infer<typeof jobSchema>[] = [];
      const files: z.infer<typeof fileSchema>[] = [];
      // Finish each bounded scan before deleting so mutations cannot skip entries within that page walk.
      let cursor: string | null | undefined;
      const jobCursors = new Set<string>();
      for (let page = 0; page < MAX_PAGES; page += 1) {
        checkBudget();
        const query: URLSearchParams = new URLSearchParams({ limit: String(PAGE_LIMIT), ...(cursor ? { cursor } : {}) });
        const result: z.infer<typeof jobPageSchema> = parsed(jobPageSchema, await request(`/transcriptions?${query}`));
        jobs.push(...result.transcriptions);
        cursor = result.next_page_cursor;
        if (!cursor || jobCursors.has(cursor)) break;
        jobCursors.add(cursor);
      }
      let incompleteScan = !!cursor;
      let deleted = 0;
      let failed = false;
      const protectedFiles = new Set<string>();
      for (const job of jobs) {
        const owned = typeof job.client_reference_id === "string" && REFERENCE_PATTERN.test(job.client_reference_id);
        if (owned && old(job.created_at) && deleted >= MAX_DELETIONS) incompleteScan = true;
        if (!owned || !old(job.created_at) || deleted >= MAX_DELETIONS) {
          if (job.file_id) protectedFiles.add(job.file_id);
          continue;
        }
        checkBudget();
        try { await client.removeJob(job.id); deleted += 1; }
        catch { failed = true; if (job.file_id) protectedFiles.add(job.file_id); }
      }
      cursor = undefined;
      const fileCursors = new Set<string>();
      for (let page = 0; page < MAX_PAGES; page += 1) {
        checkBudget();
        const query: URLSearchParams = new URLSearchParams({ limit: String(PAGE_LIMIT), ...(cursor ? { cursor } : {}) });
        const result: z.infer<typeof filePageSchema> = parsed(filePageSchema, await request(`/files?${query}`));
        files.push(...result.files);
        cursor = result.next_page_cursor;
        if (!cursor || fileCursors.has(cursor)) break;
        fileCursors.add(cursor);
      }
      incompleteScan ||= !!cursor;
      for (const file of files) {
        const reference = file.client_reference_id ?? file.filename.replace(/\.(webm|m4a|ogg|wav)$/, "");
        if (REFERENCE_PATTERN.test(reference) && old(file.created_at) && !protectedFiles.has(file.id) && deleted >= MAX_DELETIONS) incompleteScan = true;
        if (!REFERENCE_PATTERN.test(reference) || !old(file.created_at) || protectedFiles.has(file.id) || deleted >= MAX_DELETIONS) continue;
        checkBudget();
        try { await client.removeFile(file.id); deleted += 1; }
        catch { failed = true; }
      }
      // A processing job can reject DELETE. Keep the failure visible and retry on the next cleanup run.
      // The caller must not treat a capped/cyclic shared-project scan as proof that no old orphans remain.
      if (failed || incompleteScan) throw new CaptureSpeechError(503);
      return deleted;
    },
  };
  return client;
}
