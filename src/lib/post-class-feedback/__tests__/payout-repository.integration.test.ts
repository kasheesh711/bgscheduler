/**
 * Payout run selection and pass preparation, against real Postgres.
 *
 * The selection query is the one place a mistake writes money that should not
 * move, so it is exercised against a real database rather than a fake.
 *
 * `npm run test:integration` (Docker), or point at a scratch database with
 * TEST_DATABASE_URL.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { and, eq } from "drizzle-orm";
import { startTestDb, stopTestDb, truncateAll } from "@/tests/integration/db-helper";
import {
  acquirePayoutRunLease,
  beginOrResumePayoutWorkbookRoll,
  claimPayoutCsvRetry,
  closePayoutRun,
  createPayoutAdjustment,
  finalizePayoutCsvRetry,
  finalizePayoutWorkbookRoll,
  finalizePayoutRunPass,
  markPayoutLine,
  readPayoutRunPreview,
  recordLateApprovalPayoutExceptionIfClosed,
  recordPayoutWorkbookRollOutcome,
  resolvePayoutException,
  selectPayoutRunCandidates,
  upsertPayoutTutorName,
} from "@/lib/post-class-feedback/payout-repository";
import { payoutRunWindow } from "@/lib/post-class-feedback/payout-window";
import { assertPayoutRunPublishable } from "@/lib/post-class-feedback/payout-plan";
import { PostClassConflictError } from "@/lib/post-class-feedback/errors";
import {
  applyPostClassFinanceAction,
  applyPostClassReviewAction,
} from "@/lib/post-class-feedback/actions";
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
  // These snapshot-independent audit/source stores are intentionally outside
  // the shared truncation helper, but this suite writes deterministic fixtures
  // into them and must remain repeatable against one external scratch DB.
  await handle.db.delete(schema.wiseActivityEvents);
});

function appDb(): Database {
  return handle.db as unknown as Database;
}

const WINDOW = payoutRunWindow("2026-07"); // 2026-06-26 → 2026-07-25

function acknowledgementsFor(
  preview: Awaited<ReturnType<typeof readPayoutRunPreview>>,
) {
  return {
    confirmed: true as const,
    pendingReviewDeductions: preview.coverage.pendingReviewDeductions,
    nonReadySessions: preview.coverage.nonReadySessions,
    reason: "Integration payout publish confirmation.",
  };
}

function expectedVersionFor(
  preview: Awaited<ReturnType<typeof readPayoutRunPreview>>,
): number {
  return preview.run?.version ?? 1;
}

function googleDateSerial(date: string): number {
  return Math.round(Date.parse(`${date}T00:00:00.000Z`) / 86_400_000) + 25_569;
}

async function acquireRun() {
  const preview = await readPayoutRunPreview(appDb(), { window: WINDOW });
  return acquirePayoutRunLease({
    window: WINDOW,
    actorEmail: "finance@example.com",
    previewToken: preview.previewToken,
    expectedVersion: expectedVersionFor(preview),
    acknowledgements: acknowledgementsFor(preview),
  }, appDb());
}

async function releaseRun(
  acquired: Awaited<ReturnType<typeof acquireRun>>,
  forcePartial = true,
) {
  return finalizePayoutRunPass(appDb(), {
    runId: acquired.run.id,
    leaseToken: acquired.leaseToken,
    actorEmail: "finance@example.com",
    csvFileId: "csv-test",
    csvUrl: "https://example.test/csv",
    csvError: null,
    forcePartial,
  });
}

async function schemaCountLines(): Promise<number> {
  return (await handle.db.select({ id: schema.postClassPayoutRunLines.id })
    .from(schema.postClassPayoutRunLines)).length;
}

async function seedWrittenPayoutDeduction() {
  await upsertPayoutTutorName(appDb(), {
    canonicalKey: "kevin",
    primaryLedgerName: "Kevin (Kev) Y. Hsieh",
    alternateLedgerName: "Kevin (Kev) Y. Hsieh Online",
    active: true,
    updatedByEmail: "admin@example.com",
  });
  const deductionId = await seedDeduction({
    id: "written-adjustment-source",
    endsAt: "2026-07-10T03:00:00.000Z",
    tutorKey: "kevin",
    status: "approved",
  });
  const acquired = await acquireRun();
  const [line] = acquired.lines;
  await markPayoutLine(appDb(), {
    runId: acquired.run.id,
    lineId: line.id,
    leaseToken: acquired.leaseToken,
    patch: {
      matchStatus: "matched",
      writeStatus: "written",
      insertedRowNumber: 42,
      writtenAt: new Date(),
    },
  });
  const run = await releaseRun(acquired, false);
  return { deductionId, run, line };
}

type DeductionStatus = "pending_review" | "approved" | "waived" | "processed";

async function seedFinancePeriod(month: string): Promise<string> {
  const [row] = await handle.db.insert(schema.postClassFinancePeriods).values({
    month,
    status: "open",
    openedByEmail: "admin@example.com",
  }).returning({ id: schema.postClassFinancePeriods.id });
  return row.id;
}

async function seedActionableAssessment(deductionId: string): Promise<void> {
  const [deduction] = await handle.db.select({
    sessionId: schema.postClassDeductions.sessionId,
  }).from(schema.postClassDeductions)
    .where(eq(schema.postClassDeductions.id, deductionId));
  await handle.db.insert(schema.postClassAssessments).values({
    sessionId: deduction.sessionId,
    assessmentKey: `${deduction.sessionId}:actionable`,
    policyVersion: 1,
    mappingVersion: 1,
    sourceStatus: "ready",
    contentStatus: "missing",
    timingStatus: "late",
    deductionStatus: "approved",
    enforcementMode: "live",
    objectiveViolation: true,
    rawOnTime: false,
    adjustedCompliant: false,
    sourceReady: true,
    details: { policyApplies: true },
  });
}

async function seedDeduction(input: {
  id: string;
  endsAt: string;
  tutorKey: string | null;
  status: DeductionStatus;
  student?: string;
  reversedIntoPeriodId?: string;
  /**
   * Decision attribution. Defaults to a human reviewer for any decided status
   * (mirroring `applyPostClassReviewAction`, which always stamps the actor);
   * pass `null` to simulate a legacy row with no recorded decision, or a
   * `system:*` actor to simulate an auto-approval (INC-260829).
   */
  decisionByEmail?: string | null;
}): Promise<string> {
  const at = new Date(input.endsAt);
  const [session] = await handle.db.insert(schema.postClassSessions).values({
    wiseSessionId: input.id,
    wiseClassId: "class-1",
    className: "Math",
    canonicalTutorKey: input.tutorKey,
    canonicalTutorName: input.tutorKey ? `${input.tutorKey} Tutor` : null,
    scheduledStartAt: at,
    scheduledEndAt: at,
    deadlineAt: at,
    finalStatus: "ENDED",
    eligible: true,
    sourceStatus: "ready",
  }).returning({ id: schema.postClassSessions.id });

  await handle.db.insert(schema.postClassSessionParticipants).values({
    sessionId: session.id,
    participantKey: `${input.id}:1`,
    studentName: input.student ?? "Grace Hopper",
  });

  const [deduction] = await handle.db.insert(schema.postClassDeductions).values({
    sessionId: session.id,
    status: input.status,
    amountMinor: 10_000,
    defaultFinanceMonth: `${input.endsAt.slice(0, 7)}-01`,
    decisionByEmail: input.decisionByEmail !== undefined
      ? input.decisionByEmail
      : (input.status === "pending_review" ? null : "reviewer@example.com"),
    decisionAt: input.status === "pending_review" ? null : at,
  }).returning({ id: schema.postClassDeductions.id });

  if (input.reversedIntoPeriodId) {
    await handle.db.insert(schema.postClassDeductionOffsets).values({
      deductionId: deduction.id,
      financePeriodId: input.reversedIntoPeriodId,
      reason: "Reversed after review",
      reference: "ref-1",
      actorEmail: "finance@example.com",
      idempotencyKey: `reverse:${deduction.id}`,
    });
  }
  return deduction.id;
}

