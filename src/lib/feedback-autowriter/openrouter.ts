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
  };

interface ChatCompletionResponse {
  id?: string;
  model?: string;
  provider?: string;
  error?: { message?: string; code?: number | string };
  choices?: Array<{ finish_reason?: string | null; message?: { content?: string | null } }>;
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

/**
 * One OpenRouter chat completion with a strict JSON schema. No retries: a
 * failed or truncated call is recorded as a failure of that model.
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

  const text = await response.text();
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
  if (!response.ok || body.error) {
    const message = (body.error?.message ?? `HTTP ${response.status}`).slice(0, 300);
    return { ok: false, error: message, httpStatus: response.status, usage, ...common };
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
