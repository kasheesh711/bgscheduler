import { describe, it, expect } from "vitest";
import { executeSearch } from "../engine";
import type { SearchIndex, IndexedTutorGroup } from "../index";
import type { SearchRequest } from "../types";

function makeTutor(overrides: Partial<IndexedTutorGroup> = {}): IndexedTutorGroup {
  return {
    id: "g1",
    displayName: "Test Tutor",
    supportedModes: ["online", "onsite"],
    qualifications: [
      { subject: "Math", curriculum: "International", level: "Y2-8" },
    ],
    wiseRecords: [
      { wiseTeacherId: "t1", wiseDisplayName: "Test (Test) Tutor", isOnline: false },
    ],
    availabilityWindows: [
      { weekday: 1, startMinute: 540, endMinute: 1020, modality: "both", wiseTeacherId: "t1" },
    ],
    leaves: [],
    sessionBlocks: [],
    dataIssues: [],
    ...overrides,
  };
}

function makeIndex(tutors: IndexedTutorGroup[]): SearchIndex {
  const byWeekday = new Map<number, IndexedTutorGroup[]>();
  for (const t of tutors) {
    for (const w of t.availabilityWindows) {
      if (!byWeekday.has(w.weekday)) byWeekday.set(w.weekday, []);
      byWeekday.get(w.weekday)!.push(t);
    }
  }
  return {
    snapshotId: "snap-1",
    builtAt: new Date(),
    tutorGroups: tutors,
    byWeekday,
  };
}