describe("selectPayoutRunCandidates", () => {
  it("takes only approved, in-window, unreversed deductions", async () => {
    await seedDeduction({ id: "approved", endsAt: "2026-07-10T03:00:00.000Z", tutorKey: "kevin", status: "approved" });
    await seedDeduction({ id: "pending", endsAt: "2026-07-11T03:00:00.000Z", tutorKey: "kevin", status: "pending_review" });
    await seedDeduction({ id: "waived", endsAt: "2026-07-12T03:00:00.000Z", tutorKey: "kevin", status: "waived" });
    await seedDeduction({ id: "processed", endsAt: "2026-07-13T03:00:00.000Z", tutorKey: "kevin", status: "processed" });

    const candidates = await selectPayoutRunCandidates(appDb(), WINDOW);
    expect(candidates.map((row) => row.wiseSessionId)).toEqual(["approved"]);
  });

  it("excludes approved deductions without a human decision actor (INC-260829)", async () => {
    await seedDeduction({ id: "human", endsAt: "2026-07-10T03:00:00.000Z", tutorKey: "kevin", status: "approved" });
    await seedDeduction({
      id: "system-approved",
      endsAt: "2026-07-11T03:00:00.000Z",
      tutorKey: "kevin",
      status: "approved",
      decisionByEmail: "system:post-class-auto-approve",
    });
    await seedDeduction({
      id: "no-decision-actor",
      endsAt: "2026-07-12T03:00:00.000Z",
      tutorKey: "kevin",
      status: "approved",
      decisionByEmail: null,
    });

    const candidates = await selectPayoutRunCandidates(appDb(), WINDOW);
    expect(candidates.map((row) => row.wiseSessionId)).toEqual(["human"]);
  });

  it("excludes a deduction with a durable reversal offset", async () => {
    // The offset remains a second, defense-in-depth exclusion even though the
    // finance action now also persists the deduction's reversed status.
    const periodId = await seedFinancePeriod("2026-07-01");
    await seedDeduction({
      id: "reversed",
      endsAt: "2026-07-10T03:00:00.000Z",
      tutorKey: "kevin",
      status: "approved",
      reversedIntoPeriodId: periodId,
    });

    expect(await selectPayoutRunCandidates(appDb(), WINDOW)).toHaveLength(0);
  });

  it("respects both ends of the 26th-to-25th window", async () => {
    // 2026-06-25 17:00Z is 26 June 00:00 Bangkok — the first instant in.
    await seedDeduction({ id: "first-in", endsAt: "2026-06-25T17:00:00.000Z", tutorKey: "kevin", status: "approved" });
    // 2026-06-25 16:59Z is 23:59 on 25 June Bangkok — the last instant out.
    await seedDeduction({ id: "just-before", endsAt: "2026-06-25T16:59:00.000Z", tutorKey: "kevin", status: "approved" });
    // 2026-07-25 16:59Z is 23:59 on 25 July Bangkok — the last instant in.
    await seedDeduction({ id: "last-in", endsAt: "2026-07-25T16:59:00.000Z", tutorKey: "kevin", status: "approved" });
    // 2026-07-25 17:00Z is 26 July 00:00 Bangkok — the first instant out.
    await seedDeduction({ id: "just-after", endsAt: "2026-07-25T17:00:00.000Z", tutorKey: "kevin", status: "approved" });

    const candidates = await selectPayoutRunCandidates(appDb(), WINDOW);
    expect(candidates.map((row) => row.wiseSessionId).toSorted())
      .toEqual(["first-in", "last-in"]);
  });

  it("carries the students and the derived reason onto each candidate", async () => {
    const deductionId = await seedDeduction({
      id: "with-detail",
      endsAt: "2026-07-10T03:00:00.000Z",
      tutorKey: "kevin",
      status: "approved",
      student: "Ada Lovelace",
    });
    const [deduction] = await handle.db.select()
      .from(schema.postClassDeductions)
      .where(eq(schema.postClassDeductions.id, deductionId));
    await handle.db.insert(schema.postClassAssessments).values({
      sessionId: deduction.sessionId,
      assessmentKey: `${deduction.sessionId}:v1`,
      policyVersion: 1,
      mappingVersion: 1,
      sourceStatus: "ready",
      contentStatus: "missing",
      timingStatus: "late",
      enforcementMode: "live",
      fieldFailures: ["topics", "homework"],
    });

    const [candidate] = await selectPayoutRunCandidates(appDb(), WINDOW);
    expect(candidate.studentNames).toEqual(["Ada Lovelace"]);
    expect(candidate.reason).toBe("topics, homework");
  });

  it("falls back to a stated reason when nothing was assessed", async () => {
    await seedDeduction({ id: "no-assessment", endsAt: "2026-07-10T03:00:00.000Z", tutorKey: "kevin", status: "approved" });
    const [candidate] = await selectPayoutRunCandidates(appDb(), WINDOW);
    expect(candidate.reason).toBe("Feedback was incomplete at the deadline");
  });

  it("counts any non-auto human submission regardless of actor role (D-EVT-04)", async () => {
    // Wise stamps the account's role, not authorship: a tutor holding an admin
    // account submits as ADMIN. Only auto-submissions are excluded.
    const deductionId = await seedDeduction({
      id: "admin-submission",
      endsAt: "2026-07-10T03:00:00.000Z",
      tutorKey: "kevin",
      status: "approved",
    });
    const [deduction] = await handle.db.select()
      .from(schema.postClassDeductions)
      .where(eq(schema.postClassDeductions.id, deductionId));
    const events = await handle.db.insert(schema.wiseActivityEvents).values([
      {
        eventId: "auto-role-less-event",
        eventName: "SessionFeedbackSubmittedEvent",
        eventTimestamp: new Date("2026-07-10T00:30:00.000Z"),
        actorRole: null,
      },
      {
        eventId: "admin-feedback-event",
        eventName: "SessionFeedbackSubmittedEvent",
        eventTimestamp: new Date("2026-07-10T01:00:00.000Z"),
        actorRole: "ADMIN",
      },
      {
        eventId: "teacher-feedback-event",
        eventName: "SessionFeedbackSubmittedEvent",
        eventTimestamp: new Date("2026-07-10T02:00:00.000Z"),
        actorRole: " Teacher ",
      },
    ]).returning({
      id: schema.wiseActivityEvents.id,
      eventId: schema.wiseActivityEvents.eventId,
      eventTimestamp: schema.wiseActivityEvents.eventTimestamp,
    });
    await handle.db.insert(schema.postClassFeedbackEventLinks).values(
      events.map((event, index) => ({
        sessionId: deduction.sessionId,
        wiseActivityEventId: event.id,
        wiseEventId: event.eventId,
        eventTimestamp: event.eventTimestamp,
        // The earliest event is the Wise auto-submission; the human ones carry
        // NULL / false, mirroring production rows.
        autoSubmitted: index === 0 ? true : index === 1 ? null : false,
      })),
    );

    const [candidate] = await selectPayoutRunCandidates(appDb(), WINDOW);
    expect(candidate.tutorSubmittedAt?.toISOString())
      .toBe("2026-07-10T01:00:00.000Z");
  });

  it("derives the submission time from a teacher link whose autoSubmitted is unrecorded", async () => {
    // Production teacher links carry NULL autoSubmitted; only Wise auto
    // submissions are stamped true. NULL must count as a tutor submission.
    const deductionId = await seedDeduction({
      id: "null-auto-submission",
      endsAt: "2026-07-10T03:00:00.000Z",
      tutorKey: "kevin",
      status: "approved",
    });
    const [deduction] = await handle.db.select()
      .from(schema.postClassDeductions)
      .where(eq(schema.postClassDeductions.id, deductionId));
    const events = await handle.db.insert(schema.wiseActivityEvents).values([
      {
        eventId: "auto-feedback-event",
        eventName: "SessionFeedbackSubmittedEvent",
        eventTimestamp: new Date("2026-07-10T01:00:00.000Z"),
        actorRole: "TEACHER",
      },
      {
        eventId: "manual-feedback-event",
        eventName: "SessionFeedbackSubmittedEvent",
        eventTimestamp: new Date("2026-07-10T02:00:00.000Z"),
        actorRole: "TEACHER",
      },
    ]).returning({
      id: schema.wiseActivityEvents.id,
      eventId: schema.wiseActivityEvents.eventId,
      eventTimestamp: schema.wiseActivityEvents.eventTimestamp,
    });
    await handle.db.insert(schema.postClassFeedbackEventLinks).values([
      {
        sessionId: deduction.sessionId,
        wiseActivityEventId: events[0].id,
        wiseEventId: events[0].eventId,
        eventTimestamp: events[0].eventTimestamp,
        autoSubmitted: true,
      },
      {
        sessionId: deduction.sessionId,
        wiseActivityEventId: events[1].id,
        wiseEventId: events[1].eventId,
        eventTimestamp: events[1].eventTimestamp,
        autoSubmitted: null,
      },
    ]);

    const [candidate] = await selectPayoutRunCandidates(appDb(), WINDOW);
    expect(candidate.tutorSubmittedAt?.toISOString())
      .toBe("2026-07-10T02:00:00.000Z");
  });
});

