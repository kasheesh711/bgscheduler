/**
 * Publishing a payout run, end to end, against real Postgres and a fake sheet.
 *
 * The fake gateway holds a real grid and really splices on insert, so row
 * numbers shift exactly as they do in Sheets. What is being pinned here is the
 * property that matters most: pressing Publish twice must not pay a tutor
 * twice.
 *
 * `npm run test:integration` (Docker), or point at a scratch database with
 * TEST_DATABASE_URL.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { eq } from "drizzle-orm";
import { startTestDb, stopTestDb, truncateAll } from "@/tests/integration/db-helper";
import { publishPayoutRun, previewPayoutRun } from "@/lib/post-class-feedback/payout-run";
import { upsertTutorPayoutSheet } from "@/lib/post-class-feedback/payout-repository";
import { DEDUCTION_SESSION_NAME } from "@/lib/post-class-feedback/payout-sheet";
import type { PayoutSheetGateway } from "@/lib/post-class-feedback/payout-writer";
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

const HEADER = ["Date", "Time", "Duration", "Credits deducted", "Session name", "Student name", "Payout amount", "Notes"];

function sheetGrid(): unknown[][] {
  return [
    ["TUTOR", "Kevin"],
    ["START DATE", "26 Jun 2026"],
    ["END DATE", "25 Jul 2026"],
    [],
    [...HEADER],
    [dateSerial("2026-07-10"), timeSerial(3, 0), "60 mins", 1, "Math", "Grace Hopper", 700, ""],
    [dateSerial("2026-07-11"), timeSerial(3, 0), "60 mins", 1, "Math", "Ada Lovelace", 700, ""],
  ];
}

function fakeGateway(grid: unknown[][], options: { failInsertAt?: number } = {}) {
  const calls: string[] = [];
  const gateway: PayoutSheetGateway = {
    async readGrid() {
      calls.push("read");
      return grid.map((row) => [...row]);
    },
    async insertRow(_spreadsheetId, _sheetGid, afterRowNumber) {
      calls.push(`insert@${afterRowNumber}`);
      if (calls.filter((entry) => entry.startsWith("insert")).length === options.failInsertAt) {
        throw new Error("Google Sheets batch update failed (429)");
      }
      grid.splice(afterRowNumber, 0, []);
    },
    async updateRow(_spreadsheetId, _sheetName, rowNumber, values) {
      calls.push(`update@${rowNumber}`);
      grid[rowNumber - 1] = [...values];
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
  await upsertTutorPayoutSheet(appDb(), {
    canonicalKey: "kevin",
    spreadsheetId: "book-1",
    sheetName: "Kevin",
    sheetGid: 0,
    active: true,
    updatedByEmail: "admin@example.com",
  });
}

function deductionRows(grid: unknown[][]) {
  return grid.filter((row) => row[4] === DEDUCTION_SESSION_NAME);
}

const uploadOk = async () => ({ fileId: "file-1", webViewLink: "https://drive/file-1", name: "x.csv" });

describe("publishPayoutRun", () => {
  it("writes one deduction row beneath each matched class and publishes the run", async () => {
    await seedTwoDeductionsAndMapping();
    const grid = sheetGrid();
    const { gateway } = fakeGateway(grid);
    const preview = await previewPayoutRun(ACTOR, { anchorMonth: "2026-07" }, appDb());

    const view = await publishPayoutRun(
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
      expect(row[6]).toBe(-100);
      expect(String(row[7])).toContain("BGS-PAYOUT 2026-07");
    }
    // The classes keep their own earnings.
    expect(grid.filter((row) => row[6] === 700)).toHaveLength(2);
  });

  it("writes nothing on a second publish", async () => {
    await seedTwoDeductionsAndMapping();
    const grid = sheetGrid();
    const first = await publishPayoutRun(
      ACTOR,
      { anchorMonth: "2026-07", expectedVersion: 1 },
      appDb(),
      { gateway: fakeGateway(grid).gateway, uploadCsv: uploadOk },
    );
    expect(deductionRows(grid)).toHaveLength(2);

    const second = fakeGateway(grid);
    const view = await publishPayoutRun(
      ACTOR,
      { anchorMonth: "2026-07", expectedVersion: first.run.version },
      appDb(),
      { gateway: second.gateway, uploadCsv: uploadOk },
    );

    expect(deductionRows(grid)).toHaveLength(2);
    expect(second.calls.some((call) => call.startsWith("insert"))).toBe(false);
    expect(second.calls.some((call) => call.startsWith("update"))).toBe(false);
    expect(view.lines.every((line) => line.writeStatus === "written")).toBe(true);
  });

  it("retries only the failed line, and does not duplicate the one that succeeded", async () => {
    await seedTwoDeductionsAndMapping();
    const grid = sheetGrid();
    const first = await publishPayoutRun(
      ACTOR,
      { anchorMonth: "2026-07", expectedVersion: 1 },
      appDb(),
      { gateway: fakeGateway(grid, { failInsertAt: 1 }).gateway, uploadCsv: uploadOk },
    );
    expect(first.lines.filter((line) => line.writeStatus === "failed")).toHaveLength(1);
    expect(deductionRows(grid)).toHaveLength(1);

    const view = await publishPayoutRun(
      ACTOR,
      { anchorMonth: "2026-07", expectedVersion: first.run.version },
      appDb(),
      { gateway: fakeGateway(grid).gateway, uploadCsv: uploadOk },
    );

    expect(view.lines.every((line) => line.writeStatus === "written")).toBe(true);
    expect(deductionRows(grid)).toHaveLength(2);
  });

  it("skips a tutor with no mapped sheet instead of guessing a destination", async () => {
    await seedDeduction({
      wiseSessionId: "s-unmapped",
      endsAt: "2026-07-10T03:00:00.000Z",
      tutorKey: "mimi",
      student: "Grace Hopper",
    });
    const grid = sheetGrid();

    const view = await publishPayoutRun(
      ACTOR,
      { anchorMonth: "2026-07", expectedVersion: 1 },
      appDb(),
      { gateway: fakeGateway(grid).gateway, uploadCsv: uploadOk },
    );

    expect(view.lines[0].matchStatus).toBe("no_sheet");
    expect(view.lines[0].writeStatus).toBe("skipped");
    expect(view.lines[0].writeError).toContain("No payout sheet is mapped for mimi");
    expect(deductionRows(grid)).toHaveLength(0);
  });

  it("refuses a sheet that has been re-pointed to another month", async () => {
    await seedTwoDeductionsAndMapping();
    const grid = sheetGrid();
    grid[1] = ["START DATE", "26 Jul 2026"];
    grid[2] = ["END DATE", "25 Aug 2026"];

    const view = await publishPayoutRun(
      ACTOR,
      { anchorMonth: "2026-07", expectedVersion: 1 },
      appDb(),
      { gateway: fakeGateway(grid).gateway, uploadCsv: uploadOk },
    );

    expect(view.lines.every((line) => line.writeStatus === "skipped")).toBe(true);
    expect(view.lines[0].writeError).toContain("2026-07-26");
    expect(deductionRows(grid)).toHaveLength(0);
  });

  it("reports an unmatched deduction rather than writing it somewhere plausible", async () => {
    await seedDeduction({
      wiseSessionId: "s-missing",
      endsAt: "2026-07-20T03:00:00.000Z",
      tutorKey: "kevin",
      student: "Nobody At All",
    });
    await upsertTutorPayoutSheet(appDb(), {
      canonicalKey: "kevin",
      spreadsheetId: "book-1",
      sheetName: "Kevin",
      sheetGid: 0,
      active: true,
      updatedByEmail: "admin@example.com",
    });
    const grid = sheetGrid();

    const view = await publishPayoutRun(
      ACTOR,
      { anchorMonth: "2026-07", expectedVersion: 1 },
      appDb(),
      { gateway: fakeGateway(grid).gateway, uploadCsv: uploadOk },
    );

    expect(view.lines[0].matchStatus).toBe("unmatched");
    expect(deductionRows(grid)).toHaveLength(0);
  });

  it("stays published when the Drive upload fails, and records why", async () => {
    // The sheets are already money. A Drive failure must never make a run that
    // moved money look like one that did not.
    await seedTwoDeductionsAndMapping();
    const grid = sheetGrid();

    const view = await publishPayoutRun(
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

    await expect(publishPayoutRun(
      ACTOR,
      { anchorMonth: "2026-07", expectedVersion: 1 },
      appDb(),
      { gateway: fakeGateway(grid).gateway, uploadCsv: uploadOk },
    )).rejects.toThrow(/no trustworthy Wise evidence/u);
    expect(deductionRows(grid)).toHaveLength(0);

    const view = await publishPayoutRun(
      ACTOR,
      {
        anchorMonth: "2026-07",
        expectedVersion: 2,
        acknowledgements: { unavailableSessions: 60 },
      },
      appDb(),
      { gateway: fakeGateway(grid).gateway, uploadCsv: uploadOk },
    );
    expect(view.run.status).toBe("published");
    expect(deductionRows(grid)).toHaveLength(2);
  });

  it("does not write a deduction that was waived between passes", async () => {
    await seedTwoDeductionsAndMapping();
    const grid = sheetGrid();
    const [session] = await handle.db.select().from(schema.postClassSessions)
      .where(eq(schema.postClassSessions.wiseSessionId, "s-ada"));
    await handle.db.update(schema.postClassDeductions)
      .set({ status: "waived" })
      .where(eq(schema.postClassDeductions.sessionId, session.id));

    const view = await publishPayoutRun(
      ACTOR,
      { anchorMonth: "2026-07", expectedVersion: 1 },
      appDb(),
      { gateway: fakeGateway(grid).gateway, uploadCsv: uploadOk },
    );

    expect(view.lines).toHaveLength(1);
    expect(deductionRows(grid)).toHaveLength(1);
    expect(String(deductionRows(grid)[0][5])).toBe("Grace Hopper");
  });
});
