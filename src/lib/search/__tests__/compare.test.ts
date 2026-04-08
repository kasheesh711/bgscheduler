import { describe, it, expect } from "vitest";
import { buildCompareTutor, detectConflicts, findSharedFreeSlots } from "../compare";
import type { IndexedTutorGroup, SearchIndex } from "../index";

function makeTutor(overrides: Partial<IndexedTutorGroup> = {}): IndexedTutorGroup {
  return {
    id: "g1",
    displayName: "Test Tutor",
    supportedModes: ["online", "onsite"],
    qualifications: [{ subject: "Math", curriculum: "International", level: "Y2-8" }],
    wiseRecords: [{ wiseTeacherId: "t1", wiseDisplayName: "Test Tutor", isOnline: false }],
    availabilityWindows: [
      { weekday: 1, startMinute: 540, endMinute: 1020, modality: "both", wiseTeacherId: "t1" },
    ],
    leaves: [],
    sessionBlocks: [],
    dataIssues: [],
    ...overrides,
  };
}

describe("buildCompareTutor", () => {
  it("returns all sessions for the specified weekday", () => {
    const tutor = makeTutor({
      sessionBlocks: [
        { startTime: new Date("2024-01-15T09:00:00"), endTime: new Date("2024-01-15T10:00:00"), weekday: 1, startMinute: 540, endMinute: 600, isBlocking: true, wiseTeacherId: "t1", studentName: "Ava T.", subject: "Math", title: "Math - Ava T.", classType: "ONE_TO_ONE" },
        { startTime: new Date("2024-01-16T14:00:00"), endTime: new Date("2024-01-16T15:00:00"), weekday: 2, startMinute: 840, endMinute: 900, isBlocking: true, wiseTeacherId: "t1", studentName: "Ben K.", subject: "English" },
      ],
    });
    const result = buildCompareTutor(tutor, [1]);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].studentName).toBe("Ava T.");
    expect(result.sessions[0].weekday).toBe(1);
  });

  it("returns all sessions when no weekday filter (full week)", () => {
    const tutor = makeTutor({
      sessionBlocks: [
        { startTime: new Date("2024-01-15T09:00:00"), endTime: new Date("2024-01-15T10:00:00"), weekday: 1, startMinute: 540, endMinute: 600, isBlocking: true, wiseTeacherId: "t1", studentName: "Ava T.", subject: "Math" },
        { startTime: new Date("2024-01-16T14:00:00"), endTime: new Date("2024-01-16T15:00:00"), weekday: 2, startMinute: 840, endMinute: 900, isBlocking: true, wiseTeacherId: "t1", studentName: "Ben K.", subject: "English" },
      ],
    });
    const result = buildCompareTutor(tutor);
    expect(result.sessions).toHaveLength(2);
  });

  it("computes weeklyHoursBooked from all session blocks", () => {
    const tutor = makeTutor({
      sessionBlocks: [
        { startTime: new Date("2024-01-15T09:00:00"), endTime: new Date("2024-01-15T10:00:00"), weekday: 1, startMinute: 540, endMinute: 600, isBlocking: true, wiseTeacherId: "t1", studentName: "Ava T.", subject: "Math" },
        { startTime: new Date("2024-01-15T10:00:00"), endTime: new Date("2024-01-15T11:30:00"), weekday: 1, startMinute: 600, endMinute: 690, isBlocking: true, wiseTeacherId: "t1", studentName: "Ben K.", subject: "English" },
      ],
    });
    const result = buildCompareTutor(tutor);
    expect(result.weeklyHoursBooked).toBe(2.5);
  });

  it("computes distinct studentCount", () => {
    const tutor = makeTutor({
      sessionBlocks: [
        { startTime: new Date("2024-01-15T09:00:00"), endTime: new Date("2024-01-15T10:00:00"), weekday: 1, startMinute: 540, endMinute: 600, isBlocking: true, wiseTeacherId: "t1", studentName: "Ava T.", subject: "Math" },
        { startTime: new Date("2024-01-16T10:00:00"), endTime: new Date("2024-01-16T11:00:00"), weekday: 2, startMinute: 600, endMinute: 660, isBlocking: true, wiseTeacherId: "t1", studentName: "Ava T.", subject: "English" },
        { startTime: new Date("2024-01-17T14:00:00"), endTime: new Date("2024-01-17T15:00:00"), weekday: 3, startMinute: 840, endMinute: 900, isBlocking: true, wiseTeacherId: "t1", studentName: "Ben K.", subject: "Math" },
      ],
    });
    const result = buildCompareTutor(tutor);
    expect(result.studentCount).toBe(2);
  });
});

