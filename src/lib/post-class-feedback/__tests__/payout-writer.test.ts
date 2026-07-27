import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createPayoutRateGate,
  writePayoutSheetPlans,
  type PayoutSheetGateway,
  type PayoutWriteOutcome,
} from "../payout-writer";
import {
  buildPayoutSheetRowValues,
  groupPayoutPlansBySheet,
  orderPayoutWritesBottomUp,
  payoutRowMarker,
  resolvePayoutRowAction,
  type PayoutWritePlan,
} from "../payout-plan";
import { DEDUCTION_SESSION_NAME, parsePayoutSheet } from "../payout-sheet";

function dateSerial(iso: string): number {
  return Math.round(Date.parse(`${iso}T00:00:00.000Z`) / 86_400_000) + 25569;
}
function timeSerial(hours: number, minutes: number): number {
  return (hours * 60 + minutes) / 1440;
}

const HEADER = ["Date", "Time", "Duration", "Credits deducted", "Session name", "Student name", "Payout amount", "Notes"];
const STUDENTS = ["Ada Lovelace", "Grace Hopper", "Alan Turing"];

/** Header on row 1, three classes on rows 2-4. */
function initialGrid(): unknown[][] {
  return [
    [...HEADER],
    [dateSerial("2026-07-25"), timeSerial(9, 30), "60 mins", 1, "Class A", STUDENTS[0], 700, ""],
    [dateSerial("2026-07-25"), timeSerial(6, 0), "60 mins", 1, "Class B", STUDENTS[1], 700, ""],
    [dateSerial("2026-07-24"), timeSerial(2, 0), "60 mins", 1, "Class C", STUDENTS[2], 700, ""],
  ];
}

/**
 * A gateway over a real in-memory grid: `insertRow` actually splices, so row
 * numbers shift underneath the caller exactly as they do in Sheets.
 */
function fakeGateway(grid: unknown[][], options: { failOnCall?: number; throwBetween?: number } = {}) {
  let calls = 0;
  const gateway: PayoutSheetGateway = {
    async readGrid() {
      return grid.map((row) => [...row]);
    },
    async insertRow(_spreadsheetId, _sheetGid, afterRowNumber) {
      calls += 1;
      if (calls === options.failOnCall) throw new Error(`insert failed on call ${calls}`);
      grid.splice(afterRowNumber, 0, []);
      if (calls === options.throwBetween) throw new Error("crashed after insert, before update");
    },
    async updateRow(_spreadsheetId, _sheetName, rowNumber, values) {
      calls += 1;
      if (calls === options.failOnCall) throw new Error(`update failed on call ${calls}`);
      grid[rowNumber - 1] = [...values];
    },
  };
  return { gateway, callCount: () => calls };
}

const MARKERS = STUDENTS.map((_, index) =>
  payoutRowMarker({ anchorMonth: "2026-07", deductionId: `0000000${index}-1111-2222-3333-444455556666` }));

const CLASS_STARTS = [
  new Date("2026-07-25T09:30:00.000Z"),
  new Date("2026-07-25T06:00:00.000Z"),
  new Date("2026-07-24T02:00:00.000Z"),
];

/**
 * Plan every student's deduction against a freshly read grid.
 *
 * `attempted` stands in for the line state the orchestrator carries: a line the
 * database has seen fail before may reuse a blank row, a fresh one may not.
 */
function planAll(grid: unknown[][], attempted: ReadonlySet<string> = new Set()): PayoutWritePlan[] {
  const table = parsePayoutSheet(grid)!;
  const claimed = new Set<number>();
  const plans: PayoutWritePlan[] = [];
  for (const [index, student] of STUDENTS.entries()) {
    const action = resolvePayoutRowAction({
      grid,
      table,
      marker: MARKERS[index],
      scheduledStartAt: CLASS_STARTS[index],
      studentNames: [student],
      claimedAnchorRows: claimed,
      previouslyAttempted: attempted.has(`line-${index}`),
    });
    if (action.kind !== "insert" && action.kind !== "reuse_blank") continue;
    claimed.add(action.anchorRowNumber);
    plans.push({
      lineId: `line-${index}`,
      deductionId: `ded-${index}`,
      spreadsheetId: "book-1",
      sheetName: "Payouts",
      sheetGid: 0,
      anchorRowNumber: action.anchorRowNumber,
      targetRowNumber: action.rowNumber,
      reuseBlankRow: action.kind === "reuse_blank",
      values: buildPayoutSheetRowValues({
        anchorRow: grid[action.anchorRowNumber - 1],
        studentName: student,
        amountMinor: 10_000,
        reason: "No feedback submitted",
        deadlineAt: null,
        tutorSubmittedAt: null,
        marker: MARKERS[index],
      }),
      marker: MARKERS[index],
    });
  }
  return orderPayoutWritesBottomUp(plans);
}

async function runPass(
  grid: unknown[][],
  options: { failOnCall?: number; throwBetween?: number; attempted?: ReadonlySet<string> } = {},
) {
  const plans = planAll(grid, options.attempted);
  const { gateway } = fakeGateway(grid, options);
  const outcomes: PayoutWriteOutcome[] = [];
  const result = await writePayoutSheetPlans({
    gateway,
    plansBySheet: groupPayoutPlansBySheet(plans),
    onOutcome: async (outcome) => { outcomes.push(outcome); },
  });
  return { plans, outcomes, result };
}

function deductionRows(grid: unknown[][]) {
  return grid.filter((row) => row[4] === DEDUCTION_SESSION_NAME);
}

