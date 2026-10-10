import { describe, expect, it } from "vitest";
import { resolveBilling } from "../billing";
import {
  HOLD_REASON_CATEGORIES,
  HOLD_REASON_CATEGORY_LABELS,
  holdReasonCategory,
  holdReasonLabel,
  type HoldReasonCategory,
} from "../hold-reasons";
import { DATA_QUALITY_REASONS, classifyCoverage } from "../quality";
import { AUTOWRITER_TEACHER_ALLOWLIST } from "../roster";
import { classifyGateReason, evaluateSessionGates, parseAutowriterSessionDetail, planFeedbackForm } from "../session";
import { finalizeFields, validateFeedbackDraft, type ModelOutput } from "../validate";
import { GOOD_FIELDS, NOW, QUESTIONS, STUDENT_ID, STUDENT_NAME, SUBMISSION_ID, autoBlankSubmission, sessionDetail } from "./fixtures";

const JUDGE = "The judge found a claim the record does not support";
const REJECTED = "The drafts were rejected: ";

/**
 * Every reason the autowriter holds a class for, by where the code writes it, with its category and its label. A
 * reason built from a template appears with a sample of what fills it. Synthetic names and words only.
 */
const EMITTED: ReadonlyArray<readonly [reason: string, category: HoldReasonCategory, label: string]> = [
  // job.ts processSession: the third unexpected error on a class. The error's message is never shown.
  ["error:TypeError: fetch failed", "error", "An unexpected error kept stopping the class"],
  ["error:unknown", "error", "An unexpected error kept stopping the class"],

  // session.ts evaluateSessionGates → classifyGateReason "person" (first read, and the POST's fresh read).
  ["student_count_0", "data_quality", "No student"],
  ["student_not_wise_user", "data_quality", "Student not a Wise user"],
  ["attendance_0pct", "data_quality", "The student's attendance shows 0%"],
  ["attendance_45pct", "data_quality", "The student's attendance shows 45%"],
  // The account under the minimum beside a guest who did not stand in (most likely the student joined the wrong way).
  ["guest_stand_in_65pct", "data_quality", "A guest attended 65% while the student's account was under the attendance minimum: check whether the guest is the student"],
  ["guest_stand_in_0pct", "data_quality", "A guest attended 0% while the student's account was under the attendance minimum: check whether the guest is the student"],
  ["guest_stand_in_unknown", "data_quality", "A guest joined while the student's account was under the attendance minimum, but the guest's attendance is unknown"],
  ["guest_stand_in_tutor_absent", "data_quality", "A guest may be the student (the student's account was under the attendance minimum), but the tutor attended too little for a stand-in"],
  ["submission_ambiguous:2 teacher submissions", "billing_or_form", "The teacher submission in Wise is ambiguous"],
  ["submission_ambiguous:auto-submission without id", "billing_or_form", "The teacher submission in Wise is ambiguous"],
  ["non_teacher_submission_with_billing", "billing_or_form", "A student's submission in Wise carries billing fields"],

  // job.ts planPost: session.ts planFeedbackForm, then billing.ts resolveBilling (`billing:<reason>`).
  ["feedback_form_missing_or_disabled", "billing_or_form", "The feedback form is missing or switched off"],
  ["feedback_form_question_without_text", "billing_or_form", "A feedback form question has no text"],
  ["feedback_form_mapping_ready:unmapped_questions", "billing_or_form", "The feedback form's questions could not be matched to our fields"],
  ["feedback_form_mapping_form_drift:missing required mapping: topics; ambiguous required mapping: topics", "billing_or_form", "The feedback form's questions could not be matched to our fields"],
  ["feedback_form_question_unmapped", "billing_or_form", "The feedback form's questions could not be matched to our fields"],
  ["feedback_form_duplicate_field", "billing_or_form", "Two feedback form questions map to the same field"],
  ["billing:auto_status_CANCELLED", "billing_or_form", "Wise recorded the class as CANCELLED, not as completed"],
  ["billing:auto_status_missing", "billing_or_form", "Wise's auto-submission has no class status"],
  ["billing:auto_credits_missing", "billing_or_form", "Wise's auto-submission charged no credits"],
  ["billing:auto_credits_2_vs_scheduled_1", "billing_or_form", "The credits Wise charged (2) do not match the class length (1)"],
  ["billing:auto_credits_1_vs_scheduled_1.5", "billing_or_form", "The credits Wise charged (1) do not match the class length (1.5)"],
  ["billing:submission_human", "billing_or_form", "Billing for the class in Wise is not as expected"],
  ["billing:too_few_prior_submissions", "billing_or_form", "Billing for the class in Wise is not as expected"],
  ["billing:prior_status_disagrees", "billing_or_form", "Billing for the class in Wise is not as expected"],
  ["billing:prior_credits_disagree", "billing_or_form", "Billing for the class in Wise is not as expected"],
  ["billing:student_credits_unknown", "billing_or_form", "Billing for the class in Wise is not as expected"],
  ["billing:session_already_charged", "billing_or_form", "Billing for the class in Wise is not as expected"],
  ["billing:insufficient_student_credits", "billing_or_form", "The student does not have enough credits"],

  // job.ts processLeased and processTranscript.
  ["missing_student_or_tutor", "error", "The student or the tutor could not be identified"],
  ["missing_summary_student_or_tutor", "error", "The summary, the student or the tutor is missing"],
  ["thai_summary_no_transcript", "validation", "The summary is mostly Thai and there is no transcript to write from"],
  ["summary_only_held", "validation", "Only Wise's summary to write from, which is held for a person"],
  ["transcript_pass_unavailable", "error", "The transcript pass is switched off"],
  ["recording_multiple_parts", "data_quality", "Recording in several parts"],
  ["recording_too_short", "data_quality", "Recording too short"],
  ["transcript_too_short", "data_quality", "Transcript too short"],
  ["speakers_unclear", "data_quality", "Speakers unclear"],
  // Soniox failing three times on a class (transcribeFailed).
  ["soniox_create:HTTP 402", "error", "Transcription failed"],
  ["soniox_job_missing", "error", "The transcription job was lost"],
  ["soniox_status:HTTP 503", "error", "Transcription failed"],
  ["soniox_timeout", "error", "Transcription timed out"],
  ["soniox_error:bad audio", "error", "Transcription failed"],
  ["soniox_fetch:timeout", "error", "Transcription failed"],

  // pipeline.ts: one part per writer arm and reason, "; "-joined. The judge's quotes are lesson text: never shown.
  ["sol:unfaithful:scored 95% on the mock paper", "judge", JUDGE],
  ["sol:unfaithful:wrong person: Tom said 8 of the 10 pages | homework not set: three problems by Friday", "judge", JUDGE],
  ["sol:unfaithful:a | b; luna:unfaithful:c", "judge", JUDGE],
  ["glm:unfaithful:homework not in the summary", "judge", JUDGE],
  ["sol:unfaithful:", "judge", JUDGE],
  // A draft the judge rejected decides the category, whatever stopped the other writer.
  ["sol:unfaithful:a; luna:markdown:improvement", "judge", JUDGE],
  ["sol:output_not_json; luna:unfaithful:a", "judge", JUDGE],
  // validate.ts validateFeedbackDraft and parseModelOutput.
  ["sol:output_not_json; luna:output_not_json", "validation", `${REJECTED}a reply that is not JSON`],
  ["sol:output_schema_mismatch", "validation", `${REJECTED}a reply that does not fit the form`],
  ["sol:model_reports_student_not_attended; luna:model_reports_student_not_attended", "validation", `${REJECTED}the writer says the student did not attend`],
  ["sol:model_reports_no_lesson", "validation", `${REJECTED}the writer says no lesson took place`],
  ["sol:placeholder_token:homework", "validation", `${REJECTED}a name placeholder left in the text`],
  ["sol:thai_text:topics", "validation", `${REJECTED}Thai text`],
  ["sol:too_long:performance", "validation", `${REJECTED}a field too long for Wise`],
  ["glm:markdown:improvement; luna:output_not_json", "validation", `${REJECTED}Markdown formatting; a reply that is not JSON`],
  ["sol:placeholder_text:topics", "validation", `${REJECTED}a required field that is only a placeholder`],
  ["sol:policy:combined_characters:120/300", "validation", `${REJECTED}a draft that does not meet the feedback policy`],
  ["sol:field:improvement:placeholder", "validation", `${REJECTED}a field that does not meet the feedback policy`],
  ["sol:attendance_wording:missed_or_no_show:performance", "validation", `${REJECTED}wording that reads as an absence or a cancelled class`],
  ["sol:ai_suspect:similar_prior_feedback", "validation", `${REJECTED}text the Class Feedback checks would flag`],
  // A writer's reply that failed for its content (pipeline.ts isInfraFailure is false): the fallback writer is tried.
  ["sol:finish_reason_length; luna:finish_reason_length", "validation", `${REJECTED}a reply that was cut off`],
  ["sol:finish_reason_content_filter", "validation", `${REJECTED}a reply blocked by a content filter`],
  ["sol:finish_reason_tool_calls", "validation", `${REJECTED}a reply that did not finish`],
  ["sol:empty_content", "validation", `${REJECTED}an empty reply`],
  // The provider's own words for a moderation refusal or a context-length error are not shown.
  ["sol:This endpoint's maximum context length is 400000 tokens; luna:Input flagged by moderation", "validation", `${REJECTED}a reply that could not be used`],

  // submit.ts submitFeedbackGuarded: a precheck that stops the POST (job.ts postDraft holds the class with its draft).
  ["student_id_missing", "data_quality", "Student not a Wise user (POST check)"],
  ["expected_none_not_supported", "billing_or_form", "The submission in Wise is not the blank auto-submission"],
  ["expected_human_not_supported", "billing_or_form", "The submission in Wise is not the blank auto-submission"],
  ["billing_plan_not_reuse", "billing_or_form", "The post would change the credits Wise already charged"],
  ["credit_baseline:session_credit_entries_2", "billing_or_form", "The student's credit entries for the class are not as expected"],
  ["credit_baseline:session_credit_0.5", "billing_or_form", "The student's credit entries for the class are not as expected"],
  ["detail_id_mismatch", "billing_or_form", "Wise returned a different class than the one asked for"],
  ["form_lacks_field:homework", "billing_or_form", "The feedback form lacks a field the draft fills"],
  ["existing_answers_not_in_form_order", "billing_or_form", "The answers already in Wise do not line up with the form"],
  ["teacher_missing", "billing_or_form", "Wise shows no teacher for the class"],
  ["submission_changed_to_none", "billing_or_form", "The submission in Wise changed before the post"],
  ["submission_changed_to_auto_blank", "billing_or_form", "The submission in Wise changed before the post"],
  ["submission_changed_to_ambiguous", "billing_or_form", "The submission in Wise changed before the post"],
  ["billing_differs_from_current_submission", "billing_or_form", "Status or credits in Wise changed before the post"],
];