describe("detectConflicts", () => {
  it("detects conflict when same student appears in overlapping slots across tutors", () => {
    const tutorA = makeTutor({
      id: "g1", displayName: "Kevin H.",
      sessionBlocks: [{ startTime: new Date("2024-01-15T11:00:00"), endTime: new Date("2024-01-15T12:00:00"), weekday: 1, startMinute: 660, endMinute: 720, isBlocking: true, wiseTeacherId: "t1", studentName: "Ava T.", subject: "English", title: "English - Ava T." }],
    });
    const tutorB = makeTutor({
      id: "g2", displayName: "Samantha W.",
      sessionBlocks: [{ startTime: new Date("2024-01-15T11:00:00"), endTime: new Date("2024-01-15T12:00:00"), weekday: 1, startMinute: 660, endMinute: 720, isBlocking: true, wiseTeacherId: "t2", studentName: "Ava T.", subject: "Math", title: "Math - Ava T." }],
    });
    const conflicts = detectConflicts([buildCompareTutor(tutorA), buildCompareTutor(tutorB)], [tutorA, tutorB]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].studentName).toBe("Ava T.");
    expect(conflicts[0].tutorA.displayName).toBe("Kevin H.");
    expect(conflicts[0].tutorB.displayName).toBe("Samantha W.");
  });

  it("returns no conflicts when students are different", () => {
    const tutorA = makeTutor({ id: "g1", displayName: "Kevin H.", sessionBlocks: [{ startTime: new Date("2024-01-15T11:00:00"), endTime: new Date("2024-01-15T12:00:00"), weekday: 1, startMinute: 660, endMinute: 720, isBlocking: true, wiseTeacherId: "t1", studentName: "Ava T.", subject: "English" }] });
    const tutorB = makeTutor({ id: "g2", displayName: "Samantha W.", sessionBlocks: [{ startTime: new Date("2024-01-15T11:00:00"), endTime: new Date("2024-01-15T12:00:00"), weekday: 1, startMinute: 660, endMinute: 720, isBlocking: true, wiseTeacherId: "t2", studentName: "Ben K.", subject: "Math" }] });
    const conflicts = detectConflicts([buildCompareTutor(tutorA), buildCompareTutor(tutorB)], [tutorA, tutorB]);
    expect(conflicts).toHaveLength(0);
  });

  it("returns no conflicts when times don't overlap", () => {
    const tutorA = makeTutor({ id: "g1", displayName: "Kevin H.", sessionBlocks: [{ startTime: new Date("2024-01-15T09:00:00"), endTime: new Date("2024-01-15T10:00:00"), weekday: 1, startMinute: 540, endMinute: 600, isBlocking: true, wiseTeacherId: "t1", studentName: "Ava T.", subject: "Math" }] });
    const tutorB = makeTutor({ id: "g2", displayName: "Samantha W.", sessionBlocks: [{ startTime: new Date("2024-01-15T11:00:00"), endTime: new Date("2024-01-15T12:00:00"), weekday: 1, startMinute: 660, endMinute: 720, isBlocking: true, wiseTeacherId: "t2", studentName: "Ava T.", subject: "English" }] });
    const conflicts = detectConflicts([buildCompareTutor(tutorA), buildCompareTutor(tutorB)], [tutorA, tutorB]);
    expect(conflicts).toHaveLength(0);
  });
});

describe("findSharedFreeSlots", () => {
  it("finds shared free time on a given weekday", () => {
    const tutorA = makeTutor({ id: "g1", availabilityWindows: [{ weekday: 1, startMinute: 540, endMinute: 720, modality: "both", wiseTeacherId: "t1" }], sessionBlocks: [{ startTime: new Date("2024-01-15T09:00:00"), endTime: new Date("2024-01-15T10:00:00"), weekday: 1, startMinute: 540, endMinute: 600, isBlocking: true, wiseTeacherId: "t1" }] });
    const tutorB = makeTutor({ id: "g2", availabilityWindows: [{ weekday: 1, startMinute: 600, endMinute: 780, modality: "both", wiseTeacherId: "t2" }], sessionBlocks: [] });
    const slots = findSharedFreeSlots([tutorA, tutorB], [1]);
    expect(slots.length).toBeGreaterThanOrEqual(1);
    expect(slots[0].dayOfWeek).toBe(1);
    expect(slots[0].startMinute).toBe(600);
    expect(slots[0].endMinute).toBe(720);
  });
});
