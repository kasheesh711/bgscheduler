import type {
  GrowthQuery,
  GrowthReport,
  GrowthDetailQuery,
  GrowthDrilldown,
  GrowthExportSection,
} from "@/lib/tutor-offboarding/workforce/growth/types";
import { queryParams, WorkforceRequestError } from "./requests";
const BASE = "/api/tutor-offboarding/analytics/workforce/growth";
async function jsonRequest(path: string, signal: AbortSignal, body?: unknown) {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    cache: "no-store",
    signal,
    ...(body
      ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok)
    throw new WorkforceRequestError(
      result?.error ?? "Growth evidence could not load.",
      response.status,
    );
  return result;
}
function validMetric(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const v = value as {
    value?: unknown;
    completeness?: unknown;
    reasonCodes?: unknown;
  };
  return (
    (v.value === null ||
      (typeof v.value === "number" && Number.isFinite(v.value))) &&
    ["complete", "partial", "unknown"].includes(String(v.completeness)) &&
    Array.isArray(v.reasonCodes)
  );
}
function rowsHaveMetrics(rows: unknown, keys: string[]): boolean {
  return (
    Array.isArray(rows) &&
    rows.every(
      (row) =>
        row &&
        typeof row.courseKey === "string" &&
        keys.every((key) => validMetric(row[key])),
    )
  );
}
export async function fetchGrowthReport(
  query: GrowthQuery,
  signal: AbortSignal,
  measured = false,
): Promise<GrowthReport> {
  const result = await jsonRequest(
    measured ? `${BASE}?${queryParams(query.filters)}` : BASE,
    signal,
    measured ? undefined : query,
  );
  if (
    !result ||
    result.schemaVersion !== 1 ||
    typeof result.reportRevision !== "string" ||
    !result.query ||
    !Array.isArray(result.flows?.months) ||
    !Array.isArray(result.flows?.averages) ||
    !Array.isArray(result.forecast?.months) ||
    !Array.isArray(result.forecast?.hiring) ||
    !Array.isArray(result.forecast?.allocations) ||
    !Array.isArray(result.forecast?.inputs) ||
    !Array.isArray(result.forecast?.assumptions) ||
    typeof result.forecast?.baseMonth !== "string" ||
    !Array.isArray(result.quality?.issueCodes) ||
    !Array.isArray(result.quality?.sourceCoverage) ||
    !rowsHaveMetrics(result.flows.months, [
      "newStudentHours",
      "reactivatedStudentHours",
      "churnStudentHours",
      "newlyObservedStudents",
      "reactivatedStudents",
      "churnedStudents",
      "trialStudentHours",
      "pretestStudentHours",
    ]) ||
    !rowsHaveMetrics(result.flows.averages, [
      "newStudentHours",
      "reactivatedStudentHours",
      "churnStudentHours",
    ]) ||
    !rowsHaveMetrics(result.forecast.months, [
      "bookedTutorHours",
      "creditTutorHours",
      "knownCommittedTutorHours",
      "flatStudentHours",
      "capacityRequiredTutorHours",
      "bufferedAdditionalWeeklyHours",
    ]) ||
    !rowsHaveMetrics(result.forecast.hiring, [
      "extraWeeklyHours",
      "averageOfferedWeeklyHours",
      "averageMatchingWeeklyHours",
      "tutorEquivalents",
      "roundedHiringEstimate",
      "bufferedTutorEquivalents",
      "bufferedRoundedHiringEstimate",
    ]) ||
    !result.forecast.inputs.every((row: Record<string, unknown>) =>
      [
        "baseStudentHours",
        "newStudentHours",
        "reactivatedStudentHours",
        "churnStudentHours",
        "cancellationFraction",
        "studentHoursPerTutorHour",
      ].every((key) => {
        const value = row[key] as
          { value?: unknown; measured?: unknown; source?: unknown } | undefined;
        return (
          value &&
          (value.value === null ||
            (typeof value.value === "number" &&
              Number.isFinite(value.value))) &&
          validMetric(value.measured) &&
          ["measured", "override", "unavailable"].includes(String(value.source))
        );
      }),
    ) ||
    !result.forecast.allocations.every(
      (allocation: Record<string, unknown>) =>
        validMetric(allocation.bufferedAdditionalWeeklyHours) &&
        rowsHaveMetrics(allocation.cells, ["bufferedAdditionalWeeklyHours"]),
    )
  )
    throw new Error("Growth response was incomplete. Refresh to try again.");
  return result;
}
export async function fetchGrowthDetail(
  query: GrowthDetailQuery,
  signal: AbortSignal,
): Promise<GrowthDrilldown> {
  const result = await jsonRequest(`${BASE}/drilldown`, signal, query);
  if (
    !result ||
    result.reportRevision !== query.reportRevision ||
    !Array.isArray(result.sessions) ||
    !Array.isArray(result.events) ||
    !Array.isArray(result.observations) ||
    !Array.isArray(result.exceptions) ||
    !result.contributors
  )
    throw new Error("Growth detail response was incomplete.");
  return result;
}
export async function fetchGrowthExport(
  query: GrowthQuery,
  reportRevision: string,
  section: GrowthExportSection,
  signal: AbortSignal,
): Promise<Blob> {
  const response = await fetch(`${BASE}/export`, {
    method: "POST",
    cache: "no-store",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...query, reportRevision, section }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new WorkforceRequestError(
      body?.error ?? "Growth export could not load.",
      response.status,
    );
  }
  if (!response.headers.get("content-type")?.includes("text/csv"))
    throw new Error("Growth export response was not a CSV file.");
  return response.blob();
}
