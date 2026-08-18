import type { SessionEligibilityReason } from "@/lib/post-class-feedback/types";

export type FeedbackSourceStatus =
  | "ready"
  | "unavailable"
  | "form_drift"
  | "identity_review";

export type FeedbackContentStatus = "missing" | "blank" | "substantive";
export type FeedbackTimingStatus = "not_due" | "on_time" | "late" | "unknown";
export type FeedbackProvenance = "manual" | "auto" | "unknown";

/**
 * Who actually submitted the feedback, per the Wise activity-event stream.
 * Session detail cannot distinguish these — an admin submitting on a tutor's
 * behalf still writes a submission with `profile: "teacher"`.
 */
export type FeedbackSubmitter = "tutor" | "admin" | "auto" | "other" | "none";
export type FeedbackEnforcementMode = "shadow" | "live" | "paused";
export type FeedbackDeductionStatus =
  | "none"
  | "pending_review"
  | "approved"
  | "waived"
  | "processed"
  | "reversed";

export type FeedbackCapability =
  | "viewer"
  | "reviewer"
  | "finance"
  | "access_manager";

export type FeedbackWaiverCategory =
  | "wise_system_outage"
  | "incorrect_session_tutor_data"
  | "pre_approved_exception"
  | "tutor_emergency"
  | "duplicate_system_error"
  | "other";

export type FeedbackEligibilityReason = SessionEligibilityReason;

export interface FeedbackCapabilities {
  viewer: boolean;
  reviewer: boolean;
  finance: boolean;
  accessManager: boolean;
}

export interface FeedbackQuestionAnswer {
  text: string;
  characters: number;
  meaningful: boolean;
}

export type FeedbackQuestionSummary = Omit<FeedbackQuestionAnswer, "text">;

export interface FeedbackReminderSummary {
  lastKind: "day_after" | "deadline_day" | null;
  lastSentAt: string | null;
  status: "none" | "pending" | "sending" | "sent" | "failed" | "cancelled";
  attempts: number;
}

export interface SessionDeductionSummary {
  id: string;
  status: FeedbackDeductionStatus;
  amount: number;
  processingMonth: string | null;
  version: number;
}

export interface FeedbackObservedVersion {
  id: string;
  submissionId: string | null;
  contentHash: string;
  submittedAt: string | null;
  sourceTimestampTrustworthy: boolean;
  observedAt: string;
  provenance: FeedbackProvenance;
  actorName: string | null;
  required: {
    topics: FeedbackQuestionAnswer;
    performance: FeedbackQuestionAnswer;
    improvement: FeedbackQuestionAnswer;
  };
  homework: string;
  combinedCharacterCount: number;
}

export interface FeedbackSessionRow {
  id: string;
  wiseSessionId: string;
  classId: string;
  className: string;
  subject: string;
  tutorKey: string;
  tutorName: string;
  students: string[];
  scheduledStartAt: string;
  scheduledEndAt: string;
  deadlineAt: string;
  eligible: boolean;
  eligibilityReason: FeedbackEligibilityReason | null;
  sourceStatus: FeedbackSourceStatus;
  contentStatus: FeedbackContentStatus;
  timingStatus: FeedbackTimingStatus;
  /** Who Wise recorded as submitting feedback for this session. */
  submittedBy: FeedbackSubmitter;
  /** Earliest tutor-authored submission, from the Wise activity-event stream. */
  submittedAt: string | null;
  combinedCharacterCount: number;
  required: {
    topics: FeedbackQuestionSummary;
    performance: FeedbackQuestionSummary;
    improvement: FeedbackQuestionSummary;
  };
  versionCount: number;
  observedAt: string | null;
  reminder: FeedbackReminderSummary;
  deduction: SessionDeductionSummary | null;
  ai: {
    suspect: boolean;
    confirmedConcerns: number;
    pendingConcerns: number;
    concerns?: Array<{
      id: string;
      dimension: string;
      summary: string;
      confidence: number | null;
      decision: "pending" | "confirmed" | "dismissed";
      version: number;
    }>;
  };
  sourceIssueContext: Array<{
    type: string;
    message: string;
    firstSeenAt: string;
    resolvedAt: string | null;
  }>;
  wiseUrl: string;
}

export interface FeedbackSourceAnswer {
  id: string | null;
  questionId: string | null;
  questionText: string | null;
  type: string | null;
  /** Exact display string persisted from Wise, including whitespace. */
  text: string;
  /** Lossless Wise value for non-text answer types. */
  rawAnswer: unknown;
}

export interface FeedbackSessionDetailVersion extends FeedbackObservedVersion {
  profile: string;
  sourceTimestampKind: "created" | "updated" | "unknown";
  actorWiseUserId: string | null;
  answers: FeedbackSourceAnswer[];
  substantive: boolean;
  compliant: boolean;
  fieldFailures: string[];
}

