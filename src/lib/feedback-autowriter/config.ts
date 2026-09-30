import { isPreviewEnvironment } from "@/lib/preview-policy";
import type { ModelArm, OpenRouterProviderPreferences } from "./types";

type AutowriterEnvironment = Record<string, string | undefined>;

function value(env: AutowriterEnvironment, name: string): string {
  return env[name]?.trim() ?? "";
}

/** Outer gate: only the exact string `true` lets the cron or webhook do anything. */
export function autowriterEnabled(env: AutowriterEnvironment = process.env): boolean {
  return env.FEEDBACK_AUTOWRITER_ENABLED === "true";
}

/** Wise writes never happen from a preview deployment, whatever the control row says. */
export function autowriterWritesAllowedHere(env: AutowriterEnvironment = process.env): boolean {
  return !isPreviewEnvironment(env);
}

/**
 * Second pass: write from a Soniox transcript of Wise's recording when the AI
 * summary cannot carry the feedback. Only the exact string `true` enables it.
 */
export function autowriterTranscriptsEnabled(env: AutowriterEnvironment = process.env): boolean {
  return env.FEEDBACK_AUTOWRITER_TRANSCRIPTS_ENABLED === "true";
}

export function sonioxApiKey(env: AutowriterEnvironment = process.env): string | null {
  return value(env, "SONIOX_API_KEY") || null;
}

export function openRouterApiKey(env: AutowriterEnvironment = process.env): string | null {
  return value(env, "OPENROUTER_API_KEY") || null;
}

export function autowriterAlertEmails(env: AutowriterEnvironment = process.env): string[] {
  return [...new Set(value(env, "FEEDBACK_AUTOWRITER_ALERT_EMAILS")
    .split(/[\s,;]+/u)
    .map((email) => email.trim().toLowerCase())
    .filter((email) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(email)))];
}

/** The Wise user the API key belongs to — the actor on every submit event we cause. */
export function wiseApiActorId(env: AutowriterEnvironment = process.env): string | null {
  return value(env, "WISE_USER_ID") || null;
}

export interface AutowriterModelConfig {
  arm: ModelArm;
  model: string;
  provider: OpenRouterProviderPreferences;
  effort: "max" | "high" | "medium" | "low";
  /** When set, the response must come from this host and model or the call is an infra failure. */
  expectProvider?: string;
  expectModel?: string;
}

const GLM_ZDR_ROUTE: OpenRouterProviderPreferences = {
  order: ["together"],
  allow_fallbacks: false,
  zdr: true,
  data_collection: "deny",
  require_parameters: true,
};

/**
 * OpenAI models on zero-data-retention endpoints only (OpenRouter serves Sol
 * and Luna this way through Azure, verified 30 Sep). Not pinned to a host:
 * `zdr` itself restricts routing to hosts that retain nothing.
 */
const OPENAI_ZDR_ROUTE: OpenRouterProviderPreferences = {
  zdr: true,
  data_collection: "deny",
  require_parameters: true,
};

/**
 * Every route has zero data retention, so a summary or transcript never
 * reaches a retaining host, whichever model handles it.
 *
 * Writer: GPT-6.1 Sol, reasoning `low` (owner decision, 30 Sep). In a blind
 * comparison on 11 classes (same Soniox transcripts, v4 rules) 82% of Sol-low
 * drafts needed no real fix (0 critical, 0.9 real errors per 100 claims), vs
 * Luna 64% and GLM 30% (4.1 per 100). ≈ $0.04 per draft, ~6 s per call.
 * Fallback writer: GPT-6 Luna, reasoning `max`, on the same route.
 * Judge: GLM 5.3 Flash pinned to Together. Reasoning `high` since v4 (30 Sep): at
 * `medium` it passed a draft that gave another student's words to ours after
 * ~100 reasoning tokens.
 */
export const AUTOWRITER_MODELS = {
  writer: {
    arm: "sol", model: "openai/gpt-6.1-sol", provider: OPENAI_ZDR_ROUTE, effort: "low",
    expectModel: "openai/gpt-6.1-sol",
  },
  fallbackWriter: {
    arm: "luna", model: "openai/gpt-6-luna", provider: OPENAI_ZDR_ROUTE, effort: "max",
  },
  judge: {
    arm: "glm", model: "z-ai/glm-5.3-flash", provider: GLM_ZDR_ROUTE, effort: "high",
    expectProvider: "Together", expectModel: "z-ai/glm-5.3-flash",
  },
} as const satisfies Record<string, AutowriterModelConfig>;

/**
 * The writer config behind each arm, for the offline evaluation CLI
 * (`generateDraft`). GLM keeps the config it wrote with until 30 Sep; the
 * autowriter itself only uses `AUTOWRITER_MODELS`.
 */
export const AUTOWRITER_WRITER_BY_ARM: Record<ModelArm, AutowriterModelConfig> = {
  sol: AUTOWRITER_MODELS.writer,
  luna: AUTOWRITER_MODELS.fallbackWriter,
  glm: {
    arm: "glm", model: "z-ai/glm-5.3-flash", provider: GLM_ZDR_ROUTE, effort: "max",
    expectProvider: "Together", expectModel: "z-ai/glm-5.3-flash",
  },
};

