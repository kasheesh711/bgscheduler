import { isPreviewEnvironment } from "@/lib/preview-policy";
import { rosterWriterArm } from "./roster";
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

/**
 * Transcript first (owner decision, 30 Sep): every class that passes the gates waits for Wise's recording and is
 * written from its Soniox transcript; Wise's AI summary is only the fallback. Only the exact string `true` enables
 * it, and it acts only while the second pass is on (`autowriterTranscriptsEnabled` plus a Soniox key).
 */
export function autowriterTranscriptFirst(env: AutowriterEnvironment = process.env): boolean {
  return env.FEEDBACK_AUTOWRITER_TRANSCRIPT_FIRST === "true";
}

/**
 * Hold summary-only drafts (owner, 5 Oct 2026): a class that would be written from Wise's AI summary alone — no
 * transcript, or a transcript-first class that fell back — is held for the tutor before any model call. Audited
 * summary-only posts had a real error 5 times in 7 (homework left out not counted), and the nightly correction path
 * cannot repair them. Only the exact string `true` enables it; remove it once Zoom captions reach the writer.
 */
export function autowriterHoldSummaryOnly(env: AutowriterEnvironment = process.env): boolean {
  return env.FEEDBACK_AUTOWRITER_HOLD_SUMMARY_ONLY === "true";
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

/**
 * Optional LINE destination (user or group id) for the operating loop's critical incidents, pushed with the
 * existing LINE channel token. Unset: incidents go by email only.
 */
export function autowriterLineTo(env: AutowriterEnvironment = process.env): string | null {
  return value(env, "FEEDBACK_AUTOWRITER_LINE_TO") || null;
}

/** The Wise user the API key belongs to — the actor on every submit event we cause. */
export function wiseApiActorId(env: AutowriterEnvironment = process.env): string | null {
  return value(env, "WISE_USER_ID") || null;
}

/** A model and the route it is asked for on. */
export interface AutowriterModelRoute {
  arm: ModelArm;
  model: string;
  provider: OpenRouterProviderPreferences;
  /** When set, the response must come from this host and model or the call is an infra failure. */
  expectProvider?: string;
  expectModel?: string;
}

/** A model, its route and the reasoning effort it is called at. */
export interface AutowriterModelConfig extends AutowriterModelRoute {
  effort: "max" | "high" | "medium" | "low";
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
 * Judge: GLM 5.3 Flash pinned to Together. It has no effort of its own here: it runs at every effort in
 * `AUTOWRITER_JUDGE_EFFORTS` (v5). v4 (30 Sep) had moved it from `medium` to `high`: at `medium` it passed a draft
 * that gave another student's words to ours after ~100 reasoning tokens.
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
    arm: "glm", model: "z-ai/glm-5.3-flash", provider: GLM_ZDR_ROUTE,
    expectProvider: "Together", expectModel: "z-ai/glm-5.3-flash",
  },
} as const satisfies { writer: AutowriterModelConfig; fallbackWriter: AutowriterModelConfig; judge: AutowriterModelRoute };

/**
 * Judge v5 (owner decision, 30 Sep): every draft is judged at each of these efforts, in parallel on byte-identical
 * messages, and passes only when every level gives a complete verdict with `faithful: true`. In the 30 Sep replays
 * each level caught a wrong detail the other passed (1 of 5 drafts only at `high`, 2 of 9 only at `medium`).
 */
export const AUTOWRITER_JUDGE_EFFORTS = ["medium", "high"] as const satisfies ReadonlyArray<AutowriterModelConfig["effort"]>;

/** A writer call's time-out: Sol answers in ~6 s; the Luna fallback at reasoning `max` can take minutes. */
export const AUTOWRITER_WRITER_TIMEOUT_MS = 180_000;
/**
 * A judge call's time-out, by what the draft is judged against (owner decision, 30 Sep). A summary is short; on
 * hour-long transcripts the `high` judge's p90 was 63 s in the 30 Sep replay, and it once timed out at 120 s.
 */
