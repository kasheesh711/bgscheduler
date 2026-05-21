import { describe, expect, it } from "vitest";
import {
  buildTutorProfileImportPreview,
  type TutorProfileImportActiveIdentity,
  type TutorProfileImportAlias,
  type TutorAvailabilityImportRow,
  type TutorEducationImportRow,
} from "@/lib/tutor-profile-import";
import type { TutorBusinessProfileListItem } from "@/lib/tutor-business-profiles";

function activeProfile(index: number, overrides: Partial<TutorBusinessProfileListItem> = {}): TutorBusinessProfileListItem {
  return {
    canonicalKey: overrides.canonicalKey ?? `nick-${index}`,
    displayName: overrides.displayName ?? `Nick${index}`,
    tutorGroupId: `group-${index}`,
    supportedModes: ["online", "onsite"],
    subjects: ["Math"],
    parentSafeSummary: "",
    internalNotes: "",
    education: [],
    languages: [],
    englishProficiency: "unknown",
    youngLearnerFit: "unknown",
    youngestComfortableAge: null,
    youngLearnerNotes: "",
    teachingStyleTags: [],
    teachingStyleNotes: "",
    strengthTags: [],
    curriculumExperience: [],
    studentFitNotes: "",
    doNotUseForNotes: "",
    verifiedBy: null,
    lastReviewedAt: null,
    active: true,
    updatedAt: "2026-05-21T00:00:00.000Z",
    ...overrides,
  };
}

function educationRow(index: number): TutorEducationImportRow {
  return {
    firstName: `First${index}`,
    lastName: `Last${index}`,
    undergraduateDegree: "Bachelor of Science",
    undergraduateUniversity: "Chulalongkorn University",
    fluentInEnglish: index % 2 === 0 ? "No" : "Yes",
    rowNumber: index + 1,
  };
}

function availabilityRow(index: number): TutorAvailabilityImportRow {
  return {
    nickname: `Nick${index}`,
    firstName: `First${index}`,
    lastName: `Last${index}`,
    tier: "3",
    academicBackground: "International school background",
    highlights: "Patient and structured teaching for primary students.",
    profilePicture: `Kru Nick${index}.png`,
    rowNumber: index + 2,
  };
}

describe("tutor profile import preview", () => {
  it("flags availability-only rows from the audited seed shape", () => {
    const activeProfiles = Array.from({ length: 80 }, (_, index) => activeProfile(index + 1));
    const educationRows = [
      ...Array.from({ length: 70 }, (_, index) => educationRow(index + 1)),
      { ...educationRow(999), rowNumber: 72 },
    ];
    const availabilityRows = Array.from({ length: 80 }, (_, index) => availabilityRow(index + 1));

    const preview = buildTutorProfileImportPreview({
      educationRows,
      availabilityRows,
      activeProfiles,
      verifiedBy: "Kevin",
      lastReviewedAt: "2026-05-21T00:00:00.000Z",
    });

    expect(preview.summary.educationRows).toBe(71);
    expect(preview.summary.availabilityRows).toBe(80);
    expect(preview.summary.availabilityOnlyRows).toBe(10);
    expect(preview.availabilityOnlyRows).toHaveLength(10);
    expect(preview.unmatchedRows).toContainEqual(expect.objectContaining({ sourceName: "First999 Last999" }));
  });

  it("maps English fluency conservatively and ignores spreadsheet availability as scheduling truth", () => {
    const preview = buildTutorProfileImportPreview({
      educationRows: [educationRow(2)],
      availabilityRows: [availabilityRow(2)],
      activeProfiles: [activeProfile(2)],
      verifiedBy: "Kevin",
      lastReviewedAt: "2026-05-21T00:00:00.000Z",
    });

    expect(preview.rows).toHaveLength(1);
    expect(preview.rows[0].patch.englishProficiency).toBe("unknown");
    expect(preview.rows[0].patch.internalNotes).toMatch(/Wise remains the scheduling source of truth/);
    expect(preview.rows[0].patch.youngLearnerFit).toBe("comfortable");
    expect(preview.rows[0].patch.youngestComfortableAge).toBe(6);
    expect(preview.rows[0].patch.teachingStyleTags).toEqual(expect.arrayContaining(["patient", "structured"]));
  });

  it("uses active aliases to stabilize canonicalKey matching", () => {
    const aliases: TutorProfileImportAlias[] = [{ fromKey: "Kev", toKey: "Kevin" }];
    const preview = buildTutorProfileImportPreview({
      educationRows: [{ ...educationRow(1), firstName: "Kevin", lastName: "Hsieh" }],
      availabilityRows: [{ ...availabilityRow(1), nickname: "Kev", firstName: "Kevin", lastName: "Hsieh" }],
      activeProfiles: [activeProfile(1, { canonicalKey: "Kevin", displayName: "Kevin" })],
      aliases,
    });

    expect(preview.rows).toHaveLength(1);
    expect(preview.rows[0]).toMatchObject({
      canonicalKey: "Kevin",
      matchedBy: "alias",
      matchMethod: "availability.nickname -> alias",
    });
    expect(preview.rows[0].warnings.join(" ")).toMatch(/Missing canonicalKey/);
  });

  it("matches swapped legal first name and Wise nickname plus last name deterministically", () => {
    const activeIdentities: TutorProfileImportActiveIdentity[] = [{
      canonicalKey: "Key",
      displayName: "Key",
      wiseDisplayNames: ["Kieran (Key) Wilkinson Online", "Kieran (Key) Wilkinson"],
    }];
    const preview = buildTutorProfileImportPreview({
      educationRows: [],
      availabilityRows: [{
        ...availabilityRow(1),
        nickname: "Kieran",
        firstName: "Key",
        lastName: "Wilkinson",
      }],
      activeProfiles: [activeProfile(1, { canonicalKey: "Key", displayName: "Key" })],
      activeIdentities,
    });

    expect(preview.rows).toHaveLength(1);
    expect(preview.rows[0]).toMatchObject({
      canonicalKey: "Key",
      matchedBy: "wiseNicknameLastName",
      matchMethod: "availability.fullName -> wiseNicknameLastName",
    });
    expect(preview.rows[0].warnings).toContain("Availability/profile row has no matching education row.");
  });

  it("blocks ambiguous deterministic matches from commit rows", () => {
    const activeIdentities: TutorProfileImportActiveIdentity[] = [
      { canonicalKey: "Alex-One", displayName: "Alex One", wiseDisplayNames: ["Tutor (Alex) One"] },
      { canonicalKey: "Alex-Two", displayName: "Alex Two", wiseDisplayNames: ["Tutor (Alex) Two"] },
    ];
    const preview = buildTutorProfileImportPreview({
      educationRows: [],
      availabilityRows: [{ ...availabilityRow(1), nickname: "Alex", firstName: "Alex", lastName: "Tutor" }],
      activeProfiles: [
        activeProfile(1, { canonicalKey: "Alex-One", displayName: "Alex One" }),
        activeProfile(2, { canonicalKey: "Alex-Two", displayName: "Alex Two" }),
      ],
      activeIdentities,
    });

    expect(preview.rows).toHaveLength(0);
    expect(preview.summary.ambiguousRows).toBe(1);
    expect(preview.ambiguousRows[0]).toMatchObject({
      sourceName: "Alex | Alex Tutor",
      reason: expect.stringMatching(/Multiple active tutors/),
    });
    expect(preview.ambiguousRows[0].candidates?.map((candidate) => candidate.canonicalKey)).toEqual([
      "Alex-One",
      "Alex-Two",
    ]);
  });
});
