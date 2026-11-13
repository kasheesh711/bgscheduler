import type { callOpenRouter, OpenRouterCallResult } from "@/lib/feedback-autowriter/openrouter";

export const CLAUDE_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
// USD for each million tokens: input, output. A model that is not listed saves no cost, so the month's total says it is a floor.
const PRICES: Record<string, [number, number]> = { "claude-opus-5-5": [4, 20] };
// Claude's JSON output refuses these keywords with HTTP 400. The caller checks the answer against the full schema again.
const REFUSED_KEYWORDS = new Set(["$schema", "minLength", "maxLength", "pattern", "minimum", "maximum", "multipleOf", "minItems", "maxItems"]);

/** The schema without the keywords Claude refuses. A property may have one of those names, so property names stay. */
export function claudeSchema(node: unknown, names = false): unknown {
  if (Array.isArray(node)) return node.map((item) => claudeSchema(item));
  if (!node || typeof node !== "object") return node;
  return Object.fromEntries(
    Object.entries(node)
      .filter(([key]) => names || !REFUSED_KEYWORDS.has(key))
      .map(([key, value]) => [key, claudeSchema(value, !names && key === "properties")]),
  );
}

interface ClaudeResponse {
  id?: string;
  model?: string;
  stop_reason?: string | null;
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
  error?: { message?: string };
}

/**
 * One Claude Messages API call with a strict JSON schema. It takes the same input as `callOpenRouter` and gives the
 * same result, so the marking run does not know which service answered. `provider`, `plugins` and `title` are OpenRouter
 * settings with no use here: Claude reads a PDF's page images itself.
 */
export async function callClaude(input: Parameters<typeof callOpenRouter>[0]): Promise<OpenRouterCallResult> {
  const started = Date.now();
  const none = { model: null, provider: "anthropic", finishReason: null, usage: null };
  let response: Response;
  let text: string;
  try {
    response = await (input.fetchImpl ?? fetch)(CLAUDE_MESSAGES_URL, {
      method: "POST",
      headers: { "x-api-key": input.apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: input.model,
        max_tokens: input.maxTokens,
        system: input.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n"),
        messages: input.messages
          .filter((message) => message.role === "user")
          .map((message) => ({
            role: "user",
            content:
              typeof message.content === "string"
                ? message.content
                : message.content.map((part) =>
                    part.type === "text"
                      ? part
                      : { type: "document", source: { type: "base64", media_type: "application/pdf", data: part.file.file_data.slice(part.file.file_data.indexOf(",") + 1) } },
                  ),
          })),
        output_config: { ...(input.effort === "none" ? {} : { effort: input.effort }), format: { type: "json_schema", schema: claudeSchema(input.schema) } },
      }),
      signal: AbortSignal.timeout(input.timeoutMs),
    });
    // The timeout also covers reading the body.
    text = await response.text();
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    return { ok: false, error: name === "TimeoutError" ? "timeout" : `network_${name}`, httpStatus: null, ...none, latencyMs: Date.now() - started };
  }
  const latencyMs = Date.now() - started;
  let body: ClaudeResponse | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as ClaudeResponse;
  } catch {
    // Not JSON: handled below.
  }
  if (!body) return { ok: false, error: "invalid_json_response", httpStatus: response.status, ...none, latencyMs };
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const price = PRICES[body.model ?? ""];
  const usage = body.usage
    ? {
        promptTokens: count(body.usage.input_tokens),
        completionTokens: count(body.usage.output_tokens),
        // Claude counts its thinking inside the output tokens.
        reasoningTokens: 0,
        cachedTokens: count(body.usage.cache_read_input_tokens),
        costUsd: price ? (count(body.usage.input_tokens) * price[0] + count(body.usage.output_tokens) * price[1]) / 1_000_000 : null,
      }
    : null;
  const common = { model: body.model ?? null, provider: "anthropic", finishReason: body.stop_reason ?? null, latencyMs };
  if (!response.ok || body.error) return { ok: false, error: (body.error?.message ?? `HTTP ${response.status}`).slice(0, 300), httpStatus: response.status, usage, ...common };
  // A refusal or a cut-off answer is a failed run. The person retries; no second model is tried.
  if (body.stop_reason !== "end_turn") return { ok: false, error: `finish_reason_${body.stop_reason ?? "missing"}`, httpStatus: response.status, usage, ...common };
  const content = (body.content ?? []).map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("");
  if (!content.trim()) return { ok: false, error: "empty_content", httpStatus: response.status, usage, ...common };
  return { ok: true, content, generationId: body.id ?? null, usage: usage ?? { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedTokens: 0, costUsd: null }, ...common };
}
