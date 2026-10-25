import { describe, expect, it } from "vitest";
import { feedbackAttendanceExemption } from "@/lib/post-class-feedback/deduction-exemption";
import { assessFeedbackContent } from "@/lib/post-class-feedback/policy";
import { assessAiSuspect } from "@/lib/post-class-feedback/similarity";
import { factOnlyNote } from "../deadline-fallback";
import { KEVIN_ONLINE_WISE_USER_ID } from "../roster";
import { parseAutowriterSessionDetail } from "../session";
import { sessionDetail, STUDENT_ID } from "./fixtures";

const detail = (title: string, studentName: string) => parseAutowriterSessionDetail({ data: sessionDetail({
  title,
  participants: [
    { wiseUserId: KEVIN_ONLINE_WISE_USER_ID, name: "Kevin (Kev) Y. Hsieh Online", isTeacher: true, inMeetingDuration: 3800 },
    { wiseUserId: STUDENT_ID, name: studentName, isTeacher: false, inMeetingDuration: 0, absolutePercentAttendance: 0 },
  ],
}) });

describe("48-hour fallback: the fact-only note", () => {
  it("states only the subject, length and Bangkok date of the class, by the student's nickname", () => {
    // Fixture class: 08:30–09:30 UTC on 28 Sep 2026 = 15:30 Bangkok, a Monday.
    expect(factOnlyNote(detail("Live Session - Chemistry", "Somchai (Tom.Ja) Jaidee"))).toEqual({
      topics: "1. Chemistry: the 60-minute online class scheduled for Monday 28 September",
      performance: "This is a short record of Tom's class. The detailed write-up for this class could not be completed within 48 hours, so this note keeps the class record complete. Please contact BeGifted if you would like more detail about this lesson.",
      improvement: "1. We will review the work from this class at the start of the next lesson and agree the next steps with Tom then.",
      homework: "",
    });
  });

  it("names no subject when the Wise title has none", () => {
    expect(factOnlyNote(detail("Live Session", "Somchai (Tom.Ja) Jaidee")).topics)
      .toBe("1. The 60-minute online class scheduled for Monday 28 September");
  });

  it.each([
    ["a bare title and a short name", "Live Session", "Bo"],
    ["a short subject", "Online Session - Art", "Ann (Ai.Ka) Kaewkla"],
    ["a long subject and name", "Live Session - IGCSE Additional Mathematics (Paper 2 revision)", "Worawut (Bas.Ho) Horburapa"],
  ])("passes the content policy and the AI-suspect check, and is never read as an absence: %s", (_case, title, name) => {
    const note = factOnlyNote(detail(title, name));
    expect(assessFeedbackContent(note)).toMatchObject({ compliant: true, contentStatus: "substantive" });
    expect(assessAiSuspect(note, { studentNames: [name] }).reasons).toEqual([]);
    for (const value of Object.values(note)) expect(feedbackAttendanceExemption(value)).toBeNull();
  });
});
