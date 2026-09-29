import { z } from "zod";

/**
 * Soniox async speech-to-text for the autowriter's second pass. Soniox fetches
 * Wise's recording itself (`audio_url`), handles Thai/English code-switching in
 * one model, and tags every token with a speaker. Once the class is done with
 * it, a job is kept for review for at most 72 h, then deleted; we never store
 * the transcript itself.
 */
export const SONIOX_API_BASE = "https://api.soniox.com/v1";
export const SONIOX_MODEL = "stt-async-v5";
/** Async list price (2026-09): $0.10 per audio hour, diarization and language ID included. */
export const SONIOX_USD_PER_AUDIO_HOUR = 0.1;

export type SonioxStatus = "queued" | "processing" | "completed" | "error";

export interface SonioxToken {
  text: string;
  start_ms: number;
  end_ms?: number;
  speaker?: string;
  language?: string;
}

export interface SonioxClient {
  create(input: {
    audioUrl: string;
    terms: readonly string[];
    general: ReadonlyArray<{ key: string; value: string }>;
    clientReferenceId: string;
  }): Promise<{ id: string }>;
  get(id: string): Promise<{ status: SonioxStatus; audioDurationMs: number | null; errorMessage: string | null }>;
  transcript(id: string): Promise<{ text: string; tokens: SonioxToken[] }>;
  /** Resolves when the job is gone (deleted now, or already missing); throws otherwise. */
  remove(id: string): Promise<"deleted" | "missing">;
  /** Newest-first page of this project's jobs (for the orphan reaper). */
  list(limit: number): Promise<Array<{ id: string; createdAt: Date | null; clientReferenceId: string | null; status: string }>>;
}

const CreatedSchema = z.object({ id: z.string().min(1) }).passthrough();
const StatusSchema = z.object({
  status: z.enum(["queued", "processing", "completed", "error"]),
  audio_duration_ms: z.number().nullable().optional(),
  error_message: z.string().nullable().optional(),
}).passthrough();
const ListSchema = z.object({
  transcriptions: z.array(z.object({
    id: z.string(),
    status: z.string(),
    created_at: z.string().nullable().optional(),
    client_reference_id: z.string().nullable().optional(),
  }).passthrough()),
}).passthrough();
const TranscriptSchema = z.object({
  text: z.string(),
  tokens: z.array(z.object({
    text: z.string(),
    start_ms: z.number(),
    end_ms: z.number().optional(),
    speaker: z.union([z.string(), z.number()]).optional(),
    language: z.string().optional(),
  }).passthrough()),
}).passthrough();

export class SonioxError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
    this.name = "SonioxError";
  }
}

/** Cost of one transcription at list price. */
export function sonioxCostUsd(audioDurationMs: number): number {
  return (Math.max(0, audioDurationMs) / 3_600_000) * SONIOX_USD_PER_AUDIO_HOUR;
}

export function createSonioxClient(apiKey: string, fetchImpl: typeof fetch = fetch): SonioxClient {
  const request = async (path: string, init: RequestInit = {}, timeoutMs = 60_000): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetchImpl(`${SONIOX_API_BASE}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new SonioxError(`network_${error instanceof Error ? error.name : "Error"}`, null);
    }
    if (response.status === 204) return null;
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      // The timeout also covers reading the body (a long transcript): a typed error, like a failed request.
      throw new SonioxError(`network_${error instanceof Error ? error.name : "Error"}`, response.ok ? null : response.status);
    }
    if (!response.ok) throw new SonioxError(`HTTP ${response.status}: ${text.slice(0, 200)}`, response.status);
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      throw new SonioxError("invalid_json_response", response.status);
    }
  };

  return {
    async create(input) {
      const body = await request("/transcriptions", {
        method: "POST",
        body: JSON.stringify({
          model: SONIOX_MODEL,
          audio_url: input.audioUrl,
          language_hints: ["th", "en"],
          enable_speaker_diarization: true,
          enable_language_identification: true,
          context: { general: input.general, terms: input.terms },
          client_reference_id: input.clientReferenceId,
        }),
      });
      return { id: CreatedSchema.parse(body).id };
    },
    async get(id) {
      const body = StatusSchema.parse(await request(`/transcriptions/${encodeURIComponent(id)}`));
      return { status: body.status, audioDurationMs: body.audio_duration_ms ?? null, errorMessage: body.error_message ?? null };
    },
    async transcript(id) {
      const body = TranscriptSchema.parse(await request(`/transcriptions/${encodeURIComponent(id)}/transcript`));
      return {
        text: body.text,
        tokens: body.tokens.map((token) => ({
          text: token.text,
          start_ms: token.start_ms,
          end_ms: token.end_ms,
          speaker: token.speaker === undefined ? undefined : String(token.speaker),
          language: token.language,
        })),
      };
    },
    async remove(id) {
      try {
        await request(`/transcriptions/${encodeURIComponent(id)}`, { method: "DELETE" }, 15_000);
        return "deleted";
      } catch (error) {
        if (error instanceof SonioxError && error.status === 404) return "missing";
        throw error;
      }
    },
    async list(limit) {
      const body = ListSchema.parse(await request(`/transcriptions?limit=${Math.max(1, Math.min(1000, limit))}`, {}, 20_000));
      return body.transcriptions.map((item) => ({
        id: item.id,
        status: item.status,
        createdAt: item.created_at ? new Date(item.created_at) : null,
        clientReferenceId: item.client_reference_id ?? null,
      }));
    },
  };
}
