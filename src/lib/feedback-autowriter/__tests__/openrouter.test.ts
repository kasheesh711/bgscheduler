import { describe, expect, it, vi } from "vitest";
import { callOpenRouter } from "../openrouter";

function reply(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

const request = {
  apiKey: "test-key",
  model: "openai/gpt-6-luna",
  provider: { order: ["openai"], allow_fallbacks: false, data_collection: "deny" as const },
  messages: [{ role: "user" as const, content: "hi" }],
  schemaName: "s",
  schema: { type: "object" },
  effort: "max" as const,
  maxTokens: 1000,
  timeoutMs: 5000,
};

describe("callOpenRouter", () => {
  it("returns content, routing and billed usage", async () => {
    const fetchImpl = reply(200, {
      id: "gen-1",
      model: "openai/gpt-6-luna",
      provider: "OpenAI",
      choices: [{ finish_reason: "stop", message: { content: "{\"a\":1}" } }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 300,
        cost: 0.00016,
        completion_tokens_details: { reasoning_tokens: 250 },
        prompt_tokens_details: { cached_tokens: 0 },
      },
    });
    const result = await callOpenRouter({ ...request, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toMatchObject({
      ok: true,
      content: "{\"a\":1}",
      provider: "OpenAI",
      generationId: "gen-1",
      usage: { promptTokens: 100, completionTokens: 300, reasoningTokens: 250, cachedTokens: 0, costUsd: 0.00016 },
    });
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.reasoning).toEqual({ effort: "max" });
    expect(body.provider).toEqual(request.provider);
    expect(body.response_format.json_schema.strict).toBe(true);
  });

  it("fails on truncation, keeping the usage for cost accounting", async () => {
    const fetchImpl = reply(200, {
      choices: [{ finish_reason: "length", message: { content: "{\"a\":" } }],
      usage: { prompt_tokens: 10, completion_tokens: 1000, cost: 0.0005 },
    });
    const result = await callOpenRouter({ ...request, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toMatchObject({ ok: false, error: "finish_reason_length", usage: { costUsd: 0.0005 } });
  });

  it("fails on HTTP errors and timeouts without retrying", async () => {
    const fetchImpl = reply(404, { error: { message: "No endpoints found", code: 404 } });
    expect(await callOpenRouter({ ...request, fetchImpl: fetchImpl as unknown as typeof fetch }))
      .toMatchObject({ ok: false, httpStatus: 404, error: "No endpoints found" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const timeout = vi.fn(async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); });
    expect(await callOpenRouter({ ...request, fetchImpl: timeout as unknown as typeof fetch }))
      .toMatchObject({ ok: false, error: "timeout" });
  });

  it("takes the status from the body when OpenRouter reports the failure inside a 200 response", async () => {
    // 30 Sep: an upstream rate limit on the writer's route came as HTTP 200 with the status in the body.
    const rateLimited = reply(200, {
      error: { message: "openai/gpt-6-luna is temporarily rate-limited upstream. Please retry shortly.", code: 429, metadata: { error_type: "rate_limit" } },
    });
    expect(await callOpenRouter({ ...request, fetchImpl: rateLimited as unknown as typeof fetch })).toMatchObject({
      ok: false, httpStatus: 429, error: "openai/gpt-6-luna is temporarily rate-limited upstream. Please retry shortly.",
    });
    // A code that is not a status (or none) leaves the response's own status; an HTTP error keeps its status.
    const textCode = reply(200, { error: { message: "Provider returned error", code: "provider_error" } });
    expect(await callOpenRouter({ ...request, fetchImpl: textCode as unknown as typeof fetch })).toMatchObject({ ok: false, httpStatus: 200 });
    const noCode = reply(200, { error: { message: "Provider returned error" } });
    expect(await callOpenRouter({ ...request, fetchImpl: noCode as unknown as typeof fetch })).toMatchObject({ ok: false, httpStatus: 200 });
    const gateway = reply(502, { error: { message: "Provider returned error", code: 429 } });
    expect(await callOpenRouter({ ...request, fetchImpl: gateway as unknown as typeof fetch })).toMatchObject({ ok: false, httpStatus: 502 });
  });

  it("reports a timeout while reading a slow reply as a timeout, not an unhandled error", async () => {
    // Ek's 29 Sep class: the headers arrived, then the body read hit the timeout.
    const slowBody = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => { throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }); },
    }));
    expect(await callOpenRouter({ ...request, fetchImpl: slowBody as unknown as typeof fetch }))
      .toMatchObject({ ok: false, error: "timeout", httpStatus: 200 });
  });
});
