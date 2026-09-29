import { describe, expect, it } from "vitest";
import {
  buildFeedbackPostBody,
  classifyGateReason,
  recordingForTranscription,
  recordingTooShort,
  zoomTranscriptUrl,
  classifyTeacherSubmission,
  evaluateSessionGates,
  extractAiSummary,
  nonTeacherBillingEvidence,
  parseAutowriterSessionDetail,
  planFeedbackForm,
  storedTeacherFields,
  studentParticipants,
} from "../session";
import { AUTOWRITER_TEACHER_ALLOWLIST } from "../roster";
import { GOOD_FIELDS, NOW, QUESTIONS, STUDENT_NAME, answers, autoBlankSubmission, sessionDetail } from "./fixtures";

const gateInput = { now: NOW, allowlist: AUTOWRITER_TEACHER_ALLOWLIST };
const parse = (overrides: Record<string, unknown> = {}) =>
  parseAutowriterSessionDetail({ data: sessionDetail(overrides) });

describe("extractAiSummary", () => {
  it("joins the overview and labelled details", () => {
    const summary = extractAiSummary(parse());
    expect(summary?.text).toContain("Overview: Kevin and Somchai practised");
    expect(summary?.text).toContain("Fractions: Somchai solved six");
    expect(summary?.meetingUUIDs).toEqual(["uuid-1"]);
  });

  it("returns null when Wise has no summary", () => {
    expect(extractAiSummary(parse({ rawMeetingSummary: [] }))).toBeNull();
    expect(extractAiSummary(parse({ rawMeetingSummary: null }))).toBeNull();
  });
});

describe("classifyTeacherSubmission", () => {
  it("recognises Wise's blank auto-submission", () => {
    expect(classifyTeacherSubmission(parse())).toEqual({
      kind: "auto_blank",
      submissionId: "6a0000000000000000000004",
      sessionStatus: "COMPLETED",
      creditsConsumed: 1,
    });
  });

  it("treats no teacher submission as none", () => {
    expect(classifyTeacherSubmission(parse({ feedbackSubmissions: [] }))).toEqual({ kind: "none" });
  });

  it("treats written feedback as human even if Wise once auto-submitted it", () => {
    const written = autoBlankSubmission({ answers: answers(["Fractions", "", "", ""]) });
    expect(classifyTeacherSubmission(parse({ feedbackSubmissions: [written] })).kind).toBe("human");
  });

  it("treats a blank submission without the auto flag as human", () => {
    const blank = autoBlankSubmission({ metadata: null });
    expect(classifyTeacherSubmission(parse({ feedbackSubmissions: [blank] }))).toMatchObject({ kind: "human", blank: true });
  });

  it("flags two teacher submissions as ambiguous", () => {
    const state = classifyTeacherSubmission(parse({ feedbackSubmissions: [autoBlankSubmission(), autoBlankSubmission({ _id: "x" })] }));
    expect(state.kind).toBe("ambiguous");
  });

  it("ignores student submissions without billing fields", () => {
    const student = { _id: "s1", profile: "student", answers: [], rating: 5 };
    const detail = parse({ feedbackSubmissions: [autoBlankSubmission(), student] });
    expect(classifyTeacherSubmission(detail).kind).toBe("auto_blank");
    expect(nonTeacherBillingEvidence(detail)).toBe(false);
    expect(nonTeacherBillingEvidence(parse({ feedbackSubmissions: [autoBlankSubmission(), { ...student, creditsConsumed: 1 }] }))).toBe(true);
  });
});

