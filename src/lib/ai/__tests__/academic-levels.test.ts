import { describe, expect, it } from "vitest";
import {
  recoverFiltersFromUnknowns,
  resolveAcademicFilters,
  resolveAcademicLevel,
} from "@/lib/ai/academic-levels";

const options = {
  subjects: ["English", "Math", "Econ"],
  curriculums: ["International", "Thai"],
  levels: ["11+/13+", "16+", "AP", "G1-9", "G10-12", "GED", "IELTS", "SAT", "Uni", "Y12-13", "Y2-8", "Y9-11"],
};

describe("academic level resolver", () => {
  it("maps Y10 to the active International Y9-11 bucket", () => {
    expect(resolveAcademicLevel({
      rawLevel: "Y10",
      curriculum: "International",
      activeLevels: options.levels,
    })).toMatchObject({
      rawLevelLabel: "Y10",
      wiseLevel: "Y9-11",
      status: "mapped",
    });
  });

  it("maps Year 5 to Y2-8", () => {
    expect(resolveAcademicLevel({
      rawLevel: "Year 5",
      activeLevels: options.levels,
    })).toMatchObject({
      rawLevelLabel: "Year 5",
      wiseLevel: "Y2-8",
      status: "mapped",
    });
  });

  it("maps 11+ to 11+/13+", () => {
    expect(resolveAcademicLevel({
      rawLevel: "11+",
      activeLevels: options.levels,
    })).toMatchObject({
      rawLevelLabel: "11+",
      wiseLevel: "11+/13+",
      status: "mapped",
    });
  });

  it("treats Grade 10 as ambiguous without curriculum context", () => {
    expect(resolveAcademicLevel({
      rawLevel: "Grade 10",
      activeLevels: options.levels,
    })).toMatchObject({
      rawLevelLabel: "Grade 10",
      status: "ambiguous",
      candidates: ["Y9-11", "G10-12"],
    });
  });

  it("maps Grade 10 to Thai G10-12 when curriculum is Thai", () => {
    expect(resolveAcademicLevel({
      rawLevel: "Grade 10",
      curriculum: "Thai",
      activeLevels: options.levels,
    })).toMatchObject({
      wiseLevel: "G10-12",
      status: "mapped",
    });
  });

  it("recovers known subjects and subject descriptors from unknown filters", () => {
    const result = recoverFiltersFromUnknowns({
      filters: {},
      explicitUnknownFilters: ["english", "English writing"],
      options,
    });

    expect(result.filters.subject).toBe("English");
    expect(result.remainingUnknowns).toEqual([]);
  });

  it("resolves filters with raw requested level preserved in resolution metadata", () => {
    const result = resolveAcademicFilters({
      subject: "econ",
      curriculum: "international",
      level: "y10",
    }, options);

    expect(result.filters).toEqual({
      subject: "Econ",
      curriculum: "International",
      level: "Y9-11",
    });
    expect(result.academicLevelResolution).toMatchObject({
      rawLevelLabel: "y10",
      wiseLevel: "Y9-11",
      status: "mapped",
    });
  });
});
