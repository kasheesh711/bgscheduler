import { describe, expect, it } from "vitest";
import { parsePackageHours } from "../package-hours";

describe("parsePackageHours", () => {
  it("parses English hour packages into numeric bands", () => {
    expect(parsePackageHours("20 Hours")).toEqual({ hours: 20, band: "20h", label: "20 Hours" });
    expect(parsePackageHours("10 Hours")).toEqual({ hours: 10, band: "1-10h", label: "10 Hours" });
    expect(parsePackageHours("30 Hours")).toEqual({ hours: 30, band: "30h", label: "30 Hours" });
    expect(parsePackageHours("40 Hours")).toEqual({ hours: 40, band: "40h+", label: "40 Hours" });
    expect(parsePackageHours("60 Hours")).toEqual({ hours: 60, band: "40h+", label: "60 Hours" });
  });

  it("parses abbreviated and compact hour formats", () => {
    expect(parsePackageHours("5h")).toEqual({ hours: 5, band: "1-10h", label: "5h" });
    expect(parsePackageHours("20 hrs")).toEqual({ hours: 20, band: "20h", label: "20 hrs" });
    expect(parsePackageHours("30 hr.")).toEqual({ hours: 30, band: "30h", label: "30 hr." });
    expect(parsePackageHours("20")).toEqual({ hours: 20, band: "20h", label: "20" });
  });

  it("parses Thai legacy hour formats", () => {
    expect(parsePackageHours("20 ชั่วโมง")).toEqual({ hours: 20, band: "20h", label: "20 ชั่วโมง" });
    expect(parsePackageHours("10 ชม.")).toEqual({ hours: 10, band: "1-10h", label: "10 ชม." });
  });

  it("routes trial packages to the Trial band", () => {
    expect(parsePackageHours("Trial")).toEqual({ hours: null, band: "Trial", label: "Trial" });
    expect(parsePackageHours("trial class")).toEqual({ hours: null, band: "Trial", label: "trial class" });
    expect(parsePackageHours("ทดลองเรียน")).toEqual({ hours: null, band: "Trial", label: "ทดลองเรียน" });
  });

  it("fails soft to Other for unparseable values without dropping them", () => {
    expect(parsePackageHours("Camp Package")).toEqual({ hours: null, band: "Other", label: "Camp Package" });
    expect(parsePackageHours("0 Hours")).toEqual({ hours: null, band: "Other", label: "0 Hours" });
    expect(parsePackageHours("")).toEqual({ hours: null, band: "Other", label: "Unspecified" });
    expect(parsePackageHours("   ")).toEqual({ hours: null, band: "Other", label: "Unspecified" });
  });

  it("collapses whitespace in the label but preserves the original text", () => {
    expect(parsePackageHours("  20   Hours ")).toEqual({ hours: 20, band: "20h", label: "20 Hours" });
  });
});
