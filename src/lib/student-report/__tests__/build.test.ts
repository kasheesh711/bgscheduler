import { describe, expect, it } from "vitest";

import { TEACHER_TBC } from "@/lib/student-schedule/types";
import {
  buildClassRow,
  buildParentReportPayload,
  classifySession,
  summarizeAttended,
  summarizeBuckets,
} from "../build";
import { resolveReportWindow } from "../window";

import type { ReportSessionInput } from "../build";
import type { ReportClassRow, ReportStudent } from "../types";

const STUDENT_A: ReportStudent = {
  studentKey: "student-a::parent-a",
  wiseStudentId: "wise-a",
  studentName: "Student A (Alpha.One)",
  parentName: "Parent A",
  code: "Alpha.One",
  shortName: "Alpha",
  activated: true,
};

const STUDENT_B: ReportStudent = {
  studentKey: "student-b::parent-b",
  wiseStudentId: "wise-b",
  studentName: "Student B",
  parentName: "Parent B",
  code: null,
  shortName: "Student",
  activated: true,
};

function session(overrides: Partial<ReportSessionInput> = {}): ReportSessionInput {
  return {
    wiseSessionId: "session-1",
    wiseStudentId: STUDENT_A.wiseStudentId,
    studentKey: STUDENT_A.studentKey,
    title: "Online Session - Mathematics",
    subject: "Y8-9 / G7-8 (Int.)",
    packageName: "Math package",
    scheduledStartTime: new Date("2026-06-01T03:00:00.000Z"),
    durationMinutes: 60,
    meetingStatus: "ENDED",
    sessionKind: "past",
    creditApplied: 1,
    teacherName: "Kru Mint",
    teacherFeedback: "Good work",
    ...overrides,
  };
}

function classRow(overrides: Partial<ReportClassRow> = {}): ReportClassRow {
  return {
    wiseSessionId: "session-1",
    dateKey: "2026-06-01",
    weekday: "Mon",
    startLabel: "10:00",
    durationMinutes: 60,
    classLabel: "Mathematics",
    modality: "online",
    teacher: "Kru Mint",
    bucket: "attended",
    creditApplied: 1,
    hasFeedback: true,
    packageName: "Math package",
    subjectBand: "Y8-9 / G7-8 (Int.)",
    meetingStatus: "ENDED",
    ...overrides,
  };
}

describe("classifySession", () => {
  it("recognizes both Wise cancellation spellings case-insensitively before future", () => {
    expect(classifySession({
      meetingStatus: "CANCELLED",
      sessionKind: "future",
      creditApplied: 0,
    })).toBe("cancelled");
    expect(classifySession({
      meetingStatus: "cAnCeLeD",
      sessionKind: "future",
      creditApplied: 0,
    })).toBe("cancelled");
  });

  it("classifies future and ended sessions with the prototype precedence", () => {
    expect(classifySession({
      meetingStatus: "SCHEDULED",
      sessionKind: "future",
      creditApplied: 0,
    })).toBe("upcoming");
    expect(classifySession({
      meetingStatus: "ENDED",
      sessionKind: "past",
      creditApplied: 1,
    })).toBe("attended");
    expect(classifySession({
      meetingStatus: "ENDED",
      sessionKind: "past",
      creditApplied: 0,
    })).toBe("ended-no-credit");
  });

  it("surfaces unknown and blank statuses fail-closed", () => {
    expect(classifySession({
      meetingStatus: "NO_SHOW",
      sessionKind: "past",
      creditApplied: 0,
    })).toBe("other:NO_SHOW");
    expect(classifySession({
      meetingStatus: "  ",
      sessionKind: "past",
      creditApplied: 0,
    })).toBe("other:(blank)");
  });
});

describe("buildClassRow", () => {
  it("falls back to TEACHER_TBC for null and whitespace-only teachers", () => {
    expect(buildClassRow(session({ teacherName: null })).teacher).toBe(TEACHER_TBC);
    expect(buildClassRow(session({ teacherName: "   " })).teacher).toBe(TEACHER_TBC);
  });

  it("derives modality and formats a Bangkok midnight rollover", () => {
    const row = buildClassRow(session({
      title: "In-Person Session-Biology HL",
      scheduledStartTime: new Date("2026-06-01T17:30:00.000Z"),
      teacherFeedback: "   ",
    }));

    expect(row).toMatchObject({
      classLabel: "Biology HL",
      modality: "onsite",
      dateKey: "2026-06-02",
      weekday: "Tue",
      startLabel: "00:30",
      hasFeedback: false,
    });
  });
});

describe("summarizeBuckets", () => {
  it("orders known buckets first, then other buckets alphabetically, and rounds hours", () => {
    const rows = [
      classRow({ wiseSessionId: "a1", durationMinutes: 50 }),
      classRow({ wiseSessionId: "a2", durationMinutes: 50 }),
      classRow({ wiseSessionId: "a3", durationMinutes: 50 }),
      classRow({ wiseSessionId: "u", bucket: "upcoming", creditApplied: 0 }),
      classRow({ wiseSessionId: "c", bucket: "cancelled", creditApplied: 0 }),
      classRow({ wiseSessionId: "e", bucket: "ended-no-credit", creditApplied: 0 }),
      classRow({ wiseSessionId: "z", bucket: "other:Z", creditApplied: 0 }),
      classRow({ wiseSessionId: "b", bucket: "other:A", creditApplied: 0 }),
    ];

    const totals = summarizeBuckets(rows);
    expect(totals.map((total) => total.bucket)).toEqual([
      "attended",
      "upcoming",
      "cancelled",
      "ended-no-credit",
      "other:A",
      "other:Z",
    ]);
    expect(totals[0]).toEqual({
      bucket: "attended",
      sessions: 3,
      hours: 2.5,
      credits: 3,
    });
  });
});

