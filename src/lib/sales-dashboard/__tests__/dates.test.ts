import { describe, expect, it } from "vitest";
import {
  currentBangkokDate,
  currentBangkokMonthEnd,
  currentBangkokMonthStart,
} from "@/lib/sales-dashboard/dates";

describe("sales dashboard Bangkok dates", () => {
  it("uses Bangkok date boundaries for current month helpers", () => {
    const bangkokMayFirst = new Date("2026-04-30T17:00:00.000Z");

    expect(currentBangkokDate(bangkokMayFirst)).toBe("2026-05-01");
    expect(currentBangkokMonthStart(bangkokMayFirst)).toBe("2026-05-01");
    expect(currentBangkokMonthEnd(bangkokMayFirst)).toBe("2026-05-31");
  });

  it("does not roll into the next Bangkok month before Bangkok midnight", () => {
    const bangkokAprilThirtieth = new Date("2026-04-30T16:59:59.000Z");

    expect(currentBangkokDate(bangkokAprilThirtieth)).toBe("2026-04-30");
    expect(currentBangkokMonthStart(bangkokAprilThirtieth)).toBe("2026-04-01");
    expect(currentBangkokMonthEnd(bangkokAprilThirtieth)).toBe("2026-04-30");
  });
});