export const AUTOWRITER_JUDGE_TIMEOUT_MS = { summary: 120_000, transcript: 240_000 } as const;
/**
 * Every model call ends at least this long before the function's deadline (its time-out is cut to fit). A judge is
 * never started without its full time-out: cut short, it could not finish.
 */
export const AUTOWRITER_CALL_DEADLINE_MARGIN_MS = 45_000;
/**
 * In-run retries of a rate-limited model call (owner decision, 30 Sep). A rate limit on a route usually clears within
 * seconds (the writer's came as HTTP 200 with code 429 in the body), so the same request is sent again after each of
 * these waits instead of the class waiting for the next sweep: up to three retries per call.
 */
export const AUTOWRITER_RATE_LIMIT_RETRY_WAITS_MS = [4_000, 10_000, 25_000] as const;
/** Each wait is spread ±30% at random, so classes that end at the same time do not retry at the same time. */
export const AUTOWRITER_RATE_LIMIT_RETRY_JITTER = 0.3;
/**
 * A wait OpenRouter itself asks for (`Retry-After`, its rate limit's reset time) is kept, up to this long: never a
 * retry before it, and never a wait shorter than the schedule's. A longer one — or one longer than what is left of
 * the call's total below — is not cut short: the call is not tried again in this run.
 */
export const AUTOWRITER_RATE_LIMIT_RETRY_AFTER_MAX_MS = 30_000;
/** One call's waits never add up to more than this: the schedule's last wait is cut to fit. */
export const AUTOWRITER_RATE_LIMIT_RETRY_MAX_TOTAL_WAIT_MS = 45_000;

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

/**
 * The writers a tutor's class is drafted with, in order (owner decision, 2 Oct): Sol then the Luna fallback, or — for
 * the tutors whose roster entries say `writer: "luna"` (the 13 added that day) — Luna first and Sol as their fallback.
 * Keyed by the canonical tutor key, so both of a tutor's Wise accounts write the same way.
 */
export function writersFor(canonicalTutorKey: string | null | undefined): AutowriterModelConfig[] {
  return rosterWriterArm(canonicalTutorKey) === "luna"
    ? [AUTOWRITER_MODELS.fallbackWriter, AUTOWRITER_MODELS.writer]
    : [AUTOWRITER_MODELS.writer, AUTOWRITER_MODELS.fallbackWriter];
}

/** A session with no summary yet is retried this often … */
export const AUTOWRITER_RETRY_DELAY_MS = 10 * 60 * 1000;
/** … and alerted once when it still has none this long after the class ended. */
export const AUTOWRITER_NO_SUMMARY_ALERT_MS = 3 * 60 * 60 * 1000;
/**
 * A POST is only claimed when at least this much function time remains: the
 * POST phase's worst case is ~220 s (POST 60 s, pause 3 s, two 45 s reads,
 * event polling bounded by the remaining time). Checked twice: before the
 * three pre-POST Wise reads (up to 45 s each — none is made for a POST that
 * could not be claimed) and again right before the claim.
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
 * One session's work after Wise is ready. The sweep starts a session only with this much time left, and a webhook's
 * waits (Wise's summary, Soniox) never eat into it. Every entry point (webhook, cron, Data Health run) has a 740 s
 * budget under `maxDuration` 800, and every model call ends by the deadline − 45 s, so no call outlives the function.
 * After the slowest writer call (180 s) at least 335 s are left, so the judges (in parallel) always get their full
 * time-out — 240 s on a transcript, 120 s on a summary — unless the reads before the writer took over 95 s; the
 * pipeline never starts a judge without it (the class then retries with a fresh function). Worst case, the POST
 * phase (240 s) no longer fits after a transcript draft (560 − 180 − 240 = 140 s): the judged draft is kept and the
 * next run posts it without calling a model. After a summary draft it fits with 20 s to spare (560 − 180 − 120 =
 * 260 s) — when no call was rate limited, see below.
 * A rate-limited call's in-run retries (`AUTOWRITER_RATE_LIMIT_RETRY_WAITS_MS`) keep to the same rule: a retry is made
 * only when its wait and the call's whole time-out still end by the deadline − 45 s, so they add at most 45 s of
 * waiting to a call, never start a judge without its full time-out and never let a call outlive the function. The
 * time they take comes out of what is left for the POST, which is claimed only with its 240 s (as above). Once the
 * waits add up to more than those 20 s — one call that used all three retries waits 27–45 s — a summary's worst
 * case no longer posts in the same run either: 260 − 45 = 215 s are left after one such call, 170 s after two (the
 * writer, then the judges). Its draft is kept on the row, but only a transcript draft is posted as stored: the next
 * run writes a summary again.
 */
