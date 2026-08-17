import { sanitizeCsvFilename } from "@/lib/sales-dashboard/csv";

import type { CsvColumn } from "@/lib/sales-dashboard/csv";
import type { ParentReportPayload, ReportClassRow } from "./types";

export { serializeCsv } from "@/lib/sales-dashboard/csv";

export interface ClassesCsvRow extends ReportClassRow {
  studentLabel: string;
}

export const CLASSES_CSV_COLUMNS: CsvColumn<ClassesCsvRow>[] = [
  { key: "studentLabel", header: "Student", value: (row) => row.studentLabel },
  { key: "dateKey", header: "Date", value: (row) => row.dateKey },
  { key: "weekday", header: "Day", value: (row) => row.weekday },
  { key: "startLabel", header: "Time", value: (row) => row.startLabel },
  { key: "durationMinutes", header: "Mins", value: (row) => row.durationMinutes },
  { key: "classLabel", header: "Class", value: (row) => row.classLabel },
  { key: "modality", header: "Mode", value: (row) => row.modality },
  { key: "teacher", header: "Teacher", value: (row) => row.teacher },
  { key: "bucket", header: "Status", value: (row) => row.bucket },
  { key: "creditApplied", header: "Credit", value: (row) => row.creditApplied },
  { key: "hasFeedback", header: "Feedback", value: (row) => row.hasFeedback ? "yes" : "no" },
  { key: "packageName", header: "Package", value: (row) => row.packageName },
  { key: "subjectBand", header: "Level band", value: (row) => row.subjectBand },
  { key: "wiseSessionId", header: "Wise session id", value: (row) => row.wiseSessionId },
];

export interface SummaryCsvRow {
  studentLabel: string;
  dimension: string;
  key: string;
  sessions: number;
  hours: number;
  credits: number;
}

export const SUMMARY_CSV_COLUMNS: CsvColumn<SummaryCsvRow>[] = [
  { key: "studentLabel", header: "Student", value: (row) => row.studentLabel },
  { key: "dimension", header: "Dimension", value: (row) => row.dimension },
  { key: "key", header: "Key", value: (row) => row.key },
  { key: "sessions", header: "Sessions", value: (row) => row.sessions },
  { key: "hours", header: "Hours", value: (row) => row.hours },
  { key: "credits", header: "Credits", value: (row) => row.credits },
];

export interface CreditsCsvRow {
  studentLabel: string;
  packageName: string;
  subject: string;
  classType: string;
  total: number;
  consumed: number;
  remaining: number;
  available: number;
  booked: number;
  excluded: string;
}

export const CREDITS_CSV_COLUMNS: CsvColumn<CreditsCsvRow>[] = [
  { key: "studentLabel", header: "Student", value: (row) => row.studentLabel },
  { key: "packageName", header: "Package", value: (row) => row.packageName },
  { key: "subject", header: "Subject", value: (row) => row.subject },
  { key: "classType", header: "Type", value: (row) => row.classType },
  { key: "total", header: "Total", value: (row) => row.total },
  { key: "consumed", header: "Consumed", value: (row) => row.consumed },
  { key: "remaining", header: "Remaining", value: (row) => row.remaining },
  { key: "available", header: "Available", value: (row) => row.available },
  { key: "booked", header: "Booked", value: (row) => row.booked },
  { key: "excluded", header: "Excluded", value: (row) => row.excluded },
];

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function studentLabel(payload: ParentReportPayload, sectionIndex: number): string {
  const student = payload.students[sectionIndex].student;
  return student.code ?? student.studentName;
}

/** Flattens all per-student class rows in payload order for the classes CSV. */
export function flattenClassesForCsv(payload: ParentReportPayload): ClassesCsvRow[] {
  return payload.students.flatMap((section, sectionIndex) => {
    const label = studentLabel(payload, sectionIndex);
    return section.rows.map((row) => ({ studentLabel: label, ...row }));
  });
}

/**
 * Flattens status totals followed by attended summaries for each student.
 * This preserves the prototype summary table's per-student grain and order.
 */
export function flattenSummaryForCsv(payload: ParentReportPayload): SummaryCsvRow[] {
  return payload.students.flatMap((section, sectionIndex) => {
    const label = studentLabel(payload, sectionIndex);
    return [
      ...section.bucketTotals.map((total) => ({
        studentLabel: label,
        dimension: "status",
        key: total.bucket,
        sessions: total.sessions,
        hours: total.hours,
        credits: total.credits,
      })),
      ...section.summaries.map((summary) => ({
        studentLabel: label,
        dimension: summary.dimension,
        key: summary.key,
        sessions: summary.sessions,
        hours: summary.hours,
        credits: summary.credits,
      })),
    ];
  });
}

/** Flattens point-in-time package balances for the credits CSV. */
export function flattenCreditsForCsv(payload: ParentReportPayload): CreditsCsvRow[] {
  return payload.students.flatMap((section, sectionIndex) => {
    const label = studentLabel(payload, sectionIndex);
    return section.packages.map((pkg) => ({
      studentLabel: label,
      packageName: pkg.packageName,
      subject: pkg.subject || "(none)",
      classType: pkg.classType ?? "(none)",
      total: round2(pkg.totalCredits),
      consumed: round2(pkg.consumedCredits),
      remaining: round2(pkg.remainingCredits),
      available: round2(pkg.availableCredits),
      booked: round2(pkg.bookedSessions),
      excluded: pkg.excludedReason ?? "",
    }));
  });
}

/** Builds a sanitized report filename for one CSV sheet and date window. */
export function reportCsvFilename(
  payload: ParentReportPayload,
  sheet: "classes" | "summary" | "credits",
): string {
  const { fromDateKey, toDateKey } = payload.meta.window;
  return sanitizeCsvFilename(
    `begifted-class-report-${sheet}-${fromDateKey}-to-${toDateKey}.csv`,
  );
}
