import { describe, expect, it } from "vitest";
import {
  businessDates,
  configSchema,
  DEFAULT_WEIGHTS,
  parseSeekFolderCounts,
  subscriptionAuthSchema,
  type PreScreen,
} from "../model";
import { bookingToken, readBookingToken } from "../tokens";
import {
  degreeEligible,
  englishLevel,
  preScreenResult,
  profileCanAdvance,
  profileScore,
  validateAssessment,
  type Assessment,
} from "../scoring";
import { indexedSlotAvailable } from "../availability";
import type { IndexedTutorGroup } from "@/lib/search/index";

const assessment: Assessment = {
  criteria: (
    ["degree", "subject", "curriculum", "teaching", "english"] as const
  ).map((id) => ({
    id,
    result: id === "curriculum" ? "unknown" : "met",
    evidence: id === "curriculum" ? "" : id,
    reason: "Source evidence",
  })),
  subjects: [
    { subject: "Mathematics", evidence: "Mathematics", relevant: true },
  ],
  universities: [],
  summary: "Evidence reviewed",
};
const pre: PreScreen = {
  sourceRow: 2,
  submittedAt: "2026-10-30",
  degree: "Bachelor's, Master's",
  field: "Mathematics",
  subjects: "Mathematics",
  curricula: "IGCSE",
  yearGroups: "Year 10",
  english: "Native",
  englishEvidence: "CEFR C2",
  experience: "5+ years",
  portfolio: "",
  availability:
    "Weekday Afternoon (12:00-17:00), Weekend Morning (before 12:00)",
  weeklyHours: "20",
  motivation: "Teaching",
  teachingApproach: "Check understanding",
};

