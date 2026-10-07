import { describe, expect, it } from "vitest";
import { AtomCollectionError, normalizeAtomTranscript, parseActivityIndex, type AtomActivityReference } from "../atom/normalize";
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
  it("labels a contradiction with the failed check and Atom's activity id, never a payload value", () => {
    const stageOf = (fn: () => unknown) => {
      try { fn(); } catch (error) { return { code: (error as AtomCollectionError).code, stage: (error as AtomCollectionError).stage }; }
      throw new Error("did not throw");
    };
    expect(stageOf(() => normalizeAtomTranscript(transcript, { ...ref, expectedCorrect: 2, expectedSas: 99 })))
      .toEqual({ code: "source_contradiction", stage: "list_vs_transcript_correct+sas:test:_123|list:a=1,c=2,t=2|transcript:a=1,c=1,t=2,q=1,skip=0,auto=0" });
    expect(stageOf(() => normalizeAtomTranscript({ ...transcript, id_student: "_789" }, ref)).stage).toBe("transcript_identity:test:_123");
    expect(stageOf(() => normalizeAtomTranscript(transcript, { ...ref, id: "not-an-id" })).stage).toBe("transcript_identity:test:id");
    const otherStudent = [{ id_mock_test: "_1", id_student: "_789", name: "T", completed: true, started: null, finished: null, id_course_subject: 237, score: null, totalQuestions: 1, questionsCorrect: 0, questionsAnswered: 0 }];
    expect(stageOf(() => parseActivityIndex("test", otherStudent, "_456", new Set())).stage).toBe("index_student:test");
  });
  it("accepts Atom's list counting skipped questions as answered, and still counts only real answers", () => {
    const questions = [1, 2, 3].map(id => ({ id_course_question: id, responses: [{ ...response, id_course_question: id, noAttempt: id === 3, correct: id !== 3 }] }));
    const practice = { ...transcript, id_question_session: "_123", questionSessionType: "practice", totalQuestions: 3, score: null, subtopicScore: undefined, questions };
    const listed = { ...ref, kind: "practice" as const, expectedCorrect: null, expectedSas: null, expectedTotal: 3 };
    expect(normalizeAtomTranscript(practice, { ...listed, expectedAttempted: 3 }).answers).toHaveLength(2);
    expect(normalizeAtomTranscript(practice, { ...listed, expectedAttempted: 2 }).answers).toHaveLength(2);
    expect(() => normalizeAtomTranscript(practice, { ...listed, expectedAttempted: 4 })).toThrow("source_contradiction");
  });
  it("says which side of an attempted-count mismatch is off: a question answered twice shows as a=2 over q=1", () => {
    const twice = { ...transcript, questions: [{ id_course_question: 1, responses: [response, { ...response, correct: false, answeredAt: "2026-10-01T09:16:00Z" }] },
      { id_course_question: 2, responses: [{ ...response, id_course_question: 2, noAttempt: true, correct: false }] }] };
    try {
      normalizeAtomTranscript(twice, { ...ref, expectedCorrect: null, expectedSas: null });
      throw new Error("did not throw");
    } catch (error) {
      expect((error as AtomCollectionError).stage)
        .toBe("list_vs_transcript_attempted:test:_123|list:a=1,c=-,t=2|transcript:a=2,c=1,t=2,q=1,skip=1,auto=0");
    }
  });
  it.each([{ ...transcript, questionSessionType: "changed" }, { ...transcript, isScoredUsingMarks: true }, { ...transcript, questions: null }])("changed responses do not become empty success", changed => {
    expect(() => normalizeAtomTranscript(changed, ref)).toThrow("response_changed");
  });
  it("an error envelope cannot be interpreted as no completed activities", () => {
    expect(() => parseActivityIndex("test", { error: "expired" }, "_456", new Set())).toThrow("response_changed");
  });
});
