import { describe, expect, it } from "vitest";
import { eventProofOutcome, serializePostClassFeedbackAnswer } from "../detail";

const DEADLINE = new Date("2026-08-05T16:59:59.999Z");

function activityEvent(input: {
  at: string;
  role?: string | null;
  autoSubmitted?: boolean;
}) {
  return {
    eventTimestamp: new Date(input.at),
    actorRole: input.role ?? null,
    payload: input.autoSubmitted === undefined
      ? {}
      : { session: { autoSubmitted: input.autoSubmitted } },
  };
}

describe("eventProofOutcome", () => {
  it("counts a pre-deadline event whatever account role Wise stamped", () => {
    // The production case: a tutor who also holds an admin account submits
    // their own feedback and Wise records ADMIN.
    for (const role of ["TEACHER", "ADMIN", "STUDENT", "OWNER", null]) {
      expect(eventProofOutcome(activityEvent({ at: "2026-08-05T16:42:05.728Z", role }), DEADLINE))
        .toEqual({ countedAsProof: true, reason: null });
    }
  });

  it("counts an event landing exactly on the deadline instant", () => {
    expect(eventProofOutcome(activityEvent({ at: "2026-08-05T16:59:59.999Z" }), DEADLINE))
      .toEqual({ countedAsProof: true, reason: null });
  });

  it("does not count an event one millisecond past the deadline", () => {
    expect(eventProofOutcome(activityEvent({ at: "2026-08-05T17:00:00.000Z" }), DEADLINE))
      .toEqual({ countedAsProof: false, reason: "after_deadline" });
  });

  it("never counts a Wise auto-submission, even before the deadline", () => {
    expect(eventProofOutcome(
      activityEvent({ at: "2026-08-05T10:00:00.000Z", role: "TEACHER", autoSubmitted: true }),
      DEADLINE,
    )).toEqual({ countedAsProof: false, reason: "auto_submitted" });
  });

  it("reports the auto reason ahead of lateness when both apply", () => {
    expect(eventProofOutcome(
      activityEvent({ at: "2026-08-09T10:00:00.000Z", autoSubmitted: true }),
      DEADLINE,
    )).toEqual({ countedAsProof: false, reason: "auto_submitted" });
  });
});

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
