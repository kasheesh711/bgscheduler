import {
  AUTOWRITER_CALL_DEADLINE_MARGIN_MS,
  AUTOWRITER_RATE_LIMIT_RETRY_AFTER_MAX_MS,
  AUTOWRITER_RATE_LIMIT_RETRY_JITTER,
  AUTOWRITER_RATE_LIMIT_RETRY_MAX_TOTAL_WAIT_MS,
  AUTOWRITER_RATE_LIMIT_RETRY_WAITS_MS,
} from "./config";
import type { OpenRouterProviderPreferences } from "./types";

export const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";

export interface OpenRouterUsage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  /** USD as billed by OpenRouter; null when the response omitted it. */
  costUsd: number | null;
}

export type OpenRouterCallResult =
  | {
    ok: true;
    content: string;
    model: string | null;
    provider: string | null;
    generationId: string | null;
    finishReason: string | null;
    usage: OpenRouterUsage;
    latencyMs: number;
  }
  | {
    ok: false;
    error: string;
    httpStatus: number | null;
    model: string | null;
    provider: string | null;
    finishReason: string | null;
    usage: OpenRouterUsage | null;
    latencyMs: number;
    /** A rate limit only: how long OpenRouter asked us to wait before trying again, when it said. */
    retryAfterMs?: number;
  };

export type OpenRouterCallFailure = Extract<OpenRouterCallResult, { ok: false }>;

/** An error as OpenRouter reports it in a response body: for the whole response, or on a choice. */
interface ReportedError {
  message?: string;
  code?: number | string;
  metadata?: { headers?: unknown };
}