export interface FeedbackSessionAssessment {
  id: string;
  feedbackVersionId: string | null;
  policyVersion: number;
  mappingVersion: number;
  sourceStatus: FeedbackSourceStatus;
  contentStatus: FeedbackContentStatus;
  timingStatus: FeedbackTimingStatus;
  deductionStatus: FeedbackDeductionStatus;
  enforcementMode: FeedbackEnforcementMode;
  assessedAt: string;
  requiredFieldsPassed: boolean;
  combinedRawCharCount: number;
  fieldFailures: string[];
  objectiveViolation: boolean;
  rawOnTime: boolean;
  adjustedCompliant: boolean;
  remediatedLate: boolean;
  timingUnknown: boolean;
  timingEvidence: string | null;
  sourceReady: boolean;
}

export interface FeedbackEventAssociation {
  id: string;
  feedbackVersionId: string | null;
  wiseActivityEventId: string | null;
  wiseEventId: string;
  eventTimestamp: string;
  autoSubmitted: boolean | null;
  linkConfidence: number | null;
}

/**
 * One `SessionFeedbackSubmittedEvent` from the Wise activity mirror — the
 * immutable record of when a submission actually happened.
 *
 * `actorRole` is audit detail, not a gate: Wise stamps it from the account's
 * role rather than from authorship, so a tutor who also holds an admin account
 * appears as `ADMIN` on their own submission (D-EVT-04). `isSessionTutor`
 * answers the question the role cannot — whether the actor is the session's own
 * Wise teacher.
 */
export interface FeedbackSubmissionEvent {
  id: string;
  wiseEventId: string;
  eventTimestamp: string;
  actorWiseUserId: string | null;
  actorName: string | null;
  actorRole: string | null;
  autoSubmitted: boolean | null;
  isSessionTutor: boolean;
  countedAsProof: boolean;
  notCountedReason: "auto_submitted" | "after_deadline" | null;
}

export interface FeedbackSessionSourceIssue {
  id: string;
  scope: string;
  issueType: string;
  severity: string;
  status: string;
  blocksEnforcement: boolean;
  message: string;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  resolvedByEmail: string | null;
}

export interface PostClassFeedbackSessionDetail {
  session: {
    id: string;
    wiseSessionId: string;
    wiseClassId: string;
    recurrenceId: string | null;
    className: string | null;
    canonicalTutorKey: string | null;
    canonicalTutorName: string | null;
    wiseTeacherUserId: string | null;
    scheduledStartAt: string;
    scheduledEndAt: string;
    deadlineAt: string;
    finalStatus: string;
    creditsConsumed: number;
    payableEligible: boolean;
    eligible: boolean;
    eligibilityReason: FeedbackEligibilityReason | null;
    sourceStatus: FeedbackSourceStatus;
    contentStatus: FeedbackContentStatus;
    timingStatus: FeedbackTimingStatus;
    latestFeedbackVersionId: string | null;
    firstOnTimeCompliantVersionId: string | null;
    enforcementMode: FeedbackEnforcementMode;
    policyVersion: number;
    lastObservedAt: string | null;
    lastAssessedAt: string | null;
  };
  participants: Array<{
    id: string;
    participantKey: string;
    wiseStudentId: string | null;
    studentName: string;
    creditsConsumed: number;
    billable: boolean;
  }>;
  evidence: {
    versions: FeedbackSessionDetailVersion[];
    eventAssociations: FeedbackEventAssociation[];
    feedbackEvents: FeedbackSubmissionEvent[];
  };
  assessments: FeedbackSessionAssessment[];
  sourceIssues: FeedbackSessionSourceIssue[];
  review: {
    id: string;
    status: FeedbackDeductionStatus;
    amountMinor: number;
    waiverCategory: string | null;
    waiverNote: string | null;
    decisionByEmail: string | null;
    decisionAt: string | null;
    version: number;
  } | null;
  finance: unknown | null;
}

export interface FeedbackTutorMetric {
  tutorKey: string;
  tutorName: string;
  eligible: number;
  assessed: number;
  rawOnTimeRate: number | null;
  adjustedComplianceRate: number | null;
  unresolvedViolations: number;
  meanCharacters: number | null;
  confirmedAiConcerns: number;
  /** Sessions where the tutor submitted their own feedback. */
  tutorAuthored: number;
  /** Sessions an admin filled in on the tutor's behalf. */
  adminRescued: number;
  /** Sessions Wise auto-submitted, where nobody wrote the feedback. */
  autoFilled: number;
  trend: Array<{
    period: string;
    adjustedComplianceRate: number | null;
  }>;
}