describe("holdReasonCategory and holdReasonLabel", () => {
  it.each(EMITTED)("%s → %s", (reason, category, label) => {
    expect(holdReasonCategory(reason)).toBe(category);
    expect(holdReasonLabel(reason)).toBe(label);
  });

  it("puts no reason the code emits under other, and never shows one as its raw code", () => {
    expect(EMITTED.filter(([, category]) => category === "other")).toEqual([]);
    expect(EMITTED.filter(([reason]) => holdReasonLabel(reason) === reason)).toEqual([]);
    // Every category but `other` is reached.
    expect(new Set(EMITTED.map(([, category]) => category))).toEqual(new Set(HOLD_REASON_CATEGORIES.filter((category) => category !== "other")));
  });

  it("calls a hold data quality exactly when coverage leaves it out (D-03)", () => {
    for (const [reason, category] of EMITTED) {
      expect([reason, classifyCoverage({ state: "held", reason }) === "excluded_data_quality"]).toEqual([reason, category === "data_quality"]);
    }
    // Every data-quality hold in quality.ts has a sample above, so a reason added there cannot be missed here.
    const held = DATA_QUALITY_REASONS.filter((entry) => entry.coverage === "excluded_data_quality");
    expect(held.filter((entry) => !EMITTED.some(([reason, category]) => category === "data_quality" && entry.match.test(reason)))).toEqual([]);
    // Matched whole, like coverage: a reason that only contains a data-quality code is not one.
    expect(holdReasonCategory("recording_too_short_maybe")).toBe("other");
    expect(holdReasonCategory("attendance_42.5pct")).toBe("other");
  });

  it("shows a reason nobody listed as it is, under other", () => {
    for (const reason of ["something_new", "summary_fallback:speakers_unclear", "recording_too_short_maybe", "retry_requested"]) {
      expect(holdReasonCategory(reason)).toBe("other");
      expect(holdReasonLabel(reason)).toBe(reason);
    }
    // The switched-off tutor's hand-back is a skip reason (`skipped_scope`), never a hold.
    expect(holdReasonCategory("tutor_off_at_deadline")).toBe("other");
    expect(holdReasonCategory(null)).toBe("other");
    expect(holdReasonCategory("")).toBe("other");
    expect(holdReasonLabel(null)).toBe("No reason recorded");
    expect(holdReasonLabel("  ")).toBe("No reason recorded");
  });

  it("never repeats lesson text, an error's message or a provider's words in a label", () => {
    const secrets = ["scored 95%", "Tom said 8 of the 10 pages", "three problems by Friday", "fetch failed", "moderation", "context length", "bad audio", "402"];
    for (const [reason] of EMITTED) {
      const label = holdReasonLabel(reason);
      expect(secrets.filter((secret) => label.includes(secret))).toEqual([]);
    }
  });

  it("names each distinct problem of a rejected draft once, the first three at most", () => {
    expect(holdReasonLabel("sol:markdown:topics; sol:markdown:improvement; luna:markdown:topics")).toBe(`${REJECTED}Markdown formatting`);
    expect(holdReasonLabel("sol:markdown:topics; sol:thai_text:topics; sol:too_long:homework; luna:output_not_json; luna:empty_content"))
      .toBe(`${REJECTED}Markdown formatting; Thai text; a field too long for Wise; and 2 more`);
    // A reason cut at 900 characters can end in half a code: what was recognised is named, the tail is dropped.
    expect(holdReasonLabel("sol:markdown:topics; luna:placeh")).toBe(`${REJECTED}Markdown formatting`);
  });

  it("lists the categories in display order, each with a name", () => {
    expect(HOLD_REASON_CATEGORIES).toEqual(["data_quality", "judge", "validation", "billing_or_form", "error", "other"]);
    expect(HOLD_REASON_CATEGORY_LABELS).toEqual({
      data_quality: "Data quality", judge: "Judge", validation: "Validation", billing_or_form: "Billing or form", error: "Error", other: "Other",
    });
  });
});