describe("evaluateSessionGates", () => {
  it("passes a finished, attended, auto-blank online 1:1 lesson", () => {
    expect(evaluateSessionGates(parse(), gateInput)).toEqual({ ok: true });
  });

  it.each([
    ["teacher_not_allowlisted", { userId: { _id: "6a00000000000000000000ff" } }],
    ["session_type_OFFLINE", { type: "OFFLINE" }],
    ["class_type_GROUP", { classType: "GROUP" }],
    ["meeting_CANCELLED", { meetingStatus: "CANCELLED" }],
    ["human_submission", { feedbackSubmissions: [autoBlankSubmission({ metadata: null, answers: answers(["x", "y", "z", ""]) })] }],
    ["no_ai_summary", { rawMeetingSummary: [] }],
  ])("rejects %s", (reason, overrides) => {
    expect(evaluateSessionGates(parse(overrides), gateInput)).toEqual({ ok: false, reason });
  });

  it("rejects a class whose deadline has passed", () => {
    const late = { now: new Date("2026-10-01T00:00:00.000Z"), allowlist: AUTOWRITER_TEACHER_ALLOWLIST };
    expect(evaluateSessionGates(parse(), late)).toEqual({ ok: false, reason: "deadline_passed_or_too_close" });
  });

  it("rejects low attendance and group sessions", () => {
    const participants = sessionDetail().participants.map((participant) =>
      participant.isTeacher ? participant : { ...participant, absolutePercentAttendance: 20 });
    expect(evaluateSessionGates(parse({ participants }), gateInput)).toEqual({ ok: false, reason: "attendance_20pct" });
    const extra = [...sessionDetail().participants, { wiseUserId: "other", name: "Other", isTeacher: false, absolutePercentAttendance: 90 }];
    expect(evaluateSessionGates(parse({ participants: extra }), gateInput)).toEqual({ ok: false, reason: "student_count_2" });
  });

  it("skips a class titled as in-person even when Wise's type says online", () => {
    expect(evaluateSessionGates(parse({ title: "In-Person Session - Math" }), gateInput)).toEqual({ ok: false, reason: "session_type_in_person_title" });
    expect(evaluateSessionGates(parse({ title: "On-site Session - Chemistry" }), gateInput)).toEqual({ ok: false, reason: "session_type_in_person_title" });
    expect(evaluateSessionGates(parse({ title: "Live Session - Math" }), gateInput)).toEqual({ ok: true });
    expect(classifyGateReason("session_type_in_person_title")).toBe("scope");
  });

  it("requires the one student to be a Wise user (the POST checks their credit)", () => {
    const guestStudent = sessionDetail().participants.map((participant) =>
      participant.isTeacher ? participant : { ...participant, wiseUserId: undefined });
    expect(evaluateSessionGates(parse({ participants: guestStudent }), gateInput)).toEqual({ ok: false, reason: "student_not_wise_user" });
    expect(classifyGateReason("student_not_wise_user", { minutesSinceEnd: 5 })).toBe("retry");
    expect(classifyGateReason("student_not_wise_user", { minutesSinceEnd: 90 })).toBe("person");
  });

  it("lets a guest who stayed the whole class stand in for a Wise account that shows absent (owner rule)", () => {
    // Mimi, 29 Sep: the student joined by Zoom link as "Pete Thanasatitkul"; his Wise account shows 0 minutes.
    const teacher = { ...sessionDetail().participants[0], inMeetingDuration: 3461 };
    const account = { wiseUserId: "698c1edeb0e4b23fd5316dfe", name: "Pawin (Pete.Th) Thanasatitkul", isTeacher: false, inMeetingDuration: 0 };
    const guest = { name: "Pete Thanasatitkul", isTeacher: false, inMeetingDuration: 3246, absolutePercentAttendance: 94 };
    const standIn = studentParticipants(parse({ participants: [account, guest, teacher] }));
    expect(standIn).toEqual([{
      wiseUserId: "698c1edeb0e4b23fd5316dfe", name: "Pawin (Pete.Th) Thanasatitkul",
      inMeetingSeconds: 3246, absolutePercentAttendance: 94, joinedAsGuest: "Pete Thanasatitkul",
    }]);
    expect(evaluateSessionGates(parse({ participants: [account, guest, teacher] }), gateInput)).toEqual({ ok: true });

    const gate = (participants: unknown[]) => evaluateSessionGates(parse({ participants }), gateInput);
    // The guest left early, or the tutor did: no stand-in.
    expect(gate([account, { ...guest, absolutePercentAttendance: 79, inMeetingDuration: 2844 }, teacher])).toEqual({ ok: false, reason: "student_count_2" });
    expect(gate([account, guest, { ...teacher, inMeetingDuration: 2800 }])).toEqual({ ok: false, reason: "student_count_2" });
    // The Wise account attended too: two people, out of scope.
    expect(gate([{ ...account, inMeetingDuration: 3300, absolutePercentAttendance: 92 }, guest, teacher])).toEqual({ ok: false, reason: "student_count_2" });
    // Two guests, or a group class: no stand-in.
    expect(gate([account, guest, { ...guest, name: "Mum" }, teacher])).toEqual({ ok: false, reason: "student_count_3" });
    expect(evaluateSessionGates(parse({ participants: [account, guest, teacher], classType: "GROUP" }), gateInput))
      .toEqual({ ok: false, reason: "class_type_GROUP" });
  });

  it("does not count the tutor joining their own class again as a student", () => {
    // Peat, 29 Sep: two guest devices under his own names beside his teacher account; a one-to-one class.
    const selfJoins = [
      ...sessionDetail().participants,
      { name: "Kevin Hsieh", isTeacher: false, inMeetingDuration: 3248, absolutePercentAttendance: 97 },
      { name: "  kev ", isTeacher: false, inMeetingDuration: 3151, absolutePercentAttendance: 94 },
      { name: "Kevin (Kev) Y. Hsieh", isTeacher: false, absolutePercentAttendance: 90 },
      // The tutor's other Wise account.
      { wiseUserId: "695369c028118f629edcb986", name: "Kevin (Kev) Y. Hsieh", isTeacher: false, absolutePercentAttendance: 95 },
    ];
    expect(studentParticipants(parse({ participants: selfJoins })).map((student) => student.name)).toEqual([STUDENT_NAME]);
    expect(evaluateSessionGates(parse({ participants: selfJoins }), gateInput)).toEqual({ ok: true });

    // Anyone else still counts: an unknown guest, a nameless guest, or a Wise account that only shares a name.
    const others = [
      { name: "Mum", isTeacher: false, absolutePercentAttendance: 80 },
      { name: "", isTeacher: false, absolutePercentAttendance: 80 },
      { wiseUserId: "6a0000000000000000000abc", name: "Kev", isTeacher: false, absolutePercentAttendance: 80 },
    ];
    for (const other of others) {
      expect(evaluateSessionGates(parse({ participants: [...sessionDetail().participants, other] }), gateInput))
        .toEqual({ ok: false, reason: "student_count_2" });
    }
  });
});

