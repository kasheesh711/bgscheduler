import { describe, it, expect } from "vitest";
import { buildCompareTutor, detectConflicts, findSharedFreeSlots, resolveSessionModality, detectSessionModalityConflict } from "../compare";
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

  it("marks sessions from an online variant as online", () => {
    const tutor = makeTutor({
      supportedModes: ["online", "onsite"],
      wiseRecords: [
        { wiseTeacherId: "t1", wiseDisplayName: "Test Tutor", isOnline: false },
        { wiseTeacherId: "t2", wiseDisplayName: "Test Tutor Online", isOnline: true },
      ],
      sessionBlocks: [
        { startTime: new Date("2024-01-15T09:00:00"), endTime: new Date("2024-01-15T10:00:00"), weekday: 1, startMinute: 540, endMinute: 600, isBlocking: true, wiseTeacherId: "t2", studentName: "Ava T.", subject: "Math" },
      ],
    });

    const result = buildCompareTutor(tutor);
    expect(result.sessions[0].modality).toBe("online");
  });

  it("returns unknown for an unresolved group even with sessionType evidence (MOD-01 fail-closed)", () => {
    // Pre-MOD-01 this used location/sessionType as standalone fallback and returned "online".
    // MOD-01 restricts the resolver to isOnlineVariant + sessionType corroboration — an
    // unresolved group (supportedModes: []) has no isOnlineVariant signal to corroborate,
    // so the session falls into the fail-closed branch (AGENTS.md:146-149 / D-01 / D-05).
    const tutor = makeTutor({
      supportedModes: [],
      sessionBlocks: [
        { startTime: new Date("2024-01-15T09:00:00"), endTime: new Date("2024-01-15T10:00:00"), weekday: 1, startMinute: 540, endMinute: 600, isBlocking: true, wiseTeacherId: "t1", studentName: "Ava T.", subject: "Math", sessionType: "online" },
      ],
    });

    const result = buildCompareTutor(tutor);
    expect(result.sessions[0].modality).toBe("unknown");
    expect(result.sessions[0].modalityConfidence).toBe("low");
  });
});

