/**
 * REC-01 — the run-wide source demotion must be recoverable.
 *
 * A global source issue demotes every eligible session in one statement. Before
 * this, restoration only ever happened one row per successful Wise detail fetch
 * (50 per cron run against ~11k sessions), so the table could never catch up and
 * any transient Wise error reset the progress. These tests pin the two halves:
 * the demotion is still fail-closed and total, and a healthy sync undoes it in
 * one statement.
 *
 * Runs against real Postgres — `npm run test:integration` (Docker), or point at
 * a scratch database with TEST_DATABASE_URL.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { eq, inArray } from "drizzle-orm";
import { startTestDb, stopTestDb, truncateAll } from "@/tests/integration/db-helper";
import {
  createDrizzlePostClassFeedbackRepository,
  PostClassFeedbackSyncAlreadyRunningError,
  PostClassFeedbackSyncSourceFenceError,
} from "@/lib/post-class-feedback/repository";
import type { Database } from "@/lib/db";
import type { PostClassSessionObservation } from "@/lib/post-class-feedback/types";
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

/**
 * The test database typed as the app's `Database`. Production reads through
 * neon-http and tests run on node-postgres, so the suites cast at the seam —
 * same as `src/lib/sync/__tests__/orchestrator.integration.test.ts:199`.
 */
function appDb(): Database {
  return handle.db as unknown as Database;
}

type SourceStatus = "ready" | "form_drift" | "identity_review" | "unavailable";

const SEED: Array<{ id: string; eligible: boolean; sourceStatus: SourceStatus }> = [
  { id: "s-ready", eligible: true, sourceStatus: "ready" },
  { id: "s-drift", eligible: true, sourceStatus: "form_drift" },
  { id: "s-identity", eligible: true, sourceStatus: "identity_review" },
  { id: "s-unavail", eligible: true, sourceStatus: "unavailable" },
  { id: "s-ineligible", eligible: false, sourceStatus: "ready" },
];

async function seedSessions(db: Database): Promise<void> {
  const at = new Date("2026-07-01T03:00:00.000Z");
  await db.insert(schema.postClassSessions).values(SEED.map((row) => ({
    wiseSessionId: row.id,
    wiseClassId: "class-1",
    scheduledStartAt: at,
    scheduledEndAt: at,
    deadlineAt: at,
    finalStatus: "ENDED",
    eligible: row.eligible,
    sourceStatus: row.sourceStatus,
  })));
}

async function startRun(db: Database): Promise<string> {
  const [run] = await db.insert(schema.postClassSyncRuns).values({
    status: "running",
    windowStart: "2026-07-01",
    windowEnd: "2026-07-04",
  }).returning({ id: schema.postClassSyncRuns.id });
  return run.id;
}

async function statuses(db: Database): Promise<Record<string, [string, string | null]>> {
  const rows = await db.select({
    wiseSessionId: schema.postClassSessions.wiseSessionId,
    sourceStatus: schema.postClassSessions.sourceStatus,
    sourceStatusBefore: schema.postClassSessions.sourceStatusBefore,
  }).from(schema.postClassSessions);
  return Object.fromEntries(rows.map((row) => [
    row.wiseSessionId,
    [row.sourceStatus, row.sourceStatusBefore] as [string, string | null],
  ]));
}

function globalIssue(runId: string, fingerprint: string) {
  return {
    runId,
    scope: "global" as const,
    issueType: "contract_error" as const,
    severity: "error" as const,
    blocksEnforcement: true,
    fingerprint,
    message: "The Wise session-detail response no longer matches the expected contract.",
    observedAt: new Date("2026-07-04T03:00:00.000Z"),
  };
}

async function seedReadyEligible(db: Database, id: string): Promise<void> {
  const at = new Date("2026-07-01T03:00:00.000Z");
  await db.insert(schema.postClassSessions).values({
    wiseSessionId: id,
    wiseClassId: "class-1",
    scheduledStartAt: at,
    scheduledEndAt: at,
    deadlineAt: at,
    finalStatus: "ENDED",
    eligible: true,
    sourceStatus: "ready",
  });
}

/**
 * The minimal observation `syncPostClassFeedback` hands to saveObservation on
 * the run-wide demotion path: an eligible session forced to 'unavailable' with
 * `globalSourceDemotion` set. Versions default to 1/1/1 to match the empty
 * settings snapshot the source-write fence reads.
 */
