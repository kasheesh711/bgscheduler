import { describe, expect, it } from "vitest";
import { feedbackAttendanceExemption } from "@/lib/post-class-feedback/deduction-exemption";
import { detectNoShow, noShowNote, readNoShow } from "../no-show";
import { parseAutowriterSessionDetail } from "../session";
import { sessionDetail, STUDENT_ID, STUDENT_NAME } from "./fixtures";
import { KEVIN_ONLINE_WISE_USER_ID } from "../roster";

const detailWith = (studentSeconds: number | null, tutorSeconds: number) => parseAutowriterSessionDetail({ data: sessionDetail({
  participants: [
    { wiseUserId: KEVIN_ONLINE_WISE_USER_ID, name: "Kevin (Kev) Y. Hsieh Online", isTeacher: true, inMeetingDuration: tutorSeconds },
    { wiseUserId: STUDENT_ID, name: STUDENT_NAME, isTeacher: false, ...(studentSeconds === null ? {} : { inMeetingDuration: studentSeconds }) },
  ],
}) });

describe("no-show classes", () => {
  it("recognises a student who never joined while the tutor waited, and prepares the note by nickname", () => {
    const facts = detectNoShow(detailWith(0, 717), "attendance_0pct");
    expect(facts).toMatchObject({ studentSeconds: 0, tutorMinutes: 11, scheduledMinutes: 60 });
    expect(facts?.note.performance).toBe("Student did not attend the class. I waited in the online classroom for about 11 minutes and Tom did not join.");
  });
  it.each([
    ["the student was in the room", detailWith(300, 717), "attendance_8pct"],
    ["the tutor did not wait", detailWith(0, 420), "attendance_0pct"],
    ["the hold is not about attendance", detailWith(0, 717), "billing:auto_credits_missing"],
    ["the student's time is unknown", detailWith(null, 717), "attendance_0pct"],
  ])("is not a no-show when %s", (_why, detail, reason) => {
    expect(detectNoShow(detail, reason)).toBeNull();
  });
  it("writes a note the deduction policy reads as a no-show", () => {
    expect(feedbackAttendanceExemption(noShowNote("Avi", 12).performance)).toBe("missed_or_no_show");
  });
  it("reads back only a note of the current version", () => {
    const facts = detectNoShow(detailWith(0, 717), "attendance_0pct");
    expect(readNoShow({ noShow: facts })).toEqual(facts);
    expect(readNoShow({ noShow: { ...facts, version: 0 } })).toBeNull();
    expect(readNoShow({})).toBeNull();
  });
});
