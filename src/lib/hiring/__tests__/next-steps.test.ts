import { describe, expect, it } from "vitest";
import { configSchema, PRE_SCREEN_URL, TEST_SUBJECT_QUESTION, type PreScreen } from "../model";
import { visitSubject } from "../scoring";
import { preScreenRows } from "../sources";
import { preScreenEmail } from "../service";

const ACCEPTED = "I have permanent work rights with no restrictions";
const config = configSchema.parse({
  acceptedWorkRights: [ACCEPTED],
  interviewers: [
    { canonicalKey: "Peat", email: "peat@example.com", subjects: ["Mathematics", "Physics"] },
    { canonicalKey: "Tito", email: "tito@example.com", subjects: ["History"] },
  ],
});
const pre: PreScreen = {
  sourceRow: 2,
  submittedAt: "5/11/2026, 05:00:00",
  degree: "Bachelor's",
  field: "Physics",
  subjects: "Mathematics, Physics, History",
  curricula: "IGCSE",
  yearGroups: "Year 10",
  english: "Advanced (C1)",
  englishEvidence: "",
  experience: "5+ years",
  portfolio: "",
  availability: "Weekday Evening (17:00-21:00), Weekend Morning (before 12:00)",
  weeklyHours: "20",
  motivation: "Teaching",
  teachingApproach: "Check understanding",
};
describe("visitSubject", () => {
  const top = visitSubject(pre, ACCEPTED, config);
  it("uses the subject the candidate chose to be tested on when it is ticked, hiring and has a head", () => {
    const other = top === "Physics" ? "Mathematics" : "Physics";
    expect(visitSubject({ ...pre, testSubject: other }, ACCEPTED, config)).toBe(other);
    // The form's own spelling is normalised like the subject list.
    expect(visitSubject({ ...pre, testSubject: "maths" }, ACCEPTED, config)).toBe("Mathematics");
  });
  it("falls back to the top subject when the choice is not usable", () => {
    // Not ticked in the subject list.
    expect(visitSubject({ ...pre, subjects: "Mathematics, Physics", testSubject: "History" }, ACCEPTED, config)).toBe(top);
    // Ticked, but no head teaches it.
    expect(visitSubject({ ...pre, subjects: "Mathematics, Physics, Chemistry", testSubject: "Chemistry" }, ACCEPTED, config)).toBe(top);
    // No answer, as in every response before the question existed.
    expect(visitSubject(pre, ACCEPTED, config)).toBe(top);
  });
});

describe("preScreenRows", () => {
  const header = (extra: string[] = []) => {
    const row = Array.from({ length: 18 }, (_, i) => `Q${i}`);
    row[2] = "Contact Email";
    row[17] = "A student is bright but keeps losing motivation and their grades are slipping. How would you approach it?";
    return [...row, ...extra];
  };
  const answer = (extra: string[] = []) => {
    const row = Array.from({ length: 18 }, () => "x");
    row[2] = "Ann@Example.com";
    return [...row, ...extra];
  };
  it("reads the test-subject question by its header, wherever the form puts it", () => {
    const rows = preScreenRows([header(["Notes", TEST_SUBJECT_QUESTION]), answer(["", "Physics"])]);
    expect(rows.get("ann@example.com")?.pre.testSubject).toBe("Physics");
  });
  it("leaves the field out when the question or the answer is missing, so older responses keep their hash", () => {
    expect(preScreenRows([header(), answer()]).get("ann@example.com")?.pre).not.toHaveProperty("testSubject");
    expect(preScreenRows([header([TEST_SUBJECT_QUESTION]), answer([""])]).get("ann@example.com")?.pre).not.toHaveProperty("testSubject");
  });
});

describe("preScreenEmail with a visit link (Next steps)", () => {
  const visit = "https://bgscheduler.vercel.app/hiring/book/visit-token";
  it("gives the form and the visit link together, and says booking opens after the answers", () => {
    const email = preScreenEmail("Ann", "ann@example.com", false, visit);
    expect(email.subject).toBe("Next steps: your BeGifted pre-screening questions and onsite visit");
    for (const part of [email.text, email.html]) {
      expect(part).toContain("Thank you for your time at R1: HR Interview");
      expect(part).toContain(PRE_SCREEN_URL);
      expect(part).toContain(visit);
      expect(part).toContain("which subject you want to be tested on");
      expect(part).toContain("When booking opens, we email you");
      expect(part).toContain("ann@example.com");
    }
  });
  it("shows the two steps as buttons, R1 as done and this step as the reader's place", () => {
    const email = preScreenEmail("Ann", "ann@example.com", false, visit);
    expect(email.html).toContain(">Open the questionnaire</a>");
    expect(email.html).toContain(">Book your onsite visit</a>");
    expect(email.text).toContain("2. Pre-screening questions and visit booking (You are here)");
    expect(email.html).toContain(">Done</p>");
    expect(email.html).toContain("/brand/email/hiring/v1/hero-next-steps.jpg");
  });
  it("keeps the visit link in the reminder, and a form sent before this change keeps the old wording", () => {
    expect(preScreenEmail("Ann", "ann@example.com", true, visit).text).toContain(visit);
    const old = preScreenEmail("Ann", "ann@example.com", false);
    expect(old.subject).toBe("BeGifted tutor pre-screening questionnaire");
    expect(old.text).not.toContain("/hiring/book/");
  });
});
