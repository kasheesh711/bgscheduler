/**
 * REC-03: sessions Wise deleted must leave the collector's candidate lanes.
 *
 * A deleted session answers every detail fetch with HTTP 400 "Session not
 * found!", and it can never auto-resolve: resolution needs a successful
 * observation, and its feedback event only stops being a candidate once a
 * successful observation links it. Production accumulated 230 open issues from
 * 121 such sessions, which occupied ~30 of each run's 50 Wise calls and pinned
 * every run's outcome at "partial" — permanently blocking activation.
 *
 * The load-bearing case here is `still returns the live session queued behind
 * them`: the filters must live inside the lane SQL, before its LIMIT. A
 * post-hoc filter would stop the wasted fetches but never let the paging loop
 * reach the live sessions, so a backlog of dead sessions would still starve
 * the run — the symptom would change shape rather than go away.
 *
 * `npm run test:integration` (Docker), or point at a scratch database with
 * TEST_DATABASE_URL.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { eq } from "drizzle-orm";
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
  // Outside the shared truncation helper, but this suite writes deterministic
  // activity fixtures and must stay repeatable against one scratch database.
  await handle.db.delete(schema.wiseActivityEvents);
});

function repository() {
  return createDrizzlePostClassFeedbackRepository(handle.db as unknown as Database);
}

const CLASS_ID = "class-1";

/** An unlinked feedback event — the highest-priority candidate lane. */
async function seedFeedbackEvent(wiseSessionId: string, at: string): Promise<void> {
  await handle.db.insert(schema.wiseActivityEvents).values({
    eventId: `evt-feedback-${wiseSessionId}`,
    eventType: "session",
    eventName: "SessionFeedbackSubmittedEvent",
    eventTimestamp: new Date(at),
    sessionId: wiseSessionId,
    classroomId: CLASS_ID,
    sessionStartTime: new Date(at),
    sessionEndTime: new Date(at),
    payload: { session: { id: wiseSessionId }, classroom: { _id: CLASS_ID } },
    raw: {},
  });
}

async function seedDeletionEvent(wiseSessionId: string, at: string): Promise<void> {
  await handle.db.insert(schema.wiseActivityEvents).values({
    eventId: `evt-deleted-${wiseSessionId}`,
    eventType: "session",
    eventName: "SessionDeletedEvent",
    eventTimestamp: new Date(at),
    sessionId: wiseSessionId,
    classroomId: CLASS_ID,
    payload: { session: { id: wiseSessionId } },
    raw: {},
  });
}

async function seedSession(input: {
  wiseSessionId: string;
  eligible?: boolean;
  eligibilityReason?: string;
}): Promise<string> {
  const at = new Date("2026-07-04T09:00:00.000Z");
  const [row] = await handle.db.insert(schema.postClassSessions).values({
    wiseSessionId: input.wiseSessionId,
    wiseClassId: CLASS_ID,
    className: "Math",
    canonicalTutorKey: "kevin",
    canonicalTutorName: "Kevin",
    scheduledStartAt: at,
    scheduledEndAt: at,
    deadlineAt: at,
    finalStatus: "ENDED",
    eligible: input.eligible ?? true,
    eligibilityReason: input.eligibilityReason ?? "ended_positive_credits",
    sourceStatus: "ready",
  }).returning({ id: schema.postClassSessions.id });
  return row.id;
}

/** An orphan issue: raised before the session ever got a row (228 of 230 in prod). */
async function seedOrphanNotFoundIssue(input: {
  wiseSessionId: string;
  firstSeenAt: string;
  issueType?: string;
}): Promise<void> {
  await handle.db.insert(schema.postClassSourceIssues).values({
    scope: "session",
    issueType: input.issueType ?? "session_not_found",
    severity: "error",
    status: "open",
    blocksEnforcement: true,
    fingerprint: `${input.issueType ?? "session_not_found"}:${input.wiseSessionId}:400`,
    message: `Wise session ${input.wiseSessionId} was not found.`,
    details: { retryCandidate: { sessionId: input.wiseSessionId, classId: CLASS_ID } },
    firstSeenAt: new Date(input.firstSeenAt),
    lastSeenAt: new Date(input.firstSeenAt),
  });
}

async function beginRun(): Promise<string> {
  return repository().beginSync({
    triggerType: "cron",
    actorEmail: null,
    startedAt: new Date(),
    windowStart: "2026-07-01",
    windowEnd: "2026-07-04",
    detailCap: 50,
  });
}

