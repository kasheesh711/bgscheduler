import { describe, expect, it } from "vitest";

import { TEACHER_TBC } from "@/lib/student-schedule/types";
import {
  buildClassRow,
  buildLedgerClassRow,
  buildParentReportPayload,
  classifySession,
  collectFeedbackWiseSessionIds,
  isLedgerClassCandidate,
  normalizeReportFeedback,
  packageMetaKey,
  summarizeAttended,
  summarizeBuckets,
} from "../build";
import { resolveReportWindow } from "../window";

import type { ReportLedgerEntryInput, ReportSessionInput } from "../build";
import type { ReportClassFeedback, ReportClassRow, ReportStudent } from "../types";

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
    ...overrides,
  };
}

function feedback(overrides: Partial<ReportClassFeedback> = {}): ReportClassFeedback {
  return {
    topics: "Fractions",
    performance: "Worked hard",
    improvement: "Times tables",
    homework: "Worksheet 3",
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
    feedback: null,
    packageName: "Math package",
    subjectBand: "Y8-9 / G7-8 (Int.)",
    meetingStatus: "ENDED",
    source: "snapshot",
    timeApproximate: false,
    ...overrides,
  };
}

function ledgerEntry(
  overrides: Partial<ReportLedgerEntryInput> = {},
): ReportLedgerEntryInput {
  return {
    wiseCreditHistoryId: "ledger-1",
    wiseStudentId: STUDENT_A.wiseStudentId,
    wiseClassId: "class-1",
    credit: 1.5,
    type: "SESSION",
    meetingStatus: "ENDED",
    durationMinutes: 91,
    createdAtWise: new Date("2026-04-17T07:29:49.473Z"),
    rawTeacherName: "Kevin (Kev) Y. Hsieh Online",
    rawClassroomSubject: "Y9-11 / G8-10 (Int.)",
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
    expect(buildClassRow(session({ teacherName: null }), null).teacher).toBe(TEACHER_TBC);
    expect(buildClassRow(session({ teacherName: "   " }), null).teacher).toBe(TEACHER_TBC);
  });

  it("derives modality and formats a Bangkok midnight rollover", () => {
    const row = buildClassRow(session({
      title: "In-Person Session-Biology HL",
      scheduledStartTime: new Date("2026-06-01T17:30:00.000Z"),
    }), null);

    expect(row).toMatchObject({
      classLabel: "Biology HL",
      modality: "onsite",
      dateKey: "2026-06-02",
      weekday: "Tue",
      startLabel: "00:30",
      feedback: null,
    });
  });

  it("carries the provided feedback through unchanged", () => {
    expect(buildClassRow(session(), feedback()).feedback).toEqual(feedback());
  });
});

describe("normalizeReportFeedback", () => {
  it("trims outer whitespace per field while keeping interior newlines", () => {
    expect(normalizeReportFeedback(feedback({
      performance: "  Line one\nLine two  ",
      homework: "\n",
    }))).toEqual(feedback({
      performance: "Line one\nLine two",
      homework: "",
    }));
  });

  it("collapses undefined and all-blank records to null", () => {
    expect(normalizeReportFeedback(undefined)).toBeNull();
    expect(normalizeReportFeedback({
      topics: "  ",
      performance: "",
      improvement: "\n\n",
      homework: " ",
    })).toBeNull();
  });

  it("keeps a record with a single non-blank field", () => {
    expect(normalizeReportFeedback({
      topics: "",
      performance: "",
      improvement: "",
      homework: "Read chapter 4",
    })).toEqual({
      topics: "",
      performance: "",
      improvement: "",
      homework: "Read chapter 4",
    });
  });
});

