import type {
  WorkforceQuery,
  WorkforceReport,
  WorkforceDrilldownQuery,
  WorkforceDrilldown,
  WorkforceExportSection,
  ReviewedSubjectMapping,
} from "@/lib/tutor-offboarding/workforce/types";
const BASE = "/api/tutor-offboarding/analytics/workforce";
export class WorkforceRequestError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export function queryParams(query: WorkforceQuery): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined && value !== "") params.set(key, String(value));
  return params;
}
async function read(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(path, {
    method: "GET",
    cache: "no-store",
    signal,
  });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new WorkforceRequestError(
      body?.error || "Workforce evidence could not load.",
      response.status,
    );
  return body;
}
const METRIC_KEYS = [
  "uniqueStudents",
  "studentBookings",
  "distinctClasses",
  "bookedHours",
  "cancelledBookings",
  "noShowBookings",
  "creditConsumedHours",
  "recordedTeachingHours",
  "qualifiedPeople",
  "offeredHours",
  "leaveHours",
  "usableHours",
  "reservedHours",
  "freeHours",
  "outsideHours",
  "overlapHours",
  "coverageHours",
  "expectedCoverageHours",
  "coveragePercent",
  "reservedUtilizationPercent",
  "consumedUtilizationPercent",
  "recordedTeachingUtilizationPercent",
  "utilizationReservedHours",
  "utilizationCreditConsumedHours",
  "utilizationRecordedTeachingHours",
];
function validMetric(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const metric = value as {
    value?: unknown;
    completeness?: unknown;
    reasonCodes?: unknown;
  };
  return (
    (metric.value === null ||
      (typeof metric.value === "number" && Number.isFinite(metric.value))) &&
    ["complete", "partial", "unknown"].includes(String(metric.completeness)) &&
    Array.isArray(metric.reasonCodes) &&
    metric.reasonCodes.every((reason) => typeof reason === "string")
  );
}
function validMetrics(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    METRIC_KEYS.every((key) =>
      validMetric((value as Record<string, unknown>)[key]),
    )
  );
}
export async function fetchWorkforceReport(
  query: WorkforceQuery,
  signal: AbortSignal,
): Promise<WorkforceReport> {
  const body = (await read(
    `${BASE}?${queryParams(query)}`,
    signal,
  )) as WorkforceReport | null;
  if (
    !body ||
    body.schemaVersion !== 1 ||
    typeof body.reportRevision !== "string" ||
    !body.query ||
    !validMetrics(body.totals) ||
    !body.quality ||
    !Array.isArray(body.quality.sourceCoverage) ||
    !Array.isArray(body.quality.issueCodes) ||
    !Array.isArray(body.quality.exceptions) ||
    !["months", "subjects", "weekCells", "people"].every((key) =>
      Array.isArray(body[key as keyof WorkforceReport]),
    )
  )
    throw new Error("Workforce response was incomplete. Refresh to try again.");
  if (
    ![
      ...body.months,
      ...body.subjects,
      ...body.weekCells,
      ...body.people,
    ].every(validMetrics)
  )
    throw new Error("Workforce response was incomplete. Refresh to try again.");
  return body;
}
export async function fetchWorkforceDrilldown(
  query: WorkforceDrilldownQuery,
  signal: AbortSignal,
): Promise<WorkforceDrilldown> {
  const body = (await read(
    `${BASE}/drilldown?${queryParams(query)}`,
    signal,
  )) as WorkforceDrilldown | null;
  if (
    !body ||
    body.reportRevision !== query.reportRevision ||
    !Array.isArray(body.sessions) ||
    !Array.isArray(body.people) ||
    !Array.isArray(body.observations) ||
    !Array.isArray(body.exceptions)
  )
    throw new Error("Workforce detail response was incomplete.");
  return body;
}
export async function fetchWorkforceExport(
  query: WorkforceQuery,
  section: WorkforceExportSection,
  revision: string,
  signal: AbortSignal,
): Promise<Blob> {
  const params = queryParams(query);
  params.set("section", section);
  params.set("reportRevision", revision);
  const response = await fetch(`${BASE}/export?${params}`, {
    method: "GET",
    cache: "no-store",
    signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new WorkforceRequestError(
      body?.error || "Export could not load.",
      response.status,
    );
  }
  if (!response.headers.get("content-type")?.includes("text/csv"))
    throw new Error("Export response was not a CSV file.");
  return response.blob();
}
export function downloadWorkforceCsv(
  blob: Blob,
  section: WorkforceExportSection,
) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `tutor-workforce-${section}.csv`;
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export interface RequestTicket {
  signal: AbortSignal;
  id: number;
}
/** Also rejects late results when a server or mock ignores AbortSignal. */
export class LatestRequest {
  private sequence = 0;
  private controller: AbortController | null = null;
  begin(): RequestTicket {
    this.controller?.abort();
    this.controller = new AbortController();
    return { signal: this.controller.signal, id: ++this.sequence };
  }
  isCurrent(ticket: RequestTicket) {
    return ticket.id === this.sequence && !ticket.signal.aborted;
  }
  cancel() {
    this.sequence++;
    this.controller?.abort();
  }
}
export async function withFreshRevision<T>(
  revision: string,
  action: (revision: string) => Promise<T>,
  refresh: () => Promise<WorkforceReport>,
): Promise<T> {
  try {
    return await action(revision);
  } catch (error) {
    if (!(error instanceof WorkforceRequestError) || error.status !== 409)
      throw error;
    const fresh = await refresh();
    return action(fresh.reportRevision);
  }
}
export interface UnmappedClass {
  classId: string | null;
  sourceValue: string;
  bookedHours: number;
  sessionsCount: number;
}
export interface MappingReview {
  mappings: ReviewedSubjectMapping[];
  unmappedClasses: UnmappedClass[];
}
export async function fetchMappingReview(
  query: WorkforceQuery,
  signal: AbortSignal,
): Promise<MappingReview> {
  const body = (await read(
    `${BASE}/mappings?${queryParams(query)}`,
    signal,
  )) as MappingReview;
  if (
    !body ||
    !Array.isArray(body.mappings) ||
    !Array.isArray(body.unmappedClasses)
  )
    throw new Error("Mapping review response was incomplete.");
  return body;
}
export async function saveMappingReview(
  input: {
    id?: string;
    classId: string | null;
    sourceValue: string;
    subject: string;
    curriculum: string | null;
    level: string | null;
    expectedRevision: number;
  },
  signal: AbortSignal,
) {
  const response = await fetch(`${BASE}/mappings`, {
    method: "POST",
    cache: "no-store",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new WorkforceRequestError(
      body?.error || "The mapping could not be saved.",
      response.status,
    );
  if (!body?.mapping) throw new Error("Mapping save response was incomplete.");
  return body.mapping as ReviewedSubjectMapping;
}
