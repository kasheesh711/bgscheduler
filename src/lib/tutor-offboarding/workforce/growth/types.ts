import type { WorkforceEvidence, WorkforceMetric, WorkforceQuery, WorkforceQuality } from "../types";

export type GrowthBookingKind = "regular" | "trial" | "pretest" | "unknown";
/** An exact academic course dimension; lifecycle identity remains student × subject. */
export interface GrowthCourse {
  courseKey: string;
  subject: string;
  curriculum: string | null;
  level: string | null;
}
export interface GrowthBookingMetadata {
  wiseSessionId: string;
  classification: GrowthBookingKind;
  sourceField: string | null;
  sourceValue: string | null;
  observedAt: string;
  completeness: "complete" | "partial" | "unknown";
  reasonCodes: string[];
}
export interface GrowthLifecycleEvent {
  eventKey: string;
  revision: number;
  studentId: string;
  subject: string;
  kind: "churn" | "reactivation";
  lastTaughtAt: string | null;
  returnAt: string | null;
  effectiveMonth: string;
  confirmedAt: string;
  /** Retained complete future-snapshot observation supporting a contemporaneous absence check. */
  futureCheckedAt?: string | null;
  baselineMonths: string[];
  baselineStudentHours: WorkforceMetric;
  baselineByCourse?: Array<{ course: GrowthCourse; studentHours: WorkforceMetric }>;
  evidenceRevision: string;
  sourceSessionIds: string[];
  status: "active" | "superseded";
  certainty: "observed" | "inferred";
  reasonCodes: string[];
}
export interface GrowthEvidence {
  workforce: WorkforceEvidence;
  bookingMetadata: GrowthBookingMetadata[];
  lifecycleEvents: GrowthLifecycleEvent[];
  revision: string;
}
export interface GrowthSubjectOverrides {
  newStudentHours?: number;
  reactivatedStudentHours?: number;
  churnStudentHours?: number;
  cancellationFraction?: number;
  studentHoursPerTutorHour?: number;
}
export interface GrowthAssumptions {
  subjects?: Record<string, GrowthSubjectOverrides>;
  bufferPercent: number;
}
export interface GrowthQuery {
  filters: WorkforceQuery;
  assumptions: GrowthAssumptions;
}
export interface GrowthContributors {
  studentIds: string[];
  sessionIds: string[];
  eventKeys: string[];
}
export interface GrowthMonthlyRow extends GrowthCourse {
  key: string;
  subject: string;
  month: string;
  newlyObservedStudents: WorkforceMetric;
  reactivatedStudents: WorkforceMetric;
  churnedStudents: WorkforceMetric;
  newStudentHours: WorkforceMetric;
  reactivatedStudentHours: WorkforceMetric;
  churnStudentHours: WorkforceMetric;
  bookedStudentHours: WorkforceMetric;
  creditStudentHours: WorkforceMetric;
  cancellationStudentHours: WorkforceMetric;
  bookedTutorHours: WorkforceMetric;
  creditTutorHours: WorkforceMetric;
  cancellationTutorHours: WorkforceMetric;
  newTutorHours: WorkforceMetric;
  reactivatedTutorHours: WorkforceMetric;
  trialStudentHours: WorkforceMetric;
  pretestStudentHours: WorkforceMetric;
  mature: boolean;
  provisional: boolean;
  startingCohortExcluded: boolean;
  contributors: GrowthContributors;
}
export interface GrowthSubjectAverages extends GrowthCourse {
  subject: string;
  months: string[];
  newStudentHours: WorkforceMetric;
  reactivatedStudentHours: WorkforceMetric;
  churnStudentHours: WorkforceMetric;
  cancellationFraction: WorkforceMetric;
  cancellationNumerator: WorkforceMetric;
  cancellationDenominator: WorkforceMetric;
  studentHoursPerTutorHour: WorkforceMetric;
}
export interface GrowthTimePattern extends GrowthCourse {
  subject: string;
  weekday: number;
  startMinute: number;
  endMinute: number;
  /** Share of the subject's booked tutor-hours across a normalized week. */
  share: number;
  completeness: "complete" | "partial" | "unknown";
  reasonCodes: string[];
}
export interface GrowthFlows {
  months: GrowthMonthlyRow[];
  lifecycleEvents: GrowthLifecycleEvent[];
  commonWindow: string[];
  averages: GrowthSubjectAverages[];
  patterns: GrowthTimePattern[];
  quality: WorkforceQuality;
}
export interface GrowthModelInput {
  value: number | null;
  source: "measured" | "override" | "unavailable";
  measured: WorkforceMetric;
}
export interface GrowthForecastInputs extends GrowthCourse {
  subject: string;
  baseStudentHours: GrowthModelInput;
  newStudentHours: GrowthModelInput;
  reactivatedStudentHours: GrowthModelInput;
  churnStudentHours: GrowthModelInput;
  cancellationFraction: GrowthModelInput;
  studentHoursPerTutorHour: GrowthModelInput;
}
export interface GrowthForecastMonth extends GrowthCourse {
  key: string;
  month: string;
  subject: string;
  bookedStudentHours: WorkforceMetric;
  creditStudentHours: WorkforceMetric;
  bookedTutorHours: WorkforceMetric;
  creditTutorHours: WorkforceMetric;
  flatStudentHours: WorkforceMetric;
  knownCommittedTutorHours: WorkforceMetric;
  capacityRequiredTutorHours: WorkforceMetric;
  additionalWeeklyHours: WorkforceMetric;
  bufferedAdditionalWeeklyHours: WorkforceMetric;
}
export interface GrowthAllocationSupply {
  canonicalKey: string;
  startAt: string;
  endAt: string;
  /** Exact course keys this person can cover after qualification matching. */
  courseKeys: string[];
}
export interface GrowthAllocationDemand extends GrowthCourse {
  startAt: string;
  endAt: string;
  hours: number;
}
export interface GrowthAllocationCommitment {
  wiseSessionId: string;
  canonicalKey: string;
  subject: string | null;
  courseKey: string | null;
  startAt: string;
  endAt: string;
}
export interface GrowthAllocationInput {
  month: string;
  supply: GrowthAllocationSupply[];
  demand: GrowthAllocationDemand[];
  commitments: GrowthAllocationCommitment[];
  completeness: "complete" | "partial" | "unknown";
  reasonCodes: string[];
  bufferPercent: number;
  observedAt: string[];
}
export interface GrowthAllocationCell extends GrowthCourse {
  key: string;
  month: string;
  subject: string;
  weekday: number;
  startMinute: number;
  endMinute: number;
  requiredHours: WorkforceMetric;
  allocatedHours: WorkforceMetric;
  additionalWeeklyHours: WorkforceMetric;
  bufferedAdditionalWeeklyHours: WorkforceMetric;
}
export interface GrowthAllocationResult {
  month: string;
  requiredHours: WorkforceMetric;
  allocatedHours: WorkforceMetric;
  additionalWeeklyHours: WorkforceMetric;
  bufferedAdditionalWeeklyHours: WorkforceMetric;
  cells: GrowthAllocationCell[];
  observedAt: string[];
  reasonCodes: string[];
}
export interface GrowthForecast {
  baseMonth: string;
  inputs: GrowthForecastInputs[];
  months: GrowthForecastMonth[];
  allocations: GrowthAllocationResult[];
  hiring: GrowthHiringEstimate[];
  bufferPercent: number;
  assumptions: string[];
  quality: WorkforceQuality;
}
export interface GrowthHiringEstimate extends GrowthCourse {
  month: string;
  eligibleTutors: number;
  knownAvailabilityTutors: number;
  averageOfferedWeeklyHours: WorkforceMetric;
  averageMatchingWeeklyHours: WorkforceMetric;
  extraWeeklyHours: WorkforceMetric;
  tutorEquivalents: WorkforceMetric;
  roundedHiringEstimate: WorkforceMetric;
  bufferedTutorEquivalents: WorkforceMetric;
  bufferedRoundedHiringEstimate: WorkforceMetric;
  benchmarkPersonKeys: string[];
  reasonCodes: string[];
}
export interface GrowthReport {
  schemaVersion: 1;
  reportRevision: string;
  generatedAt: string;
  query: GrowthQuery;
  flows: GrowthFlows;
  forecast: GrowthForecast;
  quality: WorkforceQuality;
}
export interface GrowthDetailQuery extends GrowthQuery {
  reportRevision: string;
  kind: "cohort" | "churn" | "cancellation" | "capacity";
  key: string;
  cursor?: string;
  pageSize?: number;
}
export interface GrowthDrilldown {
  reportRevision: string;
  kind: GrowthDetailQuery["kind"];
  key: string;
  contributors: GrowthContributors;
  sessions: WorkforceEvidence["sessions"];
  events: GrowthLifecycleEvent[];
  observations: WorkforceEvidence["observations"];
  exceptions: WorkforceQuality["exceptions"];
  nextCursor: string | null;
}
export type GrowthExportSection = "months" | "averages" | "forecast" | "gaps";