describe("acquirePayoutRunLease", () => {
  it("rejects payout acquisition while a source sync is running", async () => {
    await seedDeduction({
      id: "blocked-by-sync",
      endsAt: "2026-07-10T03:00:00.000Z",
      tutorKey: "kevin",
      status: "approved",
    });
    const preview = await readPayoutRunPreview(appDb(), { window: WINDOW });
    await handle.db.insert(schema.postClassSyncRuns).values({
      status: "running",
      windowStart: WINDOW.windowStart,
      windowEnd: WINDOW.windowEnd,
    });

    await expect(acquirePayoutRunLease({
      window: WINDOW,
      actorEmail: "finance@example.com",
      previewToken: preview.previewToken,
      expectedVersion: expectedVersionFor(preview),
      acknowledgements: acknowledgementsFor(preview),
    }, appDb())).rejects.toThrow(/source sync is active/iu);
    expect(await handle.db.select().from(schema.postClassPayoutRuns))
      .toHaveLength(0);
  });

  it("creates the run and one line per approved deduction", async () => {
    await seedDeduction({ id: "a", endsAt: "2026-07-10T03:00:00.000Z", tutorKey: "kevin", status: "approved" });
    await seedDeduction({ id: "b", endsAt: "2026-07-11T03:00:00.000Z", tutorKey: "mimi", status: "approved" });

    const result = await acquireRun();

    expect(result.run.anchorMonth).toBe("2026-07-01");
    expect(result.run.status).toBe("publishing");
    expect(result.run.leaseToken).toBe(result.leaseToken);
    expect(result.lines).toHaveLength(2);
    expect(result.lines.every((line) => line.writeStatus === "pending")).toBe(true);
  });

  it("rejects acknowledgement counts which do not exactly match the preview", async () => {
    await seedDeduction({
      id: "stale-acknowledgement",
      endsAt: "2026-07-10T03:00:00.000Z",
      tutorKey: "kevin",
      status: "approved",
    });
    const preview = await readPayoutRunPreview(appDb(), { window: WINDOW });

    await expect(acquirePayoutRunLease({
      window: WINDOW,
      actorEmail: "finance@example.com",
      previewToken: preview.previewToken,
      expectedVersion: expectedVersionFor(preview),
      acknowledgements: {
        confirmed: true,
        pendingReviewDeductions: preview.coverage.pendingReviewDeductions + 1,
        nonReadySessions: preview.coverage.nonReadySessions,
        reason: "This deliberately carries a stale displayed count.",
      },
    }, appDb())).rejects.toThrow(/counts do not match this preview/iu);
    expect(await handle.db.select().from(schema.postClassPayoutRuns))
      .toHaveLength(0);
  });

  it("increments the run version when the leased pass finalizes", async () => {
    await seedDeduction({ id: "versioned-finalizer", endsAt: "2026-07-10T03:00:00.000Z", tutorKey: "kevin", status: "approved" });
    const acquired = await acquireRun();

    const finalized = await releaseRun(acquired);

    expect(finalized.status).toBe("partial");
    expect(finalized.version).toBe(acquired.run.version + 1);
  });

  it("finalizes partial when the source obligation set changes during external writes", async () => {
    await seedDeduction({
      id: "source-before-publish",
      endsAt: "2026-07-10T03:00:00.000Z",
      tutorKey: "kevin",
      status: "approved",
    });
    const acquired = await acquireRun();
    const [line] = acquired.lines;
    await markPayoutLine(appDb(), {
      runId: acquired.run.id,
      lineId: line.id,
      leaseToken: acquired.leaseToken,
      patch: {
        matchStatus: "matched",
        writeStatus: "written",
        insertedRowNumber: 42,
        writtenAt: new Date(),
      },
    });

    // Simulate a sync commit while the request is outside Postgres writing to
    // Sheets. The irreversible first row remains written, but the run must not
    // claim that the now-larger obligation set is fully published.
    await seedDeduction({
      id: "source-arrived-during-publish",
      endsAt: "2026-07-11T03:00:00.000Z",
      tutorKey: "kevin",
      status: "approved",
    });
    const finalized = await releaseRun(acquired, false);

    expect(finalized.status).toBe("partial");
    expect(finalized.publishedAt).toBeNull();
  });

  it("finalizes partial when a written row's immutable source payload changes", async () => {
    await seedDeduction({
      id: "written-payload-drift-during-publish",
      endsAt: "2026-07-10T03:00:00.000Z",
      tutorKey: "kevin",
      status: "approved",
    });
    const acquired = await acquireRun();
    const [line] = acquired.lines;
    await markPayoutLine(appDb(), {
      runId: acquired.run.id,
      lineId: line.id,
      leaseToken: acquired.leaseToken,
      patch: {
        matchStatus: "matched",
        writeStatus: "written",
        insertedRowNumber: 42,
        writtenAt: new Date(),
      },
    });
    await handle.db.update(schema.postClassSessions).set({
      className: "Changed while the publish request was writing",
    }).where(eq(schema.postClassSessions.id, line.sessionId));

    const finalized = await releaseRun(acquired, false);

    expect(finalized.status).toBe("partial");
    expect(finalized.publishedAt).toBeNull();
  });

  it("does not treat a newly derivable submission time as drift on a written line that stored none", async () => {
    // Legacy rows were written while the submission subquery dropped
    // NULL-autoSubmitted links, so they stored no timestamp. Deriving one now
    // must not brick the publish path.
    const { line } = await seedWrittenPayoutDeduction();
    const [written] = await handle.db.select({
      tutorSubmittedAt: schema.postClassPayoutRunLines.tutorSubmittedAt,
    }).from(schema.postClassPayoutRunLines)
      .where(eq(schema.postClassPayoutRunLines.id, line.id));
    expect(written.tutorSubmittedAt).toBeNull();
    const [event] = await handle.db.insert(schema.wiseActivityEvents).values({
      eventId: "late-discovered-submission",
      eventName: "SessionFeedbackSubmittedEvent",
      eventTimestamp: new Date("2026-07-10T05:00:00.000Z"),
      actorRole: "TEACHER",
    }).returning({
      id: schema.wiseActivityEvents.id,
      eventId: schema.wiseActivityEvents.eventId,
      eventTimestamp: schema.wiseActivityEvents.eventTimestamp,
    });
    await handle.db.insert(schema.postClassFeedbackEventLinks).values({
      sessionId: line.sessionId,
      wiseActivityEventId: event.id,
      wiseEventId: event.eventId,
      eventTimestamp: event.eventTimestamp,
      autoSubmitted: null,
    });

    const acquired = await acquireRun();
    const finalized = await releaseRun(acquired, false);

    expect(finalized.status).toBe("published");
  });

  it("still flags drift when a written line's stored submission time changes", async () => {
    const deductionId = await seedDeduction({
      id: "stored-submission-drift",
      endsAt: "2026-07-10T03:00:00.000Z",
      tutorKey: "kevin",
      status: "approved",
    });
    const [deduction] = await handle.db.select()
      .from(schema.postClassDeductions)
      .where(eq(schema.postClassDeductions.id, deductionId));
    const [event] = await handle.db.insert(schema.wiseActivityEvents).values({
      eventId: "original-submission-event",
      eventName: "SessionFeedbackSubmittedEvent",
      eventTimestamp: new Date("2026-07-10T04:00:00.000Z"),
      actorRole: "TEACHER",
    }).returning({
      id: schema.wiseActivityEvents.id,
      eventId: schema.wiseActivityEvents.eventId,
      eventTimestamp: schema.wiseActivityEvents.eventTimestamp,
    });
    await handle.db.insert(schema.postClassFeedbackEventLinks).values({
      sessionId: deduction.sessionId,
      wiseActivityEventId: event.id,
      wiseEventId: event.eventId,
      eventTimestamp: event.eventTimestamp,
      autoSubmitted: null,
    });
    const acquired = await acquireRun();
    const [line] = acquired.lines;
    expect(line.tutorSubmittedAt?.toISOString()).toBe("2026-07-10T04:00:00.000Z");
    await markPayoutLine(appDb(), {
      runId: acquired.run.id,
      lineId: line.id,
      leaseToken: acquired.leaseToken,
      patch: {
        matchStatus: "matched",
        writeStatus: "written",
        insertedRowNumber: 42,
        writtenAt: new Date(),
      },
    });
    await releaseRun(acquired, false);
    await handle.db.update(schema.postClassFeedbackEventLinks).set({
      eventTimestamp: new Date("2026-07-11T04:00:00.000Z"),
    }).where(eq(schema.postClassFeedbackEventLinks.wiseActivityEventId, event.id));

    await expect(acquireRun()).rejects.toBeInstanceOf(PostClassConflictError);
  });

  it("rejects a second pass while the first 15-minute lease is active", async () => {
    await seedDeduction({ id: "a", endsAt: "2026-07-10T03:00:00.000Z", tutorKey: "kevin", status: "approved" });

    const first = await acquireRun();
    const preview = await readPayoutRunPreview(appDb(), { window: WINDOW });
    await expect(acquirePayoutRunLease({
      window: WINDOW,
      actorEmail: "other-finance@example.com",
      previewToken: preview.previewToken,
      expectedVersion: expectedVersionFor(preview),
      acknowledgements: acknowledgementsFor(preview),
    }, appDb())).rejects.toBeInstanceOf(PostClassConflictError);
    expect((await schemaCountLines())).toBe(1);
    expect(first.run.status).toBe("publishing");
  });

  it("audits an expired publishing lease before reclaiming it with the same preview token", async () => {
    await seedDeduction({ id: "expired-lease", endsAt: "2026-07-10T03:00:00.000Z", tutorKey: "kevin", status: "approved" });
    const base = new Date();
    const firstPreview = await readPayoutRunPreview(appDb(), { window: WINDOW });
    const first = await acquirePayoutRunLease({
      window: WINDOW,
      actorEmail: "first-finance@example.com",
      previewToken: firstPreview.previewToken,
      expectedVersion: expectedVersionFor(firstPreview),
      acknowledgements: acknowledgementsFor(firstPreview),
      now: base,
    }, appDb());
    const expiredPreview = await readPayoutRunPreview(appDb(), { window: WINDOW });

    const reclaimed = await acquirePayoutRunLease({
      window: WINDOW,
      actorEmail: "recovery-finance@example.com",
      previewToken: expiredPreview.previewToken,
      expectedVersion: first.run.version,
      acknowledgements: acknowledgementsFor(expiredPreview),
      now: new Date(base.getTime() + 16 * 60 * 1_000),
    }, appDb());

    expect(reclaimed.run.status).toBe("publishing");
    expect(reclaimed.run.version).toBe(first.run.version + 2);
    expect(reclaimed.leaseToken).not.toBe(first.leaseToken);
    const [audit] = await handle.db.select()
      .from(schema.postClassConfigAuditLog)
      .where(and(
        eq(schema.postClassConfigAuditLog.action, "expire_publish_lease"),
        eq(schema.postClassConfigAuditLog.entityKey, first.run.id),
      ));
    expect(audit.actorEmail).toBe("recovery-finance@example.com");
    expect(audit.beforeValue).toMatchObject({
      status: "publishing",
      version: first.run.version,
      leaseToken: first.leaseToken,
    });
    expect(audit.afterValue).toMatchObject({
      status: "partial",
      version: first.run.version + 1,
      leaseToken: null,
    });

    await releaseRun(reclaimed);
  });

  it("adds a line for a deduction approved after the run was first prepared", async () => {
    // The run is a durable container, not a one-shot event: a late approval
    // must still have somewhere to land.
    await seedDeduction({ id: "a", endsAt: "2026-07-10T03:00:00.000Z", tutorKey: "kevin", status: "approved" });
    const first = await acquireRun();
    await releaseRun(first);

    await seedDeduction({ id: "late", endsAt: "2026-07-12T03:00:00.000Z", tutorKey: "kevin", status: "approved" });
    const second = await acquireRun();

    expect(second.lines.map((line) => line.wiseSessionId).toSorted()).toEqual(["a", "late"]);
  });

  it("audits reparenting an unwritten line when its session moves to the next window", async () => {
    const deductionId = await seedDeduction({
      id: "move-unwritten-window",
      endsAt: "2026-07-10T03:00:00.000Z",
      tutorKey: "kevin",
      status: "approved",
    });
    const first = await acquireRun();
    const [oldLine] = first.lines;
    const oldRun = await releaseRun(first);
    const [deduction] = await handle.db.select()
      .from(schema.postClassDeductions)
      .where(eq(schema.postClassDeductions.id, deductionId));
    await handle.db.update(schema.postClassSessions).set({
      scheduledStartAt: new Date("2026-07-26T03:00:00.000Z"),
      scheduledEndAt: new Date("2026-07-26T04:00:00.000Z"),
      deadlineAt: new Date("2026-07-26T07:00:00.000Z"),
    }).where(eq(schema.postClassSessions.id, deduction.sessionId));

    const nextWindow = payoutRunWindow("2026-08");
    const preview = await readPayoutRunPreview(appDb(), { window: nextWindow });
    const acquired = await acquirePayoutRunLease({
      window: nextWindow,
      actorEmail: "finance@example.com",
      previewToken: preview.previewToken,
      expectedVersion: expectedVersionFor(preview),
      acknowledgements: acknowledgementsFor(preview),
    }, appDb());
    const [reparented] = acquired.lines;

    expect(reparented.id).toBe(oldLine.id);
    expect(reparented.runId).toBe(acquired.run.id);
    expect(reparented.rowSignature).toMatch(/^BGS-PAYOUT 2026-08 /u);
    expect(reparented.idempotencyKey).toContain(acquired.run.id);
    const [persistedOldRun] = await handle.db.select()
      .from(schema.postClassPayoutRuns)
      .where(eq(schema.postClassPayoutRuns.id, oldRun.id));
    expect(persistedOldRun.status).toBe("partial");
    expect(persistedOldRun.version).toBe(oldRun.version + 1);
    const [audit] = await handle.db.select()
      .from(schema.postClassConfigAuditLog)
      .where(and(
        eq(schema.postClassConfigAuditLog.action, "reparent_payout_run_line"),
        eq(schema.postClassConfigAuditLog.entityKey, oldLine.id),
      ));
    expect(audit.beforeValue).toMatchObject({
      runId: oldRun.id,
      anchorMonth: "2026-07-01",
      rowSignature: oldLine.rowSignature,
    });
    expect(audit.afterValue).toMatchObject({
      runId: acquired.run.id,
      anchorMonth: "2026-08-01",
      rowSignature: reparented.rowSignature,
    });
    await releaseRun(acquired);
  });

  it("never reparents a written line across payout windows", async () => {
    const { deductionId, run } = await seedWrittenPayoutDeduction();
    const [deduction] = await handle.db.select()
      .from(schema.postClassDeductions)
      .where(eq(schema.postClassDeductions.id, deductionId));
    await handle.db.update(schema.postClassSessions).set({
      scheduledStartAt: new Date("2026-07-26T03:00:00.000Z"),
      scheduledEndAt: new Date("2026-07-26T04:00:00.000Z"),
      deadlineAt: new Date("2026-07-26T07:00:00.000Z"),
    }).where(eq(schema.postClassSessions.id, deduction.sessionId));
    const nextWindow = payoutRunWindow("2026-08");
    const preview = await readPayoutRunPreview(appDb(), { window: nextWindow });

    await expect(acquirePayoutRunLease({
      window: nextWindow,
      actorEmail: "finance@example.com",
      previewToken: preview.previewToken,
      expectedVersion: expectedVersionFor(preview),
      acknowledgements: acknowledgementsFor(preview),
    }, appDb())).rejects.toThrow(/positive compensation or post-close external exception/iu);
    const [persisted] = await handle.db.select()
      .from(schema.postClassPayoutRunLines)
      .where(eq(schema.postClassPayoutRunLines.deductionId, deductionId));
    expect(persisted.runId).toBe(run.id);
    expect(persisted.writeStatus).toBe("written");
  });

  it("never reparents an unwritten line out of a closed payout run", async () => {
    const deductionId = await seedDeduction({
      id: "move-closed-window",
      endsAt: "2026-07-10T03:00:00.000Z",
      tutorKey: "kevin",
      status: "approved",
    });
    const first = await acquireRun();
    const [oldLine] = first.lines;
    const oldRun = await releaseRun(first);
    await handle.db.update(schema.postClassPayoutRuns).set({
      status: "closed",
    }).where(eq(schema.postClassPayoutRuns.id, oldRun.id));
    const [deduction] = await handle.db.select()
      .from(schema.postClassDeductions)
      .where(eq(schema.postClassDeductions.id, deductionId));
    await handle.db.update(schema.postClassSessions).set({
      scheduledStartAt: new Date("2026-07-26T03:00:00.000Z"),
      scheduledEndAt: new Date("2026-07-26T04:00:00.000Z"),
      deadlineAt: new Date("2026-07-26T07:00:00.000Z"),
    }).where(eq(schema.postClassSessions.id, deduction.sessionId));
    const nextWindow = payoutRunWindow("2026-08");
    const preview = await readPayoutRunPreview(appDb(), { window: nextWindow });

    await expect(acquirePayoutRunLease({
      window: nextWindow,
      actorEmail: "finance@example.com",
      previewToken: preview.previewToken,
      expectedVersion: expectedVersionFor(preview),
      acknowledgements: acknowledgementsFor(preview),
    }, appDb())).rejects.toThrow(/positive compensation or post-close external exception/iu);
    const [persisted] = await handle.db.select()
      .from(schema.postClassPayoutRunLines)
      .where(eq(schema.postClassPayoutRunLines.id, oldLine.id));
    expect(persisted.runId).toBe(oldRun.id);
  });

  it("never re-touches a line that was already written", async () => {
    await upsertPayoutTutorName(appDb(), {
      canonicalKey: "kevin",
      primaryLedgerName: "Kevin (Kev) Y. Hsieh",
      alternateLedgerName: "Kevin (Kev) Y. Hsieh Online",
      active: true,
      updatedByEmail: "admin@example.com",
    });
    const deductionId = await seedDeduction({ id: "a", endsAt: "2026-07-10T03:00:00.000Z", tutorKey: "kevin", status: "approved" });
    const first = await acquireRun();
    await handle.db.update(schema.postClassPayoutRunLines).set({
      matchStatus: "matched",
      writeStatus: "written",
      insertedRowNumber: 12,
      writtenAt: new Date(),
    }).where(eq(schema.postClassPayoutRunLines.runId, first.run.id));

    await releaseRun(first, false);
    const second = await acquireRun();

    const line = second.lines.find((row) => row.deductionId === deductionId)!;
    expect(line.writeStatus).toBe("written");
    expect(line.insertedRowNumber).toBe(12);
  });

  it("reinstates a ledger-removed waived deduction into a generation-2 line (INC-260829)", async () => {
    await upsertPayoutTutorName(appDb(), {
      canonicalKey: "kevin",
      primaryLedgerName: "Kevin (Kev) Y. Hsieh",
      alternateLedgerName: null,
      active: true,
      updatedByEmail: "admin@example.com",
    });
    const deductionId = await seedDeduction({ id: "a", endsAt: "2026-07-10T03:00:00.000Z", tutorKey: "kevin", status: "approved" });
    const first = await acquireRun();
    await handle.db.update(schema.postClassPayoutRunLines).set({
      matchStatus: "matched",
      writeStatus: "written",
      insertedRowNumber: 12,
      writtenAt: new Date(),
    }).where(eq(schema.postClassPayoutRunLines.runId, first.run.id));
    await releaseRun(first, false);

    const actor = { email: "reviewer@example.com", name: "Reviewer" };
    const [beforeWaive] = await handle.db.select({ version: schema.postClassDeductions.version })
      .from(schema.postClassDeductions).where(eq(schema.postClassDeductions.id, deductionId));
    await applyPostClassReviewAction(actor, {
      deductionId,
      action: "waive",
      waiverCategory: "other",
      note: "Handled by hand on the ledger.",
      expectedVersion: beforeWaive.version,
      idempotencyKey: "t-reinstate-waive",
    }, appDb());

    // Refused while the written row is still live on the ledger.
    const [afterWaive] = await handle.db.select({ version: schema.postClassDeductions.version })
      .from(schema.postClassDeductions).where(eq(schema.postClassDeductions.id, deductionId));
    await expect(applyPostClassReviewAction(actor, {
      deductionId,
      action: "reinstate",
      note: "Re-charge attempt.",
      expectedVersion: afterWaive.version,
      idempotencyKey: "t-reinstate-refused",
    }, appDb())).rejects.toThrow(/still on the payout ledger/iu);

    // Simulate the ledger removal: retire the written line, supersede the
    // waiver correction that never reached the sheet.
    await handle.db.update(schema.postClassPayoutRunLines).set({
      retiredAt: new Date(),
      retiredReason: "Removed from the ledger (netted pair, INC-260829)",
    }).where(eq(schema.postClassPayoutRunLines.runId, first.run.id));
    await handle.db.update(schema.postClassPayoutAdjustments).set({ status: "superseded" })
      .where(eq(schema.postClassPayoutAdjustments.deductionId, deductionId));

    await applyPostClassReviewAction(actor, {
      deductionId,
      action: "reinstate",
      note: "Re-charge: content below the bar; waiver was incident cleanup only.",
      expectedVersion: afterWaive.version,
      idempotencyKey: "t-reinstate",
    }, appDb());
    const [reinstated] = await handle.db.select()
      .from(schema.postClassDeductions).where(eq(schema.postClassDeductions.id, deductionId));
    expect(reinstated.status).toBe("pending_review");
    expect(reinstated.waiverCategory).toBeNull();
    expect(reinstated.decisionByEmail).toBeNull();

    // Human approval (seeded directly; the review path is covered elsewhere).
    await handle.db.update(schema.postClassDeductions).set({
      status: "approved",
      decisionByEmail: "reviewer@example.com",
      decisionAt: new Date(),
      version: reinstated.version + 1,
    }).where(eq(schema.postClassDeductions.id, deductionId));

    const candidates = await selectPayoutRunCandidates(appDb(), WINDOW);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].generation).toBe(2);

    const second = await acquireRun();
    const gen1 = second.lines.find((line) => line.sourceIdentity === `deduction:${deductionId}`)!;
    const gen2 = second.lines.find((line) => line.sourceIdentity === `deduction:${deductionId}:g2`)!;
    expect(gen1.writeStatus).toBe("written");
    expect(gen1.retiredAt).not.toBeNull();
    expect(gen1.insertedRowNumber).toBe(12);
    expect(gen2.writeStatus).toBe("pending");
    expect(gen2.rowSignature).not.toBe(gen1.rowSignature);
    expect(gen2.rowSignature).toMatch(/^BGS-PAYOUT 2026-07 [0-9a-f]{12}$/u);
  });

  it("keeps a written line whose deduction was system-approved, without retiring it (INC-260829)", async () => {
    // Simulates the incident's historical rows: the line reached the sheet
    // while auto-approval could still plan lines. The human-decision filter
    // must drop the deduction from new planning, but the written line stays a
    // retained obligation — never retired, never re-touched.
    await upsertPayoutTutorName(appDb(), {
      canonicalKey: "kevin",
      primaryLedgerName: "Kevin (Kev) Y. Hsieh",
      alternateLedgerName: null,
      active: true,
      updatedByEmail: "admin@example.com",
    });
    const deductionId = await seedDeduction({ id: "a", endsAt: "2026-07-10T03:00:00.000Z", tutorKey: "kevin", status: "approved" });
    const first = await acquireRun();
    await handle.db.update(schema.postClassPayoutRunLines).set({
      matchStatus: "matched",
      writeStatus: "written",
      insertedRowNumber: 12,
      writtenAt: new Date(),
    }).where(eq(schema.postClassPayoutRunLines.runId, first.run.id));
    await releaseRun(first, false);

    await handle.db.update(schema.postClassDeductions)
      .set({ decisionByEmail: "system:post-class-auto-approve" })
      .where(eq(schema.postClassDeductions.id, deductionId));

    const preview = await readPayoutRunPreview(appDb(), { window: WINDOW });
    expect(preview.candidates).toHaveLength(0);

    const second = await acquireRun();
    const line = second.lines.find((row) => row.deductionId === deductionId)!;
    expect(line.writeStatus).toBe("written");
    expect(line.insertedRowNumber).toBe(12);
    expect(line.retiredAt).toBeNull();
  });

  it("retires a line whose deduction stopped being approved between passes", async () => {
    const deductionId = await seedDeduction({ id: "a", endsAt: "2026-07-10T03:00:00.000Z", tutorKey: "kevin", status: "approved" });
    const first = await acquireRun();
    await releaseRun(first);

    await handle.db.update(schema.postClassDeductions)
      .set({ status: "waived" })
      .where(eq(schema.postClassDeductions.id, deductionId));
    const second = await acquireRun();

    expect(second.lines[0].writeStatus).toBe("skipped");
    expect(second.lines[0].writeError).toContain("no longer approved");
  });

  it("refreshes every mutable matching field before retrying a non-written line", async () => {
    const deductionId = await seedDeduction({
      id: "stale-retry",
      endsAt: "2026-07-10T03:00:00.000Z",
      tutorKey: "kevin",
      status: "approved",
      student: "Old Student",
    });
    const first = await acquireRun();
    const [firstLine] = first.lines;
    await markPayoutLine(appDb(), {
      runId: first.run.id,
      lineId: firstLine.id,
      leaseToken: first.leaseToken,
      patch: {
        matchStatus: "unmatched",
        writeStatus: "skipped",
        spreadsheetId: "old-sheet",
        sheetName: "Old tab",
        matchedRowNumber: 91,
        insertedRowNumber: 92,
        writeError: "Old source did not match.",
      },
    });
    await releaseRun(first);
    await handle.db.update(schema.postClassPayoutRunLines).set({
      amountMinor: -12_500,
    }).where(eq(schema.postClassPayoutRunLines.id, firstLine.id));

    const [deduction] = await handle.db.select()
      .from(schema.postClassDeductions)
      .where(eq(schema.postClassDeductions.id, deductionId));
    await handle.db.update(schema.postClassSessions).set({
      wiseSessionId: "stale-retry-corrected",
      canonicalTutorKey: "corrected-tutor",
      canonicalTutorName: "Corrected Tutor",
      className: "Corrected Mathematics",
      scheduledStartAt: new Date("2026-07-10T04:00:00.000Z"),
      scheduledEndAt: new Date("2026-07-10T05:00:00.000Z"),
      deadlineAt: new Date("2026-07-10T08:00:00.000Z"),
    }).where(eq(schema.postClassSessions.id, deduction.sessionId));
    await handle.db.update(schema.postClassSessionParticipants).set({
      studentName: "Corrected Student",
    }).where(eq(schema.postClassSessionParticipants.sessionId, deduction.sessionId));
    await handle.db.update(schema.postClassDeductions).set({
      defaultFinanceMonth: "2026-08-01",
    }).where(eq(schema.postClassDeductions.id, deductionId));
    await handle.db.insert(schema.postClassAssessments).values({
      sessionId: deduction.sessionId,
      assessmentKey: `${deduction.sessionId}:corrected`,
      policyVersion: 1,
      mappingVersion: 1,
      sourceStatus: "ready",
      contentStatus: "missing",
      timingStatus: "late",
      enforcementMode: "live",
      fieldFailures: ["corrected topic"],
    });

    const second = await acquireRun();
    const [refreshed] = second.lines;
    expect(refreshed.id).toBe(firstLine.id);
    expect(refreshed.wiseSessionId).toBe("stale-retry-corrected");
    expect(refreshed.canonicalTutorKey).toBe("corrected-tutor");
    expect(refreshed.tutorName).toBe("Corrected Tutor");
    expect(refreshed.className).toBe("Corrected Mathematics");
    expect(refreshed.studentNames).toEqual(["Corrected Student"]);
    expect(refreshed.scheduledStartAt.toISOString()).toBe("2026-07-10T04:00:00.000Z");
    expect(refreshed.scheduledEndAt.toISOString()).toBe("2026-07-10T05:00:00.000Z");
    expect(refreshed.deadlineAt.toISOString()).toBe("2026-07-10T08:00:00.000Z");
    expect(refreshed.amountMinor).toBe(-10_000);
    expect(refreshed.financeMonth).toBe("2026-08-01");
    expect(refreshed.reason).toBe("corrected topic");
    expect(refreshed.matchStatus).toBe("pending");
    expect(refreshed.writeStatus).toBe("pending");
    expect(refreshed.spreadsheetId).toBeNull();
    expect(refreshed.sheetName).toBeNull();
    expect(refreshed.matchedRowNumber).toBeNull();
    expect(refreshed.insertedRowNumber).toBeNull();
    expect(refreshed.passToken).toBe(second.leaseToken);

    await releaseRun(second);
  });

  it("rejects a stale expectedVersion", async () => {
    await seedDeduction({ id: "a", endsAt: "2026-07-10T03:00:00.000Z", tutorKey: "kevin", status: "approved" });
    const preview = await readPayoutRunPreview(appDb(), { window: WINDOW });
    const first = await acquirePayoutRunLease({
      window: WINDOW,
      actorEmail: "finance@example.com",
      previewToken: preview.previewToken,
      expectedVersion: expectedVersionFor(preview),
      acknowledgements: acknowledgementsFor(preview),
    }, appDb());
    await releaseRun(first);
    await expect(acquirePayoutRunLease({
      window: WINDOW,
      actorEmail: "finance@example.com",
      previewToken: preview.previewToken,
      expectedVersion: expectedVersionFor(preview),
      acknowledgements: acknowledgementsFor(preview),
    }, appDb())).rejects.toBeInstanceOf(PostClassConflictError);
  });

  it("rejects stale line outcomes without mutating the pending line", async () => {
    await seedDeduction({ id: "a", endsAt: "2026-07-10T03:00:00.000Z", tutorKey: "kevin", status: "approved" });
    const acquired = await acquireRun();
    const [line] = acquired.lines;

    await expect(markPayoutLine(appDb(), {
      runId: acquired.run.id,
      lineId: line.id,
      leaseToken: "00000000-0000-4000-8000-000000000000",
      patch: {
        matchStatus: "matched",
        writeStatus: "written",
        insertedRowNumber: 12,
        writtenAt: new Date(),
      },
    })).rejects.toBeInstanceOf(PostClassConflictError);

    const [persisted] = await handle.db.select()
      .from(schema.postClassPayoutRunLines)
      .where(eq(schema.postClassPayoutRunLines.id, line.id));
    expect(persisted.writeStatus).toBe("pending");
    expect(persisted.insertedRowNumber).toBeNull();

    await releaseRun(acquired);
  });

  it("reports coverage, including which tutors have no mapped sheet", async () => {
    await seedDeduction({ id: "a", endsAt: "2026-07-10T03:00:00.000Z", tutorKey: "kevin", status: "approved" });
    await seedDeduction({ id: "b", endsAt: "2026-07-11T03:00:00.000Z", tutorKey: "mimi", status: "approved" });
    await seedDeduction({ id: "c", endsAt: "2026-07-12T03:00:00.000Z", tutorKey: null, status: "approved" });
    await seedDeduction({ id: "d", endsAt: "2026-07-13T03:00:00.000Z", tutorKey: "kevin", status: "pending_review" });
    await upsertPayoutTutorName(appDb(), {
      canonicalKey: "kevin",
      primaryLedgerName: "Kevin (Kev) Y. Hsieh",
      alternateLedgerName: "Kevin (Kev) Y. Hsieh Online",
      active: true,
      updatedByEmail: "admin@example.com",
    });

    const { coverage } = await readPayoutRunPreview(appDb(), { window: WINDOW });

    expect(coverage.approvedDeductions).toBe(3);
    expect(coverage.pendingReviewDeductions).toBe(1);
    expect(coverage.unmappedTutorKeys).toEqual(["mimi"]);
    expect(coverage.nullTutorKeyLines).toBe(1);
    expect(coverage.eligibleSessions).toBe(4);
    expect(coverage.readySessions).toBe(4);
    expect(coverage.blockingGlobalSourceIssues).toBe(0);
  });

  it("counts eligibility-unproven source rows in the non-ready payout gate", async () => {
    const at = new Date("2026-07-15T03:00:00.000Z");
    await handle.db.insert(schema.postClassSessions).values({
      wiseSessionId: "billing-evidence-unknown",
      wiseClassId: "class-unknown",
      scheduledStartAt: at,
      scheduledEndAt: at,
      deadlineAt: at,
      finalStatus: "ENDED",
      eligible: false,
      sourceStatus: "unavailable",
    });

    const preview = await readPayoutRunPreview(appDb(), { window: WINDOW });
    expect(preview.coverage).toMatchObject({
      eligibleSessions: 1,
      readySessions: 0,
      nonReadySessions: 1,
      unavailableSessions: 1,
    });
    expect(() => assertPayoutRunPublishable(preview.coverage))
      .toThrow(/no trustworthy Wise evidence/iu);
  });

  it("blocks a stale approved deduction whose source proof became unavailable", async () => {
    const deductionId = await seedDeduction({
      id: "approved-proof-lost",
      endsAt: "2026-07-15T03:00:00.000Z",
      tutorKey: "kevin",
      status: "approved",
    });
    const [deduction] = await handle.db.select()
      .from(schema.postClassDeductions)
      .where(eq(schema.postClassDeductions.id, deductionId));
    await handle.db.update(schema.postClassSessions).set({
      eligible: false,
      sourceStatus: "unavailable",
    }).where(eq(schema.postClassSessions.id, deduction.sessionId));

    expect(await selectPayoutRunCandidates(appDb(), WINDOW)).toHaveLength(0);
    const preview = await readPayoutRunPreview(appDb(), { window: WINDOW });
    expect(preview.coverage.unprovenApprovedDeductions).toBe(1);
    expect(() => assertPayoutRunPublishable(preview.coverage))
      .toThrow(/approved deduction no longer has proven eligible/iu);
    await expect(acquirePayoutRunLease({
      window: WINDOW,
      actorEmail: "finance@example.com",
      previewToken: preview.previewToken,
      expectedVersion: expectedVersionFor(preview),
      acknowledgements: acknowledgementsFor(preview),
    }, appDb())).rejects.toThrow(/approved deduction no longer has proven eligible/iu);
  });

  it("counts an open blocking global source issue", async () => {
    await seedDeduction({ id: "a", endsAt: "2026-07-10T03:00:00.000Z", tutorKey: "kevin", status: "approved" });
    const [run] = await handle.db.insert(schema.postClassSyncRuns).values({
      status: "running", windowStart: "2026-07-01", windowEnd: "2026-07-04",
    }).returning({ id: schema.postClassSyncRuns.id });
    await handle.db.insert(schema.postClassSourceIssues).values({
      syncRunId: run.id,
      scope: "global",
      issueType: "contract_error",
      severity: "error",
      status: "open",
      blocksEnforcement: true,
      fingerprint: "contract_error:global:widespread",
      message: "Contract breach",
    });

    const { coverage } = await readPayoutRunPreview(appDb(), { window: WINDOW });
    expect(coverage.blockingGlobalSourceIssues).toBe(1);
  });
});

