import { describe, expect, it } from "vitest";
import {
  generateSchedulerCandidateSlots,
  mergeSchedulerState,
  normalizeSchedulerExtraction,
  resolveSchedulerState,
  solveSchedulerTurn,
  type SchedulerExtractedState,
} from "@/lib/ai/scheduler-conversation";
import type { SearchIndex, IndexedTutorGroup } from "@/lib/search/index";
import type { ProposalHoldSummary } from "@/lib/proposals/types";
import type { TutorBusinessProfile } from "@/lib/tutor-business-profiles";

function group(overrides: Partial<IndexedTutorGroup> = {}): IndexedTutorGroup {
  return {
    id: overrides.id ?? "tutor-1",
    canonicalKey: overrides.canonicalKey ?? "kevin",
    displayName: overrides.displayName ?? "Kevin",
    supportedModes: overrides.supportedModes ?? ["online", "onsite"],
    qualifications: overrides.qualifications ?? [
      { subject: "English", curriculum: "International", level: "Year 5" },
    ],
    wiseRecords: overrides.wiseRecords ?? [
      { wiseTeacherId: "wise-1", wiseDisplayName: "Kevin", isOnline: false },
    ],
    availabilityWindows: overrides.availabilityWindows ?? [
      { weekday: 1, startMinute: 14 * 60, endMinute: 17 * 60, modality: "both", wiseTeacherId: "wise-1" },
      { weekday: 0, startMinute: 9 * 60, endMinute: 11 * 60, modality: "both", wiseTeacherId: "wise-1" },
    ],
    leaves: overrides.leaves ?? [],
    sessionBlocks: overrides.sessionBlocks ?? [],
    dataIssues: overrides.dataIssues ?? [],
    businessProfile: overrides.businessProfile,
  };
}

function index(groups: IndexedTutorGroup[] = [group()]): SearchIndex {
  const byWeekday = new Map<number, IndexedTutorGroup[]>();
  for (const item of groups) {
    for (const window of item.availabilityWindows) {
      const existing = byWeekday.get(window.weekday) ?? [];
      if (!existing.some((candidate) => candidate.id === item.id)) {
        existing.push(item);
      }
      byWeekday.set(window.weekday, existing);
    }
  }
  return {
    snapshotId: "snap-1",
    profileVersion: "0:",
    builtAt: new Date("2026-05-18T00:00:00.000Z"),
    syncedAt: new Date("2026-05-18T00:00:00.000Z"),
    tutorGroups: groups,
    byWeekday,
  };
}

function hold(overrides: Partial<ProposalHoldSummary> = {}): ProposalHoldSummary {
  return {
    itemId: overrides.itemId ?? "hold-1",
    bundleId: overrides.bundleId ?? "bundle-1",
    studentLabel: overrides.studentLabel ?? "Ava",
    notes: overrides.notes,
    tutorGroupId: overrides.tutorGroupId ?? "tutor-1",
    tutorCanonicalKey: overrides.tutorCanonicalKey ?? "kevin",
    tutorDisplayName: overrides.tutorDisplayName ?? "Kevin",
    scope: overrides.scope ?? "recurring",
    weekday: overrides.weekday ?? 1,
    date: overrides.date,
    startMinute: overrides.startMinute ?? 15 * 60,
    endMinute: overrides.endMinute ?? 16 * 60,
    startTime: overrides.startTime ?? "15:00",
    endTime: overrides.endTime ?? "16:00",
    subject: overrides.subject,
    curriculum: overrides.curriculum,
    level: overrides.level,
    status: overrides.status ?? "pending",
    createdByEmail: overrides.createdByEmail,
    createdByName: overrides.createdByName,
    createdAt: overrides.createdAt ?? "2026-05-18T00:00:00.000Z",
    expiresAt: overrides.expiresAt ?? "2026-05-20T00:00:00.000Z",
    confirmedAt: overrides.confirmedAt,
  };
}

function businessProfile(overrides: Partial<TutorBusinessProfile> = {}): TutorBusinessProfile {
  return {
    canonicalKey: overrides.canonicalKey ?? "profile",
    displayName: overrides.displayName ?? "Profile Tutor",
    parentSafeSummary: overrides.parentSafeSummary ?? "",
    internalNotes: overrides.internalNotes ?? "",
    education: overrides.education ?? [],
    languages: overrides.languages ?? [],
    englishProficiency: overrides.englishProficiency ?? "unknown",
    youngLearnerFit: overrides.youngLearnerFit ?? "unknown",
    youngestComfortableAge: overrides.youngestComfortableAge ?? null,
    youngLearnerNotes: overrides.youngLearnerNotes ?? "",
    teachingStyleTags: overrides.teachingStyleTags ?? [],
    teachingStyleNotes: overrides.teachingStyleNotes ?? "",
    strengthTags: overrides.strengthTags ?? [],
    curriculumExperience: overrides.curriculumExperience ?? [],
    studentFitNotes: overrides.studentFitNotes ?? "",
    doNotUseForNotes: overrides.doNotUseForNotes ?? "",
    verifiedBy: overrides.verifiedBy ?? "Kevin",
    lastReviewedAt: overrides.lastReviewedAt ?? "2026-05-20T00:00:00.000Z",
    active: overrides.active ?? true,
    updatedAt: overrides.updatedAt ?? "2026-05-20T00:00:00.000Z",
  };
}

const filters = {
  subjects: ["English", "EnglishVR", "EFL", "ESL", "Literature", "Math", "Econ", "NonVR", "Science"],
  curriculums: ["International"],
  levels: ["Y2-8", "Y9-11", "G10-12", "11+/13+"],
};

const tutors = [
  { tutorGroupId: "tutor-1", displayName: "Kevin", supportedModes: ["online", "onsite"], subjects: ["English"] },
  { tutorGroupId: "tutor-2", displayName: "Anna", supportedModes: ["online"], subjects: ["Math"] },
  { tutorGroupId: "tutor-3", displayName: "Anne", supportedModes: ["onsite"], subjects: ["English"] },
  { tutorGroupId: "tutor-4", displayName: "June", supportedModes: ["onsite"], subjects: ["NonVR"] },
  { tutorGroupId: "science-1", displayName: "Science Tutor", supportedModes: ["onsite"], subjects: ["Science"] },
];

