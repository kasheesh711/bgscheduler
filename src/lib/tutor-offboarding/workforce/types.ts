/** Source-neutral contracts. All date-only values and weekdays use Asia/Bangkok. */
export type WorkforceRole = "tutor" | "teaching_admin";
export type WorkforceModality = "online" | "onsite";
export type WorkforceCompleteness = "complete" | "partial" | "unknown";
export interface WorkforceQuery {
  /** Inclusive Bangkok dates, YYYY-MM-DD. */
  from: string; to: string; viewMonth: string;
  role: "all" | WorkforceRole;
  subject?: string; curriculum?: string; level?: string;
  modality: "all" | WorkforceModality;
}
export interface WorkforceMetric {
  value: number | null;
  completeness: WorkforceCompleteness;
  reasonCodes: string[];
}
export interface WorkforceAccount {
  wiseTeacherId: string;
  wiseUserId: string;
  joinedAt: string | null;
  relation: string | null;
  modality: WorkforceModality | null;
}
export interface WorkforcePerson {
  canonicalKey: string; displayName: string;
  role: WorkforceRole | null;
  rosterState: "active" | "inactive" | "off_roster" | "unknown";
  /** Earliest retained Wise join date, not a first-class date. */
  joinedAt: string | null;
  accounts: WorkforceAccount[];
  firstObservedAt: string | null; lastObservedAt: string | null;
  identityCompleteness: WorkforceCompleteness;
  reasonCodes: string[];
}
export interface WorkforceQualification {
  subject: string; curriculum: string | null; level: string | null;
  modality: WorkforceModality | null;
}
export interface WorkforceOfferedWindow {
  /** Sunday=0; minutes from Bangkok midnight. */
  weekday: number; startMinute: number; endMinute: number;
  modality: WorkforceModality | null;
  wiseUserId?: string;
}
export interface WorkforceLeave {
  startAt: string; endAt: string;
  status: "approved" | "pending" | "rejected" | "unknown";
  wiseUserId?: string;
}
/** A successful or failed observation at the original source time. Never backdated. */
export interface WorkforceDatedObservation {
  id: string; canonicalKey: string;
  observedAt: string;
  source: string; sourceSnapshotId?: string;
  sourceTimes?: { roster: string; availability: string | null; nearLeaves: string | null; farLeaves: string | null };
  role: WorkforceRole | null;
  accounts: WorkforceAccount[];
  qualifications: WorkforceQualification[];
  offeredWindows: WorkforceOfferedWindow[];
  leaves: WorkforceLeave[];
  availabilityCompleteness: WorkforceCompleteness;
  qualificationCompleteness: WorkforceCompleteness;
  completeness: WorkforceCompleteness;
  reasonCodes: string[];
}
/** Raw adapter observation; converted to canonical person observations by capture. */
export interface AvailabilityObservation {
  observedAt: string; requestedFrom: string; requestedTo: string;
  workingHours: Array<{ day: number | string; startTime: string; endTime: string }>;
  leaves: Array<{ startAt: string; endAt: string }>;
  completeness: WorkforceCompleteness; issueCodes: string[];
}
export interface WorkforceTutorFact {
  id: string; wiseSessionId: string; canonicalKey: string | null;
  scheduledMinutes: number | null; teachingMinutes: number | null;
  modality: WorkforceModality | null;
  subject: string | null; curriculum: string | null; level: string | null;
  completeness: WorkforceCompleteness; reasonCodes: string[];
}
export interface HistoricalBookedParticipants {
  wiseSessionId: string; studentIds: string[];
  completeness: WorkforceCompleteness; source: string; reasonCodes: string[];
}
export type StudentCreditEvidenceStatus = "verified" | "partial" | "unknown";
export type StudentCreditSourceInterpretation =
  | "verified_session_charge" | "verified_session_refund" | "current_balance"
  | "ambiguous_ledger_movement" | "unverified_historical_normal_charge" | "unknown";