describe("payout tutor ledger identity mapping", () => {
  it("rejects a primary name already claimed as another tutor's alternate", async () => {
    await upsertPayoutTutorName(appDb(), {
      canonicalKey: "ledger-a",
      primaryLedgerName: "Ledger Tutor A",
      alternateLedgerName: "Ledger Tutor A Alternate",
      active: true,
      updatedByEmail: "admin@example.com",
    });
    await expect(upsertPayoutTutorName(appDb(), {
      canonicalKey: "ledger-b",
      primaryLedgerName: "Ledger Tutor A Alternate",
      alternateLedgerName: null,
      active: true,
      updatedByEmail: "admin@example.com",
    })).rejects.toBeInstanceOf(PostClassConflictError);
  });
});

describe("durable payout compensation and post-close exceptions", () => {
  it("blocks a waiver while the deduction window has an active publish lease", async () => {
    const deductionId = await seedDeduction({
      id: "waive-during-publish",
      endsAt: "2026-07-10T03:00:00.000Z",
      tutorKey: "kevin",
      status: "approved",
    });
    const acquired = await acquireRun();

    await expect(applyPostClassReviewAction(
      { email: "reviewer@example.com" },
      {
        deductionId,
        action: "waive",
        note: "Tutor emergency approved during publication",
        waiverCategory: "tutor_emergency",
        expectedVersion: 1,
        idempotencyKey: "waive-during-publish-action",
      },
      appDb(),
    )).rejects.toThrow(/payout publish.*active/iu);

    const [unchanged] = await handle.db.select()
      .from(schema.postClassDeductions)
      .where(eq(schema.postClassDeductions.id, deductionId));
    expect(unchanged.status).toBe("approved");
    expect(await schemaCountLines()).toBe(1);

    await releaseRun(acquired);
  });

  it("blocks a waiver after an uncertain append until Publish reconciles its marker", async () => {
    const deductionId = await seedDeduction({
      id: "waive-after-lost-response",
      endsAt: "2026-07-10T03:00:00.000Z",
      tutorKey: "kevin",
      status: "approved",
    });
    const acquired = await acquireRun();
    const [line] = acquired.lines;
    await markPayoutLine(appDb(), {
      runId: acquired.run.id,
      lineId: line.id,
      leaseToken: acquired.leaseToken,
      patch: {
        matchStatus: "matched",
        writeStatus: "failed",
        writeError: "Google append response was lost",
      },
    });
    await releaseRun(acquired);

    await expect(applyPostClassReviewAction(
      { email: "reviewer@example.com" },
      {
        deductionId,
        action: "waive",
        note: "Tutor emergency approved after an ambiguous append",
        waiverCategory: "tutor_emergency",
        expectedVersion: 1,
        idempotencyKey: "waive-after-lost-response-action",
      },
      appDb(),
    )).rejects.toThrow(/uncertain payout append/iu);

    const [unchanged] = await handle.db.select()
      .from(schema.postClassDeductions)
      .where(eq(schema.postClassDeductions.id, deductionId));
    expect(unchanged.status).toBe("approved");
  });

  it("rejects Process through the real transaction path before publication", async () => {
    const deductionId = await seedDeduction({
      id: "process-before-publish",
      endsAt: "2026-07-10T03:00:00.000Z",
      tutorKey: "kevin",
      status: "approved",
    });
    await seedFinancePeriod("2026-07-01");

    await expect(applyPostClassFinanceAction(
      { email: "finance@example.com" },
      {
        deductionId,
        action: "process",
        processingMonth: "2026-07",
        referenceNote: "PAYROLL-7",
        expectedVersion: 1,
        idempotencyKey: "process-before-publish-action",
      },
      appDb(),
    )).rejects.toThrow(/publish and verify/iu);
  });

  it("creates the waiver correction in the same review transaction", async () => {
    const { deductionId } = await seedWrittenPayoutDeduction();
    await applyPostClassReviewAction(
      { email: "reviewer@example.com" },
      {
        deductionId,
        action: "waive",
        note: "Tutor emergency approved after publication",
        waiverCategory: "tutor_emergency",
        expectedVersion: 1,
        idempotencyKey: "waive-written-action",
      },
      appDb(),
    );
    const [adjustment] = await handle.db.select()
      .from(schema.postClassPayoutAdjustments)
      .where(eq(schema.postClassPayoutAdjustments.deductionId, deductionId));
    expect(adjustment.kind).toBe("waiver");
    expect(adjustment.status).toBe("pending");
    expect(adjustment.amountMinor).toBe(10_000);
  });

  it("creates the reversal offset and payout correction atomically", async () => {
    const { deductionId } = await seedWrittenPayoutDeduction();
    const periodId = await seedFinancePeriod("2026-07-01");
    await handle.db.update(schema.postClassDeductions).set({
      status: "processed",
      financePeriodId: periodId,
      processingReference: "PAYROLL-7",
    }).where(eq(schema.postClassDeductions.id, deductionId));

    await applyPostClassFinanceAction(
      { email: "finance@example.com" },
      {
        deductionId,
        action: "reverse",
        processingMonth: "2026-07",
        referenceNote: "PAYROLL-7-REV",
        reason: "Approved reversal",
        expectedVersion: 1,
        idempotencyKey: "reverse-written-action",
      },
      appDb(),
    );
    const [offset] = await handle.db.select()
      .from(schema.postClassDeductionOffsets)
      .where(eq(schema.postClassDeductionOffsets.deductionId, deductionId));
    const [adjustment] = await handle.db.select()
      .from(schema.postClassPayoutAdjustments)
      .where(eq(schema.postClassPayoutAdjustments.deductionId, deductionId));
    expect(offset.amountMinor).toBe(-10_000);
    const [reversedDeduction] = await handle.db.select()
      .from(schema.postClassDeductions)
      .where(eq(schema.postClassDeductions.id, deductionId));
    expect(reversedDeduction.status).toBe("reversed");
    expect(reversedDeduction.version).toBe(2);
    expect(adjustment.kind).toBe("reversal");
    expect(adjustment.amountMinor).toBe(10_000);
    expect(adjustment.status).toBe("pending");
  });

  it("creates a positive pending correction after a written deduction", async () => {
    const { deductionId, run } = await seedWrittenPayoutDeduction();

    const adjustment = await createPayoutAdjustment(appDb(), {
      deductionId,
      kind: "waiver",
      reason: "Approved waiver after ledger publication",
      actorEmail: "reviewer@example.com",
      actionIdentity: "waiver-action-1",
    });

    expect(adjustment.runId).toBe(run.id);
    expect(adjustment.status).toBe("pending");
    expect(adjustment.amountMinor).toBe(10_000);
    expect(adjustment.rowSignature).toMatch(/^BGS-PAYOUT-CORRECTION 2026-07 /u);
    const [updatedRun] = await handle.db.select()
      .from(schema.postClassPayoutRuns)
      .where(eq(schema.postClassPayoutRuns.id, run.id));
    expect(updatedRun.status).toBe("partial");
    expect(updatedRun.version).toBe(run.version + 1);
  });

  it("records a closed-run correction as an exception and never carries it forward", async () => {
    const { deductionId, run } = await seedWrittenPayoutDeduction();
    await handle.db.update(schema.postClassPayoutRuns)
      .set({ status: "closed" })
      .where(eq(schema.postClassPayoutRuns.id, run.id));

    const adjustment = await createPayoutAdjustment(appDb(), {
      deductionId,
      kind: "reversal",
      reason: "Reversed after close",
      actorEmail: "finance@example.com",
      actionIdentity: "reversal-action-1",
    });
    expect(adjustment.status).toBe("exception");
    const [exception] = await handle.db.select()
      .from(schema.postClassPayoutExceptions)
      .where(eq(schema.postClassPayoutExceptions.adjustmentId, adjustment.id));
    expect(exception.kind).toBe("post_close_adjustment");
    expect(exception.status).toBe("open");

    await expect(resolvePayoutException(appDb(), {
      exceptionId: exception.id,
      actorEmail: "finance@example.com",
      expectedVersion: exception.version,
      resolutionNote: "Corrected outside the app",
    })).rejects.toThrow(/external correction reference/u);
    await resolvePayoutException(appDb(), {
      exceptionId: exception.id,
      actorEmail: "finance@example.com",
      expectedVersion: exception.version,
      resolutionNote: "Corrected outside the app",
      resolutionReference: "PAYROLL-2026-07-REV-4",
    });
    const [persistedAdjustment] = await handle.db.select()
      .from(schema.postClassPayoutAdjustments)
      .where(eq(schema.postClassPayoutAdjustments.id, adjustment.id));
    expect(persistedAdjustment.status).toBe("exception");
  });

  it("refuses to resolve an exception until its run is closed", async () => {
    const { deductionId, run } = await seedWrittenPayoutDeduction();
    const [exception] = await handle.db.insert(schema.postClassPayoutExceptions).values({
      runId: run.id,
      deductionId,
      kind: "manual_review",
      sourceIdentity: `manual-review:${deductionId}`,
      idempotencyKey: `manual-review:${deductionId}`,
      reason: "External investigation is still open.",
    }).returning();

    await expect(resolvePayoutException(appDb(), {
      exceptionId: exception.id,
      actorEmail: "finance@example.com",
      expectedVersion: exception.version,
      resolutionNote: "Corrected outside the app.",
      resolutionReference: "PAYROLL-2026-07-EXT-1",
    })).rejects.toThrow(/only after the run is closed/iu);
  });

  it("creates one explicit exception for a late approval in a closed window", async () => {
    const { deductionId, run } = await seedWrittenPayoutDeduction();
    await handle.db.update(schema.postClassPayoutRuns)
      .set({ status: "closed" })
      .where(eq(schema.postClassPayoutRuns.id, run.id));

    const first = await recordLateApprovalPayoutExceptionIfClosed(appDb(), {
      deductionId,
      reason: "Approval arrived after close",
    });
    const second = await recordLateApprovalPayoutExceptionIfClosed(appDb(), {
      deductionId,
      reason: "Approval arrived after close",
    });
    expect(first?.id).toBe(second?.id);
    const exceptions = await handle.db.select()
      .from(schema.postClassPayoutExceptions)
      .where(eq(schema.postClassPayoutExceptions.deductionId, deductionId));
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0].kind).toBe("post_close_late_approval");
  });

  it("demotes a published run when a late approval creates a new obligation", async () => {
    const { run } = await seedWrittenPayoutDeduction();
    const deductionId = await seedDeduction({
      id: "approved-after-publish",
      endsAt: "2026-07-12T03:00:00.000Z",
      tutorKey: "kevin",
      status: "approved",
    });

    expect(await recordLateApprovalPayoutExceptionIfClosed(appDb(), {
      deductionId,
      reason: "Approved after the first payout pass.",
    })).toBeNull();

    const [reopened] = await handle.db.select()
      .from(schema.postClassPayoutRuns)
      .where(eq(schema.postClassPayoutRuns.id, run.id));
    expect(reopened.status).toBe("partial");
    expect(reopened.version).toBe(run.version + 1);
  });
});

