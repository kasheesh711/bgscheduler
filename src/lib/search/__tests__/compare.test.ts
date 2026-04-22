import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildCompareTutor, detectConflicts, findSharedFreeSlots, resolveSessionModality, detectSessionModalityConflict } from "../compare";
import type { IndexedSessionBlock, IndexedTutorGroup, SearchIndex } from "../index";

function makeTutor(overrides: Partial<IndexedTutorGroup> = {}): IndexedTutorGroup {
  return {
    id: "g1",
    canonicalKey: "test-tutor",
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

describe("buildCompareTutor past+future merge + per-weekday historical flag (Phase 7)", () => {
  // Freeze system time for deterministic "today" comparisons in getStartOfTodayBkk.
  // Simulate today = 2026-04-15 (Wednesday) in Asia/Bangkok. Given weekday
  // encoding Mon=1..Sun=0, this makes weekdays 1 (Mon 04-13) and 2 (Tue 04-14)
  // historical; weekday 3 (Wed 04-15) is today; weekdays 4..0 (Thu..Sun) future.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-15T00:00:00+07:00"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Current-week dateRange (Mon 2026-04-13 through end-of-Sun 2026-04-19).
  // Using local-TZ constructors so computeDateForWeekdayInRange's arithmetic is
  // consistent regardless of the host's wall-clock zone (avoids off-by-one).
  function currentWeek(): { start: Date; end: Date } {
    return {
      start: new Date(2026, 3, 13), // Mon 2026-04-13 00:00 local
      end: new Date(2026, 3, 20), // Mon 2026-04-20 00:00 local (exclusive)
    };
  }

  function futureWeek(): { start: Date; end: Date } {
    return {
      start: new Date(2026, 3, 27), // Mon 2026-04-27 00:00 local
      end: new Date(2026, 4, 4), // Mon 2026-05-04 00:00 local (exclusive)
    };
  }

  function oldHistoricalWeek(): { start: Date; end: Date } {
    // Mon 2026-04-06 through end-of-Sun 2026-04-12 — entirely before today.
    return {
      start: new Date(2026, 3, 6),
      end: new Date(2026, 3, 13),
    };
  }

  function makePastMondaySession(): IndexedSessionBlock {
    // Captured Monday session 10:00-11:00 BKK on 2026-04-13 (past relative to
    // frozen today). Uses wiseTeacherId "t1" (onsite variant) per makeTutor().
    return {
      startTime: new Date(2026, 3, 13, 10, 0, 0),
      endTime: new Date(2026, 3, 13, 11, 0, 0),
      weekday: 1,
      startMinute: 600,
      endMinute: 660,
      isBlocking: true,
      wiseTeacherId: "t1",
      studentName: "Alex P.",
      subject: "Math",
      title: "Math - Alex P.",
      classType: "ONE_TO_ONE",
    };
  }

  it("historical week: returns captured past data, no weekday-fallback for empty past days", () => {
    // Tutor has no future sessionBlocks at all (oldHistoricalWeek is entirely
    // past; also verifies that the weekday-fallback for empty past days is
    // disabled — tutor should NOT inherit any nearest-future occurrence on Tue.
    const tutor = makeTutor({ sessionBlocks: [] });
    const past: IndexedSessionBlock[] = [
      // Captured past session on 2026-04-06 (Monday of oldHistoricalWeek).
      {
        startTime: new Date(2026, 3, 6, 10, 0, 0),
        endTime: new Date(2026, 3, 6, 11, 0, 0),
        weekday: 1,
        startMinute: 600,
        endMinute: 660,
        isBlocking: true,
        wiseTeacherId: "t1",
        studentName: "Alex P.",
        subject: "Math",
      },
    ];

    const result = buildCompareTutor(tutor, undefined, oldHistoricalWeek(), past);

    // Exactly the captured past Monday session — no Tuesday fallback.
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].weekday).toBe(1);
    expect(result.sessions[0].studentName).toBe("Alex P.");
    // Explicit absence of any Tuesday/Wednesday/etc. fallback: no other weekdays present.
    const weekdaysPresent = new Set(result.sessions.map((s) => s.weekday));
    expect(weekdaysPresent.has(2)).toBe(false);
    expect(weekdaysPresent.has(3)).toBe(false);
  });

  it("historical week + no past data: returns empty sessions (honest empty per D-09)", () => {
    // Tutor has future recurring Monday session, but because the requested
    // week is entirely historical every weekday's fallback is disabled.
    const tutor = makeTutor({
      sessionBlocks: [
        {
          // A future Monday occurrence that WOULD satisfy the fallback predicate
          // (startTime >= dateRange.end) if the fallback were enabled.
          startTime: new Date(2026, 4, 11, 9, 0, 0),
          endTime: new Date(2026, 4, 11, 10, 0, 0),
          weekday: 1,
          startMinute: 540,
          endMinute: 600,
          isBlocking: true,
          wiseTeacherId: "t1",
          studentName: "Ava T.",
          subject: "Math",
          recurrenceId: "r-mon-recur",
        },
      ],
    });

    const result = buildCompareTutor(tutor, undefined, oldHistoricalWeek(), []);

    // All 7 weekdays are historical → fallback disabled everywhere → honest empty.
    expect(result.sessions).toHaveLength(0);
  });

  it("future week + no past data: preserves existing weekday-fallback behavior", () => {
    // Tutor has a recurring Monday session in the distant future (after the
    // requested future week). The fallback MUST kick in because no day in the
    // range is historical.
    const tutor = makeTutor({
      sessionBlocks: [
        {
          startTime: new Date(2026, 4, 11, 9, 0, 0), // Mon 2026-05-11 — after futureWeek.end (2026-05-04)
          endTime: new Date(2026, 4, 11, 10, 0, 0),
          weekday: 1,
          startMinute: 540,
          endMinute: 600,
          isBlocking: true,
          wiseTeacherId: "t1",
          studentName: "Ben K.",
          subject: "English",
          recurrenceId: "r-mon-recur",
        },
      ],
    });

    const result = buildCompareTutor(tutor, undefined, futureWeek());

    // Fallback should fill in Monday from the nearest-future occurrence.
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].weekday).toBe(1);
    expect(result.sessions[0].studentName).toBe("Ben K.");
  });

  it("current week: past weekdays respect captured-or-empty, future weekdays keep fallback (D-05 per-weekday)", () => {
    // Today = Wed 2026-04-15 BKK. currentWeek = Mon 04-13 → Sun 04-19.
    //   Mon (wd=1): historical — fallback OFF. We provide captured past data.
    //   Tue (wd=2): historical — fallback OFF. No data → empty.
    //   Wed (wd=3): today — fallback ON (no matching weekday=3 in allBlocks → empty).
    //   Thu (wd=4): future — fallback ON. We provide a future Thursday recurring.
    //   Fri..Sun: future — fallback ON, but no matching data → empty.
    const tutor = makeTutor({
      sessionBlocks: [
        // Future Thursday recurring after currentWeek.end (will be pulled by Thu fallback).
        {
          startTime: new Date(2026, 4, 14, 9, 0, 0), // Thu 2026-05-14
          endTime: new Date(2026, 4, 14, 10, 0, 0),
          weekday: 4,
          startMinute: 540,
          endMinute: 600,
          isBlocking: true,
          wiseTeacherId: "t1",
          studentName: "Thu Student",
          subject: "Math",
          recurrenceId: "r-thu",
        },
      ],
    });

    const past: IndexedSessionBlock[] = [makePastMondaySession()];

    const result = buildCompareTutor(tutor, undefined, currentWeek(), past);

    // Expected: Mon (captured) + Thu (fallback) = 2 sessions total.
    expect(result.sessions).toHaveLength(2);

    const mondaySessions = result.sessions.filter((s) => s.weekday === 1);
    const thursdaySessions = result.sessions.filter((s) => s.weekday === 4);
    expect(mondaySessions).toHaveLength(1);
    expect(mondaySessions[0].studentName).toBe("Alex P.");
    expect(thursdaySessions).toHaveLength(1);
    expect(thursdaySessions[0].studentName).toBe("Thu Student");

    // Explicit PER-WEEKDAY enforcement: Tue (historical, no data) and Wed
    // (today, no matching weekday data) MUST NOT inherit any fallback.
    expect(result.sessions.some((s) => s.weekday === 2)).toBe(false);
    expect(result.sessions.some((s) => s.weekday === 3)).toBe(false);
  });

  it("backward-compat: calling without pastBlocks behaves identically to pre-Phase-7", () => {
    // Same shape as the existing weekday-fallback test in `buildCompareTutor`
    // above but asserts the NEW signature still honors the OLD behavior when
    // pastBlocks is omitted.
    const tutor = makeTutor({
      sessionBlocks: [
        {
          startTime: new Date(2026, 4, 11, 9, 0, 0), // Mon 2026-05-11 — future
          endTime: new Date(2026, 4, 11, 10, 0, 0),
          weekday: 1,
          startMinute: 540,
          endMinute: 600,
          isBlocking: true,
          wiseTeacherId: "t1",
          studentName: "Backward Compat",
          subject: "Math",
          recurrenceId: "r-mon-bc",
        },
      ],
    });

    // 3-arg call (no pastBlocks param) — must match pre-Phase-7 fallback behavior
    // for the future week.
    const result = buildCompareTutor(tutor, undefined, futureWeek());

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].studentName).toBe("Backward Compat");

    // Sanity: passing `undefined` explicitly is also fine.
    const resultUndefined = buildCompareTutor(tutor, undefined, futureWeek(), undefined);
    expect(resultUndefined.sessions).toHaveLength(1);
    expect(resultUndefined.sessions[0].studentName).toBe("Backward Compat");
  });

  it("detectConflicts sees merged past+future sessions for same student (Pitfall 13)", () => {
    // Historical week. Tutor A has the "past" session via pastBlocks. Tutor B
    // has a session on the same Monday via regular sessionBlocks (a captured
    // future_session_block whose startTime is within the past-week range — this
    // is how the live /api/compare route passes past-week data through the
    // existing filter pipeline). After merge, both appear in their respective
    // CompareTutor.sessions and detectConflicts finds the same-student overlap.
    const historicalRange = oldHistoricalWeek(); // Mon 2026-04-06 → Mon 2026-04-13

    const tutorA = makeTutor({
      id: "g1",
      displayName: "Kevin H.",
      sessionBlocks: [],
    });
    const tutorB = makeTutor({
      id: "g2",
      displayName: "Samantha W.",
      sessionBlocks: [
        {
          startTime: new Date(2026, 3, 6, 10, 0, 0),
          endTime: new Date(2026, 3, 6, 11, 0, 0),
          weekday: 1,
          startMinute: 600,
          endMinute: 660,
          isBlocking: true,
          wiseTeacherId: "t1",
          studentName: "Alex P.",
          subject: "English",
          title: "English - Alex P.",
        },
      ],
    });

    const pastForA: IndexedSessionBlock[] = [
      {
        startTime: new Date(2026, 3, 6, 10, 0, 0),
        endTime: new Date(2026, 3, 6, 11, 0, 0),
        weekday: 1,
        startMinute: 600,
        endMinute: 660,
        isBlocking: true,
        wiseTeacherId: "t1",
        studentName: "Alex P.",
        subject: "Math",
        title: "Math - Alex P.",
      },
    ];

    const compareA = buildCompareTutor(tutorA, undefined, historicalRange, pastForA);
    const compareB = buildCompareTutor(tutorB, undefined, historicalRange);

    expect(compareA.sessions).toHaveLength(1);
    expect(compareB.sessions).toHaveLength(1);
    expect(compareA.sessions[0].studentName).toBe("Alex P.");
    expect(compareB.sessions[0].studentName).toBe("Alex P.");

    const conflicts = detectConflicts([compareA, compareB], [tutorA, tutorB]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].studentName).toBe("Alex P.");
    expect(conflicts[0].dayOfWeek).toBe(1);
    const tutorNames = new Set([conflicts[0].tutorA.displayName, conflicts[0].tutorB.displayName]);
    expect(tutorNames.has("Kevin H.")).toBe(true);
    expect(tutorNames.has("Samantha W.")).toBe(true);
  });
});