function globalDemotionObservation(id: string, opts?: {
  sourceStatus?: SourceStatus;
  globalSourceDemotion?: boolean;
}): PostClassSessionObservation {
  const at = new Date("2026-07-04T03:00:00.000Z");
  return {
    settingsVersion: 1,
    policyVersion: 1,
    mappingVersion: 1,
    candidate: {
      sessionId: id,
      classId: "class-1",
      reason: "incomplete_recheck",
      scheduledStartAt: at,
      scheduledEndAt: at,
    },
    session: {
      sessionId: id,
      classId: "class-1",
      className: "Math",
      subject: "Math",
      scheduledStartAt: at,
      scheduledEndAt: at,
      meetingStatus: "ENDED",
      classType: null,
      sessionType: null,
      attendanceStatus: null,
      submissionSessionStatuses: [],
      complimentaryOrTrial: null,
      creditsConsumed: 1,
      participants: [],
      participantsAuthoritative: false,
      questions: [],
      mapping: {
        status: "ready",
        byField: {},
        missingRequiredFields: [],
        ambiguousFields: [],
        unmappedQuestionIds: [],
        reason: null,
      },
      feedbackVersions: [],
    },
    feedbackVersionHistory: [],
    tutor: {
      status: "resolved",
      canonicalKey: "kevin",
      displayName: "Kevin",
      wiseTeacherUserId: "teacher-1",
    },
    eligibility: { status: "eligible", eligible: true, reason: "ended_positive_credits" },
    sourceStatus: opts?.sourceStatus ?? "unavailable",
    globalSourceDemotion: opts?.globalSourceDemotion ?? true,
    assessment: null,
    enforcementMode: "shadow",
    events: [],
    observedAt: at,
  };
}

function completedRun(runId: string, globalSourceHealthy: boolean) {
  return {
    runId,
    finishedAt: new Date("2026-07-04T04:00:00.000Z"),
    status: "success" as const,
    discoveredCount: 0,
    candidateCount: 0,
    detailFetchedCount: 0,
    sessionSavedCount: 0,
    versionInsertedCount: 0,
    assessedCount: 0,
    sourceIssueCount: 0,
    metadata: { globalSourceHealthy },
  };
}

