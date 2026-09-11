import { afterEach, describe, expect, it, vi } from "vitest";
import { topWisePaths, WiseClient } from "../client";

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

// EFF-00: every sync is Wise-bound, but no run ever recorded how many calls
// it made. The counter is the measurement that makes that answerable.
describe("WiseClient — EFF-00 request counter", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function okClient(): WiseClient {
    // A fresh Response per call: a body can only be read once.
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ status: 200, data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as typeof fetch;

    return new WiseClient({
      userId: "user-123",
      apiKey: "api-key-456",
      namespace: "begifted-education",
      maxRetries: 0,
    });
  }

  it("starts at zero", () => {
    expect(okClient().getStats()).toEqual({ requests: 0, byPath: {} });
  });

  it("counts every call and buckets it by normalized path", async () => {
    const client = okClient();

    await client.get("/institutes/696e1f4d90102225641cc413/teachers");
    await client.get("/institutes/696e1f4d90102225641cc413/teachers/6710a4f290102225641cc999/availability");
    await client.get("/institutes/696e1f4d90102225641cc413/teachers/59f21b0c90102225641cc111/availability");

    expect(client.getStats()).toEqual({
      requests: 3,
      byPath: {
        "/institutes/{id}/teachers": 1,
        "/institutes/{id}/teachers/{id}/availability": 2,
      },
    });
  });

  it("counts writes as well as reads", async () => {
    const client = okClient();

    await client.post("/institutes/696e1f4d90102225641cc413/sessions", {});
    await client.put("/sessions/6710a4f290102225641cc999", {});

    expect(client.getStats().requests).toBe(2);
    expect(client.getStats().byPath["/sessions/{id}"]).toBe(1);
  });

  it("keeps non-id path segments intact", () => {
    expect(WiseClient.normalizeStatsPath("/user/getUser")).toBe("/user/getUser");
    expect(WiseClient.normalizeStatsPath("/institutes/696e1f4d90102225641cc413/analytics"))
      .toBe("/institutes/{id}/analytics");
  });

  it("hands back a copy, so a caller cannot mutate the live tally", async () => {
    const client = okClient();
    await client.get("/user/getUser");

    const snapshot = client.getStats();
    snapshot.byPath["/user/getUser"] = 999;

    expect(client.getStats().byPath["/user/getUser"]).toBe(1);
  });
});

describe("topWisePaths", () => {
  it("returns the busiest paths first, capped at the limit", () => {
    const stats = {
      requests: 60,
      byPath: { a: 5, b: 40, c: 15 },
    };

    expect(Object.entries(topWisePaths(stats, 2))).toEqual([["b", 40], ["c", 15]]);
  });

  it("defaults to ten buckets", () => {
    const stats = {
      requests: 12,
      byPath: Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`p${index}`, index])),
    };

    expect(Object.keys(topWisePaths(stats))).toHaveLength(10);
  });
});

describe("WiseClient pacing and cancellation", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  const client = (extra: Partial<import("../client").WiseClientConfig> = {}) => new WiseClient({ userId: "test", apiKey: "test", namespace: "test", ...extra });
  it("paces every HTTP attempt, including retries, at two per second", async () => {
    vi.useFakeTimers(); const times: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => { times.push(Date.now()); return Response.json({}, { status: times.length === 1 ? 503 : 200 }); }));
    const c = client({ requestsPerSecond: 2 });
    const pending = Promise.all([c.get("/a"), c.get("/b"), c.get("/c")]);
    await vi.runAllTimersAsync(); await pending;
    expect(times).toHaveLength(4);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(500);
    expect(c.getStats().requests).toBe(4);
  });
  it("honors Retry-After and cancels the retry when the caller expires", async () => {
    vi.useFakeTimers(); const abort = new AbortController();
    const fetcher = vi.fn().mockResolvedValue(Response.json({}, { status: 429, headers: { "Retry-After": "60" } }));
    vi.stubGlobal("fetch", fetcher);
    const c = client(); const pending = c.get("/a", undefined, { signal: abort.signal });
    const rejection = expect(pending).rejects.toThrow("stop");
    await vi.advanceTimersByTimeAsync(7_000); expect(fetcher).toHaveBeenCalledTimes(1);
    abort.abort(new Error("stop")); await rejection;
    await vi.advanceTimersByTimeAsync(60_000); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("removes aborted queued requests without ever sending them", async () => {
    const abort = new AbortController(); let release!: (value: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { release = resolve; }));
    vi.stubGlobal("fetch", fetcher); const c = client({ maxConcurrency: 1 });
    const first = c.get("/first"); const queued = c.get("/queued", undefined, { signal: abort.signal });
    const rejection = expect(queued).rejects.toThrow("stop"); abort.abort(new Error("stop")); await rejection;
    release(Response.json({})); await first; expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
