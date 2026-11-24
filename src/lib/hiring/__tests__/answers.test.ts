import { describe, expect, it } from "vitest";
import { answersSchema, answersToPreScreen, configSchema, preScreenSchema, type Answers } from "../model";
import { availabilityFraction, hardStops, visitSubject } from "../scoring";
import { normalizeSubjects } from "../model";

const ACCEPTED = "I have permanent work rights with no restrictions";
const config = configSchema.parse({
  acceptedWorkRights: [ACCEPTED],
  interviewers: [{ canonicalKey: "Peat", email: "peat@example.com", subjects: ["Mathematics", "Physics"] }],
});
const good: Answers = {
  degree: "Master's",
  field: "Physics",
  subjects: ["Mathematics", "Physics"],
  testSubject: "Physics",
  curricula: ["British (IGCSE/ GCSE/ A-level)"],
  yearGroups: ["Year 10-11 (IGCSE Level)"],
  english: "Advanced (C1)",
  englishEvidence: "",
  experience: "3-5 years",
  portfolio: "",
  availability: ["Weekday Evening (17:00-21:00)", "Weekend Morning (before 12:00)"],
  weeklyHours: "11-20",
  motivation: "I want to help students who find physics hard to see why each step works.",
  teachingApproach: "First I ask the student what changed, then I set one small goal for each lesson.",
};
const stops = (patch: Partial<Answers>) => {
  const pre = answersToPreScreen(answersSchema.parse({ ...good, ...patch }), new Date("2026-11-24T05:00:00Z"));
  return hardStops(pre, ACCEPTED, normalizeSubjects(pre.subjects), config).stops;
};

describe("answersSchema (the questions on the booking page)", () => {
  it("accepts a full answer and stores it in the Google Form's shape", () => {
    const pre = answersToPreScreen(answersSchema.parse(good), new Date("2026-11-24T05:00:00Z"));
    expect(preScreenSchema.parse(pre)).toMatchObject({
      sourceRow: 0,
      submittedAt: "2026-11-24T05:00:00.000Z",
      degree: "Master's",
      subjects: "Mathematics, Physics",
      testSubject: "Physics",
      availability: "Weekday Evening (17:00-21:00), Weekend Morning (before 12:00)",
    });
    expect(stops({})).toEqual([]);
    expect(visitSubject(pre, ACCEPTED, config)).toBe("Physics");
    // A weekend day and a late weekday give half; the 11-20 band gives 60% of the other half.
    expect(availabilityFraction(pre)).toBeCloseTo(0.8);
  });
  it("refuses a missing choice, an empty written answer and a value that is not a choice; a short answer is accepted", () => {
    const bad = (patch: object) => answersSchema.safeParse({ ...good, ...patch }).success;
    expect(bad({ degree: undefined })).toBe(false);
    expect(bad({ subjects: [] })).toBe(false);
    expect(bad({ availability: [] })).toBe(false);
    expect(bad({ english: undefined })).toBe(false);
    expect(bad({ english: "Fluent" })).toBe(false);
    // No minimum length (Kevin, 24 Nov 2026).
    expect(bad({ motivation: "Teaching" })).toBe(true);
    expect(bad({ motivation: "" })).toBe(false);
    expect(bad({ teachingApproach: " ".repeat(80) })).toBe(false);
    expect(bad({ extra: "x" })).toBe(false);
  });
  it("needs a test subject from the ticked subjects, and stores the portfolio link and the uploaded file together", () => {
    const first = (patch: object) => answersSchema.safeParse({ ...good, ...patch }).error?.issues[0]?.message;
    expect(first({ testSubject: "History" })).toMatch(/test subject/);
    const art = answersSchema.parse({ ...good, subjects: ["Art & Design Technology"], testSubject: "Art & Design Technology", portfolio: "https://example.com/p" });
    const now = new Date("2026-11-24T05:00:00Z");
    expect(answersToPreScreen(art, now, "Uploaded file: https://app.test/api/hiring/portfolio/x").portfolio).toBe("https://example.com/p · Uploaded file: https://app.test/api/hiring/portfolio/x");
    expect(answersToPreScreen({ ...art, portfolio: "" }, now, "Uploaded file: u").portfolio).toBe("Uploaded file: u");
    // With no file and no link, Art fails the portfolio hard stop even if the server check is passed by.
    const bare = answersToPreScreen({ ...art, portfolio: "" }, now);
    expect(hardStops(bare, ACCEPTED, normalizeSubjects(bare.subjects), config).stops).toHaveLength(1);
  });
  it("lets every hard stop read the page's own choices", () => {
    expect(stops({ degree: "Below Bachelor's" })).toEqual(["No completed bachelor's degree."]);
    expect(stops({ availability: ["Weekday Evening (17:00-21:00)"] })).toEqual(["Needs a weekend day and a weekday after 15:00."]);
    expect(stops({ availability: ["Weekday Morning (before 12:00)", "Weekend Evening (17:00-21:00)"] })).toHaveLength(1);
    // B1 meets no subject. B2 does not meet an English subject.
    expect(stops({ english: "Intermediate (B1)" })).toHaveLength(1);
    expect(stops({ english: "Upper-Intermediate (B2)", subjects: ["IELTS"], testSubject: "IELTS" })).toHaveLength(1);
    expect(stops({ english: "Native", subjects: ["IELTS"], testSubject: "IELTS" })).toEqual([]);
  });
});