describe("REC-01 run-wide source demotion and restore", () => {
  it("defers a new source sync while a payout operation holds a live lease", async () => {
    const repository = createDrizzlePostClassFeedbackRepository(appDb());
    const startedAt = new Date("2026-07-29T04:00:00.000Z");
    await handle.db.insert(schema.postClassPayoutRuns).values({
      anchorMonth: "2026-07-01",
      windowStart: "2026-06-26",
      windowEnd: "2026-07-25",
      status: "partial",
      leaseToken: "11111111-1111-4111-8111-111111111111",
      leaseExpiresAt: new Date(startedAt.getTime() + 15 * 60_000),
    });

    await expect(repository.beginSync({
      triggerType: "cron",
      actorEmail: null,
      startedAt,
      windowStart: "2026-07-25",
      windowEnd: "2026-07-29",
      detailCap: 50,
    })).rejects.toBeInstanceOf(PostClassFeedbackSyncAlreadyRunningError);

    expect(await handle.db.select().from(schema.postClassSyncRuns)).toHaveLength(0);
  });

  it("rejects source writes from a worker whose stale running row was failed", async () => {
    const repository = createDrizzlePostClassFeedbackRepository(appDb());
    const [run] = await handle.db.insert(schema.postClassSyncRuns).values({
      status: "failed",
      windowStart: "2026-07-01",
      windowEnd: "2026-07-04",
      finishedAt: new Date(),
      errorSummary: "Recovered as stale.",
    }).returning({ id: schema.postClassSyncRuns.id });

    await expect(repository.recordSourceIssue(
      globalIssue(run.id, "contract_error:zombie:parse"),
    )).rejects.toBeInstanceOf(PostClassFeedbackSyncSourceFenceError);

    expect(await handle.db.select().from(schema.postClassSourceIssues)).toHaveLength(0);
  });

  it("demotes every eligible session and remembers what each one carried", async () => {
    const repository = createDrizzlePostClassFeedbackRepository(appDb());
    await seedSessions(appDb());
    const runId = await startRun(appDb());

    await repository.recordSourceIssue(globalIssue(runId, "contract_error:run-1:parse"));

    const after = await statuses(appDb());
    expect(after["s-ready"]).toEqual(["unavailable", "ready"]);
    expect(after["s-drift"]).toEqual(["unavailable", "form_drift"]);
    expect(after["s-identity"]).toEqual(["unavailable", "identity_review"]);
    expect(after["s-unavail"]).toEqual(["unavailable", "unavailable"]);
    // Fail-closed is unchanged: an ineligible row was never in a compliance
    // denominator, so the demotion has no reason to touch it.
    expect(after["s-ineligible"]).toEqual(["ready", null]);
  });

  it("keeps the first demotion's value when a second global issue lands before recovery", async () => {
    const repository = createDrizzlePostClassFeedbackRepository(appDb());
    await seedSessions(appDb());
    const runId = await startRun(appDb());

    await repository.recordSourceIssue(globalIssue(runId, "contract_error:run-1:parse"));
    await repository.recordSourceIssue(globalIssue(runId, "contract_error:run-2:parse"));

    const after = await statuses(appDb());
    // Without the coalesce, the second demotion would overwrite the remembered
    // value with the 'unavailable' it is itself writing, and the original
    // status would be lost for good.
    expect(after["s-ready"]).toEqual(["unavailable", "ready"]);
    expect(after["s-drift"]).toEqual(["unavailable", "form_drift"]);
  });

  it("restores every demoted row in one statement once source health is proven", async () => {
    const repository = createDrizzlePostClassFeedbackRepository(appDb());
    await seedSessions(appDb());
    const runId = await startRun(appDb());
    await repository.recordSourceIssue(globalIssue(runId, "contract_error:run-1:parse"));

    await repository.completeSync(completedRun(runId, true));

    const after = await statuses(appDb());
    expect(after["s-ready"]).toEqual(["ready", null]);
    expect(after["s-drift"]).toEqual(["form_drift", null]);
    expect(after["s-identity"]).toEqual(["identity_review", null]);
    expect(after["s-unavail"]).toEqual(["unavailable", null]);
    expect(after["s-ineligible"]).toEqual(["ready", null]);
  });

  it("leaves the demotion in place while source health is still unproven", async () => {
    const repository = createDrizzlePostClassFeedbackRepository(appDb());
    await seedSessions(appDb());
    const runId = await startRun(appDb());
    await repository.recordSourceIssue(globalIssue(runId, "contract_error:run-1:parse"));

    await repository.completeSync(completedRun(runId, false));

    const after = await statuses(appDb());
    expect(after["s-ready"]).toEqual(["unavailable", "ready"]);
    expect(after["s-drift"]).toEqual(["unavailable", "form_drift"]);
  });

  it("never resurrects a status for a row that was re-observed first-hand", async () => {
    const repository = createDrizzlePostClassFeedbackRepository(appDb());
    await seedSessions(appDb());
    const runId = await startRun(appDb());
    await repository.recordSourceIssue(globalIssue(runId, "contract_error:run-1:parse"));

    // What saveObservation writes for a session it actually looked at: the
    // observed status, and no remembered value to restore from later.
    await handle.db.update(schema.postClassSessions).set({
      sourceStatus: "identity_review",
      sourceStatusBefore: null,
    }).where(eq(schema.postClassSessions.wiseSessionId, "s-ready"));

    await repository.completeSync(completedRun(runId, true));

    const after = await statuses(appDb());
    // The fresh observation wins. Restoring the pre-demotion 'ready' here would
    // reinstate a projection nothing has verified — the exact staleness the
    // fail-closed rule exists to prevent.
    expect(after["s-ready"]).toEqual(["identity_review", null]);
    expect(after["s-drift"]).toEqual(["form_drift", null]);
  });

  it("is idempotent: a second healthy sync changes nothing", async () => {
    const repository = createDrizzlePostClassFeedbackRepository(appDb());
    await seedSessions(appDb());
    const runId = await startRun(appDb());
    await repository.recordSourceIssue(globalIssue(runId, "contract_error:run-1:parse"));

    await repository.completeSync(completedRun(runId, true));
    const afterFirst = await statuses(appDb());
    const secondRunId = await startRun(appDb());
    await repository.completeSync(completedRun(secondRunId, true));

    expect(await statuses(appDb())).toEqual(afterFirst);
  });

  it("does not demote on a session-scoped issue", async () => {
    const repository = createDrizzlePostClassFeedbackRepository(appDb());
    await seedSessions(appDb());
    const runId = await startRun(appDb());

    await repository.recordSourceIssue({
      runId,
      sessionId: "s-drift",
      scope: "session",
      issueType: "identity_ambiguous",
      severity: "warning",
      blocksEnforcement: true,
      fingerprint: "identity_ambiguous:s-drift",
      message: "Tutor identity for Wise session s-drift needs review.",
      observedAt: new Date("2026-07-04T03:00:00.000Z"),
    });

    const after = await statuses(appDb());
    expect(after["s-drift"]).toEqual(["identity_review", null]);
    for (const id of ["s-ready", "s-identity", "s-unavail", "s-ineligible"]) {
      expect(after[id][1], `${id} should carry no remembered status`).toBeNull();
    }
  });

  it("restores rows the recheck lane would never have reached", async () => {
    // The bug this migration exists for: demotion is one statement over the
    // whole table, restoration was 50 rows per run. Seed more eligible sessions
    // than a single run's detail cap and prove they all come back at once.
    const repository = createDrizzlePostClassFeedbackRepository(appDb());
    const at = new Date("2026-07-01T03:00:00.000Z");
    const ids = Array.from({ length: 200 }, (_, index) => `bulk-${index}`);
    await handle.db.insert(schema.postClassSessions).values(ids.map((id) => ({
      wiseSessionId: id,
      wiseClassId: "class-bulk",
      scheduledStartAt: at,
      scheduledEndAt: at,
      deadlineAt: at,
      finalStatus: "ENDED",
      eligible: true,
      sourceStatus: "ready" as const,
    })));
    const runId = await startRun(appDb());

    await repository.recordSourceIssue(globalIssue(runId, "contract_error:run-1:parse"));
    const demoted = await handle.db.select({ id: schema.postClassSessions.id })
      .from(schema.postClassSessions)
      .where(eq(schema.postClassSessions.sourceStatus, "unavailable"));
    expect(demoted).toHaveLength(200);

    await repository.completeSync(completedRun(runId, true));

    const restored = await handle.db.select({
      sourceStatus: schema.postClassSessions.sourceStatus,
      sourceStatusBefore: schema.postClassSessions.sourceStatusBefore,
    }).from(schema.postClassSessions)
      .where(inArray(schema.postClassSessions.wiseSessionId, ids));
    expect(restored).toHaveLength(200);
    expect(restored.every((row) => row.sourceStatus === "ready")).toBe(true);
    expect(restored.every((row) => row.sourceStatusBefore === null)).toBe(true);
  });
});