describe("writePayoutSheetPlans", () => {
  it("puts each deduction directly beneath its own class and leaves the class untouched", async () => {
    const grid = initialGrid();
    const before = initialGrid();
    const { outcomes } = await runPass(grid);

    expect(outcomes.every((outcome) => outcome.status === "written")).toBe(true);
    expect(deductionRows(grid)).toHaveLength(3);
    for (let index = 0; index < STUDENTS.length; index += 1) {
      const classRowIndex = grid.findIndex((row) => row[4] === `Class ${"ABC"[index]}`);
      expect(grid[classRowIndex + 1][4]).toBe(DEDUCTION_SESSION_NAME);
      expect(grid[classRowIndex + 1][5]).toBe(STUDENTS[index]);
      expect(grid[classRowIndex + 1][6]).toBe(-100);
      // The class row's own earnings must survive intact.
      expect(grid[classRowIndex][6]).toBe(700);
    }
    // Every original row is still present and unmodified.
    for (const row of before) {
      expect(grid.some((candidate) => JSON.stringify(candidate) === JSON.stringify(row))).toBe(true);
    }
  });

  it("marks the failing line and keeps going", async () => {
    const grid = initialGrid();
    // Calls run insert,update,insert,update,... so call 4 is the second line's
    // update — after its row has already been inserted.
    const { outcomes } = await runPass(grid, { failOnCall: 4 });

    expect(outcomes.filter((outcome) => outcome.status === "written")).toHaveLength(2);
    const failed = outcomes.filter((outcome) => outcome.status === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toContain("update failed");
    // The failed insert left exactly one blank row behind.
    expect(grid.filter((row) => row.length === 0)).toHaveLength(1);
  });

  it("reuses the blank row on a retry instead of inserting a second one", async () => {
    // The single most important behaviour here: an interrupted pass must not
    // cost the tutor two deductions for one class.
    const grid = initialGrid();
    await runPass(grid, { failOnCall: 4 });
    expect(deductionRows(grid)).toHaveLength(2);

    const { outcomes } = await runPass(grid, { attempted: new Set(["line-1"]) });

    expect(outcomes.every((outcome) => outcome.status === "written")).toBe(true);
    expect(deductionRows(grid)).toHaveLength(3);
    expect(grid.filter((row) => row.length === 0)).toHaveLength(0);
  });

  it("recovers when the process dies between the insert and the update", async () => {
    const grid = initialGrid();
    await runPass(grid, { throwBetween: 1 });
    expect(grid.filter((row) => row.length === 0)).toHaveLength(1);

    const { outcomes } = await runPass(grid, { attempted: new Set(["line-2"]) });

    expect(outcomes.every((outcome) => outcome.status === "written")).toBe(true);
    expect(deductionRows(grid)).toHaveLength(3);
  });

  it("writes nothing on a second pass over a finished sheet", async () => {
    const grid = initialGrid();
    await runPass(grid);

    const { plans, outcomes } = await runPass(grid);

    expect(plans).toHaveLength(0);
    expect(outcomes).toHaveLength(0);
    expect(deductionRows(grid)).toHaveLength(3);
  });

  it("persists each outcome as it happens rather than at the end", async () => {
    const grid = initialGrid();
    const plans = planAll(grid);
    const { gateway } = fakeGateway(grid);
    const seen: string[] = [];
    await writePayoutSheetPlans({
      gateway,
      plansBySheet: groupPayoutPlansBySheet(plans),
      onOutcome: async (outcome) => { seen.push(outcome.lineId); },
    });
    // A crash after the second line must leave the first two recorded.
    expect(seen).toHaveLength(3);
  });

  it("stops cleanly at its deadline and reports it", async () => {
    const grid = initialGrid();
    const plans = planAll(grid);
    const { gateway, callCount } = fakeGateway(grid);
    let ticks = 0;
    const result = await writePayoutSheetPlans({
      gateway,
      plansBySheet: groupPayoutPlansBySheet(plans),
      onOutcome: async () => undefined,
      deadlineAt: 100,
      // First check is inside the budget, the next is past it.
      clock: () => (ticks++ === 0 ? 0 : 1_000),
    });

    expect(result.stoppedEarly).toBe(true);
    expect(result.outcomes).toHaveLength(1);
    // The unwritten lines cost no Google calls at all.
    expect(callCount()).toBe(2);
  });

  it("skips the insert for a plan that is reusing a blank row", async () => {
    const grid = initialGrid();
    grid.splice(3, 0, []);
    const plans = planAll(grid, new Set(["line-1"]));
    expect(plans.some((plan) => plan.reuseBlankRow)).toBe(true);

    const inserted: number[] = [];
    const { gateway } = fakeGateway(grid);
    const spy: PayoutSheetGateway = {
      ...gateway,
      insertRow: async (spreadsheetId, sheetGid, afterRowNumber) => {
        inserted.push(afterRowNumber);
        return gateway.insertRow(spreadsheetId, sheetGid, afterRowNumber);
      },
    };
    await writePayoutSheetPlans({
      gateway: spy,
      plansBySheet: groupPayoutPlansBySheet(plans),
      onOutcome: async () => undefined,
    });

    expect(inserted).toHaveLength(plans.length - 1);
  });
});

describe("createPayoutRateGate", () => {
  it("spaces calls by the configured interval", async () => {
    vi.useFakeTimers();
    try {
      const gate = createPayoutRateGate(1_000);
      await gate();
      let resolved = false;
      const pending = gate().then(() => { resolved = true; });
      await vi.advanceTimersByTimeAsync(999);
      expect(resolved).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
