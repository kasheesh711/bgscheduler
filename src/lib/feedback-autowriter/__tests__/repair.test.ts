import { describe, expect, it } from "vitest";
import { MAX_REMOVED_SHARE, parseProblemQuote, repairRejectedDraft } from "../repair";
import type { ModelOutput } from "../validate";

const draft: ModelOutput = {
  topics: "1. Non-Verbal Reasoning test review\n2. Reflections and rotations\n3. A second Non-Verbal Reasoning test in class",
  performance: "[STUDENT_1] reviewed this morning's test and explained several answers after prompts. " +
    "I provided hints during parts of the activity, so this was not wholly independent work. " +
    "[STUDENT_1] pointed out a star-position difference between rotation options and, with guidance, confirmed that a reflection changed the direction and position of features. " +
    "He found the second test hard and guessed several answers, but the questions he took time over were mostly correct. " +
    "He also used paper to draw out harder questions.",
  improvement: "1. Slow down and check every part of the diagram\n2. Narrow the options before choosing\n3. Rotate one part at a time",
  homework: "I reminded [STUDENT_1] to complete and submit the maths homework already in progress; no deadline was stated.",
  studentAttended: true,
  lessonHappened: true,
};

describe("parseProblemQuote", () => {
  it("takes the field from the label and the text from the first quoted span", () => {
    expect(parseProblemQuote("How the student did in class: \"I provided hints during parts of the activity, so this was not wholly independent work\" — the transcript shows the tutor giving hints while [STUDENT_1] worked"))
      .toEqual({ field: "performance", text: "I provided hints during parts of the activity, so this was not wholly independent work" });
    expect(parseProblemQuote("Feedback (How the student did in class): \"[STUDENT_1] pointed out a star-position difference\" The transcript shows"))
      .toEqual({ field: "performance", text: "[STUDENT_1] pointed out a star-position difference" });
    expect(parseProblemQuote("“and, with guidance, confirmed that a reflection changed…” — the transcript only shows the tutor"))
      .toEqual({ field: null, text: "and, with guidance, confirmed that a reflection changed" });
    // 7 Oct production: the judge put the label inside the quotes.
    expect(parseProblemQuote("\"Homework and due date: I reminded [STUDENT_1] to finish and submit the remaining Dr. Frost maths homework\" — the Dr. Frost maths homework was not set"))
      .toEqual({ field: "homework", text: "I reminded [STUDENT_1] to finish and submit the remaining Dr. Frost maths homework" });
    expect(parseProblemQuote("Homework and due date: I reminded [STUDENT_1] to finish — not set by the tutor"))
      .toEqual({ field: "homework", text: "I reminded [STUDENT_1] to finish" });
  });
});

