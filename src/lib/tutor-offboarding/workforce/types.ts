/** Shared, source-neutral contracts for the tutor workforce report. */

export type WorkforceRole = "tutor" | "teaching_admin";
export type WorkforceModality = "online" | "onsite";
export type WorkforceCompleteness = "complete" | "partial" | "unknown";

/** `from` and `to` are inclusive Bangkok calendar dates (`YYYY-MM-DD`). */
export interface WorkforceQuery {
  from: string;
  to: string;
  viewMonth: string;
  role: "all" | WorkforceRole;
  subject?: string;
  curriculum?: string;
  level?: string;
  modality: "all" | WorkforceModality;
}

export interface WorkforceMetric {
  /** Unknown values are null; zero is reserved for a measured zero. */
  value: number | null;
  completeness: WorkforceCompleteness;
  reasonCodes: string[];
}

export interface WorkforcePerson {
  canonicalKey: string;
  displayName: string;
  role: WorkforceRole | null;
  rosterState: "active" | "inactive" | "off_roster" | "unknown";
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  identityCompleteness: WorkforceCompleteness;
  reasonCodes: string[];
}

export interface WorkforceDatedObservation {
  id: string;
  canonicalKey: string | null;
  observedAt: string;
  effectiveAt: string | null;
  kind: "roster_join" | "roster_departure" | "availability" | "teaching" | "termination" | "other";
  source: string;
  completeness: WorkforceCompleteness;
  reasonCodes: string[];
}

export interface AvailabilityObservation {
  observedAt: string;
  requestedFrom: string;
  requestedTo: string;
  workingHours: Array<{ day: number | string; startTime: string; endTime: string }>;
  leaves: Array<{ startAt: string; endAt: string }>;
  completeness: WorkforceCompleteness;
  issueCodes: string[];
}

export interface WorkforceTutorFact {
  id: string;
  wiseSessionId: string;
  canonicalKey: string | null;
  scheduledMinutes: number | null;
  teachingMinutes: number | null;
  modality: WorkforceModality | null;
  subject: string | null;
  curriculum: string | null;
  level: string | null;
  completeness: WorkforceCompleteness;
  reasonCodes: string[];
}

export interface HistoricalBookedParticipants {
  wiseSessionId: string;
  studentIds: string[];
  completeness: WorkforceCompleteness;
  source: string;
  reasonCodes: string[];
}

export type StudentCreditEvidenceStatus = "verified" | "partial" | "unknown";
export type StudentCreditSourceInterpretation =
  | "verified_session_charge"
  | "verified_session_refund"
  | "current_balance"
  | "ambiguous_ledger_movement"
  | "unverified_historical_normal_charge"
  | "unknown";

export interface StudentCreditEvidence {
  wiseSessionId: string;
  wiseStudentId: string;
  /** Signed net change only when Wise contract semantics are verified. */
  netCredits: number | null;
  /** Normal charge only when it is directly and unambiguously evidenced. */
  normalCredits: number | null;
  evidenceStatus: StudentCreditEvidenceStatus;
  sourceInterpretation: StudentCreditSourceInterpretation;
  observedAt: string | null;
  issueCodes: string[];
}

export interface ReviewedSubjectMapping {
  sourceValue: string;
  subject: string;
  curriculum: string | null;
  level: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
}

export interface WorkforceTerminationMark {
  canonicalKey: string;
  effectiveAt: string | null;
  markedAt: string;
  status: "pending_classes" | "complete" | "cancelled";
  sourceId: string;
}

export interface WorkforceSourceCoverage {
  source: string;
  requestedFrom: string;
  requestedTo: string;
  returnedFrom: string | null;
  returnedTo: string | null;
  pagesRequested: number;
  pagesReturned: number;
  recordsReturned: number;
  truncated: boolean;
  completeness: WorkforceCompleteness;
  issueCodes: string[];
}

export interface WorkforceSession {
  wiseSessionId: string;
  wiseClassId: string | null;
  /** Exact source label; never normalize or infer a reviewed subject from it. */
  classTitle: string | null;
  startAt: string;
  endAt: string | null;
  scheduledMinutes: number | null;
  canonicalTutorKeys: string[];
  historicalBookedStudentIds: string[] | null;
  participantCompleteness: WorkforceCompleteness;
  completeness: WorkforceCompleteness;
  meetingStatus: string | null;
  attendanceStatus: string | null;
  modality: WorkforceModality | null;
  subject: string | null;
  curriculum: string | null;
  level: string | null;
  /** Populated only by direct, attributable evidence. */
  directTeachingEvidence?: {
    minutes: number;
    source: string;
    evidenceId: string;
  } | null;
  reasonCodes: string[];
}

export interface WorkforceEvidence {
  people: WorkforcePerson[];
  observations: WorkforceDatedObservation[];
  tutorFacts: WorkforceTutorFact[];
  sessions: WorkforceSession[];
  historicalBookedParticipants: HistoricalBookedParticipants[];
  studentCredits: StudentCreditEvidence[];
  subjectMappings: ReviewedSubjectMapping[];
  terminationMarks: WorkforceTerminationMark[];
  sourceCoverage: WorkforceSourceCoverage[];
}

