import { describe, expect, it } from "vitest";
import {
  DEDUCTION_SESSION_NAME,
  matchPayoutRow,
  normalizeStudentName,
  parsePayoutSheet,
  serialToUtc,
} from "../payout-sheet";

// Google serial for a UTC date: days since 1899-12-30.
function dateSerial(iso: string): number {
  return Math.round(Date.parse(`${iso}T00:00:00.000Z`) / 86_400_000) + 25569;
}
// Time-of-day as a day fraction.
function timeSerial(hours: number, minutes: number): number {
  return (hours * 60 + minutes) / 1440;
}

/**
 * The real payout sheet shape: preamble rows, a header on row 8, then data.
 * Times are UTC and match `scheduled_start_at` exactly — verified against
 * production for 25 Jul 2026.
 */
function realSheet(): unknown[][] {
  return [
    [],
    ["TUTOR", "Kevin (Kev) Y. Hsieh", "", "Tier 1", "Paid on 25th"],
    ["", "Kevin (Kev) Y. Hsieh Online"],
    ["START DATE", "26 Jun 2026"],
    ["END DATE", "25 Jul 2026"],
    ["TOTAL PAYOUTS", 48640],
    [],
    ["Date", "Time", "Duration", "Credits deducted", "Session name", "Student name", "Payout amount"],
    [dateSerial("2026-07-25"), timeSerial(9, 30), "60 mins", 0, "On-site Session - Math (Cancelled)", "Thanasate (ThunThun.Su) Supsinburana", 0],
    [dateSerial("2026-07-25"), timeSerial(6, 0), "60 mins", 1, "On-site Session - Math", "Norraphat (Him.Vi) Viriyarojanakul", 700],
    [dateSerial("2026-07-25"), timeSerial(2, 0), "60 mins", 0, "On-site Session - Math (Cancelled)", "Kanchananat (Vanille.Ya) Yaemsahnguan", 0],
    // A live session logging its ACTUAL start: scheduled 10:30, sheet 10:26.
    [dateSerial("2026-07-25"), timeSerial(10, 26), "36 mins", 1, "Online Session - Math", "Cheyenne (Chey.Hu) Huang", 700],
  ];
}

describe("serialToUtc", () => {
  it("converts a Google serial date and time to a UTC instant", () => {
    expect(serialToUtc(dateSerial("2026-07-25"), timeSerial(6, 0))?.toISOString())
      .toBe("2026-07-25T06:00:00.000Z");
  });

  it("reads the time from the date cell's own fraction when no time cell exists", () => {
    const combined = dateSerial("2026-07-25") + timeSerial(9, 30);
    expect(serialToUtc(combined, null)?.toISOString()).toBe("2026-07-25T09:30:00.000Z");
  });

  it("returns null for a blank or non-numeric date", () => {
    expect(serialToUtc(null, null)).toBeNull();
    expect(serialToUtc("", null)).toBeNull();
    expect(serialToUtc("not a date", null)).toBeNull();
  });
});

describe("parsePayoutSheet", () => {
  it("finds the header row and reads the data rows beneath it", () => {
    const table = parsePayoutSheet(realSheet());
    expect(table).not.toBeNull();
    expect(table!.headerRowNumber).toBe(8);
    expect(table!.rows).toHaveLength(4);
    const first = table!.rows[0];
    expect(first.rowNumber).toBe(9);
    expect(first.startAt?.toISOString()).toBe("2026-07-25T09:30:00.000Z");
    expect(first.studentName).toBe("Thanasate (ThunThun.Su) Supsinburana");
    expect(first.payoutAmount).toBe(0);
  });

  it("refuses a sheet whose shape it does not recognise", () => {
    // Never write to a sheet we cannot positively identify.
    expect(parsePayoutSheet([["Something", "else"], [1, 2]])).toBeNull();
    expect(parsePayoutSheet([])).toBeNull();
  });
});

