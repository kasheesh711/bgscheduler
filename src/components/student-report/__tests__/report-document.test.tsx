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
    feedback: null,
    packageName: "Mathematics package",
    subjectBand: "Y8-9 / G7-8 (Int.)",
    meetingStatus: "ENDED",
    source: "snapshot",
    timeApproximate: false,
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
        classRow({
          feedback: {
            topics: "Quadratic factorisation",
            performance: "Focused well\nAsked good questions",
            improvement: "Word problems",
            homework: "",
          },
        }),
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
          meetingStatus: "SCHEDULED",
        }),
        classRow({
          wiseSessionId: "session-cancelled",
          dateKey: "2026-07-10",
          weekday: "Fri",
          bucket: "cancelled",
          creditApplied: 0,
          meetingStatus: "CANCELLED",
        }),
        classRow({
          wiseSessionId: "session-no-show",
          dateKey: "2026-07-17",
          weekday: "Fri",
          teacher: TEACHER_TBC,
          bucket: "other:NO_SHOW",
          creditApplied: 0,
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
      "This statement window extends beyond the session records held";

    expect(render()).toContain(warningText);
    expect(render()).toContain("Classes outside that range are not shown.");

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

  it("marks ledger-backfilled rows and explains them in the warning and footnote", () => {
    const ledgerPayload: ParentReportPayload = {
      ...PAYLOAD,
      students: [
        {
          ...PAYLOAD.students[0],
          rows: [
            classRow({
              wiseSessionId: "session-ledger",
              dateKey: "2026-04-17",
              startLabel: "14:29",
              source: "ledger",
              timeApproximate: true,
            }),
            ...PAYLOAD.students[0].rows,
          ],
        },
      ],
    };

    const html = render(ledgerPayload);
    expect(html).toContain("14:29 †");
    expect(html).toContain("Reconstructed from the billing ledger");
    expect(html).toContain("reconstructed from the billing ledger and marked");
    expect(html).not.toContain("Classes outside that range are not shown.");
  });

  it("footnotes fractional package balances only when one exists", () => {
    const footnote = "Fractional balances mirror pro-rated credit top-ups";
    expect(render()).not.toContain(footnote);

    const fractionalPayload: ParentReportPayload = {
      ...PAYLOAD,
      students: [
        {
          ...PAYLOAD.students[0],
          packages: [
            {
              ...PAYLOAD.students[0].packages[0],
              remainingCredits: 2.6900000000000004,
            },
          ],
        },
      ],
    };
    expect(render(fractionalPayload)).toContain(footnote);
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

  it("shows exactly one credits-used card per student and no other stat cards", () => {
    const html = render();

    expect(html).not.toContain('data-testid="combined-stat-tiles"');
    expect(html.match(/Credits used/g)).toHaveLength(2);
    expect(html).toMatch(/<p[^>]*>1<\/p><p[^>]*>Credits used<\/p>/);
    expect(html).not.toContain("Attended classes");
    expect(html).not.toContain("Hours attended");
    expect(html).not.toContain("Upcoming classes");
  });

  it("summarizes by teacher only", () => {
    const html = render();

    expect(html).toContain("Summary by teacher");
    expect(html).not.toContain("Summary by class &amp; teacher");
    const summaryStart = html.indexOf("Summary by teacher");
    const summaryMarkup = html.slice(summaryStart, html.indexOf("Package balances"));
    expect(summaryMarkup).toContain("Kru Mint");
    expect(summaryMarkup).not.toContain("2026-07");
    expect(summaryMarkup).not.toContain("modality");
    expect(summaryMarkup).not.toContain("Dimension");
  });

  it("omits the minutes column from the class table", () => {
    const html = render();

    expect(html).not.toContain(">Mins<");
    expect(html).toContain("Total · 4 sessions");
  });

  it("renders one feedback sub-row per feedback-bearing class row", () => {
    const html = render();

    expect(html.match(/data-testid="class-feedback-row"/g)).toHaveLength(1);
    expect(html.match(/data-feedback-parent/g)).toHaveLength(1);
    expect(html).toContain("whitespace-pre-wrap");
    expect(html).toContain("Quadratic factorisation");
    // Interior newline reaches the markup for pre-wrap rendering.
    expect(html).toContain("Focused well\nAsked good questions");
  });

  it("labels feedback fields and skips blank ones", () => {
    const html = render();

    expect(html).toContain("Topics:");
    expect(html).toContain("Performance:");
    expect(html).toContain("Needs work:");
    // Homework is blank on the only feedback-bearing row, so its label is
    // omitted entirely.
    expect(html).not.toContain("Homework:");
  });

  it("renders no feedback rows when every row's feedback is null", () => {
    const bare: ParentReportPayload = {
      ...PAYLOAD,
      students: [
        {
          ...PAYLOAD.students[0],
          rows: PAYLOAD.students[0].rows.map((row) => ({
            ...row,
            feedback: null,
          })),
        },
      ],
    };

    const html = render(bare);
    expect(html).not.toContain("class-feedback-row");
    expect(html).not.toContain("data-feedback-parent");
  });

  it("renders feedback on a ledger-backfilled row alongside its dagger", () => {
    const ledgerPayload: ParentReportPayload = {
      ...PAYLOAD,
      students: [
        {
          ...PAYLOAD.students[0],
          rows: [
            classRow({
              wiseSessionId: "session-ledger",
              dateKey: "2026-04-17",
              startLabel: "14:29",
              source: "ledger",
              timeApproximate: true,
              feedback: {
                topics: "Algebra review",
                performance: "",
                improvement: "",
                homework: "",
              },
            }),
          ],
        },
      ],
    };

    const html = render(ledgerPayload);
    expect(html).toContain("14:29 †");
    expect(html).toContain("Algebra review");
    expect(html.match(/data-testid="class-feedback-row"/g)).toHaveLength(1);
  });
});
