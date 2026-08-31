/**
 * Continuous auto-approval and reopen sweep, against real Postgres.
 *
 * Every state change goes through the existing `applyPostClassReviewAction`,
 * so what is pinned here is candidate selection: which deductions the sweep
 * decides to touch, and that touching them twice is a no-op.
 *
 * `npm run test:integration` (Docker), or point at a scratch database with
 * TEST_DATABASE_URL.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { eq } from "drizzle-orm";
import { startTestDb, stopTestDb, truncateAll } from "@/tests/integration/db-helper";
import {
  runPostClassAutoApprovals,
  runPostClassAutoApprovalSweep,
  runPostClassAutoReopens,
  runPostClassIneligibleWaivers,
} from "@/lib/post-class-feedback/auto-approval";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";

let handle: Awaited<ReturnType<typeof startTestDb>>;

beforeAll(async () => {
  // The approve sweep is opt-in and off by default (INC-260829); this suite
  // exercises the sweep itself, so switch it on for the duration.
  process.env.POST_CLASS_AUTO_APPROVE_ENABLED = "true";
  handle = await startTestDb();
}, 60_000);

afterAll(async () => {
  delete process.env.POST_CLASS_AUTO_APPROVE_ENABLED;
  if (handle) await stopTestDb(handle);
});

beforeEach(async () => {
  await truncateAll(handle.db);
});

function appDb(): Database {
  return handle.db as unknown as Database;
}

const GRACE_HOURS = 24;
// Inside the first unattended-charging window (2026-08-26 onward, MID-SEP).
const NOW = new Date("2026-09-15T12:00:00.000Z");

function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1_000);
}

async function seedSession(input: {
  wiseSessionId: string;
  deadlineAt: Date;
  eligible?: boolean;
  eligibilityReason?: string;
  sourceStatus?: "ready" | "unavailable" | "form_drift" | "identity_review";
  enforcementMode?: "shadow" | "live" | "paused";
}): Promise<string> {
  const [session] = await handle.db.insert(schema.postClassSessions).values({
    wiseSessionId: input.wiseSessionId,
    wiseClassId: "class-1",
    className: "Math",
    canonicalTutorKey: "kevin",
    canonicalTutorName: "Kevin Tutor",
    scheduledStartAt: input.deadlineAt,
    scheduledEndAt: input.deadlineAt,
    deadlineAt: input.deadlineAt,
    finalStatus: "ENDED",
    eligible: input.eligible ?? true,
    eligibilityReason: input.eligibilityReason ?? null,
    sourceStatus: input.sourceStatus ?? "ready",
    enforcementMode: input.enforcementMode ?? "live",
  }).returning({ id: schema.postClassSessions.id });
  return session.id;
}

/** The exact fixture shape `revalidateDeductionCandidate` (actions.ts) requires to approve. */
async function seedActionableAssessment(sessionId: string): Promise<void> {
  await handle.db.insert(schema.postClassAssessments).values({
    sessionId,
    assessmentKey: `${sessionId}:actionable`,
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
  sessionId: string;
  status: "pending_review" | "approved";
}): Promise<string> {
  const [deduction] = await handle.db.insert(schema.postClassDeductions).values({
    sessionId: input.sessionId,
    status: input.status,
    amountMinor: 10_000,
    defaultFinanceMonth: "2026-09-01",
  }).returning({ id: schema.postClassDeductions.id });
  return deduction.id;
}

async function deductionStatus(deductionId: string): Promise<string> {
  const [row] = await handle.db.select({ status: schema.postClassDeductions.status })
    .from(schema.postClassDeductions)
    .where(eq(schema.postClassDeductions.id, deductionId));
  return row.status;
}

describe("runPostClassAutoApprovals", () => {
  it("approves a past-deadline proven violation", async () => {
    const sessionId = await seedSession({
      wiseSessionId: "s-past-deadline",
      deadlineAt: hoursAgo(GRACE_HOURS + 1),
    });
    const deductionId = await seedDeduction({ sessionId, status: "pending_review" });
    await seedActionableAssessment(sessionId);

    const result = await runPostClassAutoApprovals(appDb(), NOW);

    expect(result).toEqual({ approved: 1, failed: 0 });
    expect(await deductionStatus(deductionId)).toBe("approved");
    const [deduction] = await handle.db.select().from(schema.postClassDeductions)
      .where(eq(schema.postClassDeductions.id, deductionId));
    expect(deduction.decisionByEmail).toBe("system:post-class-auto-approve");
  });

  it("is a no-op while the enable flag is off, whatever the backlog (INC-260829)", async () => {
    const sessionId = await seedSession({
      wiseSessionId: "s-disabled-sweep",
      deadlineAt: hoursAgo(GRACE_HOURS + 100),
    });
    const deductionId = await seedDeduction({ sessionId, status: "pending_review" });
    await seedActionableAssessment(sessionId);

    delete process.env.POST_CLASS_AUTO_APPROVE_ENABLED;
    try {
      const result = await runPostClassAutoApprovals(appDb(), NOW);
      expect(result).toEqual({ approved: 0, failed: 0 });
      expect(await deductionStatus(deductionId)).toBe("pending_review");
    } finally {
      process.env.POST_CLASS_AUTO_APPROVE_ENABLED = "true";
    }
  });

  it("skips a deduction still inside the grace window", async () => {
    const sessionId = await seedSession({
      wiseSessionId: "s-in-grace",
      deadlineAt: hoursAgo(GRACE_HOURS - 1),
    });
    const deductionId = await seedDeduction({ sessionId, status: "pending_review" });
    await seedActionableAssessment(sessionId);

    const result = await runPostClassAutoApprovals(appDb(), NOW);

    expect(result).toEqual({ approved: 0, failed: 0 });
    expect(await deductionStatus(deductionId)).toBe("pending_review");
  });

  it("skips a class before the automation floor — the INC-260829 backlog stays human", async () => {
    const sessionId = await seedSession({
      wiseSessionId: "s-before-floor",
      // 2026-08-20 Bangkok: proven, past-deadline, but inside the pre-automation
      // 2026-08 window that only a human may decide.
      deadlineAt: new Date("2026-08-20T16:59:59.999Z"),
    });
    const deductionId = await seedDeduction({ sessionId, status: "pending_review" });
    await seedActionableAssessment(sessionId);

    const result = await runPostClassAutoApprovals(appDb(), NOW);

    expect(result).toEqual({ approved: 0, failed: 0 });
    expect(await deductionStatus(deductionId)).toBe("pending_review");
  });

  it("skips a non-ready source", async () => {
    const sessionId = await seedSession({
      wiseSessionId: "s-not-ready",
      deadlineAt: hoursAgo(GRACE_HOURS + 1),
      sourceStatus: "unavailable",
    });
    const deductionId = await seedDeduction({ sessionId, status: "pending_review" });

    const result = await runPostClassAutoApprovals(appDb(), NOW);

    expect(result).toEqual({ approved: 0, failed: 0 });
    expect(await deductionStatus(deductionId)).toBe("pending_review");
  });
});

describe("runPostClassIneligibleWaivers", () => {
  it("waives a pending deduction on a cancelled class, no review needed", async () => {
    const sessionId = await seedSession({
      wiseSessionId: "s-cancelled",
      deadlineAt: hoursAgo(1),
      eligible: false,
      eligibilityReason: "cancelled",
    });
    const deductionId = await seedDeduction({ sessionId, status: "pending_review" });

    const result = await runPostClassIneligibleWaivers(appDb());

    expect(result).toEqual({ waived: 1, failed: 0 });
    const [deduction] = await handle.db.select().from(schema.postClassDeductions)
      .where(eq(schema.postClassDeductions.id, deductionId));
    expect(deduction.status).toBe("waived");
    expect(deduction.waiverCategory).toBe("class_cancelled");
    expect(deduction.decisionByEmail).toBe("system:post-class-ineligible-waive");
    expect(deduction.waiverNote).toContain("cancelled");
  });

  it("uses the generic category for other ineligibility reasons", async () => {
    const sessionId = await seedSession({
      wiseSessionId: "s-no-show",
      deadlineAt: hoursAgo(1),
      eligible: false,
      eligibilityReason: "missed_or_no_show",
    });
    const deductionId = await seedDeduction({ sessionId, status: "pending_review" });

    const result = await runPostClassIneligibleWaivers(appDb());

    expect(result).toEqual({ waived: 1, failed: 0 });
    const [deduction] = await handle.db.select().from(schema.postClassDeductions)
      .where(eq(schema.postClassDeductions.id, deductionId));
    expect(deduction.status).toBe("waived");
    expect(deduction.waiverCategory).toBe("other");
    expect(deduction.waiverNote).toContain("missed_or_no_show");
  });

  it("leaves pending deductions on eligible sessions for human review", async () => {
    const sessionId = await seedSession({
      wiseSessionId: "s-still-eligible",
      deadlineAt: hoursAgo(1),
    });
    const deductionId = await seedDeduction({ sessionId, status: "pending_review" });

    const result = await runPostClassIneligibleWaivers(appDb());

    expect(result).toEqual({ waived: 0, failed: 0 });
    expect(await deductionStatus(deductionId)).toBe("pending_review");
  });

  it("is a no-op on a second identical run", async () => {
    const sessionId = await seedSession({
      wiseSessionId: "s-cancelled-twice",
      deadlineAt: hoursAgo(1),
      eligible: false,
      eligibilityReason: "cancelled",
    });
    await seedDeduction({ sessionId, status: "pending_review" });

    expect(await runPostClassIneligibleWaivers(appDb()))
      .toEqual({ waived: 1, failed: 0 });
    expect(await runPostClassIneligibleWaivers(appDb()))
      .toEqual({ waived: 0, failed: 0 });
  });
});

describe("runPostClassAutoReopens", () => {
  it("reopens an approved deduction that lost proof (session no longer eligible)", async () => {
    const sessionId = await seedSession({
      wiseSessionId: "s-lost-eligibility",
      deadlineAt: hoursAgo(GRACE_HOURS + 1),
      eligible: false,
    });
    const deductionId = await seedDeduction({ sessionId, status: "approved" });

    const result = await runPostClassAutoReopens(appDb());

    expect(result).toEqual({ reopened: 1, failed: 0 });
    expect(await deductionStatus(deductionId)).toBe("pending_review");
  });

  it("reopens an approved deduction that lost proof (source no longer ready)", async () => {
    const sessionId = await seedSession({
      wiseSessionId: "s-lost-source",
      deadlineAt: hoursAgo(GRACE_HOURS + 1),
      sourceStatus: "form_drift",
    });
    const deductionId = await seedDeduction({ sessionId, status: "approved" });

    const result = await runPostClassAutoReopens(appDb());

    expect(result).toEqual({ reopened: 1, failed: 0 });
    expect(await deductionStatus(deductionId)).toBe("pending_review");
  });

  it("leaves an approved deduction with intact proof untouched", async () => {
    const sessionId = await seedSession({
      wiseSessionId: "s-proven",
      deadlineAt: hoursAgo(GRACE_HOURS + 1),
    });
    const deductionId = await seedDeduction({ sessionId, status: "approved" });

    const result = await runPostClassAutoReopens(appDb());

    expect(result).toEqual({ reopened: 0, failed: 0 });
    expect(await deductionStatus(deductionId)).toBe("approved");
  });
});

describe("runPostClassAutoApprovalSweep", () => {
  it("runs the reopen sweep before the approve sweep and tallies both", async () => {
    const approveSessionId = await seedSession({
      wiseSessionId: "s-sweep-approve",
      deadlineAt: hoursAgo(GRACE_HOURS + 1),
    });
    const approveDeductionId = await seedDeduction({
      sessionId: approveSessionId,
      status: "pending_review",
    });
    await seedActionableAssessment(approveSessionId);

    // Deliberately within grace: a deduction reopened by lost proof this same
    // tick would otherwise be immediately re-selected by the approve query
    // too (now pending_review, deadline already past grace) and correctly
    // fail revalidateDeductionCandidate on the same still-broken evidence --
    // a real, tolerated outcome, but not what this test is isolating.
    const reopenSessionId = await seedSession({
      wiseSessionId: "s-sweep-reopen",
      deadlineAt: hoursAgo(1),
      eligible: false,
    });
    const reopenDeductionId = await seedDeduction({
      sessionId: reopenSessionId,
      status: "approved",
    });

    const result = await runPostClassAutoApprovalSweep(appDb(), NOW);

    expect(result).toEqual({
      approved: 1,
      approveFailed: 0,
      reopened: 1,
      reopenFailed: 0,
      // The reopened deduction sits on an ineligible session, so the
      // ineligible-waive leg clears it in the same tick — no review item
      // survives for a class that no longer counts.
      waived: 1,
      waiveFailed: 0,
    });
    expect(await deductionStatus(approveDeductionId)).toBe("approved");
    expect(await deductionStatus(reopenDeductionId)).toBe("waived");
  });

  it("is a no-op on a second identical run", async () => {
    const sessionId = await seedSession({
      wiseSessionId: "s-idempotent",
      deadlineAt: hoursAgo(GRACE_HOURS + 1),
    });
    const deductionId = await seedDeduction({ sessionId, status: "pending_review" });
    await seedActionableAssessment(sessionId);

    const first = await runPostClassAutoApprovalSweep(appDb(), NOW);
    expect(first.approved).toBe(1);
    expect(await deductionStatus(deductionId)).toBe("approved");
    const actionsAfterFirst = await handle.db.select()
      .from(schema.postClassDeductionActions);

    const second = await runPostClassAutoApprovalSweep(appDb(), NOW);

    expect(second).toEqual({
      approved: 0,
      approveFailed: 0,
      reopened: 0,
      reopenFailed: 0,
      waived: 0,
      waiveFailed: 0,
    });
    const actionsAfterSecond = await handle.db.select()
      .from(schema.postClassDeductionActions);
    expect(actionsAfterSecond).toHaveLength(actionsAfterFirst.length);
  });
});
