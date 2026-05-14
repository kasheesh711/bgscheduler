import { afterEach, describe, expect, it, vi } from "vitest";
import { WiseClient } from "../client";

describe("WiseClient", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("sends the live Wise auth headers to the correct base URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 200, message: "Success", data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    global.fetch = fetchMock as typeof fetch;

    const client = new WiseClient({
      userId: "user-123",
      apiKey: "api-key-456",
      namespace: "begifted-education",
      maxRetries: 0,
    });

    await client.get("/user/getUser");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.wiseapp.live/user/getUser",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from("user-123:api-key-456").toString("base64")}`,
          "x-api-key": "api-key-456",
          "x-wise-namespace": "begifted-education",
          "user-agent": "VendorIntegrations/begifted-education",
        }),
      })
    );
  });
});

describe("WiseClient — REL-05 status-code-aware retry policy", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // Helper: builds a client with maxRetries=3 (default). Tests use
  // vi.useFakeTimers() so the 1s/2s/4s exponential backoff doesn't add
  // ~7 seconds of real wall-clock time to each retry test.
  function makeClient(maxRetries = 3) {
    return new WiseClient({
      userId: "user-123",
      apiKey: "api-key-456",
      namespace: "begifted-education",
      maxRetries,
    });
  }

  function jsonResponse(status: number, body: unknown = {}): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("REL-05: 401 (permanent 4xx) does NOT retry — throws on first response", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(401, { error: "unauthorized" }));
      global.fetch = fetchMock as typeof fetch;

      const client = makeClient(3);
      const promise = client.get("/test");
      const expectation = expect(promise).rejects.toThrow(/401/);
      await vi.runAllTimersAsync();
      await expectation;

      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("REL-05: 404 (permanent 4xx) does NOT retry — throws on first response", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(404, { error: "not found" }));
      global.fetch = fetchMock as typeof fetch;

      const client = makeClient(3);
      const promise = client.get("/test");
      const expectation = expect(promise).rejects.toThrow(/404/);
      await vi.runAllTimersAsync();
      await expectation;

      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("REL-05: 500 (transient 5xx) retries maxRetries times then throws", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(500, { error: "server" }));
      global.fetch = fetchMock as typeof fetch;

      const client = makeClient(3);
      const promise = client.get("/test");
      // attach catch handler immediately so the rejection is observed,
      // then advance through 1s/2s/4s backoffs.
      const expectation = expect(promise).rejects.toThrow(/500/);
      await vi.runAllTimersAsync();
      await expectation;

      // 1 initial + 3 retries = 4 total fetch calls
      expect(fetchMock).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("REL-05: 429 (rate limit) retries and succeeds on second try", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(429, { error: "too many" }))
        .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
      global.fetch = fetchMock as typeof fetch;

      const client = makeClient(3);
      const promise = client.get<{ ok: boolean }>("/test");
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("REL-05: network error (fetch throws TypeError) retries and succeeds", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
      global.fetch = fetchMock as typeof fetch;

      const client = makeClient(3);
      const promise = client.get<{ ok: boolean }>("/test");
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("limits concurrent requests", async () => {
    let active = 0;
    let maxActive = 0;
    const fetchMock = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return jsonResponse(200, { ok: true });
    });
    global.fetch = fetchMock as typeof fetch;

    const client = new WiseClient({
      userId: "user-123",
      apiKey: "api-key-456",
      namespace: "begifted-education",
      maxConcurrency: 2,
      maxRetries: 0,
    });

    await Promise.all(Array.from({ length: 6 }, () => client.get<{ ok: boolean }>("/test")));

    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});
