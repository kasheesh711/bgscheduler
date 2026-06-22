import { describe, expect, it } from "vitest";
import {
  EM_DASH,
  admissionRequirements,
  awardLevelText,
  formatInt,
  formatPct,
  formatRatio,
  formatSatRange,
  formatUsd,
  rangeText,
} from "../format";

describe("formatUsd", () => {
  it("formats with $ and thousands separators", () => {
    expect(formatUsd(12_500)).toBe("$12,500");
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(1_234_567)).toBe("$1,234,567");
  });
  it("renders missing as em dash", () => {
    expect(formatUsd(null)).toBe(EM_DASH);
    expect(formatUsd(undefined)).toBe(EM_DASH);
    expect(formatUsd(Number.NaN)).toBe(EM_DASH);
  });
});

describe("formatPct", () => {
  it("one-decimal, drops trailing .0", () => {
    expect(formatPct(15)).toBe("15%");
    expect(formatPct(42.34)).toBe("42.3%");
    expect(formatPct(0)).toBe("0%");
  });
  it("renders missing as em dash", () => {
    expect(formatPct(null)).toBe(EM_DASH);
    expect(formatPct(Number.NaN)).toBe(EM_DASH);
  });
});

describe("formatRatio", () => {
  it("renders N:1", () => {
    expect(formatRatio(14)).toBe("14:1");
    expect(formatRatio(8.5)).toBe("8.5:1");
  });
  it("renders missing as em dash", () => {
    expect(formatRatio(null)).toBe(EM_DASH);
    expect(formatRatio(undefined)).toBe(EM_DASH);
  });
});

describe("formatInt", () => {
  it("rounds + locale-formats with optional prefix", () => {
    expect(formatInt(15_234)).toBe("15,234");
    expect(formatInt(18_200, "$")).toBe("$18,200");
    expect(formatInt(0)).toBe("0");
  });
  it("renders missing as em dash", () => {
    expect(formatInt(null)).toBe(EM_DASH);
    expect(formatInt(undefined, "$")).toBe(EM_DASH);
  });
});

describe("formatSatRange", () => {
  it("renders p25–p75 when both present", () => {
    expect(formatSatRange(1330, 1530)).toBe("1330–1530");
  });
  it("renders em dash when either bound missing", () => {
    expect(formatSatRange(null, 1530)).toBe(EM_DASH);
    expect(formatSatRange(1330, null)).toBe(EM_DASH);
    expect(formatSatRange(null, null)).toBe(EM_DASH);
  });
});

describe("rangeText", () => {
  it("renders both bounds", () => {
    expect(rangeText(1330, 1530)).toBe("1330–1530");
  });
  it("renders em dash only when BOTH null; one side keeps the other", () => {
    expect(rangeText(null, null)).toBe(EM_DASH);
    expect(rangeText(null, 1530)).toBe("—–1530");
    expect(rangeText(1330, null)).toBe("1330–—");
  });
});

describe("admissionRequirements", () => {
  it("maps codes to labels in ADMCON order", () => {
    expect(
      admissionRequirements({ ADMCON1: 1, ADMCON7: 2, ADMCON11: 5 }),
    ).toEqual([
      { key: "ADMCON1", label: "Secondary school GPA", level: "Required" },
      { key: "ADMCON7", label: "Admission test scores", level: "Recommended" },
      { key: "ADMCON11", label: "Personal statement or essay", level: "Considered but not required" },
    ]);
  });
  it("drops null, code 3, and unknown codes", () => {
    expect(admissionRequirements({ ADMCON1: 1, ADMCON2: null, ADMCON3: 3 })).toEqual([
      { key: "ADMCON1", label: "Secondary school GPA", level: "Required" },
    ]);
    expect(admissionRequirements({ ADMCON1: 99 })).toEqual([]);
    expect(admissionRequirements(null)).toEqual([]);
    expect(admissionRequirements(undefined)).toEqual([]);
  });
});

describe("awardLevelText", () => {
  it("prefers the fallback label", () => {
    expect(awardLevelText(5, "Bachelor's degree")).toBe("Bachelor's degree");
  });
  it("falls back to the code label, then em dash", () => {
    expect(awardLevelText(5, null)).toBe("Bachelor's degree");
    expect(awardLevelText(999, null)).toBe(EM_DASH);
    expect(awardLevelText(null, null)).toBe(EM_DASH);
  });
});