describe("second-pass inputs", () => {
  it("does not require a summary when writing from a transcript", () => {
    expect(evaluateSessionGates(parse({ rawMeetingSummary: [] }), { ...gateInput, requireSummary: false })).toEqual({ ok: true });
    expect(evaluateSessionGates(parse({ rawMeetingSummary: [] }), gateInput)).toEqual({ ok: false, reason: "no_ai_summary" });
  });

  it("finds the single composite recording and Zoom's transcript", () => {
    expect(recordingForTranscription(parse())).toEqual({ ok: false, reason: "recording_not_ready" });
    expect(recordingForTranscription(parse({ rawRecordings: [{ url: "https://files.wiseapp.live/a.mp4", partIndex: 1 }] })))
      .toEqual({ ok: true, url: "https://files.wiseapp.live/a.mp4", durationSeconds: null });
    expect(recordingForTranscription(parse({ rawRecordings: [{ url: "https://files.wiseapp.live/a.mp4", partIndex: 1, duration: 3520 }] })))
      .toEqual({ ok: true, url: "https://files.wiseapp.live/a.mp4", durationSeconds: 3520 });
    expect(recordingForTranscription(parse({ rawRecordings: [{ url: "https://x/1.mp4" }, { url: "https://x/2.mp4" }] })))
      .toEqual({ ok: false, reason: "recording_multiple_parts" });
    expect(zoomTranscriptUrl(parse({ rawTranscript: [{ url: "https://files.wiseapp.live/t.vtt" }] }))).toBe("https://files.wiseapp.live/t.vtt");
    expect(zoomTranscriptUrl(parse({ rawTranscript: [{ file: { path: "https://x/p.vtt" } }] }))).toBe("https://x/p.vtt");
    expect(zoomTranscriptUrl(parse())).toBeNull();
  });

  it("calls a recording under 70% of the scheduled class too short (Wise gives seconds)", () => {
    expect(recordingTooShort(3520, 60)).toBe(false); // a normal 60-min class: 58.7 min
    expect(recordingTooShort(2520, 60)).toBe(false); // 70% exactly
    expect(recordingTooShort(2519, 60)).toBe(true);
    expect(recordingTooShort(null, 60)).toBe(false); // unknown length: Soniox's own length is checked later
    expect(recordingTooShort(0, 60)).toBe(false);
  });
});

