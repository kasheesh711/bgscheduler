/**
 * Continuous payout accrual and automated finalize, against real Postgres.
 *
 * What matters most here is negative: an in-window accrual pass must never
 * mint `published` and must never touch the CSV fields, no matter how many
 * times it runs. Finalize is the mirror image -- it reaches `published` only
 * once the window has actually ended.
 *
 * Dates are deliberately computed relative to the real clock rather than
 * hardcoded: `markPayoutLine`'s lease guard compares `leaseExpiresAt` against
 * Postgres's own `now()`, so a simulated `now` in the past relative to the
 * real database clock would make every lease look pre-expired. Anchoring
 * ~13 months into the future keeps the simulated window safely ahead of the
 * real clock regardless of when this suite runs, while forcing a specific
 * day-of-month keeps which 26th->25th window is under test deterministic.
 *
 * `npm run test:integration` (Docker), or point at a scratch database with
 * TEST_DATABASE_URL.
 */

import { randomUUID } from "node:crypto";

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { startTestDb, stopTestDb, truncateAll } from "@/tests/integration/db-helper";
import {
  runPayoutAccrualPass,
  runPayoutFinalizePass,
} from "@/lib/post-class-feedback/payout-accrual";
import { upsertPayoutTutorName } from "@/lib/post-class-feedback/payout-repository";
import { DEDUCTION_SESSION_NAME } from "@/lib/post-class-feedback/payout-master";
import { payoutBangkokDate } from "@/lib/post-class-feedback/payout-window";
import type { PayoutRunView } from "@/lib/post-class-feedback/payout-run";
import type { MasterLedgerGateway } from "@/lib/post-class-feedback/payout-writer";
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
  await handle.db.delete(schema.postClassPayoutTutorNames);
});

function appDb(): Database {
  return handle.db as unknown as Database;
}

function dateSerial(iso: string): number {
  return Math.round(Date.parse(`${iso}T00:00:00.000Z`) / 86_400_000) + 25569;
}
function timeSerial(hours: number, minutes: number): number {
  return (hours * 60 + minutes) / 1440;
}

// A "YYYY-MM" anchor month ~13 months ahead of whenever this suite runs.
const ANCHOR_YEAR_MONTH = payoutBangkokDate(
  new Date(Date.now() + 400 * 24 * 60 * 60 * 1_000),
).slice(0, 7);
const PRIOR_ANCHOR_YEAR_MONTH = payoutBangkokDate(
  new Date(new Date(`${ANCHOR_YEAR_MONTH}-01T00:00:00.000Z`).getTime() - 24 * 60 * 60 * 1_000),
).slice(0, 7);
/** Day 10 of the anchor month: safely inside its 26th(prior)->25th window. */
const DAY_A = `${ANCHOR_YEAR_MONTH}-10`;
/** Day 11: a second in-window date, distinct from DAY_A. */
const DAY_B = `${ANCHOR_YEAR_MONTH}-11`;
/** One day past the anchor month's own 25th -- the window has just ended. */
const DAY_AFTER_END = `${ANCHOR_YEAR_MONTH}-26`;

const MID_WINDOW = new Date(`${DAY_A}T04:00:00.000Z`);
const POST_WINDOW = new Date(`${DAY_AFTER_END}T04:00:00.000Z`);

const HEADER = [
  "Teacher name", "Session name", "Course name",
  "Date", "Time", "Duration", "Credits deducted", "Payout amount",
];
const KEVIN = "Kevin (Kev) Y. Hsieh";

function sheetGrid(): unknown[][] {
  return [
    [...HEADER],
    [KEVIN, "On-site Session - Math", "Grace Hopper", dateSerial(DAY_A), timeSerial(3, 0), "60 mins", 1, 700],
    [KEVIN, "On-site Session - Math", "Ada Lovelace", dateSerial(DAY_B), timeSerial(3, 0), "60 mins", 1, 700],
  ];
}

function fakeGateway(grid: unknown[][]) {
  const calls: string[] = [];
  const gateway: MasterLedgerGateway = {
    async readRawGrid() {
      calls.push("read-raw");
      return grid.map((row) => [...row]);
    },
    async readDeductionGrid() {
      calls.push("read");
      return grid.map((row) => [...row]);
    },
    async appendDeductionRow(row: Array<string | number>) {
      calls.push("append");
      grid.push([...row]);
      return { rowNumber: grid.length };
    },
  };
  return { gateway, calls };
}

