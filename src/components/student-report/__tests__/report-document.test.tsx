import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ReportDocument } from "../report-document";
import { TEACHER_TBC } from "@/lib/student-schedule/types";

import type {
  ParentReportPayload,
  ReportClassRow,
} from "@/lib/student-report/types";

function classRow(overrides: Partial<ReportClassRow> = {}): ReportClassRow {
  return {
    wiseSessionId: "session-attended",
    dateKey: "2026-07-03",
    weekday: "Fri",
    startLabel: "16:00",
    durationMinutes: 90,
    classLabel: "Mathematics",
    modality: "onsite",
    teacher: "Kru Mint",
    bucket: "attended",
    creditApplied: 1,
    hasFeedback: true,
    packageName: "Mathematics package",
    subjectBand: "Y8-9 / G7-8 (Int.)",
    meetingStatus: "ENDED",
    ...overrides,
  };
}

const PAYLOAD: ParentReportPayload = {
  meta: {
    snapshotId: "snapshot-12345678",
    snapshotGeneratedAt: "2026-08-17T05:00:00.000Z",
    generatedAt: "2026-08-17T06:00:00.000Z",
    window: {
      fromDateKey: "2026-04-01",
      toDateKey: "2026-08-31",
      startUtc: "2026-03-31T17:00:00.000Z",
      endUtc: "2026-08-31T17:00:00.000Z",
      label: "1/4/2026 – 31/8/2026",
    },
    snapshotFloorDateKey: "2026-04-19",
    snapshotCeilingDateKey: "2027-02-13",
    floorWarning: true,
    ceilingWarning: false,
  },
  combined: {
    bucketTotals: [
      { bucket: "attended", sessions: 1, hours: 1.5, credits: 1 },
      { bucket: "upcoming", sessions: 1, hours: 1, credits: 0 },
      { bucket: "cancelled", sessions: 1, hours: 1, credits: 0 },
      { bucket: "other:NO_SHOW", sessions: 1, hours: 1, credits: 0 },
    ],
  },
  students: [
    {
      student: {
        studentKey: "mali::parent-one",
        wiseStudentId: "student-one",
        studentName: "Mali Srisuk",
        parentName: "Parent One",
        code: "MALI-01",
        shortName: "Mali",
        activated: true,
      },
      rows: [
        classRow(),
        classRow({
          wiseSessionId: "session-upcoming",
          dateKey: "2026-08-20",
          weekday: "Thu",
          startLabel: "17:30",
          durationMinutes: 60,
          classLabel: "Physics",
          modality: "online",
          bucket: "upcoming",
          creditApplied: 0,
          hasFeedback: false,
          meetingStatus: "SCHEDULED",
        }),
        classRow({
          wiseSessionId: "session-cancelled",
          dateKey: "2026-07-10",
          weekday: "Fri",
          bucket: "cancelled",
          creditApplied: 0,
          hasFeedback: false,
          meetingStatus: "CANCELLED",
        }),
        classRow({
          wiseSessionId: "session-no-show",
          dateKey: "2026-07-17",
          weekday: "Fri",
          teacher: TEACHER_TBC,
          bucket: "other:NO_SHOW",
          creditApplied: 0,
          hasFeedback: false,
          meetingStatus: "NO_SHOW",
        }),
      ],
      bucketTotals: [
        { bucket: "attended", sessions: 1, hours: 1.5, credits: 1 },
        { bucket: "upcoming", sessions: 1, hours: 1, credits: 0 },
        { bucket: "cancelled", sessions: 1, hours: 1, credits: 0 },
        { bucket: "other:NO_SHOW", sessions: 1, hours: 1, credits: 0 },
      ],
      summaries: [
        {
          dimension: "class",
          key: "Mathematics",
          sessions: 1,
          hours: 1.5,
          credits: 1,
        },
        {
          dimension: "teacher",
          key: "Kru Mint",
          sessions: 1,
          hours: 1.5,
          credits: 1,
        },
        {
          dimension: "month",
          key: "2026-07",
          sessions: 1,
          hours: 1.5,
          credits: 1,
        },
        {
          dimension: "modality",
          key: "onsite",
          sessions: 1,
          hours: 1.5,
          credits: 1,
        },
      ],
      packages: [
        {
          packageName: "Mathematics package",
          subject: "Mathematics",
          classType: "Private",
          totalCredits: 20,
          consumedCredits: 8,
          remainingCredits: 12,
          availableCredits: 10,
          bookedSessions: 2,
          excludedReason: null,
        },
      ],
      ledger: { entries: 4, netCredit: -1 },
    },
    {
      student: {
        studentKey: "noi::parent-two",
        wiseStudentId: "student-two",
        studentName: "Noi Chai",
        parentName: "Parent Two",
        code: null,
        shortName: "Noi",
        activated: true,
      },
      rows: [],
      bucketTotals: [],
      summaries: [],
      packages: [],
      ledger: { entries: 0, netCredit: 0 },
    },
  ],
};

function render(payload: ParentReportPayload = PAYLOAD): string {
  return renderToStaticMarkup(<ReportDocument payload={payload} />);
}

describe("ReportDocument", () => {
  it("renders a data-range warning only when a window warning is set", () => {
    const warningText =
      "This statement window extends beyond the data held for this period";

    expect(render()).toContain(warningText);

    const clearPayload: ParentReportPayload = {
      ...PAYLOAD,
      meta: {
        ...PAYLOAD.meta,
        floorWarning: false,
        ceilingWarning: false,
      },
    };
    expect(render(clearPayload)).not.toContain(warningText);
  });

  it("preserves unknown statuses and unresolved teachers verbatim", () => {
    const html = render();

    expect(html).toContain("other:NO_SHOW");
    expect(html).toContain(TEACHER_TBC);
  });

  it("renders both students and an explicit empty state for zero rows", () => {
    const html = render();

    expect(html.match(/data-testid="student-report-section"/g)).toHaveLength(2);
    expect(html).toContain("Mali Srisuk");
    expect(html).toContain("Noi Chai");
    expect(html.slice(html.indexOf("Noi Chai"))).toContain(
      "No rows in this period.",
    );
  });

  it("labels package balances as point-in-time data", () => {
    expect(render()).toContain("Package balances — as of");
  });

  it("shows the combined attended-session count in the overview tile", () => {
    const html = render();
    const combinedStart = html.indexOf('data-testid="combined-stat-tiles"');
    const firstStudent = html.indexOf('data-testid="student-report-section"');
    const combinedMarkup = html.slice(combinedStart, firstStudent);

    expect(combinedMarkup).toMatch(
      /<p[^>]*>1<\/p><p[^>]*>Attended classes<\/p>/,
    );
  });
});
