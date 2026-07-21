interface MetricSession {
  eligible: boolean;
  sourceStatus: string;
  deadlineAt: Date;
}

interface MetricAssessment {
  sourceReady: boolean;
  rawOnTime: boolean;
  adjustedCompliant: boolean;
  assessedAt: Date;
}

/** Assessed metrics include only eligible, source-ready sessions that are complete or due. */
export function isPostClassAssessmentInDenominator(
  session: MetricSession | undefined,
  assessment: MetricAssessment | undefined,
): boolean {
  return Boolean(
    session?.eligible === true &&
    session.sourceStatus === "ready" &&
    assessment?.sourceReady === true &&
    (assessment.rawOnTime || assessment.adjustedCompliant || assessment.assessedAt >= session.deadlineAt),
  );
}

interface TutorMetricRankRow {
  assessed: number;
  adjustedComplianceRate: number | null;
  unresolvedViolations: number;
  tutorName: string;
}

export function rankPostClassTutorMetrics<T extends TutorMetricRankRow>(rows: T[]): T[] {
  return rows
    .filter((row) => row.assessed > 0)
    .toSorted((left, right) =>
      (left.adjustedComplianceRate ?? 1) - (right.adjustedComplianceRate ?? 1) ||
      right.unresolvedViolations - left.unresolvedViolations ||
      left.tutorName.localeCompare(right.tutorName),
    );
}

interface SourceIssueInterval {
  sessionId: string | null;
  scope: string;
  firstSeenAt: Date;
  resolvedAt: Date | null;
}

export function postClassSourceIssueCrossedDeadline(
  issue: SourceIssueInterval,
  sessionId: string,
  deadlineAt: Date,
): boolean {
  const appliesToSession = issue.sessionId === sessionId || issue.scope === "global";
  return appliesToSession &&
    issue.firstSeenAt <= deadlineAt &&
    (!issue.resolvedAt || issue.resolvedAt >= deadlineAt);
}

interface ReminderDeliveryMetric {
  status: string;
  attemptCount: number;
  nextAttemptAt: Date | null;
}

/** A failed send is terminal only after retry exhaustion or an explicit stop. */
export function isPostClassTerminalReminderFailure(
  delivery: ReminderDeliveryMetric,
): boolean {
  return delivery.status === "failed" &&
    (delivery.attemptCount >= 4 || delivery.nextAttemptAt === null);
}