const uploadOk = async () => ({ fileId: "file-1", webViewLink: "https://drive/file-1", name: "x.csv" });

const TEST_TARGET = {
  environmentTarget: "scratch" as const,
  connectedEmail: "finance@example.com",
  driveFolderId: "drive-folder",
  workbooksFolderId: "workbooks-folder",
  masterSpreadsheetId: "master-sheet",
  sourceSheetName: "Begifted Payouts Detailed",
  deductionsSheetName: "Feedback Deductions",
  compositeSheetName: "Payouts With Deductions",
  writesEnabled: true,
};

function deductionRows(grid: unknown[][]) {
  return grid.filter((row) => String(row[1] ?? "").startsWith(DEDUCTION_SESSION_NAME));
}

/** An already-approved, proven-ready obligation -- outside the auto-approval sweep's reach. */
async function seedApprovedDeduction(input: {
  wiseSessionId: string;
  endsAtDay: string;
  student: string;
}): Promise<string> {
  const at = new Date(`${input.endsAtDay}T03:00:00.000Z`);
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
    eligible: true,
    sourceStatus: "ready",
  }).returning({ id: schema.postClassSessions.id });
  await handle.db.insert(schema.postClassSessionParticipants).values({
    sessionId: session.id,
    participantKey: `${input.wiseSessionId}:1`,
    studentName: input.student,
  });
  const [deduction] = await handle.db.insert(schema.postClassDeductions).values({
    sessionId: session.id,
    status: "approved",
    amountMinor: 10_000,
    defaultFinanceMonth: `${input.endsAtDay.slice(0, 7)}-01`,
  }).returning({ id: schema.postClassDeductions.id });
  return deduction.id;
}

async function seedKevinLedgerMapping(): Promise<void> {
  await upsertPayoutTutorName(appDb(), {
    canonicalKey: "kevin",
    primaryLedgerName: KEVIN,
    alternateLedgerName: null,
    active: true,
    updatedByEmail: "admin@example.com",
  });
}

function expectRunView(result: { skipped: string } | PayoutRunView): PayoutRunView {
  if ("skipped" in result) {
    throw new Error(`Expected a run view, got a skip: ${result.skipped}`);
  }
  return result;
}

