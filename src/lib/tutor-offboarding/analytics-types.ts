import type { FreshnessReport } from "./types";
import type { TerminationSourceStatus } from "./termination-source";
export type AnalyticsCategory =
  | "marked_no_upcoming"
  | "marked_pending_classes"
  | "inferred_very_likely_unmarked"
  | "likely_unmarked"
  | "unclear_unmarked"
  | "retained"
  | "staff";
export interface AnalyticsPerson {
  canonicalKey: string;
  displayName: string;
  category: AnalyticsCategory;
  currentRoster: boolean;
  marked: boolean;
  fullTime: boolean;
  likelihood: number | null;
  lastTaughtAt: string | null;
  taughtSinceMarch: boolean;
  upcomingSessions30Days: number;
  upcomingSessionsAllTime: number;
  nextSessionAt: string | null;
  capabilitiesKnown: boolean;
  identityConflict: boolean;
}
export interface AnalyticsMonthly {
  month: string;
  teachingPeople: number;
  endedSessions: number;
  partial: boolean;
}
export interface AnalyticsCoverage {
  subject: string;
  curriculum: string;
  level: string;
  examPrep: string | null;
  currentPeople: string[];
  markedPeople: string[];
  inferredPeople: string[];
  remainingAfterMarked: string[];
  remainingAfterMarkedAndInferred: string[];
  recentTeachingPeople: string[];
  upcomingTeachingPeople: string[];
}
export interface AnalyticsCourseImpact {
  wiseClassId: string | null;
  title: string | null;
  wiseCourseCategory: string | null;
  personKeys: string[];
  markedPeople: string[];
  inferredPeople: string[];
  upcomingSessions30Days: number;
  upcomingSessionsAllTime: number;
  markedUpcomingSessions30Days: number;
  markedUpcomingSessionsAllTime: number;
  inferredUpcomingSessions30Days: number;
  inferredUpcomingSessionsAllTime: number;
  firstUpcomingAt: string | null;
  lastUpcomingAt: string | null;
  endedSessionsSinceMarch: number;
  otherHistoricalPeople: string[];
}
export interface AnalyticsReport {
  available: true;
  servedAt: string;
  historyStart: string;
  snapshotCreatedAt: string;
  upcomingWindowEnd: string;
  futureHorizonEnd: string | null;
  freshness: FreshnessReport;
  terminationSource: TerminationSourceStatus;
  totals: {
    rosterTutors: number;
    staff: number;
    fullTimeTutors: number;
    historicalTeachingPeople: number;
    historicalOffRosterPeople: number;
    markedTutors: number;
    markedPendingClasses: number;
    inferredVeryLikely: number;
    missingQualifications: number;
    identityConflicts: number;
    unresolvedHistoricalSessions: number;
    missingFutureCourseIds: number;
    conflictingSessionAssignments: number;
  };
  turnover: {
    actualRate: null;
    unavailableReason: string;
    denominator: number;
    markedNumerator: number;
    markedShare: number | null;
    markedAndInferredNumerator: number;
    markedAndInferredShare: number | null;
  };
  monthly: AnalyticsMonthly[];
  people: AnalyticsPerson[];
  coverage: AnalyticsCoverage[];
  courses: AnalyticsCourseImpact[];
  limitations: string[];
}
export type TutorOffboardingAnalytics =
  | AnalyticsReport
  | { available: false; reason: "not_set_up" | "no_snapshot" | "load_failed" };
export interface AnalyticsQualification {
  canonicalKey: string;
  subject: string;
  curriculum: string;
  level: string;
  examPrep: string | null;
}
export interface AnalyticsSession {
  wiseSessionId: string;
  canonicalKey: string | null;
  wiseClassId: string | null;
  title: string | null;
  wiseCourseCategory: string | null;
  startAt: string;
  endAt: string | null;
}
