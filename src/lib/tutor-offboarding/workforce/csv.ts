import type { WorkforceExportSection, WorkforceMetric, WorkforceReport, WorkforceUtilizationMetrics } from "./types";

const metrics: Array<keyof WorkforceUtilizationMetrics> = [
  "uniqueStudents", "studentBookings", "distinctClasses", "bookedHours", "cancelledBookings", "noShowBookings",
  "creditConsumedHours", "recordedTeachingHours", "qualifiedPeople", "offeredHours", "leaveHours", "usableHours",
  "reservedHours", "freeHours", "outsideHours", "overlapHours", "coverageHours", "expectedCoverageHours", "coveragePercent",
  "utilizationReservedHours", "utilizationCreditConsumedHours", "utilizationRecordedTeachingHours",
  "reservedUtilizationPercent", "consumedUtilizationPercent", "recordedTeachingUtilizationPercent",
];
const rosterMetrics = ["openingRosterCount", "closingRosterCount", "joinsCount", "departuresCount", "pendingCount", "turnoverPercent"];
const labels: Record<WorkforceExportSection, string[]> = {
  months: ["month", "partialMonth"],
  subjects: ["key", "month", "subject", "curriculum", "level", "depth", "modality"],
  week: ["key", "month", "weekday", "startMinute", "endMinute", "coveredDates", "calendarOccurrences", "subject", "curriculum", "level", "modality"],
  people: ["canonicalKey", "displayName", "role", "rosterState", "joinedAt", "departedAt", "pendingDeparture"],
};

function cell(value: unknown): string {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : '""';
  let text = value == null ? "" : String(value);
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

/** Exports the selected report rows, including the exact completeness state for every metric. */
export function serializeWorkforceCsv(report: WorkforceReport, section: WorkforceExportSection): string {
  const commonHeaders = ["report_revision", "generated_at", "from", "to", "selected_month", "role_filter", "subject_filter", "curriculum_filter", "level_filter", "modality_filter", "source_status", "source_issues"];
  const commonValues = [report.reportRevision, report.generatedAt, report.query.from, report.query.to, report.query.viewMonth,
    report.query.role, report.query.subject, report.query.curriculum, report.query.level, report.query.modality,
    report.quality.completeness, report.quality.issueCodes.join("|")];
  const rowMetrics = [...metrics, ...(section === "months" ? rosterMetrics : [])];
  const header = [...commonHeaders, ...labels[section], ...rowMetrics.flatMap(key => [`${key}_value`, `${key}_completeness`, `${key}_reasons`])];
  const rows = section === "week" ? report.weekCells : report[section];
  const lines = rows.map(row => {
    const record = row as unknown as Record<string, unknown>;
    const values = rowMetrics.flatMap(key => {
      const metric = record[key] as WorkforceMetric | undefined;
      return [metric?.value ?? null, metric?.completeness ?? "unknown", metric?.reasonCodes.join("|") ?? "NOT_AVAILABLE"];
    });
    return [...commonValues, ...labels[section].map(key => record[key]), ...values].map(cell).join(",");
  });
  return [header.map(cell).join(","), ...lines].join("\r\n") + "\r\n";
}