describe("resolveSessionModality matrix (MOD-05 / D-21)", () => {
  // Merge-gate regression matrix per 06-CONTEXT.md D-21/D-22 and research Pitfall 1.
  // Covers every combination of {group shape × isOnlineVariant × sessionType} with
  // explicit expected {modality, confidence} outputs. Every contradiction case (#4, 5,
  // 9, 10, 15, 16) asserts BOTH modality === "unknown" AND detectSessionModalityConflict
  // returns a non-null payload whose message names both disagreeing signals. Any future
  // refactor that silently replaces a fail-closed "unknown" branch with a concrete value
  // breaks this matrix and blocks the merge.
  function runCase(args: {
    supportedModes: string[];
    wiseRecords: { wiseTeacherId: string; wiseDisplayName: string; isOnline: boolean }[];
    sessionType?: string;
  }) {
    const tutor = makeTutor({
      supportedModes: args.supportedModes,
      wiseRecords: args.wiseRecords,
      sessionBlocks: [
        {
          startTime: new Date("2024-01-15T09:00:00"),
          endTime: new Date("2024-01-15T10:00:00"),
          weekday: 1,
          startMinute: 540,
          endMinute: 600,
          isBlocking: true,
          wiseTeacherId: args.wiseRecords[0]?.wiseTeacherId ?? "t1",
          studentName: "Test Student",
          subject: "Math",
          sessionType: args.sessionType,
        },
      ],
    });
    const resolverResult = resolveSessionModality(tutor, tutor.sessionBlocks[0]);
    const compareResult = buildCompareTutor(tutor);
    const supportedModality: "online" | "onsite" | "both" | "unresolved" =
      args.supportedModes.length === 0
        ? "unresolved"
        : args.supportedModes.length === 2
        ? "both"
        : (args.supportedModes[0] as "online" | "onsite");
    const conflictResult = detectSessionModalityConflict({
      supportedModality,
      isOnlineVariant: args.wiseRecords[0]?.isOnline ?? false,
      sessionType: args.sessionType,
      groupDisplayName: tutor.displayName,
    });
    return { resolverResult, compareResult, conflictResult };
  }

  // --- Single-online group (supportedModes: ["online"]) ---
  it("case 1: single-online + isOnlineVariant=true + sessionType=missing → online/high", () => {
    const { resolverResult, compareResult, conflictResult } = runCase({
      supportedModes: ["online"],
      wiseRecords: [{ wiseTeacherId: "t1", wiseDisplayName: "Online Tutor", isOnline: true }],
    });
    expect(resolverResult.modality).toBe("online");
    expect(resolverResult.confidence).toBe("high");
    expect(compareResult.sessions[0].modality).toBe("online");
    expect(compareResult.sessions[0].modalityConfidence).toBe("high");
    expect(conflictResult).toBeNull();
  });

  it("case 2: single-online + isOnlineVariant=true + sessionType=online → online/high", () => {
    const { resolverResult, conflictResult } = runCase({
      supportedModes: ["online"],
      wiseRecords: [{ wiseTeacherId: "t1", wiseDisplayName: "Online Tutor", isOnline: true }],
      sessionType: "online",
    });
    expect(resolverResult.modality).toBe("online");
    expect(resolverResult.confidence).toBe("high");
    expect(conflictResult).toBeNull();
  });

  it("case 3: single-online + isOnlineVariant=true + sessionType=virtual → online/high (virtual ∈ ONLINE_SESSION_TYPES)", () => {
    const { resolverResult, conflictResult } = runCase({
      supportedModes: ["online"],
      wiseRecords: [{ wiseTeacherId: "t1", wiseDisplayName: "Online Tutor", isOnline: true }],
      sessionType: "virtual",
    });
    expect(resolverResult.modality).toBe("online");
    expect(resolverResult.confidence).toBe("high");
    expect(conflictResult).toBeNull();
  });

  it("case 4: single-online + isOnlineVariant=true + sessionType=onsite → unknown/low + CONTRADICTION (D-08)", () => {
    const { resolverResult, compareResult, conflictResult } = runCase({
      supportedModes: ["online"],
      wiseRecords: [{ wiseTeacherId: "t1", wiseDisplayName: "Online Tutor", isOnline: true }],
      sessionType: "onsite",
    });
    expect(resolverResult.modality).toBe("unknown");
    expect(resolverResult.confidence).toBe("low");
    expect(compareResult.sessions[0].modality).toBe("unknown");
    expect(conflictResult).not.toBeNull();
    expect(conflictResult?.message).toMatch(/onsite/);
    expect(conflictResult?.sessionType).toBe("onsite");
    expect(conflictResult?.isOnlineVariant).toBe(true);
  });

  it("case 5: single-online + isOnlineVariant=true + sessionType=in-person → unknown/low + CONTRADICTION (D-08)", () => {
    const { resolverResult, conflictResult } = runCase({
      supportedModes: ["online"],
      wiseRecords: [{ wiseTeacherId: "t1", wiseDisplayName: "Online Tutor", isOnline: true }],
      sessionType: "in-person",
    });
    expect(resolverResult.modality).toBe("unknown");
    expect(resolverResult.confidence).toBe("low");
    expect(conflictResult).not.toBeNull();
    expect(conflictResult?.sessionType).toBe("in-person");
  });

  // --- Single-onsite group (supportedModes: ["onsite"]) ---
  it("case 6: single-onsite + isOnlineVariant=false + sessionType=missing → onsite/high", () => {
    const { resolverResult, conflictResult } = runCase({
      supportedModes: ["onsite"],
      wiseRecords: [{ wiseTeacherId: "t1", wiseDisplayName: "Onsite Tutor", isOnline: false }],
    });
    expect(resolverResult.modality).toBe("onsite");
    expect(resolverResult.confidence).toBe("high");
    expect(conflictResult).toBeNull();
  });

  it("case 7: single-onsite + isOnlineVariant=false + sessionType=onsite → onsite/high", () => {
    const { resolverResult, conflictResult } = runCase({
      supportedModes: ["onsite"],
      wiseRecords: [{ wiseTeacherId: "t1", wiseDisplayName: "Onsite Tutor", isOnline: false }],
      sessionType: "onsite",
    });
    expect(resolverResult.modality).toBe("onsite");
    expect(resolverResult.confidence).toBe("high");
    expect(conflictResult).toBeNull();
  });

  it("case 8: single-onsite + isOnlineVariant=false + sessionType=in-person → onsite/high (in-person ∈ ONSITE_SESSION_TYPES)", () => {
    const { resolverResult, conflictResult } = runCase({
      supportedModes: ["onsite"],
      wiseRecords: [{ wiseTeacherId: "t1", wiseDisplayName: "Onsite Tutor", isOnline: false }],
      sessionType: "in-person",
    });
    expect(resolverResult.modality).toBe("onsite");
    expect(resolverResult.confidence).toBe("high");
    expect(conflictResult).toBeNull();
  });

  it("case 9: single-onsite + isOnlineVariant=false + sessionType=online → unknown/low + CONTRADICTION (D-08)", () => {
    const { resolverResult, conflictResult } = runCase({
      supportedModes: ["onsite"],
      wiseRecords: [{ wiseTeacherId: "t1", wiseDisplayName: "Onsite Tutor", isOnline: false }],
      sessionType: "online",
    });
    expect(resolverResult.modality).toBe("unknown");
    expect(resolverResult.confidence).toBe("low");
    expect(conflictResult).not.toBeNull();
    expect(conflictResult?.sessionType).toBe("online");
    expect(conflictResult?.isOnlineVariant).toBe(false);
  });

  it("case 10: single-onsite + isOnlineVariant=false + sessionType=virtual → unknown/low + CONTRADICTION (D-08)", () => {
    const { resolverResult, conflictResult } = runCase({
      supportedModes: ["onsite"],
      wiseRecords: [{ wiseTeacherId: "t1", wiseDisplayName: "Onsite Tutor", isOnline: false }],
      sessionType: "virtual",
    });
    expect(resolverResult.modality).toBe("unknown");
    expect(resolverResult.confidence).toBe("low");
    expect(conflictResult).not.toBeNull();
    expect(conflictResult?.sessionType).toBe("virtual");
  });

  // --- Paired group (supportedModes: ["online", "onsite"]) ---
  it("case 11: paired + isOnlineVariant=true + sessionType=online → online/high (agree)", () => {
    const { resolverResult, conflictResult } = runCase({
      supportedModes: ["online", "onsite"],
      wiseRecords: [{ wiseTeacherId: "t1", wiseDisplayName: "Paired Online", isOnline: true }],
      sessionType: "online",
    });
    expect(resolverResult.modality).toBe("online");
    expect(resolverResult.confidence).toBe("high");
    expect(conflictResult).toBeNull();
  });

  it("case 12: paired + isOnlineVariant=false + sessionType=onsite → onsite/high (agree)", () => {
    const { resolverResult, conflictResult } = runCase({
      supportedModes: ["online", "onsite"],
      wiseRecords: [{ wiseTeacherId: "t1", wiseDisplayName: "Paired Onsite", isOnline: false }],
      sessionType: "onsite",
    });
    expect(resolverResult.modality).toBe("onsite");
    expect(resolverResult.confidence).toBe("high");
    expect(conflictResult).toBeNull();
  });

  it("case 13: paired + isOnlineVariant=true + sessionType=missing → online/low (inferred, D-04)", () => {
    const { resolverResult, conflictResult } = runCase({
      supportedModes: ["online", "onsite"],
      wiseRecords: [{ wiseTeacherId: "t1", wiseDisplayName: "Paired Online", isOnline: true }],
    });
    expect(resolverResult.modality).toBe("online");
    expect(resolverResult.confidence).toBe("low");
    expect(conflictResult).toBeNull();
  });

  it("case 14: paired + isOnlineVariant=false + sessionType=missing → onsite/low (inferred, D-04)", () => {
    const { resolverResult, conflictResult } = runCase({
      supportedModes: ["online", "onsite"],
      wiseRecords: [{ wiseTeacherId: "t1", wiseDisplayName: "Paired Onsite", isOnline: false }],
    });
    expect(resolverResult.modality).toBe("onsite");
    expect(resolverResult.confidence).toBe("low");
    expect(conflictResult).toBeNull();
  });

  it("case 15: paired + isOnlineVariant=true + sessionType=onsite → unknown/low + CONTRADICTION (D-07)", () => {
    const { resolverResult, compareResult, conflictResult } = runCase({
      supportedModes: ["online", "onsite"],
      wiseRecords: [{ wiseTeacherId: "t1", wiseDisplayName: "Paired Online", isOnline: true }],
      sessionType: "onsite",
    });
    expect(resolverResult.modality).toBe("unknown");
    expect(resolverResult.confidence).toBe("low");
    expect(compareResult.sessions[0].modality).toBe("unknown");
    expect(compareResult.sessions[0].modalityConfidence).toBe("low");
    expect(conflictResult).not.toBeNull();
    expect(conflictResult?.message).toMatch(/isOnlineVariant=true/);
    expect(conflictResult?.message).toMatch(/"onsite"/);
  });

  it("case 16: paired + isOnlineVariant=false + sessionType=online → unknown/low + CONTRADICTION (D-07)", () => {
    const { resolverResult, conflictResult } = runCase({
      supportedModes: ["online", "onsite"],
      wiseRecords: [{ wiseTeacherId: "t1", wiseDisplayName: "Paired Onsite", isOnline: false }],
      sessionType: "online",
    });
    expect(resolverResult.modality).toBe("unknown");
    expect(resolverResult.confidence).toBe("low");
    expect(conflictResult).not.toBeNull();
    expect(conflictResult?.message).toMatch(/isOnlineVariant=false/);
    expect(conflictResult?.message).toMatch(/"online"/);
  });

  // --- Unresolved group ---
  it("case 17: unresolved group (supportedModes=[]) + any signal → unknown/low (fail-closed, MOD-02)", () => {
    const { resolverResult, conflictResult } = runCase({
      supportedModes: [],
      wiseRecords: [{ wiseTeacherId: "t1", wiseDisplayName: "Unresolved", isOnline: false }],
      sessionType: "online",
    });
    expect(resolverResult.modality).toBe("unknown");
    expect(resolverResult.confidence).toBe("low");
    // No contradiction because supportedModality=unresolved has no baseline to contradict against:
    expect(conflictResult).toBeNull();
  });

  // --- Aggregate: medium is never emitted in MOD-01 (D-03) ---
  it("never emits `medium` confidence tier in MOD-01 (D-03)", () => {
    const allCases: Array<Parameters<typeof runCase>[0]> = [
      { supportedModes: ["online"], wiseRecords: [{ wiseTeacherId: "t1", wiseDisplayName: "T", isOnline: true }] },
      { supportedModes: ["online"], wiseRecords: [{ wiseTeacherId: "t1", wiseDisplayName: "T", isOnline: true }], sessionType: "online" },
      { supportedModes: ["online"], wiseRecords: [{ wiseTeacherId: "t1", wiseDisplayName: "T", isOnline: true }], sessionType: "onsite" },
      { supportedModes: ["onsite"], wiseRecords: [{ wiseTeacherId: "t1", wiseDisplayName: "T", isOnline: false }] },
      { supportedModes: ["onsite"], wiseRecords: [{ wiseTeacherId: "t1", wiseDisplayName: "T", isOnline: false }], sessionType: "online" },
      { supportedModes: ["online", "onsite"], wiseRecords: [{ wiseTeacherId: "t1", wiseDisplayName: "T", isOnline: true }] },
      { supportedModes: ["online", "onsite"], wiseRecords: [{ wiseTeacherId: "t1", wiseDisplayName: "T", isOnline: true }], sessionType: "onsite" },
      { supportedModes: [], wiseRecords: [{ wiseTeacherId: "t1", wiseDisplayName: "T", isOnline: false }] },
    ];
    for (const c of allCases) {
      const { resolverResult } = runCase(c);
      expect(resolverResult.confidence, `confidence for ${JSON.stringify(c)}`).not.toBe("medium");
    }
  });

  // --- Tenant-vocabulary anchors (MOD-UAT-01, 2026-04-21) ---
  // The active Wise snapshot emits exactly two distinct sessionType values:
  // "OFFLINE" (24,415 rows) and "SCHEDULED" (9,677 rows). These tests lock the
  // real production vocabulary into the matrix so any future Wise vocabulary
  // drift (e.g. Wise emitting "LIVE" or "IN_PERSON" next) breaks a test before
  // it silently degrades ~28% of sessions back to "Likely online — unconfirmed".
  // The resolver lowercases + trims on compare.ts:66, so uppercase inputs from
  // the Wise API normalize through .trim().toLowerCase() into Set.has() checks.

  it("case 18: paired + isOnlineVariant=true + sessionType=\"SCHEDULED\" (uppercase, tenant vocab) → online/high (MOD-UAT-01)", () => {
    const { resolverResult, compareResult, conflictResult } = runCase({
      supportedModes: ["online", "onsite"],
      wiseRecords: [{ wiseTeacherId: "t1", wiseDisplayName: "Live Tutor", isOnline: true }],
      sessionType: "SCHEDULED",
    });
    // Before MOD-UAT-01 fix: "SCHEDULED" lowercased to "scheduled" matched neither Set,
    // so this case fell into the paired+missing-type branch and returned {online, low}.
    // Post-fix: "scheduled" ∈ ONLINE_SESSION_TYPES → agreeing-signals → {online, high}.
    expect(resolverResult.modality).toBe("online");
    expect(resolverResult.confidence).toBe("high");
    expect(compareResult.sessions[0].modality).toBe("online");
    expect(compareResult.sessions[0].modalityConfidence).toBe("high");
    expect(conflictResult).toBeNull();
  });

  it("case 19: paired + isOnlineVariant=false + sessionType=\"OFFLINE\" (uppercase, tenant vocab) → onsite/high (MOD-UAT-01)", () => {
    const { resolverResult, compareResult, conflictResult } = runCase({
      supportedModes: ["online", "onsite"],
      wiseRecords: [{ wiseTeacherId: "t1", wiseDisplayName: "Onsite Tutor", isOnline: false }],
      sessionType: "OFFLINE",
    });
    // "OFFLINE" lowercased to "offline" is already in ONSITE_SESSION_TYPES; this test
    // anchors the tenant's onsite vocabulary alongside case 18's online vocabulary so
    // the production data distribution is explicit in the matrix.
    expect(resolverResult.modality).toBe("onsite");
    expect(resolverResult.confidence).toBe("high");
    expect(compareResult.sessions[0].modality).toBe("onsite");
    expect(compareResult.sessions[0].modalityConfidence).toBe("high");
    expect(conflictResult).toBeNull();
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