describe("session title", () => {
  it("is parsed from the Wise detail (it names the subject at BeGifted)", () => {
    expect(parse({ title: "Live Session - NVR" }).title).toBe("Live Session - NVR");
    expect(parse().title).toBeUndefined();
  });
});

describe("classifyGateReason", () => {
  it("waits for Wise to settle attendance before holding for absence or low attendance", () => {
    expect(classifyGateReason("student_count_0", { minutesSinceEnd: 1 })).toBe("retry");
    expect(classifyGateReason("attendance_20pct", { minutesSinceEnd: 30 })).toBe("retry");
    expect(classifyGateReason("student_count_0", { minutesSinceEnd: 61 })).toBe("person");
    expect(classifyGateReason("attendance_20pct", { minutesSinceEnd: 90 })).toBe("person");
    expect(classifyGateReason("attendance_20pct")).toBe("person");
  });

  it("keeps the other dispositions", () => {
    expect(classifyGateReason("student_count_2", { minutesSinceEnd: 1 })).toBe("scope");
    expect(classifyGateReason("deadline_passed_or_too_close")).toBe("expired");
    expect(classifyGateReason("human_submission")).toBe("human");
    expect(classifyGateReason("teacher_not_allowlisted")).toBe("scope");
    expect(classifyGateReason("no_ai_summary")).toBe("retry");
    expect(classifyGateReason("meeting_ONGOING")).toBe("retry");
    expect(classifyGateReason("meeting_CANCELLED")).toBe("scope");
    expect(classifyGateReason("non_teacher_submission_with_billing")).toBe("person");
  });
});

describe("form planning and POST body", () => {
  it("maps answers positionally in Wise form order", () => {
    const form = planFeedbackForm(parse());
    expect(form).toEqual({ ok: true, plan: { fieldOrder: ["topics", "performance", "improvement", "homework"] } });
    if (!form.ok) return;
    const body = buildFeedbackPostBody(form.plan, { ...GOOD_FIELDS, homework: "Worksheet 3 by Friday" }, { sessionStatus: "COMPLETED", creditsConsumed: 1 });
    expect(body).toEqual({
      answers: [
        { answer: GOOD_FIELDS.topics },
        { answer: GOOD_FIELDS.performance },
        { answer: GOOD_FIELDS.improvement },
        { answer: "Worksheet 3 by Friday" },
      ],
      sessionStatus: "COMPLETED",
      creditsConsumed: 1,
    });
  });

  it("refuses a form with an extra unmapped question (it would shift answers)", () => {
    const questions = [...QUESTIONS.slice(0, 2), { _id: "rating", questionText: "Rate the lesson", type: "RATING" }, ...QUESTIONS.slice(2)];
    const form = planFeedbackForm(parse({ feedbackForm: { questions } }));
    expect(form.ok).toBe(false);
  });

  it("reads back the stored fields of the teacher submission", () => {
    const written = autoBlankSubmission({ metadata: null, answers: answers([GOOD_FIELDS.topics, GOOD_FIELDS.performance, GOOD_FIELDS.improvement, ""]) });
    expect(storedTeacherFields(parse({ feedbackSubmissions: [written] }))).toEqual(GOOD_FIELDS);
  });
});