describe("repairRejectedDraft", () => {
  it("cuts the sentences the judges quoted and keeps the rest", () => {
    const repaired = repairRejectedDraft(draft, {
      unsupported: [
        "How the student did in class: \"I provided hints during parts of the activity, so this was not wholly independent work\" — hints were in the second test",
        "\"and, with guidance, confirmed that a reflection changed the direction and position of features\" — the tutor stated this",
      ],
      misattributed: ["Feedback (How the student did in class): \"[STUDENT_1] pointed out a star-position difference between rotation options\" The transcript shows the tutor confirming"],
      homeworkNotSet: [],
    });
    expect(repaired).not.toBeNull();
    expect(repaired!.output.performance).toBe("[STUDENT_1] reviewed this morning's test and explained several answers after prompts. " +
      "He found the second test hard and guessed several answers, but the questions he took time over were mostly correct. " +
      "He also used paper to draw out harder questions.");
    expect(repaired!.removed.map((item) => item.field)).toEqual(["performance", "performance"]);
    expect(repaired!.output.topics).toBe(draft.topics);
    expect(repaired!.output.homework).toBe(draft.homework);
  });

  it("empties the homework answer for homework the tutor did not set, however the judge labels it", () => {
    for (const quote of [
      "Homework and due date: \"I reminded [STUDENT_1] to complete and submit the maths homework already in progress; no deadline was stated.\" The transcript shows this is the school's",
      "\"I reminded [STUDENT_1] to complete and submit the maths homework already in progress\" — set by the school maths teacher",
    ]) {
      const repaired = repairRejectedDraft(draft, { unsupported: [], misattributed: [], homeworkNotSet: [quote] });
      expect(repaired?.output.homework).toBe("");
      expect(repaired?.output.performance).toBe(draft.performance);
    }
  });

  it("repairs the 7 Oct production case: the label inside the quotes, two levels quoting the same homework", () => {
    const linn: ModelOutput = { ...draft, homework: "I reminded [STUDENT_1] to finish and submit the remaining Dr. Frost maths homework, and to ask me about any questions if needed." };
    const repaired = repairRejectedDraft(linn, {
      unsupported: [],
      misattributed: [],
      homeworkNotSet: [
        "\"I reminded [STUDENT_1] to finish and submit the remaining Dr. Frost maths homework, and to ask me about any questions if needed.\"",
        "\"Homework and due date: I reminded [STUDENT_1] to finish and submit the remaining Dr. Frost maths homework\" — the Dr. Frost maths homework was not set by the tutor in this lesson",
      ],
    });
    expect(repaired?.output.homework).toBe("");
    expect(repaired?.output.performance).toBe(draft.performance);
  });

  it("cuts a numbered line and renumbers the list", () => {
    const repaired = repairRejectedDraft(draft, { unsupported: ["Topics covered: \"Reflections and rotations\""], misattributed: [], homeworkNotSet: [] });
    expect(repaired?.output.topics).toBe("1. Non-Verbal Reasoning test review\n2. A second Non-Verbal Reasoning test in class");
  });

  it("never splits a sentence after an abbreviation, and keeps the field's own spacing", () => {
    const withTitle: ModelOutput = { ...draft, performance: "We worked with Mr. [TUTOR] on ratios today. [STUDENT_1] scored 8/10 on the quiz. He explained the  unitary method clearly." };
    const repaired = repairRejectedDraft(withTitle, { unsupported: ["\"[STUDENT_1] scored 8/10 on the quiz\""], misattributed: [], homeworkNotSet: [] });
    expect(repaired?.output.performance).toBe("We worked with Mr. [TUTOR] on ratios today. He explained the  unitary method clearly.");
    // A quote that starts after "Mr." cannot cut half a sentence.
    expect(repairRejectedDraft(withTitle, { unsupported: ["\"[TUTOR] on ratios today\""], misattributed: [], homeworkNotSet: [] })?.output.performance)
      .toBe("[STUDENT_1] scored 8/10 on the quiz. He explained the  unitary method clearly.");
  });

  it("ends a sentence at 'etc.' or 'no.' unless a number follows", () => {
    const value: ModelOutput = { ...draft, performance: "We revised fractions, decimals, etc. He scored 9/10 on the quiz. We reviewed Q. 5 together and he explained it well." };
    expect(repairRejectedDraft(value, { unsupported: ["\"He scored 9/10 on the quiz\""], misattributed: [], homeworkNotSet: [] })?.output.performance)
      .toBe("We revised fractions, decimals, etc. We reviewed Q. 5 together and he explained it well.");
  });

  it("does not repair when the quoted claim would still be in the draft", () => {
    const twice: ModelOutput = { ...draft, improvement: draft.improvement + "\n4. I provided hints during parts of the activity, so this was not wholly independent work" };
    const result = repairRejectedDraft(twice, { unsupported: ["\"I provided hints during parts of the activity\""], misattributed: [], homeworkNotSet: [] });
    expect(result).toBeNull();
  });

  it("does not repair when a quote is not in the draft, is a source contradiction, or there is nothing to cut", () => {
    expect(repairRejectedDraft(draft, { unsupported: ["\"scored 34 out of 40 on the test\" — no score was given"], misattributed: [], homeworkNotSet: [] })).toBeNull();
    expect(repairRejectedDraft(draft, { unsupported: ["SOURCE_CONTRADICTION: Atom says 12 correct, transcript says 10"], misattributed: [], homeworkNotSet: [] })).toBeNull();
    expect(repairRejectedDraft(draft, { unsupported: [], misattributed: [], homeworkNotSet: [] })).toBeNull();
    expect(repairRejectedDraft(draft, { unsupported: ["\"hard\""], misattributed: [], homeworkNotSet: [] })).toBeNull(); // too short to place
  });

  it("does not repair a draft that would lose too much, or a field that would be left empty", () => {
    const sentences = draft.performance.split(/(?<=\.)\s/u);
    const wide = repairRejectedDraft(draft, { unsupported: sentences.slice(0, 4).map((sentence) => `"${sentence}"`), misattributed: [], homeworkNotSet: [] });
    expect(MAX_REMOVED_SHARE).toBeLessThan(0.5);
    expect(wide).toBeNull();
    const short: ModelOutput = { ...draft, improvement: "Check reflections carefully." };
    expect(repairRejectedDraft(short, { unsupported: ["\"Check reflections carefully\""], misattributed: [], homeworkNotSet: [] })).toBeNull();
  });
});
