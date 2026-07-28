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
import { publishPayoutRun, previewPayoutRun } from "@/lib/post-class-feedback/payout-run";
import { upsertPayoutTutorName } from "@/lib/post-class-feedback/payout-repository";
import { DEDUCTION_SESSION_NAME } from "@/lib/post-class-feedback/payout-master";
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
    async readGrid() {
      calls.push("read");
      return grid.map((row) => [...row]);
    },
    async appendRow(row) {
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
    onsiteName: KEVIN,
    onlineName: KEVIN_ONLINE,
    active: true,
    updatedByEmail: "admin@example.com",
  });
}

function deductionRows(grid: unknown[][]) {
  // Session name is column B in the ledger, and carries the marker after it.
  return grid.filter((row) => String(row[1] ?? "").startsWith(DEDUCTION_SESSION_NAME));
}

const uploadOk = async () => ({ fileId: "file-1", webViewLink: "https://drive/file-1", name: "x.csv" });

describe("publishPayoutRun", () => {
  it("appends one ledger row per deduction and publishes the run", async () => {
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
      expect(row[7]).toBe(-100);
      expect(String(row[1])).toContain("BGS-PAYOUT 2026-07");
      // Attributed to one of this tutor's ledger identities, never another's.
      expect([KEVIN, KEVIN_ONLINE]).toContain(row[0]);
    }
    // Every original class row keeps its own earnings, and nothing shifted.
    expect(grid.filter((row) => row[7] === 700)).toHaveLength(3);
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
    expect(second.calls.some((call) => call.startsWith("append"))).toBe(false);
    expect(second.calls.includes("append#1")).toBe(false);
    expect(view.lines.every((line) => line.writeStatus === "written")).toBe(true);
  });

  it("retries only the failed line, and does not duplicate the one that succeeded", async () => {
    await seedTwoDeductionsAndMapping();
    const grid = sheetGrid();
    const first = await publishPayoutRun(
      ACTOR,
      { anchorMonth: "2026-07", expectedVersion: 1 },
      appDb(),
      { gateway: fakeGateway(grid, { failAppendAt: 1 }).gateway, uploadCsv: uploadOk },
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

  it("skips a tutor with no mapped ledger identity instead of guessing one", async () => {
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
    expect(view.lines[0].writeError).toContain("No ledger name is mapped for mimi");
    expect(deductionRows(grid)).toHaveLength(0);
  });

  it("refuses a ledger whose columns have moved", async () => {
    // A reordered re-paste must be detected, not appended to under the wrong
    // headings — that is how a deduction ends up in the wrong column entirely.
    await seedTwoDeductionsAndMapping();
    const grid = sheetGrid();
    grid[0] = ["Date", "Teacher name", "Session name", "Course name", "Time", "Duration", "Credits deducted", "Payout amount"];

    const view = await publishPayoutRun(
      ACTOR,
      { anchorMonth: "2026-07", expectedVersion: 1 },
      appDb(),
      { gateway: fakeGateway(grid).gateway, uploadCsv: uploadOk },
    );

    expect(view.lines.every((line) => line.writeStatus === "skipped")).toBe(true);
    expect(view.lines[0].writeError).toContain("columns are not where they are expected");
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
      onsiteName: KEVIN,
      onlineName: KEVIN_ONLINE,
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
    expect(String(deductionRows(grid)[0][2])).toBe("Grace Hopper");
  });
});
