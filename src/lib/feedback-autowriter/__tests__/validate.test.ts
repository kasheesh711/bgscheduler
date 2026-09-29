import { describe, expect, it } from "vitest";
import { finalizeFields, parseModelOutput, validateFeedbackDraft, type ModelOutput } from "../validate";
import { GOOD_FIELDS, STUDENT_NAME } from "./fixtures";

const tutorNames = ["Kevin Hsieh", "Kev"];
const goodOutput: ModelOutput = {
  topics: GOOD_FIELDS.topics,
  performance: GOOD_FIELDS.performance.replaceAll("Somchai", "[STUDENT_1]"),
  improvement: GOOD_FIELDS.improvement.replaceAll("Somchai", "[STUDENT_1]"),
  homework: "",
  studentAttended: true,
  lessonHappened: true,
};

function check(output: ModelOutput, priorFeedback = []) {
  const fields = finalizeFields(output, "Somchai");
  return validateFeedbackDraft({ output, fields, studentFullName: STUDENT_NAME, tutorNames, priorFeedback });
}

describe("parseModelOutput", () => {
  it("accepts strict JSON, with or without a code fence", () => {
    expect(parseModelOutput(JSON.stringify(goodOutput)).ok).toBe(true);
    expect(parseModelOutput(`\`\`\`json\n${JSON.stringify(goodOutput)}\n\`\`\``).ok).toBe(true);
  });

  it("rejects non-JSON and extra or missing keys", () => {
    expect(parseModelOutput("not json")).toEqual({ ok: false, reason: "output_not_json" });
    expect(parseModelOutput(JSON.stringify({ ...goodOutput, extra: 1 }))).toEqual({ ok: false, reason: "output_schema_mismatch" });
    const missing: Partial<ModelOutput> = { ...goodOutput };
    delete missing.homework;
    expect(parseModelOutput(JSON.stringify(missing))).toEqual({ ok: false, reason: "output_schema_mismatch" });
  });
});

describe("finalizeFields", () => {
  it("restores the student name and tidies whitespace", () => {
    const fields = finalizeFields({ ...goodOutput, topics: "  Fractions  \n\n\n\nand decimals " }, "Somchai");
    expect(fields.topics).toBe("Fractions\n\nand decimals");
    expect(fields.performance.startsWith("Somchai found")).toBe(true);
  });
});

describe("validateFeedbackDraft", () => {
  it("accepts compliant, specific feedback", () => {
    expect(check(goodOutput)).toEqual({ ok: true });
  });

  it("rejects when the model reports no lesson or an absent student", () => {
    const result = check({ ...goodOutput, studentAttended: false, lessonHappened: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toEqual(expect.arrayContaining(["model_reports_student_not_attended", "model_reports_no_lesson"]));
  });

  it("rejects wording that would make the class deduction-exempt", () => {
    const result = check({ ...goodOutput, homework: "The student was absent." });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons.some((reason) => reason.startsWith("attendance_wording:"))).toBe(true);
  });

  it("rejects short or placeholder fields and leftover tokens", () => {
    const short = check({ ...goodOutput, topics: "Fractions." });
    expect(short.ok).toBe(false);
    const token = check({ ...goodOutput, performance: `${goodOutput.performance} [TUTOR] was pleased.` });
    expect(token.ok).toBe(false);
    if (!token.ok) expect(token.reasons).toContain("placeholder_token:performance");
  });

  it("rejects markdown formatting", () => {
    const result = check({ ...goodOutput, topics: `**Topics**\n${goodOutput.topics}` });
    expect(result.ok).toBe(false);
  });

  it("rejects near-copies of the tutor's recent feedback", () => {
    const result = check(goodOutput, [{ key: "prior", fields: GOOD_FIELDS, studentNames: [STUDENT_NAME] }] as never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("ai_suspect:similar_prior_feedback");
  });
});
