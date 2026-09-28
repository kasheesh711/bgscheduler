import { describe, expect, it } from "vitest";
import { feedbackAttendanceExemption, postClassDeductionExemption } from "../deduction-exemption";
import { evaluateSessionEligibility } from "../policy";
import { POST_CLASS_FEEDBACK_FIELDS } from "../types";

describe("feedback attendance exemptions", () => {
  it.each([
    "Absent", " ABSENT! ", "Student Absent", "Student is absent", "Absent student",
    "Absent - he didn’t join the link", "Absent - cancel on spot",
    "ABSENT (Arav showed up for 5 minutes in silence and left)",
    "Absence", "Absense", "No show", "NO-SHOW", "noshow",
    "The student was a no-show", "Student did not show up", "Student didn't attend",
    "No show. The session started at 8:53; the student did not appear.",
    "ขาดเรียน", "นักเรียนไม่มาเรียน", "น้องขาดเรียนครับ",
  ])("recognizes an explicit student attendance entry: %s", text => {
    expect(feedbackAttendanceExemption(text)).toBe("missed_or_no_show");
  });
  it.each([
    "Cancelled", "Canceled", "Class was cancelled", "Last-minute cancellation",
    "Late cancellation", "Cancelled on the spot", "Cancelled by: Parent",
    "Date received: 9/5/2026\nCancelled by: Parent\nAction Resolution: Cancelled (no reschedule)",
    "ยกเลิกคลาสกะทันหัน", "ยกเลิกเรียน", "คลาสถูกยกเลิก",
  ])("recognizes explicit class cancellation: %s", text => {
    expect(feedbackAttendanceExemption(text)).toBe("cancelled");
  });
  it.each([
    "The student is not absent", "Class was not cancelled", "Teacher No show",
    "Absent Friends by Alan Ayckbourn", "We discussed Absent Friends.",
    "Absence of a nucleus", "Oxygen is absent in anaerobic respiration.",
    "The student was absent from school last week.", "He was absent last week.",
    "The student will be absent tomorrow.", "We discussed an upcoming absence.",
    "The student did not show improvement.", "Cancellation of fractions",
    "The student did not join the discussion.", "He didn't attend school last week.",
    "We cancelled common factors.", "The x terms cancel.", "ยังขาดความมั่นใจ",
  ])("does not exempt unrelated, historical, future or negated prose: %s", text => {
    expect(feedbackAttendanceExemption(text)).toBeNull();
  });
  it.each(POST_CLASS_FEEDBACK_FIELDS)("accepts an attendance entry in %s even with positive credits", field => {
    const result = evaluateSessionEligibility({
      meetingStatus: "ENDED", creditsConsumed: 1, payoutEligible: true,
      feedbackFields: [{ [field]: "Absent" }],
    });
    expect(result).toMatchObject({ eligible: false, reason: "missed_or_no_show", exemption: { field, source: "feedback" } });
  });
});

describe("Gift consultation exemption", () => {
  it.each(["Consult - Event", "Consultation Ken", "Consultations", "CONSULT_KIN"])("exempts Gift's named non-teaching class: %s", className => {
    expect(evaluateSessionEligibility({
      canonicalTutorKey: "Gift", className, meetingStatus: "ENDED", creditsConsumed: 1,
    })).toMatchObject({ eligible: false, reason: "non_teaching_consultation" });
  });
  it("uses structured type or subject even when the class is named for a student", () => {
    expect(postClassDeductionExemption({ canonicalTutorKey: "Gift", className: "Ken", classType: "CONSULTATION" })?.reason).toBe("non_teaching_consultation");
    expect(postClassDeductionExemption({ canonicalTutorKey: "Gift", className: "Ken", subject: "Consult Ken" })?.reason).toBe("non_teaching_consultation");
  });
  it("preserves paid teaching, mock-test classification and other tutors' policy", () => {
    expect(postClassDeductionExemption({ canonicalTutorKey: "Gift", className: "Math" })).toBeNull();
    expect(postClassDeductionExemption({ canonicalTutorKey: "Gift", className: "ISEB Mock Test" })).toBeNull();
    expect(postClassDeductionExemption({ canonicalTutorKey: "Kevin", className: "Consult Ken" })).toBeNull();
  });
});
