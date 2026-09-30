import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTOWRITER_CALL_DEADLINE_MARGIN_MS } from "../config";
import { callOpenRouter, callWithRateLimitRetries, isRateLimited } from "../openrouter";

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

  it("reads a rate limit in every form it takes inside a 200 response: the code as text, or the error carried on the choice", async () => {
    const call = (body: unknown, status = 200) => callOpenRouter({ ...request, fetchImpl: reply(status, body) as unknown as typeof fetch });
    const limit = "openai/gpt-6-luna is temporarily rate-limited upstream. Please retry shortly.";
    // The code as text.
    expect(await call({ error: { message: limit, code: "429" } })).toMatchObject({ ok: false, httpStatus: 429, error: limit });
    // The error on the choice (a generation that ended in an error), with the code as a number or as text.
    const onChoice = (error: unknown, finishReason: string | null = "error") => ({
      id: "gen-1", model: "openai/gpt-6-luna", provider: "Azure",
      choices: [{ finish_reason: finishReason, native_finish_reason: finishReason, message: { role: "assistant", content: "" }, error }],
      usage: { prompt_tokens: 10, completion_tokens: 0, cost: 0 },
    });
    expect(await call(onChoice({ message: limit, code: 429 }))).toMatchObject({
      ok: false, httpStatus: 429, error: limit, finishReason: "error", model: "openai/gpt-6-luna", provider: "Azure", usage: { costUsd: 0 },
    });
    expect(await call(onChoice({ message: limit, code: "429" }))).toMatchObject({ ok: false, httpStatus: 429, error: limit });
    expect(await call(onChoice({ message: limit, code: " 429 " }, null))).toMatchObject({ ok: false, httpStatus: 429, error: limit, finishReason: null });
    // No message with it: the status says what it was.
    expect(await call(onChoice({ code: 429 }))).toMatchObject({ ok: false, httpStatus: 429, error: "HTTP 429" });
    expect(await call({ error: { code: "429" } })).toMatchObject({ ok: false, httpStatus: 429, error: "HTTP 429" });

    // Only a 429. Any other error on a choice stays a generation error of the model's …
    for (const error of [{ message: "Provider returned error", code: 502 }, { message: "Provider returned error", code: "provider_error" }, { message: "Overloaded" }, { message: limit, code: 4290 }, { message: limit, code: "429.5" }]) {
      expect(await call(onChoice(error)), JSON.stringify(error)).toMatchObject({ ok: false, httpStatus: 200, error: "finish_reason_error" });
    }
    // … another code given as text keeps the response's own status …
    expect(await call({ error: { message: "Insufficient credits", code: "402" } })).toMatchObject({ ok: false, httpStatus: 200, error: "Insufficient credits" });
    expect(await call({ error: { message: "Provider returned error", code: "provider_error" } })).toMatchObject({ ok: false, httpStatus: 200 });
    // … an error of the whole response comes before one on a choice, and an HTTP error keeps its status.
    expect(await call({ error: { message: "Provider returned error", code: 500 }, ...onChoice({ message: limit, code: 429 }) }))
      .toMatchObject({ ok: false, httpStatus: 500, error: "Provider returned error" });
    expect(await call(onChoice({ message: limit, code: "429" }), 502)).toMatchObject({ ok: false, httpStatus: 502 });
    expect(await call({ error: { message: limit, code: "429" } }, 503)).toMatchObject({ ok: false, httpStatus: 503 });
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

// 30 Sep: the writer route's upstream limit, as OpenRouter reports it — HTTP 200 with the status in the body.
const UPSTREAM_LIMIT = {
  error: {
    message: "openai/gpt-6.1-sol is temporarily rate-limited upstream. Please retry shortly.",
    code: 429,
    metadata: { error_type: "rate_limit_exceeded" },
  },
};
const ANSWER = { id: "gen-1", model: "openai/gpt-6-luna", provider: "OpenAI", choices: [{ finish_reason: "stop", message: { content: "{\"a\":1}" } }] };
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status, headers });

