import { describe, expect, it } from "vitest";
import {
  buildFeedbackPostBody,
  classifyGateReason,
  recordingForTranscription,
  recordingTooShort,
  zoomTranscriptUrl,
  classifyTeacherSubmission,
  detailClassName,
  evaluateSessionGates,
  extractAiSummary,
  guestNamedAsStudent,
  nonTeacherBillingEvidence,
  parseAutowriterSessionDetail,
  planFeedbackForm,
  storedTeacherFields,
  studentParticipants,
  tutorSelfNames,
} from "../session";
import { classifyCoverage } from "../quality";
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

  it("names a fractional attendance by its whole percent, rounded down, so it is classified like any other", () => {
    const attended = (percent: number) => parse({ participants: sessionDetail().participants.map((participant) =>
      participant.isTeacher ? participant : { ...participant, absolutePercentAttendance: percent }) });
    expect(evaluateSessionGates(attended(42.5), gateInput)).toEqual({ ok: false, reason: "attendance_42pct" });
    // The threshold still compares the raw value: 49.9 is under 50; 50 passes.
    expect(evaluateSessionGates(attended(49.9), gateInput)).toEqual({ ok: false, reason: "attendance_49pct" });
    expect(evaluateSessionGates(attended(50), gateInput)).toEqual({ ok: true });
    // Retried while attendance settles, then held for a person; and left out of coverage as the class's own data (D-03).
    expect(classifyGateReason("attendance_42pct", { minutesSinceEnd: 30 })).toBe("retry");
    expect(classifyGateReason("attendance_42pct", { minutesSinceEnd: 90 })).toBe("person");
    expect(classifyCoverage({ state: "held", reason: "attendance_42pct" })).toBe("excluded_data_quality");
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
    // Mimi, 29 Sep: the student joined by Zoom link as a guest under his nickname and surname; his Wise account shows 0 minutes.
    const teacher = { ...sessionDetail().participants[0], inMeetingDuration: 3461 };
    const account = { wiseUserId: "6a00000000000000000000a1", name: "Wichai (Krit.Ka) Kaewmanee", isTeacher: false, inMeetingDuration: 0 };
    const guest = { name: "Krit Kaewmanee", isTeacher: false, inMeetingDuration: 3246, absolutePercentAttendance: 94 };
    const standIn = studentParticipants(parse({ participants: [account, guest, teacher] }));
    expect(standIn).toEqual([{
      wiseUserId: "6a00000000000000000000a1", name: "Wichai (Krit.Ka) Kaewmanee",
      inMeetingSeconds: 3246, absolutePercentAttendance: 94, joinedAsGuest: "Krit Kaewmanee",
    }]);
    expect(evaluateSessionGates(parse({ participants: [account, guest, teacher] }), gateInput)).toEqual({ ok: true });

    const gate = (participants: unknown[]) => evaluateSessionGates(parse({ participants }), gateInput);
    // A guest not named as the student left early, or the tutor did: no stand-in, and the reason says which
    // (owner rule, 2 Oct: usually the student joining the wrong way, held for a person once attendance settles).
    const zoomGuest = { ...guest, name: "Zoom user" };
    expect(gate([account, { ...zoomGuest, absolutePercentAttendance: 79, inMeetingDuration: 2844 }, teacher])).toEqual({ ok: false, reason: "guest_stand_in_79pct" });
    expect(gate([account, guest, { ...teacher, inMeetingDuration: 2800 }])).toEqual({ ok: false, reason: "guest_stand_in_tutor_absent" });
    // The Wise account attended too: two people.
    expect(gate([{ ...account, inMeetingDuration: 3300, absolutePercentAttendance: 92 }, guest, teacher])).toEqual({ ok: false, reason: "student_count_2_guest" });
    expect(classifyGateReason("student_count_2_guest", { minutesSinceEnd: 5 })).toBe("retry");
    expect(classifyGateReason("student_count_2_guest", { minutesSinceEnd: 90 })).toBe("scope");
    // The tutor listed twice, or only as a percentage: their best entry counts.
    const tutorAsPercent = { ...teacher, inMeetingDuration: undefined, absolutePercentAttendance: 96 };
    expect(gate([account, guest, { ...teacher, inMeetingDuration: 600 }, tutorAsPercent])).toEqual({ ok: true });
    // A nameless guest still stands in; nothing to redact.
    expect(studentParticipants(parse({ participants: [account, { ...guest, name: "" }, teacher] }))[0]?.joinedAsGuest).toBe("");
    // Two guests, or a group class: no stand-in.
    expect(gate([account, guest, { ...guest, name: "Mum" }, teacher])).toEqual({ ok: false, reason: "student_count_3" });
    expect(evaluateSessionGates(parse({ participants: [account, guest, teacher], classType: "GROUP" }), gateInput))
      .toEqual({ ok: false, reason: "class_type_GROUP" });
  });

  it("lets a guest under the student's own name stand in at the usual attendance minimum (owner rule, 2 Oct)", () => {
    // 2 Oct: the student joined by Zoom link as a stretched nickname at 65%; the Wise account shows 0 minutes.
    const teacher = { ...sessionDetail().participants[0], inMeetingDuration: 3461 };
    const account = { wiseUserId: "6a00000000000000000000a2", name: "Somchai (Aim.Ka) Kaewmanee", isTeacher: false, inMeetingDuration: 0 };
    const guest = { name: "aimmm", isTeacher: false, inMeetingDuration: 2340, absolutePercentAttendance: 65 };
    const gate = (participants: unknown[]) => evaluateSessionGates(parse({ participants }), gateInput);

    expect(studentParticipants(parse({ participants: [account, guest, teacher] }))).toEqual([{
      wiseUserId: "6a00000000000000000000a2", name: "Somchai (Aim.Ka) Kaewmanee",
      inMeetingSeconds: 2340, absolutePercentAttendance: 65, joinedAsGuest: "aimmm",
    }]);
    expect(gate([account, guest, teacher])).toEqual({ ok: true });
    // Exactly the usual minimum stands in; under it, no stand-in.
    expect(gate([account, { ...guest, absolutePercentAttendance: 50 }, teacher])).toEqual({ ok: true });
    expect(gate([account, { ...guest, absolutePercentAttendance: 49 }, teacher])).toEqual({ ok: false, reason: "guest_stand_in_49pct" });
    // The surname alone is enough (owner rule, 2 Oct)...
    expect(gate([account, { ...guest, name: "Nattapong Kaewmanee" }, teacher])).toEqual({ ok: true });
    // ...but a family word means a parent's or sibling's name for the device: the stricter guest bar.
    expect(gate([account, { ...guest, name: "Kaewmanee Family" }, teacher])).toEqual({ ok: false, reason: "guest_stand_in_65pct" });
    expect(gate([account, { ...guest, name: "Mae Aim" }, teacher])).toEqual({ ok: false, reason: "guest_stand_in_65pct" });
    // A device whose model word is also a nickname is not the student.
    const air = { ...account, name: "Somchai (Air.Ka) Kaewmanee" };
    expect(gate([air, { ...guest, name: "iPad Air" }, teacher])).toEqual({ ok: false, reason: "guest_stand_in_65pct" });
    // A guest not named as the student keeps the higher bar; so does a nameless guest or a device on someone else's name.
    expect(gate([account, { ...guest, name: "Nattapong" }, teacher])).toEqual({ ok: false, reason: "guest_stand_in_65pct" });
    expect(gate([account, { ...guest, name: "" }, teacher])).toEqual({ ok: false, reason: "guest_stand_in_65pct" });
    expect(gate([account, { ...guest, name: "Mom's iPad" }, teacher])).toEqual({ ok: false, reason: "guest_stand_in_65pct" });
    // The tutor's bar does not move.
    expect(gate([account, guest, { ...teacher, inMeetingDuration: 2800 }])).toEqual({ ok: false, reason: "guest_stand_in_tutor_absent" });
    // The Wise account attended too: two people.
    expect(gate([{ ...account, inMeetingDuration: 3300, absolutePercentAttendance: 92 }, guest, teacher])).toEqual({ ok: false, reason: "student_count_2_guest" });
  });

  it("holds an absent account beside a guest who did not stand in for a person, not out of scope (owner rule, 2 Oct)", () => {
    // The student joined as a guest under a name the gate cannot tie to them, while the Wise account shows 0 minutes.
    const teacher = { ...sessionDetail().participants[0], inMeetingDuration: 3461 };
    const account = { wiseUserId: "6a00000000000000000000a3", name: "Pimchanok (Fern.Su) Suksawat", isTeacher: false, inMeetingDuration: 0 };
    const guest = { name: "Zoom user", isTeacher: false, inMeetingDuration: 2340, absolutePercentAttendance: 65 };
    const gate = (participants: unknown[]) => evaluateSessionGates(parse({ participants }), gateInput);

    // The guest's attendance names the reason, rounded down like `attendance_<n>pct`.
    expect(gate([account, guest, teacher])).toEqual({ ok: false, reason: "guest_stand_in_65pct" });
    expect(gate([account, { ...guest, absolutePercentAttendance: 79.6 }, teacher])).toEqual({ ok: false, reason: "guest_stand_in_79pct" });
    expect(gate([account, { ...guest, absolutePercentAttendance: 0, inMeetingDuration: 0 }, teacher])).toEqual({ ok: false, reason: "guest_stand_in_0pct" });
    // A guest who stayed but no attendance for them at all: unknown.
    expect(gate([account, { ...guest, absolutePercentAttendance: undefined, inMeetingDuration: undefined }, teacher]))
      .toEqual({ ok: false, reason: "guest_stand_in_unknown" });
    // The guest qualified but the tutor did not; with both short, the guest's attendance is named.
    const shortTutor = { ...teacher, inMeetingDuration: 1200 };
    expect(gate([account, { ...guest, absolutePercentAttendance: 90 }, shortTutor])).toEqual({ ok: false, reason: "guest_stand_in_tutor_absent" });
    expect(gate([account, guest, shortTutor])).toEqual({ ok: false, reason: "guest_stand_in_65pct" });
    // The account under the minimum but not zero is still "absent" for this rule.
    expect(gate([{ ...account, inMeetingDuration: 900, absolutePercentAttendance: 25 }, guest, teacher]))
      .toEqual({ ok: false, reason: "guest_stand_in_65pct" });

    // Retried while attendance settles, then held for a person (alert), and left out of coverage as the class's own data.
    for (const reason of ["guest_stand_in_65pct", "guest_stand_in_0pct", "guest_stand_in_unknown", "guest_stand_in_tutor_absent"]) {
      expect(classifyGateReason(reason, { minutesSinceEnd: 30 })).toBe("retry");
      expect(classifyGateReason(reason, { minutesSinceEnd: 90 })).toBe("person");
      expect(classifyGateReason(reason)).toBe("person");
      expect(classifyCoverage({ state: "held", reason })).toBe("excluded_data_quality");
    }

    // The account attended at the minimum or more beside a guest: two people, out of scope as before.
    expect(gate([{ ...account, inMeetingDuration: 1800, absolutePercentAttendance: 50 }, guest, teacher]))
      .toEqual({ ok: false, reason: "student_count_2_guest" });
    // No attendance for the account yet: still the plain account-plus-guest reason (it may settle either way).
    expect(gate([{ ...account, inMeetingDuration: undefined }, guest, teacher])).toEqual({ ok: false, reason: "student_count_2_guest" });
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

    // Anyone else still counts: an unknown guest, a nameless guest (the student attended: no stand-in), or a
    // Wise account that only shares a name.
    const others: Array<[Record<string, unknown>, string]> = [
      [{ name: "Mum", isTeacher: false, absolutePercentAttendance: 80 }, "student_count_2_guest"],
      [{ name: "", isTeacher: false, absolutePercentAttendance: 80 }, "student_count_2_guest"],
      [{ wiseUserId: "6a0000000000000000000abc", name: "Kev", isTeacher: false, absolutePercentAttendance: 80 }, "student_count_2"],
    ];
    for (const [other, reason] of others) {
      expect(evaluateSessionGates(parse({ participants: [...sessionDetail().participants, other] }), gateInput))
        .toEqual({ ok: false, reason });
    }
  });

  it("knows the tutor under a nickname kept out of redaction (`selfNames`)", () => {
    // Shop's nickname is an English word, so it is not redacted, but a guest device under it is still Shop.
    const shop = { _id: "696e2c4343579bbada233fee", name: "Warit (Shop) Trikasemsak Online" };
    const participants = [
      { wiseUserId: shop._id, name: shop.name, isTeacher: true, inMeetingDuration: 3800 },
      sessionDetail().participants[1],
      { name: "Shop", isTeacher: false, inMeetingDuration: 3500, absolutePercentAttendance: 95 },
    ];
    const detail = parse({ userId: shop, participants });
    expect(studentParticipants(detail).map((student) => student.name)).toEqual([STUDENT_NAME]);
    expect(tutorSelfNames(detail)).toContain("Shop");
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

describe("detailClassName", () => {
  it("is Wise's class name, else classId.name, else the first student with a Wise account", () => {
    expect(detailClassName(parse())).toBe(STUDENT_NAME);
    expect(detailClassName(parse({ className: "  ", classId: { _id: "6a0000000000000000000001", name: " Athen class " } })))
      .toBe("Athen class");
    expect(detailClassName(parse({ className: undefined }))).toBe(STUDENT_NAME);
  });

  it("is null when Wise names neither the class nor a student account", () => {
    const participants = [
      { wiseUserId: "696e2c4343579bbada2340ed", name: "Kevin (Kev) Y. Hsieh Online", isTeacher: true, inMeetingDuration: 3800 },
      { name: "guest", isTeacher: false, inMeetingDuration: 3700 },
    ];
    expect(detailClassName(parse({ className: undefined, participants }))).toBeNull();
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

describe("guestNamedAsStudent", () => {
  const student = "Somchai (Aim.Ka) Kaewmanee";

  it("matches the student's nickname, first name or surname as a whole word", () => {
    expect(guestNamedAsStudent("Aim", student)).toBe(true);
    expect(guestNamedAsStudent("aimmm", student)).toBe(true);
    expect(guestNamedAsStudent("SOMCHAI", student)).toBe(true);
    expect(guestNamedAsStudent("Krit Kaewmanee", student)).toBe(true);
    expect(guestNamedAsStudent("Aim's iPad", student)).toBe(true);
    expect(guestNamedAsStudent("iPhone ของ Aim", student)).toBe(true);
  });

  it("never matches device or family words, short words, prefixes or a nameless guest", () => {
    expect(guestNamedAsStudent("Mom's iPad", student)).toBe(false);
    expect(guestNamedAsStudent("Mae Kaew", student)).toBe(false);
    expect(guestNamedAsStudent("Ka", student)).toBe(false);
    expect(guestNamedAsStudent("Aimee", student)).toBe(false);
    expect(guestNamedAsStudent("Somchaiya", student)).toBe(false);
    expect(guestNamedAsStudent("", student)).toBe(false);
    expect(guestNamedAsStudent("Zoom user", student)).toBe(false);
  });

  it("never reads a device-model word as a nickname", () => {
    expect(guestNamedAsStudent("iPad Air", "Somchai (Air.Ka) Kaewmanee")).toBe(false);
    expect(guestNamedAsStudent("iPhone 15 Pro Max", "Somchai (Max.Ka) Kaewmanee")).toBe(false);
    expect(guestNamedAsStudent("Redmi Note 12", "Somchai (Note.Ka) Kaewmanee")).toBe(false);
  });

  it("does not take an account label for the surname", () => {
    expect(guestNamedAsStudent("Online", "Somchai (Aim.Ka) Kaewmanee Online")).toBe(false);
    expect(guestNamedAsStudent("Kaewmanee", "Somchai (Aim.Ka) Kaewmanee Online")).toBe(true);
  });

  it("matches the student's name in Thai script", () => {
    expect(guestNamedAsStudent("เอมมม", "สมชาย (เอม.Ka) แก้วมณี")).toBe(true);
    // น้อง is the usual prefix for the child themselves.
    expect(guestNamedAsStudent("น้อง เอม", "สมชาย (เอม.Ka) แก้วมณี")).toBe(true);
  });

  it("never matches a name with a family word in it (owner rule, 2 Oct)", () => {
    for (const name of ["Mae Aim", "Aim's Mom", "Mommy Aim", "Kaewmanee Family", "Aim Brother"]) {
      expect(guestNamedAsStudent(name, student)).toBe(false);
    }
    for (const name of ["แม่ เอม", "แม่เอม", "พ่อเอม", "ยาย เอม"]) {
      expect(guestNamedAsStudent(name, "สมชาย (เอม.Ka) แก้วมณี")).toBe(false);
    }
    // A surname-only match and a device word are still fine.
    expect(guestNamedAsStudent("Nattapong Kaewmanee", student)).toBe(true);
    expect(guestNamedAsStudent("Aim's iPad", student)).toBe(true);
  });

  it("reads a student name without a nickname or surname", () => {
    expect(guestNamedAsStudent("Nattapong", "Nattapong")).toBe(true);
    expect(guestNamedAsStudent("Nattapong", "Somchai Kaewmanee")).toBe(false);
  });
});
