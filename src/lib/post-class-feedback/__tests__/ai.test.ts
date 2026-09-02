import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import { assertPostClassAiReviewIdempotentPayloadMatches } from "@/lib/post-class-feedback/ai";

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
