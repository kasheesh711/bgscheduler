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
 * How long OpenRouter asks us to wait after a rate limit, when it says: `Retry-After` (seconds, or an HTTP date) or
 * the reset time of its own limit (`X-RateLimit-Reset`, epoch milliseconds or seconds) — a header of the response,
 * or listed under the reported error's `metadata.headers` in its body. Null when it names no time still ahead.
 */
function retryAfterMs(response: Response, error: ReportedError | undefined, now: number): number | null {
  const listed = error?.metadata?.headers;
  const inBody = listed && typeof listed === "object" ? Object.entries(listed) : [];
  const read = (name: string): string | null => {
    const header = response.headers.get(name);
    if (header !== null) return header;
    const [, value] = inBody.find(([key]) => key.toLowerCase() === name) ?? [];
    return typeof value === "string" || typeof value === "number" ? String(value) : null;
  };
  const retryAfter = read("retry-after")?.trim();
  if (retryAfter) {
    const waitMs = /^\d+(?:\.\d+)?$/u.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - now;
    if (Number.isFinite(waitMs) && waitMs > 0) return Math.round(waitMs);
  }
  const reset = Number(read("x-ratelimit-reset")?.trim() || Number.NaN);
  if (Number.isFinite(reset) && reset > 0) {
    const waitMs = (reset < 1e12 ? reset * 1000 : reset) - now;
    if (waitMs > 0) return Math.round(waitMs);
  }
  return null;
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
  let body: ChatCompletionResponse;
  try {
    body = JSON.parse(text) as ChatCompletionResponse;
  } catch {
    return {
      ok: false, error: "invalid_json_response", httpStatus: response.status,
      model: null, provider: null, finishReason: null, usage: null, latencyMs,
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
 * One model call, tried again in the same run while it is rate limited (owner decision, 30 Sep): the same request,
 * up to three more times, after about 4 s, 10 s and 25 s — each ±30% at random — or after the wait OpenRouter asks
 * for (never before it, up to 30 s); one call's waits never add up to more than 45 s. Any other result — an answer,
 * a time-out, a provider error, a reply that is not JSON — is returned as it is: this retries rate limits only.
 *
 * Never past the run's time: a retry is made only when its wait and the request's whole time-out still end before
 * the function's deadline margin (`remainingMs` − 45 s), the rule every model call starts under. Otherwise the rate
 * limit is returned at once, as before: the class is retried at the next sweep.
 *
 * Returns the last attempt, and before it every attempt that was rate limited and tried again (oldest first): each
 * was a real request, so the caller records each as its own call.
 */
export async function callWithRateLimitRetries<Request extends { timeoutMs: number }>(input: {
  call: (request: Request) => Promise<OpenRouterCallResult>;
  request: Request;
  /** The function's time left. */
  remainingMs: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** A number in [0, 1), like `Math.random`. */
  random?: () => number;
}): Promise<{ call: OpenRouterCallResult; rateLimited: OpenRouterCallFailure[] }> {
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = input.random ?? Math.random;
  const rateLimited: OpenRouterCallFailure[] = [];
  let waitedMs = 0;
  for (;;) {
    const call = await input.call(input.request);
    if (!isRateLimited(call) || rateLimited.length >= AUTOWRITER_RATE_LIMIT_RETRY_WAITS_MS.length) return { call, rateLimited };
    const spread = AUTOWRITER_RATE_LIMIT_RETRY_JITTER * random();
    const askedMs = call.retryAfterMs === undefined
      // The schedule's wait, anywhere within ±30%.
      ? AUTOWRITER_RATE_LIMIT_RETRY_WAITS_MS[rateLimited.length] * (1 - AUTOWRITER_RATE_LIMIT_RETRY_JITTER + 2 * spread)
      // The wait OpenRouter asked for: the spread only adds to it, and it is cut at the cap.
      : Math.min(AUTOWRITER_RATE_LIMIT_RETRY_AFTER_MAX_MS, call.retryAfterMs * (1 + spread));
    const waitMs = Math.round(Math.min(askedMs, AUTOWRITER_RATE_LIMIT_RETRY_MAX_TOTAL_WAIT_MS - waitedMs));
    const fits = waitMs + input.request.timeoutMs <= input.remainingMs() - AUTOWRITER_CALL_DEADLINE_MARGIN_MS;
    if (waitMs <= 0 || !fits) return { call, rateLimited };
    rateLimited.push(call);
    await sleep(waitMs);
    waitedMs += waitMs;
  }
}
