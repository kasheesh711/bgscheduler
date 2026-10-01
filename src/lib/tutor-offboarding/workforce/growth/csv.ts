import type { WorkforceMetric } from "../types";
import type { GrowthExportSection, GrowthReport } from "./types";

const metricKeys: Record<GrowthExportSection, string[]> = {
  months: ["newlyObservedStudents", "reactivatedStudents", "churnedStudents", "newStudentHours", "reactivatedStudentHours", "churnStudentHours", "bookedStudentHours", "creditStudentHours", "cancellationStudentHours", "bookedTutorHours", "creditTutorHours", "cancellationTutorHours", "newTutorHours", "reactivatedTutorHours", "trialStudentHours", "pretestStudentHours"],
  averages: ["newStudentHours", "reactivatedStudentHours", "churnStudentHours", "cancellationFraction", "cancellationNumerator", "cancellationDenominator", "studentHoursPerTutorHour"],
  forecast: ["bookedStudentHours", "creditStudentHours", "bookedTutorHours", "creditTutorHours", "flatStudentHours", "knownCommittedTutorHours", "capacityRequiredTutorHours", "additionalWeeklyHours", "bufferedAdditionalWeeklyHours"],
  gaps: ["requiredHours", "allocatedHours", "additionalWeeklyHours", "bufferedAdditionalWeeklyHours"],
};
const rowKeys: Record<GrowthExportSection, string[]> = {
  months: ["key", "month", "mature", "provisional", "startingCohortExcluded", "contributors"],
  averages: ["months"],
  forecast: ["key", "month"],
  gaps: ["key", "month", "weekday", "startMinute", "endMinute"],
};

function cell(value: unknown): string {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : '""';
  let text = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

/** A lossless export of the selected chart rows, including their evidence and assumptions. */
export function serializeGrowthCsv(report: GrowthReport, section: GrowthExportSection): string {
  const commonHeaders = ["report_revision", "generated_at", "filters", "scenario", "common_window", "forecast_base_month", "source_status", "source_issues", "source_coverage", "source_exceptions", "availability_observed_at", "lifecycle_evidence", "forecast_assumptions"];
  const commonValues = [report.reportRevision, report.generatedAt, report.query.filters, report.query.assumptions,
    report.flows.commonWindow.join("|"), report.forecast.baseMonth, report.quality.completeness,
    report.quality.issueCodes.join("|"), report.quality.sourceCoverage, report.quality.exceptions,
    [...new Set(report.forecast.allocations.flatMap(row => row.observedAt))].sort(), null, report.forecast.assumptions];
  const keys = ["courseKey", "subject", "curriculum", "level", ...rowKeys[section]];
  const headers = [...commonHeaders, ...keys, ...metricKeys[section].flatMap(key => [`${key}_value`, `${key}_completeness`, `${key}_reasons`]), "model_inputs", "hiring_benchmark"];
  const rows = section === "months" ? report.flows.months : section === "averages" ? report.flows.averages
    : section === "forecast" ? report.forecast.months : report.forecast.allocations.flatMap(row => row.cells);
  const events = new Map(report.flows.lifecycleEvents.map(event => [event.eventKey, event]));
  const inputs = new Map(report.forecast.inputs.map(input => [input.courseKey, input]));
  const benchmarks = new Map(report.forecast.hiring.map(estimate => [JSON.stringify([estimate.month, estimate.courseKey]), estimate]));
  const lines = rows.map(row => {
    const record = row as unknown as Record<string, unknown>;
    const contributors = record.contributors as { eventKeys?: string[] } | undefined;
    const relevantEvents = section === 'months'
      ? (contributors?.eventKeys ?? []).flatMap(key => events.has(key) ? [events.get(key)!] : [])
      : report.flows.lifecycleEvents.filter(event => event.subject === row.subject && report.flows.commonWindow.includes(event.effectiveMonth));
    const provenance = [...commonValues];
    // Keep unrelated people and lifecycle histories out of every exported row.
    provenance[11] = relevantEvents;
    const values = metricKeys[section].flatMap(key => {
      const metric = record[key] as WorkforceMetric | undefined;
      return [metric?.value ?? null, metric?.completeness ?? "unknown", metric?.reasonCodes.join("|") ?? "NOT_AVAILABLE"];
    });
    return [...provenance, ...keys.map(key => record[key]), ...values,
      inputs.get(row.courseKey) ?? null,
      benchmarks.get(JSON.stringify([record.month, row.courseKey])) ?? null,
    ].map(cell).join(",");
  });
  return [headers.map(cell).join(","), ...lines].join("\r\n") + "\r\n";
}
