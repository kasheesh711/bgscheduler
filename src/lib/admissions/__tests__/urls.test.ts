import { describe, expect, it } from "vitest";

import {
  admissionsHttpUrlSchema,
  admissionsHttpsUrlSchema,
  normalizeAdmissionsUrl,
} from "@/lib/admissions/shared/urls";
import { academicRecordPayloadSchema } from "@/lib/admissions/shared/academics";

describe("admissions URL safety", () => {
  it("canonicalizes absolute web URLs and preserves nullable values", () => {
    expect(normalizeAdmissionsUrl("  https://example.edu  ", "url"))
      .toBe("https://example.edu/");
    expect(normalizeAdmissionsUrl(null, "url")).toBeNull();
    expect(normalizeAdmissionsUrl(undefined, "url")).toBeUndefined();
  });

  it("rejects non-web schemes and embedded usernames or passwords", () => {
    for (const value of [
      "javascript:alert(1)",
      "https://student@example.edu/apply",
      "https://student:secret@example.edu/apply",
    ]) {
      expect(() => normalizeAdmissionsUrl(value, "url")).toThrow("Invalid url");
      expect(admissionsHttpUrlSchema.safeParse(value).success).toBe(false);
    }
  });

  it("retains the resource library's HTTPS-only invariant", () => {
    expect(admissionsHttpsUrlSchema.safeParse("https://example.edu/guide").success).toBe(true);
    expect(admissionsHttpsUrlSchema.safeParse("http://example.edu/guide").success).toBe(false);
  });

  it("applies credential rejection to academic document links", () => {
    const base = {
      system: "us" as const,
      gpaScale: 4,
      fourYearCoursePlan: [],
    };
    expect(academicRecordPayloadSchema.safeParse({
      ...base,
      transcriptUrl: "https://drive.google.com/transcript",
    }).success).toBe(true);
    expect(academicRecordPayloadSchema.safeParse({
      ...base,
      schoolProfileUrl: "https://student:secret@drive.google.com/profile",
    }).success).toBe(false);
  });
});
