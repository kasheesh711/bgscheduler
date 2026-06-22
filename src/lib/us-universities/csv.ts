// ── Browse-table CSV export ────────────────────────────────────────────
// Reuses the generic serializer from the sales-dashboard csv util (DRY).

import { serializeCsv, type CsvColumn } from "@/lib/sales-dashboard/csv";
import { CONTROL_LABELS } from "./constants";
import type { IpedsInstitutionSummary } from "./types";

export const INSTITUTION_CSV_COLUMNS: CsvColumn<IpedsInstitutionSummary>[] = [
  { key: "instName", header: "Institution", value: (r) => r.instName },
  { key: "city", header: "City", value: (r) => r.city },
  { key: "stateAbbr", header: "State", value: (r) => r.stateAbbr },
  {
    key: "control",
    header: "Control",
    value: (r) => (r.control != null ? (CONTROL_LABELS[r.control] ?? r.control) : ""),
  },
  { key: "acceptanceRate", header: "Acceptance %", value: (r) => r.acceptanceRate },
  { key: "yieldRate", header: "Yield %", value: (r) => r.yieldRate },
  { key: "satReadingP25", header: "SAT Reading 25th", value: (r) => r.satReadingP25 },
  { key: "satReadingP75", header: "SAT Reading 75th", value: (r) => r.satReadingP75 },
  { key: "satMathP25", header: "SAT Math 25th", value: (r) => r.satMathP25 },
  { key: "satMathP75", header: "SAT Math 75th", value: (r) => r.satMathP75 },
  { key: "actCompositeP25", header: "ACT 25th", value: (r) => r.actCompositeP25 },
  { key: "actCompositeP75", header: "ACT 75th", value: (r) => r.actCompositeP75 },
  { key: "enrollmentTotal", header: "Total enrollment", value: (r) => r.enrollmentTotal },
  { key: "enrollmentUg", header: "Undergrad enrollment", value: (r) => r.enrollmentUg },
  { key: "studentFacultyRatio", header: "Student-faculty ratio", value: (r) => r.studentFacultyRatio },
  { key: "retentionFt", header: "Retention % (FT)", value: (r) => r.retentionFt },
  { key: "gradRateBach6yr", header: "Grad rate 6yr %", value: (r) => r.gradRateBach6yr },
  { key: "tuitionInState", header: "Tuition (in-state)", value: (r) => r.tuitionInState },
  { key: "tuitionOutState", header: "Tuition (out-of-state)", value: (r) => r.tuitionOutState },
  { key: "totalPriceInState", header: "Total price (in-state)", value: (r) => r.totalPriceInState },
  { key: "avgNetPrice", header: "Avg net price", value: (r) => r.avgNetPrice },
  { key: "website", header: "Website", value: (r) => r.website },
];

export function institutionsToCsv(rows: readonly IpedsInstitutionSummary[]): string {
  return serializeCsv(rows, INSTITUTION_CSV_COLUMNS);
}