describe("REC-01 saveObservation run-wide demotion capture", () => {
  it("remembers the prior source_status when the demotion is written through saveObservation", async () => {
    const repository = createDrizzlePostClassFeedbackRepository(appDb());
    await seedReadyEligible(appDb(), "g-1");
    const runId = await startRun(appDb());

    await repository.saveObservation(runId, globalDemotionObservation("g-1"));

    // Without capturing source_status_before here, completeSync's bulk restore
    // (keyed on source_status_before IS NOT NULL) can never heal a row the
    // run-wide demotion reached through saveObservation — the production stall.
    expect(await statuses(appDb())).toMatchObject({ "g-1": ["unavailable", "ready"] });
  });

  it("keeps the first remembered status if a later demotion re-saves the same row", async () => {
    const repository = createDrizzlePostClassFeedbackRepository(appDb());
    await seedReadyEligible(appDb(), "g-1");
    const runId = await startRun(appDb());

    await repository.saveObservation(runId, globalDemotionObservation("g-1"));
    await repository.saveObservation(runId, globalDemotionObservation("g-1"));

    // Keep-first: the second demotion must not overwrite the remembered 'ready'
    // with the 'unavailable' it is itself writing.
    expect(await statuses(appDb())).toMatchObject({ "g-1": ["unavailable", "ready"] });
  });

  it("a healthy sync restores a row the demotion reached through saveObservation", async () => {
    const repository = createDrizzlePostClassFeedbackRepository(appDb());
    await seedReadyEligible(appDb(), "g-1");
    const runId = await startRun(appDb());
    await repository.saveObservation(runId, globalDemotionObservation("g-1"));

    await repository.completeSync(completedRun(runId, true));

    expect(await statuses(appDb())).toMatchObject({ "g-1": ["ready", null] });
  });

  it("a per-session 'unavailable' observation still supersedes, remembering nothing", async () => {
    const repository = createDrizzlePostClassFeedbackRepository(appDb());
    await seedReadyEligible(appDb(), "g-1");
    const runId = await startRun(appDb());

    // Not a run-wide demotion but a real first-hand verdict about this row (e.g.
    // ambiguous billing evidence). REC-01 must NOT remember or later restore it —
    // resurrecting the pre-demotion 'ready' would be the stale projection the
    // fail-closed rule exists to prevent.
    await repository.saveObservation(runId, globalDemotionObservation("g-1", {
      sourceStatus: "unavailable",
      globalSourceDemotion: false,
    }));

    expect(await statuses(appDb())).toMatchObject({ "g-1": ["unavailable", null] });
  });
});
