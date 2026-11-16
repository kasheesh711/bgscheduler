import { describe, expect, it } from "vitest";
import { phoneView, thaiNational } from "../phone";

describe("Thai phone numbers", () => {
  it("reads every way of typing one mobile as the same national number", () => {
    for (const raw of ["+66812345678", "66812345678", "0812345678", "812345678", "+66 81 234 5678", "081-234-5678", "+660812345678", "660812345678"])
      expect(thaiNational(raw)).toBe("0812345678");
  });
  it("reads a Bangkok landline with the country code, with or without the plus sign", () => {
    for (const raw of ["6624171692", "+6624171692", "024171692", "02-417-1692"]) expect(thaiNational(raw)).toBe("024171692");
  });
  it("does not guess for a foreign or short number", () => {
    for (const raw of ["+447911123456", "+12025550123", "12345", "", "24171692", "+0812345678"]) expect(thaiNational(raw)).toBeNull();
  });
});

describe("phoneView", () => {
  it("shows a mobile in three groups and dials the international number", () => {
    expect(phoneView("66812345678")).toEqual({ display: "081 234 5678", href: "tel:+66812345678" });
    expect(phoneView("0815955191")).toEqual({ display: "081 595 5191", href: "tel:+66815955191" });
  });
  it("shows Bangkok and other landlines with their area code", () => {
    expect(phoneView("6624171692")).toEqual({ display: "02 417 1692", href: "tel:+6624171692" });
    expect(phoneView("053123456")).toEqual({ display: "053 123 456", href: "tel:+6653123456" });
  });
  it("shows a foreign number as stored and dials its digits", () => {
    expect(phoneView("+44 7911 123456")).toEqual({ display: "+44 7911 123456", href: "tel:+447911123456" });
  });
});
