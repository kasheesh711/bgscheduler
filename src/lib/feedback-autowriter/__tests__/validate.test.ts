import { describe, expect, it } from "vitest";
import { dropRecordCommentary, feedbackTextChecks, finalizeFields, parseModelOutput, validateFeedbackDraft, type ModelOutput } from "../validate";
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

  it("rejects Thai text: feedback is English for everyone", () => {
    const result = check({ ...goodOutput, topics: `${goodOutput.topics} (เศษส่วน)` });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("thai_text:topics");
  });

  it("allows the student's own Thai name, restored after the model wrote a placeholder", () => {
    const fields = finalizeFields(goodOutput, "สมชาย");
    expect(fields.performance.startsWith("สมชาย")).toBe(true);
    const result = validateFeedbackDraft({ output: goodOutput, fields, studentFullName: STUDENT_NAME, tutorNames, priorFeedback: [] });
    expect(result.ok ? [] : result.reasons.filter((reason) => reason.startsWith("thai_text"))).toEqual([]);
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
    for (const [label, improvement] of [
      ["heading", `## Next steps\n${goodOutput.improvement}`],
      ["bold with underscores", `${goodOutput.improvement} Practise __common denominators__ daily.`],
      ["bold with asterisks", `${goodOutput.improvement} Practise **common denominators** daily.`],
      ["bold italic with underscores", `${goodOutput.improvement} Practise ___common denominators___ daily.`],
      ["bold over a line break", `${goodOutput.improvement} Practise __common\ndenominators__ daily.`],
    ]) {
      const marked = check({ ...goodOutput, improvement });
      expect(marked.ok, label).toBe(false);
      if (!marked.ok) expect(marked.reasons, label).toContain("markdown:improvement");
    }
  });

  it("accepts a fill-in blank, which is not markdown (30 Sep replay)", () => {
    for (const blank of ["I am ___ for adjectives", "She __ to school", "___ and ___", "a gap (____) to fill"]) {
      const result = check({ ...goodOutput, improvement: `${goodOutput.improvement} Quick checks such as ${blank} help.` });
      expect(result, blank).toEqual({ ok: true });
    }
  });

  it("rejects near-copies of the tutor's recent feedback", () => {
    const result = check(goodOutput, [{ key: "prior", fields: GOOD_FIELDS, studentNames: [STUDENT_NAME] }] as never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("ai_suspect:similar_prior_feedback");
  });
});

describe("record commentary (owner, 12 Oct: no tutor writes \"No deadline was stated.\")", () => {
  it("drops a sentence that is nothing but commentary and keeps the rest of the field as it was", () => {
    expect(dropRecordCommentary("I asked Poom to complete the question sheet sent by email for homework. No deadline was stated."))
      .toBe("I asked Poom to complete the question sheet sent by email for homework.");
    expect(dropRecordCommentary("Try ten revision questions. The page numbers were not specified. Send me a photo of your notes."))
      .toBe("Try ten revision questions. Send me a photo of your notes.");
    expect(dropRecordCommentary("We reviewed vectors. The summary does not show whether a test was set."))
      .toBe("We reviewed vectors.");
    expect(dropRecordCommentary("There was no deadline stated.")).toBe("");
  });

  it("never cuts commentary out of a longer sentence or a list item: the draft is rejected instead", () => {
    for (const homework of [
      "Complete page 12 (no deadline was given).",
      "Complete page 12; no deadline was set.",
      "Finish past paper 2, although no specific deadline was given.",
      "1. Complete page 12\n2. No deadline was stated.",
      "Complete page 12. Dr. Lee's deadline was not stated.",
    ]) {
      const fields = finalizeFields({ ...goodOutput, homework }, STUDENT_NAME);
      expect(fields.homework).toBe(homework);
      expect(feedbackTextChecks(fields).form).toContain("record_commentary:homework");
    }
  });

  it("leaves coaching and lesson content that merely look similar alone", () => {
    for (const text of [
      "It was unclear whether Pim had revised the formulas, so we went through them again.",
      "The deadline is Friday.",
      "The deadline was given as Friday.",
      "Pim lost marks because units were not stated in his answers.",
      "Pressure was not specified, so we assumed STP.",
      "Pim's summary did not mention the turning point of the story.",
      "Pim noticed that no electrons were lost.",
    ]) {
      expect(dropRecordCommentary(text)).toBe(text);
      expect(feedbackTextChecks({ ...GOOD_FIELDS, performance: text }).form).not.toContain("record_commentary:performance");
    }
  });

  it("is applied by finalizeFields before posting", () => {
    const fields = finalizeFields({ ...goodOutput, homework: "Complete page 12. No deadline was stated." }, STUDENT_NAME);
    expect(fields.homework).toBe("Complete page 12.");
    expect(feedbackTextChecks(fields).form).not.toContain("record_commentary:homework");
  });
});
