import type { CalibrationCurve } from "./calibration";

// ----------------------------------------------------------------------------
// Tutor Offboarding types. Instants are ISO strings everywhere, so the signals
// payload can be cached ("use cache") and sent to the client unchanged.
// ----------------------------------------------------------------------------

export type OffboardingBand = "very_likely_gone" | "likely_gone" | "unclear" | "active";

export type OffboardingExclusion =
  | "wise_admin"
  | "teaching"
  | "full_time"
  | "identity_conflict"
  | "awaiting_details"
  | "new_account"
  | "still_with_us";

export type ReasonCode =
  | "idle_gap"
  | "no_class_on_record"
  | "no_working_hours"
  | "no_courses"
  | "never_activated"
  | "recent_wise_action"
  | "on_leave";

/** One Wise account of a person, as the last promoted sync saw it. Null = unknown (OFF-02). */
export interface OffboardingAccount {
  wiseTeacherId: string;
  wiseUserId: string | null;
  displayName: string;
  isOnlineVariant: boolean;
  email: string | null;
  /** `tutor_wise_accounts.status`; null when the account has no durable row yet. */
  status: string | null;
  relation: string | null;
  joinedOn: string | null;
  courseCount: number | null;
  activated: boolean | null;
  /** False when the active snapshot recorded an availability fetch failure for this account. */
  availabilityKnown: boolean;
  workingHourWindows: number;
}

export interface LastTaughtBySource {
  ledger: string | null;
  pastBlocks: string | null;
  postClass: string | null;
}

/** Everything the score needs about one person (OFF-01: an identity group's canonical key). */
export interface PersonSignals {
  canonicalKey: string;
  displayName: string;
  accounts: OffboardingAccount[];
  lastTaughtAt: string | null;
  lastTaughtBySource: LastTaughtBySource;
  upcomingSessions: number;
  nextSessionAt: string | null;
  /** Latest end of an upcoming Wise leave or leave request; null when none. */
  upcomingLeaveUntil: string | null;
  lastTeacherActionAt: string | null;
  lastAdminActionAt: string | null;
  fullTime: boolean;
}

/** The cached part of the dashboard: people on the active snapshot plus every tutor's taught dates. */
export interface OffboardingSignals {
  snapshotId: string;
  snapshotCreatedAt: string;
  generatedAt: string;
  people: PersonSignals[];
  /** Canonical key → sorted Bangkok date keys with a taught session, on the roster or not. */
  taughtDates: Record<string, string[]>;
}

export interface ScoreReason {
  code: ReasonCode;
  direction: "toward_gone" | "toward_active";
  text: string;
}

export interface PersonScore {
  likelihood: number;
  band: OffboardingBand;
  idleDays: number;
  neverTaught: boolean;
  /** reasons[0] is always the idle / no-class reason. */
  reasons: ScoreReason[];
  exclusion: { code: OffboardingExclusion; text: string } | null;
  removable: boolean;
  removableBlockedBy: string | null;
}

export interface FeedTimestamps {
  tutorSnapshot: string | null;
  progressTests: string | null;
  postClass: string | null;
  wiseActivity: string | null;
  leaveRequests: string | null;
}

export type FeedKey = keyof FeedTimestamps;

export interface FeedStatus {
  key: FeedKey;
  label: string;
  lastSuccessAt: string | null;
  maxAgeHours: number;
  fresh: boolean;
}

export interface FreshnessReport {
  ok: boolean;
  feeds: FeedStatus[];
}

export interface DecisionRecord {
  id: string;
  canonicalKey: string;
  note: string | null;
  snoozeUntil: string;
  likelihoodAtDecision: number;
  bandAtDecision: OffboardingBand;
  reasons: string[];
  decidedByEmail: string;
  decidedAt: string;
  revokedAt: string | null;
  revokedByEmail: string | null;
}

export interface DecisionView extends DecisionRecord {
  displayName: string;
}

export interface GrantRecord {
  email: string;
  grantedByEmail: string;
  grantedAt: string;
}

export interface TutorOffboardingViewer {
  email: string;
  isOwner: boolean;
  canRemove: boolean;
}

export interface OffboardingPersonRow {
  signals: PersonSignals;
  score: PersonScore;
  openDecision: DecisionRecord | null;
}

export interface OffboardingSummary {
  veryLikely: number;
  likely: number;
  unclear: number;
  veryLikelyAccounts: number;
}

export interface OffboardingDashboardData {
  /** When this payload was assembled (uncached). */
  servedAt: string;
  /** When the cached signals were read. */
  generatedAt: string;
  snapshotCreatedAt: string;
  freshness: FreshnessReport;
  curve: CalibrationCurve;
  /** Not excluded and not Active, most likely first. */
  inbox: OffboardingPersonRow[];
  activeCount: number;
  /** Excluded for any reason except a Wise ADMIN account. */
  excluded: OffboardingPersonRow[];
  /** OFF-03: people with a Wise ADMIN account. */
  staff: OffboardingPersonRow[];
  decisions: DecisionView[];
  /** Owner only. */
  grants: GrantRecord[] | null;
  viewer: TutorOffboardingViewer;
  summary: OffboardingSummary;
}

export type OffboardingUnavailableReason = "not_set_up" | "no_snapshot" | "load_failed";

export type OffboardingDashboard =
  | ({ available: true } & OffboardingDashboardData)
  | { available: false; reason: OffboardingUnavailableReason; viewer: TutorOffboardingViewer };
