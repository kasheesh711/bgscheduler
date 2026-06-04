export type CronJobStatus =
  | "healthy"
  | "late"
  | "failing"
  | "running"
  | "manual-only"
  | "unknown";

export type CronInvocationOutcome = "running" | "success" | "failed" | "skipped";

export type CronTriggerSource = "cron" | "admin" | "system";

export type CronProofSource = "direct" | "inferred" | "none";

export interface CronInvocationSummary {
  id: string;
  jobKey: string;
  triggerSource: CronTriggerSource | string;
  actorEmail: string | null;
  receivedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  responseStatus: number | null;
  outcome: CronInvocationOutcome | string;
  errorSummary: string | null;
}

export interface CronJobHealth {
  key: string;
  label: string;
  feature: string;
  path: string;
  schedule: string | null;
  cadenceLabel: string;
  maxDurationSeconds: number;
  manualOnly: boolean;
  dangerous: boolean;
  status: CronJobStatus;
  proof: CronProofSource;
  proofLabel: string;
  lastSeenAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  nextExpectedAt: string | null;
  lastExpectedAt: string | null;
  lateAfterAt: string | null;
  durationMs: number | null;
  responseStatus: number | null;
  errorSummary: string | null;
  healthDetail: string;
  latestInvocation: CronInvocationSummary | null;
  recentInvocations: CronInvocationSummary[];
  canRunManually: boolean;
}

export interface DataDomainHealth {
  key: string;
  label: string;
  status: CronJobStatus;
  freshnessLabel: string;
  lastSuccessAt: string | null;
  lastRunAt: string | null;
  recordCountLabel: string;
  issueCount: number;
  detail: string;
}

export interface WiseSnapshotHealth {
  activeSnapshotId: string | null;
  lastSuccessfulSync: string | null;
  lastFailedSync: string | null;
  lastFailureError: string | null;
  staleAgeMs: number | null;
  staleMinutes: number | null;
  stats: {
    totalWiseTeachers: number;
    totalIdentityGroups: number;
    resolvedGroups: number;
    unresolvedGroups: number;
    totalDataIssues: number;
    totalQualifications?: number;
    totalAvailabilityWindows?: number;
    totalLeaves?: number;
    totalFutureSessions?: number;
  } | null;
}

export interface IssueDetails {
  unresolvedAliases: { entityName: string; message: string }[];
  unresolvedModality: { entityName: string; message: string; issueType: string }[];
  unmappedTags: { entityName: string; message: string }[];
}

export interface RunHistoryItem {
  id: string;
  jobKey: string;
  label: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  triggerType: string | null;
  countLabel: string;
  errorSummary: string | null;
}

export interface DataHealthDashboardPayload {
  checkedAt: string;
  overall: {
    status: CronJobStatus;
    headline: string;
    detail: string;
    healthyCount: number;
    lateCount: number;
    failingCount: number;
    runningCount: number;
    unknownCount: number;
    manualOnlyCount: number;
  };
  cronJobs: CronJobHealth[];
  dataDomains: DataDomainHealth[];
  wiseSnapshot: WiseSnapshotHealth;
  issueSummary: Record<string, number>;
  issueDetails: IssueDetails;
  recentRuns: RunHistoryItem[];
  manualActions: Array<{
    key: string;
    label: string;
    dangerous: boolean;
    confirmationLabel: string | null;
  }>;
  // Compatibility fields used by StaleSnapshotBanner and older tests.
  lastSuccessfulSync: string | null;
  lastFailedSync: string | null;
  lastFailureError: string | null;
  staleAgeMs: number | null;
  staleMinutes: number | null;
  activeSnapshotId: string | null;
  stats: WiseSnapshotHealth["stats"];
  issuesByType: Record<string, number>;
  unresolvedAliases: IssueDetails["unresolvedAliases"];
  unresolvedModality: IssueDetails["unresolvedModality"];
  unmappedTags: IssueDetails["unmappedTags"];
  recentSyncs: Array<{
    id: string;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    teacherCount: number | null;
    errorSummary: string | null;
  }>;
}