function modelExtraction(overrides: Record<string, unknown> = {}) {
  return {
    searchMode: "recurring",
    dayOfWeek: null,
    date: null,
    startTime: null,
    endTime: null,
    durationMinutes: null,
    mode: null,
    filters: { subject: null, curriculum: null, level: null },
    subjectRequests: [],
    businessRequirements: {
      englishProficiency: null,
      youngLearnerAge: null,
      strengthTags: [],
      curriculumExperience: [],
      teachingStyleTags: [],
      schoolKeywords: [],
    },
    dateRange: null,
    requestedSlots: [],
    explicitUnknownFilters: [],
    explicitUnknownBusinessRequirements: [],
    tutorNames: [],
    tutorExclusions: [],
    parentName: null,
    studentName: null,
    contact: null,
    negativeFeedback: false,
    assumptions: [],
    unresolvedQuestions: [],
    parentRequestSummary: null,
    title: null,
    ...overrides,
  };
}

describe("conversational scheduler helpers", () => {
  it("defaults missing duration/mode and broad-searches weekday after 15:00 plus weekend availability", () => {
    const state = resolveSchedulerState({});
    const generated = generateSchedulerCandidateSlots(index(), state);

    expect(state.durationMinutes).toBe(60);
    expect(state.mode).toBe("either");
    expect(generated.slots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dayOfWeek: 1, start: "15:00", end: "16:00" }),
        expect.objectContaining({ dayOfWeek: 0, start: "09:00", end: "10:00" }),
      ]),
    );
    expect(generated.slots).not.toContainEqual(expect.objectContaining({ dayOfWeek: 1, start: "14:00" }));
  });

  it("keeps suggestions tentative when an explicit qualification is unmapped", () => {
    const result = solveSchedulerTurn({
      index: index(),
      extractedState: {
        dayOfWeek: 1,
        startTime: "15:00",
        endTime: "17:00",
        filters: { subject: "Physics" },
      },
      filterOptions: filters,
      tutorList: tutors,
      activeProposalHolds: [],
    });

    expect(result.parentReady).toBe(false);
    expect(result.questions.join(" ")).toMatch(/Physics/);
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(result.suggestions[0].parentReady).toBe(false);
  });

  it("asks about ambiguous tutor names without blocking broad timing suggestions", () => {
    const groups = [
      group({ id: "tutor-2", canonicalKey: "anna", displayName: "Anna" }),
      group({ id: "tutor-3", canonicalKey: "anne", displayName: "Anne" }),
    ];
    const result = solveSchedulerTurn({
      index: index(groups),
      extractedState: {
        dayOfWeek: 1,
        startTime: "15:00",
        endTime: "17:00",
        tutorNames: ["Ann"],
      },
      filterOptions: filters,
      tutorList: tutors,
      activeProposalHolds: [],
    });

    expect(result.parentReady).toBe(false);
    expect(result.questions[0]).toMatch(/Which Ann/);
    expect(result.suggestions[0].availableTutorCount).toBe(2);
  });

  it("suppresses tutors whose slot is blocked by an active proposal hold", () => {
    const result = solveSchedulerTurn({
      index: index(),
      extractedState: {
        dayOfWeek: 1,
        startTime: "15:00",
        endTime: "16:00",
      } satisfies SchedulerExtractedState,
      filterOptions: filters,
      tutorList: tutors,
      activeProposalHolds: [hold()],
    });

    expect(result.suggestions).toHaveLength(0);
    expect(result.warnings.join(" ")).toMatch(/proposal holds/);
  });

  it("normalizes multi-slot extraction for Care KT's Thai Econ request", () => {
    const extraction = normalizeSchedulerExtraction(modelExtraction({
      filters: { subject: "Econ", curriculum: null, level: "Y9-11" },
      requestedSlots: [
        {
          id: "fri",
          searchMode: "recurring",
          dayOfWeek: 5,
          date: null,
          startTime: "18:30",
          endTime: "19:30",
          durationMinutes: 60,
        },
        {
          id: "sat",
          searchMode: "recurring",
          dayOfWeek: 6,
          date: null,
          startTime: "13:00",
          endTime: "14:00",
          durationMinutes: 60,
        },
      ],
      studentName: "เอิง",
    }));

    expect(extraction.state.requestedSlots).toEqual([
      expect.objectContaining({ id: "fri", dayOfWeek: 5, startTime: "18:30", endTime: "19:30" }),
      expect.objectContaining({ id: "sat", dayOfWeek: 6, startTime: "13:00", endTime: "14:00" }),
    ]);
  });

  it("searches only requested slots for Care KT's Friday/Saturday Econ request", () => {
    const fridayTutor = group({
      id: "econ-fri",
      canonicalKey: "econ-fri",
      displayName: "Friday Econ",
      qualifications: [{ subject: "Econ", curriculum: "International", level: "Y9-11" }],
      availabilityWindows: [
        { weekday: 5, startMinute: 18 * 60, endMinute: 20 * 60, modality: "both", wiseTeacherId: "wise-fri" },
      ],
    });
    const saturdayTutor = group({
      id: "econ-sat",
      canonicalKey: "econ-sat",
      displayName: "Saturday Econ",
      qualifications: [{ subject: "Econ", curriculum: "International", level: "Y9-11" }],
      availabilityWindows: [
        { weekday: 6, startMinute: 13 * 60, endMinute: 15 * 60, modality: "both", wiseTeacherId: "wise-sat" },
      ],
    });
    const broadTuesdayTutor = group({
      id: "econ-tue",
      canonicalKey: "econ-tue",
      displayName: "Tuesday Econ",
      qualifications: [{ subject: "Econ", curriculum: "International", level: "Y9-11" }],
      availabilityWindows: [
        { weekday: 2, startMinute: 17 * 60, endMinute: 19 * 60, modality: "both", wiseTeacherId: "wise-tue" },
      ],
    });

    const result = solveSchedulerTurn({
      index: index([fridayTutor, saturdayTutor, broadTuesdayTutor]),
      extractedState: {
        searchMode: "recurring",
        durationMinutes: 60,
        filters: { subject: "Econ", level: "Y9-11" },
        requestedSlots: [
          { id: "fri", searchMode: "recurring", dayOfWeek: 5, startTime: "18:30", endTime: "19:30", durationMinutes: 60 },
          { id: "sat", searchMode: "recurring", dayOfWeek: 6, startTime: "13:00", endTime: "14:00", durationMinutes: 60 },
        ],
      },
      filterOptions: filters,
      tutorList: tutors,
      activeProposalHolds: [],
    });

    expect(result.parentReady).toBe(true);
    expect(result.suggestions.map((suggestion) => ({
      dayOfWeek: suggestion.dayOfWeek,
      start: suggestion.start,
      end: suggestion.end,
    }))).toEqual([
      { dayOfWeek: 5, start: "18:30", end: "19:30" },
      { dayOfWeek: 6, start: "13:00", end: "14:00" },
    ]);
    expect(result.parentMessageDraft).not.toMatch(/Tuesday/);
  });

  it("maps raw Y10 scheduler filters to the active Y9-11 Wise level", () => {
    const result = solveSchedulerTurn({
      index: index([
        group({
          id: "econ-fri",
          canonicalKey: "econ-fri",
          displayName: "Friday Econ",
          qualifications: [{ subject: "Econ", curriculum: "International", level: "Y9-11" }],
          availabilityWindows: [
            { weekday: 5, startMinute: 18 * 60, endMinute: 20 * 60, modality: "both", wiseTeacherId: "wise-fri" },
          ],
        }),
      ]),
      extractedState: {
        searchMode: "recurring",
        durationMinutes: 60,
        filters: { subject: "Econ", curriculum: "International", level: "Y10" },
        requestedSlots: [
          { searchMode: "recurring", dayOfWeek: 5, startTime: "18:30", endTime: "19:30", durationMinutes: 60 },
        ],
      },
      filterOptions: filters,
      tutorList: tutors,
      activeProposalHolds: [],
    });

    expect(result.parentReady).toBe(true);
    expect(result.state.filters.level).toBe("Y9-11");
    expect(result.state.academicLevelResolution).toMatchObject({
      rawLevelLabel: "Y10",
      wiseLevel: "Y9-11",
      status: "mapped",
    });
    expect(result.questions.join(" ")).not.toMatch(/Y10.*not an active Wise qualification/);
  });

  it("asks for curriculum when Grade 10 could be International or Thai", () => {
    const result = solveSchedulerTurn({
      index: index(),
      extractedState: {
        searchMode: "recurring",
        dayOfWeek: 1,
        startTime: "15:00",
        endTime: "16:00",
        filters: { subject: "Econ", level: "Grade 10" },
      },
      filterOptions: filters,
      tutorList: tutors,
      activeProposalHolds: [],
    });

    expect(result.parentReady).toBe(false);
    expect(result.questions.join(" ")).toMatch(/Y9-11 or G10-12/);
  });

  it("filters by verified fluent English tutor profile requirements", () => {
    const fluentTutor = group({
      id: "fluent",
      canonicalKey: "fluent",
      displayName: "Fluent Tutor",
      businessProfile: {
        canonicalKey: "fluent",
        displayName: "Fluent Tutor",
        parentSafeSummary: "Confident English communicator.",
        internalNotes: "",
        education: [],
        languages: [{ language: "English", proficiency: "Fluent", verificationSource: "admin" }],
        englishProficiency: "fluent",
        youngLearnerFit: "unknown",
        youngestComfortableAge: null,
        youngLearnerNotes: "",
        teachingStyleTags: [],
        teachingStyleNotes: "",
        strengthTags: ["writing"],
        curriculumExperience: ["International"],
        studentFitNotes: "",
        doNotUseForNotes: "",
        verifiedBy: "Kevin",
        lastReviewedAt: "2026-05-20T00:00:00.000Z",
        active: true,
        updatedAt: "2026-05-20T00:00:00.000Z",
      },
    });
    const unknownTutor = group({
      id: "unknown",
      canonicalKey: "unknown",
      displayName: "Unknown Tutor",
    });

    const result = solveSchedulerTurn({
      index: index([fluentTutor, unknownTutor]),
      extractedState: {
        searchMode: "recurring",
        dayOfWeek: 1,
        startTime: "15:00",
        endTime: "16:00",
        businessRequirements: { englishProficiency: "fluent" },
      },
      filterOptions: filters,
      tutorList: tutors,
      activeProposalHolds: [],
    });

    expect(result.suggestions[0].tutors.map((tutor) => tutor.displayName)).toEqual(["Fluent Tutor"]);
  });

  it("does not return missing tutor profile context as a positive match", () => {
    const result = solveSchedulerTurn({
      index: index([
        group({
          id: "unknown",
          canonicalKey: "unknown",
          displayName: "Unknown Tutor",
        }),
      ]),
      extractedState: {
        searchMode: "recurring",
        dayOfWeek: 1,
        startTime: "15:00",
        endTime: "16:00",
        businessRequirements: { englishProficiency: "fluent" },
      },
      filterOptions: filters,
      tutorList: tutors,
      activeProposalHolds: [],
    });

    expect(result.suggestions).toHaveLength(0);
    expect(result.warnings.join(" ")).toMatch(/verified tutor profile requirements/);
  });

  it("hard-filters young learner requests only against verified compatible age profile data", () => {
    const youngLearnerTutor = group({
      id: "young-fit",
      canonicalKey: "young-fit",
      displayName: "Young Fit Tutor",
      businessProfile: {
        canonicalKey: "young-fit",
        displayName: "Young Fit Tutor",
        parentSafeSummary: "",
        internalNotes: "",
        education: [],
        languages: [],
        englishProficiency: "unknown",
        youngLearnerFit: "comfortable",
        youngestComfortableAge: 6,
        youngLearnerNotes: "Verified primary learner fit.",
        teachingStyleTags: [],
        teachingStyleNotes: "",
        strengthTags: [],
        curriculumExperience: [],
        studentFitNotes: "",
        doNotUseForNotes: "",
        verifiedBy: "Kevin",
        lastReviewedAt: "2026-05-20T00:00:00.000Z",
        active: true,
        updatedAt: "2026-05-20T00:00:00.000Z",
      },
    });
    const olderOnlyTutor = group({
      id: "older-only",
      canonicalKey: "older-only",
      displayName: "Older Only Tutor",
      businessProfile: {
        canonicalKey: "older-only",
        displayName: "Older Only Tutor",
        parentSafeSummary: "",
        internalNotes: "",
        education: [],
        languages: [],
        englishProficiency: "unknown",
        youngLearnerFit: "comfortable",
        youngestComfortableAge: 12,
        youngLearnerNotes: "",
        teachingStyleTags: [],
        teachingStyleNotes: "",
        strengthTags: [],
        curriculumExperience: [],
        studentFitNotes: "",
        doNotUseForNotes: "",
        verifiedBy: "Kevin",
        lastReviewedAt: "2026-05-20T00:00:00.000Z",
        active: true,
        updatedAt: "2026-05-20T00:00:00.000Z",
      },
    });

    const result = solveSchedulerTurn({
      index: index([olderOnlyTutor, youngLearnerTutor, group({ id: "missing-profile", canonicalKey: "missing-profile", displayName: "Missing Profile" })]),
      extractedState: {
        searchMode: "recurring",
        dayOfWeek: 1,
        startTime: "15:00",
        endTime: "16:00",
        businessRequirements: { youngLearnerAge: 8 },
      },
      filterOptions: filters,
      tutorList: tutors,
      activeProposalHolds: [],
    });

    expect(result.suggestions[0].tutors.map((tutor) => tutor.displayName)).toEqual(["Young Fit Tutor"]);
  });

  it("uses teaching style as ranking context without filtering unmatched tutors", () => {
    const structuredTutor = group({
      id: "structured",
      canonicalKey: "structured",
      displayName: "Structured Tutor",
      businessProfile: {
        canonicalKey: "structured",
        displayName: "Structured Tutor",
        parentSafeSummary: "",
        internalNotes: "",
        education: [],
        languages: [],
        englishProficiency: "unknown",
        youngLearnerFit: "unknown",
        youngestComfortableAge: null,
        youngLearnerNotes: "",
        teachingStyleTags: ["patient", "structured"],
        teachingStyleNotes: "",
        strengthTags: [],
        curriculumExperience: [],
        studentFitNotes: "",
        doNotUseForNotes: "",
        verifiedBy: "Kevin",
        lastReviewedAt: "2026-05-20T00:00:00.000Z",
        active: true,
        updatedAt: "2026-05-20T00:00:00.000Z",
      },
    });
    const genericTutor = group({
      id: "generic",
      canonicalKey: "generic",
      displayName: "Generic Tutor",
    });

    const result = solveSchedulerTurn({
      index: index([genericTutor, structuredTutor]),
      extractedState: {
        searchMode: "recurring",
        dayOfWeek: 1,
        startTime: "15:00",
        endTime: "16:00",
        businessRequirements: { teachingStyleTags: ["patient", "structured"] },
      },
      filterOptions: filters,
      tutorList: tutors,
      activeProposalHolds: [],
    });

    expect(result.suggestions[0].tutors.map((tutor) => tutor.displayName)).toEqual([
      "Structured Tutor",
      "Generic Tutor",
    ]);
    expect(result.suggestions[0].reasons.join(" ")).toMatch(/Teaching style/);
  });

  it("ranks structured profile signals ahead of note-derived and generic tutor evidence", () => {
    const qualification = [{ subject: "English", curriculum: "International", level: "Y2-8" }];
    const structuredTutor = group({
      id: "structured-profile",
      canonicalKey: "structured-profile",
      displayName: "Structured Profile",
      qualifications: qualification,
      businessProfile: businessProfile({
        canonicalKey: "structured-profile",
        displayName: "Structured Profile",
        englishProficiency: "fluent",
        strengthTags: ["writing"],
        curriculumExperience: ["International"],
        teachingStyleTags: ["patient"],
      }),
    });
    const notesTutor = group({
      id: "notes-profile",
      canonicalKey: "notes-profile",
      displayName: "Notes Profile",
      qualifications: qualification,
      businessProfile: businessProfile({
        canonicalKey: "notes-profile",
        displayName: "Notes Profile",
        internalNotes: "Good for writing support and patient lesson pacing.",
      }),
    });
    const genericTutor = group({
      id: "generic-profile",
      canonicalKey: "generic-profile",
      displayName: "Generic Profile",
      qualifications: qualification,
    });

    const result = solveSchedulerTurn({
      index: index([genericTutor, notesTutor, structuredTutor]),
      extractedState: {
        searchMode: "recurring",
        dayOfWeek: 1,
        startTime: "15:00",
        endTime: "16:00",
        filters: { subject: "English", curriculum: "International", level: "Y2-8" },
        businessRequirements: { strengthTags: ["writing"], teachingStyleTags: ["patient"] },
      },
      filterOptions: filters,
      tutorList: tutors,
      activeProposalHolds: [],
    });

    expect(result.suggestions[0].tutors.map((tutor) => tutor.displayName)).toEqual([
      "Structured Profile",
      "Notes Profile",
      "Generic Profile",
    ]);
    expect(result.suggestions[0].tutors[0].profileEvidence?.join(" ")).toMatch(/profile: Profile strength: writing/);
    expect(result.suggestions[0].tutors[1].profileEvidence?.join(" ")).toMatch(/notes: Profile notes mention strength: writing/);
  });

  it("keeps profile caution matches out of available suggestions without treating unrelated caution notes as availability proof", () => {
    const qualification = [{ subject: "English", curriculum: "International", level: "Y2-8" }];
    const writingCautionTutor = group({
      id: "writing-caution",
      canonicalKey: "writing-caution",
      displayName: "Writing Caution",
      qualifications: qualification,
      businessProfile: businessProfile({
        canonicalKey: "writing-caution",
        displayName: "Writing Caution",
        doNotUseForNotes: "Do not use for writing requests.",
      }),
    });
    const unrelatedCautionTutor = group({
      id: "unrelated-caution",
      canonicalKey: "unrelated-caution",
      displayName: "Unrelated Caution",
      qualifications: qualification,
      businessProfile: businessProfile({
        canonicalKey: "unrelated-caution",
        displayName: "Unrelated Caution",
        doNotUseForNotes: "Avoid for IELTS test prep.",
      }),
    });

    const result = solveSchedulerTurn({
      index: index([writingCautionTutor, unrelatedCautionTutor]),
      extractedState: {
        searchMode: "recurring",
        dayOfWeek: 1,
        startTime: "15:00",
        endTime: "16:00",
        filters: { subject: "English", curriculum: "International", level: "Y2-8" },
        businessRequirements: { strengthTags: ["writing"] },
      },
      filterOptions: filters,
      tutorList: tutors,
      activeProposalHolds: [],
    });

    expect(result.suggestions[0].tutors.map((tutor) => tutor.displayName)).toEqual(["Unrelated Caution"]);
    expect(result.suggestions[0].tutors[0].profileEvidence?.join(" ")).toMatch(/notes: Profile caution note present/);
  });

  it("splits a requested time window into bounded sub-slots only inside that window", () => {
    const result = solveSchedulerTurn({
      index: index([
        group({
          id: "english-sat",
          canonicalKey: "english-sat",
          displayName: "Saturday English",
          qualifications: [{ subject: "English", curriculum: "International", level: "Year 5" }],
          availabilityWindows: [
            { weekday: 6, startMinute: 8 * 60, endMinute: 13 * 60, modality: "onsite", wiseTeacherId: "wise-sat" },
          ],
        }),
      ]),
      extractedState: {
        searchMode: "recurring",
        mode: "onsite",
        durationMinutes: 60,
        filters: { subject: "English" },
        requestedSlots: [
          { id: "sat-window", searchMode: "recurring", dayOfWeek: 6, startTime: "09:00", endTime: "12:00", durationMinutes: 60 },
        ],
      },
      filterOptions: filters,
      tutorList: tutors,
      activeProposalHolds: [],
    });

    expect(result.suggestions.map((suggestion) => suggestion.start)).toEqual([
      "09:00",
      "09:30",
      "10:00",
      "10:30",
      "11:00",
    ]);
    expect(result.suggestions).not.toContainEqual(expect.objectContaining({ start: "08:30" }));
    expect(result.suggestions).not.toContainEqual(expect.objectContaining({ start: "11:30" }));
    expect(new Set(result.suggestions.map((suggestion) => suggestion.requestedSlotId))).toEqual(new Set(["sat-window"]));
  });

  it("does not broad-search when extracted prose mentions slots but structured fields are missing", () => {
    const result = solveSchedulerTurn({
      index: index([
        group({
          id: "econ-tue",
          canonicalKey: "econ-tue",
          displayName: "Tuesday Econ",
          qualifications: [{ subject: "Econ", curriculum: "International", level: "Y9-11" }],
          availabilityWindows: [
            { weekday: 2, startMinute: 17 * 60, endMinute: 19 * 60, modality: "both", wiseTeacherId: "wise-tue" },
          ],
        }),
      ]),
      extractedState: {
        searchMode: "recurring",
        durationMinutes: 60,
        filters: { subject: "Econ", level: "Y9-11" },
        assumptions: ["Times: Fri 18:30-19:30 and Sat 13:00-14:00 (Asia/Bangkok)"],
        parentRequestSummary: "Econ recurring weekly on Fridays 18:30-19:30 and Saturdays 13:00-14:00",
      },
      filterOptions: filters,
      tutorList: tutors,
      activeProposalHolds: [],
    });

    expect(result.parentReady).toBe(false);
    expect(result.suggestions).toHaveLength(0);
    expect(result.questions.join(" ")).toMatch(/could not safely structure/);
    expect(result.constraintLedger).toContainEqual(expect.objectContaining({
      key: "slot",
      status: "needs_clarification",
    }));
  });

  it("does not broad-search a day-only request without a start time", () => {
    const result = solveSchedulerTurn({
      index: index([
        group({
          id: "saturday",
          canonicalKey: "saturday",
          displayName: "Saturday Tutor",
          availabilityWindows: [
            { weekday: 6, startMinute: 9 * 60, endMinute: 20 * 60, modality: "onsite", wiseTeacherId: "wise-sat" },
          ],
        }),
      ]),
      extractedState: {
        searchMode: "recurring",
        dayOfWeek: 6,
        mode: "onsite",
      },
      filterOptions: filters,
      tutorList: tutors,
      activeProposalHolds: [],
    });

    expect(result.parentReady).toBe(false);
    expect(result.suggestions).toHaveLength(0);
    expect(result.questions.join(" ")).toMatch(/start time/);
  });

  it("repairs one-time weekday extraction without an exact date before slot resolution", () => {
    const result = solveSchedulerTurn({
      index: index([
        group({
          id: "math-sun",
          canonicalKey: "math-sun",
          displayName: "Sunday Math",
          qualifications: [{ subject: "Math", curriculum: "International", level: "Year 5" }],
          availabilityWindows: [
            { weekday: 0, startMinute: 12 * 60, endMinute: 13 * 60, modality: "both", wiseTeacherId: "wise-sun" },
          ],
        }),
      ]),
      extractedState: {
        searchMode: "one_time",
        dayOfWeek: 0,
        startTime: "12:00",
        filters: { subject: "Math" },
      },
      filterOptions: filters,
      tutorList: tutors,
      activeProposalHolds: [],
    });

    expect(result.parentReady).toBe(true);
    expect(result.state.searchMode).toBe("recurring");
    expect(result.suggestions[0]).toMatchObject({ searchMode: "recurring", dayOfWeek: 0, start: "12:00", end: "13:00" });
  });

  it("treats exact start plus default duration as one exact slot", () => {
    const result = solveSchedulerTurn({
      index: index([
        group({
          availabilityWindows: [
            { weekday: 0, startMinute: 18 * 60, endMinute: 20 * 60, modality: "both", wiseTeacherId: "wise-1" },
          ],
        }),
      ]),
      extractedState: {
        searchMode: "recurring",
        dayOfWeek: 0,
        startTime: "18:00",
      },
      filterOptions: filters,
      tutorList: tutors,
      activeProposalHolds: [],
    });

    expect(result.suggestions[0]).toMatchObject({ dayOfWeek: 0, start: "18:00", end: "19:00" });
    expect(result.suggestions).not.toContainEqual(expect.objectContaining({ start: "19:00" }));
  });

  it("resets stale scheduling state for a new student/class request", () => {
    const merged = mergeSchedulerState(
      {
        studentName: "Henry",
        filters: { subject: "Math" },
        requestedSlots: [{ searchMode: "recurring", dayOfWeek: 6, startTime: "10:00", endTime: "11:00" }],
        unresolvedQuestions: ["Please confirm Year 5."],
      },
      {
        studentName: "Ing Ing",
        filters: { subject: "English" },
        requestedSlots: [{ searchMode: "recurring", dayOfWeek: 0, startTime: "09:00", endTime: "12:00" }],
        unresolvedQuestions: ["Which day is preferred?"],
      },
    );

    expect(merged.studentName).toBe("Ing Ing");
    expect(merged.filters).toEqual({ subject: "English" });
    expect(merged.requestedSlots).toEqual([
      expect.objectContaining({ dayOfWeek: 0, startTime: "09:00" }),
    ]);
    expect(merged.unresolvedQuestions).toEqual(["Which day is preferred?"]);
  });

  it("excludes replacement tutors instead of suggesting them", () => {
    const result = solveSchedulerTurn({
      index: index([
        group({
          id: "tutor-4",
          canonicalKey: "june",
          displayName: "June",
          qualifications: [{ subject: "NonVR", curriculum: "International", level: "Year 5" }],
          availabilityWindows: [
            { weekday: 6, startMinute: 13 * 60, endMinute: 14 * 60, modality: "onsite", wiseTeacherId: "wise-june" },
          ],
        }),
        group({
          id: "replacement",
          canonicalKey: "replacement",
          displayName: "Replacement Tutor",
          supportedModes: ["onsite"],
          qualifications: [{ subject: "NonVR", curriculum: "International", level: "Year 5" }],
          availabilityWindows: [
            { weekday: 6, startMinute: 13 * 60, endMinute: 14 * 60, modality: "onsite", wiseTeacherId: "wise-replacement" },
          ],
        }),
      ]),
      extractedState: {
        searchMode: "recurring",
        mode: "onsite",
        filters: { subject: "NonVR" },
        requestedSlots: [{ searchMode: "recurring", dayOfWeek: 6, startTime: "13:00", endTime: "14:00" }],
        tutorExclusions: ["June"],
      },
      filterOptions: filters,
      tutorList: tutors,
      activeProposalHolds: [],
    });

    expect(result.suggestions[0].tutors.map((tutor) => tutor.displayName)).toEqual(["Replacement Tutor"]);
  });

  it("turns negative feedback into clarification instead of repeating suggestions", () => {
    const result = solveSchedulerTurn({
      index: index(),
      extractedState: {
        negativeFeedback: true,
        searchMode: "recurring",
        dayOfWeek: 1,
        startTime: "15:00",
        endTime: "16:00",
      },
      filterOptions: filters,
      tutorList: tutors,
      activeProposalHolds: [],
    });

    expect(result.parentReady).toBe(false);
    expect(result.suggestions).toHaveLength(0);
    expect(result.questions[0]).toMatch(/What should I change/);
  });

  it("expands first-week July prose to 2026-07-01 through 2026-07-07", () => {
    const state = resolveSchedulerState({
      parentRequestSummary: "หาครูสอนวิชา writing y6 ช่วง Week แรกของ July",
      filters: { subject: "Writing", level: "Y6" },
    });

    expect(state.dateRange).toEqual({ startDate: "2026-07-01", endDate: "2026-07-07" });
    expect(state.durationMinutes).toBe(60);
    expect(state.requestedSlots).toEqual([]);
  });

  it("maps Writing Y6 to English-family International Y2-8 for scheduler searches", () => {
    const result = solveSchedulerTurn({
      index: index([
        group({
          id: "efl-available",
          canonicalKey: "efl-available",
          displayName: "Available EFL",
          qualifications: [{ subject: "EFL", curriculum: "International", level: "Y2-8" }],
          availabilityWindows: [
            { weekday: 3, startMinute: 10 * 60, endMinute: 11 * 60, modality: "both", wiseTeacherId: "wise-english" },
          ],
        }),
        group({
          id: "esl-available",
          canonicalKey: "esl-available",
          displayName: "Available ESL",
          qualifications: [{ subject: "ESL", curriculum: "International", level: "Y2-8" }],
          availabilityWindows: [
            { weekday: 3, startMinute: 10 * 60, endMinute: 11 * 60, modality: "both", wiseTeacherId: "wise-esl" },
          ],
        }),
      ]),
      extractedState: {
        searchMode: "one_time",
        mode: "either",
        filters: { subject: "Writing", level: "Y6" },
        dateRange: { startDate: "2026-07-01", endDate: "2026-07-07" },
      },
      filterOptions: filters,
      tutorList: tutors,
      activeProposalHolds: [],
    });

    expect(result.state.filters).toMatchObject({ subject: "EFL", curriculum: "International", level: "Y2-8" });
    expect(result.state.subjectIntent).toMatchObject({
      family: "english",
      label: "English-family",
      canonicalSubjects: ["EFL", "ESL"],
      skillTags: ["writing"],
      curriculum: "International",
      level: "Y2-8",
    });
    expect(result.state.subjectRequests).toEqual([
      { subject: "EFL", curriculum: "International", level: "Y2-8" },
      { subject: "ESL", curriculum: "International", level: "Y2-8" },
    ]);
    expect(result.availabilitySummary?.searchedFilters).toEqual(result.state.subjectRequests);
    expect(result.availabilitySummary?.tutors.map((tutor) => tutor.displayName)).toEqual(["Available EFL", "Available ESL"]);
    expect(result.assistantMessage).toMatch(/EFL, ESL Y2-8 International/);
  });

  it("handles the Thai Writing Y6 first-week July request without model-provided filters", () => {
    const result = solveSchedulerTurn({
      index: index([
        group({
          id: "efl-available",
          canonicalKey: "efl-available",
          displayName: "Available EFL",
          qualifications: [{ subject: "EFL", curriculum: "International", level: "Y2-8" }],
          availabilityWindows: [
            { weekday: 3, startMinute: 10 * 60, endMinute: 11 * 60, modality: "both", wiseTeacherId: "wise-english" },
          ],
        }),
      ]),
      extractedState: {
        searchMode: "one_time",
      },
      sourceText: "หาครูสอนวิชา writing y6 ช่วง Week แรกของ July",
      filterOptions: filters,
      tutorList: tutors,
      activeProposalHolds: [],
    });

    expect(result.parentReady).toBe(true);
    expect(result.questions).toEqual([]);
    expect(result.state.dateRange).toEqual({ startDate: "2026-07-01", endDate: "2026-07-07" });
    expect(result.state.subjectIntent).toMatchObject({
      label: "English-family",
      canonicalSubjects: ["EFL"],
      curriculum: "International",
      level: "Y2-8",
      skillTags: ["writing"],
    });
    expect(result.availabilitySummary?.tutors.map((tutor) => tutor.displayName)).toEqual(["Available EFL"]);
  });

  it("recovers Mon-Sun 10:00 AM-6:00 PM prose into structured recurring slots", () => {
    const state = resolveSchedulerState({
      parentRequestSummary: "Need a writing tutor for Y6 in July 2026, available Mon-Sun 10:00 AM-6:00 PM.",
      filters: { subject: "Writing", level: "Y6" },
      dateRange: { startDate: "2026-07-01", endDate: "2026-07-31" },
    });

    expect(state.requestedSlots).toHaveLength(7);
    expect(state.requestedSlots.map((slot) => slot.dayOfWeek)).toEqual([1, 2, 3, 4, 5, 6, 0]);
    expect(state.requestedSlots[0]).toMatchObject({ startTime: "10:00", endTime: "18:00", durationMinutes: 60 });
  });

  it("prefers explicit Mon-Sun recurring prose over stale one-time date-range slots", () => {
    const state = resolveSchedulerState({
      searchMode: "one_time",
      parentRequestSummary: "Need a writing tutor for Y6 in July 2026, available Mon-Sun 10:00 AM-6:00 PM.",
      filters: { subject: "Writing", level: "Y6" },
      dateRange: { startDate: "2026-07-01", endDate: "2026-07-07" },
      requestedSlots: [
        { searchMode: "one_time", date: "2026-07-01", startTime: "10:00", endTime: "18:00" },
        { searchMode: "one_time", date: "2026-07-02", startTime: "10:00", endTime: "18:00" },
        { searchMode: "one_time", date: "2026-07-03", startTime: "10:00", endTime: "18:00" },
        { searchMode: "one_time", date: "2026-07-04", startTime: "10:00", endTime: "18:00" },
        { searchMode: "one_time", date: "2026-07-05", startTime: "10:00", endTime: "18:00" },
        { searchMode: "one_time", date: "2026-07-06", startTime: "10:00", endTime: "18:00" },
        { searchMode: "one_time", date: "2026-07-07", startTime: "10:00", endTime: "18:00" },
      ],
    });

    expect(state.requestedSlots).toHaveLength(7);
    expect(state.requestedSlots.every((slot) => slot.searchMode === "recurring")).toBe(true);
    expect(state.requestedSlots.map((slot) => slot.dayOfWeek)).toEqual([1, 2, 3, 4, 5, 6, 0]);
  });

  it("recovers date-range time-window prose into one-time slots", () => {
    const state = resolveSchedulerState({
      searchMode: "one_time",
      parentRequestSummary: "Ellen Emma onsite Math/English/Science, May 30-June 3, 09:00-12:00.",
      filters: { subject: "Math" },
      dateRange: { startDate: "2026-05-30", endDate: "2026-06-03" },
    });

    expect(state.requestedSlots).toHaveLength(5);
    expect(state.requestedSlots.map((slot) => slot.date)).toEqual([
      "2026-05-30",
      "2026-05-31",
      "2026-06-01",
      "2026-06-02",
      "2026-06-03",
    ]);
    expect(state.requestedSlots[0]).toMatchObject({ searchMode: "one_time", startTime: "09:00", endTime: "12:00" });
  });

  it("summarizes proven tutor availability for first-week July Writing Y6 requests", () => {
    const availableEnglishTutor = group({
      id: "efl-available",
      canonicalKey: "efl-available",
      displayName: "Available EFL",
      qualifications: [{ subject: "EFL", curriculum: "International", level: "Y2-8" }],
      availabilityWindows: [
        { weekday: 3, startMinute: 10 * 60, endMinute: 12 * 60, modality: "both", wiseTeacherId: "wise-english" },
      ],
    });
    const reviewTutor = group({
      id: "esl-review",
      canonicalKey: "esl-review",
      displayName: "Review English",
      qualifications: [{ subject: "ESL", curriculum: "International", level: "Y2-8" }],
      availabilityWindows: [
        { weekday: 3, startMinute: 10 * 60, endMinute: 12 * 60, modality: "both", wiseTeacherId: "wise-review" },
      ],
      dataIssues: [{ type: "modality", message: "Unresolved mode" }],
    });
    const blockedTutor = group({
      id: "literature-held",
      canonicalKey: "literature-held",
      displayName: "Held English",
      qualifications: [{ subject: "Literature", curriculum: "International", level: "Y2-8" }],
      availabilityWindows: [
        { weekday: 3, startMinute: 10 * 60, endMinute: 11 * 60, modality: "both", wiseTeacherId: "wise-held" },
      ],
    });

    const result = solveSchedulerTurn({
      index: index([availableEnglishTutor, reviewTutor, blockedTutor]),
      extractedState: {
        searchMode: "one_time",
        mode: "either",
        durationMinutes: 60,
        filters: { subject: "Writing", level: "Y6" },
        dateRange: { startDate: "2026-07-01", endDate: "2026-07-07" },
        parentRequestSummary: "Need a Writing Y6 tutor in the first week of July.",
      } as SchedulerExtractedState,
      filterOptions: filters,
      tutorList: tutors,
      activeProposalHolds: [
        hold({
          tutorGroupId: "literature-held",
          tutorCanonicalKey: "literature-held",
          tutorDisplayName: "Held English",
          scope: "one_time",
          weekday: 3,
          date: "2026-07-01",
          startMinute: 10 * 60,
          endMinute: 11 * 60,
          startTime: "10:00",
          endTime: "11:00",
        }),
      ],
    });

    expect(result.parentReady).toBe(true);
    expect(result.questions).toEqual([]);
    expect(result.availabilitySummary).toMatchObject({
      dateRange: { startDate: "2026-07-01", endDate: "2026-07-07" },
      durationMinutes: 60,
      filters: { subject: "EFL", curriculum: "International", level: "Y2-8" },
      searchedFilters: [
        { subject: "EFL", curriculum: "International", level: "Y2-8" },
        { subject: "ESL", curriculum: "International", level: "Y2-8" },
        { subject: "Literature", curriculum: "International", level: "Y2-8" },
      ],
    });
    expect(result.availabilitySummary?.subjectIntent).toMatchObject({ label: "English-family" });
    expect(result.availabilitySummary?.tutors.map((tutor) => tutor.displayName)).toEqual(["Available EFL"]);
    expect(result.availabilitySummary?.tutors[0].matchedSubjects).toEqual(["EFL"]);
    expect(result.availabilitySummary?.tutors[0].windows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ date: "2026-07-01", weekday: 3, start: "10:00", end: "11:00" }),
      ]),
    );
    expect(result.assistantMessage).toMatch(/Available EFL/);
    expect(result.parentMessageDraft).toMatch(/Checked: EFL, ESL, Literature Y2-8 International/);
    expect(result.parentMessageDraft).toMatch(/1\. Available EFL \(EFL\) - Wed 1 Jul: 10:00-12:00/);
    expect(result.parentMessageDraft).not.toMatch(/Wise snapshot/);
  });

  it("excludes active sessions and leaves from broad date-range availability summaries", () => {
    const freeTutor = group({
      id: "free-english",
      canonicalKey: "free-english",
      displayName: "Free English",
      qualifications: [{ subject: "EFL", curriculum: "International", level: "Y2-8" }],
      availabilityWindows: [
        { weekday: 3, startMinute: 10 * 60, endMinute: 11 * 60, modality: "both", wiseTeacherId: "wise-free" },
      ],
    });
    const sessionBlockedTutor = group({
      id: "session-blocked",
      canonicalKey: "session-blocked",
      displayName: "Session Blocked",
      qualifications: [{ subject: "EFL", curriculum: "International", level: "Y2-8" }],
      availabilityWindows: [
        { weekday: 3, startMinute: 10 * 60, endMinute: 11 * 60, modality: "both", wiseTeacherId: "wise-session" },
      ],
      sessionBlocks: [
        {
          startTime: new Date("2026-07-01T03:00:00.000Z"),
          endTime: new Date("2026-07-01T04:00:00.000Z"),
          weekday: 3,
          startMinute: 10 * 60,
          endMinute: 11 * 60,
          isBlocking: true,
          wiseTeacherId: "wise-session",
        },
      ],
    });
    const leaveBlockedTutor = group({
      id: "leave-blocked",
      canonicalKey: "leave-blocked",
      displayName: "Leave Blocked",
      qualifications: [{ subject: "EFL", curriculum: "International", level: "Y2-8" }],
      availabilityWindows: [
        { weekday: 3, startMinute: 10 * 60, endMinute: 11 * 60, modality: "both", wiseTeacherId: "wise-leave" },
      ],
      leaves: [
        {
          startTime: new Date("2026-07-01T00:00:00.000Z"),
          endTime: new Date("2026-07-02T00:00:00.000Z"),
        },
      ],
    });

    const result = solveSchedulerTurn({
      index: index([freeTutor, sessionBlockedTutor, leaveBlockedTutor]),
      extractedState: {
        searchMode: "one_time",
        filters: { subject: "Writing", level: "Y6" },
        parentRequestSummary: "Need Writing Y6.",
        dateRange: { startDate: "2026-07-01", endDate: "2026-07-01" },
      },
      filterOptions: filters,
      tutorList: tutors,
      activeProposalHolds: [],
    });

    expect(result.availabilitySummary?.tutors.map((tutor) => tutor.displayName)).toEqual(["Free English"]);
  });

  it("clears stale day/date questions when a follow-up supplies the requested slot", () => {
    const merged = mergeSchedulerState(
      {
        searchMode: "one_time",
        startTime: "13:00",
        endTime: "14:00",
        durationMinutes: 60,
        filters: { subject: "EnglishVR", level: "11+/13+" },
        studentName: "maze",
        unresolvedQuestions: ["Which weekday or exact date should I search for that time?"],
      },
      {
        searchMode: "recurring",
        dayOfWeek: 6,
        startTime: "13:00",
        endTime: "14:00",
        requestedSlots: [
          { searchMode: "recurring", dayOfWeek: 6, startTime: "13:00", endTime: "14:00", durationMinutes: 60 },
        ],
      },
    );

    const result = solveSchedulerTurn({
      index: index([
        group({
          id: "english-sat",
          canonicalKey: "english-sat",
          displayName: "Saturday English",
          qualifications: [{ subject: "EnglishVR", curriculum: "International", level: "11+/13+" }],
          availabilityWindows: [
            { weekday: 6, startMinute: 13 * 60, endMinute: 14 * 60, modality: "both", wiseTeacherId: "wise-sat" },
          ],
        }),
      ]),
      extractedState: merged,
      filterOptions: filters,
      tutorList: tutors,
      activeProposalHolds: [],
    });

    expect(result.parentReady).toBe(true);
    expect(result.constraintLedger).toContainEqual(expect.objectContaining({
      key: "slot",
      status: "proven",
      normalized: expect.stringContaining("Saturday 13:00-14:00"),
    }));
    expect(result.questions.join(" ")).not.toMatch(/Which weekday or exact date/);
    expect(result.suggestions[0]).toMatchObject({ dayOfWeek: 6, start: "13:00", end: "14:00" });
  });

  it("recovers a Saturday follow-up from raw text when the model leaves dayOfWeek empty", () => {
    const result = solveSchedulerTurn({
      index: index([
        group({
          id: "english-sat",
          canonicalKey: "english-sat",
          displayName: "Saturday English",
          qualifications: [{ subject: "EnglishVR", curriculum: "International", level: "11+/13+" }],
          availabilityWindows: [
            { weekday: 6, startMinute: 13 * 60, endMinute: 14 * 60, modality: "both", wiseTeacherId: "wise-sat" },
          ],
        }),
      ]),
      extractedState: {
        searchMode: "one_time",
        startTime: "13:00",
        endTime: "14:00",
        durationMinutes: 60,
        filters: { subject: "EnglishVR", level: "11+/13+" },
        studentName: "maze",
        unresolvedQuestions: ["Which weekday or exact date should I search for that time?"],
      },
      sourceText: "Saturday",
      filterOptions: filters,
      tutorList: tutors,
      activeProposalHolds: [],
    });

    expect(result.parentReady).toBe(true);
    expect(result.state.dayOfWeek).toBe(6);
    expect(result.state.searchMode).toBe("recurring");
    expect(result.questions).toEqual([]);
    expect(result.suggestions[0]).toMatchObject({ dayOfWeek: 6, start: "13:00", end: "14:00" });
  });

  it("runs subject-specific searches for Math English Science requests", () => {
    const result = solveSchedulerTurn({
      index: index([
        group({
          id: "math-tutor",
          canonicalKey: "math-tutor",
          displayName: "Math Tutor",
          qualifications: [{ subject: "Math", curriculum: "International", level: "Y2-8" }],
          availabilityWindows: [
            { weekday: 3, startMinute: 9 * 60, endMinute: 12 * 60, modality: "onsite", wiseTeacherId: "wise-math" },
          ],
        }),
        group({
          id: "english-tutor",
          canonicalKey: "english-tutor",
          displayName: "English Tutor",
          qualifications: [{ subject: "EnglishVR", curriculum: "International", level: "Y2-8" }],
          availabilityWindows: [
            { weekday: 3, startMinute: 9 * 60, endMinute: 12 * 60, modality: "onsite", wiseTeacherId: "wise-english" },
          ],
        }),
        group({
          id: "science-tutor",
          canonicalKey: "science-tutor",
          displayName: "Science Tutor",
          qualifications: [{ subject: "Science", curriculum: "International", level: "Y2-8" }],
          availabilityWindows: [
            { weekday: 3, startMinute: 9 * 60, endMinute: 12 * 60, modality: "onsite", wiseTeacherId: "wise-science" },
          ],
        }),
      ]),
      extractedState: {
        searchMode: "one_time",
        mode: "onsite",
        durationMinutes: 60,
        filters: { subject: "Math", level: "Y2-8" },
        subjectRequests: [
          { subject: "Math", level: "Y2-8" },
          { subject: "EnglishVR", level: "Y2-8" },
          { subject: "Science", level: "Y2-8" },
        ],
        requestedSlots: [
          { searchMode: "one_time", date: "2026-07-01", startTime: "09:00", endTime: "12:00", durationMinutes: 60 },
        ],
      } as SchedulerExtractedState,
      filterOptions: filters,
      tutorList: tutors,
      activeProposalHolds: [],
    });

    expect(result.parentReady).toBe(true);
    expect(new Set(result.suggestions.map((suggestion) => suggestion.subject))).toEqual(new Set(["Math", "EnglishVR", "Science"]));
    expect(result.assistantMessage).toMatch(/3 subjects/);
    expect(result.parentMessageDraft).toMatch(/Math/);
    expect(result.parentMessageDraft).toMatch(/EnglishVR/);
    expect(result.parentMessageDraft).toMatch(/Science/);
  });
});
