/**
 * Unattended ledger retirement (auto-un-charge), against real Postgres and an
 * in-memory sheet.
 *
 * What is pinned: which live written lines the pass takes off the ledger
 * (waived / ineligible / assessment-cleared, inside the automation scope),
 * that deletion is proven by readback before any line is retired, that a
 * pending correction on a retired line is superseded (no lone +฿100), and
 * that the pass stands down rather than fight a live publish lease or run
 * with unattended charging off.
 *
 * `npm run test:integration` (Docker), or point at a scratch database with
 * TEST_DATABASE_URL.
 */

import { randomUUID } from "node:crypto";

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { eq } from "drizzle-orm";
import { startTestDb, stopTestDb, truncateAll } from "@/tests/integration/db-helper";
import type { PayoutGoogleTarget } from "@/lib/post-class-feedback/payout-config";
import {
  runPayoutLedgerRetirement,
  type PayoutRetirementSheetOps,
} from "@/lib/post-class-feedback/payout-retirement";
import { payoutBangkokDate } from "@/lib/post-class-feedback/payout-window";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";

let handle: Awaited<ReturnType<typeof startTestDb>>;

beforeAll(async () => {
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

// A window ~13 months ahead, safely past the automation floor.
const ANCHOR = payoutBangkokDate(
  new Date(Date.now() + 400 * 24 * 60 * 60 * 1_000),
).slice(0, 7);
const CLASS_DAY = `${ANCHOR}-10`;
const NOW = new Date(`${ANCHOR}-12T04:00:00.000Z`);

const MARKER_A = `BGS-PAYOUT ${ANCHOR} aaaaaaaaaaaa`;
const MARKER_B = `BGS-PAYOUT ${ANCHOR} bbbbbbbbbbbb`;
const CORRECTION_MARKER = `BGS-PAYOUT-CORRECTION ${ANCHOR} aaaaaaaaaaaa`;

const TARGET: PayoutGoogleTarget = {
  environmentTarget: "scratch",
  connectedEmail: "finance@example.com",
  driveFolderId: "drive-folder",
  workbooksFolderId: "workbooks-folder",
  masterSpreadsheetId: "master-sheet",
  sourceSheetName: "Begifted Payouts Detailed",
  deductionsSheetName: "Feedback Deductions",
  compositeSheetName: "Payouts With Deductions",
  writesEnabled: true,
};

const HEADER = [
  "Teacher name", "Session name", "Course name",
  "Date", "Time", "Duration", "Credits deducted", "Payout amount",
];

function deductionRow(marker: string, amount = -100): unknown[] {
  return [
    "Kevin (Kev) Y. Hsieh",
    `Feedback deduction — late submission ${marker}`,
    "Math",
    45_000,
    0.5,
    "60 mins",
    0,
    amount,
  ];
}

function fakeSheet(rows: unknown[][]) {
  const grid = [[...HEADER], ...rows.map((row) => [...row])];
  const calls: string[] = [];
  const ops = {
    async listSheetProperties() {
      calls.push("list");
      return [{ sheetId: 11, title: TARGET.deductionsSheetName, index: 0 }];
    },
    async fetchRows() {
      calls.push("fetch");
      return grid.map((row) => [...row]);
    },
    async batchUpdate(_email: string, _spreadsheetId: string, requests: unknown[]) {
      calls.push("delete");
      for (const request of requests as {
        deleteDimension: { range: { startIndex: number; endIndex: number } };
      }[]) {
        grid.splice(
          request.deleteDimension.range.startIndex,
          request.deleteDimension.range.endIndex - request.deleteDimension.range.startIndex,
        );
      }
    },
  };
  return { grid, calls, ops: ops as unknown as PayoutRetirementSheetOps };
}

async function seedWrittenLine(input: {
  wiseSessionId: string;
  marker: string;
  deductionStatus?: "approved" | "waived";
  eligible?: boolean;
  eligibilityReason?: string;
  objectiveViolation?: boolean | null;
}): Promise<{ sessionId: string; deductionId: string; runId: string; lineId: string }> {
  const at = new Date(`${CLASS_DAY}T03:00:00.000Z`);
  const [session] = await handle.db.insert(schema.postClassSessions).values({
    wiseSessionId: input.wiseSessionId,
    wiseClassId: "class-1",
    className: "Math",
    canonicalTutorKey: "kevin",
    canonicalTutorName: "Kevin",
    scheduledStartAt: at,
    scheduledEndAt: at,
    deadlineAt: at,
    finalStatus: "ENDED",
    eligible: input.eligible ?? true,
    eligibilityReason: input.eligibilityReason ?? null,
    sourceStatus: "ready",
    enforcementMode: "live",
  }).returning({ id: schema.postClassSessions.id });
  if (input.objectiveViolation !== null && input.objectiveViolation !== undefined) {
    await handle.db.insert(schema.postClassAssessments).values({
      sessionId: session.id,
      assessmentKey: `${input.wiseSessionId}:latest`,
      policyVersion: 1,
      mappingVersion: 1,
      sourceStatus: "ready",
      contentStatus: "substantive",
      timingStatus: input.objectiveViolation ? "late" : "on_time",
      enforcementMode: "live",
      objectiveViolation: input.objectiveViolation,
      rawOnTime: !input.objectiveViolation,
      adjustedCompliant: !input.objectiveViolation,
      sourceReady: true,
      details: { policyApplies: true },
    });
  }
  const [deduction] = await handle.db.insert(schema.postClassDeductions).values({
    sessionId: session.id,
    status: input.deductionStatus ?? "approved",
    amountMinor: 10_000,
    defaultFinanceMonth: `${ANCHOR}-01`,
    decisionByEmail: "reviewer@example.com",
    decisionAt: at,
  }).returning({ id: schema.postClassDeductions.id });
  const [run] = await handle.db.insert(schema.postClassPayoutRuns).values({
    anchorMonth: `${ANCHOR}-01`,
    windowStart: `${payoutBangkokDate(new Date(`${ANCHOR}-01T00:00:00.000Z`)).slice(0, 7)}-26`,
    windowEnd: `${ANCHOR}-25`,
    status: "partial",
    version: 3,
  }).onConflictDoNothing().returning({ id: schema.postClassPayoutRuns.id });
  const runId = run?.id ?? (await handle.db.select({ id: schema.postClassPayoutRuns.id })
    .from(schema.postClassPayoutRuns).limit(1))[0].id;
  const [line] = await handle.db.insert(schema.postClassPayoutRunLines).values({
    runId,
    deductionId: deduction.id,
    sessionId: session.id,
    sourceIdentity: `deduction:${deduction.id}`,
    rowSignature: input.marker,
    canonicalTutorKey: "kevin",
    tutorName: "Kevin",
    wiseSessionId: input.wiseSessionId,
    scheduledStartAt: at,
    scheduledEndAt: at,
    deadlineAt: at,
    amountMinor: -10_000,
    matchStatus: "matched",
    writeStatus: "written",
    writtenAt: at,
    insertedRowNumber: 2,
    idempotencyKey: `line:${deduction.id}`,
  }).returning({ id: schema.postClassPayoutRunLines.id });
  return { sessionId: session.id, deductionId: deduction.id, runId, lineId: line.id };
}

async function lineState(lineId: string) {
  const [row] = await handle.db.select({
    retiredAt: schema.postClassPayoutRunLines.retiredAt,
    retiredReason: schema.postClassPayoutRunLines.retiredReason,
    insertedRowNumber: schema.postClassPayoutRunLines.insertedRowNumber,
  }).from(schema.postClassPayoutRunLines)
    .where(eq(schema.postClassPayoutRunLines.id, lineId));
  return row;
}

describe("runPayoutLedgerRetirement", () => {
  it("deletes the row and retires the line of a waived deduction, superseding its pending correction", async () => {
    const seeded = await seedWrittenLine({
      wiseSessionId: "s-waived",
      marker: MARKER_A,
      deductionStatus: "waived",
      objectiveViolation: true,
    });
    const [adjustment] = await handle.db.insert(schema.postClassPayoutAdjustments).values({
      deductionId: seeded.deductionId,
      sourceLineId: seeded.lineId,
      runId: seeded.runId,
      kind: "waiver",
      status: "pending",
      amountMinor: 10_000,
      currency: "THB",
      reason: "waived after write",
      actorEmail: "reviewer@example.com",
      sourceIdentity: `adjustment:${randomUUID()}`,
      rowSignature: CORRECTION_MARKER,
      idempotencyKey: `adjustment:${randomUUID()}`,
    }).returning({ id: schema.postClassPayoutAdjustments.id });
    const sheet = fakeSheet([deductionRow(MARKER_A), deductionRow(MARKER_B)]);

    const result = await runPayoutLedgerRetirement(appDb(), {
      now: NOW,
      sheetOps: sheet.ops,
      resolveGoogleTarget: () => TARGET,
    });

    expect(result).toMatchObject({
      scanned: 1,
      retiredLines: 1,
      deletedRows: 1,
      supersededAdjustments: 1,
      skippedReason: null,
    });
    expect(sheet.grid.some((row) => String(row[1]).includes(MARKER_A))).toBe(false);
    expect(sheet.grid.some((row) => String(row[1]).includes(MARKER_B))).toBe(true);
    const line = await lineState(seeded.lineId);
    expect(line.retiredAt).not.toBeNull();
    expect(line.retiredReason).toMatch(/waived/iu);
    expect(line.insertedRowNumber).toBeNull();
    const [adj] = await handle.db.select({ status: schema.postClassPayoutAdjustments.status })
      .from(schema.postClassPayoutAdjustments)
      .where(eq(schema.postClassPayoutAdjustments.id, adjustment.id));
    expect(adj.status).toBe("superseded");
    const [run] = await handle.db.select({ version: schema.postClassPayoutRuns.version })
      .from(schema.postClassPayoutRuns)
      .where(eq(schema.postClassPayoutRuns.id, seeded.runId));
    expect(run.version).toBe(4);
  });

  it("retires an assessment-cleared violation and leaves a still-proven one alone", async () => {
    const cleared = await seedWrittenLine({
      wiseSessionId: "s-cleared",
      marker: MARKER_A,
      objectiveViolation: false,
    });
    const proven = await seedWrittenLine({
      wiseSessionId: "s-proven",
      marker: MARKER_B,
      objectiveViolation: true,
    });
    const sheet = fakeSheet([deductionRow(MARKER_A), deductionRow(MARKER_B)]);

    const result = await runPayoutLedgerRetirement(appDb(), {
      now: NOW,
      sheetOps: sheet.ops,
      resolveGoogleTarget: () => TARGET,
    });

    expect(result).toMatchObject({ scanned: 1, retiredLines: 1, deletedRows: 1 });
    expect((await lineState(cleared.lineId)).retiredAt).not.toBeNull();
    expect((await lineState(proven.lineId)).retiredAt).toBeNull();
    expect(sheet.grid.some((row) => String(row[1]).includes(MARKER_B))).toBe(true);
  });

  it("retires an ineligible session's line with the eligibility reason", async () => {
    const seeded = await seedWrittenLine({
      wiseSessionId: "s-ineligible",
      marker: MARKER_A,
      eligible: false,
      eligibilityReason: "cancelled",
      objectiveViolation: true,
    });
    const sheet = fakeSheet([deductionRow(MARKER_A)]);

    const result = await runPayoutLedgerRetirement(appDb(), {
      now: NOW,
      sheetOps: sheet.ops,
      resolveGoogleTarget: () => TARGET,
    });

    expect(result).toMatchObject({ retiredLines: 1 });
    expect((await lineState(seeded.lineId)).retiredReason).toMatch(/cancelled/u);
  });

  it("skips a row whose sheet amount was hand-edited instead of destroying the evidence", async () => {
    const seeded = await seedWrittenLine({
      wiseSessionId: "s-edited",
      marker: MARKER_A,
      deductionStatus: "waived",
      objectiveViolation: true,
    });
    const sheet = fakeSheet([deductionRow(MARKER_A, -50)]);

    const result = await runPayoutLedgerRetirement(appDb(), {
      now: NOW,
      sheetOps: sheet.ops,
      resolveGoogleTarget: () => TARGET,
    });

    expect(result).toMatchObject({ scanned: 1, retiredLines: 0, deletedRows: 0 });
    expect(result.skippedTargets).toHaveLength(1);
    expect(result.skippedTargets[0].reason).toMatch(/amount/u);
    expect((await lineState(seeded.lineId)).retiredAt).toBeNull();
  });

  it("retires a line whose sheet row is already absent (partial-failure recovery)", async () => {
    const seeded = await seedWrittenLine({
      wiseSessionId: "s-absent",
      marker: MARKER_A,
      deductionStatus: "waived",
      objectiveViolation: true,
    });
    const sheet = fakeSheet([deductionRow(MARKER_B)]);

    const result = await runPayoutLedgerRetirement(appDb(), {
      now: NOW,
      sheetOps: sheet.ops,
      resolveGoogleTarget: () => TARGET,
    });

    expect(result).toMatchObject({ retiredLines: 1, deletedRows: 0 });
    expect((await lineState(seeded.lineId)).retiredAt).not.toBeNull();
  });

  it("is a no-op while unattended charging is off", async () => {
    await seedWrittenLine({
      wiseSessionId: "s-flag-off",
      marker: MARKER_A,
      deductionStatus: "waived",
      objectiveViolation: true,
    });
    const sheet = fakeSheet([deductionRow(MARKER_A)]);

    delete process.env.POST_CLASS_AUTO_APPROVE_ENABLED;
    try {
      const result = await runPayoutLedgerRetirement(appDb(), {
        now: NOW,
        sheetOps: sheet.ops,
        resolveGoogleTarget: () => TARGET,
      });
      expect(result.skippedReason).toBe("auto-charge disabled");
      expect(sheet.calls).toHaveLength(0);
    } finally {
      process.env.POST_CLASS_AUTO_APPROVE_ENABLED = "true";
    }
  });

  it("stands down while a publish lease is live", async () => {
    const seeded = await seedWrittenLine({
      wiseSessionId: "s-lease",
      marker: MARKER_A,
      deductionStatus: "waived",
      objectiveViolation: true,
    });
    await handle.db.update(schema.postClassPayoutRuns).set({
      status: "publishing",
      leaseToken: randomUUID(),
      leaseExpiresAt: new Date(Date.now() + 10 * 60_000),
    }).where(eq(schema.postClassPayoutRuns.id, seeded.runId));
    const sheet = fakeSheet([deductionRow(MARKER_A)]);

    const result = await runPayoutLedgerRetirement(appDb(), {
      now: NOW,
      sheetOps: sheet.ops,
      resolveGoogleTarget: () => TARGET,
    });

    expect(result.skippedReason).toBe("publish lease live");
    expect(sheet.calls).toHaveLength(0);
    expect((await lineState(seeded.lineId)).retiredAt).toBeNull();
  });
});