describe("strict payout close source fencing", () => {
  it("closes after a published deduction is processed without treating lifecycle as source drift", async () => {
    const { deductionId, run } = await seedWrittenPayoutDeduction();
    await seedFinancePeriod("2026-07-01");
    await seedActionableAssessment(deductionId);

    await applyPostClassFinanceAction(
      { email: "finance@example.com" },
      {
        deductionId,
        action: "process",
        processingMonth: "2026-07",
        referenceNote: "PAYROLL-2026-07-KEVIN",
        expectedVersion: 1,
        idempotencyKey: "process-published-before-strict-close",
      },
      appDb(),
    );

    const closed = await closePayoutRun(appDb(), {
      anchorMonth: "2026-07",
      actorEmail: "finance@example.com",
      expectedVersion: run.version,
      closeReason: "Published row verified and monthly payroll processed.",
    });

    expect(closed.status).toBe("closed");
    const [processed] = await handle.db.select()
      .from(schema.postClassDeductions)
      .where(eq(schema.postClassDeductions.id, deductionId));
    expect(processed.status).toBe("processed");
  });

  it("rejects a new publish pass when a written row's immutable source payload changed", async () => {
    const { run, line } = await seedWrittenPayoutDeduction();
    await handle.db.update(schema.postClassSessions).set({
      className: "Changed after payout publication",
    }).where(eq(schema.postClassSessions.id, line.sessionId));
    const preview = await readPayoutRunPreview(appDb(), { window: WINDOW });

    await expect(acquirePayoutRunLease({
      window: WINDOW,
      actorEmail: "finance@example.com",
      previewToken: preview.previewToken,
      expectedVersion: run.version,
      acknowledgements: acknowledgementsFor(preview),
    }, appDb())).rejects.toThrow(/immutable source payload/iu);
  });

  it("rejects close when a row-affecting source field changed after publication", async () => {
    const { run, line } = await seedWrittenPayoutDeduction();
    await handle.db.update(schema.postClassSessions).set({
      className: "Changed after payout publication",
    }).where(eq(schema.postClassSessions.id, line.sessionId));

    await expect(closePayoutRun(appDb(), {
      anchorMonth: "2026-07",
      actorEmail: "finance@example.com",
      expectedVersion: run.version,
      closeReason: "Monthly payout reviewed and finalized.",
    })).rejects.toThrow(/source changed after publication/iu);
  });

  it("rejects close while a source sync remains running", async () => {
    const { run } = await seedWrittenPayoutDeduction();
    await handle.db.insert(schema.postClassSyncRuns).values({
      status: "running",
      windowStart: WINDOW.windowStart,
      windowEnd: WINDOW.windowEnd,
    });

    await expect(closePayoutRun(appDb(), {
      anchorMonth: "2026-07",
      actorEmail: "finance@example.com",
      expectedVersion: run.version,
      closeReason: "Monthly payout reviewed and finalized.",
    })).rejects.toThrow(/source sync is active/iu);
  });
});

