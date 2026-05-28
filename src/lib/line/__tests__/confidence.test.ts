import { describe, expect, it } from "vitest";
import { confidenceBand } from "@/lib/line/confidence";

describe("confidenceBand", () => {
  it("returns high at or above 0.85", () => {
    expect(confidenceBand(0.85)).toBe("high");
    expect(confidenceBand(0.99)).toBe("high");
    expect(confidenceBand(1)).toBe("high");
  });

  it("returns medium from 0.6 up to (but not including) 0.85", () => {
    expect(confidenceBand(0.6)).toBe("medium");
    expect(confidenceBand(0.75)).toBe("medium");
    expect(confidenceBand(0.8499)).toBe("medium");
  });

  it("returns low below 0.6", () => {
    expect(confidenceBand(0.5999)).toBe("low");
    expect(confidenceBand(0)).toBe("low");
  });

  it("returns null for nullish or NaN input", () => {
    expect(confidenceBand(null)).toBeNull();
    expect(confidenceBand(undefined)).toBeNull();
    expect(confidenceBand(Number.NaN)).toBeNull();
  });
});
