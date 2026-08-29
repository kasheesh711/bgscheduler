export const POST_CLASS_REQUIRED_FIELDS = [
  "topics",
  "performance",
  "improvement",
] as const;

export const POST_CLASS_FEEDBACK_FIELDS = [
  ...POST_CLASS_REQUIRED_FIELDS,
  "homework",
] as const;

export type PostClassRequiredField = (typeof POST_CLASS_REQUIRED_FIELDS)[number];
export type PostClassFeedbackField = (typeof POST_CLASS_FEEDBACK_FIELDS)[number];

export type SourceStatus = "ready" | "unavailable" | "form_drift" | "identity_review";
export type ContentStatus = "missing" | "blank" | "substantive";
export type TimingStatus = "not_due" | "on_time" | "late" | "unknown";
export type DeductionStatus =
  | "none"
  | "pending_review"
  | "approved"
  | "waived"
  | "processed"
  | "reversed";
export type EnforcementMode = "shadow" | "live" | "paused";
export type FeedbackProvenance = "manual" | "auto" | "unknown";

export interface FeedbackFieldMapping {
  field: PostClassFeedbackField;
  /** Wise question id. This is the strongest and preferred mapping key. */
  questionId?: string | null;
  /** Exact question text fallback, compared with Unicode/case normalization. */
  questionText?: string | null;
}

export interface WiseFeedbackQuestionInput {
  id?: string | null;
  text: string;
  type?: string | null;
  required?: boolean | null;
}

export interface WiseFeedbackAnswerInput {
  id?: string | null;
  questionId?: string | null;
  questionText?: string | null;
  type?: string | null;
  /** Exact Wise answer string. It must not be trimmed before persistence. */
  answer: string;
  /** Lossless JSON evidence returned by Wise before display-string projection. */
  rawAnswer?: unknown;
}

export interface ResolvedFeedbackFieldMapping {
  status: "ready" | "form_drift";
  byField: Partial<Record<PostClassFeedbackField, WiseFeedbackQuestionInput>>;
  missingRequiredFields: PostClassRequiredField[];
  ambiguousFields: PostClassFeedbackField[];
  unmappedQuestionIds: string[];
  reason: string | null;
}

export type FeedbackFieldAnswers = Record<PostClassFeedbackField, string>;

export interface FeedbackVersion {
  /** Wise submission id when Wise supplies one; contentHash is the durable fallback. */
  submissionId: string | null;
  profile: string | null;
  answers: WiseFeedbackAnswerInput[];
  fields: FeedbackFieldAnswers;
  contentHash: string;
  sourceCreatedAt: Date | null;
  sourceTimestampTrustworthy: boolean;
  sourceTimestampKind?: "created" | "updated" | "unknown";
  observedAt: Date;
  actorWiseUserId: string | null;
  actorName?: string | null;
  provenance: FeedbackProvenance;
}

export interface FieldAssessment {
  field: PostClassRequiredField;
  rawCharacterCount: number;
  meaningful: boolean;
  placeholder: boolean;
  noImprovementClaim: boolean;
  hasPositiveGoalAndRationale: boolean;
  failures: Array<"empty" | "placeholder" | "no_goal_or_rationale">;
}

export interface FeedbackContentAssessment {
  compliant: boolean;
  contentStatus: ContentStatus;
  combinedRawCharacterCount: number;
  fields: Record<PostClassRequiredField, FieldAssessment>;
  failedFields: PostClassRequiredField[];
  failureReasons: string[];
}

export interface PreviousComplianceLock {
  locked: boolean;
  versionKey: string | null;
  /** Once a deadline assessment proves a violation, later backfill cannot erase it. */
  violationLocked?: boolean;
  /** Locks are valid only for the policy and mapping that produced them. */
  policyVersion?: number;
  mappingVersion?: number;
  scheduledEndAt?: Date;
  deadlineAt?: Date;
}

/** Who Wise recorded as the submitting actor on a feedback activity event. */
export type FeedbackSubmitterRole = "TEACHER" | "ADMIN" | "STUDENT" | "AUTO" | "UNKNOWN";

/** Where a timing verdict came from. Persisted on the assessment. */
export type TimingEvidenceSource = "activity_event" | "source_timestamp" | "none";

export interface EventTimingEvidence {
  status: TimingStatus;
  /** Earliest qualifying tutor-authored event, when one exists. */
  provenAt: Date | null;
  /** Distinct roles observed across this session's feedback events. */
  submitterRoles: FeedbackSubmitterRole[];
  source: Extract<TimingEvidenceSource, "activity_event" | "none">;
  /** Coverage floor consulted, echoed for audit reproducibility. */
  coverageFrom: Date | null;
}

export interface SessionComplianceInput {
  sourceStatus: SourceStatus;
  scheduledEndAt: Date;
  now: Date;
  versions: FeedbackVersion[];
  enforcementMode: EnforcementMode;
  policyEffectiveAt: Date | null;
  policyVersion?: number;
  mappingVersion?: number;
  previousOnTimeLock?: PreviousComplianceLock | null;
  /** Immutable Wise-side timing/authorship proof. Takes precedence over mutable submission timestamps. */
  eventTiming?: EventTimingEvidence | null;
}

export interface SessionComplianceAssessment {
  sourceStatus: SourceStatus;
  contentStatus: ContentStatus;
  timingStatus: TimingStatus;
  /** What proved the timing verdict. */
  timingEvidenceSource: TimingEvidenceSource;
  /** Roles observed on this session's feedback events, for display and analytics. */
  submitterRoles: FeedbackSubmitterRole[];
  /** Earliest tutor-authored submission, i.e. the instant that decided the verdict. */
  tutorSubmittedAt: Date | null;
  deadlineAt: Date;
  governingVersionKey: string | null;
  onTimeVersionKey: string | null;
  onTimeComplianceLocked: boolean;
  content: FeedbackContentAssessment;
  due: boolean;
  policyApplies: boolean;
  assessed: boolean;
  rawOnTimeCompliant: boolean;
  adjustedCompliant: boolean;
  violation: boolean;
  remediatedLate: boolean;
  deductionCandidate: boolean;
}

