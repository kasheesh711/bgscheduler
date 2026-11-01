import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  businessDates,
  configSchema,
  DEFAULT_WEIGHTS,
  parseSeekFolderCounts,
  stageSchema,
  tokenKindSchema,
  subscriptionAuthSchema,
  type PreScreen,
} from "../model";
import { bookingToken, readBookingToken } from "../tokens";
import {
  availabilityFraction,
  degreeEligible,
  englishLevel,
  hardStops,
  preScreenAssessmentSchema,
  preScreenPoints,
  preScreenResult,
  profileCanAdvance,
  profileScore,
  assessmentSchema,
  validateAssessment,
  validatePreScreenAssessment,
  workRightsAccepted,
  PRE_SCREEN_SYSTEM,
  ASSESSMENT_SYSTEM,
  type Assessment,
} from "../scoring";
import { profileGate } from "../insights";
import { indexedSlotAvailable } from "../availability";
import type { IndexedTutorGroup } from "@/lib/search/index";
import { redactProfile } from "../../../../scripts/hiring-seek";

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
  it("removes PDF null bytes without losing the surrounding profile evidence", () => {
    expect(
      redactProfile("Example Tutor\nMathematics\0 teacher\nภาษาไทย", "Example Tutor"),
    ).toBe("[candidate]\nMathematics teacher\nภาษาไทย");
  });
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
  it("parses a stored config without the new keys", () => {
    const c = configSchema.parse({});
    expect(c.onsiteLimits).toEqual({ perWeek: 3, unbooked: 2, perHeadPerWeek: 2, perSubject: 2 });
    expect(c.preScreenLimits).toEqual({ perDay: 5, perWeek: 15, waiting: 15, perSubject: 3 });
    expect(c.preScreenThreshold).toBeNull();
    expect(c.acceptedWorkRights).toEqual(["I have permanent work rights with no restrictions"]);
    expect(c.seenWorkRights).toEqual([]);
    expect(c.subjectPriority[0]).toEqual({ subject: "Mathematics", hiring: true });
    expect([c.visitStartMinute, c.visitEndMinute, c.resumeRetentionMonths]).toEqual([600, 960, 12]);
    expect(c.preScreenFollowUp).toEqual({ remindDays: 3, expireDays: 7 });
    expect(c.onsiteFollowUp).toEqual({ remindDays: 3, expireDays: 7 });
  });
  it("refuses pre-screen weights that do not total 100", () => {
    const w = configSchema.parse({}).preScreenWeights;
    expect(Object.values(w).reduce((n, v) => n + v, 0)).toBe(100);
    expect(configSchema.safeParse({ preScreenWeights: { ...w, degree: 11 } }).success).toBe(false);
    expect(configSchema.safeParse({ preScreenThreshold: 101 }).success).toBe(false);
  });
  it("knows the visit stages and token kind", () => {
    for (const s of ["onsite_invited", "onsite_booked", "no_reply", "no_booking"]) expect(stageSchema.safeParse(s).success).toBe(true);
    expect(stageSchema.safeParse("nope").success).toBe(false);
    expect(tokenKindSchema.parse("visit")).toBe("visit");
  });
  it("keeps the short display lines out of the model's JSON schema, and stored rows without them still parse", () => {
    expect(JSON.stringify(z.toJSONSchema(assessmentSchema, { target: "draft-07" }))).not.toMatch(/brief/i);
    expect(assessmentSchema.safeParse(assessment).success).toBe(true);
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
    expect(englishLevel("Native", "")).toBe(5);
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
    // "Native" in the form field now counts as C2.
    expect(
      preScreenResult(
        { ...pre, englishEvidence: "", english: "Native" },
        assessment,
        true,
      ).eligible,
    ).toBe(true);
    expect(
      preScreenResult(
        { ...pre, englishEvidence: "", english: "" },
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
      supportedModes: ["onsite"],
      qualifications: [],
      wiseRecords: [],
      availabilityWindows: [
        {
          weekday: 1,
          startMinute: 600,
          endMinute: 960,
          modality: "onsite",
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
        {
          ...group,
          availabilityWindows: group.availabilityWindows.map((window) => ({
            ...window,
            modality: "online",
          })),
        },
        "2026-11-02",
        600,
        660,
      ),
    ).toBe(false);
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

const config = configSchema.parse({});
const answer = "I have permanent work rights with no restrictions";
const form = (extra: Partial<PreScreen> = {}): PreScreen => ({
  ...pre,
  english: "Upper-Intermediate (B2)",
  englishEvidence: "",
  availability: "Weekday Evening (17:00-21:00), Weekend Morning (before 12:00)",
  weeklyHours: "40+",
  ...extra,
});

describe("pre-screen scoring", () => {
  it("treats Native as C2 only from the form field", () => {
    expect(englishLevel("Native", "")).toBe(5);
    expect(englishLevel("Upper-Intermediate (B2)", "Native-English")).toBe(3);
    expect(englishLevel("Non-native speaker", "")).toBeNull();
  });
  it("scores availability", () => {
    expect(availabilityFraction(form())).toBe(1);
    expect(availabilityFraction(form({ weeklyHours: "11-20" }))).toBeCloseTo(0.8);
    expect(
      availabilityFraction(form({ availability: "Weekday Morning (before 12:00)", weeklyHours: "1-10" })),
    ).toBeCloseTo(0.1);
    // A weekday option and a weekend option are different choices: "17:00" in the weekend option is not a weekday.
    expect(
      availabilityFraction(form({ availability: "Weekday Morning (before 12:00), Weekend Afternoon (12:00-17:00)", weeklyHours: "1-10" })),
    ).toBeCloseTo(0.1);
    expect(availabilityFraction(form({ weeklyHours: "" }))).toBeCloseTo(0.5);
  });
  it("adds the eight parts with the editable weights", () => {
    const six = {
      ...assessment,
      criteria: [
        ...assessment.criteria.map((c) => ({ ...c, result: c.id === "degree" ? ("partial" as const) : ("met" as const) })),
        { id: "written" as const, result: "met" as const, evidence: "", reason: "Specific" },
      ],
    };
    const w = config.preScreenWeights;
    const p = preScreenPoints(six, w, 0.5, 0.8);
    expect(p).toEqual({
      degree: 5,
      subject: 10,
      curriculum: 15,
      teaching: 15,
      english: 15,
      prestige: 5,
      written: 15,
      availability: 8,
      total: 88,
    });
    // A missing criterion scores nothing.
    expect(preScreenPoints({ ...six, criteria: six.criteria.slice(0, 5) }, w, 0, 0).written).toBe(0);
  });
  it("matches work-rights answers exactly after trimming and case", () => {
    expect(workRightsAccepted(answer, [answer])).toBe(true);
    expect(workRightsAccepted(`  ${answer.toUpperCase()}  `, [answer])).toBe(true);
    expect(workRightsAccepted("I am a long term / permanent resident with eligibility for a work permit", [answer])).toBe(false);
    expect(workRightsAccepted(null, [answer])).toBe(false);
    expect(workRightsAccepted("", [answer])).toBe(false);
    expect(workRightsAccepted(answer, [])).toBe(false);
  });
  it("does not stop on an unrelated degree field", () => {
    const result = hardStops(form({ field: "Fine Art" }), answer, ["Mathematics"], config);
    expect(result.stops).toEqual([]);
    expect(result.subjects).toEqual(["Mathematics"]);
  });
  it("stops on no bachelor, B1 for Biology, no weekend, and an unaccepted work-rights answer", () => {
    expect(hardStops(form({ degree: "Below Bachelor's" }), answer, ["Biology"], config).stops).toHaveLength(1);
    expect(hardStops(form({ degree: "" }), answer, ["Biology"], config).stops).toHaveLength(1);
    expect(hardStops(form({ english: "Intermediate (B1)" }), answer, ["Biology"], config).stops.length).toBeGreaterThan(0);
    expect(hardStops(form({ english: "" }), answer, ["Biology"], config).stops.length).toBeGreaterThan(0);
    expect(hardStops(form({ availability: "Weekday Evening (17:00-21:00)" }), answer, ["Biology"], config).stops).toHaveLength(1);
    expect(hardStops(form({ availability: "Weekend Morning (before 12:00)" }), answer, ["Biology"], config).stops).toHaveLength(1);
    expect(hardStops(form(), "I am a long term / permanent resident with eligibility for a work permit", ["Biology"], config).stops).toHaveLength(1);
    expect(hardStops(form(), null, ["Biology"], config).stops).toHaveLength(1);
    expect(hardStops(form(), answer, [], config).stops).toHaveLength(1);
    expect(hardStops(form(), answer, ["Biology"], config).stops).toEqual([]);
  });
  it("stops EFL/ESL at B2 and passes Biology at B2", () => {
    const mixed = hardStops(form(), answer, ["EFL/ESL", "Biology"], config);
    expect(mixed.stops).toEqual([]);
    expect(mixed.subjects).toEqual(["Biology"]);
    const english = hardStops(form(), answer, ["EFL/ESL", "IELTS"], config);
    expect(english.stops).toHaveLength(1);
    expect(english.subjects).toEqual([]);
    expect(hardStops(form({ english: "Advanced (C1)" }), answer, ["EFL/ESL"], config).subjects).toEqual(["EFL/ESL"]);
    expect(hardStops(form({ english: "Native" }), answer, ["IELTS"], config).stops).toEqual([]);
  });
  it("keeps the portfolio rule for Art", () => {
    expect(hardStops(form(), answer, ["Art & Design Technology"], config).stops).toHaveLength(1);
    const ok = hardStops(form({ portfolio: "https://example.com/work" }), answer, ["Art & Design Technology", "Biology"], config);
    expect(ok.stops).toEqual([]);
    expect(ok.subjects).toEqual(["Art & Design Technology", "Biology"]);
    expect(hardStops(form(), answer, ["Art & Design Technology", "Biology"], config).subjects).toEqual(["Biology"]);
  });
  it("accepts a six-criterion pre-screen assessment and keeps the short lines out of the model schema", () => {
    const six = {
      ...assessment,
      criteria: [
        ...assessment.criteria,
        { id: "written", result: "met", evidence: "Check understanding", reason: "Specific actions" },
      ],
    };
    const source = "degree subject teaching english Mathematics Check understanding";
    expect(validatePreScreenAssessment(six, source).criteria).toHaveLength(6);
    expect(preScreenAssessmentSchema.safeParse(assessment).success).toBe(false);
    expect(() => validatePreScreenAssessment({ ...six, criteria: [...assessment.criteria, assessment.criteria[0]] }, source)).toThrow(/duplicate/);
    expect(() => validatePreScreenAssessment({ ...six, criteria: [...six.criteria.slice(0, 5), { ...six.criteria[5], evidence: "invented" }] }, source)).toThrow(/source/);
    expect(JSON.stringify(z.toJSONSchema(preScreenAssessmentSchema, { target: "draft-07" }))).not.toMatch(/brief/i);
  });
  it("tells the model to score written answers on content only and keeps the rule against inferring English", () => {
    expect(PRE_SCREEN_SYSTEM.startsWith(ASSESSMENT_SYSTEM)).toBe(true);
    expect(PRE_SCREEN_SYSTEM).toMatch(/written/);
    expect(PRE_SCREEN_SYSTEM).toMatch(/diagnos/i);
    expect(PRE_SCREEN_SYSTEM).toMatch(/grammar/i);
    expect(PRE_SCREEN_SYSTEM).toMatch(/Do not infer language proficiency from nationality or a name/);
  });
});

describe("profile gate", () => {
  const strong = assessment;
  const base = {
    email: "a@example.com",
    previouslyContacted: false,
    workRightsAnswer: answer,
    profileAssessment: strong,
    universityAssessment: null,
  };
  const gate = (extra = {}, over = {}) => profileGate({ ...base, ...extra }, { ...config, profileThreshold: 60, ...over });
  it("passes with a partial degree and names the subject", () => {
    const partial = { ...strong, criteria: strong.criteria.map((c) => (c.id === "degree" || c.id === "subject" ? { ...c, result: "partial" as const } : c)) };
    expect(gate({ profileAssessment: partial }, { profileThreshold: 0 })).toEqual({ eligible: true, reasons: [], subject: "Mathematics" });
    expect(gate().eligible).toBe(true);
  });
  it("refuses a not_met degree, a low score, and a missing assessment", () => {
    const failed = { ...strong, criteria: strong.criteria.map((c) => (c.id === "degree" ? { ...c, result: "not_met" as const } : c)) };
    expect(gate({ profileAssessment: failed }, { profileThreshold: 0 }).eligible).toBe(false);
    expect(gate({}, { profileThreshold: 61 }).eligible).toBe(false);
    expect(gate({ profileAssessment: null }).eligible).toBe(false);
  });
  it("refuses an unaccepted or missing work-rights answer, no email and no relevant subject", () => {
    expect(gate({ workRightsAnswer: "other" }).reasons).toHaveLength(1);
    expect(gate({ workRightsAnswer: null }).eligible).toBe(false);
    expect(gate({ email: null }).eligible).toBe(false);
    expect(gate({ profileAssessment: { ...strong, subjects: [{ ...strong.subjects[0], relevant: false }] } }).eligible).toBe(false);
  });
  it("refuses a not-hiring subject and earlier contact, and picks the highest-ranked hiring subject", () => {
    const two = { ...strong, subjects: [
      { subject: "Physics" as const, evidence: "Physics", relevant: true },
      { subject: "Mathematics" as const, evidence: "Mathematics", relevant: true },
    ] };
    const priority = (list: [string, boolean][]) => ({ subjectPriority: list.map(([subject, hiring]) => ({ subject: subject as "Physics", hiring })) });
    expect(gate({ profileAssessment: { ...strong } }, priority([["Mathematics", false]])).eligible).toBe(false);
    expect(gate({ previouslyContacted: true }).eligible).toBe(false);
    expect(gate({ profileAssessment: two }, priority([["Mathematics", true], ["Physics", true]])).subject).toBe("Mathematics");
    expect(gate({ profileAssessment: two }, priority([["Physics", true], ["Mathematics", true]])).subject).toBe("Physics");
    expect(gate({ profileAssessment: two }, priority([["Mathematics", false], ["Physics", true]]))).toMatchObject({ eligible: true, subject: "Physics" });
  });
});
