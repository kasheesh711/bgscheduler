import { describe, expect, it } from "vitest";
import {
  hashFeedbackAnswers,
  normalizeWiseFeedbackAnswers,
  parseWisePostClassSession,
  resolveFeedbackFieldMapping,
} from "../wise";

const questions = [
  { id: "q1", text: "Topics covered" },
  { id: "q2", text: "How the student did in class" },
  { id: "q3", text: "Need more work on" },
  { id: "q4", text: "Homework and due date" },
];

describe("Wise post-class feedback parsing", () => {
  it("maps the three required fields and optional homework", () => {
    const mapping = resolveFeedbackFieldMapping(questions);
    expect(mapping.status).toBe("ready");
    expect(mapping.byField.topics?.id).toBe("q1");
    expect(mapping.byField.homework?.id).toBe("q4");
  });

  it("fails closed when a required question is missing or ambiguous", () => {
    expect(resolveFeedbackFieldMapping(questions.filter((question) => question.id !== "q3")).status)
      .toBe("form_drift");
    expect(resolveFeedbackFieldMapping([...questions, { id: "q1b", text: "Topics covered" }]).ambiguousFields)
      .toContain("topics");
  });

  it("does not create a new content hash for an answer-array reorder", () => {
    const answers = [
      { questionId: "q1", answer: "first" },
      { questionId: "q2", answer: "second" },
    ];
    expect(hashFeedbackAnswers(answers)).toBe(hashFeedbackAnswers(answers.toReversed()));
  });

  it("preserves structured answer JSON while deriving display text and hashing raw evidence", () => {
    const rawAnswer = [
      { text: "First choice", score: 1 },
      { value: "Second choice", metadata: { selected: true } },
      3,
    ];
    const [normalized] = normalizeWiseFeedbackAnswers([{
      questionId: "q1",
      answer: rawAnswer,
    }]);
    expect(normalized.answer).toBe("First choice\nSecond choice\n3");
    expect(normalized.rawAnswer).toEqual(rawAnswer);
    expect(hashFeedbackAnswers([{ ...normalized, rawAnswer: null }]))
      .not.toBe(hashFeedbackAnswers([{ ...normalized, rawAnswer: "" }]));
    expect(hashFeedbackAnswers([{ ...normalized, rawAnswer: { b: 2, a: 1 } }]))
      .toBe(hashFeedbackAnswers([{ ...normalized, rawAnswer: { a: 1, b: 2 } }]));
  });

  it("retains exact answers and determines provenance from direct event evidence", () => {
    const parsed = parseWisePostClassSession({
      candidateSession: null,
      classId: "class-1",
      sessionId: "session-1",
      observedAt: new Date("2026-07-02T10:05:00.000Z"),
      detail: {
        _id: "session-1",
        classId: { _id: "class-1", name: "Math with Mali" },
        scheduledStartTime: "2026-07-01T09:00:00.000Z",
        scheduledEndTime: "2026-07-01T10:00:00.000Z",
        meetingStatus: "ENDED",
        students: [{ _id: "student-1", name: "Mali" }],
        feedbackForm: {
          questions: questions.map((question) => ({
            _id: question.id,
            questionText: question.text,
          })),
        },
        feedbackSubmissions: [{
          _id: "submission-1",
          profile: "teacher",
          createdAt: "2026-07-02T10:00:00.000Z",
          creditsConsumed: 1.5,
          answers: questions.map((question, index) => ({
            questionId: question.id,
            questionText: question.text,
            answer: index === 0 ? "  Exact topics\n" : `answer ${index}`,
          })),
        }],
      },
      events: [{
        eventId: "event-1",
        sessionId: "session-1",
        submissionId: "submission-1",
        eventTimestamp: new Date("2026-07-02T10:00:01.000Z"),
        autoSubmitted: false,
        actorWiseUserId: "teacher-1",
        actorName: "Teacher One",
      }],
    });

    expect(parsed.feedbackVersions[0].fields.topics).toBe("  Exact topics\n");
    expect(parsed.feedbackVersions[0].provenance).toBe("manual");
    expect(parsed.feedbackVersions[0].actorWiseUserId).toBe("teacher-1");
    expect(parsed.feedbackVersions[0].actorName).toBe("Teacher One");
    expect(parsed.feedbackVersions[0].sourceTimestampTrustworthy).toBe(false);
    expect(parsed.feedbackVersions[0].sourceTimestampKind).toBe("created");
    expect(parsed.creditsConsumed).toBe(1.5);
    expect(parsed.participants).toEqual([{ wiseStudentId: "student-1", studentName: "Mali" }]);
  });

  it("does not guess provenance when event association is ambiguous", () => {
    const parsed = parseWisePostClassSession({
      candidateSession: null,
      classId: "class-1",
      sessionId: "session-1",
      observedAt: new Date("2026-07-02T10:05:00.000Z"),
      detail: {
        _id: "session-1",
        classId: "class-1",
        scheduledStartTime: "2026-07-01T09:00:00.000Z",
        scheduledEndTime: "2026-07-01T10:00:00.000Z",
        feedbackForm: { questions: questions.map((question) => ({ questionText: question.text })) },
        feedbackSubmissions: [{
          _id: "submission-1",
          profile: "teacher",
          createdAt: "2026-07-02T10:00:00.000Z",
          answers: [],
        }],
      },
      events: [
        { eventId: "one", sessionId: "session-1", eventTimestamp: new Date("2026-07-02T10:00:00Z"), autoSubmitted: true },
        { eventId: "two", sessionId: "session-1", eventTimestamp: new Date("2026-07-02T10:00:01Z"), autoSubmitted: false },
      ],
    });
    expect(parsed.feedbackVersions[0].provenance).toBe("unknown");
  });

  it("uses the update timestamp for a mutable submission content version", () => {
    const parsed = parseWisePostClassSession({
      candidateSession: null,
      classId: "class-1",
      sessionId: "session-1",
      observedAt: new Date("2026-07-04T10:05:00.000Z"),
      detail: {
        _id: "session-1",
        classId: "class-1",
        scheduledStartTime: "2026-07-01T09:00:00.000Z",
        scheduledEndTime: "2026-07-01T10:00:00.000Z",
        feedbackForm: { questions: questions.map((question) => ({
          _id: question.id,
          questionText: question.text,
        })) },
        feedbackSubmissions: [{
          _id: "submission-1",
          profile: "teacher",
          createdAt: "2026-07-02T10:00:00.000Z",
          updatedAt: "2026-07-04T10:00:00.000Z",
          answers: [],
        }],
      },
      events: [
        {
          eventId: "original-event",
          sessionId: "session-1",
          submissionId: "submission-1",
          eventTimestamp: new Date("2026-07-02T10:00:00.000Z"),
          autoSubmitted: false,
        },
        {
          eventId: "edit-event",
          sessionId: "session-1",
          submissionId: "submission-1",
          eventTimestamp: new Date("2026-07-04T10:00:01.000Z"),
          autoSubmitted: true,
        },
      ],
    });
    expect(parsed.feedbackVersions[0].sourceCreatedAt?.toISOString())
      .toBe("2026-07-04T10:00:00.000Z");
    expect(parsed.feedbackVersions[0].sourceTimestampTrustworthy).toBe(true);
    expect(parsed.feedbackVersions[0].sourceTimestampKind).toBe("updated");
    expect(parsed.feedbackVersions[0].provenance).toBe("auto");
  });

  it("keeps class type, combined exception flags, submission status, and canonical detail roster", () => {
    const parsed = parseWisePostClassSession({
      candidateSession: {
        _id: "session-1",
        classId: { _id: "class-1", classType: "OTHER" },
        type: "ONLINE",
        scheduledStartTime: "2026-07-01T09:00:00.000Z",
        scheduledEndTime: "2026-07-01T10:00:00.000Z",
        students: [{ _id: "removed-student", name: "Removed" }],
        isTrial: true,
      },
      classId: "class-1",
      sessionId: "session-1",
      observedAt: new Date("2026-07-02T10:05:00.000Z"),
      detail: {
        _id: "session-1",
        classId: { _id: "class-1", classType: "REGULAR" },
        type: "OFFLINE",
        scheduledStartTime: "2026-07-01T09:00:00.000Z",
        scheduledEndTime: "2026-07-01T10:00:00.000Z",
        students: [],
        isComplimentary: false,
        feedbackForm: { questions: questions.map((question) => ({
          _id: question.id,
          questionText: question.text,
        })) },
        feedbackSubmissions: [{
          _id: "submission-1",
          profile: "teacher",
          sessionStatus: "NO_SHOW",
          isTrial: false,
          answers: [],
        }],
      },
    });
    expect(parsed.classType).toBe("REGULAR");
    expect(parsed.sessionType).toBe("OFFLINE");
    expect(parsed.complimentaryOrTrial).toBe(true);
    expect(parsed.submissionSessionStatuses).toEqual(["NO_SHOW"]);
    expect(parsed.participants).toEqual([]);
    expect(parsed.participantsAuthoritative).toBe(true);
  });

  it("persists only explicit teacher-profile feedback while retaining other status evidence", () => {
    const parsed = parseWisePostClassSession({
      candidateSession: null,
      classId: "class-1",
      sessionId: "session-1",
      observedAt: new Date("2026-07-02T10:05:00.000Z"),
      detail: {
        _id: "session-1",
        classId: "class-1",
        scheduledStartTime: "2026-07-01T09:00:00.000Z",
        scheduledEndTime: "2026-07-01T10:00:00.000Z",
        feedbackForm: { questions: questions.map((question) => ({
          _id: question.id,
          questionText: question.text,
        })) },
        feedbackSubmissions: [
          {
            _id: "student-submission",
            profile: "student",
            sessionStatus: "NO_SHOW",
            answers: [{ questionId: "q1", answer: "student private response" }],
          },
          {
            _id: "teacher-submission",
            profile: "teacher",
            sessionStatus: "ENDED",
            answers: [{ questionId: "q1", answer: "teacher response" }],
          },
        ],
      },
    });
    expect(parsed.feedbackVersions).toHaveLength(1);
    expect(parsed.feedbackVersions[0]).toMatchObject({
      submissionId: "teacher-submission",
      profile: "teacher",
    });
    expect(parsed.feedbackVersions[0].fields.topics).toBe("teacher response");
    expect(parsed.submissionSessionStatuses).toEqual(["NO_SHOW", "ENDED"]);
  });

  it("reads class name, subject and participants from the real session-detail shape", () => {
    // The session-detail endpoint returns `classId` as a bare string with the
    // name/subject at the top level, and participants keyed by `wiseUserId`.
    // Reading only `classId.name` / `_id` produced "Untitled class" on 5,211
    // production sessions and dropped every participant.
    const parsed = parseWisePostClassSession({
      candidateSession: null,
      classId: "698e799d7cf248f04e231c84",
      sessionId: "6a07fe3d959b60fa5b19e644",
      observedAt: new Date("2026-07-24T00:00:00.000Z"),
      detail: {
        _id: "6a07fe3d959b60fa5b19e644",
        classId: "698e799d7cf248f04e231c84",
        className: "Chenghao (Chenghao.Zh) Zhang",
        classSubject: "Y2-8 / G1-7 (Int.)",
        title: "In-Person Session - Math",
        meetingStatus: "ENDED",
        scheduledStartTime: "2026-07-22T02:00:00.000Z",
        scheduledEndTime: "2026-07-22T03:00:00.000Z",
        participants: [{
          wiseUserId: "696e2a7b43579bbada2093c1",
          name: "Chenghao (Chenghao.Zh) Zhang",
          credits: 1,
          offline: false,
        }],
      } as never,
    });

    expect(parsed.className).toBe("Chenghao (Chenghao.Zh) Zhang");
    expect(parsed.subject).toBe("Y2-8 / G1-7 (Int.)");
    expect(parsed.participants).toEqual([{
      wiseStudentId: "696e2a7b43579bbada2093c1",
      studentName: "Chenghao (Chenghao.Zh) Zhang",
    }]);
  });

  it("still prefers the PAST-list classId object when Wise supplies one", () => {
    const parsed = parseWisePostClassSession({
      candidateSession: null,
      classId: "class-1",
      sessionId: "session-1",
      observedAt: new Date("2026-07-24T00:00:00.000Z"),
      detail: {
        _id: "session-1",
        classId: { _id: "class-1", name: "Math Y5", subject: "Mathematics" },
        className: "ignored-top-level",
        meetingStatus: "ENDED",
        scheduledStartTime: "2026-07-22T02:00:00.000Z",
        scheduledEndTime: "2026-07-22T03:00:00.000Z",
        students: [{ _id: "student-1", name: "Alice" }],
      } as never,
    });

    expect(parsed.className).toBe("Math Y5");
    expect(parsed.subject).toBe("Mathematics");
    expect(parsed.participants).toEqual([{ wiseStudentId: "student-1", studentName: "Alice" }]);
  });
});