describe("payout CSV retry fencing", () => {
  it("does not replace an already-uploaded payout CSV", async () => {
    const { run } = await seedWrittenPayoutDeduction();

    await expect(claimPayoutCsvRetry(appDb(), {
      anchorMonth: "2026-07",
      actorEmail: "finance@example.com",
      expectedVersion: run.version,
    })).rejects.toThrow(/only a failed payout CSV may be retried/iu);
  });

  it("audits and reclaims an expired pending CSV retry", async () => {
    const { run } = await seedWrittenPayoutDeduction();
    await handle.db.update(schema.postClassPayoutRuns).set({
      csvStatus: "failed",
      csvFileId: null,
      csvUrl: null,
      csvError: "Initial upload failed.",
    }).where(eq(schema.postClassPayoutRuns.id, run.id));
    const base = new Date("2099-01-01T00:00:00.000Z");
    const abandoned = await claimPayoutCsvRetry(appDb(), {
      anchorMonth: "2026-07",
      actorEmail: "first-finance@example.com",
      expectedVersion: run.version,
      now: base,
    });

    const reclaimed = await claimPayoutCsvRetry(appDb(), {
      anchorMonth: "2026-07",
      actorEmail: "recovery-finance@example.com",
      expectedVersion: abandoned.run.version,
      now: new Date(base.getTime() + 16 * 60 * 1_000),
    });

    expect(reclaimed.leaseToken).not.toBe(abandoned.leaseToken);
    expect(reclaimed.run.version).toBe(abandoned.run.version + 1);
    const [audit] = await handle.db.select()
      .from(schema.postClassConfigAuditLog)
      .where(and(
        eq(schema.postClassConfigAuditLog.action, "expire_csv_retry_lease"),
        eq(schema.postClassConfigAuditLog.entityKey, run.id),
      ));
    expect(audit.actorEmail).toBe("recovery-finance@example.com");
    expect(audit.beforeValue).toMatchObject({
      csvStatus: "pending",
      leaseToken: abandoned.leaseToken,
      version: abandoned.run.version,
    });
    expect(audit.afterValue).toMatchObject({
      csvStatus: "pending",
      leaseToken: reclaimed.leaseToken,
      version: reclaimed.run.version,
    });
  });

  it("rejects a stale finalizer after the claimed run version changes", async () => {
    const { run } = await seedWrittenPayoutDeduction();
    await handle.db.update(schema.postClassPayoutRuns).set({
      csvStatus: "failed",
      csvFileId: null,
      csvUrl: null,
      csvError: "Initial upload failed.",
    }).where(eq(schema.postClassPayoutRuns.id, run.id));
    const claimed = await claimPayoutCsvRetry(appDb(), {
      anchorMonth: "2026-07",
      actorEmail: "finance@example.com",
      expectedVersion: run.version,
      now: new Date("2099-01-01T00:00:00.000Z"),
    });
    await handle.db.update(schema.postClassPayoutRuns).set({
      version: claimed.run.version + 1,
      updatedAt: new Date(),
    }).where(eq(schema.postClassPayoutRuns.id, claimed.run.id));

    await expect(finalizePayoutCsvRetry(appDb(), {
      runId: claimed.run.id,
      leaseToken: claimed.leaseToken,
      expectedVersion: claimed.run.version,
      csvFileId: "stale-csv-file",
      csvUrl: "https://example.test/stale-csv-file",
      csvError: null,
    })).rejects.toBeInstanceOf(PostClassConflictError);

    const [persisted] = await handle.db.select()
      .from(schema.postClassPayoutRuns)
      .where(eq(schema.postClassPayoutRuns.id, claimed.run.id));
    expect(persisted.csvFileId).toBeNull();
    expect(persisted.leaseToken).toBe(claimed.leaseToken);
    expect(persisted.version).toBe(claimed.run.version + 1);
  });
});

