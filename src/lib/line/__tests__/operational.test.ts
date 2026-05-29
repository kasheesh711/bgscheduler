import { describe, expect, it } from "vitest";
import {
  inferLineOperationalIntent,
  selectPauseSessionsBeforeResumeDate,
  selectVerifiedStudentLinksForOperationalMessage,
  type LineOperationalCandidateSession,
} from "@/lib/line/operational";
import type { LineContactStudentLinkDto } from "@/lib/line/student-links";

function link(overrides: Partial<LineContactStudentLinkDto>): LineContactStudentLinkDto {
  return {
    id: "link-1",
    contactId: "contact-1",
    wiseStudentId: "wise-student-1",
    studentKey: "student::parent",
    studentName: "Ada.Li",
    parentName: "Parent Li",
    status: "verified",
    confidence: 1,
    evidence: {},
    reviewedByEmail: null,
    reviewedByName: null,
    reviewedAt: null,
    createdAt: "2026-05-20T00:00:00.000Z",
    updatedAt: "2026-05-20T00:00:00.000Z",
    currentStudentActivated: true,
    currentStudentHasFutureSessions: true,
    currentStudentHasLivePackage: true,
    ...overrides,
  };
}

function candidate(overrides: Partial<LineOperationalCandidateSession>): LineOperationalCandidateSession {
  return {
    wiseSessionId: "session-1",
    wiseClassId: "class-1",
    wiseStudentId: "wise-student-1",
    studentKey: "student::parent",
    studentName: "Ada.Li",
    packageName: "Math",
    subject: "Math",
    scheduledStartTime: "2026-06-09T10:00:00.000Z",
    scheduledEndTime: "2026-06-09T11:00:00.000Z",
    startLocalDate: "2026-06-09",
    startLocalTime: "17:00",
    endLocalTime: "18:00",
    durationMinutes: 60,
    meetingStatus: "SCHEDULED",
    teacherGroupId: "teacher-1",
    teacherName: "Teacher A",
    wiseTeacherId: "wise-teacher-1",
    location: "Online",
    score: 0,
    reasons: [],
    ...overrides,
  };
}

describe("LINE operational intent parsing", () => {
  it("parses Thai one-off cancellation with exact date and time", () => {
    const result = inferLineOperationalIntent(
      "ขอยกเลิกคลาสวันที่ 30/05/2026 เวลา 13:00 ค่ะ",
      "scheduling_request",
    );

    expect(result.intentType).toBe("cancel_one_off");
    expect(result.payload.targetDate).toBe("2026-05-30");
    expect(result.payload.targetStartTime).toBe("13:00");
    expect(result.payload.issues).toEqual([]);
  });

  it("requires an exact resume date for pauses", () => {
    const vague = inferLineOperationalIntent("ขอหยุดเรียนจนถึงปลายเดือนค่ะ", "scheduling_request");
    const exact = inferLineOperationalIntent("ขอหยุดเรียนจนถึง 10/06/2026 ค่ะ", "scheduling_request");

    expect(vague.intentType).toBe("pause_until");
    expect(vague.payload.issues).toContain("Pause request needs an exact resume date before selecting classes to cancel.");
    expect(exact.intentType).toBe("pause_until");
    expect(exact.payload.resumeDate).toBe("2026-06-10");
    expect(exact.payload.issues).toEqual([]);
  });

  it("parses resume and reschedule intents", () => {
    const resume = inferLineOperationalIntent("กลับมาเรียนวันที่ 10/06/2026 ได้ไหมคะ", "scheduling_request");
    const reschedule = inferLineOperationalIntent(
      "ขอเลื่อนคลาสวันที่ 30/05/2026 เวลา 15:30 ค่ะ",
      "scheduling_request",
    );

    expect(resume.intentType).toBe("resume");
    expect(resume.payload.resumeDate).toBe("2026-06-10");
    expect(reschedule.intentType).toBe("reschedule");
    expect(reschedule.payload.targetDate).toBe("2026-05-30");
    expect(reschedule.payload.targetStartTime).toBe("15:30");
  });
});

describe("LINE operational safety helpers", () => {
  it("blocks ambiguous sibling contacts unless the message identifies one child", () => {
    const links = [
      link({ id: "ada", studentKey: "ada::li", studentName: "Ada.Li" }),
      link({ id: "aya", wiseStudentId: "wise-student-2", studentKey: "aya::li", studentName: "Aya.Li" }),
    ];

    const ambiguous = selectVerifiedStudentLinksForOperationalMessage({
      links,
      messageText: "ขอยกเลิกคลาสวันที่ 30/05/2026 ค่ะ",
    });
    const identified = selectVerifiedStudentLinksForOperationalMessage({
      links,
      messageText: "ขอยกเลิกคลาสของ Aya วันที่ 30/05/2026 ค่ะ",
    });

    expect(ambiguous.selected).toEqual([]);
    expect(ambiguous.issues).toContain("Multiple verified children are linked to this LINE contact. Select the child before applying this operation.");
    expect(identified.selected.map((item) => item.studentKey)).toEqual(["aya::li"]);
    expect(identified.issues).toEqual([]);
  });

  it("selects pause sessions before the resume date and preserves classes on or after it", () => {
    const selected = selectPauseSessionsBeforeResumeDate([
      candidate({
        wiseSessionId: "before",
        scheduledStartTime: "2026-06-09T10:00:00.000Z",
        startLocalDate: "2026-06-09",
      }),
      candidate({
        wiseSessionId: "resume-day",
        scheduledStartTime: "2026-06-09T17:30:00.000Z",
        startLocalDate: "2026-06-10",
      }),
      candidate({
        wiseSessionId: "after",
        scheduledStartTime: "2026-06-10T04:00:00.000Z",
        startLocalDate: "2026-06-10",
      }),
    ], "2026-06-10");

    expect(selected.map((session) => session.wiseSessionId)).toEqual(["before"]);
  });
});
