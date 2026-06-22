import { describe, it, expect } from "vitest";
import {
  coerceIpedsNumber,
  coerceIpedsInt,
  coerceIpedsBool,
  deriveCip2,
  isSixDigitCip,
  emptyToNull,
  upperKeys,
  parseAdmConsiderations,
} from "../parser";

describe("coerceIpedsNumber", () => {
  it("parses plain numbers", () => expect(coerceIpedsNumber("1234")).toBe(1234));
  it("treats '.' as null (not reported)", () => expect(coerceIpedsNumber(".")).toBeNull());
  it("treats empty as null", () => expect(coerceIpedsNumber("")).toBeNull());
  it("treats null/undefined as null", () => {
    expect(coerceIpedsNumber(null)).toBeNull();
    expect(coerceIpedsNumber(undefined)).toBeNull();
  });
  it("trims and strips thousands separators", () => expect(coerceIpedsNumber(" 1,234 ")).toBe(1234));
  it("preserves valid negatives (longitude)", () => expect(coerceIpedsNumber("-122.34")).toBe(-122.34));
  it("keeps legit zero", () => expect(coerceIpedsNumber("0")).toBe(0));
  it("returns null for non-numeric", () => expect(coerceIpedsNumber("N/A")).toBeNull());
});

describe("coerceIpedsInt", () => {
  it("rounds", () => expect(coerceIpedsInt("12.6")).toBe(13));
  it("nulls missing", () => expect(coerceIpedsInt("")).toBeNull());
});

describe("coerceIpedsBool", () => {
  it("1 → true", () => expect(coerceIpedsBool("1")).toBe(true));
  it("2 → false", () => expect(coerceIpedsBool("2")).toBe(false));
  it("other → null", () => expect(coerceIpedsBool("3")).toBeNull());
  it("blank → null", () => expect(coerceIpedsBool("")).toBeNull());
});

describe("deriveCip2", () => {
  it("takes the 2-digit family", () => expect(deriveCip2("11.0701")).toBe("11"));
  it("zero-pads single digit", () => expect(deriveCip2("1.1001")).toBe("01"));
  it("handles already-2-digit", () => expect(deriveCip2("26.0101")).toBe("26"));
});

describe("isSixDigitCip", () => {
  it("keeps 6-digit detail codes", () => expect(isSixDigitCip("11.0701")).toBe(true));
  it("drops 2-digit family rollups", () => expect(isSixDigitCip("11")).toBe(false));
  it("drops 4-digit rollups", () => expect(isSixDigitCip("11.07")).toBe(false));
  it("drops the 99 grand total (2-digit)", () => expect(isSixDigitCip("99")).toBe(false));
});

describe("emptyToNull", () => {
  it("blank → null", () => expect(emptyToNull("   ")).toBeNull());
  it("keeps content trimmed", () => expect(emptyToNull("  Yale  ")).toBe("Yale"));
});

describe("upperKeys", () => {
  it("upper-cases keys (UNITID/unitId/unitid)", () => {
    expect(upperKeys({ unitId: "1", CipCode: "11" })).toEqual({ UNITID: "1", CIPCODE: "11" });
  });
});

describe("parseAdmConsiderations", () => {
  it("maps ADMCON1-12 codes, null for missing", () => {
    const out = parseAdmConsiderations({ ADMCON1: "1", ADMCON7: "5" });
    expect(out.ADMCON1).toBe(1);
    expect(out.ADMCON7).toBe(5);
    expect(out.ADMCON2).toBeNull();
    expect(Object.keys(out)).toHaveLength(12);
  });
});
