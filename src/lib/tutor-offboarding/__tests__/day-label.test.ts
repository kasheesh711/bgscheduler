import { describe, expect, it } from "vitest";
import { bangkokDayLabel } from "../day-label";

describe("bangkokDayLabel", () => {
  it("writes Bangkok days with fixed month names, September included", () => {
    expect(bangkokDayLabel("2026-09-21T03:00:00.000Z")).toBe("21 Sep");
    expect(bangkokDayLabel("2026-02-28T17:00:00.000Z")).toBe("1 Mar"); // midnight in Bangkok
    expect(bangkokDayLabel("2026-01-20T00:00:00.000Z", true)).toBe("20 Jan 2026");
  });
});
