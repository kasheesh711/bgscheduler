import { describe, expect, it } from "vitest";

import {
  normalizeSearchParams,
  parseTopicCodes,
  reportParamsSchema,
} from "../report-params";

describe("reportParamsSchema", () => {
  it("accepts a minimal valid request", () => {
    const result = reportParamsSchema.safeParse({ student: "Mali", year: "7" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.year).toBe(7);
      expect(result.data.topics).toBeUndefined();
    }
  });

  it("coerces year from string and rejects out-of-range years", () => {
    expect(reportParamsSchema.safeParse({ student: "A", year: "13" }).success).toBe(true);
    expect(reportParamsSchema.safeParse({ student: "A", year: "0" }).success).toBe(false);
    expect(reportParamsSchema.safeParse({ student: "A", year: "14" }).success).toBe(false);
    expect(reportParamsSchema.safeParse({ student: "A", year: "7.5" }).success).toBe(false);
    expect(reportParamsSchema.safeParse({ student: "A", year: "abc" }).success).toBe(false);
  });

  it("requires a non-empty student name and trims whitespace", () => {
    expect(reportParamsSchema.safeParse({ student: "   ", year: "7" }).success).toBe(false);
    const result = reportParamsSchema.safeParse({ student: "  Mali  ", year: "7" });
    expect(result.success && result.data.student).toBe("Mali");
  });

  it("enforces length caps", () => {
    expect(
      reportParamsSchema.safeParse({ student: "x".repeat(81), year: "7" }).success,
    ).toBe(false);
    expect(
      reportParamsSchema.safeParse({ student: "A", year: "7", notes: "x".repeat(1001) })
        .success,
    ).toBe(false);
    expect(
      reportParamsSchema.safeParse({ student: "A", year: "7", notes: "x".repeat(1000) })
        .success,
    ).toBe(true);
  });

  it("validates the topics CSV format", () => {
    const ok = ["A", "A,B,C", "AA,BB", "A,AA,NN"];
    for (const topics of ok) {
      expect(
        reportParamsSchema.safeParse({ student: "A", year: "7", topics }).success,
      ).toBe(true);
    }
    const bad = ["", "a,b", "A,", ",A", "A;B", "A B", "A,,B", "1,2"];
    for (const topics of bad) {
      expect(
        reportParamsSchema.safeParse({ student: "A", year: "7", topics }).success,
      ).toBe(false);
    }
  });
});

describe("parseTopicCodes", () => {
  it("returns null (all topics) when omitted", () => {
    expect(parseTopicCodes(undefined)).toBeNull();
  });

  it("splits a CSV into a set including multi-letter codes", () => {
    const set = parseTopicCodes("A,B,AA");
    expect(set).not.toBeNull();
    expect([...(set ?? [])]).toEqual(["A", "B", "AA"]);
  });
});

describe("normalizeSearchParams", () => {
  it("collapses array values to their first entry", () => {
    expect(normalizeSearchParams({ student: ["Mali", "Other"] })).toEqual({
      student: "Mali",
    });
  });

  it("drops empty strings and undefined so optional fields stay absent", () => {
    expect(
      normalizeSearchParams({ tutor: "", notes: undefined, student: "Mali" }),
    ).toEqual({ student: "Mali" });
  });
});
