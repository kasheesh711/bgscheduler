import { describe, expect, it } from "vitest";
import { serializePostClassFeedbackAnswer } from "../detail";

describe("post-class feedback detail serialization", () => {
  it("returns exact identifiers, label, text, and lossless raw value", () => {
    const rawAnswer = { selected: ["A", "B"] };
    expect(serializePostClassFeedbackAnswer({
      id: "answer-1",
      questionId: "question-1",
      questionText: "What was covered?",
      type: "multi_select",
      answer: "  Exact teacher text\n",
      rawAnswer,
    })).toEqual({
      id: "answer-1",
      questionId: "question-1",
      questionText: "What was covered?",
      type: "multi_select",
      text: "  Exact teacher text\n",
      rawAnswer,
    });
  });

  it("does not coerce an unknown raw answer into fabricated prose", () => {
    expect(serializePostClassFeedbackAnswer({
      questionId: "rating",
      rawAnswer: 5,
    })).toMatchObject({ questionId: "rating", text: "", rawAnswer: 5 });
  });
});
