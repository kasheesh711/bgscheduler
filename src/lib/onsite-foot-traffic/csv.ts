import { sanitizeCsvFilename, serializeCsv, type CsvColumn } from "@/lib/sales-dashboard/csv";

import type {
  FootTrafficBreakdownRow,
  FootTrafficDashboardResult,
  FootTrafficExportGrain,
  FootTrafficPeriodRow,
  FootTrafficVisitDetail,
} from "./types";

interface AggregateExportRow {
  key: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  isPartial: boolean;
  studentVisits: number;
  uniqueStudents: number;
  onsiteClasses: number;
  averageVisitsPerClass: number;
  unidentifiedVisits: number;
  source: string;
  dataAsOf: string;
  lastSuccessfulSyncAt: string;
}

const AGGREGATE_COLUMNS: CsvColumn<AggregateExportRow>[] = [
  { key: "key", header: "Key", value: (row) => row.key },
  { key: "label", header: "Label", value: (row) => row.label },
  { key: "periodStart", header: "Period start", value: (row) => row.periodStart },
  { key: "periodEnd", header: "Period end", value: (row) => row.periodEnd },
  { key: "isPartial", header: "Partial period", value: (row) => row.isPartial },
  { key: "studentVisits", header: "Student visits", value: (row) => row.studentVisits },
  { key: "uniqueStudents", header: "Unique students", value: (row) => row.uniqueStudents },
  { key: "onsiteClasses", header: "Onsite classes", value: (row) => row.onsiteClasses },
  { key: "averageVisitsPerClass", header: "Average visits per class", value: (row) => row.averageVisitsPerClass },
  { key: "unidentifiedVisits", header: "Unidentified visits", value: (row) => row.unidentifiedVisits },
  { key: "source", header: "Source", value: (row) => row.source },
  { key: "dataAsOf", header: "Data as of", value: (row) => row.dataAsOf },
  { key: "lastSuccessfulSyncAt", header: "Last successful sync", value: (row) => row.lastSuccessfulSyncAt },
];

const VISIT_COLUMNS: CsvColumn<FootTrafficVisitDetail>[] = [
  { key: "attendanceDate", header: "Attendance date", value: (row) => row.attendanceDate },
  { key: "startTime", header: "Start time (Asia/Bangkok)", value: (row) => row.startTime },
  { key: "weekStart", header: "Week start (Monday)", value: (row) => row.weekStart },
  { key: "month", header: "Month", value: (row) => row.month },
  { key: "studentFingerprint", header: "Student fingerprint", value: (row) => row.studentFingerprint },
  { key: "wiseSessionId", header: "Wise session ID", value: (row) => row.wiseSessionId },
  { key: "room", header: "Room", value: (row) => row.room },
  { key: "subject", header: "Subject", value: (row) => row.subject },
  { key: "tutor", header: "Tutor", value: (row) => row.tutor },
  { key: "consumedCredits", header: "Consumed credit", value: (row) => row.consumedCredits },
];

function aggregateRows(
  payload: FootTrafficDashboardResult,
  rows: Array<FootTrafficPeriodRow | FootTrafficBreakdownRow>,
): AggregateExportRow[] {
  return rows.map((row) => ({
    ...row,
    periodStart: "periodStart" in row ? row.periodStart : payload.meta.effectiveStartDate,
    periodEnd: "periodEnd" in row ? row.periodEnd : payload.meta.effectiveEndDate,
    isPartial: "isPartial" in row ? row.isPartial : payload.meta.isEndDateCapped,
    source: payload.meta.source,
    dataAsOf: payload.meta.dataAsOf ?? "",
    lastSuccessfulSyncAt: payload.meta.lastSuccessfulSyncAt ?? "",
  }));
}

export function buildFootTrafficCsv(
  payload: FootTrafficDashboardResult,
  grain: FootTrafficExportGrain,
): { csv: string; filename: string } {
  const stem = `begifted-foot-traffic-${payload.meta.requestedStartDate}-to-${payload.meta.requestedEndDate}-${grain}`;
  if (grain === "visits") {
    return {
      csv: serializeCsv(payload.visits, VISIT_COLUMNS),
      filename: sanitizeCsvFilename(stem),
    };
  }
  const source = grain === "weekly"
    ? payload.weekly
    : grain === "monthly"
      ? payload.monthly
      : grain === "weekday"
        ? payload.byWeekday
        : payload.byRoom;
  return {
    csv: serializeCsv(aggregateRows(payload, source), AGGREGATE_COLUMNS),
    filename: sanitizeCsvFilename(stem),
  };
}