describe("deleted Wise sessions leave the candidate lanes", () => {
  it("skips a deleted session and still returns the live session queued behind it", async () => {
    // The deleted session's event is newer, so it sorts first and would consume
    // the budget if the filter were applied after the query's LIMIT.
    await seedFeedbackEvent("deleted-session", "2026-07-25T15:57:00.000Z");
    await seedDeletionEvent("deleted-session", "2026-07-25T15:57:00.000Z");
    await seedFeedbackEvent("live-session", "2026-07-24T10:00:00.000Z");

    const candidates = await repository().listFeedbackEventCandidates(1);

    expect(candidates.map((candidate) => candidate.sessionId)).toEqual(["live-session"]);
  });

  it("keeps proposing a session Wise still has", async () => {
    await seedFeedbackEvent("live-session", "2026-07-24T10:00:00.000Z");

    const candidates = await repository().listFeedbackEventCandidates(10);

    expect(candidates.map((candidate) => candidate.sessionId)).toEqual(["live-session"]);
  });

  it("drops a deleted session from the incomplete-recheck lane", async () => {
    await seedSession({ wiseSessionId: "deleted-session" });
    await seedSession({ wiseSessionId: "live-session" });
    await seedDeletionEvent("deleted-session", "2026-07-25T15:57:00.000Z");

    const candidates = await repository().listIncompleteRecheckCandidates(10);

    expect(candidates.map((candidate) => candidate.sessionId)).toEqual(["live-session"]);
  });

  it("drops a deleted session from the orphan-issue retry lane", async () => {
    await seedOrphanNotFoundIssue({
      wiseSessionId: "deleted-session",
      firstSeenAt: new Date().toISOString(),
    });
    await seedDeletionEvent("deleted-session", "2026-07-25T15:57:00.000Z");

    const candidates = await repository().listIncompleteRecheckCandidates(10);

    expect(candidates).toEqual([]);
  });

  it("stops retrying an evidence-free missing session once the grace window expires", async () => {
    // No deletion event: the activity mirror only reaches back so far, so an
    // old missing session gets time rather than a guess.
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await seedOrphanNotFoundIssue({ wiseSessionId: "ancient-session", firstSeenAt: longAgo });
    await seedFeedbackEvent("ancient-session", "2026-04-02T10:00:00.000Z");

    const [events, rechecks] = await Promise.all([
      repository().listFeedbackEventCandidates(10),
      repository().listIncompleteRecheckCandidates(10),
    ]);

    expect(events).toEqual([]);
    expect(rechecks).toEqual([]);
  });

  it("still retries a recently-missing session with no deletion evidence", async () => {
    await seedOrphanNotFoundIssue({
      wiseSessionId: "maybe-transient",
      firstSeenAt: new Date().toISOString(),
    });

    const candidates = await repository().listIncompleteRecheckCandidates(10);

    expect(candidates.map((candidate) => candidate.sessionId)).toEqual(["maybe-transient"]);
  });
});

describe("retireDeletedWiseSessions", () => {
  it("resolves orphan and linked issues and marks the session row terminal", async () => {
    const sessionRowId = await seedSession({ wiseSessionId: "deleted-with-row" });
    await seedDeletionEvent("deleted-with-row", "2026-07-25T15:57:00.000Z");
    await seedDeletionEvent("deleted-orphan", "2026-07-25T15:57:00.000Z");
    await seedOrphanNotFoundIssue({
      wiseSessionId: "deleted-orphan",
      firstSeenAt: new Date().toISOString(),
    });
    // The `detail_retry` contract_error raised alongside a failed fetch must be
    // retired too, or it keeps the run dirty on its own.
    await seedOrphanNotFoundIssue({
      wiseSessionId: "deleted-orphan",
      firstSeenAt: new Date().toISOString(),
      issueType: "contract_error",
    });
    await handle.db.insert(schema.postClassSourceIssues).values({
      sessionId: sessionRowId,
      scope: "session",
      issueType: "session_not_found",
      severity: "error",
      status: "open",
      blocksEnforcement: true,
      fingerprint: "session_not_found:deleted-with-row:400",
      message: "Wise session deleted-with-row was not found.",
      details: {},
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
    });

    const runId = await beginRun();
    const result = await repository().retireDeletedWiseSessions!({
      runId,
      observedAt: new Date(),
    });

    expect(result).toEqual({ retiredIssues: 3, retiredSessions: 1 });

    const issues = await handle.db.select().from(schema.postClassSourceIssues);
    expect(issues.every((issue) => issue.status === "resolved")).toBe(true);
    expect(issues.every((issue) =>
      (issue.details as Record<string, unknown>).retiredReason === "wise_session_deleted")).toBe(true);

    const [session] = await handle.db.select().from(schema.postClassSessions)
      .where(eq(schema.postClassSessions.id, sessionRowId));
    expect(session.wiseDeletedAt).not.toBeNull();
    expect(session.eligible).toBe(false);
    expect(session.eligibilityReason).toBe("deleted_in_wise");
  });

  it("leaves a live session and its issues alone", async () => {
    const sessionRowId = await seedSession({ wiseSessionId: "live-session" });
    await seedOrphanNotFoundIssue({
      wiseSessionId: "maybe-transient",
      firstSeenAt: new Date().toISOString(),
    });

    const runId = await beginRun();
    const result = await repository().retireDeletedWiseSessions!({
      runId,
      observedAt: new Date(),
    });

    expect(result).toEqual({ retiredIssues: 0, retiredSessions: 0 });
    const [session] = await handle.db.select().from(schema.postClassSessions)
      .where(eq(schema.postClassSessions.id, sessionRowId));
    expect(session.wiseDeletedAt).toBeNull();
    expect(session.eligible).toBe(true);
  });

  it("is idempotent across runs", async () => {
    await seedSession({ wiseSessionId: "deleted-session" });
    await seedDeletionEvent("deleted-session", "2026-07-25T15:57:00.000Z");

    const runId = await beginRun();
    const first = await repository().retireDeletedWiseSessions!({ runId, observedAt: new Date() });
    const second = await repository().retireDeletedWiseSessions!({ runId, observedAt: new Date() });

    expect(first.retiredSessions).toBe(1);
    expect(second.retiredSessions).toBe(0);
  });
});
