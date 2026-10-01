import { describe, expect, it } from "vitest";
import { normalizeGrowthBookingMetadata } from "../source";

const observedAt = "2026-10-01T04:00:00.000Z";
describe("growth booking classification", () => {
  it("uses recorded purpose for a paid trial and never infers from credits", () => {
    expect(normalizeGrowthBookingMetadata({ _id: "a", purpose: "TRIAL", credit: 1 }, observedAt))
      .toMatchObject({ classification: "trial", sourceField: "purpose", sourceValue: "TRIAL", completeness: "complete" });
    expect(normalizeGrowthBookingMetadata({ _id: "b", purpose: "REGULAR", credit: 0 }, observedAt).classification).toBe("regular");
  });
  it("keeps absent and unrecognized classification unknown", () => {
    expect(normalizeGrowthBookingMetadata({ _id: "a", credit: 0, title: "Maths" }, observedAt).classification).toBe("unknown");
    expect(normalizeGrowthBookingMetadata({ _id: "a", classId: { classType: "ONE_ON_ONE" } }, observedAt).classification).toBe("unknown");
  });
  it("recognizes explicit pretest and the retained workforce source shape", () => {
    expect(normalizeGrowthBookingMetadata({ _id: "a", classId: { purpose: "PRE_TEST" } }, observedAt).classification).toBe("pretest");
    expect(normalizeGrowthBookingMetadata({ wiseSessionId: "a", bookingClassificationSource: { classType: "REGULAR" } }, observedAt))
      .toMatchObject({ wiseSessionId: "a", classification: "regular", observedAt });
  });
  it("does not choose between contradictory source purposes", () => {
    const row = normalizeGrowthBookingMetadata({ _id: "a", purpose: "TRIAL", classId: { classType: "REGULAR" } }, observedAt);
    expect(row.classification).toBe("unknown");
    expect(row.reasonCodes).toContain("CONFLICTING_BOOKING_CLASSIFICATION");
  });
  it("rejects invalid record identity or observation time", () => {
    expect(() => normalizeGrowthBookingMetadata({}, observedAt)).toThrow("session identity");
    expect(() => normalizeGrowthBookingMetadata({ _id: "a" }, "wrong")).toThrow("observation time");
  });
  it("applies the owner's title rule and only defaults reviewed academic classes to regular", () => {
    expect(normalizeGrowthBookingMetadata({ _id: "t", title: "Maths trial lesson" }, observedAt).classification).toBe("trial");
    expect(normalizeGrowthBookingMetadata({ _id: "p", title: "Physics Pre-test" }, observedAt).classification).toBe("pretest");
    expect(normalizeGrowthBookingMetadata({ _id: "u", title: "Maths Y10" }, observedAt).classification).toBe("unknown");
    expect(normalizeGrowthBookingMetadata({ _id: "r", title: "Maths Y10" }, observedAt, true)).toMatchObject({ classification:"regular", reasonCodes:["OWNER_CONFIRMED_TITLE_CLASSIFICATION"] });
    expect(normalizeGrowthBookingMetadata({ _id: "c", title: "Industrial chemistry" }, observedAt, true).classification).toBe("regular");
  });
});
