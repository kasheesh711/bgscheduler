import { afterEach, describe, expect, it, vi } from "vitest";
import { WiseClient } from "../client";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const make = () => new WiseClient({ userId: "test", apiKey: "test", namespace: "test", maxConcurrency: 1,
  requestsPerSecond: 1 / 3, maxRetries: 0, stopOnRateLimit: true });

describe("paced classroom Wise client", () => {
  it("starts sequential HTTP calls at least three seconds apart", async () => {
    vi.useFakeTimers();
    const starts: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => { starts.push(Date.now()); return new Response("{}"); }));
    const client = make();
    const completed = Promise.all([client.get("/first"), client.put("/second", {}), client.get("/third")]);
    await vi.runAllTimersAsync();
    await completed;
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(3000);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(3000);
  });
  it("stops queued calls on 429 and preserves status and Retry-After", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => new Response('{"errorCode":"RATE_LIMITED"}', { status: 429, headers: { "Retry-After": "600" } }));
    vi.stubGlobal("fetch", fetch);
    const client = make();
    const results = Promise.allSettled([client.get("/one"), client.put("/two", {}), client.get("/three")]);
    await vi.runAllTimersAsync();
    expect(await results).toEqual(Array.from({ length: 3 }, () => expect.objectContaining({ status: "rejected",
      reason: expect.objectContaining({ status: 429, retryAfterMs: 600_000 }),
    })));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not send a queued request after the attempt deadline", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const fetch = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    const client = new WiseClient({ userId: "t", apiKey: "t", namespace: "t", maxConcurrency: 1,
      requestsPerSecond: 1 / 3, signal: abort.signal });
    await client.get("/first");
    const second = client.get("/second").catch(error => error);
    abort.abort();
    await vi.runAllTimersAsync();
    expect(await second).toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
