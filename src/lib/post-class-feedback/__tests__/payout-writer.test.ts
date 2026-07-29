import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  appendMasterDeductions,
  assertPayoutRollFitsLease,
  createPayoutMaintenanceRateGate,
  createPayoutRateGate,
  createPayoutRollRateGate,
  DuplicatePayoutAppendSignatureError,
  PAYOUT_GOOGLE_MAINTENANCE_MIN_INTERVAL_MS,
  PAYOUT_GOOGLE_ROLL_MIN_INTERVAL_MS,
  type MasterAppendOutcome,
  type MasterAppendPlan,
  type MasterLedgerGateway,
} from "../payout-writer";
import {
  buildMasterDeductionRow,
  collectMasterMarkers,
  parseMasterPayoutSheet,
  payoutRowMarker,
} from "../payout-master";

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

function ledger(): unknown[][] {
  return [
    [...HEADER],
    [KEVIN, "On-site Session - Math", "Grace Hopper", dateSerial("2026-07-25"), timeSerial(6, 0), "60 mins", 1, 700],
    [KEVIN, "On-site Session - Science", "Ada Lovelace", dateSerial("2026-07-24"), timeSerial(9, 30), "60 mins", 1, 700],
  ];
}

/** An in-memory ledger that really grows on append, as Sheets does. */
function fakeGateway(grid: unknown[][], options: { failOnCall?: number } = {}) {
  let calls = 0;
  const gateway: MasterLedgerGateway = {
    async readRawGrid() {
      return grid.map((row) => [...row]);
    },
    async readDeductionGrid() {
      return grid.map((row) => [...row]);
    },
    async appendDeductionRow(row: Array<string | number>) {
      calls += 1;
      if (calls === options.failOnCall) throw new Error("Google Sheets append failed (429)");
      grid.push([...row]);
      return { rowNumber: grid.length };
    },
  };
  return { gateway, callCount: () => calls };
}

function planFor(grid: unknown[][], student: string, deductionId: string): MasterAppendPlan {
  const table = parseMasterPayoutSheet(grid)!;
  const anchor = table.rows.find((row) => row.studentName === student)!;
  const marker = payoutRowMarker({ anchorMonth: "2026-07", deductionId });
  return {
    lineId: `line-${student}`,
    sourceType: "deduction",
    sourceId: deductionId,
    marker,
    row: buildMasterDeductionRow({ anchor, amountMinor: 10_000, marker }),
  };
}

async function run(grid: unknown[][], plans: MasterAppendPlan[], options: { failOnCall?: number } = {}) {
  const { gateway, callCount } = fakeGateway(grid, options);
  const outcomes: MasterAppendOutcome[] = [];
  const result = await appendMasterDeductions({
    gateway,
    plans,
    onOutcome: async (outcome) => { outcomes.push(outcome); },
  });
  return { outcomes, result, callCount };
}