// The reasons below are not typed out: they are what the real checks return, so a check that gains a reason (or
// renames one) shows up here as `other`, or as a label that is only the raw code.
describe("hold reasons as the code returns them", () => {
  const parse = (overrides: Record<string, unknown> = {}) => parseAutowriterSessionDetail({ data: sessionDetail(overrides) });
  const teacher = sessionDetail().participants[0];
  const expectKnown = (reason: string, category: HoldReasonCategory) => {
    expect([reason, holdReasonCategory(reason)]).toEqual([reason, category]);
    expect(holdReasonLabel(reason)).not.toBe(reason);
  };

  it("labels every gate failure that holds a class for a person", () => {
    const student = { wiseUserId: STUDENT_ID, name: STUDENT_NAME, isTeacher: false, inMeetingDuration: 600, absolutePercentAttendance: 20 };
    const studentSubmission = { _id: "s1", profile: "student", answers: [], sessionStatus: "COMPLETED", creditsConsumed: 1 };
    const absentAccount = { ...student, inMeetingDuration: 0, absolutePercentAttendance: 0 };
    const zoomGuest = { name: "Zoom user", isTeacher: false, inMeetingDuration: 2340, absolutePercentAttendance: 65 };
    const held = [
      parse({ participants: [teacher] }),
      parse({ participants: [teacher, student] }),
      parse({ participants: [teacher, { name: "Guest", isTeacher: false, inMeetingDuration: 3700, absolutePercentAttendance: 98 }] }),
      parse({ participants: [teacher, absentAccount, zoomGuest] }),
      parse({ participants: [teacher, absentAccount, { ...zoomGuest, inMeetingDuration: undefined, absolutePercentAttendance: undefined }] }),
      parse({ participants: [{ ...teacher, inMeetingDuration: 600 }, absentAccount, { ...zoomGuest, absolutePercentAttendance: 95 }] }),
      parse({ feedbackSubmissions: [autoBlankSubmission(), autoBlankSubmission({ _id: "6a0000000000000000000005" })] }),
      parse({ feedbackSubmissions: [autoBlankSubmission({ _id: undefined })] }),
      parse({ feedbackSubmissions: [autoBlankSubmission(), studentSubmission] }),
    ].map((detail) => {
      const gates = evaluateSessionGates(detail, { now: NOW, allowlist: AUTOWRITER_TEACHER_ALLOWLIST });
      if (gates.ok) throw new Error("the gate was expected to fail");
      // Long after the class: attendance has settled, so these are holds for a person, not retries.
      expect(classifyGateReason(gates.reason, { minutesSinceEnd: 600 })).toBe("person");
      return gates.reason;
    });
    expect(held).toEqual([
      "student_count_0", "attendance_20pct", "student_not_wise_user",
      "guest_stand_in_65pct", "guest_stand_in_unknown", "guest_stand_in_tutor_absent",
      "submission_ambiguous:2 teacher submissions", "submission_ambiguous:auto-submission without id",
      "non_teacher_submission_with_billing",
    ]);
    for (const reason of held.slice(0, 6)) expectKnown(reason, "data_quality");
    for (const reason of held.slice(6)) expectKnown(reason, "billing_or_form");
  });

  it("labels every way the feedback form or the billing can stop a post", () => {
    const forms = [
      parse({ feedbackForm: null }),
      parse({ feedbackForm: { _id: "form1", profile: "teacher", enabled: false, questions: QUESTIONS } }),
      parse({ feedbackForm: { _id: "form1", profile: "teacher", enabled: true, questions: [...QUESTIONS.slice(0, 3), { _id: "q4", type: "LONG_ANSWER" }] } }),
      parse({ feedbackForm: { _id: "form1", profile: "teacher", enabled: true, questions: [...QUESTIONS, { _id: "q5", questionText: "Favourite colour", type: "SHORT_ANSWER" }] } }),
      parse({ feedbackForm: { _id: "form1", profile: "teacher", enabled: true, questions: [...QUESTIONS, { ...QUESTIONS[0], _id: "q5" }] } }),
    ].map((detail) => {
      const form = planFeedbackForm(detail);
      if (form.ok) throw new Error("the form was expected to be refused");
      return form.reason;
    });
    expect(new Set(forms).size).toBeGreaterThanOrEqual(3);
    for (const reason of forms) expectKnown(reason, "billing_or_form");

    const autoBlank = { kind: "auto_blank" as const, submissionId: SUBMISSION_ID };
    const billing = [
      resolveBilling({ submission: { ...autoBlank, sessionStatus: "CANCELLED", creditsConsumed: 1 }, scheduledMinutes: 60 }),
      resolveBilling({ submission: { ...autoBlank, sessionStatus: null, creditsConsumed: 1 }, scheduledMinutes: 60 }),
      resolveBilling({ submission: { ...autoBlank, sessionStatus: "COMPLETED", creditsConsumed: null }, scheduledMinutes: 60 }),
      resolveBilling({ submission: { ...autoBlank, sessionStatus: "COMPLETED", creditsConsumed: 1 }, scheduledMinutes: 90 }),
      resolveBilling({ submission: { kind: "human", submissionId: null, blank: false }, scheduledMinutes: 60 }),
      resolveBilling({ submission: { kind: "none" }, scheduledMinutes: 60 }),
    ].map((result) => {
      if (result.ok) throw new Error("the billing was expected to be refused");
      return `billing:${result.reason}`;
    });
    expect(billing.slice(0, 4)).toEqual([
      "billing:auto_status_CANCELLED", "billing:auto_status_missing", "billing:auto_credits_missing", "billing:auto_credits_1_vs_scheduled_1.5",
    ]);
    for (const reason of billing) expectKnown(reason, "billing_or_form");
  });

  it("names every problem the validator finds in a draft", () => {
    const long = "word ".repeat(1_100);
    const drafts: ModelOutput[] = [
      // Not attended, no lesson, Markdown, Thai text, a leftover placeholder, an answer longer than Wise takes.
      { topics: "**Fractions**", performance: "ทำได้ดีมาก", improvement: `Ask [TUTOR] about ${long}`, homework: "", studentAttended: false, lessonHappened: false },
      // A placeholder answer, too little text overall.
      { topics: "N/A", performance: "ok", improvement: "-", homework: "", studentAttended: true, lessonHappened: true },
      // An attendance label where feedback should be.
      { ...GOOD_FIELDS, performance: "Absent.", studentAttended: true, lessonHappened: true },
    ];
    const reasons = drafts.flatMap((output) => {
      const result = validateFeedbackDraft({
        output, fields: finalizeFields(output, "Tom"), studentFullName: STUDENT_NAME, tutorNames: ["Anna"], priorFeedback: [],
      });
      if (result.ok) throw new Error("the draft was expected to be rejected");
      return result.reasons;
    });
    const kinds = new Set(reasons.map((reason) => reason.split(":")[0]));
    for (const kind of [
      "model_reports_student_not_attended", "model_reports_no_lesson", "markdown", "thai_text", "placeholder_token", "too_long",
      "placeholder_text", "policy", "field", "attendance_wording", "ai_suspect",
    ]) expect([kind, kinds.has(kind)]).toEqual([kind, true]);
    for (const reason of reasons) {
      // As pipeline.ts writes it: prefixed with the writer's arm.
      expect([reason, holdReasonCategory(`sol:${reason}`)]).toEqual([reason, "validation"]);
      const label = holdReasonLabel(`sol:${reason}`);
      expect([reason, label.startsWith(REJECTED), label.includes("could not be used")]).toEqual([reason, true, false]);
    }
  });
});
