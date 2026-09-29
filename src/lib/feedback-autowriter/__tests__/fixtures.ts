import { KEVIN_ONLINE_WISE_USER_ID } from "../roster";

export const CLASS_ID = "6a0000000000000000000001";
export const SESSION_ID = "6a0000000000000000000002";
export const STUDENT_ID = "6a0000000000000000000003";
export const SUBMISSION_ID = "6a0000000000000000000004";
export const STUDENT_NAME = "Somchai (Tom.Ja) Jaidee";

export const QUESTIONS = [
  { _id: "q1", questionText: "Topics covered", type: "SHORT_ANSWER", required: false },
  { _id: "q2", questionText: "How the student did in class", type: "LONG_ANSWER", required: false },
  { _id: "q3", questionText: "Need more work on", type: "LONG_ANSWER", required: false },
  { _id: "q4", questionText: "Homework and due date", type: "LONG_ANSWER", required: false },
];

export function answers(values: [string, string, string, string]) {
  return QUESTIONS.map((question, index) => ({
    _id: `a${index + 1}`,
    questionText: question.questionText,
    type: question.type,
    answer: values[index],
  }));
}

export function autoBlankSubmission(overrides: Record<string, unknown> = {}) {
  return {
    _id: SUBMISSION_ID,
    profile: "teacher",
    answers: answers(["", "", "", ""]),
    createdAt: "2026-09-28T09:32:24.797Z",
    creditsConsumed: 1,
    sessionStatus: "COMPLETED",
    metadata: { autoSubmitted: true },
    userId: { _id: KEVIN_ONLINE_WISE_USER_ID, name: "Kevin (Kev) Y. Hsieh Online" },
    ...overrides,
  };
}

/** A Wise session-detail `data` object shaped like the probed live responses. */
export function sessionDetail(overrides: Record<string, unknown> = {}) {
  return {
    _id: SESSION_ID,
    classId: CLASS_ID,
    className: STUDENT_NAME,
    classSubject: "Mathematics",
    type: "SCHEDULED",
    classType: "ONE_TO_ONE",
    meetingStatus: "ENDED",
    scheduledStartTime: "2026-09-28T08:30:00.000Z",
    scheduledEndTime: "2026-09-28T09:30:00.000Z",
    userId: { _id: KEVIN_ONLINE_WISE_USER_ID, name: "Kevin (Kev) Y. Hsieh Online" },
    participants: [
      { wiseUserId: KEVIN_ONLINE_WISE_USER_ID, name: "Kevin (Kev) Y. Hsieh Online", isTeacher: true, inMeetingDuration: 3800 },
      { wiseUserId: STUDENT_ID, name: STUDENT_NAME, isTeacher: false, inMeetingDuration: 3700, absolutePercentAttendance: 98 },
    ],
    feedbackForm: { _id: "form1", profile: "teacher", enabled: true, questions: QUESTIONS },
    feedbackSubmissions: [autoBlankSubmission()],
    rawMeetingSummary: [{
      summaryTitle: `Meeting Summary for ${STUDENT_NAME}`,
      summaryOverview: "Kevin and Somchai practised adding fractions with unlike denominators and converting mixed numbers. Somchai found common denominators quickly but rushed simplification.",
      summaryDetails: [
        { label: "Fractions", summary: "Somchai solved six addition questions and corrected two simplification slips after Kevin asked him to check the highest common factor." },
        { label: "Word problems", summary: "Tom worked through two word problems on sharing pizza and explained his steps clearly." },
      ],
      meetingUUID: "uuid-1",
    }],
    ...overrides,
  };
}

/** "Now" = one day after the class, well before the deadline (09-30 23:59 Bangkok). */
export const NOW = new Date("2026-09-29T04:00:00.000Z");

export const GOOD_FIELDS = {
  topics: "Today we practised adding fractions with unlike denominators, converting mixed numbers, and two word problems about sharing food fairly between friends.",
  performance: "Somchai found common denominators quickly and explained his steps clearly in the word problems. He rushed the simplification step twice, but corrected both slips once he checked the highest common factor.",
  improvement: "Before our next lesson, Somchai should slow down at the simplification step: after each answer, list the factors of the numerator and denominator and divide by the highest common factor. Five short practice questions a day will build this habit.",
  homework: "",
};
