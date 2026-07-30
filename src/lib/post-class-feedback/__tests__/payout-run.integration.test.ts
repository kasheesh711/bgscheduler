/**
 * Publishing a payout run, end to end, against real Postgres and a fake sheet.
 *
 * The fake gateway holds a real ledger that really grows on append. What is
 * being pinned here is the property that matters most: pressing Publish twice
 * must not pay a tutor twice.
 *
 * `npm run test:integration` (Docker), or point at a scratch database with
 * TEST_DATABASE_URL.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { eq } from "drizzle-orm";
import { startTestDb, stopTestDb, truncateAll } from "@/tests/integration/db-helper";
import {
  publishPayoutRun as publishPayoutRunService,
  previewPayoutRun,
  type PayoutRunDependencies,
} from "@/lib/post-class-feedback/payout-run";
import type { PayoutPublishAcknowledgements } from "@/lib/post-class-feedback/payout-plan";
import {
  createPayoutAdjustment,
  upsertPayoutTutorName,
} from "@/lib/post-class-feedback/payout-repository";
import {
  CORRECTION_SESSION_NAME,
  DEDUCTION_SESSION_NAME,
} from "@/lib/post-class-feedback/payout-master";
import type { MasterLedgerGateway } from "@/lib/post-class-feedback/payout-writer";
import type { PostClassUser } from "@/lib/post-class-feedback/access";
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

const ACTOR: PostClassUser = {
  email: "finance@example.com",
  name: "Finance",
  role: "admin",
  capabilities: ["viewer", "reviewer", "finance", "access_manager"],
};

function dateSerial(iso: string): number {
  return Math.round(Date.parse(`${iso}T00:00:00.000Z`) / 86_400_000) + 25569;
}
function timeSerial(hours: number, minutes: number): number {
  return (hours * 60 + minutes) / 1440;
}

const HEADER = [
  "Teacher name", "Session name", "Course name",
  "Date", "Time", "Duration", "Credits deducted", "Payout amount",
];
const KEVIN = "Kevin (Kev) Y. Hsieh";
const KEVIN_ONLINE = "Kevin (Kev) Y. Hsieh Online";
const MIMI = "Mimi (Mimi) Somebody";

/** The shared ledger: every tutor's rows in one tab. */
function sheetGrid(): unknown[][] {
  return [
    [...HEADER],
    [MIMI, "Online Session - Math", "Someone Else", dateSerial("2026-07-10"), timeSerial(3, 0), "60 mins", 1, 700],
    [KEVIN, "On-site Session - Math", "Grace Hopper", dateSerial("2026-07-10"), timeSerial(3, 0), "60 mins", 1, 700],
    [KEVIN_ONLINE, "Online Session - Math", "Ada Lovelace", dateSerial("2026-07-11"), timeSerial(3, 0), "60 mins", 1, 700],
  ];
}

function fakeGateway(grid: unknown[][], options: { failAppendAt?: number } = {}) {
  const calls: string[] = [];
  let appends = 0;
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
      appends += 1;
      calls.push(`append#${appends}`);
      if (appends === options.failAppendAt) {
        throw new Error("Google Sheets append failed (429)");
      }
      grid.push([...row]);
      return { rowNumber: grid.length };
    },
  };
  return { gateway, calls };
}