export interface FeedbackDeductionRow {
  id: string;
  sessionId: string;
  /** Stable identity. Group by this, never by `tutorName`. */
  tutorKey: string | null;
  wiseSessionId: string | null;
  tutorName: string;
  className: string;
  students: string[];
  sessionEndAt: string;
  reason: string;
  amount: number;
  status: FeedbackDeductionStatus;
  /** True only after the negative line is durably verified in Feedback Deductions. */
  payoutVerifiedWritten: boolean;
  processingMonth: string | null;
  referenceNote: string | null;
  waiverCategory: FeedbackWaiverCategory | null;
  decisionNote: string | null;
  /** Reviewer (or the auto-approval sweep actor) behind the approve/waive decision. */
  decisionByEmail: string | null;
  decisionAt: string | null;
  /** Finance operator who marked the deduction processed. */
  processedByEmail: string | null;
  processedAt: string | null;
  version: number;
  updatedAt: string;
}

export interface FeedbackAuditRow {
  id: string;
  createdAt: string;
  actorEmail: string | null;
  action: string;
  entityType: string;
  entityId: string;
  summary: string;
}

export interface FeedbackAdminAccessRow {
  email: string;
  name: string | null;
  viewer: boolean;
  reviewer: boolean;
  finance: boolean;
  accessManager: boolean;
  version: number;
  updatedAt: string;
}

export interface FeedbackTutorEmailRow {
  tutorKey: string;
  tutorName: string;
  wiseEmails: string[];
  primaryEmail: string | null;
  status: "primary" | "fallback" | "missing" | "conflict";
  warning: string | null;
  version: number;
}

export interface FeedbackFinancePeriod {
  month: string;
  status: "open" | "closed";
  approvedUnprocessed: number;
  version: number;
  updatedAt: string;
}

export interface FeedbackSetupItem {
  key:
    | "mapping"
    | "roles"
    | "shadow_review"
    | "activation";
  label: string;
  complete: boolean;
  detail: string;
  /**
   * Why this item cannot be completed yet, when the server can say. A durable
   * surface for the shadow-review gate, whose reasons previously existed only
   * as a transient toast on a failed confirmation attempt.
   */
  blockers?: Array<{ key: string; detail: string }>;
}

/**
 * Google grants held by the single pinned account that performs every payout
 * write. Null unless the viewer has the finance capability.
 */
export interface FeedbackPayoutGoogleStatus {
  connectedEmail: string;
  sheetsWriteReady: boolean;
  driveReady: boolean;
}

export interface PostClassFeedbackPayload {
  capabilities: FeedbackCapabilities;
  payoutGoogle: FeedbackPayoutGoogleStatus | null;
  settings: {
    mode: FeedbackEnforcementMode;
    effectiveAt: string | null;
    sourceHealth: "healthy" | "degraded" | "unavailable";
    /**
     * Open source issues, split by scope. Global issues suspend enforcement;
     * session-scoped ones affect only their own row and are shown so an
     * operator can see what is messy rather than only that something is.
     */
    openSourceIssues: { global: number; session: number };
    sourceLastSyncedAt: string | null;
    formMappingHealth: "healthy" | "drift" | "unmapped";
    mapping: {
      topics: string | null;
      performance: string | null;
      improvement: string | null;
      homework: string | null;
    };
    digestRecipientEmails: string[];
    policyVersion: string;
    version?: number;
  };
  summary: {
    eligible: number;
    assessed: number;
    rawOnTime: number;
    rawOnTimeRate: number | null;
    adjustedCompliant: number;
    adjustedComplianceRate: number | null;
    openViolations: number;
    pendingDeductions: number;
    pendingDeductionAmount: number;
    reminderFailures: number;
    late: number;
    incomplete: number;
    waived: number;
    meanCharacters: number | null;
    medianCharacters: number | null;
    confirmedAiConcerns: number;
  };
  sessions: FeedbackSessionRow[];
  tutorMetrics: FeedbackTutorMetric[];
  deductions: FeedbackDeductionRow[];
  audit: FeedbackAuditRow[];
  admins: FeedbackAdminAccessRow[];
  tutorEmails: FeedbackTutorEmailRow[];
  financePeriods: FeedbackFinancePeriod[];
  setup: {
    complete: boolean;
    items: FeedbackSetupItem[];
  };
}

export type FeedbackMutationRequest =
  | {
      endpoint: "/api/post-class-feedback/review";
      body: {
        deductionId: string;
        action: "approve" | "waive" | "reopen";
        note: string;
        waiverCategory?: FeedbackWaiverCategory;
        expectedVersion: number;
        idempotencyKey: string;
      };
    }
  | {
      endpoint: "/api/post-class-feedback/finance";
      body: {
        deductionId: string;
        action: "move" | "process" | "reverse";
        processingMonth: string;
        referenceNote: string;
        reason?: string;
        expectedVersion: number;
        idempotencyKey: string;
      };
    }
  | {
      endpoint: "/api/post-class-feedback/ai-review";
      body: {
        concernId: string;
        action: "confirm" | "dismiss";
        note: string;
        expectedVersion: number;
        idempotencyKey: string;
      };
    };
