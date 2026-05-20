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

const filters = {
  subjects: ["English", "Math", "Econ", "NonVR"],
  curriculums: ["International"],
  levels: ["Year 5", "Y9-11"],
};

const tutors = [
  { tutorGroupId: "tutor-1", displayName: "Kevin", supportedModes: ["online", "onsite"], subjects: ["English"] },
  { tutorGroupId: "tutor-2", displayName: "Anna", supportedModes: ["online"], subjects: ["Math"] },
  { tutorGroupId: "tutor-3", displayName: "Anne", supportedModes: ["onsite"], subjects: ["English"] },
  { tutorGroupId: "tutor-4", displayName: "June", supportedModes: ["onsite"], subjects: ["NonVR"] },
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
    requestedSlots: [],
    explicitUnknownFilters: [],
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
});