export interface WorkforceMonthlyRow {
  month: string;
  openingRosterCount: WorkforceMetric;
  closingRosterCount: WorkforceMetric;
  joinsCount: WorkforceMetric;
  departuresCount: WorkforceMetric;
  pendingCount: WorkforceMetric;
  turnoverPercent: WorkforceMetric;
}

export interface WorkforceUtilizationMetrics {
  /** Sum of scheduled demand minutes, expressed in hours. */
  demandHours: WorkforceMetric;
  offeredHours: WorkforceMetric;
  usableHours: WorkforceMetric;
  freeHours: WorkforceMetric;
  utilizationDemandPercent: WorkforceMetric;
  utilizationOfferedPercent: WorkforceMetric;
  utilizationUsablePercent: WorkforceMetric;
}

export interface WorkforceSubjectRow extends WorkforceUtilizationMetrics {
  subject: string;
  curriculum: string | null;
  level: string | null;
  modality: "all" | WorkforceModality;
}

export interface WorkforceWeekCell extends WorkforceUtilizationMetrics {
  weekStart: string;
  weekEnd: string;
  subject: string | null;
  curriculum: string | null;
  level: string | null;
  modality: "all" | WorkforceModality;
}

export interface WorkforcePersonRow extends WorkforceUtilizationMetrics {
  canonicalKey: string;
  displayName: string;
  role: WorkforceRole | null;
  rosterState: WorkforcePerson["rosterState"];
  joinsCount: WorkforceMetric;
  departuresCount: WorkforceMetric;
  pendingCount: WorkforceMetric;
}

export interface WorkforceQuality {
  completeness: WorkforceCompleteness;
  issueCodes: string[];
  sourceCoverage: WorkforceSourceCoverage[];
}

export interface WorkforceReport {
  schemaVersion: 1;
  generatedAt: string;
  query: WorkforceQuery;
  months: WorkforceMonthlyRow[];
  subjects: WorkforceSubjectRow[];
  weekCells: WorkforceWeekCell[];
  people: WorkforcePersonRow[];
  quality: WorkforceQuality;
}

/** Stable contributor identifiers shared by every drilldown kind. */
export interface WorkforceContributingEntityIds {
  canonicalKeys: string[];
  wiseSessionIds: string[];
  wiseClassIds: string[];
  wiseStudentIds: string[];
  terminationSourceIds: string[];
  observationIds: string[];
}

export interface WorkforceDrilldown {
  query: WorkforceQuery;
  reportRevision: string;
  kind: "person" | "subject_cell" | "turnover";
  key: string;
  contributors: WorkforceContributingEntityIds;
  exceptions: Array<{ code: string; message: string; entityId?: string }>;
}

export interface WorkforceDrilldownQuery extends WorkforceQuery {
  kind: WorkforceDrilldown["kind"];
  key: string;
  reportRevision: string;
  cursor?: string;
  pageSize?: number;
}

export type WorkforceExportSection = "months" | "subjects" | "week" | "people";

export interface SourceWindowRequest {
  from: string;
  to: string;
  /** Explicit hard ceiling across every Wise request in this operation. */
  maxRequests: number;
  pageSize?: number;
  maxPages?: number;
  teacherUserIds?: string[];
  creditExamples?: Array<{ classId: string; studentId: string; sessionId?: string }>;
}

export interface SourceWindowResult {
  sourceKey: string;
  observedAt: string;
  evidence: WorkforceEvidence;
  requestedWindow: { from: string; to: string };
  returnedWindow: { from: string | null; to: string | null };
  paging: { requests: number; pagesRequested: number; pagesReturned: number; recordsReturned: number };
  truncated: boolean;
  completeness: WorkforceCompleteness;
  complete: boolean;
  sessions: WorkforceSession[];
  credits: StudentCreditEvidence[];
  contractIssues: string[];
}

export interface ProbeOptions {
  from: string;
  to: string;
  maxRequests: number;
  maxPages: number;
  maxDates: number;
  maxCreditExamples: number;
  creditExamples: Array<{ label: string; classId: string; studentId: string; sessionId?: string }>;
  availabilityTeacherUserIds: string[];
  outputPath?: string;
}

export interface SourceContractReport {
  requestedWindow: { from: string; to: string };
  completedAt: string;
  requests: number;
  pages: number;
  contractIssues: string[];
  conclusions: {
    historicalParticipants: WorkforceCompleteness;
    availabilityCoverage: WorkforceCompleteness;
    currentBalanceOrLedger: "current_balance" | "ledger_movement" | "mixed" | "unknown";
    historicalNormalCharges: "verified" | "not_exposed" | "unknown";
    ambiguousRefunds: "unknown" | "interpretable";
  };
  evidence: WorkforceEvidence;
}