describe("matchPayoutRow", () => {
  const table = parsePayoutSheet(realSheet())!;

  it("matches an exact date, student and start time", () => {
    const result = matchPayoutRow({
      table,
      scheduledStartAt: new Date("2026-07-25T06:00:00.000Z"),
      studentNames: ["Norraphat (Him.Vi) Viriyarojanakul"],
    });
    expect(result.status).toBe("matched");
    expect(result.row?.rowNumber).toBe(10);
    expect(result.row?.payoutAmount).toBe(700);
  });

  it("matches a live session whose sheet row logs the actual start", () => {
    // Scheduled 10:30, sheet says 10:26 — 4 minutes inside tolerance.
    const result = matchPayoutRow({
      table,
      scheduledStartAt: new Date("2026-07-25T10:30:00.000Z"),
      studentNames: ["Cheyenne (Chey.Hu) Huang"],
    });
    expect(result.status).toBe("matched");
    expect(result.row?.rowNumber).toBe(12);
  });

  it("does not match outside the tolerance window", () => {
    const result = matchPayoutRow({
      table,
      scheduledStartAt: new Date("2026-07-25T11:00:00.000Z"),
      studentNames: ["Cheyenne (Chey.Hu) Huang"],
    });
    expect(result.status).toBe("unmatched");
    expect(result.row).toBeNull();
  });

  it("does not match a different student at the same time", () => {
    const result = matchPayoutRow({
      table,
      scheduledStartAt: new Date("2026-07-25T06:00:00.000Z"),
      studentNames: ["Someone Else"],
    });
    expect(result.status).toBe("unmatched");
  });

  it("does not match the same time on a different day", () => {
    const result = matchPayoutRow({
      table,
      scheduledStartAt: new Date("2026-07-24T06:00:00.000Z"),
      studentNames: ["Norraphat (Him.Vi) Viriyarojanakul"],
    });
    expect(result.status).toBe("unmatched");
  });

  it("ignores case and spacing in the student name", () => {
    const result = matchPayoutRow({
      table,
      scheduledStartAt: new Date("2026-07-25T06:00:00.000Z"),
      studentNames: ["  norraphat   (Him.Vi)   VIRIYAROJANAKUL "],
    });
    expect(result.status).toBe("matched");
  });

  it("reports ambiguous when two rows tie inside the tolerance", () => {
    const ambiguous = parsePayoutSheet([
      ["Date", "Time", "Duration", "Credits deducted", "Session name", "Student name", "Payout amount"],
      [dateSerial("2026-07-25"), timeSerial(5, 55), "60 mins", 1, "A", "Twin Student", 700],
      [dateSerial("2026-07-25"), timeSerial(6, 5), "60 mins", 1, "B", "Twin Student", 700],
    ])!;
    const result = matchPayoutRow({
      table: ambiguous,
      scheduledStartAt: new Date("2026-07-25T06:00:00.000Z"),
      studentNames: ["Twin Student"],
    });
    // Both are exactly 5 minutes away — a tie must not be guessed at.
    expect(result.status).toBe("ambiguous");
    expect(result.row).toBeNull();
    expect(result.candidates).toHaveLength(2);
  });

  it("picks the strictly nearest row when several are in tolerance", () => {
    const near = parsePayoutSheet([
      ["Date", "Time", "Duration", "Credits deducted", "Session name", "Student name", "Payout amount"],
      [dateSerial("2026-07-25"), timeSerial(6, 2), "60 mins", 1, "A", "Twin Student", 700],
      [dateSerial("2026-07-25"), timeSerial(6, 9), "60 mins", 1, "B", "Twin Student", 700],
    ])!;
    const result = matchPayoutRow({
      table: near,
      scheduledStartAt: new Date("2026-07-25T06:00:00.000Z"),
      studentNames: ["Twin Student"],
    });
    expect(result.status).toBe("matched");
    expect(result.row?.sessionName).toBe("A");
  });

  it("never re-matches a deduction row inserted by a previous publish", () => {
    const withDeduction = parsePayoutSheet([
      ["Date", "Time", "Duration", "Credits deducted", "Session name", "Student name", "Payout amount"],
      [dateSerial("2026-07-25"), timeSerial(6, 0), "—", "—", DEDUCTION_SESSION_NAME, "Norraphat (Him.Vi) Viriyarojanakul", -100],
    ])!;
    const result = matchPayoutRow({
      table: withDeduction,
      scheduledStartAt: new Date("2026-07-25T06:00:00.000Z"),
      studentNames: ["Norraphat (Him.Vi) Viriyarojanakul"],
    });
    expect(result.status).toBe("unmatched");
  });
});

describe("normalizeStudentName", () => {
  it("collapses whitespace and case", () => {
    expect(normalizeStudentName("  Ada   Lovelace ")).toBe("ada lovelace");
    expect(normalizeStudentName(null)).toBe("");
  });
});
