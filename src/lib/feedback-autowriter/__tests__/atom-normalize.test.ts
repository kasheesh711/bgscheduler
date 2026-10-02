import { describe, expect, it } from "vitest";
import { normalizeAtomTranscript, parseActivityIndex, type AtomActivityReference } from "../atom/normalize";
const ref: AtomActivityReference = { id: "_123", studentId: "_456", name: "Test 7", subject: "maths", kind: "test", startedAt: "2026-10-01T09:00:00Z", completedAt: "2026-10-01T10:00:00Z", expectedCorrect: 1, expectedAttempted: 1, expectedTotal: 2, expectedSas: 102 };
const response = { id_student: "_456", id_course_question: 1, id_course_subject: 237, answeredAt: "2026-10-01T09:15:00Z", correct: true, noAttempt: false, autoResponse: false, tutorMode: true, secondsTaken: 18, id_homework: null };
const transcript = { id_question_session: "_123", id_student: "_456", name: "Test 7", questionSessionType: "mock_test", totalQuestions: 2, isScoredUsingMarks: false, includesAiMarkedQuestions: false, score: 102, subtopicScore: [{ title: "Fractions", score: 73, percentCorrect: 100 }], questions: [{ id_course_question: 1, responses: [response] }] };
describe("validated Atom boundary", () => {
  it("preserves assistance and modelled rather than raw subtopic percentages", () => {
    expect(normalizeAtomTranscript(transcript, ref)).toMatchObject({ sas: 102, modelledTopicEstimates: [{ topic: "Fractions", percent: 73 }], answers: [{ assisted: true }] });
  });
  it("excludes unattempted and automatic responses", () => {
    const skipped = { id_course_question: 2, responses: [{ ...response, id_course_question: 2, noAttempt: true, correct: false }] };
    expect(normalizeAtomTranscript({ ...transcript, questions: [...transcript.questions, skipped] }, ref).answers).toHaveLength(1);
  });
  it("retains a homework indicator", () => {
    expect(normalizeAtomTranscript({ ...transcript, questions: [{ id_course_question: 1, responses: [{ ...response, id_homework: "_567" }] }] }, ref).purpose).toBe("homework");
  });
  it("holds confirmed count and student contradictions", () => {
    expect(() => normalizeAtomTranscript(transcript, { ...ref, expectedCorrect: 2 })).toThrow("source_contradiction");
    expect(() => normalizeAtomTranscript({ ...transcript, id_student: "_789" }, ref)).toThrow("source_contradiction");
  });
  it.each([{ ...transcript, questionSessionType: "changed" }, { ...transcript, isScoredUsingMarks: true }, { ...transcript, questions: null }])("changed responses do not become empty success", changed => {
    expect(() => normalizeAtomTranscript(changed, ref)).toThrow("response_changed");
  });
  it("an error envelope cannot be interpreted as no completed activities", () => {
    expect(() => parseActivityIndex("test", { error: "expired" }, "_456", new Set())).toThrow("response_changed");
  });
});