describe("summarizeAttended", () => {
  it("counts only attended rows and sorts each dimension by sessions then key", () => {
    const summaries = summarizeAttended([
      classRow({
        wiseSessionId: "1",
        classLabel: "Math",
        teacher: "Kru Zed",
        dateKey: "2026-05-10",
      }),
      classRow({
        wiseSessionId: "2",
        classLabel: "Math",
        teacher: "Kru Amy",
        dateKey: "2026-05-20",
      }),
      classRow({
        wiseSessionId: "3",
        classLabel: "Biology",
        teacher: "Kru Amy",
        dateKey: "2026-06-01",
        modality: "onsite",
      }),
      classRow({
        wiseSessionId: "4",
        bucket: "upcoming",
        classLabel: "Math",
        teacher: "Kru Amy",
        dateKey: "2026-05-21",
      }),
    ]);

    expect(summaries.filter((line) => line.dimension === "class")).toEqual([
      { dimension: "class", key: "Math", sessions: 2, hours: 2, credits: 2 },
      { dimension: "class", key: "Biology", sessions: 1, hours: 1, credits: 1 },
    ]);
    expect(summaries.filter((line) => line.dimension === "teacher").map((line) => line.key))
      .toEqual(["Kru Amy", "Kru Zed"]);
    expect(summaries.filter((line) => line.dimension === "month")).toEqual([
      { dimension: "month", key: "2026-05", sessions: 2, hours: 2, credits: 2 },
      { dimension: "month", key: "2026-06", sessions: 1, hours: 1, credits: 1 },
    ]);
  });
});

describe("buildParentReportPayload", () => {
  it("deduplicates by Wise session id and sorts the retained first rows chronologically", () => {
    const payload = buildParentReportPayload({
      snapshot: { id: "snapshot-1", generatedAt: new Date("2026-08-17T05:00:00.000Z") },
      window: resolveReportWindow("2026-05-01", "2026-08-17"),
      students: [STUDENT_A],
      sessionsByStudentId: new Map([[STUDENT_A.wiseStudentId, [
        session({
          wiseSessionId: "late",
          scheduledStartTime: new Date("2026-08-10T03:00:00.000Z"),
        }),
        session({
          wiseSessionId: "early",
          scheduledStartTime: new Date("2026-05-10T03:00:00.000Z"),
          packageName: "first retained",
        }),
        session({
          wiseSessionId: "early",
          scheduledStartTime: new Date("2026-04-01T03:00:00.000Z"),
          packageName: "duplicate dropped",
        }),
      ]]]),
      packagesByStudentId: new Map(),
      ledgerByStudentId: new Map(),
      generatedAt: new Date("2026-08-17T06:00:00.000Z"),
    });

    expect(payload.students[0].rows.map((row) => row.wiseSessionId)).toEqual(["early", "late"]);
    expect(payload.students[0].rows[0].packageName).toBe("first retained");
  });

  it("keeps requested student order, empty sections, combined totals, and bound warnings", () => {
    const payload = buildParentReportPayload({
      snapshot: { id: "snapshot-2", generatedAt: new Date("2026-08-17T05:00:00.000Z") },
      window: resolveReportWindow("2026-04-18", "2027-02-14"),
      students: [STUDENT_B, STUDENT_A],
      sessionsByStudentId: new Map([[STUDENT_A.wiseStudentId, [
        session({ wiseSessionId: "attended" }),
        session({
          wiseSessionId: "future",
          scheduledStartTime: new Date("2026-08-20T03:00:00.000Z"),
          meetingStatus: "SCHEDULED",
          sessionKind: "future",
          creditApplied: 0,
        }),
      ]]]),
      packagesByStudentId: new Map(),
      ledgerByStudentId: new Map([[STUDENT_A.wiseStudentId, { entries: 2, netCredit: -1 }]]),
      generatedAt: new Date("2026-08-17T06:00:00.000Z"),
    });

    expect(payload.students.map((section) => section.student.wiseStudentId)).toEqual([
      STUDENT_B.wiseStudentId,
      STUDENT_A.wiseStudentId,
    ]);
    expect(payload.students[0]).toMatchObject({
      rows: [],
      bucketTotals: [],
      summaries: [],
      packages: [],
      ledger: { entries: 0, netCredit: 0 },
    });
    expect(payload.students[1].ledger).toEqual({ entries: 2, netCredit: -1 });
    expect(payload.combined.bucketTotals.map((total) => total.bucket)).toEqual([
      "attended",
      "upcoming",
    ]);
    expect(payload.meta).toMatchObject({
      snapshotFloorDateKey: "2026-04-19",
      snapshotCeilingDateKey: "2027-02-13",
      floorWarning: true,
      ceilingWarning: true,
    });
  });
});
