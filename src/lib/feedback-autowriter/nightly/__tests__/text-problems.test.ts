import { describe, expect, it } from "vitest";
import { ISEB_FORMAT_GUIDE } from "../../format";
import { MIMI_STYLE_GUIDE, MIMI_STYLE_GUIDE_V2 } from "../../style";
import { correctionTextProblems, guidesFromStamp, type TextProblemInput } from "../text-problems";
import { PIM_FIELDS, SID } from "./nightly-fixtures";

function input(patch: Partial<TextProblemInput> = {}): TextProblemInput {
  return {
    wiseSessionId: SID,
    fields: PIM_FIELDS,
    studentFullName: "Pimchanok (Pim.Ta) Testwong",
    studentDisplayName: "Pim",
    studentAliases: [],
    tutorNames: ["Arthit Teacherson", "Art"],
    classDetails: ["Programme: Y5-6", "Class subject: Maths"],
    priorFeedback: [],
    otherStudentNames: ["Nok", "Tawan"],
    ...patch,
  };
}

const codes = (patch: Partial<TextProblemInput> = {}) => correctionTextProblems(input(patch)).map((problem) => problem.code);

describe("correctionTextProblems", () => {
  it("finds nothing wrong with a sound post", () => {
    expect(correctionTextProblems(input())).toEqual([]);
  });

  it("runs production's validator on the text (placeholders, Thai, markdown, length)", () => {
    expect(codes({ fields: { ...PIM_FIELDS, performance: `${PIM_FIELDS.performance} [STUDENT_1] smiled.` } })).toContain("validator:placeholder_token:performance");
    expect(codes({ fields: { ...PIM_FIELDS, topics: `${PIM_FIELDS.topics} เศษส่วน` } })).toContain("validator:thai_text:topics");
    expect(codes({ fields: { ...PIM_FIELDS, improvement: `**Next:** ${PIM_FIELDS.improvement}` } })).toContain("validator:markdown:improvement");
    expect(codes({ fields: { ...PIM_FIELDS, performance: "Good." } }).some((code) => code.startsWith("validator:"))).toBe(true);
  });

  it("leaves the class's own earlier post out of the copy check, but not other classes'", () => {
    const prior = (key: string) => ({ key, fields: { ...PIM_FIELDS }, studentNames: ["Pimchanok (Pim.Ta) Testwong"] });
    expect(codes({ priorFeedback: [prior(SID)] })).toEqual([]);
    expect(codes({ priorFeedback: [prior("6a0000000000000000000b02")] }).some((code) => code.startsWith("validator:ai_suspect:"))).toBe(true);
  });

  it("flags meta words, which may still be lesson content for the auditor to decide", () => {
    const problems = correctionTextProblems(input({
      fields: { ...PIM_FIELDS, performance: `${PIM_FIELDS.performance} The recording froze when the lesson was rescheduled, and the AI summary was late.` },
    }));
    expect(problems.filter((problem) => problem.code.startsWith("meta_word:")).map((problem) => problem.code).sort()).toEqual([
      "meta_word:ai", "meta_word:late", "meta_word:recording", "meta_word:reschedul", "meta_word:summary",
    ]);
    expect(problems.find((problem) => problem.code === "meta_word:recording")).toMatchObject({ field: "performance", detail: "recording" });
    // Ordinary words that only contain a meta word are not meta words.
    expect(codes({ fields: { ...PIM_FIELDS, topics: `${PIM_FIELDS.topics} We translated, calculated and zoomed out on the graph.` } })
      .filter((code) => code.startsWith("meta_word:"))).toEqual([]);
  });

  it("wants the student called only by the display name, and nobody else named", () => {
    const problems = correctionTextProblems(input({
      fields: {
        ...PIM_FIELDS,
        performance: `${PIM_FIELDS.performance} Pimchanok and Art agreed Nok had the same question.`,
      },
    }));
    expect(problems.map((problem) => [problem.code, problem.detail])).toEqual(expect.arrayContaining([
      ["student_name_form", "Pimchanok"],
      ["tutor_named", "Art"],
      ["other_student_named", "Nok"],
    ]));
    // Case matters for names: "art" is a word, "Art" a name.
    expect(codes({ fields: { ...PIM_FIELDS, topics: `${PIM_FIELDS.topics} We also looked at pixel art.` } })).toEqual([]);
  });

  it("names another person only from a capitalised word before a person verb", () => {
    const problems = correctionTextProblems(input({
      fields: { ...PIM_FIELDS, performance: `${PIM_FIELDS.performance} Ploy also finished the paper early.` },
    }));
    expect(problems).toEqual(expect.arrayContaining([{ code: "other_person_named", field: "performance", detail: "Ploy" }]));
  });

  it("checks style and format guides from the pipeline stamp", () => {
    expect(guidesFromStamp(null)).toEqual({ styleGuide: null, formatGuide: null });
    expect(guidesFromStamp({ styleGuide: { id: "mimi", version: 2 }, formatGuide: { id: "iseb", version: 1 } }))
      .toEqual({ styleGuide: MIMI_STYLE_GUIDE_V2, formatGuide: ISEB_FORMAT_GUIDE });
    expect(guidesFromStamp({ styleGuide: { id: "mimi", version: 1 } }).styleGuide).toBe(MIMI_STYLE_GUIDE);
    expect(guidesFromStamp({ styleGuide: { id: "other", version: 9 } }).styleGuide).toBeNull();
    // Prose topics break the ISEB format's numbered lists.
    expect(codes({ formatGuide: ISEB_FORMAT_GUIDE }).some((code) => code.startsWith("validator:style:"))).toBe(true);
  });
});