describe("runPayoutAccrualPass", () => {
  it("appends approved+ready obligations in-window and never reaches published", async () => {
    await seedKevinLedgerMapping();
    await seedApprovedDeduction({
      wiseSessionId: "s-accrual-a",
      endsAtDay: DAY_A,
      student: "Grace Hopper",
    });
    const grid = sheetGrid();

    const view = expectRunView(await runPayoutAccrualPass(appDb(), {
      gateway: fakeGateway(grid).gateway,
      resolveGoogleTarget: () => TEST_TARGET,
      now: () => MID_WINDOW.getTime(),
    }, MID_WINDOW));

    expect(view.run.status).toBe("partial");
    expect(view.lines.every((line) => line.writeStatus === "written")).toBe(true);
    expect(deductionRows(grid)).toHaveLength(1);
  });

  it("never touches csvStatus/csvFileId/csvAttemptedAt across repeated in-window passes", async () => {
    await seedKevinLedgerMapping();
    await seedApprovedDeduction({
      wiseSessionId: "s-accrual-repeat-a",
      endsAtDay: DAY_A,
      student: "Grace Hopper",
    });
    const grid = sheetGrid();

    const first = expectRunView(await runPayoutAccrualPass(appDb(), {
      gateway: fakeGateway(grid).gateway,
      resolveGoogleTarget: () => TEST_TARGET,
      now: () => MID_WINDOW.getTime(),
    }, MID_WINDOW));

    // The draft defaults, never rewritten by an accrual pass.
    expect(first.run.csvStatus).toBe("pending");
    expect(first.run.csvFileId).toBeNull();
    expect(first.run.csvUrl).toBeNull();
    expect(first.run.csvAttemptedAt).toBeNull();

    // A new obligation arrives before the window ends: the second pass has
    // real work to do, so it re-enters publishPayoutRun a second time and
    // must leave the CSV fields untouched again.
    await seedApprovedDeduction({
      wiseSessionId: "s-accrual-repeat-b",
      endsAtDay: DAY_B,
      student: "Ada Lovelace",
    });

    const second = expectRunView(await runPayoutAccrualPass(appDb(), {
      gateway: fakeGateway(grid).gateway,
      resolveGoogleTarget: () => TEST_TARGET,
      now: () => MID_WINDOW.getTime(),
    }, MID_WINDOW));

    expect(second.run.status).toBe("partial");
    expect(second.run.csvStatus).toBe("pending");
    expect(second.run.csvFileId).toBeNull();
    expect(second.run.csvUrl).toBeNull();
    expect(second.run.csvAttemptedAt).toBeNull();
    expect(deductionRows(grid)).toHaveLength(2);
  });

  it("skips cleanly when nothing is pending", async () => {
    const result = await runPayoutAccrualPass(appDb(), {
      resolveGoogleTarget: () => TEST_TARGET,
      now: () => MID_WINDOW.getTime(),
    }, MID_WINDOW);

    expect(result).toEqual({ skipped: "nothing-pending" });
  });

  it("skips cleanly, without throwing, when a source sync is active", async () => {
    await seedKevinLedgerMapping();
    await seedApprovedDeduction({
      wiseSessionId: "s-accrual-sync-running",
      endsAtDay: DAY_A,
      student: "Grace Hopper",
    });
    await handle.db.insert(schema.postClassSyncRuns).values({
      windowStart: DAY_A,
      windowEnd: DAY_A,
    });
    const grid = sheetGrid();

    const result = await runPayoutAccrualPass(appDb(), {
      gateway: fakeGateway(grid).gateway,
      resolveGoogleTarget: () => TEST_TARGET,
      now: () => MID_WINDOW.getTime(),
    }, MID_WINDOW);

    expect(result).toMatchObject({ skipped: expect.stringMatching(/source sync is active/iu) });
    expect(deductionRows(grid)).toHaveLength(0);
  });

  it("skips cleanly, without throwing, when another actor already holds the lease", async () => {
    await seedKevinLedgerMapping();
    await seedApprovedDeduction({
      wiseSessionId: "s-accrual-lease-held",
      endsAtDay: DAY_A,
      student: "Grace Hopper",
    });
    await handle.db.insert(schema.postClassPayoutRuns).values({
      anchorMonth: `${ANCHOR_YEAR_MONTH}-01`,
      windowStart: `${PRIOR_ANCHOR_YEAR_MONTH}-26`,
      windowEnd: `${ANCHOR_YEAR_MONTH}-25`,
      status: "publishing",
      leaseToken: randomUUID(),
      leaseExpiresAt: new Date(MID_WINDOW.getTime() + 10 * 60_000),
      publishingByEmail: "someone-else@example.com",
      publishStartedAt: MID_WINDOW,
    });
    const grid = sheetGrid();

    const result = await runPayoutAccrualPass(appDb(), {
      gateway: fakeGateway(grid).gateway,
      resolveGoogleTarget: () => TEST_TARGET,
      now: () => MID_WINDOW.getTime(),
    }, MID_WINDOW);

    expect(result).toMatchObject({ skipped: expect.stringMatching(/active until/iu) });
    expect(deductionRows(grid)).toHaveLength(0);
  });
});

describe("runPayoutFinalizePass", () => {
  it("no-ops before the window has ended", async () => {
    const result = await runPayoutFinalizePass(appDb(), {}, MID_WINDOW);
    expect(result).toEqual({ skipped: "window-not-ended" });
  });

  it("reaches published once the window has ended and coverage is clean", async () => {
    await seedKevinLedgerMapping();
    await seedApprovedDeduction({
      wiseSessionId: "s-finalize",
      endsAtDay: DAY_A,
      student: "Grace Hopper",
    });
    const grid = sheetGrid();

    const view = expectRunView(await runPayoutFinalizePass(appDb(), {
      gateway: fakeGateway(grid).gateway,
      uploadCsv: uploadOk,
      resolveGoogleTarget: () => TEST_TARGET,
      now: () => POST_WINDOW.getTime(),
    }, POST_WINDOW));

    expect(view.run.status).toBe("published");
    expect(view.run.csvFileId).toBe("file-1");
    expect(view.lines.every((line) => line.writeStatus === "written")).toBe(true);
    expect(deductionRows(grid)).toHaveLength(1);
  });
});
