import { describe, expect, it } from "vitest";
import {
  normalizeModelParse,
  redactNaturalLanguageInput,
  resolveParsedFilters,
  resolveTutorNames,
} from "@/lib/search/natural-language";
import type { FilterOptions } from "@/lib/data/filters";
import type { TutorListItem } from "@/lib/data/tutors";

const filterOptions: FilterOptions = {
  subjects: ["English", "Math"],
  curriculums: ["International", "Thai"],
  levels: ["Year 5", "Grade 10"],
};

const tutorList: TutorListItem[] = [
  { tutorGroupId: "tutor-1", displayName: "Kevin", supportedModes: ["online"], subjects: ["English"] },
  { tutorGroupId: "tutor-2", displayName: "Kenny", supportedModes: ["onsite"], subjects: ["Math"] },
  { tutorGroupId: "tutor-3", displayName: "Anna", supportedModes: ["online"], subjects: ["English"] },
  { tutorGroupId: "tutor-4", displayName: "Anne", supportedModes: ["online"], subjects: ["Math"] },
];

function modelParsed(overrides: Record<string, unknown> = {}) {
  return {
    status: "parsed",
    searchMode: "one_time",
    dayOfWeek: null,
    date: "2026-05-19",
    startTime: "17:00",
    endTime: "20:00",
    durationMinutes: 90,
    mode: "either",
    filters: { subject: "English", curriculum: null, level: null },
    tutorNames: [],
    warnings: [],
    clarifyingQuestions: [],
    partial: {
      searchMode: null,
      dayOfWeek: null,
      date: null,
      startTime: null,
      endTime: null,
      durationMinutes: null,
      mode: null,
      filters: null,
      tutorNames: null,
    },
    ...overrides,
  };
}

describe("natural language search helpers", () => {
  it("redacts emails, phone-like values, and long numeric identifiers", () => {
    const redacted = redactNaturalLanguageInput(
      "Parent beam@example.com called +66 81 234 5678 about student 123456789 on Tuesday",
    );

    expect(redacted).toContain("[email]");
    expect(redacted).toContain("[phone]");
    expect(redacted).toContain("[number]");
    expect(redacted).not.toContain("beam@example.com");

    expect(redactNaturalLanguageInput("Need class on 2026-05-19")).toContain("2026-05-19");
  });

  it("resolves tutor names exactly, case-insensitively, and reports misses or ambiguity", () => {
    expect(resolveTutorNames(["kevin"], tutorList).matchedTutors).toEqual([
      { tutorGroupId: "tutor-1", displayName: "Kevin" },
    ]);

    expect(resolveTutorNames(["Missing"], tutorList).issues[0]).toMatch(/did not match/);
    expect(resolveTutorNames(["Ann"], tutorList).issues[0]).toMatch(/matched multiple/);
  });

  it("resolves filters against active options only", () => {
    expect(resolveParsedFilters({ subject: "english", curriculum: "thai", level: "year 5" }, filterOptions)).toEqual({
      filters: { subject: "English", curriculum: "Thai", level: "Year 5" },
      issues: [],
    });

    const invalid = resolveParsedFilters({ subject: "Physics" }, filterOptions);
    expect(invalid.filters).toEqual({});
    expect(invalid.issues[0]).toMatch(/not an active filter option/);
  });

  it("rejects unsupported durations, invalid dates, end-before-start, and missing parsed fields", () => {
    expect(() => normalizeModelParse(modelParsed({ durationMinutes: 45 }))).toThrow();
    expect(() => normalizeModelParse(modelParsed({ date: "2026-02-31" }))).toThrow(/valid YYYY-MM-DD/);
    expect(() => normalizeModelParse(modelParsed({ endTime: "16:00" }))).toThrow(/after start/);
    expect(() => normalizeModelParse(modelParsed({ startTime: null }))).toThrow(/missing required/);
  });

  it("keeps ambiguous bare weekday as clarification and accepts explicit one-time dates", () => {
    const clarification = normalizeModelParse({
      ...modelParsed({
        status: "needs_clarification",
        searchMode: null,
        date: null,
        startTime: null,
        endTime: null,
        durationMinutes: null,
        mode: null,
        filters: { subject: null, curriculum: null, level: null },
        clarifyingQuestions: ["Do you mean this Tuesday or every Tuesday?"],
        partial: {
          searchMode: null,
          dayOfWeek: 2,
          date: null,
          startTime: null,
          endTime: null,
          durationMinutes: null,
          mode: null,
          filters: null,
          tutorNames: null,
        },
      }),
    });
    expect(clarification.status).toBe("needs_clarification");

    const explicit = normalizeModelParse(modelParsed());
    expect(explicit.status).toBe("parsed");
    if (explicit.status === "parsed") {
      expect(explicit.date).toBe("2026-05-19");
      expect(explicit.searchMode).toBe("one_time");
    }
  });
});