describe("audited payout workbook date rolls", () => {
  async function seedClosedRun() {
    const [run] = await handle.db.insert(schema.postClassPayoutRuns).values({
      anchorMonth: "2026-07-01",
      windowStart: "2026-06-26",
      windowEnd: "2026-07-25",
      status: "closed",
      csvStatus: "uploaded",
      csvFileId: "closed-run.csv",
      csvUrl: "https://example.test/closed-run.csv",
      closedByEmail: "finance@example.com",
      closedAt: new Date("2026-07-26T00:00:00.000Z"),
      closeReason: "Monthly payout finalized.",
    }).returning();
    return run;
  }

  async function beginRoll(
    runId: string,
    targetAnchorMonth = "2026-08",
    now = new Date("2099-01-01T00:00:00.000Z"),
  ) {
    return beginOrResumePayoutWorkbookRoll(appDb(), {
      anchorMonth: "2026-07",
      closedRunId: runId,
      targetAnchorMonth,
      manifestHash: "fleet-hash-v1",
      actorEmail: "finance@example.com",
      workbooks: [{
        spreadsheetId: "tutor-sheet-1",
        workbookName: "Tutor One",
        canonicalTutorKey: "tutor-one",
      }],
      now,
    });
  }

  it("allows a closed run to roll only to its exact next anchor", async () => {
    const run = await seedClosedRun();

    await expect(beginRoll(run.id, "2026-09"))
      .rejects.toThrow(/may roll only to 2026-08/iu);
    expect(await handle.db.select().from(schema.postClassPayoutRollRuns))
      .toHaveLength(0);
  });

  it("rejects incomplete success evidence and completes only after exact serial proof", async () => {
    const run = await seedClosedRun();
    const lease = await beginRoll(run.id);
    const [pending] = lease.outcomes;

    await expect(recordPayoutWorkbookRollOutcome(appDb(), {
      rollRunId: lease.rollRun.id,
      leaseToken: lease.leaseToken,
      spreadsheetId: pending.workbookId,
      expectedVersion: pending.version,
      status: "verified",
      beforeStartSerial: null,
      beforeEndSerial: null,
      afterStartSerial: null,
      afterEndSerial: null,
      previousWindowStart: null,
      previousWindowEnd: null,
      appliedWindowStart: null,
      appliedWindowEnd: null,
    })).rejects.toThrow(/exact before\/after serials/iu);

    const recorded = await recordPayoutWorkbookRollOutcome(appDb(), {
      rollRunId: lease.rollRun.id,
      leaseToken: lease.leaseToken,
      spreadsheetId: pending.workbookId,
      expectedVersion: pending.version,
      status: "verified",
      beforeStartSerial: googleDateSerial("2026-06-26"),
      beforeEndSerial: googleDateSerial("2026-07-25"),
      afterStartSerial: googleDateSerial("2026-07-26"),
      afterEndSerial: googleDateSerial("2026-08-25"),
      previousWindowStart: "2026-06-26",
      previousWindowEnd: "2026-07-25",
      appliedWindowStart: "2026-07-26",
      appliedWindowEnd: "2026-08-25",
    });
    expect(recorded.status).toBe("verified");
    const [recordAudit] = await handle.db.select()
      .from(schema.postClassConfigAuditLog)
      .where(and(
        eq(schema.postClassConfigAuditLog.action, "record_payout_workbook_roll_outcome"),
        eq(schema.postClassConfigAuditLog.entityKey, recorded.id),
      ));
    expect(recordAudit.actorEmail).toBe("finance@example.com");
    expect(recordAudit.beforeValue).toMatchObject({
      rollRunId: lease.rollRun.id,
      manifestHash: "fleet-hash-v1",
      workbookId: pending.workbookId,
      status: "pending",
      version: pending.version,
      attemptedAt: null,
    });
    expect(recordAudit.afterValue).toMatchObject({
      rollRunId: lease.rollRun.id,
      manifestHash: "fleet-hash-v1",
      workbookId: pending.workbookId,
      status: "verified",
      version: recorded.version,
      beforeStartSerial: googleDateSerial("2026-06-26"),
      afterStartSerial: googleDateSerial("2026-07-26"),
    });

    const finalized = await finalizePayoutWorkbookRoll(appDb(), {
      rollRunId: lease.rollRun.id,
      leaseToken: lease.leaseToken,
      actorEmail: "finance@example.com",
    });
    expect(finalized.rollRun.status).toBe("completed");
    expect(finalized.rollRun.succeededWorkbooks).toBe(1);
    const [persistedRun] = await handle.db.select()
      .from(schema.postClassPayoutRuns)
      .where(eq(schema.postClassPayoutRuns.id, run.id));
    expect(persistedRun.dateRollStatus).toBe("completed");
    expect(persistedRun.rolledToAnchorMonth).toBe("2026-08-01");
  });

  it("preserves failed workbook evidence when an expired roll is resumed", async () => {
    const run = await seedClosedRun();
    const base = new Date("2099-01-01T00:00:00.000Z");
    const lease = await beginRoll(run.id, "2026-08", base);
    const [pending] = lease.outcomes;
    const attemptedAt = new Date("2026-07-29T06:00:00.000Z");
    const failed = await recordPayoutWorkbookRollOutcome(appDb(), {
      rollRunId: lease.rollRun.id,
      leaseToken: lease.leaseToken,
      spreadsheetId: pending.workbookId,
      expectedVersion: pending.version,
      status: "failed",
      beforeStartSerial: googleDateSerial("2026-06-26"),
      beforeEndSerial: googleDateSerial("2026-07-25"),
      afterStartSerial: null,
      afterEndSerial: null,
      previousWindowStart: "2026-06-26",
      previousWindowEnd: "2026-07-25",
      appliedWindowStart: null,
      appliedWindowEnd: null,
      error: "Sheets update returned 429.",
      attemptedAt,
    });

    const resumed = await beginRoll(
      run.id,
      "2026-08",
      new Date(base.getTime() + 16 * 60 * 1_000),
    );
    expect(resumed.outcomes[0].status).toBe("pending");
    expect(resumed.outcomes[0].version).toBe(failed.version + 1);
    expect(resumed.outcomes[0].error).toBeNull();

    const [resumeAudit] = await handle.db.select()
      .from(schema.postClassConfigAuditLog)
      .where(and(
        eq(schema.postClassConfigAuditLog.action, "resume_payout_workbook_roll"),
        eq(schema.postClassConfigAuditLog.entityKey, lease.rollRun.id),
      ));
    expect(resumeAudit.actorEmail).toBe("finance@example.com");
    expect(resumeAudit.beforeValue).toMatchObject({
      rollRunId: lease.rollRun.id,
      manifestHash: "fleet-hash-v1",
      status: "running",
      version: lease.rollRun.version,
    });
    expect(resumeAudit.afterValue).toMatchObject({
      rollRunId: lease.rollRun.id,
      manifestHash: "fleet-hash-v1",
      status: "running",
      version: resumed.rollRun.version,
    });

    const [resetAudit] = await handle.db.select()
      .from(schema.postClassConfigAuditLog)
      .where(and(
        eq(schema.postClassConfigAuditLog.action, "reset_payout_workbook_roll_outcome"),
        eq(schema.postClassConfigAuditLog.entityKey, failed.id),
      ));
    expect(resetAudit.beforeValue).toMatchObject({
      rollRunId: lease.rollRun.id,
      manifestHash: "fleet-hash-v1",
      workbookId: pending.workbookId,
      status: "failed",
      version: failed.version,
      error: "Sheets update returned 429.",
      attemptedAt: attemptedAt.toISOString(),
    });
    expect(resetAudit.afterValue).toMatchObject({
      rollRunId: lease.rollRun.id,
      manifestHash: "fleet-hash-v1",
      workbookId: pending.workbookId,
      status: "pending",
      version: failed.version + 1,
      error: null,
      attemptedAt: attemptedAt.toISOString(),
    });
  });
});