describe("hiring decision boundaries", () => {
  it("reads total folder counts rather than new counts and refuses incomplete source coverage", () => {
    const labels = [
      "Inbox\n331 New\n1,362",
      "Prescreen\n45",
      "Shortlist\n72",
      "Interview\n0",
      "Offer\n0",
      "Accept\n0",
      "Not Suitable\n158",
    ];
    expect(parseSeekFolderCounts(labels)[0]).toEqual({
      status: "Inbox",
      count: 1362,
    });
    expect(parseSeekFolderCounts(labels)[3].count).toBe(0);
    expect(
      parseSeekFolderCounts(
        labels.map((value) => value.replaceAll("\n", "")),
      )[0].count,
    ).toBe(1362);
    expect(() => parseSeekFolderCounts(labels.slice(1))).toThrow(/counts/);
  });
  it("accepts only a signed-in Claude subscription for automatic scoring", () => {
    expect(
      subscriptionAuthSchema.safeParse({
        loggedIn: true,
        authMethod: "claude.ai",
        subscriptionType: "max",
      }).success,
    ).toBe(true);
    expect(
      subscriptionAuthSchema.safeParse({
        loggedIn: true,
        authMethod: "api_key",
      }).success,
    ).toBe(false);
    expect(
      subscriptionAuthSchema.safeParse({
        loggedIn: false,
        authMethod: "claude.ai",
        subscriptionType: "max",
      }).success,
    ).toBe(false);
  });
  it("uses the user's editable weights and threshold without ignoring mandatory evidence", () => {
    expect(profileScore(assessment, DEFAULT_WEIGHTS)).toBe(60);
    expect(profileCanAdvance(assessment, 60, DEFAULT_WEIGHTS)).toBe(true);
    expect(profileCanAdvance(assessment, 61, DEFAULT_WEIGHTS)).toBe(false);
    const changed = {
      degree: 10,
      subject: 10,
      curriculum: 50,
      teaching: 10,
      english: 20,
    };
    expect(profileScore(assessment, changed)).toBe(50);
    expect(
      profileCanAdvance(
        {
          ...assessment,
          criteria: assessment.criteria.map((c) =>
            c.id === "degree" ? { ...c, result: "unknown" } : c,
          ),
        },
        0,
      ),
    ).toBe(false);
    expect(
      configSchema.safeParse({
        profileWeights: { ...DEFAULT_WEIGHTS, english: 19 },
      }).success,
    ).toBe(false);
  });
  it("requires exact source evidence and rejects duplicate criteria", () => {
    const source = "degree subject teaching english Mathematics";
    expect(validateAssessment(assessment, source)).toEqual(assessment);
    expect(() =>
      validateAssessment(
        {
          ...assessment,
          summary: "Valid",
          subjects: [
            {
              subject: "Physics",
              relevant: true,
              evidence: "invented evidence",
            },
          ],
        },
        source,
      ),
    ).toThrow(/source/);
    expect(() =>
      validateAssessment(
        { ...assessment, criteria: Array(5).fill(assessment.criteria[0]) },
        source,
      ),
    ).toThrow(/duplicate/);
  });
  it("accepts combined degrees, handles Native without inventing a CEFR level, and requires both work periods", () => {
    expect(degreeEligible("Bachelor's, Master's")).toBe(true);
    expect(degreeEligible("Below Bachelor's")).toBe(false);
    expect(englishLevel("Native", "")).toBeNull();
    expect(englishLevel("Native", "CEFR C2")).toBe(5);
    expect(preScreenResult(pre, assessment, true).eligible).toBe(true);
    expect(
      preScreenResult(
        pre,
        {
          ...assessment,
          criteria: assessment.criteria.map((c) =>
            c.id === "degree" ? { ...c, result: "partial" } : c,
          ),
        },
        true,
      ).eligible,
    ).toBe(false);
    expect(
      preScreenResult(
        { ...pre, availability: "Weekday Evening (17:00-21:00)" },
        assessment,
        true,
      ).eligible,
    ).toBe(false);
    expect(
      preScreenResult(
        { ...pre, englishEvidence: "", english: "Native" },
        assessment,
        true,
      ).eligible,
    ).toBe(false);
  });
  it("returns the next five whole Bangkok business days and respects closures", () => {
    expect(businessDates(new Date("2026-10-30T23:00:00Z"))).toEqual([
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
      "2026-11-06",
    ]);
    expect(
      businessDates(new Date("2026-10-30T23:00:00Z"), ["2026-11-03"]),
    ).toEqual([
      "2026-11-02",
      "2026-11-04",
      "2026-11-05",
      "2026-11-06",
      "2026-11-09",
    ]);
  });
  it("rejects tampered and expired booking capabilities", () => {
    const now = new Date("2026-10-31T00:00:00Z"),
      expiry = new Date("2026-11-02T00:00:00Z");
    const token = bookingToken(
      "00000000-0000-4000-8000-000000000001",
      "mock",
      expiry,
      "test-secret",
    );
    expect(readBookingToken(token, now, "test-secret").kind).toBe("mock");
    expect(() => readBookingToken(token + "x", now, "test-secret")).toThrow();
    expect(() => readBookingToken(token, expiry, "test-secret")).toThrow();
    expect(() => readBookingToken(token, now, "wrong-secret")).toThrow();
  });
  it("needs positive onsite evidence, complete leave coverage, and no dated clash", () => {
    const group: IndexedTutorGroup = {
      id: "g",
      canonicalKey: "Peat",
      displayName: "Peat",
      supportedModes: ["OFFLINE"],
      qualifications: [],
      wiseRecords: [],
      availabilityWindows: [
        {
          weekday: 1,
          startMinute: 600,
          endMinute: 960,
          modality: "OFFLINE",
          wiseTeacherId: "w",
        },
      ],
      leaves: [],
      leavesCompleteThrough: new Date("2026-11-10"),
      sessionBlocks: [],
      dataIssues: [],
    };
    expect(indexedSlotAvailable(group, "2026-11-02", 600, 660)).toBe(true);
    expect(
      indexedSlotAvailable(
        { ...group, availabilityWindows: [] },
        "2026-11-02",
        600,
        660,
      ),
    ).toBe(false);
    expect(
      indexedSlotAvailable(
        { ...group, leavesCompleteThrough: null },
        "2026-11-02",
        600,
        660,
      ),
    ).toBe(false);
    const block = {
      startTime: new Date("2026-11-02T03:30:00Z"),
      endTime: new Date("2026-11-02T04:30:00Z"),
      weekday: 1,
      startMinute: 630,
      endMinute: 690,
      isBlocking: true,
      wiseTeacherId: "w",
    };
    expect(
      indexedSlotAvailable(
        { ...group, sessionBlocks: [block] },
        "2026-11-02",
        600,
        660,
      ),
    ).toBe(false);
    expect(
      indexedSlotAvailable(
        { ...group, sessionBlocks: [{ ...block, isBlocking: false }] },
        "2026-11-02",
        600,
        660,
      ),
    ).toBe(true);
    expect(indexedSlotAvailable(group, "2026-11-02", 960, 1020)).toBe(false);
  });
});
