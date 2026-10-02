/**
 * The AI review pass against real Postgres: which earlier runs its candidate
 * query treats as due a retry (the jsonb `attempts`/`retryable` metadata, the
 * one-hour cool-down, the 15-minute stale-claim cut-off), and that a run is
 * claimed by exactly one of two overlapping passes.
 *
 * `npm run test:integration` (Docker), or point at a scratch database with
 * TEST_DATABASE_URL.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { eq, sql } from "drizzle-orm";
import { startTestDb, stopTestDb, truncateAll } from "@/tests/integration/db-helper";
import { processPostClassAiReviews } from "@/lib/post-class-feedback/ai";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";

let handle: Awaited<ReturnType<typeof startTestDb>>;

beforeAll(async () => {
  handle = await startTestDb();
}, 60_000);

afterAll(async () => {
  if (handle) await stopTestDb(handle);
});

beforeEach(async () => {
  await truncateAll(handle.db);
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function appDb(): Database {
  return handle.db as unknown as Database;
}

function pass() {
  return processPostClassAiReviews({}, appDb());
}

/**
 * The app db, except that writes to post_class_ai_runs wait until `parties`
 * passes have reached their first one (the claim). Overlapping passes then
 * genuinely race for the same row instead of one finishing before the other
 * looks.
 */
