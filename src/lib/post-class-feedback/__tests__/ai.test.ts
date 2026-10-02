import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { z } from "zod";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import {
  assertPostClassAiReviewIdempotentPayloadMatches,
  isTransientQualityModelError,
  processPostClassAiReviews,
} from "@/lib/post-class-feedback/ai";

/**
 * A stand-in for the drizzle query builder: every chained call returns the chain, and awaiting it
 * resolves the next queued result, in query order (a queued Error rejects instead). `values(...)`
 * and `set(...)` payloads are kept for assertions, and `transaction(fn)` runs `fn` on the same fake.
 * A test that queues exactly the queries it expects fails loudly on any extra query.
 */
function fakeDb(results: unknown[]) {
  const values: Record<string, unknown>[] = [];
  const sets: Record<string, unknown>[] = [];
  const chain = (): unknown => new Proxy({}, {
    get(_target, property) {
      if (property === "then") {
        const value = results.shift();
        return (resolve: (value: unknown) => void, reject: (reason: unknown) => void) =>
          (value instanceof Error ? Promise.reject(value) : Promise.resolve(value)).then(resolve, reject);
      }
      return (...args: unknown[]) => {
        if (property === "values") values.push(args[0] as Record<string, unknown>);
        if (property === "set") sets.push(args[0] as Record<string, unknown>);
        return chain();
      };
    },
  });
  const deletes: unknown[] = [];
  const db: Record<string, unknown> = { select: () => chain(), insert: () => chain(), update: () => chain() };
  db.delete = (table: unknown) => { deletes.push(table); return chain(); };
  db.transaction = (fn: (tx: unknown) => Promise<unknown>) => fn(db);
  return { db: db as never, values, sets, deletes, results };
}

const NOW = new Date("2026-09-29T12:00:00.000Z");
const minutesBefore = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

// Short required fields make a version suspect, so the model is called.
const SUSPECT_FIELDS = { topics: "ok", performance: "ok", improvement: "ok", homework: "" };
// Long, distinct prose clears every deterministic trigger, so no model is called.
const HEALTHY_FIELDS = {
  topics: "We worked through factorising quadratics, starting from the difference of two squares and moving on to trinomials where the leading coefficient is greater than one.",
  performance: "She spotted the common factor quickly and only needed a prompt on sign handling when the constant term was negative. Her working was laid out clearly throughout.",
  improvement: "Next session we should drill completing the square, because she still reaches for the formula before checking whether a neater route exists.",
  homework: "",
};

function candidate(n: number, fields = SUSPECT_FIELDS) {
  return {
    session: { id: `session-${n}`, canonicalTutorKey: null, canonicalTutorName: null },
    version: { id: `version-${n}`, contentHash: `hash-${n}`, ...fields },
  };
}

/** An earlier run row for the candidate's request hash, as the existing-run lookup returns it. */
function earlierRun(overrides: {
  status: "failed" | "running" | "succeeded";
  metadata?: Record<string, unknown>;
  finishedAt?: Date | null;
  updatedAt?: Date;
}) {
  return {
    id: "run-earlier",
    status: overrides.status,
    model: "gpt-5.4-mini",
    errorMessage: overrides.status === "failed" ? "OpenAI HTTP 503" : null,
    startedAt: minutesBefore(121),
    triggerReasons: ["short_required_field"],
    metadata: { promptVersion: 1, highestPriorSimilarity: 0.25, matchingPriorKey: null, ...overrides.metadata },
    finishedAt: overrides.finishedAt === undefined ? minutesBefore(120) : overrides.finishedAt,
    updatedAt: overrides.updatedAt ?? minutesBefore(120),
  };
}

function modelReply(concerns: unknown[] = []): Response {
  return new Response(JSON.stringify({ output_text: JSON.stringify({ concerns }) }), { status: 200 });
}

function modelStatus(status: number): Response {
  return new Response("{}", { status });
}

