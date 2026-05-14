import { describe, expect, it } from "vitest";
import { buildFilterOptions } from "@/lib/data/filters";

describe("buildFilterOptions", () => {
  it("returns sorted distinct subjects, curriculums, and levels", () => {
    expect(buildFilterOptions([
      { subject: "Physics", curriculum: "IB", level: "Grade 11" },
      { subject: "Math", curriculum: "AP", level: "Grade 10" },
      { subject: "Math", curriculum: "IB", level: "Grade 10" },
    ])).toEqual({
      subjects: ["Math", "Physics"],
      curriculums: ["AP", "IB"],
      levels: ["Grade 10", "Grade 11"],
    });
  });
});
