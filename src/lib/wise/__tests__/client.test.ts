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