describe("processPostClassAiReviews", () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  let consoleError: MockInstance<typeof console.error>;

  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("bounds each model call with a 30s timeout and records a timed-out first attempt as retryable", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    fetchMock.mockRejectedValueOnce(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    const { db, values, sets, results } = fakeDb([
      [candidate(1)], // candidates
      [], // participants
      [], // no earlier run for this request hash
      [{ id: "run-1" }], // the claimed first attempt
      undefined, // the failed-status update
    ]);

    const result = await processPostClassAiReviews({ now: NOW }, db);

    expect(result).toEqual({ processed: 0, failed: 1, skipped: 0, retried: 0, stopped: null });
    expect(timeout).toHaveBeenCalledWith(30_000);
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(timeout.mock.results[0].value);
    expect(values).toEqual([expect.objectContaining({
      status: "running",
      triggerReasons: ["short_required_field", "placeholder_pattern"],
      metadata: expect.objectContaining({ promptVersion: 1, attempts: 1 }),
    })]);
    expect(sets).toEqual([expect.objectContaining({
      status: "failed",
      errorMessage: "AI quality review failed",
      metadata: expect.objectContaining({ attempts: 1, retryable: true, lastErrorName: "TimeoutError" }),
    })]);
    expect(results).toEqual([]);
  });

  it("records a permanent failure as not retryable", async () => {
    fetchMock.mockResolvedValueOnce(modelStatus(400));
    const { db, sets } = fakeDb([[candidate(1)], [], [], [{ id: "run-1" }], undefined]);

    const result = await processPostClassAiReviews({ now: NOW }, db);

    expect(result).toMatchObject({ failed: 1, stopped: null });
    expect(sets).toEqual([expect.objectContaining({
      errorMessage: "OpenAI HTTP 400",
      metadata: expect.objectContaining({ attempts: 1, retryable: false, lastErrorName: "Error" }),
    })]);
  });

  it("starts no model call that could not finish before the tick's deadline", async () => {
    const { db, values, results } = fakeDb([[candidate(1)], [], []]);

    const result = await processPostClassAiReviews({ now: NOW, deadlineAt: Date.now() + 10_000 }, db);

    expect(result).toEqual({ processed: 0, failed: 0, skipped: 0, retried: 0, stopped: "deadline" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(values).toEqual([]);
    expect(results).toEqual([]);
    expect(consoleError.mock.calls).toEqual([[
      "[post-class-ai-review]",
      { stopped: "deadline", processed: 0, failed: 0, retried: 0 },
    ]]);
  });

  it("stops the pass after three consecutive model failures and leaves the rest untouched", async () => {
    fetchMock.mockImplementation(async () => modelStatus(503));
    const { db, results } = fakeDb([
      [candidate(1), candidate(2), candidate(3), candidate(4)],
      [],
      [], [{ id: "run-1" }], undefined,
      [], [{ id: "run-2" }], undefined,
      [], [{ id: "run-3" }], undefined,
    ]);

    const result = await processPostClassAiReviews({ now: NOW }, db);

    expect(result).toEqual({ processed: 0, failed: 3, skipped: 0, retried: 0, stopped: "model_failures" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(results).toEqual([]);
    expect(consoleError.mock.calls).toEqual([[
      "[post-class-ai-review]",
      { stopped: "model_failures", processed: 0, failed: 3, retried: 0 },
    ]]);
  });

  it("counts only consecutive failures toward the stop", async () => {
    fetchMock
      .mockResolvedValueOnce(modelStatus(503))
      .mockResolvedValueOnce(modelReply())
      .mockResolvedValueOnce(modelStatus(503))
      .mockResolvedValueOnce(modelStatus(503));
    const { db, results } = fakeDb([
      [candidate(1), candidate(2), candidate(3), candidate(4)],
      [],
      [], [{ id: "run-1" }], undefined,
      [], [{ id: "run-2" }], [{ id: "run-2" }], // the success settles in one transaction
      [], [{ id: "run-3" }], undefined,
      [], [{ id: "run-4" }], undefined,
    ]);

    const result = await processPostClassAiReviews({ now: NOW }, db);

    expect(result).toEqual({ processed: 1, failed: 3, skipped: 0, retried: 0, stopped: null });
    expect(results).toEqual([]);
  });

  it("leaves suspect versions unclaimed without OPENAI_API_KEY, and keeps settling healthy ones", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const { db, values, results } = fakeDb([
      [candidate(1, HEALTHY_FIELDS), candidate(2), candidate(3, HEALTHY_FIELDS)],
      [],
      [], undefined, // healthy: no earlier run, deterministic-only row
      [], // suspect: no earlier run, left unclaimed
      [], undefined, // healthy again, after the suspect one
    ]);

    const result = await processPostClassAiReviews({ now: NOW }, db);

    expect(result).toEqual({ processed: 0, failed: 0, skipped: 3, retried: 0, stopped: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(values).toEqual([
      expect.objectContaining({ feedbackVersionId: "version-1", model: "deterministic-only", status: "succeeded" }),
      expect.objectContaining({ feedbackVersionId: "version-3", model: "deterministic-only", status: "succeeded" }),
    ]);
    expect(results).toEqual([]);
    expect(consoleError.mock.calls).toEqual([[
      "[post-class-ai-review]",
      { stopped: "not_configured", processed: 0, failed: 0, retried: 0 },
    ]]);
  });

  it("retries a transient failure an hour later on the same row, from its recorded triggers", async () => {
    fetchMock.mockResolvedValueOnce(modelReply([{ dimension: "vagueness", summary: "Generic praise only.", confidence: 0.8 }]));
    const { db, values, sets, results } = fakeDb([
      [candidate(1)],
      [],
      [earlierRun({ status: "failed", metadata: { attempts: 1, retryable: true, lastErrorName: "TimeoutError" } })],
      [{ id: "run-earlier" }], // the conditional claim won
      [{ id: "run-earlier" }], // the succeeded update, still holding the claim
      undefined, // the concerns insert, in the same transaction
    ]);

    const result = await processPostClassAiReviews({ now: NOW }, db);

    expect(result).toEqual({ processed: 1, failed: 0, skipped: 0, retried: 1, stopped: null });
    expect(sets[0]).toEqual(expect.objectContaining({
      status: "running",
      finishedAt: null,
      errorMessage: null,
      startedAt: expect.any(Date),
      metadata: { promptVersion: 1, highestPriorSimilarity: 0.25, matchingPriorKey: null, attempts: 2 },
    }));
    expect(sets[1]).toEqual(expect.objectContaining({ status: "succeeded" }));
    expect(values).toEqual([[expect.objectContaining({ runId: "run-earlier", dimension: "vagueness" })]]);
    // The stored triggers and similarity, not a fresh assessment (which would add placeholder_pattern).
    const prompt = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).input as string;
    expect(prompt).toContain("Deterministic triggers: short_required_field\n\nPrior-text similarity: 25.0%");
    expect(results).toEqual([]);
  });

  it("recovers a run killed mid-call once it has been running for 15 minutes", async () => {
    fetchMock.mockResolvedValueOnce(modelReply());
    const { db, sets } = fakeDb([
      [candidate(1)],
      [],
      [earlierRun({ status: "running", metadata: {}, finishedAt: null, updatedAt: minutesBefore(20) })],
      [{ id: "run-earlier" }],
      [{ id: "run-earlier" }],
    ]);

    const result = await processPostClassAiReviews({ now: NOW }, db);

    expect(result).toMatchObject({ processed: 1, retried: 1 });
    expect(sets[0]).toEqual(expect.objectContaining({ status: "running", metadata: expect.objectContaining({ attempts: 2 }) }));
  });

  it("treats a rejected key like a missing one: the claim is released and later suspect versions wait", async () => {
    fetchMock.mockResolvedValueOnce(modelStatus(401));
    const { db, values, sets, deletes, results } = fakeDb([
      [candidate(1), candidate(2), candidate(3, HEALTHY_FIELDS)],
      [],
      [], [{ id: "run-1" }], undefined, // first attempt claimed, rejected, released (deleted)
      [], // the next suspect version is left unclaimed
      [], undefined, // a healthy version still settles
    ]);

    const result = await processPostClassAiReviews({ now: NOW }, db);

    expect(result).toEqual({ processed: 0, failed: 0, skipped: 3, retried: 0, stopped: "key_rejected" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(deletes).toHaveLength(1);
    expect(sets).toEqual([]);
    expect(values).toEqual([
      expect.objectContaining({ feedbackVersionId: "version-1", status: "running" }),
      expect.objectContaining({ feedbackVersionId: "version-3", model: "deterministic-only" }),
    ]);
    expect(results).toEqual([]);
    expect(consoleError.mock.calls).toEqual([[
      "[post-class-ai-review]",
      { stopped: "key_rejected", processed: 0, failed: 0, retried: 0 },
    ]]);
  });

  it("restores a retry's row exactly as it was when OpenAI rejects the key", async () => {
    fetchMock.mockResolvedValueOnce(modelStatus(403));
    const earlier = earlierRun({ status: "failed", metadata: { attempts: 1, retryable: true, lastErrorName: "Error" } });
    const { db, sets, deletes, results } = fakeDb([
      [candidate(1)],
      [],
      [earlier],
      [{ id: "run-earlier" }], // the conditional claim
      undefined, // the release
    ]);

    const result = await processPostClassAiReviews({ now: NOW }, db);

    expect(result).toEqual({ processed: 0, failed: 0, skipped: 1, retried: 0, stopped: "key_rejected" });
    expect(deletes).toEqual([]);
    expect(sets[1]).toEqual({
      status: earlier.status,
      model: earlier.model,
      startedAt: earlier.startedAt,
      finishedAt: earlier.finishedAt,
      errorMessage: earlier.errorMessage,
      metadata: earlier.metadata,
      updatedAt: earlier.updatedAt,
    });
    expect(results).toEqual([]);
  });

  it("closes a killed run that is out of attempts as failed, without calling the model", async () => {
    const { db, sets, results } = fakeDb([
      [candidate(1)],
      [],
      [earlierRun({ status: "running", metadata: { attempts: 3 }, finishedAt: null, updatedAt: minutesBefore(20) })],
      undefined, // the conditional close
    ]);

    const result = await processPostClassAiReviews({ now: NOW }, db);

    expect(result).toEqual({ processed: 0, failed: 0, skipped: 1, retried: 0, stopped: null });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sets).toEqual([expect.objectContaining({
      status: "failed",
      errorMessage: "AI quality review abandoned after its last attempt was interrupted",
      metadata: expect.objectContaining({ attempts: 3, retryable: false }),
    })]);
    expect(results).toEqual([]);
  });

  it("writes nothing when the pass lost its claim before saving an answer", async () => {
    fetchMock.mockResolvedValueOnce(modelReply([{ dimension: "vagueness", summary: "Generic praise only.", confidence: 0.8 }]));
    const { db, values, results } = fakeDb([[candidate(1)], [], [], [{ id: "run-1" }], []]);

    const result = await processPostClassAiReviews({ now: NOW }, db);

    expect(result).toEqual({ processed: 0, failed: 0, skipped: 1, retried: 0, stopped: null });
    expect(values).toHaveLength(1); // the claim only; no concerns without the claim
    expect(results).toEqual([]);
  });

  it("records a failed save as a retryable failure that does not count toward the stop", async () => {
    fetchMock.mockImplementation(async () => modelReply());
    const saveError = new Error("Connection terminated unexpectedly");
    const { db, sets, results } = fakeDb([
      [candidate(1), candidate(2), candidate(3)],
      [],
      [], [{ id: "run-1" }], saveError, undefined,
      [], [{ id: "run-2" }], saveError, undefined,
      [], [{ id: "run-3" }], saveError, undefined,
    ]);

    const result = await processPostClassAiReviews({ now: NOW }, db);

    expect(result).toEqual({ processed: 0, failed: 3, skipped: 0, retried: 0, stopped: null });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const failures = sets.filter((set) => set.status === "failed");
    expect(failures).toHaveLength(3);
    for (const failure of failures) {
      expect(failure.metadata).toEqual(expect.objectContaining({ retryable: true, lastErrorName: "Error" }));
    }
    expect(results).toEqual([]);
  });

  it.each([
    ["a transient failure still inside its hour", earlierRun({ status: "failed", metadata: { attempts: 1, retryable: true }, finishedAt: minutesBefore(10) })],
    ["a transient failure out of attempts", earlierRun({ status: "failed", metadata: { attempts: 3, retryable: true } })],
    ["a permanent failure", earlierRun({ status: "failed", metadata: { attempts: 1, retryable: false } })],
    ["a failure recorded before retries existed", earlierRun({ status: "failed" })],
    ["a run claimed 10 minutes ago", earlierRun({ status: "running", finishedAt: null, updatedAt: minutesBefore(10) })],
    ["a finished review", earlierRun({ status: "succeeded" })],
  ])("skips %s without calling the model", async (_label, existing) => {
    const { db, values, sets, results } = fakeDb([[candidate(1)], [], [existing]]);

    const result = await processPostClassAiReviews({ now: NOW }, db);

    expect(result).toEqual({ processed: 0, failed: 0, skipped: 1, retried: 0, stopped: null });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(values).toEqual([]);
    expect(sets).toEqual([]);
    expect(results).toEqual([]);
  });

  it.each([
    ["a retry whose conditional claim another pass won", [earlierRun({ status: "failed", metadata: { attempts: 1, retryable: true } })]],
    ["a first attempt whose insert another pass won", []],
  ])("skips %s without calling the model", async (_label, existing) => {
    const { db, results } = fakeDb([[candidate(1)], [], existing, []]);

    const result = await processPostClassAiReviews({ now: NOW }, db);

    expect(result).toEqual({ processed: 0, failed: 0, skipped: 1, retried: 0, stopped: null });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });
});

describe("isTransientQualityModelError", () => {
  it.each([
    ["a timeout", new DOMException("The operation was aborted due to timeout", "TimeoutError")],
    ["an abort", new DOMException("This operation was aborted", "AbortError")],
    ["a network failure", new TypeError("fetch failed")],
    ["a socket dropped mid-body", new TypeError("terminated")],
    ["a rate limit", new Error("OpenAI HTTP 429")],
    ["a server error", new Error("OpenAI HTTP 500")],
    ["an unavailable service", new Error("OpenAI HTTP 503")],
  ])("retries %s", (_label, error) => {
    expect(isTransientQualityModelError(error)).toBe(true);
  });

  it.each([
    ["a bad request", new Error("OpenAI HTTP 400")],
    ["a rejected key", new Error("OpenAI HTTP 401")],
    ["a missing key", new Error("OPENAI_API_KEY is not configured")],
    ["unparseable output", new SyntaxError("Unexpected token < in JSON at position 0")],
    ["output that breaks the schema", (() => {
      try { z.object({ concerns: z.array(z.string()) }).parse({}); } catch (error) { return error; }
      throw new Error("unreachable");
    })()],
    ["a reply without output text", new Error("OpenAI response did not include output text")],
    ["a code bug", new TypeError("Cannot read properties of undefined (reading 'text')")],
    ["a thrown string", "fetch failed"],
  ])("does not retry %s", (_label, error) => {
    expect(isTransientQualityModelError(error)).toBe(false);
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
