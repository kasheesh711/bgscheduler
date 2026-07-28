import { describe, expect, it } from "vitest";

import { normalizeStudentName, serialToUtc } from "../payout-sheet";

describe("serialToUtc", () => {
  it("reads a date serial with a separate time fraction", () => {
    // 46228 is 25 Jul 2026; 0.25 of a day is 06:00.
    expect(serialToUtc(46228, 0.25)?.toISOString()).toBe("2026-07-25T06:00:00.000Z");
  });

  it("reads a date serial that already carries its own time", () => {
    expect(serialToUtc(46228.25, null)?.toISOString()).toBe("2026-07-25T06:00:00.000Z");
  });

  it("treats the value as UTC, never Bangkok", () => {
    // The whole matcher rests on this. Reading these as Bangkok would shift
    // every deduction seven hours and land it on the wrong class.
    expect(serialToUtc(46228, 0)?.toISOString()).toBe("2026-07-25T00:00:00.000Z");
  });

  it("accepts numeric strings, since a differently-rendered read returns those", () => {
    expect(serialToUtc("46228", "0.25")?.toISOString()).toBe("2026-07-25T06:00:00.000Z");
  });

  it("returns null rather than a wrong instant for an unreadable cell", () => {
    expect(serialToUtc(null, 0.25)).toBeNull();
    expect(serialToUtc("not a serial", 0)).toBeNull();
  });
});

describe("normalizeStudentName", () => {
  it("collapses whitespace and case", () => {
    expect(normalizeStudentName("  Ada   Lovelace ")).toBe("ada lovelace");
    expect(normalizeStudentName(null)).toBe("");
  });
});