interface ChatCompletionResponse {
  id?: string;
  model?: string;
  provider?: string;
  error?: ReportedError;
  choices?: Array<{ finish_reason?: string | null; message?: { content?: string | null }; error?: ReportedError }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function parseOpenRouterUsage(usage: ChatCompletionResponse["usage"]): OpenRouterUsage | null {
  if (!usage) return null;
  return {
    promptTokens: number(usage.prompt_tokens),
    completionTokens: number(usage.completion_tokens),
    reasoningTokens: number(usage.completion_tokens_details?.reasoning_tokens),
    cachedTokens: number(usage.prompt_tokens_details?.cached_tokens),
    costUsd: typeof usage.cost === "number" && Number.isFinite(usage.cost) ? usage.cost : null,
  };
}

/** The code of a rate limit, as a number or as text. */
function isRateLimitCode(code: ReportedError["code"]): boolean {
  return code === 429 || (typeof code === "string" && code.trim() === "429");
}

/**
 * The values of a `Retry-After` header. A header sent more than once reaches us as one list ("60, 120"); an HTTP
 * date has a comma of its own, after its weekday ("Wed, 30 Sep 2026 09:20:12 GMT"), which stays with what follows it.
 */
function retryAfterValues(header: string): string[] {
  const parts = header.split(",").map((part) => part.trim());
  const values: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    if (/^(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*$/iu.test(parts[index]) && index + 1 < parts.length) {
      values.push(`${parts[index]}, ${parts[index + 1]}`);
      index += 1;
    } else {
      values.push(parts[index]);
    }
  }
  return values;
}

/**
 * How long OpenRouter asks us to wait after a rate limit, when it says. Null when it names no time still ahead.
 * - `Retry-After` (seconds, or an HTTP date): the response's own header, or the one listed with the reported error
 *   (`metadata.headers` in the body). A header that names no time ahead (empty, `0`, a past date) does not hide the
 *   error's. A header sent more than once ("60, 120") asks for the longest of its waits: a retry before it would
 *   only be rate limited again.
 * - The reset time of OpenRouter's own limit (`X-RateLimit-Reset`, epoch milliseconds or seconds): only as listed
 *   with the error. A response header of that name describes whichever limit the response carries, not
 *   necessarily the one that refused this request.
 */
function retryAfterMs(response: Response, error: ReportedError | undefined, now: number): number | null {
  const listed = error?.metadata?.headers;
  const inBody = listed && typeof listed === "object" ? Object.entries(listed) : [];
  const ofError = (name: string): string | null => {
    const [, value] = inBody.find(([key]) => key.toLowerCase() === name) ?? [];
    return typeof value === "string" || typeof value === "number" ? String(value) : null;
  };
  const ahead = (waitMs: number) => Number.isFinite(waitMs) && Math.round(waitMs) > 0 ? Math.round(waitMs) : null;
  for (const header of [response.headers.get("retry-after"), ofError("retry-after")]) {
    const waits = retryAfterValues(header ?? "")
      .map((retryAfter) => ahead(/^\d+(?:\.\d+)?$/u.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - now))
      .filter((waitMs) => waitMs !== null);
    if (waits.length > 0) return Math.max(...waits);
  }
  const reset = Number(ofError("x-ratelimit-reset")?.trim() || Number.NaN);
  return Number.isFinite(reset) && reset > 0 ? ahead((reset < 1e12 ? reset * 1000 : reset) - now) : null;
}

/**
 * One OpenRouter chat completion with a strict JSON schema: one request. A failed or truncated call is recorded as
 * a failure of that model; only a rate limit is tried again, by `callWithRateLimitRetries`.
 */
export async function callOpenRouter(input: {
  apiKey: string;
  model: string;
  provider: OpenRouterProviderPreferences;
  messages: Array<{ role: "system" | "user"; content: string }>;
  schemaName: string;
  schema: object;
  effort: "max" | "high" | "medium" | "low";
  maxTokens: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): Promise<OpenRouterCallResult> {
  const started = Date.now();
  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(OPENROUTER_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "BGScheduler feedback autowriter",
      },
      body: JSON.stringify({
        model: input.model,
        provider: input.provider,
        messages: input.messages,
        reasoning: { effort: input.effort },
        max_tokens: input.maxTokens,
        response_format: {
          type: "json_schema",
          json_schema: { name: input.schemaName, strict: true, schema: input.schema },
        },
      }),
      signal: AbortSignal.timeout(input.timeoutMs),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    return {
      ok: false, error: name === "TimeoutError" ? "timeout" : `network_${name}`, httpStatus: null,
      model: null, provider: null, finishReason: null, usage: null, latencyMs: Date.now() - started,
    };
  }

  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    // The timeout also covers reading the body: a slow reply ends here as a timeout, not an unhandled error.
    const name = error instanceof Error ? error.name : "Error";
    return {
      ok: false, error: name === "TimeoutError" ? "timeout" : `network_${name}`, httpStatus: response.status,
      model: null, provider: null, finishReason: null, usage: null, latencyMs: Date.now() - started,
    };
  }
  const latencyMs = Date.now() - started;
  let body: ChatCompletionResponse | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as ChatCompletionResponse;
  } catch {
    // Not JSON: handled with a reply that is JSON but no object (`null`, a bare string), below.
  }
  if (!body) {
    // An HTTP 429 is a rate limit whatever its body (a proxy's error page), and may still say how long to wait.
    const waitMs = response.status === 429 ? retryAfterMs(response, undefined, Date.now()) : null;
    return {
      ok: false, error: "invalid_json_response", httpStatus: response.status,
      model: null, provider: null, finishReason: null, usage: null, latencyMs, ...(waitMs !== null ? { retryAfterMs: waitMs } : {}),
    };
  }
  const usage = parseOpenRouterUsage(body.usage);
  const choice = body.choices?.[0];
  const finishReason = choice?.finish_reason ?? null;
  const common = { model: body.model ?? null, provider: body.provider ?? null, finishReason, latencyMs };
  // OpenRouter reports some failures inside a 200 response, with the status in the body: an upstream rate limit
  // comes as HTTP 200 with `error.code` 429 (seen 30 Sep). The failure's status is then the body's, so a rate
  // limit is never taken for the model's own failure (pipeline.ts `callFailure`). A rate limit is read in every
  // form it may take there: the code as a number or as text ("429"), on the response or carried on the choice
  // (`choices[0].error`, as with `finish_reason: "error"`). Only a 429 is read this way: any other error on a choice,
  // and any other code given as text, stays what it was (`finish_reason_…`, the response's own status).
  const reported = body.error ?? (isRateLimitCode(choice?.error?.code) ? choice?.error : undefined);
  if (!response.ok || reported) {
    const httpStatus = !response.ok ? response.status
      : typeof reported?.code === "number" ? reported.code
        : isRateLimitCode(reported?.code) ? 429 : response.status;
    const message = (reported?.message ?? `HTTP ${httpStatus}`).slice(0, 300);
    const waitMs = httpStatus === 429 ? retryAfterMs(response, reported, Date.now()) : null;
    return { ok: false, error: message, httpStatus, usage, ...common, ...(waitMs !== null ? { retryAfterMs: waitMs } : {}) };
  }
  const content = choice?.message?.content ?? "";
  if (finishReason !== "stop") {
    return { ok: false, error: `finish_reason_${finishReason ?? "missing"}`, httpStatus: response.status, usage, ...common };
  }
  if (!content.trim()) {
    return { ok: false, error: "empty_content", httpStatus: response.status, usage, ...common };
  }
  return {
    ok: true,
    content,
    generationId: body.id ?? null,
    usage: usage ?? { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedTokens: 0, costUsd: null },
    ...common,
  };
}

/** A rate limit: OpenRouter's own (HTTP 429), or the model's upstream one (HTTP 200 with code 429 in the body). */
export function isRateLimited(call: OpenRouterCallResult): call is OpenRouterCallFailure {
  return !call.ok && call.httpStatus === 429;
}

