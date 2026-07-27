import { describe, expect, it } from "vitest";
import {
  currentPayoutRunWindow,
  payoutRunRangeUtc,
  payoutRunWindow,
} from "../payout-window";

describe("payoutRunWindow", () => {
  it("spans the 26th of the prior month to the 25th inclusive", () => {
    // The window shown on the real payout sheet.
    expect(payoutRunWindow("2026-07")).toEqual({
      anchorMonth: "2026-07",
      windowStart: "2026-06-26",
      windowEnd: "2026-07-25",
    });
  });

  it("handles a January anchor rolling back into the previous year", () => {
    expect(payoutRunWindow("2026-01")).toEqual({
      anchorMonth: "2026-01",
      windowStart: "2025-12-26",
      windowEnd: "2026-01-25",
    });
  });

  it("handles a March anchor rolling back into February", () => {
    expect(payoutRunWindow("2026-03").windowStart).toBe("2026-02-26");
    // 2028 is a leap year; the 26th exists either way, but the step back
    // from 1 March must not skip a day.
    expect(payoutRunWindow("2028-03").windowStart).toBe("2028-02-26");
  });

  it("rejects a malformed anchor month", () => {
    expect(() => payoutRunWindow("2026-13")).toThrow(/YYYY-MM/u);
    expect(() => payoutRunWindow("2026-7")).toThrow(/YYYY-MM/u);
    expect(() => payoutRunWindow("")).toThrow(/YYYY-MM/u);
  });
});

describe("currentPayoutRunWindow", () => {
  it("stays on the current month before the 25th closes", () => {
    // 20 Jul Bangkok.
    expect(currentPayoutRunWindow(new Date("2026-07-20T05:00:00.000Z")).anchorMonth).toBe("2026-07");
  });

  it("rolls forward once the 26th arrives", () => {
    expect(currentPayoutRunWindow(new Date("2026-07-26T05:00:00.000Z")).anchorMonth).toBe("2026-08");
  });

  it("rolls across a year boundary", () => {
    expect(currentPayoutRunWindow(new Date("2026-12-27T05:00:00.000Z")).anchorMonth).toBe("2027-01");
  });

  it("uses the Bangkok date, not UTC", () => {
    // 25 Jul 18:00Z is already 26 Jul in Bangkok, so the run has rolled.
    expect(currentPayoutRunWindow(new Date("2026-07-25T18:00:00.000Z")).anchorMonth).toBe("2026-08");
  });
});

describe("payoutRunRangeUtc", () => {
  it("produces an inclusive-start, exclusive-end Bangkok range", () => {
    const range = payoutRunRangeUtc(payoutRunWindow("2026-07"));
    // 26 Jun 00:00 Bangkok = 25 Jun 17:00Z.
    expect(range.start.toISOString()).toBe("2026-06-25T17:00:00.000Z");
    // Exclusive end is 26 Jul 00:00 Bangkok = 25 Jul 17:00Z.
    expect(range.endExclusive.toISOString()).toBe("2026-07-25T17:00:00.000Z");
  });
});