export const AUTOWRITER_SWEEP_MIN_REMAINING_MS = 560_000;
/**
 * A due class whose feedback deadline (`deadline_at`) is this close is started first in a sweep, whatever it needs,
 * soonest deadline first. The sweep expires a class `AUTOWRITER_DEADLINE_MARGIN_MS` (30 min) before that deadline, so
 * these are the classes with at most 2.5 h of tries left.
 */
export const AUTOWRITER_SWEEP_NEAR_DEADLINE_MS = 3 * 60 * 60 * 1000;
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
/**
 * Transcript first: a class still without a recording this long after its scheduled end is written from the
 * summary instead (`summaryFallback`, cause `no_recording`), rather than alerted. Measured 30 Sep (first Wise
 * `RecordingCompletedEvent` − scheduled end, 16–29 Sep, 453 classes): median 34 min, p95 71 min, 1 class over 3 h.
 */
export const AUTOWRITER_TRANSCRIPT_FIRST_FALLBACK_MS = 3 * 60 * 60 * 1000;
/**
 * Transcript first: runs in a row that end in a failure of the writer on a class's transcript draft (a time-out, a
 * reply that is not JSON, a provider error, an unusable route) before the class is written from the summary instead
 * (`summaryFallback`, cause `writer_failed`; owner default, 30 Sep) rather than retried every 10 min until its
 * deadline. Only the writer's failures count (owner decision, 30 Sep): a judge failure just retries. The count starts
 * again when a run ends in a judge failure or with a stored draft — not whenever a writer delivers one: a run in
 * which a judge rejects Sol's draft and the Luna fallback then fails is a writer failure and counts (owner decision,
 * 30 Sep 17:00). Wise and Soniox errors are counted apart.
 */
export const AUTOWRITER_MAX_WRITER_ERRORS = 3;
/**
 * A run of failures is the runs in a row that end at the judge stage on one class, with no answer of the judge in
 * between. This many failures of the judge itself in it (a judge level timing out, giving no verdict in two tries,
 * answering from the wrong route or model, a provider error) raise one `judge_failing` alert. The class keeps
 * retrying every 10 min, as decided (judge failures never fall back); the alert is dropped once the judge answers or
 * the class settles, and a later run of failures alerts again.
 */
export const AUTOWRITER_JUDGE_ERRORS_ALERT = 3;
/**
 * The higher mark, for all of a run of failures: the judge's own together with the runs in which it could not be
 * asked — its route rate limited, our OpenRouter account out of credit (or its key refused), our connection, or no
 * time left in our function to start it. Those are not the judge's failures and usually pass on their own (a rate
 * limit hits every class at once and clears within minutes), so without three failures of the judge itself a class
 * alerts only at this many runs.
 */
export const AUTOWRITER_JUDGE_STAGE_ERRORS_ALERT = 6;
/** Soniox jobs no row references are deleted once they are this old (orphans). */
export const AUTOWRITER_SONIOX_REAPER_AGE_MS = 2 * 60 * 60 * 1000;
/** Soniox deletes per sweep (each bounded by a 15 s time-out). */
export const AUTOWRITER_SONIOX_CLEANUP_MAX = 10;
