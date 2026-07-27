import { describe, expect, it } from "vitest";

import {
  assertPayoutRunPublishable,
  buildPayoutRunCsv,
  buildPayoutSheetRowValues,
  groupPayoutPlansBySheet,
  orderPayoutWritesBottomUp,
  payoutLineIdempotencyKey,
  payoutRowMarker,
  resolvePayoutRowAction,
  type PayoutRunCoverage,
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

/** Header on row 1, then three classes on rows 2-4. */
function grid(): unknown[][] {
  return [
    HEADER,
    [dateSerial("2026-07-25"), timeSerial(9, 30), "60 mins", 1, "On-site Session - Math", "Ada Lovelace", 700, ""],
    [dateSerial("2026-07-25"), timeSerial(6, 0), "60 mins", 1, "On-site Session - Math", "Grace Hopper", 700, ""],
    [dateSerial("2026-07-24"), timeSerial(2, 0), "60 mins", 1, "Online Session - Math", "Alan Turing", 700, ""],
  ];
}

const MARKER = payoutRowMarker({ anchorMonth: "2026-07", deductionId: "3f1c9a2b-1111-2222-3333-444455556666" });

function resolve(overrides: {
  grid?: unknown[][];
  marker?: string;
  scheduledStartAt?: Date;
  studentNames?: string[];
  claimedAnchorRows?: ReadonlySet<number>;
} = {}) {
  const raw = overrides.grid ?? grid();
  return resolvePayoutRowAction({
    grid: raw,
    table: parsePayoutSheet(raw)!,
    marker: overrides.marker ?? MARKER,
    scheduledStartAt: overrides.scheduledStartAt ?? new Date("2026-07-25T06:00:00.000Z"),
    studentNames: overrides.studentNames ?? ["Grace Hopper"],
    claimedAnchorRows: overrides.claimedAnchorRows,
  });
}

describe("payoutLineIdempotencyKey", () => {
  it("is deterministic for the same run and deduction", () => {
    const key = payoutLineIdempotencyKey({ runId: "run-1", deductionId: "ded-1" });
    expect(key).toBe("payout:run-1:ded-1");
    expect(payoutLineIdempotencyKey({ runId: "run-1", deductionId: "ded-1" })).toBe(key);
  });

  it("separates the same deduction across two runs", () => {
    expect(payoutLineIdempotencyKey({ runId: "run-1", deductionId: "ded-1" }))
      .not.toBe(payoutLineIdempotencyKey({ runId: "run-2", deductionId: "ded-1" }));
  });
});

describe("payoutRowMarker", () => {
  it("carries the payout month and a traceable deduction prefix", () => {
    expect(MARKER).toBe("BGS-PAYOUT 2026-07 3f1c9a2b");
  });

  it("differs per deduction and per month", () => {
    const other = payoutRowMarker({ anchorMonth: "2026-07", deductionId: "aaaaaaaa-1111-2222-3333-444455556666" });
    expect(other).not.toBe(MARKER);
    expect(payoutRowMarker({ anchorMonth: "2026-08", deductionId: "3f1c9a2b-1111-2222-3333-444455556666" }))
      .not.toBe(MARKER);
  });
});

describe("resolvePayoutRowAction", () => {
  it("plans an insert directly beneath the matched class", () => {
    expect(resolve()).toEqual({ kind: "insert", anchorRowNumber: 3, rowNumber: 4 });
  });

  it("treats a marker anywhere in the sheet as already written", () => {
    // The crash this covers: the sheet write landed, the database write did
    // not. Re-publishing must not write the row a second time.
    const raw = grid();
    raw.splice(3, 0, ["", "", "—", "—", DEDUCTION_SESSION_NAME, "Grace Hopper", -100, `Late · ${MARKER}`]);
    expect(resolve({ grid: raw })).toEqual({ kind: "already_written", rowNumber: 4 });
  });

  it("finds the marker even when the anchor has since moved", () => {
    const raw = grid();
    raw.splice(1, 0, [dateSerial("2026-07-26"), timeSerial(1, 0), "60 mins", 1, "New class", "Someone Else", 700, ""]);
    raw.splice(4, 0, ["", "", "—", "—", DEDUCTION_SESSION_NAME, "Grace Hopper", -100, MARKER]);
    expect(resolve({ grid: raw })).toEqual({ kind: "already_written", rowNumber: 5 });
  });

  it("reuses a blank row left by an insert that never got filled", () => {
    // The other half of the crash: insertDimension succeeded, values.update
    // did not. Inserting again would leave an orphan blank row and double the
    // deduction.
    const raw = grid();
    raw.splice(3, 0, []);
    expect(resolve({ grid: raw })).toEqual({ kind: "reuse_blank", anchorRowNumber: 3, rowNumber: 4 });
  });

  it("inserts when the row below the anchor is another deduction with a different marker", () => {
    const raw = grid();
    raw.splice(3, 0, ["", "", "—", "—", DEDUCTION_SESSION_NAME, "Grace Hopper", -100, "BGS-PAYOUT 2026-07 99999999"]);
    expect(resolve({ grid: raw })).toEqual({ kind: "insert", anchorRowNumber: 3, rowNumber: 4 });
  });

  it("reports unmatched when no row fits", () => {
    expect(resolve({ studentNames: ["Nobody At All"] })).toEqual({ kind: "unmatched" });
  });

  it("reports ambiguous on an exact tie inside the tolerance", () => {
    const raw = [
      HEADER,
      [dateSerial("2026-07-25"), timeSerial(5, 50), "60 mins", 1, "A", "Grace Hopper", 700, ""],
      [dateSerial("2026-07-25"), timeSerial(6, 10), "60 mins", 1, "B", "Grace Hopper", 700, ""],
    ];
    const action = resolve({ grid: raw });
    expect(action.kind).toBe("ambiguous");
  });

  it("takes the strictly nearest row when there is no tie", () => {
    const raw = [
      HEADER,
      [dateSerial("2026-07-25"), timeSerial(5, 56), "60 mins", 1, "A", "Grace Hopper", 700, ""],
      [dateSerial("2026-07-25"), timeSerial(6, 10), "60 mins", 1, "B", "Grace Hopper", 700, ""],
    ];
    expect(resolve({ grid: raw })).toEqual({ kind: "insert", anchorRowNumber: 2, rowNumber: 3 });
  });

  it("refuses to stack two deductions under one class row", () => {
    expect(resolve({ claimedAnchorRows: new Set([3]) }).kind).toBe("ambiguous");
  });
});

describe("buildPayoutSheetRowValues", () => {
  const values = buildPayoutSheetRowValues({
    anchorRow: grid()[2],
    studentName: "Grace Hopper",
    amountMinor: 10_000,
    reason: "No feedback submitted",
    deadlineAt: new Date("2026-07-26T17:00:00.000Z"),
    tutorSubmittedAt: null,
    marker: MARKER,
  });

  it("writes exactly the eight columns A..H", () => {
    expect(values).toHaveLength(8);
  });

  it("copies the anchor's date and time cells verbatim", () => {
    expect(values[0]).toBe(grid()[2][0]);
    expect(values[1]).toBe(grid()[2][1]);
  });

  it("writes the amount as a negative number, not a string", () => {
    // USER_ENTERED would re-parse a string, and text in a summed column is a
    // silent way to corrupt a payout total.
    expect(typeof values[6]).toBe("number");
    expect(values[6]).toBe(-100);
  });

  it("marks the row as a deduction and stamps it", () => {
    expect(values[4]).toBe(DEDUCTION_SESSION_NAME);
    expect(values[5]).toBe("Grace Hopper");
    expect(String(values[7])).toContain(MARKER);
    expect(String(values[7])).toContain("No feedback submitted");
  });

  it("says so explicitly when the tutor never submitted", () => {
    expect(String(values[7])).toContain("No tutor submission observed");
  });

  it("records a submission time in Bangkok when there is one", () => {
    const submitted = buildPayoutSheetRowValues({
      anchorRow: grid()[2],
      studentName: "Grace Hopper",
      amountMinor: 10_000,
      reason: "Late",
      deadlineAt: null,
      tutorSubmittedAt: new Date("2026-07-27T03:00:00.000Z"),
      marker: MARKER,
    });
    // 03:00Z is 10:00 in Bangkok.
    expect(String(submitted[7])).toContain("10:00");
  });

  it("negates an amount that is already negative rather than flipping it back", () => {
    const negative = buildPayoutSheetRowValues({
      anchorRow: grid()[2],
      studentName: "Grace Hopper",
      amountMinor: -10_000,
      reason: "Late",
      deadlineAt: null,
      tutorSubmittedAt: null,
      marker: MARKER,
    });
    expect(negative[6]).toBe(-100);
  });
});

describe("orderPayoutWritesBottomUp", () => {
  function plan(lineId: string, anchorRowNumber: number): PayoutWritePlan {
    return {
      lineId,
      deductionId: lineId,
      spreadsheetId: "sheet-1",
      sheetName: "Payouts",
      sheetGid: 0,
      anchorRowNumber,
      targetRowNumber: anchorRowNumber + 1,
      reuseBlankRow: false,
      values: [],
      marker: lineId,
    };
  }

  it("works downwards so an insert never moves a row still to be written", () => {
    const ordered = orderPayoutWritesBottomUp([plan("a", 9), plan("b", 40), plan("c", 22)]);
    expect(ordered.map((item) => item.anchorRowNumber)).toEqual([40, 22, 9]);
  });

  it("is deterministic when two plans share an anchor", () => {
    const ordered = orderPayoutWritesBottomUp([plan("z", 5), plan("a", 5)]);
    expect(ordered.map((item) => item.lineId)).toEqual(["a", "z"]);
  });

  it("does not mutate its input", () => {
    const input = [plan("a", 9), plan("b", 40)];
    orderPayoutWritesBottomUp(input);
    expect(input.map((item) => item.lineId)).toEqual(["a", "b"]);
  });
});

describe("groupPayoutPlansBySheet", () => {
  function plan(lineId: string, spreadsheetId: string, sheetName: string): PayoutWritePlan {
    return {
      lineId,
      deductionId: lineId,
      spreadsheetId,
      sheetName,
      sheetGid: 0,
      anchorRowNumber: 2,
      targetRowNumber: 3,
      reuseBlankRow: false,
      values: [],
      marker: lineId,
    };
  }

  it("keeps two tabs of one spreadsheet apart", () => {
    const grouped = groupPayoutPlansBySheet([
      plan("a", "book-1", "Kevin"),
      plan("b", "book-1", "Mimi"),
      plan("c", "book-1", "Kevin"),
    ]);
    expect(grouped.size).toBe(2);
    expect(grouped.get("book-1::Kevin")?.map((item) => item.lineId)).toEqual(["a", "c"]);
  });

  it("keeps the same tab name in different spreadsheets apart", () => {
    expect(groupPayoutPlansBySheet([
      plan("a", "book-1", "Payouts"),
      plan("b", "book-2", "Payouts"),
    ]).size).toBe(2);
  });
});

describe("assertPayoutRunPublishable", () => {
  function coverage(overrides: Partial<PayoutRunCoverage> = {}): PayoutRunCoverage {
    return {
      eligibleSessions: 1_000,
      readySessions: 1_000,
      unavailableSessions: 0,
      formDriftSessions: 0,
      identityReviewSessions: 0,
      pendingReviewDeductions: 0,
      approvedDeductions: 12,
      unmappedTutorKeys: [],
      nullTutorKeyLines: 0,
      blockingGlobalSourceIssues: 0,
      ...overrides,
    };
  }

  it("passes a clean run", () => {
    expect(() => assertPayoutRunPublishable(coverage())).not.toThrow();
  });

  it("blocks on an open global source issue regardless of acknowledgements", () => {
    expect(() => assertPayoutRunPublishable(
      coverage({ blockingGlobalSourceIssues: 1, pendingReviewDeductions: 3, unavailableSessions: 900 }),
      { pendingReviewDeductions: 3, unavailableSessions: 900 },
    )).toThrow(/Source health is unproven/u);
  });

  it("blocks while deductions are still awaiting review", () => {
    expect(() => assertPayoutRunPublishable(coverage({ pendingReviewDeductions: 4 })))
      .toThrow(/awaiting review/u);
  });

  it("accepts an acknowledgement that matches the count exactly", () => {
    expect(() => assertPayoutRunPublishable(
      coverage({ pendingReviewDeductions: 4 }),
      { pendingReviewDeductions: 4 },
    )).not.toThrow();
  });

  it("rejects a stale acknowledgement", () => {
    // The operator approved 4; 6 are pending now. Publishing would quietly
    // include two nobody looked at.
    expect(() => assertPayoutRunPublishable(
      coverage({ pendingReviewDeductions: 6 }),
      { pendingReviewDeductions: 4 },
    )).toThrow(/awaiting review/u);
  });

  it("blocks when the window is materially unreconciled", () => {
    expect(() => assertPayoutRunPublishable(
      coverage({ eligibleSessions: 1_304, unavailableSessions: 1_271 }),
    )).toThrow(/no trustworthy Wise evidence/u);
  });

  it("tolerates a negligible unreconciled tail", () => {
    expect(() => assertPayoutRunPublishable(
      coverage({ eligibleSessions: 1_000, unavailableSessions: 10 }),
    )).not.toThrow();
  });

  it("lets an operator publish an unreconciled window by acknowledging the exact count", () => {
    expect(() => assertPayoutRunPublishable(
      coverage({ eligibleSessions: 1_304, unavailableSessions: 1_271 }),
      { unavailableSessions: 1_271 },
    )).not.toThrow();
  });

  it("does not divide by zero on an empty window", () => {
    expect(() => assertPayoutRunPublishable(
      coverage({ eligibleSessions: 0, unavailableSessions: 0, approvedDeductions: 0 }),
    )).not.toThrow();
  });
});

describe("buildPayoutRunCsv", () => {
  const header = { anchorMonth: "2026-07", windowStart: "2026-06-26", windowEnd: "2026-07-25" };

  function line(overrides: Partial<Parameters<typeof buildPayoutRunCsv>[1][number]> = {}) {
    return {
      canonicalTutorKey: "Kevin",
      tutorName: "Kevin Hsieh",
      wiseSessionId: "sess-1",
      className: "Math",
      studentNames: ["Grace Hopper"],
      scheduledStartAt: new Date("2026-07-25T06:00:00.000Z"),
      scheduledEndAt: new Date("2026-07-25T07:00:00.000Z"),
      deadlineAt: new Date("2026-07-26T17:00:00.000Z"),
      tutorSubmittedAt: null,
      amountMinor: 10_000,
      currency: "THB",
      financeMonth: "2026-07",
      reason: "No feedback submitted",
      spreadsheetId: "book-1",
      sheetName: "Kevin",
      matchedRowNumber: 12,
      insertedRowNumber: 13,
      matchStatus: "matched",
      writeStatus: "written",
      writeError: null,
      writtenAt: new Date("2026-07-27T04:00:00.000Z"),
      ...overrides,
    };
  }

  it("writes a header row followed by one row per line", () => {
    const csv = buildPayoutRunCsv(header, [line(), line({ wiseSessionId: "sess-2" })]);
    expect(csv.split("\r\n")).toHaveLength(3);
    expect(csv).toContain('"Payout month"');
    expect(csv).toContain('"Deduction"');
  });

  it("records the deduction as a negative amount", () => {
    expect(buildPayoutRunCsv(header, [line()])).toContain('"-100"');
  });

  it("formats timestamps in Bangkok, not UTC", () => {
    // 06:00Z is 13:00 in Bangkok. A UTC rendering here would misinform finance.
    const csv = buildPayoutRunCsv(header, [line()]);
    expect(csv).toContain("13:00");
  });

  it("keeps skipped and unmapped lines so an absence is distinguishable", () => {
    const csv = buildPayoutRunCsv(header, [
      line({ matchStatus: "no_sheet", writeStatus: "skipped", spreadsheetId: null, sheetName: null }),
      line({ matchStatus: "unmatched", writeStatus: "skipped", wiseSessionId: "sess-3" }),
      line({ writeStatus: "failed", writeError: "Google Sheets batch update failed (429)" }),
    ]);
    expect(csv.split("\r\n")).toHaveLength(4);
    expect(csv).toContain('"no_sheet"');
    expect(csv).toContain('"unmatched"');
    expect(csv).toContain("429");
  });

  it("starts with a UTF-8 BOM so Excel reads Thai names correctly", () => {
    expect(buildPayoutRunCsv(header, [line()]).startsWith("﻿")).toBe(true);
  });
});