function racingDb(parties: number): Database {
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const held = (builder: object): object => new Proxy(builder, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== "function") return value;
      if (property === "then") {
        return (resolve: (result: unknown) => void, reject: (reason: unknown) => void) => {
          arrived += 1;
          if (arrived >= parties) open();
          return gate.then(() => value.call(target, resolve, reject));
        };
      }
      return (...args: unknown[]) => {
        const next = value.apply(target, args);
        return typeof next === "object" && next !== null ? held(next) : next;
      };
    },
  });
  return new Proxy(handle.db, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if ((property === "insert" || property === "update") && typeof value === "function") {
        return (table: unknown) => {
          const builder = value.call(target, table);
          return table === schema.postClassAiRuns ? held(builder) : builder;
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as Database;
}

/** One eligible, source-ready session whose latest version has short fields, so the model is called. */
async function seedSuspectVersion(n = 1): Promise<void> {
  const at = new Date("2026-09-20T09:00:00.000Z");
  const [session] = await handle.db.insert(schema.postClassSessions).values({
    wiseSessionId: `wise-session-${n}`,
    wiseClassId: "class-1",
    className: "Math",
    scheduledStartAt: at,
    scheduledEndAt: at,
    deadlineAt: at,
    finalStatus: "ENDED",
    eligible: true,
    sourceStatus: "ready",
    enforcementMode: "live",
    lastAssessedAt: at,
  }).returning({ id: schema.postClassSessions.id });
  const [version] = await handle.db.insert(schema.postClassFeedbackVersions).values({
    sessionId: session.id,
    versionKey: `version-${n}`,
    contentHash: `hash-${n}`,
    observedAt: at,
    topics: "ok",
    performance: "ok",
    improvement: "ok",
    substantive: true,
  }).returning({ id: schema.postClassFeedbackVersions.id });
  await handle.db.update(schema.postClassSessions)
    .set({ latestFeedbackVersionId: version.id })
    .where(eq(schema.postClassSessions.id, session.id));
}

function modelFails(status: number) {
  return vi.fn<typeof fetch>(async () => new Response("{}", { status }));
}

function modelReplies() {
  return vi.fn<typeof fetch>(async () =>
    new Response(JSON.stringify({ output_text: JSON.stringify({ concerns: [] }) }), { status: 200 }));
}

async function runs() {
  return handle.db.select().from(schema.postClassAiRuns);
}

/** Moves every run's clock back, as if its failure or claim happened `minutes` ago. */
async function age(minutes: number): Promise<void> {
  await handle.db.execute(sql`
    update post_class_ai_runs
    set finished_at = finished_at - make_interval(mins => ${minutes}),
        updated_at = updated_at - make_interval(mins => ${minutes})
  `);
}

describe("processPostClassAiReviews retries (real Postgres)", () => {
  it("retries a transient failure only after an hour, on the same row, three attempts in all", async () => {
    await seedSuspectVersion();
    const fetchMock = modelFails(503);
    vi.stubGlobal("fetch", fetchMock);

    expect(await pass()).toMatchObject({ failed: 1, retried: 0, stopped: null });
    expect((await runs())[0]).toMatchObject({
      status: "failed",
      errorMessage: "OpenAI HTTP 503",
      metadata: expect.objectContaining({ attempts: 1, retryable: true, lastErrorName: "Error" }),
    });

    // Inside the hour the version is not a candidate at all.
    expect(await pass()).toEqual({ processed: 0, failed: 0, skipped: 0, retried: 0, stopped: null });

    await age(61);
    expect(await pass()).toMatchObject({ failed: 1, retried: 1 });
    expect((await runs())[0].metadata).toMatchObject({ attempts: 2, retryable: true });

    await age(61);
    expect(await pass()).toMatchObject({ failed: 1, retried: 1 });
    expect((await runs())[0].metadata).toMatchObject({ attempts: 3 });

    // Three attempts spent: never selected again.
    await age(61);
    expect(await pass()).toEqual({ processed: 0, failed: 0, skipped: 0, retried: 0, stopped: null });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(await runs()).toHaveLength(1);
  });

  it("never retries a permanent failure", async () => {
    await seedSuspectVersion();
    const fetchMock = modelFails(400);
    vi.stubGlobal("fetch", fetchMock);

    expect(await pass()).toMatchObject({ failed: 1 });
    expect((await runs())[0].metadata).toMatchObject({ attempts: 1, retryable: false });

    await age(180);
    expect(await pass()).toEqual({ processed: 0, failed: 0, skipped: 0, retried: 0, stopped: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("leaves failures recorded before retries existed alone", async () => {
    await seedSuspectVersion();
    vi.stubGlobal("fetch", modelFails(429));
    await pass();
    // What every pre-existing failed row looks like: no retry metadata.
    await handle.db.execute(sql`update post_class_ai_runs set metadata = metadata - 'attempts' - 'retryable' - 'lastErrorName'`);
    await age(180);
    const fetchMock = modelReplies();
    vi.stubGlobal("fetch", fetchMock);

    expect(await pass()).toEqual({ processed: 0, failed: 0, skipped: 0, retried: 0, stopped: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("recovers a run killed mid-call once its claim is 15 minutes old, and records the review", async () => {
    await seedSuspectVersion();
    vi.stubGlobal("fetch", modelFails(503));
    await pass();
    // A function killed after its claim leaves the row running with no finish.
    await handle.db.execute(sql`update post_class_ai_runs set status = 'running', finished_at = null, updated_at = now() - interval '10 minutes'`);
    const fetchMock = modelReplies();
    vi.stubGlobal("fetch", fetchMock);

    expect(await pass()).toEqual({ processed: 0, failed: 0, skipped: 0, retried: 0, stopped: null });

    await age(6);
    expect(await pass()).toEqual({ processed: 1, failed: 0, skipped: 0, retried: 1, stopped: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await runs())[0]).toMatchObject({ status: "succeeded", metadata: expect.objectContaining({ attempts: 2 }) });
  });

  it("lets exactly one of two overlapping passes make the first attempt", async () => {
    await seedSuspectVersion();
    const fetchMock = modelReplies();
    vi.stubGlobal("fetch", fetchMock);
    const db = racingDb(2);

    const results = await Promise.all([
      processPostClassAiReviews({}, db),
      processPostClassAiReviews({}, db),
    ]);

    // Both passes inserted the same request hash; the loser skipped instead of failing on 23505.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results.map((result) => [result.processed, result.skipped]).sort()).toEqual([[0, 1], [1, 0]]);
    expect(await runs()).toHaveLength(1);
  });

  it("lets exactly one of two overlapping passes claim a due retry", async () => {
    await seedSuspectVersion();
    vi.stubGlobal("fetch", modelFails(503));
    await pass();
    await age(61);
    const fetchMock = modelReplies();
    vi.stubGlobal("fetch", fetchMock);
    const db = racingDb(2);

    const results = await Promise.all([
      processPostClassAiReviews({}, db),
      processPostClassAiReviews({}, db),
    ]);

    // Both passes tried the conditional claim; only one matched status and attempts.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results.map((result) => [result.retried, result.skipped]).sort()).toEqual([[0, 1], [1, 0]]);
    expect((await runs())[0]).toMatchObject({ status: "succeeded", metadata: expect.objectContaining({ attempts: 2 }) });
  });
  it("lets exactly one of two overlapping passes reclaim a run killed mid-call", async () => {
    await seedSuspectVersion();
    vi.stubGlobal("fetch", modelFails(503));
    await pass();
    // running -> running: only the attempts condition stops a second claimer.
    await handle.db.execute(sql`update post_class_ai_runs set status = 'running', finished_at = null, updated_at = now() - interval '20 minutes'`);
    const fetchMock = modelReplies();
    vi.stubGlobal("fetch", fetchMock);
    const db = racingDb(2);

    const results = await Promise.all([
      processPostClassAiReviews({}, db),
      processPostClassAiReviews({}, db),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results.map((result) => [result.retried, result.skipped]).sort()).toEqual([[0, 1], [1, 0]]);
    expect((await runs())[0]).toMatchObject({ status: "succeeded", metadata: expect.objectContaining({ attempts: 2 }) });
  });

  it("closes a run killed mid-call on its last attempt instead of leaving it running", async () => {
    await seedSuspectVersion();
    vi.stubGlobal("fetch", modelFails(503));
    await pass();
    await handle.db.execute(sql`
      update post_class_ai_runs
      set status = 'running', finished_at = null, updated_at = now() - interval '20 minutes',
          metadata = jsonb_set(metadata, '{attempts}', '3')
    `);
    const fetchMock = modelReplies();
    vi.stubGlobal("fetch", fetchMock);

    expect(await pass()).toEqual({ processed: 0, failed: 0, skipped: 1, retried: 0, stopped: null });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await runs())[0]).toMatchObject({
      status: "failed",
      errorMessage: "AI quality review abandoned after its last attempt was interrupted",
      metadata: expect.objectContaining({ attempts: 3, retryable: false }),
    });
    // Closed for good: never selected again.
    await age(120);
    expect(await pass()).toEqual({ processed: 0, failed: 0, skipped: 0, retried: 0, stopped: null });
  });

  it("does not retry a failure recorded under an older prompt", async () => {
    await seedSuspectVersion();
    vi.stubGlobal("fetch", modelFails(503));
    await pass();
    await handle.db.execute(sql`update post_class_ai_runs set metadata = jsonb_set(metadata, '{promptVersion}', '0')`);
    await age(61);
    const fetchMock = modelReplies();
    vi.stubGlobal("fetch", fetchMock);

    expect(await pass()).toEqual({ processed: 0, failed: 0, skipped: 0, retried: 0, stopped: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads a hand-edited non-number attempts as one attempt instead of failing the query", async () => {
    await seedSuspectVersion();
    vi.stubGlobal("fetch", modelFails(503));
    await pass();
    await handle.db.execute(sql`update post_class_ai_runs set metadata = jsonb_set(metadata, '{attempts}', '"1.5x"')`);
    await age(61);
    const fetchMock = modelReplies();
    vi.stubGlobal("fetch", fetchMock);

    expect(await pass()).toEqual({ processed: 1, failed: 0, skipped: 0, retried: 1, stopped: null });
    expect((await runs())[0].metadata).toMatchObject({ attempts: 2 });
  });
  it("releases a first attempt whose key OpenAI rejects, so the version runs once the key works", async () => {
    await seedSuspectVersion();
    vi.stubGlobal("fetch", modelFails(401));

    expect(await pass()).toEqual({ processed: 0, failed: 0, skipped: 1, retried: 0, stopped: "key_rejected" });
    expect(await runs()).toHaveLength(0);

    const fetchMock = modelReplies();
    vi.stubGlobal("fetch", fetchMock);
    expect(await pass()).toEqual({ processed: 1, failed: 0, skipped: 0, retried: 0, stopped: null });
    expect((await runs())[0]).toMatchObject({ status: "succeeded", metadata: expect.objectContaining({ attempts: 1 }) });
  });

  it("leaves a due retry exactly as it was when OpenAI rejects the key", async () => {
    await seedSuspectVersion();
    vi.stubGlobal("fetch", modelFails(503));
    await pass();
    await age(61);
    const [before] = await runs();
    vi.stubGlobal("fetch", modelFails(403));

    expect(await pass()).toEqual({ processed: 0, failed: 0, skipped: 1, retried: 0, stopped: "key_rejected" });
    const [after] = await runs();
    expect(after).toEqual(before);
  });
});