export interface StudentCreditEvidence {
  wiseSessionId: string; wiseStudentId: string;
  /** Positive net credits deducted; refunds reduce this value. */
  netCredits: number | null;
  normalCredits: number | null;
  /** Verification of the net session deduction; a normal charge may still be unknown. */
  evidenceStatus: StudentCreditEvidenceStatus;
  sourceInterpretation: StudentCreditSourceInterpretation;
  observedAt: string | null; issueCodes: string[];
}
export interface ReviewedSubjectMapping {
  id: string;
  /** Exact class ID takes precedence over a reviewed exact label alias. */
  classId: string | null;
  sourceValue: string;
  subject: string; curriculum: string | null; level: string | null;
  revision: number;
  reviewedBy: string | null; reviewedAt: string | null;
}
export type SubjectMapping = ReviewedSubjectMapping;
export interface WorkforceTerminationMark {
  canonicalKey: string;
  /** Optional source date; turnover derives the final taught date independently. */
  effectiveAt: string | null;
  markedAt: string;
  status: "pending_classes" | "complete" | "cancelled";
  sourceId: string;
}
export interface WorkforceSourceCoverage {
  source: string;
  requestedFrom: string; requestedTo: string;
  returnedFrom: string | null; returnedTo: string | null;
  observedAt?: string;
  pagesRequested: number; pagesReturned: number; recordsReturned: number;
  truncated: boolean; completeness: WorkforceCompleteness; issueCodes: string[];
}
export interface WorkforceSession {
  wiseSessionId: string; wiseClassId: string | null;
  /** Exact source label, retained for reviewed mapping and changed-label detection. */
  classTitle: string | null;
  startAt: string; endAt: string | null; scheduledMinutes: number | null;
  canonicalTutorKeys: string[];
  /** Used to resolve identity when ingest precedes a roster observation. */
  wiseTeacherIds?: string[]; wiseUserIds?: string[];
  historicalBookedStudentIds: string[] | null;
  participantCompleteness: WorkforceCompleteness;
  completeness: WorkforceCompleteness;
  meetingStatus: string | null; attendanceStatus: string | null;
  modality: WorkforceModality | null;
  subject: string | null; curriculum: string | null; level: string | null;
  observedAt?: string;
  /** Raw Wise classification fields retained for audited regular/trial/pretest review. */
  bookingClassificationSource?: { classType?: string | null; purpose?: string | null; title?: string | null };
  directTeachingEvidence?: { minutes: number; source: string; evidenceId: string } | null;
  reasonCodes: string[];
}
export interface WorkforceEvidence {
  /** Stable source/version token. Never based only on response generation time. */
  revision?: string;
  people: WorkforcePerson[]; observations: WorkforceDatedObservation[];
  tutorFacts: WorkforceTutorFact[]; sessions: WorkforceSession[];
  historicalBookedParticipants: HistoricalBookedParticipants[];
  studentCredits: StudentCreditEvidence[];
  subjectMappings: ReviewedSubjectMapping[];
  terminationMarks: WorkforceTerminationMark[];
  sourceCoverage: WorkforceSourceCoverage[];
}
export interface WorkforceDemandMetrics {
  uniqueStudents: WorkforceMetric;
  studentBookings: WorkforceMetric;
  distinctClasses: WorkforceMetric;
  bookedHours: WorkforceMetric;
  cancelledBookings: WorkforceMetric;
  noShowBookings: WorkforceMetric;
  creditConsumedHours: WorkforceMetric;
  recordedTeachingHours: WorkforceMetric;
}
export interface WorkforceCapacityMetrics {
  qualifiedPeople: WorkforceMetric;
  offeredHours: WorkforceMetric; leaveHours: WorkforceMetric;
  usableHours: WorkforceMetric; reservedHours: WorkforceMetric; freeHours: WorkforceMetric;
  outsideHours: WorkforceMetric; overlapHours: WorkforceMetric;
  /** Numerators clipped to the same observed coverage as usableHours. */
  utilizationReservedHours: WorkforceMetric;
  utilizationCreditConsumedHours: WorkforceMetric;
  utilizationRecordedTeachingHours: WorkforceMetric;
  /** Observed time span, not offered time. Used to explain partial support. */
  coverageHours: WorkforceMetric; expectedCoverageHours: WorkforceMetric;
  coveragePercent: WorkforceMetric;
}
export interface WorkforceUtilizationMetrics extends WorkforceDemandMetrics, WorkforceCapacityMetrics {
  reservedUtilizationPercent: WorkforceMetric;
  consumedUtilizationPercent: WorkforceMetric;
  recordedTeachingUtilizationPercent: WorkforceMetric;
}
export interface WorkforceMonth extends WorkforceUtilizationMetrics {
  month: string; partialMonth: boolean;
  openingRosterCount: WorkforceMetric; closingRosterCount: WorkforceMetric;
  joinsCount: WorkforceMetric; departuresCount: WorkforceMetric; pendingCount: WorkforceMetric;
  turnoverPercent: WorkforceMetric;
  joinedPersonKeys: string[]; departedPersonKeys: string[]; pendingPersonKeys: string[];
}
export type WorkforceMonthlyRow = WorkforceMonth;
export interface WorkforceSubjectRow extends WorkforceUtilizationMetrics {
  key: string; month: string;
  subject: string; curriculum: string | null; level: string | null;
  depth: 0 | 1 | 2; parentKey: string | null;
  modality: "all" | WorkforceModality;
}
/** Metrics are average-week values. monthlyTotals and coveredDates explain support. */
export interface WorkforceWeekCell extends WorkforceUtilizationMetrics {
  key: string; month: string;
  weekday: number; startMinute: number; endMinute: number;
  coveredDates: number; calendarOccurrences: number;
  monthlyTotals: Partial<WorkforceUtilizationMetrics>;
  subject: string | null; curriculum: string | null; level: string | null;
  modality: "all" | WorkforceModality;
}
export interface WorkforcePersonMonth extends WorkforceUtilizationMetrics { month: string; }
export interface WorkforcePersonRow extends WorkforceUtilizationMetrics {
  canonicalKey: string; displayName: string;
  role: WorkforceRole | null; rosterState: WorkforcePerson["rosterState"];
  joinedAt: string | null; departedAt: string | null; pendingDeparture: boolean;
  months: WorkforcePersonMonth[];
  reasonCodes: string[];
}
export interface WorkforceException { code: string; message: string; entityId?: string; }
export interface WorkforceQuality {
  completeness: WorkforceCompleteness; issueCodes: string[];
  sourceCoverage: WorkforceSourceCoverage[];
  exceptions: WorkforceException[];
}
export interface WorkforceReport {
  schemaVersion: 1; reportRevision: string; generatedAt: string; query: WorkforceQuery;
  totals: WorkforceUtilizationMetrics;
  months: WorkforceMonth[]; subjects: WorkforceSubjectRow[];
  weekCells: WorkforceWeekCell[]; people: WorkforcePersonRow[];
  quality: WorkforceQuality;
}
export interface WorkforceContributingEntityIds {
  canonicalKeys: string[]; wiseSessionIds: string[]; wiseClassIds: string[];
  wiseStudentIds: string[]; terminationSourceIds: string[]; observationIds: string[];
}
export interface WorkforceDrilldown {
  query: WorkforceQuery; reportRevision: string;
  kind: "person" | "subject_cell" | "turnover"; key: string;
  contributors: WorkforceContributingEntityIds;
  people: WorkforcePersonRow[];
  sessions: WorkforceSession[];
  observations: WorkforceDatedObservation[];
  exceptions: WorkforceException[];
  nextCursor: string | null;
}
export interface WorkforceDrilldownQuery extends WorkforceQuery {
  kind: WorkforceDrilldown["kind"]; key: string; reportRevision: string;
  cursor?: string; pageSize?: number;
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
