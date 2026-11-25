import { describe, expect, it } from "vitest";
import { mockWhen } from "../assessment-screen";

describe("mockWhen", () => {
  it("shows the date when the mock is on a later day than the test", () => {
    // Htoonantha Win: test Sat 28 Nov 10:00, mock Tue 1 Dec 13:00 (Bangkok).
    expect(mockWhen(new Date("2026-11-28T03:00:00Z"), new Date("2026-12-01T06:00:00Z"))).toBe("Tue 1 Dec, 13:00");
  });

  it("shows only the time when the mock is on the test day", () => {
    expect(mockWhen(new Date("2026-11-26T04:00:00Z"), new Date("2026-11-26T08:00:00Z"))).toBe("15:00");
  });

  it("compares Bangkok days, not UTC days", () => {
    // Same UTC date, but the mock is 00:30 on Sun 29 Nov in Bangkok.
    expect(mockWhen(new Date("2026-11-28T03:00:00Z"), new Date("2026-11-28T17:30:00Z"))).toBe("Sun 29 Nov, 00:30");
  });

  it("shows the date when the visit has no test time", () => {
    expect(mockWhen(null, new Date("2026-12-01T06:00:00Z"))).toBe("Tue 1 Dec, 13:00");
  });
});
