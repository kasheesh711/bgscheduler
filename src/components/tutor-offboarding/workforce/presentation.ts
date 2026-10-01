import type {
  WorkforceMetric,
  WorkforceSubjectRow,
  WorkforceQuery,
  WorkforceUtilizationMetrics,
} from "@/lib/tutor-offboarding/workforce/types";
export const RATE_LABELS = {
  reservedUtilizationPercent: "Reserved utilization",
  consumedUtilizationPercent: "Credit-consumed utilization",
  recordedTeachingUtilizationPercent: "Recorded teaching utilization",
} as const;
export const METRIC_LABELS = {
  freeHours: "Shared free hours",
  usableHours: "Usable hours",
  offeredHours: "Gross offered hours",
  leaveHours: "Approved leave",
  bookedHours: "Booked tutor-hours",
  creditConsumedHours: "Credit-consumed hours",
  recordedTeachingHours: "Recorded teaching hours",
  studentBookings: "Student bookings",
  uniqueStudents: "Unique students",
  distinctClasses: "Classes",
  qualifiedPeople: "Qualified people",
  ...RATE_LABELS,
} as const;
export type DisplayMetric = keyof typeof METRIC_LABELS;
export function formatMetric(metric: WorkforceMetric | undefined, unit = "") {
  if (metric?.value == null) return "Unavailable";
  return `${new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(metric.value)}${unit === "%" ? "%" : unit ? ` ${unit}` : ""}`;
}
const reasons: Record<string, string> = {
  availability_history_missing: "Historical availability was not retained.",
  missing_availability: "Availability was not recorded.",
  zero_usable_hours: "No usable hours were recorded.",
  incomplete_coverage: "Only part of the period has supporting evidence.",
  normal_credit_unknown: "The normal credit charge is unknown.",
  subject_unmapped: "Academic subject needs review.",
  roster_history_incomplete:
    "Opening Wise roster is reconstructed from incomplete history.",
};
export function metricReason(metric: WorkforceMetric | undefined) {
  if (!metric) return "Supporting evidence is unavailable.";
  return (
    metric.reasonCodes
      .map((code) => reasons[code] ?? code.replaceAll("_", " "))
      .join(" · ") ||
    (metric.completeness === "partial"
      ? "Only part of the period has supporting evidence."
      : metric.value == null
        ? "Supporting evidence is unavailable."
        : "Complete supporting evidence.")
  );
}
export function monthLabel(month: string) {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en", {
    month: "short",
    year: "numeric",
    timeZone: "Asia/Bangkok",
  });
}
export function bangkokTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Not recorded"
    : date.toLocaleString("en-GB", {
        timeZone: "Asia/Bangkok",
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }) + " Bangkok";
}
export function hierarchyKey(row: WorkforceSubjectRow) {
  return [row.subject, row.curriculum, row.level]
    .filter((value) => value !== null)
    .join("/");
}
export function visibleSubjectRows(
  rows: WorkforceSubjectRow[],
  expanded: Set<string>,
) {
  return rows.filter(
    (row) =>
      row.depth === 0 ||
      (expanded.has(row.subject) &&
        (row.depth === 1 || expanded.has(`${row.subject}/${row.curriculum}`))),
  );
}
export function heatDomain(
  rows: WorkforceUtilizationMetrics[],
  key: DisplayMetric,
) {
  return Math.max(1, ...rows.map((row) => row[key].value ?? 0));
}
export function heatTone(
  metric: WorkforceMetric,
  domain: number,
): number | "unknown" {
  return metric.value === null
    ? "unknown"
    : Math.min(4, Math.max(0, Math.ceil((metric.value / domain) * 4)));
}
export const HEAT_CLASSES = [
  "bg-muted/30",
  "bg-primary/10",
  "bg-primary/20",
  "bg-primary/30",
  "bg-primary/45",
];
export function changeFilter(
  query: WorkforceQuery,
  key: keyof WorkforceQuery,
  value: string,
): WorkforceQuery {
  const next = { ...query, [key]: value || undefined };
  if (key === "subject") {
    next.curriculum = undefined;
    next.level = undefined;
  }
  if (key === "curriculum") next.level = undefined;
  if (key === "from" || key === "to")
    next.viewMonth =
      next.viewMonth < next.from.slice(0, 7)
        ? next.from.slice(0, 7)
        : next.viewMonth > next.to.slice(0, 7)
          ? next.to.slice(0, 7)
          : next.viewMonth;
  return next as WorkforceQuery;
}
export function rateFormula(
  row: WorkforceUtilizationMetrics,
  kind: keyof typeof RATE_LABELS,
) {
  const numerator =
    kind === "reservedUtilizationPercent"
      ? row.utilizationReservedHours
      : kind === "consumedUtilizationPercent"
        ? row.utilizationCreditConsumedHours
        : row.utilizationRecordedTeachingHours;
  return `${formatMetric(numerator, "h")} ÷ ${formatMetric(row.usableHours, "h")} × 100 = ${formatMetric(row[kind], "%")}. Both numerator and usable hours cover the same observed dates.`;
}
