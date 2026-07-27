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

import { eq } from "drizzle-orm";
import { startTestDb, stopTestDb, truncateAll } from "@/tests/integration/db-helper";
import {
  preparePayoutRunPass,
  selectPayoutRunCandidates,
  upsertTutorPayoutSheet,
} from "@/lib/post-class-feedback/payout-repository";
import { payoutRunWindow } from "@/lib/post-class-feedback/payout-window";
import { PostClassConflictError } from "@/lib/post-class-feedback/errors";
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

const WINDOW = payoutRunWindow("2026-07"); // 2026-06-26 → 2026-07-25

type DeductionStatus = "pending_review" | "approved" | "waived" | "processed";

async function seedFinancePeriod(month: string): Promise<string> {
  const [row] = await handle.db.insert(schema.postClassFinancePeriods).values({
    month,
    status: "open",
    openedByEmail: "admin@example.com",
  }).returning({ id: schema.postClassFinancePeriods.id });
  return row.id;
}

async function seedDeduction(input: {
  id: string;
  endsAt: string;
  tutorKey: string | null;
  status: DeductionStatus;
  student?: string;
  reversedIntoPeriodId?: string;
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

  it("excludes a reversed deduction even though its status column still reads processed", async () => {
    // `applyPostClassFinanceAction`'s reverse branch inserts an offset and
    // never updates the deduction row, so `status` alone would say 'processed'
    // and a status-only filter that someone later widened would pay it out.
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
});

describe("preparePayoutRunPass", () => {
  it("creates the run and one line per approved deduction", async () => {
    await seedDeduction({ id: "a", endsAt: "2026-07-10T03:00:00.000Z", tutorKey: "kevin", status: "approved" });
    await seedDeduction({ id: "b", endsAt: "2026-07-11T03:00:00.000Z", tutorKey: "mimi", status: "approved" });

    const result = await preparePayoutRunPass(
      { window: WINDOW, actorEmail: "finance@example.com" },
      appDb(),
    );

    expect(result.run.anchorMonth).toBe("2026-07-01");
    expect(result.run.status).toBe("draft");
    expect(result.lines).toHaveLength(2);
    expect(result.lines.every((line) => line.writeStatus === "pending")).toBe(true);
  });

  it("is safe to run twice — no duplicate lines, no unique violation", async () => {
    await seedDeduction({ id: "a", endsAt: "2026-07-10T03:00:00.000Z", tutorKey: "kevin", status: "approved" });

    const first = await preparePayoutRunPass({ window: WINDOW, actorEmail: "finance@example.com" }, appDb());
    const second = await preparePayoutRunPass({ window: WINDOW, actorEmail: "finance@example.com" }, appDb());

    expect(second.run.id).toBe(first.run.id);
    expect(second.lines).toHaveLength(1);
    expect(second.run.version).toBe(first.run.version + 1);
  });

  it("adds a line for a deduction approved after the run was first prepared", async () => {
    // The run is a durable container, not a one-shot event: a late approval
    // must still have somewhere to land.
    await seedDeduction({ id: "a", endsAt: "2026-07-10T03:00:00.000Z", tutorKey: "kevin", status: "approved" });
    await preparePayoutRunPass({ window: WINDOW, actorEmail: "finance@example.com" }, appDb());

    await seedDeduction({ id: "late", endsAt: "2026-07-12T03:00:00.000Z", tutorKey: "kevin", status: "approved" });
    const second = await preparePayoutRunPass({ window: WINDOW, actorEmail: "finance@example.com" }, appDb());

    expect(second.lines.map((line) => line.wiseSessionId).toSorted()).toEqual(["a", "late"]);
  });

  it("never re-touches a line that was already written", async () => {
    const deductionId = await seedDeduction({ id: "a", endsAt: "2026-07-10T03:00:00.000Z", tutorKey: "kevin", status: "approved" });
    const first = await preparePayoutRunPass({ window: WINDOW, actorEmail: "finance@example.com" }, appDb());
    await handle.db.update(schema.postClassPayoutRunLines).set({
      matchStatus: "matched",
      writeStatus: "written",
      insertedRowNumber: 12,
      writtenAt: new Date(),
    }).where(eq(schema.postClassPayoutRunLines.runId, first.run.id));

    const second = await preparePayoutRunPass({ window: WINDOW, actorEmail: "finance@example.com" }, appDb());

    const line = second.lines.find((row) => row.deductionId === deductionId)!;
    expect(line.writeStatus).toBe("written");
    expect(line.insertedRowNumber).toBe(12);
  });

  it("retires a line whose deduction stopped being approved between passes", async () => {
    const deductionId = await seedDeduction({ id: "a", endsAt: "2026-07-10T03:00:00.000Z", tutorKey: "kevin", status: "approved" });
    await preparePayoutRunPass({ window: WINDOW, actorEmail: "finance@example.com" }, appDb());

    await handle.db.update(schema.postClassDeductions)
      .set({ status: "waived" })
      .where(eq(schema.postClassDeductions.id, deductionId));
    const second = await preparePayoutRunPass({ window: WINDOW, actorEmail: "finance@example.com" }, appDb());

    expect(second.lines[0].writeStatus).toBe("skipped");
    expect(second.lines[0].writeError).toContain("no longer approved");
  });

  it("rejects a stale expectedVersion", async () => {
    await seedDeduction({ id: "a", endsAt: "2026-07-10T03:00:00.000Z", tutorKey: "kevin", status: "approved" });
    const first = await preparePayoutRunPass({ window: WINDOW, actorEmail: "finance@example.com" }, appDb());

    await expect(preparePayoutRunPass(
      { window: WINDOW, actorEmail: "finance@example.com", expectedVersion: first.run.version - 1 },
      appDb(),
    )).rejects.toBeInstanceOf(PostClassConflictError);
  });

  it("reports coverage, including which tutors have no mapped sheet", async () => {
    await seedDeduction({ id: "a", endsAt: "2026-07-10T03:00:00.000Z", tutorKey: "kevin", status: "approved" });
    await seedDeduction({ id: "b", endsAt: "2026-07-11T03:00:00.000Z", tutorKey: "mimi", status: "approved" });
    await seedDeduction({ id: "c", endsAt: "2026-07-12T03:00:00.000Z", tutorKey: null, status: "approved" });
    await seedDeduction({ id: "d", endsAt: "2026-07-13T03:00:00.000Z", tutorKey: "kevin", status: "pending_review" });
    await upsertTutorPayoutSheet(appDb(), {
      canonicalKey: "kevin",
      spreadsheetId: "book-1",
      sheetName: "Kevin",
      sheetGid: 0,
      active: true,
      updatedByEmail: "admin@example.com",
    });

    const { coverage } = await preparePayoutRunPass(
      { window: WINDOW, actorEmail: "finance@example.com" },
      appDb(),
    );

    expect(coverage.approvedDeductions).toBe(3);
    expect(coverage.pendingReviewDeductions).toBe(1);
    expect(coverage.unmappedTutorKeys).toEqual(["mimi"]);
    expect(coverage.nullTutorKeyLines).toBe(1);
    expect(coverage.eligibleSessions).toBe(4);
    expect(coverage.readySessions).toBe(4);
    expect(coverage.blockingGlobalSourceIssues).toBe(0);
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

    const { coverage } = await preparePayoutRunPass(
      { window: WINDOW, actorEmail: "finance@example.com" },
      appDb(),
    );
    expect(coverage.blockingGlobalSourceIssues).toBe(1);
  });
});
