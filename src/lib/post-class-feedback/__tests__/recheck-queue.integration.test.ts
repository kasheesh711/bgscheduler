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

import { eq } from "drizzle-orm";

import { startTestDb, stopTestDb, truncateAll } from "@/tests/integration/db-helper";
import { seedPayoutAssessment } from "@/tests/integration/payout-fixtures";
import { autoChargeLowerBoundUtc } from "@/lib/post-class-feedback/auto-approval";
import { loadFeedbackDeadlineCoverage } from "@/lib/post-class-feedback/deadline-coverage";
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

async function seedEligibleSession(input: {
  wiseSessionId: string;
  sourceStatus: "ready" | "unavailable";
  updatedAt: Date;
}): Promise<void> {
  const at = new Date("2026-07-20T09:00:00.000Z");
  await handle.db.insert(schema.postClassSessions).values({
    wiseSessionId: input.wiseSessionId,
    wiseClassId: "class-1",
    scheduledStartAt: at,
    scheduledEndAt: at,
    deadlineAt: at,
    finalStatus: "ENDED",
    eligible: true,
    sourceStatus: input.sourceStatus,
    updatedAt: input.updatedAt,
  });
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

describe("REC-04 non-ready-first recheck ordering", () => {
  it("admits the demoted backlog into the capped slice even when the ready rows are older", async () => {
    // Reproduces the production starvation: a run-wide fail-closed demotion left
    // ~2.5k eligible rows 'unavailable', and because the recheck lane ordered
    // purely by updated_at the older already-'ready' rows filled every detailCap
    // slice while the demoted backlog was never re-observed. Here the ready rows
    // PRECEDE the unavailable ones in updated_at, so an updated_at-only order
    // buries the backlog — the lane must surface the non-ready rows first.
    const olderReady = new Date("2026-07-30T08:00:00.000Z");
    const newerUnavailable = new Date("2026-07-30T08:26:00.000Z");
    for (let index = 0; index < 3; index += 1) {
      await seedEligibleSession({
        wiseSessionId: `ready-${index}`,
        sourceStatus: "ready",
        updatedAt: olderReady,
      });
      await seedEligibleSession({
        wiseSessionId: `unavail-${index}`,
        sourceStatus: "unavailable",
        updatedAt: newerUnavailable,
      });
    }

    // Pool of six eligible rows against a cap of three: only half make the slice.
    const queued = await queuedSessionIds(3);

    expect(queued).toHaveLength(3);
    expect(queued.every((id) => id.startsWith("unavail-"))).toBe(true);
    expect(queued.some((id) => id.startsWith("ready-"))).toBe(false);
  });
});

/**
 * FU1 — a class whose feedback deadline passed must be observed again after
 * that deadline, or a late or short submission is never charged. The lane and
 * the watchdog invariant share one predicate, so these fixtures exercise both.
 */
describe("deadline-crossed recheck lane (FU1)", () => {
  // Bangkok 08:00 on 10 November: the last-ended payout window (26 Sep - 25 Oct)
  // opens the unattended-charging scope.
  const NOW = new Date("2026-11-10T01:00:00.000Z");

  beforeEach(async () => {
    // Outside the shared truncation helper; the deletion-evidence case writes one.
    await handle.db.delete(schema.wiseActivityEvents);
  });

  async function seedDeadlineSession(input: {
    wiseSessionId: string;
    scheduledEndAt: string;
    deadlineAt: string;
    eligible?: boolean;
    wiseDeletedAt?: string | null;
    sourceStatus?: "ready" | "unavailable";
    /** Set when a global source issue demoted the row from this status. */
    sourceStatusBefore?: "ready";
    onTimeCompliant?: boolean;
    /** Assessments to record; a collector key and `source_ready` unless overridden. */
    assessments?: Array<{ assessedAt: string; sourceReady?: boolean; reassess?: boolean }>;
    /** An open, linked `detail_retry` issue last seen at this instant. */
    openSessionIssueLastSeenAt?: string;
  }): Promise<void> {
    const endAt = new Date(input.scheduledEndAt);
    const [session] = await handle.db.insert(schema.postClassSessions).values({
      wiseSessionId: input.wiseSessionId,
      wiseClassId: "class-1",
      scheduledStartAt: endAt,
      scheduledEndAt: endAt,
      deadlineAt: new Date(input.deadlineAt),
      // Coverage is decided by assessment rows, never by this column: stamp it
      // after the deadline everywhere so a regression to it would be caught.
      lastAssessedAt: input.assessments?.length ? new Date("2026-11-09T23:00:00.000Z") : null,
      wiseDeletedAt: input.wiseDeletedAt ? new Date(input.wiseDeletedAt) : null,
      eligible: input.eligible ?? true,
      sourceStatus: input.sourceStatus ?? "ready",
      sourceStatusBefore: input.sourceStatusBefore ?? null,
      finalStatus: "ENDED",
    }).returning({ id: schema.postClassSessions.id });
    if (input.onTimeCompliant) {
      // The column is FK-bound to a real version of this session.
      const [version] = await handle.db.insert(schema.postClassFeedbackVersions).values({
        sessionId: session.id,
        versionKey: `on-time-${input.wiseSessionId}`,
        contentHash: `on-time-${input.wiseSessionId}`,
        observedAt: new Date(input.scheduledEndAt),
      }).returning({ id: schema.postClassFeedbackVersions.id });
      await handle.db.update(schema.postClassSessions)
        .set({ firstOnTimeCompliantVersionId: version.id })
        .where(eq(schema.postClassSessions.id, session.id));
    }
    for (const assessment of input.assessments ?? []) {
      await seedPayoutAssessment(appDb(), session.id, {
        assessedAt: new Date(assessment.assessedAt),
        sourceReady: assessment.sourceReady ?? true,
        sourceStatus: assessment.sourceReady === false ? "unavailable" : "ready",
        ...(assessment.reassess
          ? { assessmentKey: `reassess:${input.wiseSessionId}:${assessment.assessedAt}` }
          : {}),
      });
    }
    if (input.openSessionIssueLastSeenAt) {
      const lastSeenAt = new Date(input.openSessionIssueLastSeenAt);
      await handle.db.insert(schema.postClassSourceIssues).values({
        sessionId: session.id,
        scope: "session",
        issueType: "detail_retry",
        severity: "error",
        status: "open",
        blocksEnforcement: true,
        fingerprint: `detail_retry:${input.wiseSessionId}`,
        message: `Wise session ${input.wiseSessionId} could not be reconciled.`,
        details: {},
        firstSeenAt: lastSeenAt,
        lastSeenAt,
      });
    }
  }

  async function seedDeletionEvent(wiseSessionId: string, at: string): Promise<void> {
    await handle.db.insert(schema.wiseActivityEvents).values({
      eventId: `evt-deleted-${wiseSessionId}`,
      eventType: "session",
      eventName: "SessionDeletedEvent",
      eventTimestamp: new Date(at),
      sessionId: wiseSessionId,
      classroomId: "class-1",
      payload: { session: { id: wiseSessionId } },
      raw: {},
    });
  }

  /** Deadlines are Bangkok end-of-day, two days after the class. */
  async function seedLaneFixtures(): Promise<void> {
    // In the lane: no chargeable assessment after the deadline.
    await seedDeadlineSession({
      wiseSessionId: "lane-recent",
      scheduledEndAt: "2026-11-07T10:00:00.000Z",
      deadlineAt: "2026-11-09T16:59:59.999Z",
    });
    await seedDeadlineSession({
      wiseSessionId: "lane-never",
      scheduledEndAt: "2026-11-05T10:00:00.000Z",
      deadlineAt: "2026-11-07T16:59:59.999Z",
    });
    await seedDeadlineSession({
      wiseSessionId: "lane-boundary",
      scheduledEndAt: "2026-11-04T10:00:00.000Z",
      deadlineAt: "2026-11-06T16:59:59.999Z",
      // Exactly at the deadline is not after it.
      assessments: [{ assessedAt: "2026-11-06T16:59:59.999Z" }],
    });
    // A post-deadline assessment from a batch that hit a global source issue
    // is not source-ready, so it cannot have charged anything.
    await seedDeadlineSession({
      wiseSessionId: "lane-not-ready-assessment",
      scheduledEndAt: "2026-11-03T10:00:00.000Z",
      deadlineAt: "2026-11-05T16:59:59.999Z",
      assessments: [{ assessedAt: "2026-11-06T01:00:00.000Z", sourceReady: false }],
    });
    // A reassess.ts verdict-only rerun never creates a deduction.
    await seedDeadlineSession({
      wiseSessionId: "lane-reassess-only",
      scheduledEndAt: "2026-11-03T12:00:00.000Z",
      deadlineAt: "2026-11-05T16:59:59.999Z",
      assessments: [{ assessedAt: "2026-11-06T01:00:00.000Z", reassess: true }],
    });
    await seedDeadlineSession({
      wiseSessionId: "lane-old",
      scheduledEndAt: "2026-11-02T10:00:00.000Z",
      deadlineAt: "2026-11-04T16:59:59.999Z",
      assessments: [{ assessedAt: "2026-11-03T02:00:00.000Z" }],
    });
    // Out of the lane.
    await seedDeadlineSession({
      wiseSessionId: "assessed-after",
      scheduledEndAt: "2026-11-02T10:00:00.000Z",
      deadlineAt: "2026-11-04T16:59:59.999Z",
      assessments: [
        { assessedAt: "2026-11-03T02:00:00.000Z" },
        { assessedAt: "2026-11-05T01:00:00.000Z" },
      ],
    });
    await seedDeadlineSession({
      wiseSessionId: "not-ready-session",
      scheduledEndAt: "2026-11-02T10:00:00.000Z",
      deadlineAt: "2026-11-04T16:59:59.999Z",
      sourceStatus: "unavailable",
    });
    await seedDeadlineSession({
      wiseSessionId: "on-time-locked",
      scheduledEndAt: "2026-11-02T10:00:00.000Z",
      deadlineAt: "2026-11-04T16:59:59.999Z",
      onTimeCompliant: true,
    });
    // Its detail fetch failed an hour ago: the lane cools down, but the
    // watchdog still counts it as owed.
    await seedDeadlineSession({
      wiseSessionId: "open-session-issue",
      scheduledEndAt: "2026-11-02T10:00:00.000Z",
      deadlineAt: "2026-11-04T16:59:59.999Z",
      openSessionIssueLastSeenAt: "2026-11-10T00:00:00.000Z",
    });
    // In the lane: a REC-01 restore left a linked detail_retry open, but it
    // was last seen before the cool-down, so the lane retries it.
    await seedDeadlineSession({
      wiseSessionId: "stale-session-issue",
      scheduledEndAt: "2026-11-02T12:00:00.000Z",
      deadlineAt: "2026-11-04T16:59:59.999Z",
      openSessionIssueLastSeenAt: "2026-11-09T20:00:00.000Z",
    });
    // In the lane: a global source issue demoted it from ready; an outage
    // must not hide owed sessions from the lane or the watchdog.
    await seedDeadlineSession({
      wiseSessionId: "demoted-ready",
      scheduledEndAt: "2026-11-02T11:00:00.000Z",
      deadlineAt: "2026-11-04T16:59:59.999Z",
      sourceStatus: "unavailable",
      sourceStatusBefore: "ready",
    });
    await seedDeadlineSession({
      wiseSessionId: "not-due",
      scheduledEndAt: "2026-11-09T10:00:00.000Z",
      deadlineAt: "2026-11-11T16:59:59.999Z",
    });
    await seedDeadlineSession({
      wiseSessionId: "ineligible",
      scheduledEndAt: "2026-11-02T10:00:00.000Z",
      deadlineAt: "2026-11-04T16:59:59.999Z",
      eligible: false,
    });
    await seedDeadlineSession({
      wiseSessionId: "wise-deleted",
      scheduledEndAt: "2026-11-02T10:00:00.000Z",
      deadlineAt: "2026-11-04T16:59:59.999Z",
      wiseDeletedAt: "2026-11-06T00:00:00.000Z",
    });
    await seedDeadlineSession({
      wiseSessionId: "deletion-event",
      scheduledEndAt: "2026-11-02T10:00:00.000Z",
      deadlineAt: "2026-11-04T16:59:59.999Z",
    });
    await seedDeletionEvent("deletion-event", "2026-11-05T03:00:00.000Z");
    await seedDeadlineSession({
      wiseSessionId: "before-bound",
      scheduledEndAt: "2026-09-20T10:00:00.000Z",
      deadlineAt: "2026-09-22T16:59:59.999Z",
    });
  }

  it("keeps the fixtures on the intended sides of the charging-scope bound", () => {
    const bound = autoChargeLowerBoundUtc(NOW);
    expect(new Date("2026-09-20T10:00:00.000Z") < bound).toBe(true);
    expect(new Date("2026-11-02T10:00:00.000Z") >= bound).toBe(true);
  });

  it("proposes eligible live in-scope sessions with no chargeable post-deadline assessment, oldest deadline first", async () => {
    await seedLaneFixtures();
    const repository = createDrizzlePostClassFeedbackRepository(appDb());

    const candidates = await repository.listDeadlineCrossedCandidates!(50, NOW);

    expect(candidates.map((candidate) => candidate.sessionId)).toEqual([
      "lane-old",
      "demoted-ready",
      "stale-session-issue",
      "lane-not-ready-assessment",
      "lane-reassess-only",
      "lane-boundary",
      "lane-never",
      "lane-recent",
    ]);
    expect(candidates.every((candidate) => candidate.reason === "deadline_crossed")).toBe(true);
    expect(candidates.map((candidate) => candidate.recheckPriorityAt?.toISOString())).toEqual([
      "2026-11-04T16:59:59.999Z",
      "2026-11-04T16:59:59.999Z",
      "2026-11-04T16:59:59.999Z",
      "2026-11-05T16:59:59.999Z",
      "2026-11-05T16:59:59.999Z",
      "2026-11-06T16:59:59.999Z",
      "2026-11-07T16:59:59.999Z",
      "2026-11-09T16:59:59.999Z",
    ]);
    expect(candidates[0]).toMatchObject({
      classId: "class-1",
      scheduledEndAt: new Date("2026-11-02T10:00:00.000Z"),
    });
  });

  it("honours the limit", async () => {
    await seedLaneFixtures();
    const repository = createDrizzlePostClassFeedbackRepository(appDb());

    const candidates = await repository.listDeadlineCrossedCandidates!(1, NOW);

    expect(candidates.map((candidate) => candidate.sessionId)).toEqual(["lane-old"]);
  });

  it("counts, for the watchdog, only the lane's sessions more than 12 h past deadline", async () => {
    await seedLaneFixtures();

    const coverage = await loadFeedbackDeadlineCoverage(appDb(), NOW);

    // lane-recent's deadline passed only 8 h ago, so it is still within budget.
    // The watchdog applies no fetch-failure cool-down: open-session-issue,
    // which the lane is resting, still counts as owed.
    expect(coverage).toMatchObject({ stale: true, overdueCount: 8, thresholdHours: 12 });
    expect(coverage?.oldestDeadlineAt?.toISOString()).toBe("2026-11-04T16:59:59.999Z");
  });
});
