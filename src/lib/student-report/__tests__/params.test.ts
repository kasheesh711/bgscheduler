import { describe, expect, it } from "vitest";

import {
  buildReportSearch,
  normalizeReportParams,
  reportParamsSchema,
} from "../params";

describe("normalizeReportParams", () => {
  it("turns one student string into a one-element array", () => {
    expect(normalizeReportParams({
      student: "student::one",
      from: "2026-05-01",
      to: "2026-08-17",
    })).toEqual({
      students: ["student::one"],
      from: "2026-05-01",
      to: "2026-08-17",
    });
  });

  it("passes repeated student values through", () => {
    expect(normalizeReportParams({
      student: ["student::one", "student::two"],
      from: "2026-05-01",
      to: "2026-08-17",
    })).toEqual({
      students: ["student::one", "student::two"],
      from: "2026-05-01",
      to: "2026-08-17",
    });
  });

  it("fails schema validation when student is absent", () => {
    const normalized = normalizeReportParams({
      from: "2026-05-01",
      to: "2026-08-17",
    });
    expect(reportParamsSchema.safeParse(normalized).success).toBe(false);
  });
});

describe("reportParamsSchema", () => {
  const valid = {
    students: ["student::one"],
    from: "2026-05-01",
    to: "2026-08-17",
  };

  it("rejects more than eight students", () => {
    expect(reportParamsSchema.safeParse({
      ...valid,
      students: Array.from({ length: 9 }, (_, index) => `student-${index}`),
    }).success).toBe(false);
  });

  it("rejects non-padded dates", () => {
    expect(reportParamsSchema.safeParse({ ...valid, from: "2026-5-01" }).success).toBe(false);
  });

  it("rejects an inverted range and accepts a single day", () => {
    expect(reportParamsSchema.safeParse({
      ...valid,
      from: "2026-08-18",
      to: "2026-08-17",
    }).success).toBe(false);
    expect(reportParamsSchema.safeParse({
      ...valid,
      from: "2026-08-17",
      to: "2026-08-17",
    }).success).toBe(true);
  });
});

describe("buildReportSearch", () => {
  it("round-trips repeated encoded student keys without a leading question mark", () => {
    const search = buildReportSearch({
      studentKeys: ["family::student one", "student::two with spaces"],
      from: "2026-05-01",
      to: "2026-08-17",
    });

    expect(search.startsWith("?")).toBe(false);
    expect(search).toContain("family%3A%3Astudent%20one");
    const params = new URLSearchParams(search);
    expect(params.getAll("student")).toEqual([
      "family::student one",
      "student::two with spaces",
    ]);
    expect(params.get("from")).toBe("2026-05-01");
    expect(params.get("to")).toBe("2026-08-17");
  });
});
