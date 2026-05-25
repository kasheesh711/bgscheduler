import { describe, expect, it } from "vitest";
import {
  recoverFiltersFromUnknowns,
  resolveAcademicFilters,
  resolveAcademicLevel,
} from "@/lib/ai/academic-levels";

const options = {
  subjects: ["English", "EnglishVR", "Math", "Econ", "Science"],
  curriculums: ["International", "Thai"],
  levels: ["11+/13+", "16+", "A-Level", "AP", "G1-9", "G10-12", "GED", "IB", "IELTS", "IGCSE", "MYP", "SAT", "Uni", "Y12-13", "Y2-8", "Y9-11"],
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

  it("maps exam and programme aliases when active", () => {
    expect(resolveAcademicLevel({
      rawLevel: "IGCSE",
      activeLevels: options.levels,
    })).toMatchObject({ wiseLevel: "IGCSE", status: "mapped" });

    expect(resolveAcademicLevel({
      rawLevel: "A level",
      activeLevels: options.levels,
    })).toMatchObject({ wiseLevel: "A-Level", status: "mapped" });

    expect(resolveAcademicLevel({
      rawLevel: "IB",
      activeLevels: options.levels,
    })).toMatchObject({ wiseLevel: "IB", status: "mapped" });

    expect(resolveAcademicLevel({
      rawLevel: "IB MYP",
      activeLevels: options.levels,
    })).toMatchObject({ wiseLevel: "MYP", status: "mapped" });
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

  it("recovers raw course and subject aliases before warning", () => {
    const result = recoverFiltersFromUnknowns({
      filters: {},
      explicitUnknownFilters: ["economics", "Thai curriculum", "Grade 10"],
      options,
    });

    expect(result.filters).toEqual({
      subject: "Econ",
      curriculum: "Thai",
      level: "G10-12",
    });
    expect(result.remainingUnknowns).toEqual([]);
  });

  it("resolves raw subject aliases passed directly in filters", () => {
    expect(resolveAcademicFilters({
      subject: "English writing",
      level: "Y6",
    }, options)).toMatchObject({
      filters: {
        subject: "English",
        level: "Y2-8",
      },
      issues: [],
    });

    expect(resolveAcademicFilters({
      subject: "economics",
      level: "Y10",
    }, options)).toMatchObject({
      filters: {
        subject: "Econ",
        level: "Y9-11",
      },
      issues: [],
    });
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
