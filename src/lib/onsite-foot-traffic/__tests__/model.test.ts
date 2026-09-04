import { describe, expect, it } from "vitest";

import type { WiseSession } from "@/lib/wise/types";

import { classifyWisePastSession, fingerprintStudentId } from "../model";

const rooms = [
  { name: "Focus", category: "standard" as const, active: true },
  { name: "Overflow", category: "overflow_only" as const, active: true },
  { name: "Hope (online)", category: "online_only" as const, active: true },
  { name: "Closed", category: "standard" as const, active: false },
];

function wiseSession(overrides: Record<string, unknown> = {}): WiseSession {
  return {
    _id: "session-1",
    scheduledStartTime: "2026-08-03T03:00:00.000Z",
    scheduledEndTime: "2026-08-03T04:00:00.000Z",
    meetingStatus: "ENDED",
    type: "OFFLINE",
    location: "Focus",
    teacherName: "Tutor Gift",
    title: "Private class for Student Name",
    classId: { _id: "class-1", name: "Student Name Math", subject: "Mathematics" },
    participants: [
      { wiseUserId: "student-raw-1", name: "Student Name", credits: 1, offline: true, isTeacher: false },
      { wiseUserId: "teacher-raw-1", name: "Tutor Gift", credits: 1, isTeacher: true },
    ],
    ...overrides,
  } as unknown as WiseSession;
}

describe("onsite foot-traffic classification", () => {
  it("counts one positive-credit non-teacher and removes every student/class name", () => {
    const result = classifyWisePastSession({
      session: wiseSession(),
      rooms,
      pseudonymSecret: "stable-test-secret",
    });

    expect(result?.session).toMatchObject({
      wiseSessionId: "session-1",
      attendanceDate: "2026-08-03",
      roomName: "Focus",
      subject: "Mathematics",
      tutorName: "Tutor Gift",
      participantCount: 1,
      countedVisitCount: 1,
      isCountedOnsite: true,
      exclusionReason: null,
    });
    expect(result?.visits).toHaveLength(1);
    expect(result?.visits[0].studentFingerprint).toMatch(/^[a-f0-9]{64}$/);
    const persisted = JSON.stringify(result);
    expect(persisted).not.toContain("student-raw-1");
    expect(persisted).not.toContain("Student Name");
    expect(persisted).not.toContain("Private class");
    expect(persisted).not.toContain("Student Name Math");
  });

  it("produces stable, secret-scoped HMAC fingerprints", () => {
    const first = fingerprintStudentId("student-1", "secret-a");
    expect(fingerprintStudentId("student-1", "secret-a")).toBe(first);
    expect(fingerprintStudentId("student-1", "secret-b")).not.toBe(first);
    expect(fingerprintStudentId("student-2", "secret-a")).not.toBe(first);
  });

  it.each([
    [{ meetingStatus: "CANCELLED" }, "cancelled"],
    [{ meetingStatus: "MISSED" }, "missed"],
    [{ meetingStatus: "UPCOMING" }, "not_ended"],
    [{ type: "SCHEDULED" }, "not_onsite"],
    [{ location: "" }, "missing_location"],
    [{ location: "Not a room" }, "unknown_room"],
    [{ location: "Hope (online)" }, "online_only_room"],
  ])("excludes a session for %s", (overrides, reason) => {
    const result = classifyWisePastSession({
      session: wiseSession(overrides),
      rooms,
      pseudonymSecret: "secret",
    });
    expect(result?.session.exclusionReason).toBe(reason);
    expect(result?.visits).toHaveLength(0);
  });

  it("requires the scheduled end instant to have passed even when Wise says ENDED", () => {
    const result = classifyWisePastSession({
      session: wiseSession({ scheduledEndTime: "2026-08-03T05:00:00.000Z" }),
      rooms,
      pseudonymSecret: "secret",
      now: new Date("2026-08-03T04:59:59.999Z"),
    });
    expect(result?.session.exclusionReason).toBe("not_ended");
    expect(result?.visits).toEqual([]);
  });

  it("tracks missing evidence and counts a positive-credit participant without a stable ID", () => {
    const result = classifyWisePastSession({
      session: wiseSession({
        participants: [
          { name: "No id", credits: 1, isTeacher: false },
          { wiseUserId: "no-credit", credits: 0, isTeacher: false },
        ],
      }),
      rooms,
      pseudonymSecret: "secret",
    });
    expect(result?.session).toMatchObject({
      countedVisitCount: 1,
      missingStableIdCount: 1,
      missingAttendanceEvidenceCount: 1,
      isCountedOnsite: true,
    });
    expect(result?.visits[0].studentFingerprint).toBeNull();
    expect(result?.visits[0].participantKey).toMatch(/^unidentified:session-1:/);
  });

  it("does not count a class when no participant has positive consumed credit", () => {
    const result = classifyWisePastSession({
      session: wiseSession({ participants: [{ wiseUserId: "student-1", credits: 0 }] }),
      rooms,
      pseudonymSecret: "secret",
    });
    expect(result?.session.exclusionReason).toBe("no_attendance_evidence");
    expect(result?.session.isCountedOnsite).toBe(false);
    expect(result?.visits).toEqual([]);
  });
});
