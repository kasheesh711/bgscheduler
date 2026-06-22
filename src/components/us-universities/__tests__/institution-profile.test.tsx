import { describe, expect, it } from "vitest";
import {
  admissionRequirements,
  formatPct,
  formatRatio,
  formatUsd,
} from "../institution-profile";

const EM_DASH = "—";

describe("formatUsd", () => {
  it("formats with a dollar sign and thousands separators", () => {
    expect(formatUsd(12_500)).toBe("$12,500");
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(1_234_567)).toBe("$1,234,567");
  });

  it("renders a missing value as an em dash, never 0", () => {
    expect(formatUsd(null)).toBe(EM_DASH);
    expect(formatUsd(undefined)).toBe(EM_DASH);
    expect(formatUsd(Number.NaN)).toBe(EM_DASH);
  });
});

describe("formatPct", () => {
  it("appends a percent sign and trims to one decimal", () => {
    expect(formatPct(15)).toBe("15%");
    expect(formatPct(42.34)).toBe("42.3%");
    expect(formatPct(0)).toBe("0%");
  });

  it("renders a missing value as an em dash, never 0%", () => {
    expect(formatPct(null)).toBe(EM_DASH);
    expect(formatPct(undefined)).toBe(EM_DASH);
    expect(formatPct(Number.NaN)).toBe(EM_DASH);
  });
});

describe("formatRatio", () => {
  it("renders as N:1", () => {
    expect(formatRatio(14)).toBe("14:1");
    expect(formatRatio(8.5)).toBe("8.5:1");
  });

  it("renders a missing value as an em dash", () => {
    expect(formatRatio(null)).toBe(EM_DASH);
    expect(formatRatio(undefined)).toBe(EM_DASH);
  });
});

describe("admissionRequirements", () => {
  it("maps codes to labels and requirement levels in ADMCON order", () => {
    const reqs = admissionRequirements({
      ADMCON1: 1, // Secondary school GPA → Required
      ADMCON7: 2, // Admission test scores → Recommended
      ADMCON11: 5, // Personal statement → Considered but not required
    });
    expect(reqs).toEqual([
      { key: "ADMCON1", label: "Secondary school GPA", level: "Required" },
      { key: "ADMCON7", label: "Admission test scores", level: "Recommended" },
      {
        key: "ADMCON11",
        label: "Personal statement or essay",
        level: "Considered but not required",
      },
    ]);
  });

  it("filters out null codes and 'Not considered' (code 3)", () => {
    const reqs = admissionRequirements({
      ADMCON1: 1,
      ADMCON2: null,
      ADMCON3: 3, // Not considered → dropped
      ADMCON5: null,
    });
    expect(reqs).toEqual([
      { key: "ADMCON1", label: "Secondary school GPA", level: "Required" },
    ]);
  });

  it("returns an empty list for null/undefined input", () => {
    expect(admissionRequirements(null)).toEqual([]);
    expect(admissionRequirements(undefined)).toEqual([]);
    expect(admissionRequirements({})).toEqual([]);
  });

  it("drops unknown value codes defensively", () => {
    expect(admissionRequirements({ ADMCON1: 99 })).toEqual([]);
  });
});