describe("appendMasterDeductions", () => {
  it("appends one ledger row per deduction and leaves every existing row untouched", async () => {
    const grid = ledger();
    const before = ledger();
    const plans = [
      planFor(grid, "Grace Hopper", "aaaaaaaa-1111-2222-3333-444455556666"),
      planFor(grid, "Ada Lovelace", "bbbbbbbb-1111-2222-3333-444455556666"),
    ];

    const { outcomes } = await run(grid, plans);

    expect(outcomes.every((outcome) => outcome.status === "written")).toBe(true);
    expect(grid).toHaveLength(5);
    // Nothing shifted: the original rows are exactly where they were.
    before.forEach((row, index) => expect(grid[index]).toEqual(row));
    expect(outcomes.map((outcome) => outcome.rowNumber)).toEqual([4, 5]);
  });

  it("attributes each deduction to its anchor's tutor and keeps the amount negative", async () => {
    const grid = ledger();
    await run(grid, [planFor(grid, "Grace Hopper", "aaaaaaaa-1111-2222-3333-444455556666")]);

    const appended = grid[3];
    expect(appended[0]).toBe(KEVIN);
    expect(appended[2]).toBe("Grace Hopper");
    expect(appended[7]).toBe(-100);
    // Typed exactly like the column it joins, so QUERY cannot drop it.
    expect(typeof appended[3]).toBe("number");
    expect(typeof appended[4]).toBe("number");
  });

  it("marks the failing line and keeps going", async () => {
    const grid = ledger();
    const plans = [
      planFor(grid, "Grace Hopper", "aaaaaaaa-1111-2222-3333-444455556666"),
      planFor(grid, "Ada Lovelace", "bbbbbbbb-1111-2222-3333-444455556666"),
    ];

    const { outcomes } = await run(grid, plans, { failOnCall: 1 });

    expect(outcomes[0].status).toBe("failed");
    expect(outcomes[0].error).toContain("429");
    expect(outcomes[1].status).toBe("written");
    // Three original rows plus the one that succeeded. The failed append left
    // nothing behind at all — no half-written row, nothing to clean up, which
    // is the whole reason appending beats inserting here.
    expect(grid).toHaveLength(4);
    expect(grid[3][2]).toBe("Ada Lovelace");
  });

  it("leaves a re-runnable state: the marker of a failed line is absent from the ledger", async () => {
    const grid = ledger();
    const plans = [planFor(grid, "Grace Hopper", "aaaaaaaa-1111-2222-3333-444455556666")];
    await run(grid, plans, { failOnCall: 1 });

    const markers = collectMasterMarkers(parseMasterPayoutSheet(grid)!);
    expect(markers.has(plans[0].marker)).toBe(false);

    // Re-running writes it, and the marker is then findable.
    await run(grid, plans);
    expect(collectMasterMarkers(parseMasterPayoutSheet(grid)!).has(plans[0].marker)).toBe(true);
  });

  it("persists each outcome as it happens rather than at the end", async () => {
    const grid = ledger();
    const plans = [
      planFor(grid, "Grace Hopper", "aaaaaaaa-1111-2222-3333-444455556666"),
      planFor(grid, "Ada Lovelace", "bbbbbbbb-1111-2222-3333-444455556666"),
    ];
    const seen: string[] = [];
    const { gateway } = fakeGateway(grid);
    await appendMasterDeductions({
      gateway,
      plans,
      onOutcome: async (outcome) => { seen.push(`${outcome.lineId}:${outcome.status}`); },
    });
    // A crash after the first append must leave the first line recorded.
    expect(seen).toEqual(["line-Grace Hopper:written", "line-Ada Lovelace:written"]);
  });

  it("stops cleanly at its deadline without spending a call on the rest", async () => {
    const grid = ledger();
    const plans = [
      planFor(grid, "Grace Hopper", "aaaaaaaa-1111-2222-3333-444455556666"),
      planFor(grid, "Ada Lovelace", "bbbbbbbb-1111-2222-3333-444455556666"),
    ];
    const { gateway, callCount } = fakeGateway(grid);
    let ticks = 0;
    const result = await appendMasterDeductions({
      gateway,
      plans,
      onOutcome: async () => undefined,
      deadlineAt: 100,
      clock: () => (ticks++ === 0 ? 0 : 1_000),
    });

    expect(result.stoppedEarly).toBe(true);
    expect(result.outcomes).toHaveLength(1);
    expect(callCount()).toBe(1);
  });

  it("rejects duplicate planned signatures before the first append", async () => {
    const grid = ledger();
    const first = planFor(
      grid,
      "Grace Hopper",
      "aaaaaaaa-1111-2222-3333-444455556666",
    );
    const duplicate = { ...first, lineId: "line-duplicate", sourceId: "other" };
    const { gateway, callCount } = fakeGateway(grid);
    await expect(appendMasterDeductions({
      gateway,
      plans: [first, duplicate],
      onOutcome: async () => undefined,
    })).rejects.toBeInstanceOf(DuplicatePayoutAppendSignatureError);
    expect(callCount()).toBe(0);
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

  it("reserves shared-account quota headroom for fleet maintenance", async () => {
    vi.useFakeTimers();
    try {
      const gate = createPayoutMaintenanceRateGate();
      await gate();
      let resolved = false;
      const pending = gate().then(() => { resolved = true; });
      await vi.advanceTimersByTimeAsync(
        PAYOUT_GOOGLE_MAINTENANCE_MIN_INTERVAL_MS - 1,
      );
      expect(resolved).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("spaces calls by the lease-bound date-roll interval", async () => {
    vi.useFakeTimers();
    try {
      const gate = createPayoutRollRateGate();
      await gate();
      let resolved = false;
      const pending = gate().then(() => { resolved = true; });
      await vi.advanceTimersByTimeAsync(PAYOUT_GOOGLE_ROLL_MIN_INTERVAL_MS - 1);
      expect(resolved).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a date-roll fleet that cannot fit the durable lease", () => {
    expect(assertPayoutRollFitsLease(68, 15 * 60 * 1_000)).toEqual({
      pacedCallCount: 476,
      minimumPacedDurationMs: 712_500,
      safetyMarginMs: 187_500,
    });
    expect(() => assertPayoutRollFitsLease(
      75,
      15 * 60 * 1_000,
    )).toThrow(/cannot fit/);
  });
});