async function seedDeduction(input: {
  wiseSessionId: string;
  endsAt: string;
  tutorKey: string | null;
  student: string;
}): Promise<void> {
  const at = new Date(input.endsAt);
  const [session] = await handle.db.insert(schema.postClassSessions).values({
    wiseSessionId: input.wiseSessionId,
    wiseClassId: "class-1",
    className: "Math",
    canonicalTutorKey: input.tutorKey,
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
  await handle.db.insert(schema.postClassDeductions).values({
    sessionId: session.id,
    status: "approved",
    amountMinor: 10_000,
    defaultFinanceMonth: `${input.endsAt.slice(0, 7)}-01`,
  });
}

async function seedTwoDeductionsAndMapping(): Promise<void> {
  await seedDeduction({
    wiseSessionId: "s-grace",
    endsAt: "2026-07-10T03:00:00.000Z",
    tutorKey: "kevin",
    student: "Grace Hopper",
  });
  await seedDeduction({
    wiseSessionId: "s-ada",
    endsAt: "2026-07-11T03:00:00.000Z",
    tutorKey: "kevin",
    student: "Ada Lovelace",
  });
  await upsertPayoutTutorName(appDb(), {
    canonicalKey: "kevin",
    primaryLedgerName: KEVIN,
    alternateLedgerName: KEVIN_ONLINE,
    active: true,
    updatedByEmail: "admin@example.com",
  });
}

function deductionRows(grid: unknown[][]) {
  // Session name is column B in the ledger, and carries the marker after it.
  return grid.filter((row) => String(row[1] ?? "").startsWith(DEDUCTION_SESSION_NAME));
}

function correctionRows(grid: unknown[][]) {
  return grid.filter((row) => String(row[1] ?? "").startsWith(CORRECTION_SESSION_NAME));
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

async function publish(
  _actor: PostClassUser,
  input: {
    anchorMonth: string;
    expectedVersion?: number;
    acknowledgements?: PayoutPublishAcknowledgements;
  },
  _db: Database,
  dependencies: PayoutRunDependencies,
) {
  const preview = await previewPayoutRun(ACTOR, {
    anchorMonth: input.anchorMonth,
  }, appDb());
  return publishPayoutRunService(ACTOR, {
    ...input,
    expectedVersion: input.expectedVersion ?? preview.run.version,
    previewToken: preview.previewToken,
    acknowledgements: input.acknowledgements ?? {
      confirmed: true,
      pendingReviewDeductions: preview.coverage.pendingReviewDeductions,
      nonReadySessions: preview.coverage.nonReadySessions,
      reason: "Integration payout publish confirmation.",
    },
  }, appDb(), {
    ...dependencies,
    resolveGoogleTarget: () => TEST_TARGET,
  });
}

describe("publishPayoutRun", () => {
  it("blocks publication through the last Bangkok day and allows it on the 26th", async () => {
    const before = await previewPayoutRun(ACTOR, { anchorMonth: "2026-08" }, appDb());
    await expect(publishPayoutRunService(ACTOR, {
      anchorMonth: "2026-08",
      expectedVersion: before.run.version,
      previewToken: before.previewToken,
      acknowledgements: {
        confirmed: true,
        pendingReviewDeductions: 0,
        nonReadySessions: 0,
        reason: "Boundary verification",
      },
    }, appDb(), {
      now: () => Date.parse("2026-08-25T16:59:59.000Z"),
      resolveGoogleTarget: () => TEST_TARGET,
      uploadCsv: uploadOk,
    })).rejects.toThrow(/has not ended in Bangkok/u);
    expect(await handle.db.select().from(schema.postClassPayoutRuns)).toHaveLength(0);

    const after = await publishPayoutRunService(ACTOR, {
      anchorMonth: "2026-08",
      expectedVersion: before.run.version,
      previewToken: before.previewToken,
      acknowledgements: {
        confirmed: true,
        pendingReviewDeductions: 0,
        nonReadySessions: 0,
        reason: "Boundary verification",
      },
    }, appDb(), {
      now: () => Date.parse("2026-08-25T17:00:00.000Z"),
      resolveGoogleTarget: () => TEST_TARGET,
      uploadCsv: uploadOk,
    });
    expect(after.run.status).toBe("published");
  });

  it("keeps preview read-only and returns a deterministic token", async () => {
    await seedTwoDeductionsAndMapping();
    const first = await previewPayoutRun(ACTOR, { anchorMonth: "2026-07" }, appDb());
    const second = await previewPayoutRun(ACTOR, { anchorMonth: "2026-07" }, appDb());
    const runs = await handle.db.select({ id: schema.postClassPayoutRuns.id })
      .from(schema.postClassPayoutRuns);

    expect(first.previewToken).toBe(second.previewToken);
    expect(first.runPersisted).toBe(false);
    expect(first.lines).toHaveLength(2);
    expect(runs).toHaveLength(0);
  });

  it("rejects Publish when the expected run version does not match the preview", async () => {
    await seedTwoDeductionsAndMapping();
    const grid = sheetGrid();
    const preview = await previewPayoutRun(ACTOR, { anchorMonth: "2026-07" }, appDb());

    await expect(publishPayoutRunService(ACTOR, {
      anchorMonth: "2026-07",
      expectedVersion: preview.run.version + 1,
      previewToken: preview.previewToken,
      acknowledgements: {
        confirmed: true,
        pendingReviewDeductions: 0,
        nonReadySessions: 0,
        reason: "Version fence verification",
      },
    }, appDb(), {
      gateway: fakeGateway(grid).gateway,
      uploadCsv: uploadOk,
      resolveGoogleTarget: () => TEST_TARGET,
    })).rejects.toThrow(/version changed/iu);

    expect(await handle.db.select().from(schema.postClassPayoutRuns)).toHaveLength(0);
    expect(deductionRows(grid)).toHaveLength(0);
  });

  it("publishes a zero-obligation run without reading or writing Sheets", async () => {
    const calls: string[] = [];
    const gateway: MasterLedgerGateway = {
      async readRawGrid() {
        calls.push("read-raw");
        return [];
      },
      async readDeductionGrid() {
        calls.push("read-deductions");
        return [];
      },
      async appendDeductionRow() {
        calls.push("append");
        return { rowNumber: null };
      },
    };
    const view = await publish(
      ACTOR,
      { anchorMonth: "2026-07" },
      appDb(),
      { gateway, uploadCsv: uploadOk },
    );

    expect(view.run.status).toBe("published");
    expect(view.lines).toHaveLength(0);
    expect(calls).toEqual([]);
  });

  it("reads anchors only from the raw tab and markers only from the dedicated tab", async () => {
    await seedDeduction({
      wiseSessionId: "s-separated-tabs",
      endsAt: "2026-07-10T03:00:00.000Z",
      tutorKey: "kevin",
      student: "Grace Hopper",
    });
    await upsertPayoutTutorName(appDb(), {
      canonicalKey: "kevin",
      primaryLedgerName: KEVIN,
      alternateLedgerName: KEVIN_ONLINE,
      active: true,
      updatedByEmail: "admin@example.com",
    });
    const preview = await previewPayoutRun(ACTOR, { anchorMonth: "2026-07" }, appDb());
    const raw = sheetGrid();
    // A marker on the externally refreshed raw tab is not publication
    // evidence. Only the app-owned dedicated tab may satisfy idempotency.
    raw.push([
      KEVIN,
      `${DEDUCTION_SESSION_NAME} · ${preview.lines[0].rowSignature}`,
      "Grace Hopper",
      dateSerial("2026-07-10"),
      timeSerial(3, 0),
      "—",
      0,
      -100,
    ]);
    const rawLength = raw.length;
    const deductions: unknown[][] = [[...HEADER]];
    let appends = 0;
    const gateway: MasterLedgerGateway = {
      async readRawGrid() {
        return raw.map((row) => [...row]);
      },
      async readDeductionGrid() {
        return deductions.map((row) => [...row]);
      },
      async appendDeductionRow(row) {
        appends += 1;
        deductions.push([...row]);
        return { rowNumber: deductions.length };
      },
    };

    const view = await publishPayoutRunService(ACTOR, {
      anchorMonth: "2026-07",
      expectedVersion: preview.run.version,
      previewToken: preview.previewToken,
      acknowledgements: {
        confirmed: true,
        pendingReviewDeductions: 0,
        nonReadySessions: 0,
        reason: "Finance verified separated source and marker tabs.",
      },
    }, appDb(), {
      gateway,
      uploadCsv: uploadOk,
      resolveGoogleTarget: () => TEST_TARGET,
    });

    expect(view.run.status).toBe("published");
    expect(appends).toBe(1);
    expect(raw).toHaveLength(rawLength);
    expect(deductionRows(deductions)).toHaveLength(1);
  });

  it("publishes only the exact tutor canary and leaves the overall run partial", async () => {
    await seedDeduction({
      wiseSessionId: "s-kevin-canary",
      endsAt: "2026-07-10T03:00:00.000Z",
      tutorKey: "kevin",
      student: "Grace Hopper",
    });
    await seedDeduction({
      wiseSessionId: "s-mimi-canary",
      endsAt: "2026-07-10T03:00:00.000Z",
      tutorKey: "mimi",
      student: "Someone Else",
    });
    await upsertPayoutTutorName(appDb(), {
      canonicalKey: "kevin",
      primaryLedgerName: KEVIN,
      alternateLedgerName: KEVIN_ONLINE,
      active: true,
      updatedByEmail: "admin@example.com",
    });
    await upsertPayoutTutorName(appDb(), {
      canonicalKey: "mimi",
      primaryLedgerName: MIMI,
      alternateLedgerName: null,
      active: true,
      updatedByEmail: "admin@example.com",
    });
    const grid = sheetGrid();
    const preview = await previewPayoutRun(
      ACTOR,
      { anchorMonth: "2026-07", tutorFilter: "kevin" },
      appDb(),
    );

    const view = await publishPayoutRunService(ACTOR, {
      anchorMonth: "2026-07",
      expectedVersion: preview.run.version,
      previewToken: preview.previewToken,
      tutorFilter: "kevin",
      acknowledgements: {
        confirmed: true,
        pendingReviewDeductions: 0,
        nonReadySessions: 0,
        reason: "Finance verified the exact Kevin canary.",
      },
    }, appDb(), {
      gateway: fakeGateway(grid).gateway,
      uploadCsv: uploadOk,
      resolveGoogleTarget: () => TEST_TARGET,
    });

    expect(view.run.status).toBe("partial");
    expect(deductionRows(grid)).toHaveLength(1);
    expect(deductionRows(grid)[0][0]).toBe(KEVIN);
    expect(view.run.publishAcknowledgements?.tutorFilter).toBe("kevin");
  });

  it("appends one ledger row per deduction and publishes the run", async () => {
    await seedTwoDeductionsAndMapping();
    const grid = sheetGrid();
    const { gateway } = fakeGateway(grid);
    const preview = await previewPayoutRun(ACTOR, { anchorMonth: "2026-07" }, appDb());

    const view = await publish(
      ACTOR,
      { anchorMonth: "2026-07", expectedVersion: preview.run.version },
      appDb(),
      { gateway, uploadCsv: uploadOk },
    );

    expect(view.run.status).toBe("published");
    expect(view.run.csvFileId).toBe("file-1");
    expect(view.csvError).toBeNull();
    expect(view.lines.every((line) => line.writeStatus === "written")).toBe(true);
    expect(deductionRows(grid)).toHaveLength(2);
    for (const row of deductionRows(grid)) {
      expect(row[7]).toBe(-100);
      expect(String(row[1])).toContain("BGS-PAYOUT 2026-07");
      // Attributed to one of this tutor's ledger identities, never another's.
      expect([KEVIN, KEVIN_ONLINE]).toContain(row[0]);
    }
    // Every original class row keeps its own earnings, and nothing shifted.
    expect(grid.filter((row) => row[7] === 700)).toHaveLength(3);
  });

  it("starts no Google append once planning reaches the lease quiescence window", async () => {
    await seedTwoDeductionsAndMapping();
    const grid = sheetGrid();
    const calls: string[] = [];
    let clock = Date.now();
    const gateway: MasterLedgerGateway = {
      async readRawGrid() {
        calls.push("read-raw");
        return grid.map((row) => [...row]);
      },
      async readDeductionGrid() {
        calls.push("read-deductions");
        // Simulate unusually slow source planning. The lease has 15 minutes
        // and the external-write budget ends at minute 10, preserving a
        // five-minute quiet interval before a replacement may take over.
        clock += 10 * 60 * 1_000 + 30 * 1_000;
        return grid.map((row) => [...row]);
      },
      async appendDeductionRow(row) {
        calls.push("append");
        grid.push([...row]);
        return { rowNumber: grid.length };
      },
    };

    const view = await publish(
      ACTOR,
      { anchorMonth: "2026-07", expectedVersion: 1 },
      appDb(),
      { gateway, uploadCsv: uploadOk, now: () => clock },
    );

    expect(view.run.status).toBe("partial");
    expect(view.stoppedEarly).toBe(true);
    expect(calls).toEqual(["read-raw", "read-deductions"]);
    expect(deductionRows(grid)).toHaveLength(0);
    expect(view.lines.every((line) => line.writeStatus === "pending")).toBe(true);
  });

  it("writes nothing on a second publish", async () => {
    await seedTwoDeductionsAndMapping();
    const grid = sheetGrid();
    const first = await publish(
      ACTOR,
      { anchorMonth: "2026-07", expectedVersion: 1 },
      appDb(),
      { gateway: fakeGateway(grid).gateway, uploadCsv: uploadOk },
    );
    expect(deductionRows(grid)).toHaveLength(2);

    const second = fakeGateway(grid);
    const view = await publish(
      ACTOR,
      { anchorMonth: "2026-07", expectedVersion: first.run.version },
      appDb(),
      { gateway: second.gateway, uploadCsv: uploadOk },
    );

    expect(deductionRows(grid)).toHaveLength(2);
    expect(second.calls.some((call) => call.startsWith("append"))).toBe(false);
    expect(second.calls.includes("append#1")).toBe(false);
    expect(view.lines.every((line) => line.writeStatus === "written")).toBe(true);
  });

  it("does not reuse a raw source row claimed by a line written in an earlier pass", async () => {
    await seedTwoDeductionsAndMapping();
    const rawGrid = sheetGrid();
    const dedicatedGrid: unknown[][] = [[...HEADER]];
    const splitGateway: MasterLedgerGateway = {
      async readRawGrid() {
        return rawGrid.map((row) => [...row]);
      },
      async readDeductionGrid() {
        return dedicatedGrid.map((row) => [...row]);
      },
      async appendDeductionRow(row) {
        dedicatedGrid.push([...row]);
        return { rowNumber: dedicatedGrid.length };
      },
    };
    await publish(
      ACTOR,
      { anchorMonth: "2026-07" },
      appDb(),
      { gateway: splitGateway, uploadCsv: uploadOk },
    );
    expect(deductionRows(dedicatedGrid)).toHaveLength(2);

    // This new obligation has the same tutor, start, and student as s-grace.
    // The original raw row was consumed in the prior pass and must not serve
    // as proof for a second deduction.
    await seedDeduction({
      wiseSessionId: "s-grace-duplicate-anchor",
      endsAt: "2026-07-10T03:00:00.000Z",
      tutorKey: "kevin",
      student: "Grace Hopper",
    });
    const second = await publish(
      ACTOR,
      { anchorMonth: "2026-07" },
      appDb(),
      { gateway: splitGateway, uploadCsv: uploadOk },
    );

    const duplicate = second.lines.find(
      (line) => line.wiseSessionId === "s-grace-duplicate-anchor",
    );
    expect(duplicate?.writeStatus).toBe("skipped");
    expect(duplicate?.writeError).toMatch(
      /source rows match; no row was appended|no source payout row matches/iu,
    );
    expect(deductionRows(dedicatedGrid)).toHaveLength(2);
  });

  it("retries only the failed line, and does not duplicate the one that succeeded", async () => {
    await seedTwoDeductionsAndMapping();
    const grid = sheetGrid();
    const first = await publish(
      ACTOR,
      { anchorMonth: "2026-07", expectedVersion: 1 },
      appDb(),
      { gateway: fakeGateway(grid, { failAppendAt: 1 }).gateway, uploadCsv: uploadOk },
    );
    expect(first.lines.filter((line) => line.writeStatus === "failed")).toHaveLength(1);
    expect(deductionRows(grid)).toHaveLength(1);

    const view = await publish(
      ACTOR,
      { anchorMonth: "2026-07", expectedVersion: first.run.version },
      appDb(),
      { gateway: fakeGateway(grid).gateway, uploadCsv: uploadOk },
    );

    expect(view.lines.every((line) => line.writeStatus === "written")).toBe(true);
    expect(deductionRows(grid)).toHaveLength(2);
  });

  it("appends one positive correction linked to its landed negative row", async () => {
    await seedTwoDeductionsAndMapping();
    const grid = sheetGrid();
    const first = await publish(
      ACTOR,
      { anchorMonth: "2026-07" },
      appDb(),
      { gateway: fakeGateway(grid).gateway, uploadCsv: uploadOk },
    );
    const sourceLine = first.lines.find((line) => line.wiseSessionId === "s-grace")!;
    const adjustment = await createPayoutAdjustment(appDb(), {
      deductionId: sourceLine.deductionId,
      kind: "waiver",
      reason: "Waived after the payout row landed",
      actorEmail: ACTOR.email,
      actionIdentity: "waiver:s-grace",
    });

    const second = await publish(
      ACTOR,
      { anchorMonth: "2026-07" },
      appDb(),
      { gateway: fakeGateway(grid).gateway, uploadCsv: uploadOk },
    );

    expect(second.run.status).toBe("published");
    expect(second.adjustments).toHaveLength(1);
    expect(second.adjustments[0].status).toBe("written");
    expect(correctionRows(grid)).toHaveLength(1);
    expect(correctionRows(grid)[0][7]).toBe(100);
    expect(String(correctionRows(grid)[0][1])).toContain(adjustment.rowSignature);
    expect(String(correctionRows(grid)[0][1])).toContain(sourceLine.rowSignature);
  });

  it("keeps a transient correction failure retryable without creating an exception", async () => {
    await seedTwoDeductionsAndMapping();
    const grid = sheetGrid();
    const first = await publish(
      ACTOR,
      { anchorMonth: "2026-07" },
      appDb(),
      { gateway: fakeGateway(grid).gateway, uploadCsv: uploadOk },
    );
    const sourceLine = first.lines.find((line) => line.wiseSessionId === "s-grace")!;
    await createPayoutAdjustment(appDb(), {
      deductionId: sourceLine.deductionId,
      kind: "waiver",
      reason: "Waived after the payout row landed",
      actorEmail: ACTOR.email,
      actionIdentity: "waiver:s-grace:retry",
    });

    const failed = await publish(
      ACTOR,
      { anchorMonth: "2026-07" },
      appDb(),
      { gateway: fakeGateway(grid, { failAppendAt: 1 }).gateway, uploadCsv: uploadOk },
    );

    expect(failed.run.status).toBe("partial");
    expect(failed.adjustments).toHaveLength(1);
    expect(failed.adjustments[0].status).toBe("failed");
    expect(correctionRows(grid)).toHaveLength(0);
    expect(await handle.db.select().from(schema.postClassPayoutExceptions))
      .toHaveLength(0);

    const retried = await publish(
      ACTOR,
      { anchorMonth: "2026-07", expectedVersion: failed.run.version },
      appDb(),
      { gateway: fakeGateway(grid).gateway, uploadCsv: uploadOk },
    );

    expect(retried.run.status).toBe("published");
    expect(retried.adjustments[0].status).toBe("written");
    expect(correctionRows(grid)).toHaveLength(1);
    expect(await handle.db.select().from(schema.postClassPayoutExceptions))
      .toHaveLength(0);
  });

  it("skips a tutor with no mapped ledger identity instead of guessing one", async () => {
    await seedDeduction({
      wiseSessionId: "s-unmapped",
      endsAt: "2026-07-10T03:00:00.000Z",
      tutorKey: "mimi",
      student: "Grace Hopper",
    });
    const grid = sheetGrid();

    const view = await publish(
      ACTOR,
      { anchorMonth: "2026-07", expectedVersion: 1 },
      appDb(),
      { gateway: fakeGateway(grid).gateway, uploadCsv: uploadOk },
    );

    expect(view.lines[0].matchStatus).toBe("no_sheet");
    expect(view.lines[0].writeStatus).toBe("skipped");
    expect(view.lines[0].writeError).toContain("No ledger name is mapped for mimi");
    expect(deductionRows(grid)).toHaveLength(0);
  });

  it("refuses a ledger whose columns have moved", async () => {
    // A reordered re-paste must be detected, not appended to under the wrong
    // headings — that is how a deduction ends up in the wrong column entirely.
    await seedTwoDeductionsAndMapping();
    const grid = sheetGrid();
    grid[0] = ["Date", "Teacher name", "Session name", "Course name", "Time", "Duration", "Credits deducted", "Payout amount"];

    const view = await publish(
      ACTOR,
      { anchorMonth: "2026-07", expectedVersion: 1 },
      appDb(),
      { gateway: fakeGateway(grid).gateway, uploadCsv: uploadOk },
    );

    expect(view.lines.every((line) => line.writeStatus === "skipped")).toBe(true);
    expect(view.lines[0].writeError).toContain("required A:H headers");
    expect(deductionRows(grid)).toHaveLength(0);
  });

  it("reports an unmatched deduction rather than writing it somewhere plausible", async () => {
    await seedDeduction({
      wiseSessionId: "s-missing",
      endsAt: "2026-07-20T03:00:00.000Z",
      tutorKey: "kevin",
      student: "Nobody At All",
    });
    await upsertPayoutTutorName(appDb(), {
      canonicalKey: "kevin",
      primaryLedgerName: KEVIN,
      alternateLedgerName: KEVIN_ONLINE,
      active: true,
      updatedByEmail: "admin@example.com",
    });
    const grid = sheetGrid();

    const view = await publish(
      ACTOR,
      { anchorMonth: "2026-07", expectedVersion: 1 },
      appDb(),
      { gateway: fakeGateway(grid).gateway, uploadCsv: uploadOk },
    );

    expect(view.lines[0].matchStatus).toBe("unmatched");
    expect(deductionRows(grid)).toHaveLength(0);
  });

  it("retries a skipped line directly against a fresh source read", async () => {
    await seedDeduction({
      wiseSessionId: "s-late-source",
      endsAt: "2026-07-20T03:00:00.000Z",
      tutorKey: "kevin",
      student: "Late Source Student",
    });
    await upsertPayoutTutorName(appDb(), {
      canonicalKey: "kevin",
      primaryLedgerName: KEVIN,
      alternateLedgerName: KEVIN_ONLINE,
      active: true,
      updatedByEmail: "admin@example.com",
    });
    const grid = sheetGrid();
    const first = await publish(
      ACTOR,
      { anchorMonth: "2026-07" },
      appDb(),
      { gateway: fakeGateway(grid).gateway, uploadCsv: uploadOk },
    );
    expect(first.lines[0].writeStatus).toBe("skipped");
    expect(first.exceptions).toHaveLength(0);
    grid.push([
      KEVIN,
      "On-site Session - Math",
      "Late Source Student",
      dateSerial("2026-07-20"),
      timeSerial(3, 0),
      "60 mins",
      1,
      700,
    ]);
    const second = await publish(
      ACTOR,
      { anchorMonth: "2026-07" },
      appDb(),
      { gateway: fakeGateway(grid).gateway, uploadCsv: uploadOk },
    );
    expect(second.lines[0].writeStatus).toBe("written");
    expect(deductionRows(grid)).toHaveLength(1);
  });

  it("stays published when the Drive upload fails, and records why", async () => {
    // The sheets are already money. A Drive failure must never make a run that
    // moved money look like one that did not.
    await seedTwoDeductionsAndMapping();
    const grid = sheetGrid();

    const view = await publish(
      ACTOR,
      { anchorMonth: "2026-07", expectedVersion: 1 },
      appDb(),
      {
        gateway: fakeGateway(grid).gateway,
        uploadCsv: async () => { throw new Error("Drive upload failed (404)"); },
      },
    );

    expect(view.run.status).toBe("published");
    expect(view.run.csvFileId).toBeNull();
    expect(view.csvError).toContain("404");
    expect(view.lines.every((line) => line.writeStatus === "written")).toBe(true);
    expect(deductionRows(grid)).toHaveLength(2);
  });

  it("blocks a window that is materially unreconciled until it is acknowledged", async () => {
    await seedTwoDeductionsAndMapping();
    // 60 eligible sessions with no trustworthy evidence against 2 that have it.
    const at = new Date("2026-07-15T03:00:00.000Z");
    await handle.db.insert(schema.postClassSessions).values(
      Array.from({ length: 60 }, (_, index) => ({
        wiseSessionId: `unreconciled-${index}`,
        wiseClassId: "class-2",
        scheduledStartAt: at,
        scheduledEndAt: at,
        deadlineAt: at,
        finalStatus: "ENDED",
        eligible: true,
        sourceStatus: "unavailable" as const,
      })),
    );
    const grid = sheetGrid();

    const stalePreview = await previewPayoutRun(
      ACTOR,
      { anchorMonth: "2026-07" },
      appDb(),
    );
    await expect(publishPayoutRunService(ACTOR, {
      anchorMonth: "2026-07",
      expectedVersion: stalePreview.run.version,
      previewToken: stalePreview.previewToken,
      acknowledgements: {
        confirmed: true,
        pendingReviewDeductions: 0,
        nonReadySessions: 0,
        reason: "This stale confirmation omits the unreconciled source rows.",
      },
    }, appDb(), {
      gateway: fakeGateway(grid).gateway,
      uploadCsv: uploadOk,
      resolveGoogleTarget: () => TEST_TARGET,
    })).rejects.toThrow(/counts do not match this preview/iu);
    expect(deductionRows(grid)).toHaveLength(0);

    const acknowledgedPreview = await previewPayoutRun(
      ACTOR,
      { anchorMonth: "2026-07" },
      appDb(),
    );
    const view = await publish(
      ACTOR,
      {
        anchorMonth: "2026-07",
        expectedVersion: 1,
        acknowledgements: {
          confirmed: true,
          pendingReviewDeductions: 0,
          nonReadySessions: 60,
          reason: "The source gap was independently reviewed.",
        },
      },
      appDb(),
      { gateway: fakeGateway(grid).gateway, uploadCsv: uploadOk },
    );
    expect(view.run.status).toBe("published");
    expect(deductionRows(grid)).toHaveLength(2);
    const acknowledgements = view.run.publishAcknowledgements;
    expect(acknowledgements).toMatchObject({
      confirmed: true,
      actorEmail: ACTOR.email,
      reason: "The source gap was independently reviewed.",
      pendingReviewDeductions: 0,
      nonReadySessions: 60,
      policyVersion: acknowledgedPreview.policyVersion,
      tutorFilter: null,
      previewToken: acknowledgedPreview.previewToken,
      coverage: {
        eligibleSessions: 62,
        readySessions: 2,
        nonReadySessions: 60,
      },
    });
  });

  it("does not write a deduction that was waived between passes", async () => {
    await seedTwoDeductionsAndMapping();
    const grid = sheetGrid();
    const [session] = await handle.db.select().from(schema.postClassSessions)
      .where(eq(schema.postClassSessions.wiseSessionId, "s-ada"));
    await handle.db.update(schema.postClassDeductions)
      .set({ status: "waived" })
      .where(eq(schema.postClassDeductions.sessionId, session.id));

    const view = await publish(
      ACTOR,
      { anchorMonth: "2026-07", expectedVersion: 1 },
      appDb(),
      { gateway: fakeGateway(grid).gateway, uploadCsv: uploadOk },
    );

    expect(view.lines).toHaveLength(1);
    expect(deductionRows(grid)).toHaveLength(1);
    expect(String(deductionRows(grid)[0][2])).toBe("Grace Hopper");
  });
});
