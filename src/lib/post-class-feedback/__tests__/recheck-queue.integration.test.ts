/**
 * REC-02 — the recheck lane must not be occupied by sessions Wise deleted.
 *
 * A session-scoped issue raised before the session ever got a row carries
 * `session_id = NULL`, so it is re-queued from the issue's own retry details.
 * That is right for a session that can come back and wrong for one Wise has
 * removed: it has no row to auto-resolve against, so it would be re-fetched
 * every 30 minutes forever, spending a Wise call and a recheck slot that a
 * recoverable session could have used. Production had 228 of them.
 *
 * Runs against real Postgres — `npm run test:integration` (Docker), or point at
 * a scratch database with TEST_DATABASE_URL.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { startTestDb, stopTestDb, truncateAll } from "@/tests/integration/db-helper";
import { createDrizzlePostClassFeedbackRepository } from "@/lib/post-class-feedback/repository";
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
});

function appDb(): Database {
  return handle.db as unknown as Database;
}

const DAY_MS = 24 * 60 * 60 * 1000;

async function startRun(): Promise<string> {
  const [run] = await handle.db.insert(schema.postClassSyncRuns).values({
    status: "running",
    windowStart: "2026-07-01",
    windowEnd: "2026-07-04",
  }).returning({ id: schema.postClassSyncRuns.id });
  return run.id;
}

/**
 * An issue raised for a session that has no row yet — exactly the shape
 * `safeWiseIssue` produces when the very first detail fetch fails.
 */
async function insertOrphanIssue(input: {
  runId: string;
  sessionId: string;
  issueType: "session_not_found" | "contract_error";
  fingerprint: string;
  ageDays: number;
}): Promise<void> {
  const seenAt = new Date(Date.now() - input.ageDays * DAY_MS);
  await handle.db.insert(schema.postClassSourceIssues).values({
    syncRunId: input.runId,
    sessionId: null,
    scope: "session",
    issueType: input.issueType,
    severity: "error",
    status: "open",
    blocksEnforcement: true,
    fingerprint: input.fingerprint,
    message: `Wise session ${input.sessionId} could not be reconciled.`,
    details: {
      retryCandidate: {
        sessionId: input.sessionId,
        classId: "class-1",
        scheduledStartAt: "2026-07-20T09:00:00.000Z",
        scheduledEndAt: "2026-07-20T10:00:00.000Z",
      },
    },
    firstSeenAt: seenAt,
    lastSeenAt: seenAt,
  });
}

async function queuedSessionIds(limit = 50): Promise<string[]> {
  const repository = createDrizzlePostClassFeedbackRepository(appDb());
  const candidates = await repository.listIncompleteRecheckCandidates(limit);
  return candidates.map((candidate) => candidate.sessionId);
}

describe("REC-02 recheck queue and missing sessions", () => {
  it("still retries a recently missing session", async () => {
    const runId = await startRun();
    await insertOrphanIssue({
      runId,
      sessionId: "recently-missing",
      issueType: "session_not_found",
      fingerprint: "session_not_found:recently-missing:400",
      ageDays: 1,
    });

    expect(await queuedSessionIds()).toContain("recently-missing");
  });

  it("stops retrying a session Wise has reported missing beyond the grace window", async () => {
    const runId = await startRun();
    await insertOrphanIssue({
      runId,
      sessionId: "long-gone",
      issueType: "session_not_found",
      fingerprint: "session_not_found:long-gone:400",
      ageDays: 30,
    });

    expect(await queuedSessionIds()).not.toContain("long-gone");
  });

  it("keeps the issue open and visible after it stops being retried", async () => {
    const runId = await startRun();
    await insertOrphanIssue({
      runId,
      sessionId: "long-gone",
      issueType: "session_not_found",
      fingerprint: "session_not_found:long-gone:400",
      ageDays: 30,
    });

    await queuedSessionIds();

    // Dropping out of the queue is a scheduling decision, not a claim that the
    // problem went away. Data Health must still show it.
    const [issue] = await handle.db.select().from(schema.postClassSourceIssues);
    expect(issue.status).toBe("open");
  });

  it("keeps retrying other old session-scoped failures", async () => {
    const runId = await startRun();
    await insertOrphanIssue({
      runId,
      sessionId: "old-contract-breach",
      issueType: "contract_error",
      fingerprint: "contract_error:old-contract-breach:400",
      ageDays: 30,
    });

    // Only a missing session is known-terminal. A payload that failed to parse
    // may well parse after a Wise fix, so it keeps its place in the queue.
    expect(await queuedSessionIds()).toContain("old-contract-breach");
  });

  it("leaves room for recoverable sessions once the dead ones drop out", async () => {
    const runId = await startRun();
    const at = new Date("2026-07-01T03:00:00.000Z");
    // 60 permanently-missing sessions against a 50-slot lane: before the grace
    // window they would fill it entirely and the live session would never be
    // looked at again.
    for (let index = 0; index < 60; index += 1) {
      await insertOrphanIssue({
        runId,
        sessionId: `dead-${index}`,
        issueType: "session_not_found",
        fingerprint: `session_not_found:dead-${index}:400`,
        ageDays: 30,
      });
    }
    await handle.db.insert(schema.postClassSessions).values({
      wiseSessionId: "recoverable",
      wiseClassId: "class-1",
      scheduledStartAt: at,
      scheduledEndAt: at,
      deadlineAt: at,
      finalStatus: "ENDED",
      eligible: true,
      sourceStatus: "unavailable",
    });

    const queued = await queuedSessionIds();
    expect(queued).toContain("recoverable");
    expect(queued.some((id) => id.startsWith("dead-"))).toBe(false);
  });
});