/** A session with no summary yet is retried this often … */
export const AUTOWRITER_RETRY_DELAY_MS = 10 * 60 * 1000;
/** … and alerted once when it still has none this long after the class ended. */
export const AUTOWRITER_NO_SUMMARY_ALERT_MS = 3 * 60 * 60 * 1000;
/**
 * A POST is only claimed when at least this much function time remains: the
 * POST phase's worst case is ~220 s (POST 60 s, pause 3 s, two 45 s reads,
 * event polling bounded by the remaining time).
 */
export const AUTOWRITER_MIN_POST_BUDGET_MS = 240_000;
/**
 * Generation lease. Longer than a function may live (maxDuration 800 s), so a
 * live worker never loses its lease and an expired one always means a dead worker.
 */
export const AUTOWRITER_GENERATION_LEASE_MS = 14 * 60 * 1000;
/**
 * A `posting` row older than this is reconciled by reads only. The POST phase
 * is bounded by request time-outs (POST 60 s, reads 45 s each, event wait 20 s).
 */
export const AUTOWRITER_STALE_POSTING_MS = 6 * 60 * 1000;
/** The feedback POST request's time-out (also bounds the overwrite-check window when its end is unknown). */
export const AUTOWRITER_POST_TIMEOUT_MS = 60_000;
/** Every Wise read (including its paced retries) gives up after this long. */
export const AUTOWRITER_WISE_READ_TIMEOUT_MS = 45_000;
/**
 * One session's work after Wise is ready: writer (≤180 s) + judge (≤120 s) +
 * the POST budget. The sweep starts a session only with this much time left,
 * and a webhook's readiness wait never eats into it.
 */
export const AUTOWRITER_SWEEP_MIN_REMAINING_MS = 560_000;
/** While another POST is in flight, re-try the guarded submit this often … */
export const AUTOWRITER_POST_IN_FLIGHT_WAIT_MS = 10_000;
/** … at most this many times before leaving the session for the next sweep. */
export const AUTOWRITER_POST_IN_FLIGHT_ATTEMPTS = 8;
/** No confirming Wise event this long after the POST → verify_failed + halt. */
export const AUTOWRITER_EVENT_DEADLINE_MS = 2 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Second pass (Soniox transcript)
// ---------------------------------------------------------------------------

/** A summary at least this Thai (share of Thai among Thai + Latin letters) goes to the transcript pass. */
export const AUTOWRITER_THAI_SUMMARY_SHARE = 0.5;
/** Still no usable summary this long after the class end → wait for the recording instead. */
export const AUTOWRITER_NO_SUMMARY_HANDOVER_MINUTES = 30;
/** How often a class waiting for Wise's recording is re-checked (a RecordingCompletedEvent skips the wait). */
export const AUTOWRITER_RECORDING_RECHECK_MS = 30 * 60 * 1000;
/** A submitted Soniox job is checked again after this long when it was not done in-invocation. */
export const AUTOWRITER_TRANSCRIBING_RECHECK_MS = 5 * 60 * 1000;
/** In-invocation wait for Soniox (an hour of audio took 2–7 min in the pilot). */
export const AUTOWRITER_TRANSCRIBE_WAIT_MS = 180_000;
/**
 * Zoom's name-labelled transcript is published a few minutes after the recording (5.5 min on the first live
 * class): keep waiting for it until this long after the Soniox job was submitted, so TUTOR/STUDENT are
 * confirmed, before falling back to talk share …
 */
export const AUTOWRITER_ZOOM_TRANSCRIPT_WAIT_MS = 20 * 60 * 1000;
/**
 * … due again after this long (the job is kept; re-fetching its transcript is free). Without a webhook the
 * next backstop sweep (~every 15 min) is the next look, so the last look can land up to ~35 min after submit.
 */
export const AUTOWRITER_ZOOM_TRANSCRIPT_RECHECK_MS = 5 * 60 * 1000;
/** A Soniox job still queued or processing this long after it was submitted is abandoned (deleted, counted as an error). */
export const AUTOWRITER_TRANSCRIBE_TIMEOUT_MS = 60 * 60 * 1000;
export const AUTOWRITER_TRANSCRIBE_POLL_MS = 10_000;
/** Soniox failures on one class before it is held for a person. */
export const AUTOWRITER_MAX_TRANSCRIBE_ERRORS = 3;
/** Unexpected errors on one class before it is held for a person (instead of retrying until the deadline). */
export const AUTOWRITER_MAX_GENERIC_ERRORS = 3;
/** A finished class keeps its Soniox transcript this long for review (triage), then the sweep deletes it. */
export const AUTOWRITER_SONIOX_RETAIN_MS = 72 * 60 * 60 * 1000;
/** A rendered transcript shorter than this is not enough to write from. */
export const AUTOWRITER_MIN_TRANSCRIPT_CHARACTERS = 800;
/** Still waiting for the recording this long after class → `no_recording` alert (not only at the deadline). */
export const AUTOWRITER_NO_RECORDING_ALERT_MS = 3 * 60 * 60 * 1000;
/** Soniox jobs no row references are deleted once they are this old (orphans). */
export const AUTOWRITER_SONIOX_REAPER_AGE_MS = 2 * 60 * 60 * 1000;
/** Soniox deletes per sweep (each bounded by a 15 s time-out). */
export const AUTOWRITER_SONIOX_CLEANUP_MAX = 10;
