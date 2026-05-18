import { describe, it, expect, afterEach, vi } from "vitest";
import { executeSearch } from "../engine";
import type { SearchIndex, IndexedTutorGroup } from "../index";
import type { SearchRequest } from "../types";

function makeTutor(overrides: Partial<IndexedTutorGroup> = {}): IndexedTutorGroup {
  return {
    id: "g1",
    canonicalKey: "test-tutor",
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
    syncedAt: new Date(),
    tutorGroups: tutors,
    byWeekday,
  };
}

describe("executeSearch", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it("marks default search metadata stale only after the 90-minute API threshold", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T02:00:00.000Z"));

    const req: SearchRequest = {
      searchMode: "recurring",
      slots: [
        { id: "s1", dayOfWeek: 1, start: "09:00", end: "10:00", mode: "either" },
      ],
    };
    const freshIndex = makeIndex([makeTutor()]);
    freshIndex.syncedAt = new Date(Date.now() - (90 * 60 * 1000));
    const staleIndex = makeIndex([makeTutor()]);
    staleIndex.syncedAt = new Date(Date.now() - (90 * 60 * 1000 + 1));

    const freshResult = executeSearch(freshIndex, req);
    const staleResult = executeSearch(staleIndex, req);

    expect(freshResult.snapshotMeta.syncedAt).toBe(freshIndex.syncedAt.toISOString());
    expect(freshResult.snapshotMeta.stale).toBe(false);
    expect(freshResult.warnings).toEqual([]);
    expect(staleResult.snapshotMeta.syncedAt).toBe(staleIndex.syncedAt.toISOString());
    expect(staleResult.snapshotMeta.stale).toBe(true);
    expect(staleResult.warnings).toContain(
      "Search data may be stale — last sync was more than 90 minutes ago",
    );
  });
});

describe("executeSearch — REL-04 leave overlap (recurring mode)", () => {
  // Helper: build a tutor with availability covering Mon and Tue 09:00-17:00,
  // plus a single leave window. Reuses the makeTutor fixture above so leaves
  // can be isolated as the only blocking factor.
  function makeTutorWithLeave(opts: {
    leaveStart: Date;
    leaveEnd: Date;
  }): IndexedTutorGroup {
    return makeTutor({
      // Cover Mon (1) and Tue (2) so the leave is the only thing that can block.
      availabilityWindows: [
        {
          weekday: 1,
          startMinute: 540, // 09:00
          endMinute: 1020, // 17:00
          modality: "both",
          wiseTeacherId: "t1",
        },
        {
          weekday: 2,
          startMinute: 540,
          endMinute: 1020,
          modality: "both",
          wiseTeacherId: "t1",
        },
      ],
      leaves: [
        {
          startTime: opts.leaveStart,
          endTime: opts.leaveEnd,
        },
      ],
    });
  }

  // Bangkok-local Date construction matches the existing test pattern (e.g.,
  // line 63: `new Date("2024-01-15T09:00:00")`). For multi-day vs single-day
  // behavior the only relevant Date methods are .getDay()/.getHours()/
  // .getMinutes() which all read local-time fields, so the constructor form
  // here (Mon 6 Apr 2026 = local time) is equivalent.
  it("REL-04: multi-day leave (Mon 14:00 → Wed 10:00) blocks Tue 14:00-16:00 slot", () => {
    const tutor = makeTutorWithLeave({
      leaveStart: new Date(2026, 3, 6, 14, 0), // Mon 6 Apr 14:00
      leaveEnd: new Date(2026, 3, 8, 10, 0), // Wed 8 Apr 10:00
    });
    const index = makeIndex([tutor]);
    const req: SearchRequest = {
      searchMode: "recurring",
      slots: [
        { id: "s1", dayOfWeek: 2, start: "14:00", end: "16:00", mode: "either" },
      ],
    };

    const result = executeSearch(index, req);
    // Tutor must NOT appear as Available — the multi-day leave touches Tuesday
    // and the documented assumption blocks every weekday it touches in full.
    expect(result.perSlotResults[0].available).toHaveLength(0);
  });

  it("REL-04: single-day leave (Mon 14:00 → Mon 16:00) blocks Mon 15:00 but NOT Tue 14:00 or Mon 13:00", () => {
    const tutor = makeTutorWithLeave({
      leaveStart: new Date(2026, 3, 6, 14, 0), // Mon 6 Apr 14:00
      leaveEnd: new Date(2026, 3, 6, 16, 0), // Mon 6 Apr 16:00
    });
    const index = makeIndex([tutor]);

    // Sub-case A: Mon 15:00-15:30 (within leave) → blocked
    const aReq: SearchRequest = {
      searchMode: "recurring",
      slots: [
        { id: "s1", dayOfWeek: 1, start: "15:00", end: "15:30", mode: "either" },
      ],
    };
    expect(executeSearch(index, aReq).perSlotResults[0].available).toHaveLength(0);

    // Sub-case B: Mon 13:00-13:30 (before leave on same weekday) → NOT blocked
    const bReq: SearchRequest = {
      searchMode: "recurring",
      slots: [
        { id: "s1", dayOfWeek: 1, start: "13:00", end: "13:30", mode: "either" },
      ],
    };
    expect(executeSearch(index, bReq).perSlotResults[0].available).toHaveLength(1);

    // Sub-case C: Tue 14:00-16:00 (different weekday from single-day leave) → NOT blocked
    const cReq: SearchRequest = {
      searchMode: "recurring",
      slots: [
        { id: "s1", dayOfWeek: 2, start: "14:00", end: "16:00", mode: "either" },
      ],
    };
    expect(executeSearch(index, cReq).perSlotResults[0].available).toHaveLength(1);
  });
});