/**
 * The wait before retry number `retry` (from 0) of a rate-limited call, or null when it is not tried again.
 * - The schedule's wait, anywhere within ±30% (`random` in [0, 1)); one call's waits never add up to more than 45 s,
 *   so the schedule's last wait is cut to what is left of them.
 * - When OpenRouter named a wait (`askedMs`): never before it, and never less than the schedule's wait — a wait of a
 *   second or less would otherwise spend every retry at once. The spread only adds to what it asked, up to 30 s.
 * - A wait it asks for is never cut short (a retry before the time it named would only be rate limited again): one
 *   longer than 30 s, or than what is left of the call's 45 s, ends the retries.
 */
function retryWaitMs(askedMs: number | undefined, retry: number, waitedMs: number, random: number): number | null {
  const leftMs = AUTOWRITER_RATE_LIMIT_RETRY_MAX_TOTAL_WAIT_MS - waitedMs;
  const spread = AUTOWRITER_RATE_LIMIT_RETRY_JITTER * random;
  let waitMs = AUTOWRITER_RATE_LIMIT_RETRY_WAITS_MS[retry] * (1 - AUTOWRITER_RATE_LIMIT_RETRY_JITTER + 2 * spread);
  if (askedMs !== undefined) {
    if (askedMs > Math.min(AUTOWRITER_RATE_LIMIT_RETRY_AFTER_MAX_MS, leftMs)) return null;
    waitMs = Math.max(waitMs, Math.min(AUTOWRITER_RATE_LIMIT_RETRY_AFTER_MAX_MS, askedMs * (1 + spread)));
  }
  waitMs = Math.round(Math.min(waitMs, leftMs));
  return waitMs > 0 ? waitMs : null;
}

/** A rate-limited attempt that was tried again: its reply, when its request was sent (epoch ms) and the wait that followed. */
export type RateLimitedAttempt = OpenRouterCallFailure & { startedAt: number; waitedMs: number };

/**
 * One model call, tried again in the same run while it is rate limited (owner decision, 30 Sep): the same request,
 * up to three more times, after about 4 s, 10 s and 25 s — each ±30% at random. A wait OpenRouter asks for is kept
 * (`retryWaitMs`): never a retry before it, and one it asks for that does not fit ends the retries. One call's waits
 * never add up to more than 45 s. Any other result — an answer, a time-out, a provider error, a reply that is not
 * JSON — is returned as it is: this retries rate limits only. `abandon` is asked before each wait and again after it,
 * so a retry that can no longer change anything is neither waited for nor sent.
 *
 * Never past the run's time: a retry is made only when its wait and the request's whole time-out still end before
 * the function's deadline margin (`remainingMs` − 45 s), the rule every model call starts under. Otherwise the rate
 * limit is returned at once, as before: the class is retried at the next sweep.
 *
 * Returns the last attempt and when its request was sent, and before it every attempt that was rate limited and
 * tried again (oldest first): each was a real request, so the caller records each as its own call.
 */
export async function callWithRateLimitRetries<ModelRequest extends { timeoutMs: number }>(input: {
  call: (request: ModelRequest) => Promise<OpenRouterCallResult>;
  request: ModelRequest;
  /** The function's time left. */
  remainingMs: () => number;
  /** False: one request only — a rate limit is returned at once, as before the retries (a sweep that met a lasting one). */
  retries?: boolean;
  /**
   * Asked before each wait, and again after it (before the retry is sent): true when a retry can no longer change
   * anything, so none is made.
   */
  abandon?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  /** A number in [0, 1), like `Math.random`. */
  random?: () => number;
}): Promise<{
  call: OpenRouterCallResult;
  /** When the last attempt's request was sent (epoch ms). */
  startedAt: number;
  rateLimited: RateLimitedAttempt[];
  /** The call is still rate limited and would have been tried again, had `abandon` not said otherwise. */
  abandoned: boolean;
  /** The wait made after the last attempt, when `abandon` said so only after it: waited, then not tried again. */
  waitedMs?: number;
}> {
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = input.random ?? Math.random;
  const rateLimited: RateLimitedAttempt[] = [];
  let waitedMs = 0;
  for (;;) {
    const startedAt = Date.now();
    const call = await input.call(input.request);
    const last = { call, startedAt, rateLimited, abandoned: false };
    if (!isRateLimited(call) || input.retries === false || rateLimited.length >= AUTOWRITER_RATE_LIMIT_RETRY_WAITS_MS.length) return last;
    const waitMs = retryWaitMs(call.retryAfterMs, rateLimited.length, waitedMs, random());
    if (waitMs === null || waitMs + input.request.timeoutMs > input.remainingMs() - AUTOWRITER_CALL_DEADLINE_MARGIN_MS) return last;
    if (input.abandon?.()) return { ...last, abandoned: true };
    await sleep(waitMs);
    // Asked again: what makes a retry pointless may have happened during the wait (the other judge level decided the
    // draft). The retry is then not sent, and this attempt stays the last one.
    if (input.abandon?.()) return { ...last, abandoned: true, waitedMs: waitMs };
    rateLimited.push({ ...call, startedAt, waitedMs: waitMs });
    waitedMs += waitMs;
  }
}