describe("executeSearch", () => {
  it("returns available tutor for matching recurring slot", () => {
    const index = makeIndex([makeTutor()]);
    const req: SearchRequest = {
      searchMode: "recurring",
      slots: [
        { id: "s1", dayOfWeek: 1, start: "09:00", end: "10:00", mode: "either" },
      ],
    };

    const result = executeSearch(index, req);
    expect(result.perSlotResults[0].available).toHaveLength(1);
    expect(result.perSlotResults[0].available[0].displayName).toBe("Test Tutor");
  });

  it("excludes tutor blocked by future session (recurring)", () => {
    const tutor = makeTutor({
      sessionBlocks: [
        {
          startTime: new Date("2024-01-15T09:00:00"),
          endTime: new Date("2024-01-15T10:00:00"),
          weekday: 1,
          startMinute: 540,
          endMinute: 600,
          isBlocking: true,
          wiseTeacherId: "t1",
        },
      ],
    });
    const index = makeIndex([tutor]);
    const req: SearchRequest = {
      searchMode: "recurring",
      slots: [
        { id: "s1", dayOfWeek: 1, start: "09:00", end: "10:00", mode: "either" },
      ],
    };

    const result = executeSearch(index, req);
    expect(result.perSlotResults[0].available).toHaveLength(0);
  });

  it("does not block on cancelled session", () => {
    const tutor = makeTutor({
      sessionBlocks: [
        {
          startTime: new Date("2024-01-15T09:00:00"),
          endTime: new Date("2024-01-15T10:00:00"),
          weekday: 1,
          startMinute: 540,
          endMinute: 600,
          isBlocking: false, // cancelled
          wiseTeacherId: "t1",
        },
      ],
    });
    const index = makeIndex([tutor]);
    const req: SearchRequest = {
      searchMode: "recurring",
      slots: [
        { id: "s1", dayOfWeek: 1, start: "09:00", end: "10:00", mode: "either" },
      ],
    };

    const result = executeSearch(index, req);
    expect(result.perSlotResults[0].available).toHaveLength(1);
  });

  it("routes tutor with data issues to Needs Review", () => {
    const tutor = makeTutor({
      dataIssues: [{ type: "alias", message: "Unresolved identity" }],
    });
    const index = makeIndex([tutor]);
    const req: SearchRequest = {
      searchMode: "recurring",
      slots: [
        { id: "s1", dayOfWeek: 1, start: "09:00", end: "10:00", mode: "either" },
      ],
    };

    const result = executeSearch(index, req);
    expect(result.perSlotResults[0].available).toHaveLength(0);
    expect(result.perSlotResults[0].needsReview).toHaveLength(1);
  });

  it("routes tutor with unresolved modality to Needs Review", () => {
    const tutor = makeTutor({
      supportedModes: [],
      dataIssues: [{ type: "modality", message: "Unresolved" }],
    });
    const index = makeIndex([tutor]);
    const req: SearchRequest = {
      searchMode: "recurring",
      slots: [
        { id: "s1", dayOfWeek: 1, start: "09:00", end: "10:00", mode: "either" },
      ],
    };

    const result = executeSearch(index, req);
    expect(result.perSlotResults[0].available).toHaveLength(0);
    expect(result.perSlotResults[0].needsReview).toHaveLength(1);
  });

  it("filters by mode correctly", () => {
    const tutor = makeTutor({ supportedModes: ["onsite"] });
    const index = makeIndex([tutor]);

    const onlineReq: SearchRequest = {
      searchMode: "recurring",
      slots: [
        { id: "s1", dayOfWeek: 1, start: "09:00", end: "10:00", mode: "online" },
      ],
    };
    expect(executeSearch(index, onlineReq).perSlotResults[0].available).toHaveLength(0);

    const eitherReq: SearchRequest = {
      searchMode: "recurring",
      slots: [
        { id: "s1", dayOfWeek: 1, start: "09:00", end: "10:00", mode: "either" },
      ],
    };
    expect(executeSearch(index, eitherReq).perSlotResults[0].available).toHaveLength(1);
  });

  it("filters by subject/curriculum/level", () => {
    const index = makeIndex([makeTutor()]);
    const req: SearchRequest = {
      searchMode: "recurring",
      slots: [
        { id: "s1", dayOfWeek: 1, start: "09:00", end: "10:00", mode: "either" },
      ],
      filters: { subject: "Science" },
    };

    const result = executeSearch(index, req);
    expect(result.perSlotResults[0].available).toHaveLength(0);
  });

  it("computes intersection across multiple slots", () => {
    const tutor1 = makeTutor({
      id: "g1",
      displayName: "Both Days",
      availabilityWindows: [
        { weekday: 1, startMinute: 540, endMinute: 1020, modality: "both", wiseTeacherId: "t1" },
        { weekday: 2, startMinute: 540, endMinute: 1020, modality: "both", wiseTeacherId: "t1" },
      ],
    });
    const tutor2 = makeTutor({
      id: "g2",
      displayName: "Monday Only",
      wiseRecords: [
        { wiseTeacherId: "t2", wiseDisplayName: "Mon Tutor", isOnline: false },
      ],
      availabilityWindows: [
        { weekday: 1, startMinute: 540, endMinute: 1020, modality: "both", wiseTeacherId: "t2" },
      ],
    });

    const index = makeIndex([tutor1, tutor2]);
    const req: SearchRequest = {
      searchMode: "recurring",
      slots: [
        { id: "s1", dayOfWeek: 1, start: "09:00", end: "10:00", mode: "either" },
        { id: "s2", dayOfWeek: 2, start: "09:00", end: "10:00", mode: "either" },
      ],
    };

    const result = executeSearch(index, req);
    expect(result.perSlotResults[0].available).toHaveLength(2);
    expect(result.perSlotResults[1].available).toHaveLength(1);
    expect(result.intersection).toHaveLength(1);
    expect(result.intersection[0].displayName).toBe("Both Days");
  });

  it("one-time mode only blocks on exact date", () => {
    const tutor = makeTutor({
      sessionBlocks: [
        {
          startTime: new Date("2024-01-15T09:00:00"),
          endTime: new Date("2024-01-15T10:00:00"),
          weekday: 1,
          startMinute: 540,
          endMinute: 600,
          isBlocking: true,
          wiseTeacherId: "t1",
        },
      ],
    });
    const index = makeIndex([tutor]);

    // Same date → blocked
    const blockedReq: SearchRequest = {
      searchMode: "one_time",
      slots: [
        { id: "s1", date: "2024-01-15", start: "09:00", end: "10:00", mode: "either" },
      ],
    };
    expect(executeSearch(index, blockedReq).perSlotResults[0].available).toHaveLength(0);

    // Different date → available
    const freeReq: SearchRequest = {
      searchMode: "one_time",
      slots: [
        { id: "s1", date: "2024-01-22", start: "09:00", end: "10:00", mode: "either" },
      ],
    };
    expect(executeSearch(index, freeReq).perSlotResults[0].available).toHaveLength(1);
  });
});
