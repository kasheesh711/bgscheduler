import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import {
  assertPostClassAiReviewIdempotentPayloadMatches,
  processPostClassAiReviews,
} from "@/lib/post-class-feedback/ai";

/**
 * A stand-in for the drizzle query builder: every chained call returns the chain, and awaiting it
 * resolves the next queued result, in query order. `set(...)` payloads are kept for assertions.
 */
function fakeDb(results: unknown[]) {
  const updates: unknown[] = [];
  const chain = (): unknown => new Proxy({}, {
    get(_target, property) {
      if (property === "then") {
        const value = results.shift();
        return (resolve: (value: unknown) => void, reject: (reason: unknown) => void) =>
          Promise.resolve(value).then(resolve, reject);
      }
      return (...args: unknown[]) => {
        if (property === "set") updates.push(args[0]);
        return chain();
      };
    },
  });
  return { db: { select: () => chain(), insert: () => chain(), update: () => chain() }, updates };
}

describe("post-class AI quality-model call", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("bounds the model call with a 30s timeout and records a timed-out call as a failed review", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    vi.stubGlobal("fetch", fetchMock);
    const candidate = {
      session: { id: "session-1", canonicalTutorKey: null, canonicalTutorName: null },
      // A short required field makes the version suspect, so the model is called.
      version: { id: "version-1", contentHash: "hash-1", topics: "ok", performance: "ok", improvement: "ok", homework: "" },
    };
    const { db, updates } = fakeDb([
      [candidate], // candidates
      [], // participants
      [], // no earlier run for this request hash
      [{ id: "ai-run-1" }], // the inserted running row
      undefined, // the failed-status update
    ]);

    const result = await processPostClassAiReviews({}, db as never);

    expect(result).toEqual({ processed: 0, failed: 1, skipped: 0 });
    expect(timeout).toHaveBeenCalledWith(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(timeout.mock.results[0].value);
    expect(updates).toEqual([
      expect.objectContaining({ status: "failed", errorMessage: "AI quality review failed" }),
    ]);
  });
});

describe("post-class AI review idempotency", () => {
  const prior = {
    action: "confirmed",
    actorEmail: "reviewer@example.com",
    note: "Confirmed after reviewing the full feedback.",
    beforeValue: { concernId: "concern-1", version: 2 },
    afterValue: { concernId: "concern-1", decision: "confirmed", version: 3 },
  };
  const expected = {
    concernId: "concern-1",
    decision: "confirmed" as const,
    actorEmail: "reviewer@example.com",
    note: "Confirmed after reviewing the full feedback.",
    expectedVersion: 2,
  };

  it("accepts an exact replay", () => {
    expect(() => assertPostClassAiReviewIdempotentPayloadMatches(prior, expected)).not.toThrow();
  });

  it("rejects a reused key for another concern or decision", () => {
    expect(() => assertPostClassAiReviewIdempotentPayloadMatches(prior, {
      ...expected,
      concernId: "concern-2",
    })).toThrow(/different AI review payload/i);
    expect(() => assertPostClassAiReviewIdempotentPayloadMatches(prior, {
      ...expected,
      decision: "dismissed",
    })).toThrow(/different AI review payload/i);
  });

  it("rejects a reused key with a changed note, actor, or expected version", () => {
    expect(() => assertPostClassAiReviewIdempotentPayloadMatches(prior, {
      ...expected,
      note: "Changed note",
    })).toThrow(/different AI review payload/i);
    expect(() => assertPostClassAiReviewIdempotentPayloadMatches(prior, {
      ...expected,
      actorEmail: "other@example.com",
    })).toThrow(/different AI review payload/i);
    expect(() => assertPostClassAiReviewIdempotentPayloadMatches(prior, {
      ...expected,
      expectedVersion: 3,
    })).toThrow(/different AI review payload/i);
  });
});
