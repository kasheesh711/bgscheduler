import { describe, expect, it } from "vitest";

import {
  CLASSES_CSV_COLUMNS,
  CREDITS_CSV_COLUMNS,
  SUMMARY_CSV_COLUMNS,
  flattenClassesForCsv,
  flattenCreditsForCsv,
  flattenSummaryForCsv,
  reportCsvFilename,
  serializeCsv,
} from "../csv";

import type { ParentReportPayload } from "../types";

function payloadFixture(): ParentReportPayload {
  return {
    meta: {
      snapshotId: "snapshot-1",
      snapshotGeneratedAt: "2026-08-17T05:00:00.000Z",
      generatedAt: "2026-08-17T06:00:00.000Z",
      window: {
        fromDateKey: "2026-05-15",
        toDateKey: "2026-08-17",
        startUtc: "2026-05-14T17:00:00.000Z",
        endUtc: "2026-08-17T17:00:00.000Z",
        label: "15 May – 17 Aug 2026",
      },
      snapshotFloorDateKey: "2026-04-19",
      snapshotCeilingDateKey: "2027-02-13",
      floorWarning: false,
      ceilingWarning: false,
    },
    combined: {
      bucketTotals: [
        { bucket: "attended", sessions: 1, hours: 1, credits: 1 },
      ],
    },
    students: [
      {
        student: {
          studentKey: "student::parent",
          wiseStudentId: "wise-student",
          studentName: "Student Name",
          parentName: "Parent Name",
          code: "Student.Code",
          shortName: "Student",
          activated: true,
        },
        rows: [
          {
            wiseSessionId: "wise-session",
            dateKey: "2026-06-01",
            weekday: "Mon",
            startLabel: "10:00",
            durationMinutes: 60,
            classLabel: "Math, Advanced",
            modality: "online",
            teacher: "Kru Mint",
            bucket: "attended",
            creditApplied: 1,
            feedback: {
              topics: "Fractions\nand decimals",
              performance: "Worked hard",
              improvement: "",
              homework: "Worksheet 3",
            },
            packageName: "Math package",
            subjectBand: "Y8-9",
            meetingStatus: "ENDED",
            source: "snapshot",
            timeApproximate: false,
          },
          {
            wiseSessionId: "wise-ledger",
            dateKey: "2026-04-17",
            weekday: "Fri",
            startLabel: "14:29",
            durationMinutes: 91,
            classLabel: "Y9-11",
            modality: "unknown",
            teacher: "Kevin (Kev) Y. Hsieh Online",
            bucket: "attended",
            creditApplied: 1.5,
            feedback: null,
            packageName: "Math package",
            subjectBand: "Y9-11",
            meetingStatus: "ENDED",
            source: "ledger",
            timeApproximate: true,
          },
        ],
        bucketTotals: [
          { bucket: "attended", sessions: 1, hours: 1, credits: 1 },
        ],
        summaries: [
          { dimension: "class", key: "Math, Advanced", sessions: 1, hours: 1, credits: 1 },
          { dimension: "teacher", key: "Kru Mint", sessions: 1, hours: 1, credits: 1 },
        ],
        packages: [
          {
            packageName: "Math package",
            subject: "",
            classType: null,
            totalCredits: 10.126,
            consumedCredits: 4.124,
            remainingCredits: 6.002,
            availableCredits: 5.555,
            bookedSessions: 2.004,
            excludedReason: null,
          },
        ],
        ledger: { entries: 1, netCredit: -1 },
      },
    ],
  };
}

describe("CSV columns", () => {
  it("emits the exact classes header", () => {
    expect(serializeCsv([], CLASSES_CSV_COLUMNS, { includeBom: false })).toBe(
      '"Student","Date","Day","Time","Mins","Class","Mode","Teacher","Status","Credit","Feedback","Topics","Performance","Needs work","Homework","Package","Level band","Wise session id","Source"',
    );
  });

  it("emits the exact summary header", () => {
    expect(serializeCsv([], SUMMARY_CSV_COLUMNS, { includeBom: false })).toBe(
      '"Student","Dimension","Key","Sessions","Hours","Credits"',
    );
  });

  it("emits the exact credits header", () => {
    expect(serializeCsv([], CREDITS_CSV_COLUMNS, { includeBom: false })).toBe(
      '"Student","Package","Subject","Type","Total","Consumed","Remaining","Available","Booked","Excluded"',
    );
  });
});

describe("CSV flattening", () => {
  it("emits one row per class and relies on the shared serializer for commas", () => {
    const rows = flattenClassesForCsv(payloadFixture());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      studentLabel: "Student.Code",
      classLabel: "Math, Advanced",
      bucket: "attended",
      feedback: { performance: "Worked hard" },
      source: "snapshot",
    });
    expect(rows[1]).toMatchObject({ source: "ledger", feedback: null });

    const csv = serializeCsv(rows, CLASSES_CSV_COLUMNS, { includeBom: false });
    expect(csv).toContain('"Math, Advanced"');
    expect(csv).toContain('"yes"');
    expect(csv).toContain('"ledger"');
    // Interior newlines survive inside one quoted Topics field.
    expect(csv).toContain('"Fractions\nand decimals"');
    // The feedback-less ledger row emits "no" plus four empty text cells.
    expect(csv).toContain('"no","","","",""');
  });

  it("emits status totals and every attended summary line per student", () => {
    const rows = flattenSummaryForCsv(payloadFixture());
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => [row.dimension, row.key])).toEqual([
      ["status", "attended"],
      ["class", "Math, Advanced"],
      ["teacher", "Kru Mint"],
    ]);
  });

  it("emits one rounded row per package with prototype fallbacks", () => {
    expect(flattenCreditsForCsv(payloadFixture())).toEqual([
      {
        studentLabel: "Student.Code",
        packageName: "Math package",
        subject: "(none)",
        classType: "(none)",
        total: 10.13,
        consumed: 4.12,
        remaining: 6,
        available: 5.56,
        booked: 2,
        excluded: "",
      },
    ]);
  });
});

describe("reportCsvFilename", () => {
  it("uses the report sheet and date range in a sanitized filename", () => {
    const payload = payloadFixture();
    expect(reportCsvFilename(payload, "classes")).toBe(
      "begifted-class-report-classes-2026-05-15-to-2026-08-17.csv",
    );

    payload.meta.window.fromDateKey = "2026/05/15";
    expect(reportCsvFilename(payload, "summary")).toBe(
      "begifted-class-report-summary-2026-05-15-to-2026-08-17.csv",
    );
  });
});