export interface SessionEligibilityInput {
  meetingStatus?: string | null;
  /** Wise classroom classType. This takes precedence over the session modality/type. */
  classType?: string | null;
  /** Wise session type/modality, used only when classType is unavailable. */
  sessionType?: string | null;
  attendanceStatus?: string | null;
  /** Status evidence attached to individual Wise feedback submissions. */
  submissionSessionStatuses?: readonly (string | null | undefined)[];
  complimentaryOrTrial?: boolean | null;
  creditsConsumed?: number | null;
  payoutEligible?: boolean | null;
}

export const SESSION_ELIGIBILITY_REASONS = [
  "ended_positive_credits",
  "ended_payout_eligible",
  "not_ended",
  "cancelled",
  "missed_or_no_show",
  "excluded_session_type",
  "complimentary_or_trial",
  "non_billable",
  "billing_evidence_missing",
  /**
   * Wise deleted the session (REC-03). Deliberately absent from
   * `KNOWN_INELIGIBLE_REASON_VALUES`: that list feeds the one-terminal-row-
   * per-run readmission lane, which exists so corrected Wise status or billing
   * can recover. A deleted session has nothing to recover to.
   */
  "deleted_in_wise",
] as const;

export type SessionEligibilityReason = (typeof SESSION_ELIGIBILITY_REASONS)[number];

export interface SessionEligibilityResult {
  status: "eligible" | "ineligible" | "ambiguous";
  eligible: boolean;
  reason: SessionEligibilityReason;
}

export type AiSuspectReason =
  | "short_required_field"
  | "borderline_total_length"
  | "placeholder_pattern"
  | "similar_prior_feedback";

export interface AiSuspectAssessment {
  suspect: boolean;
  reasons: AiSuspectReason[];
  highestPriorSimilarity: number;
  matchingPriorKey: string | null;
}

export interface FeedbackEventEvidence {
  /** Internal row id for the persisted Wise activity event, when available. */
  activityEventRowId?: string | null;
  eventId: string;
  sessionId: string;
  submissionId?: string | null;
  eventTimestamp: Date;
  autoSubmitted?: boolean | null;
  actorWiseUserId?: string | null;
  actorName?: string | null;
  /**
   * Wise actor role on the event (`TEACHER`, `ADMIN`, `STUDENT`). Absent for
   * auto-submitted events, which carry no actor at all. This is the only place
   * tutor authorship can be established: an admin submitting on a tutor's
   * behalf still writes a session-detail submission with `profile: "teacher"`.
   */
  actorRole?: string | null;
}

export interface CanonicalTutorResolution {
  status: "resolved" | "ambiguous";
  canonicalKey: string | null;
  displayName: string | null;
  wiseTeacherUserId: string | null;
}

export interface PostClassParticipant {
  wiseStudentId: string;
  studentName: string | null;
}

export interface PostClassSessionCandidate {
  sessionId: string;
  classId: string;
  reason: "feedback_event" | "incomplete_recheck" | "rolling_window";
  scheduledStartAt?: Date | null;
  scheduledEndAt?: Date | null;
  /** Durable queue ordering for bounded historical canonical rechecks. */
  recheckPriorityAt?: Date | null;
  /** Checkpoint PAST enumeration omitted this persisted obligation. */
  forceDetailRefresh?: boolean;
  rawSession?: Record<string, unknown> | null;
}

export interface ParsedPostClassSession {
  sessionId: string;
  classId: string;
  className: string | null;
  /** Wise classroom subject, surfaced in the session queue. */
  subject: string | null;
  scheduledStartAt: Date;
  scheduledEndAt: Date;
  meetingStatus: string | null;
  classType: string | null;
  sessionType: string | null;
  attendanceStatus: string | null;
  submissionSessionStatuses: string[];
  complimentaryOrTrial: boolean | null;
  creditsConsumed: number | null;
  participants: PostClassParticipant[];
  participantsAuthoritative: boolean;
  questions: WiseFeedbackQuestionInput[];
  mapping: ResolvedFeedbackFieldMapping;
  feedbackVersions: FeedbackVersion[];
}

export interface PostClassSessionObservation {
  /** Immutable configuration snapshot used to parse and evaluate this observation. */
  settingsVersion: number;
  policyVersion: number;
  mappingVersion: number;
  candidate: PostClassSessionCandidate;
  session: ParsedPostClassSession;
  /** Immutable union retained for evidence; session.feedbackVersions is the current Wise projection. */
  feedbackVersionHistory: FeedbackVersion[];
  tutor: CanonicalTutorResolution;
  eligibility: SessionEligibilityResult;
  sourceStatus: SourceStatus;
  /**
   * True only when `sourceStatus` was forced to 'unavailable' by the run-wide
   * fail-closed demotion (a blocking global source issue), not by a per-session
   * verdict. On this path saveObservation stashes the prior source_status into
   * `source_status_before` (keep-first), so completeSync's REC-01 bulk restore
   * heals the row on the next healthy run. Absent/false for every other status.
   */
  globalSourceDemotion?: boolean;
  assessment: SessionComplianceAssessment | null;
  enforcementMode: EnforcementMode;
  events: FeedbackEventEvidence[];
  observedAt: Date;
}