describe("collectFeedbackWiseSessionIds", () => {
  it("unions snapshot session ids with ledger class candidates, deduplicated", () => {
    expect(collectFeedbackWiseSessionIds(
      [session({ wiseSessionId: "s1" }), session({ wiseSessionId: "shared" })],
      [
        ledgerEntry({ wiseCreditHistoryId: "shared" }),
        ledgerEntry({ wiseCreditHistoryId: "pre-floor" }),
        ledgerEntry({ wiseCreditHistoryId: "topup", type: "CREDIT", meetingStatus: null }),
        ledgerEntry({ wiseCreditHistoryId: "unplaced", createdAtWise: null }),
        ledgerEntry({ wiseCreditHistoryId: "cancelled", meetingStatus: "CANCELLED" }),
      ],
    )).toEqual(["s1", "shared", "pre-floor"]);
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
      ledgerEntriesByStudentId: new Map(),
      packageMetaByClassKey: new Map(),
      feedbackByWiseSessionId: new Map(),
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
      ledgerEntriesByStudentId: new Map([[STUDENT_A.wiseStudentId, [
        ledgerEntry({ wiseCreditHistoryId: "topup", type: "CREDIT", meetingStatus: null, credit: 0.5 }),
        ledgerEntry({ wiseCreditHistoryId: "spend", type: "CREDIT", meetingStatus: null, credit: -1.5 }),
      ]]]),
      packageMetaByClassKey: new Map(),
      feedbackByWiseSessionId: new Map(),
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

  it("backfills a class row from a ledger charge the snapshot no longer holds", () => {
    const payload = buildParentReportPayload({
      snapshot: { id: "snapshot-3", generatedAt: new Date("2026-08-17T05:00:00.000Z") },
      window: resolveReportWindow("2026-04-01", "2026-08-17"),
      students: [STUDENT_A],
      sessionsByStudentId: new Map([[STUDENT_A.wiseStudentId, [
        session({
          wiseSessionId: "kevin-2",
          title: "Live Session - Math",
          teacherName: "Kevin (Kev) Y. Hsieh Online",
          scheduledStartTime: new Date("2026-04-24T07:30:00.000Z"),
          creditApplied: 1.5,
        }),
      ]]]),
      packagesByStudentId: new Map(),
      ledgerEntriesByStudentId: new Map([[STUDENT_A.wiseStudentId, [
        // Matches the snapshot session above — must NOT duplicate.
        ledgerEntry({ wiseCreditHistoryId: "kevin-2", createdAtWise: new Date("2026-04-24T07:33:00.000Z") }),
        // Pre-floor charge with no session row — must be synthesized.
        ledgerEntry({ wiseCreditHistoryId: "kevin-1" }),
      ]]]),
      packageMetaByClassKey: new Map(),
      feedbackByWiseSessionId: new Map(),
      generatedAt: new Date("2026-08-17T06:00:00.000Z"),
    });

    const rows = payload.students[0].rows;
    expect(rows.map((row) => row.wiseSessionId)).toEqual(["kevin-1", "kevin-2"]);
    expect(rows[0]).toMatchObject({
      source: "ledger",
      timeApproximate: true,
      dateKey: "2026-04-17",
      weekday: "Fri",
      startLabel: "14:29",
      durationMinutes: 91,
      teacher: "Kevin (Kev) Y. Hsieh Online",
      classLabel: "Y9-11 / G8-10 (Int.)",
      modality: "unknown",
      bucket: "attended",
      creditApplied: 1.5,
    });
    expect(rows[1]).toMatchObject({ source: "snapshot", timeApproximate: false });

    const teacherLine = payload.students[0].summaries.find(
      (line) => line.dimension === "teacher" && line.key === "Kevin (Kev) Y. Hsieh Online",
    );
    expect(teacherLine).toMatchObject({ sessions: 2, credits: 3 });
    expect(payload.students[0].ledger).toEqual({ entries: 2, netCredit: 3 });
  });

  it("labels ledger rows from the package pair and falls back to TEACHER_TBC", () => {
    const payload = buildParentReportPayload({
      snapshot: { id: "snapshot-4", generatedAt: new Date("2026-08-17T05:00:00.000Z") },
      window: resolveReportWindow("2026-04-01", "2026-08-17"),
      students: [STUDENT_A],
      sessionsByStudentId: new Map(),
      packagesByStudentId: new Map(),
      ledgerEntriesByStudentId: new Map([[STUDENT_A.wiseStudentId, [
        ledgerEntry({ rawTeacherName: null, rawClassroomSubject: null }),
      ]]]),
      packageMetaByClassKey: new Map([[
        packageMetaKey(STUDENT_A.wiseStudentId, "class-1"),
        { packageName: "Package name", subject: "Y9-11 / G8-10 (Int.)" },
      ]]),
      feedbackByWiseSessionId: new Map(),
      generatedAt: new Date("2026-08-17T06:00:00.000Z"),
    });

    expect(payload.students[0].rows[0]).toMatchObject({
      teacher: TEACHER_TBC,
      classLabel: "Y9-11 / G8-10 (Int.)",
      packageName: "Package name",
    });
  });

  it("attaches normalized feedback to snapshot and ledger rows by session id", () => {
    const payload = buildParentReportPayload({
      snapshot: { id: "snapshot-5", generatedAt: new Date("2026-08-17T05:00:00.000Z") },
      window: resolveReportWindow("2026-04-01", "2026-08-17"),
      students: [STUDENT_A, STUDENT_B],
      sessionsByStudentId: new Map([
        [STUDENT_A.wiseStudentId, [
          session({ wiseSessionId: "with-feedback" }),
          session({
            wiseSessionId: "without-feedback",
            scheduledStartTime: new Date("2026-06-02T03:00:00.000Z"),
          }),
        ]],
        // Group class: the sibling holds the same Wise session and must
        // receive the same feedback.
        [STUDENT_B.wiseStudentId, [
          session({
            wiseSessionId: "with-feedback",
            wiseStudentId: STUDENT_B.wiseStudentId,
            studentKey: STUDENT_B.studentKey,
          }),
        ]],
      ]),
      packagesByStudentId: new Map(),
      ledgerEntriesByStudentId: new Map([[STUDENT_A.wiseStudentId, [
        ledgerEntry({ wiseCreditHistoryId: "pre-floor" }),
      ]]]),
      packageMetaByClassKey: new Map(),
      feedbackByWiseSessionId: new Map([
        ["with-feedback", feedback({ performance: "  Focused all class  " })],
        ["pre-floor", feedback({ topics: "Algebra review" })],
        ["all-blank", feedback({ topics: " ", performance: "", improvement: "", homework: "" })],
      ]),
      generatedAt: new Date("2026-08-17T06:00:00.000Z"),
    });

    const [ledgerRow, fedRow, bareRow] = payload.students[0].rows;
    expect(ledgerRow).toMatchObject({
      source: "ledger",
      feedback: feedback({ topics: "Algebra review" }),
    });
    expect(fedRow.feedback).toEqual(feedback({ performance: "Focused all class" }));
    expect(bareRow.feedback).toBeNull();
    expect(payload.students[1].rows[0].feedback).toEqual(
      feedback({ performance: "Focused all class" }),
    );
  });

  it("leaves every row's feedback null when the lookup map is empty", () => {
    const payload = buildParentReportPayload({
      snapshot: { id: "snapshot-6", generatedAt: new Date("2026-08-17T05:00:00.000Z") },
      window: resolveReportWindow("2026-04-01", "2026-08-17"),
      students: [STUDENT_A],
      sessionsByStudentId: new Map([[STUDENT_A.wiseStudentId, [session()]]]),
      packagesByStudentId: new Map(),
      ledgerEntriesByStudentId: new Map([[STUDENT_A.wiseStudentId, [
        ledgerEntry({ wiseCreditHistoryId: "pre-floor" }),
      ]]]),
      packageMetaByClassKey: new Map(),
      feedbackByWiseSessionId: new Map(),
      generatedAt: new Date("2026-08-17T06:00:00.000Z"),
    });

    expect(payload.students[0].rows).toHaveLength(2);
    for (const row of payload.students[0].rows) {
      expect(row.feedback).toBeNull();
    }
  });
});

describe("isLedgerClassCandidate", () => {
  it("accepts only placeable SESSION charges and skips cancellations", () => {
    expect(isLedgerClassCandidate(ledgerEntry())).toBe(true);
    expect(isLedgerClassCandidate(ledgerEntry({ type: "CREDIT", meetingStatus: null }))).toBe(false);
    expect(isLedgerClassCandidate(ledgerEntry({ type: null }))).toBe(false);
    expect(isLedgerClassCandidate(ledgerEntry({ createdAtWise: null }))).toBe(false);
    expect(isLedgerClassCandidate(ledgerEntry({ meetingStatus: "CANCELLED" }))).toBe(false);
    expect(isLedgerClassCandidate(ledgerEntry({ meetingStatus: "canceled" }))).toBe(false);
  });
});

describe("buildLedgerClassRow", () => {
  it("keeps unknown ledger statuses fail-closed and never invents feedback", () => {
    const row = buildLedgerClassRow(
      ledgerEntry({ meetingStatus: "MISSED" }) as ReportLedgerEntryInput & { createdAtWise: Date },
      undefined,
      null,
    );
    expect(row).toMatchObject({
      bucket: "other:MISSED",
      feedback: null,
      modality: "unknown",
      source: "ledger",
    });
  });

  it("carries the provided feedback through unchanged", () => {
    const row = buildLedgerClassRow(
      ledgerEntry() as ReportLedgerEntryInput & { createdAtWise: Date },
      undefined,
      feedback(),
    );
    expect(row.feedback).toEqual(feedback());
  });
});
