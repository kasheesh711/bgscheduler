import { describe, expect, it } from "vitest";
import { CARNEGIE_BASIC_LABELS, carnegieLabel } from "../constants";

describe("CARNEGIE_BASIC_LABELS", () => {
  it("maps the doctoral research tiers", () => {
    expect(CARNEGIE_BASIC_LABELS[15]).toBe("R1: Doctoral – Very high research");
    expect(CARNEGIE_BASIC_LABELS[16]).toBe("R2: Doctoral – High research");
    expect(CARNEGIE_BASIC_LABELS[17]).toBe("D/PU: Doctoral/Professional");
  });
});

describe("carnegieLabel", () => {
  it("returns the mapped label", () => {
    expect(carnegieLabel(15)).toBe("R1: Doctoral – Very high research");
    expect(carnegieLabel(21)).toBe("Baccalaureate: Arts & Sciences");
  });
  it("returns null (fail-closed) for unmapped / missing codes", () => {
    expect(carnegieLabel(999)).toBeNull();
    expect(carnegieLabel(0)).toBeNull();
    expect(carnegieLabel(-2)).toBeNull();
    expect(carnegieLabel(null)).toBeNull();
    expect(carnegieLabel(undefined)).toBeNull();
  });
});