describe("callOpenRouter: how long OpenRouter asks us to wait after a rate limit", () => {
  const NOW = Date.parse("2026-09-30T09:20:00.000Z");
  afterEach(() => { vi.useRealTimers(); });
  const hint = async (status: number, body: unknown, headers: Record<string, string> = {}) => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const result = await callOpenRouter({ ...request, fetchImpl: vi.fn(async () => json(status, body, headers)()) as unknown as typeof fetch });
    return result.ok ? "answered" : result.retryAfterMs;
  };

  it("names no wait when OpenRouter gives none (the upstream limit of 30 Sep)", async () => {
    expect(await hint(200, UPSTREAM_LIMIT)).toBeUndefined();
    expect(await hint(429, { error: { message: "Rate limit exceeded", code: 429 } })).toBeUndefined();
  });

  it("reads Retry-After, in seconds or as a date, from the response or from the error's own header list", async () => {
    expect(await hint(429, UPSTREAM_LIMIT, { "Retry-After": "7" })).toBe(7_000);
    expect(await hint(200, UPSTREAM_LIMIT, { "retry-after": "1.5" })).toBe(1_500);
    expect(await hint(429, UPSTREAM_LIMIT, { "Retry-After": new Date(NOW + 12_000).toUTCString() })).toBe(12_000);
    expect(await hint(200, { error: { message: "Provider returned error", code: 429, metadata: { headers: { "Retry-After": 9 } } } })).toBe(9_000);
    // … also when the rate limit is carried on the choice, or its code is text.
    expect(await hint(200, { choices: [{ finish_reason: "error", error: { message: "x", code: "429", metadata: { headers: { "retry-after": "6" } } } }] })).toBe(6_000);
    expect(await hint(200, { error: { message: "x", code: "429" } }, { "Retry-After": "2" })).toBe(2_000);
    // The response's own header comes first.
    expect(await hint(429, { error: { message: "x", code: 429, metadata: { headers: { "retry-after": "20" } } } }, { "Retry-After": "3" })).toBe(3_000);
  });

  it("reads the reset time of OpenRouter's own limit (X-RateLimit-Reset, epoch milliseconds or seconds)", async () => {
    const own = (reset: string) => ({
      error: { message: "Rate limit exceeded: limit_rpm", code: 429, metadata: { headers: { "X-RateLimit-Limit": "20", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": reset } } },
    });
    expect(await hint(429, own(String(NOW + 40_000)))).toBe(40_000);
    expect(await hint(429, own(String((NOW + 8_000) / 1000)))).toBe(8_000);
    expect(await hint(429, { error: { message: "x", code: 429 } }, { "X-RateLimit-Reset": String(NOW + 5_000) })).toBe(5_000);
  });

  it("ignores a wait that is not ahead or cannot be read, and any such header on another failure", async () => {
    expect(await hint(429, UPSTREAM_LIMIT, { "Retry-After": "0" })).toBeUndefined();
    expect(await hint(429, UPSTREAM_LIMIT, { "Retry-After": "soon" })).toBeUndefined();
    expect(await hint(429, UPSTREAM_LIMIT, { "Retry-After": new Date(NOW - 60_000).toUTCString() })).toBeUndefined();
    expect(await hint(429, UPSTREAM_LIMIT, { "X-RateLimit-Reset": String(NOW - 1) })).toBeUndefined();
    expect(await hint(429, { error: { message: "x", code: 429, metadata: { headers: "Retry-After: 5" } } })).toBeUndefined();
    expect(await hint(429, { error: { message: "x", code: 429, metadata: { headers: { "Retry-After": { seconds: 5 } } } } })).toBeUndefined();
    // Only a rate limit carries it.
    expect(await hint(503, { error: { message: "Service unavailable", code: 503 } }, { "Retry-After": "30" })).toBeUndefined();
    expect(await hint(200, ANSWER, { "Retry-After": "30" })).toBe("answered");
  });
});

describe("callWithRateLimitRetries", () => {
  /** Replies per request, in order; an extra request fails the test. */
  function attempt(replies: Array<() => Response | Promise<Response>>, options: { remainingMs?: number; random?: () => number } = {}) {
    const waits: number[] = [];
    const fetchImpl = vi.fn(async (...args: [string, RequestInit]) => {
      void args;
      const next = replies.shift();
      if (!next) throw new Error("unexpected request");
      return next();
    });
    const promise = callWithRateLimitRetries({
      call: (input: typeof request) => callOpenRouter({ ...input, fetchImpl: fetchImpl as unknown as typeof fetch }),
      request,
      remainingMs: () => options.remainingMs ?? 700_000,
      sleep: async (ms) => { waits.push(ms); },
      random: options.random ?? (() => 0.5),
    });
    return { promise, waits, fetchImpl };
  }
  const limited = (headers: Record<string, string> = {}) => json(200, UPSTREAM_LIMIT, headers);
  const timedOut = () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); };

  it("sends the same request again after a rate limit, whether it comes inside a 200 response or as HTTP 429", async () => {
    const { promise, waits, fetchImpl } = attempt([limited(), json(429, { error: { message: "Rate limit exceeded", code: 429 } }), json(200, ANSWER)]);
    const { call, rateLimited } = await promise;
    expect(call).toMatchObject({ ok: true, content: "{\"a\":1}" });
    // Both earlier attempts come back too, in order: each was a request, each is recorded.
    expect(rateLimited.map((limit) => [limit.httpStatus, limit.error, limit.usage])).toEqual([
      [429, UPSTREAM_LIMIT.error.message, null], [429, "Rate limit exceeded", null],
    ]);
    expect(rateLimited.every(isRateLimited)).toBe(true);
    expect(waits).toEqual([4_000, 10_000]);
    const bodies = fetchImpl.mock.calls.map(([, init]) => init.body);
    expect(bodies).toEqual([bodies[0], bodies[0], bodies[0]]);
  });

  it("retries a rate limit in every form it is reported: the code as text, or carried on the choice", async () => {
    const message = UPSTREAM_LIMIT.error.message;
    const { promise, waits, fetchImpl } = attempt([
      json(200, { error: { message, code: "429" } }),
      json(200, { choices: [{ finish_reason: "error", message: { content: "" }, error: { message, code: 429 } }] }),
      json(200, { choices: [{ finish_reason: "error", message: { content: "" }, error: { message, code: "429" } }] }),
      json(200, ANSWER),
    ]);
    expect(await promise).toMatchObject({ call: { ok: true }, rateLimited: [{ httpStatus: 429, error: message }, { httpStatus: 429, error: message }, { httpStatus: 429, error: message }] });
    expect(waits).toEqual([4_000, 10_000, 25_000]);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("makes at most three retries, then returns the rate limit", async () => {
    const { promise, waits, fetchImpl } = attempt([limited(), limited(), limited(), limited()]);
    const { call, rateLimited } = await promise;
    expect(call).toMatchObject({ ok: false, httpStatus: 429, error: UPSTREAM_LIMIT.error.message });
    expect(rateLimited).toHaveLength(3);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(waits).toEqual([4_000, 10_000, 25_000]);
  });

  it("retries nothing but a rate limit", async () => {
    const others: Array<[string, () => Response | Promise<Response>]> = [
      ["a time-out", timedOut],
      ["a network error", () => { throw new TypeError("fetch failed"); }],
      ["a provider error", json(500, { error: { message: "Provider returned error", code: 500 } })],
      ["a gateway error naming 429 in its body", json(502, { error: { message: "Provider returned error", code: 429 } })],
      ["a reply that is not JSON", () => new Response("<html>Bad gateway</html>", { status: 502 })],
      ["no credit", json(402, { error: { message: "Insufficient credits", code: 402 } })],
      ["a failure with a text code inside a 200 response", json(200, { error: { message: "Provider returned error", code: "provider_error" } })],
      ["another status given as text inside a 200 response", json(200, { error: { message: "Insufficient credits", code: "402" } })],
      ["a generation that ended in another error", json(200, { choices: [{ finish_reason: "error", message: { content: "" }, error: { message: "Provider returned error", code: 502 } }] })],
      ["a truncated answer", json(200, { choices: [{ finish_reason: "length", message: { content: "{" } }] })],
      ["an answer", json(200, ANSWER)],
    ];
    for (const [label, reply] of others) {
      const { promise, waits, fetchImpl } = attempt([reply]);
      const { call, rateLimited } = await promise;
      expect(isRateLimited(call), label).toBe(false);
      expect(rateLimited, label).toEqual([]);
      expect(waits, label).toEqual([]);
      expect(fetchImpl, label).toHaveBeenCalledTimes(1);
    }
    // A retry that ends another way is returned as it ended, after the one wait.
    const { promise, waits } = attempt([limited(), timedOut]);
    expect(await promise).toMatchObject({ call: { ok: false, error: "timeout" }, rateLimited: [{ httpStatus: 429 }] });
    expect(waits).toEqual([4_000]);
  });

  it("spreads each wait ±30% and keeps one call's waits within 45 s", async () => {
    const four = () => [limited(), limited(), limited(), limited()];
    const shortest = attempt(four(), { random: () => 0 });
    await shortest.promise;
    expect(shortest.waits).toEqual([2_800, 7_000, 17_500]);
    const longest = attempt(four(), { random: () => 0.999_999 });
    await longest.promise;
    expect(longest.waits).toEqual([5_200, 13_000, 26_800]);
  });

  it("waits what OpenRouter asks — never less, at most 30 s at a time and 45 s in all", async () => {
    const asked = attempt([limited({ "Retry-After": "7" }), json(200, ANSWER)], { random: () => 0 });
    await asked.promise;
    expect(asked.waits).toEqual([7_000]);
    const spread = attempt([limited({ "Retry-After": "7" }), json(200, ANSWER)]);
    await spread.promise;
    expect(spread.waits).toEqual([8_050]);
    // Two minutes asked: 30 s, then what is left of the 45 s, then no more — two retries instead of three.
    const long = attempt([limited({ "Retry-After": "120" }), limited({ "Retry-After": "120" }), limited({ "Retry-After": "120" })]);
    expect(await long.promise).toMatchObject({ call: { ok: false, httpStatus: 429, retryAfterMs: 120_000 }, rateLimited: [{}, {}] });
    expect(long.waits).toEqual([30_000, 15_000]);
    expect(long.fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("never waits past the run's time: the wait and the request's whole time-out must end before the deadline margin", async () => {
    const needed = 4_000 + request.timeoutMs + AUTOWRITER_CALL_DEADLINE_MARGIN_MS;
    const short = attempt([limited()], { remainingMs: needed - 1 });
    expect(await short.promise).toMatchObject({ call: { ok: false, httpStatus: 429 }, rateLimited: [] });
    expect(short.waits).toEqual([]);
    expect(short.fetchImpl).toHaveBeenCalledTimes(1);
    const enough = attempt([limited(), json(200, ANSWER)], { remainingMs: needed });
    expect(await enough.promise).toMatchObject({ call: { ok: true }, rateLimited: [{ httpStatus: 429 }] });
    expect(enough.waits).toEqual([4_000]);
  });

  it("waits with a real timer and the real random source when none is given", async () => {
    vi.useFakeTimers();
    try {
      const replies = [limited(), json(200, ANSWER)];
      const fetchImpl = vi.fn(async () => replies.shift()!());
      const made = callWithRateLimitRetries({
        call: (input: typeof request) => callOpenRouter({ ...input, fetchImpl: fetchImpl as unknown as typeof fetch }),
        request,
        remainingMs: () => 700_000,
      });
      // Nothing is sent again before the shortest possible first wait (4 s − 30%) …
      await vi.advanceTimersByTimeAsync(2_799);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      // … and it has been by the longest (4 s + 30%).
      await vi.advanceTimersByTimeAsync(2_401);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(await made).toMatchObject({ call: { ok: true } });
    } finally {
      vi.useRealTimers();
    }
  });
});
