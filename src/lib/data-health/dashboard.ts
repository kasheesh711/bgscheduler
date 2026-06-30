import { desc, eq, getTableColumns, lte, sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { isApiSnapshotStale } from "@/lib/ops/stale";
import { CRON_JOBS, statusRank, type CronJobDefinition } from "./cron-registry";
import { evaluateCronJobStatus, type InvocationEvidence, type RunEvidence } from "./status";
import type {
  CronInvocationSummary,
  CronJobHealth,
  CronJobStatus,
  DataDomainHealth,
  DataHealthDashboardPayload,
  IssueDetails,
  RunHistoryItem,
} from "./types";

const RECENT_LIMIT = 8;

type SyncRun = typeof schema.syncRuns.$inferSelect;
type CronInvocation = typeof schema.cronInvocations.$inferSelect;
type WiseActivityRun = typeof schema.wiseActivitySyncRuns.$inferSelect;
type SalesImportRun = typeof schema.salesDashboardImportRuns.$inferSelect;
type SalesProjectionRun = typeof schema.salesDashboardProjectionImportRuns.$inferSelect;
type CompetitorRun = typeof schema.competitorSyncRuns.$inferSelect;
type CreditRun = typeof schema.creditControlSyncRuns.$inferSelect;
type ClassroomRun = typeof schema.classroomAssignmentRuns.$inferSelect;
type ClassroomAdminEmailRun = typeof schema.classroomAdminEmailRuns.$inferSelect;
type LeaveRun = typeof schema.leaveRequestSyncRuns.$inferSelect;
type ProgressTestRun = typeof schema.progressTestSyncRuns.$inferSelect;
type ProgressTestDigestRun = typeof schema.progressTestAdminDigestRuns.$inferSelect;
type RoomUtilizationSession = typeof schema.roomUtilizationSessions.$inferSelect;

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function durationMs(startedAt: Date | string | null, finishedAt: Date | string | null | undefined): number | null {
  if (!startedAt || !finishedAt) return null;
  return new Date(finishedAt).getTime() - new Date(startedAt).getTime();
}

function compactError(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.length > 220 ? `${value.slice(0, 220)}...` : value;
}

function freshnessLabel(value: string | null, now = new Date()): string {
  if (!value) return "Never";
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(value).getTime()) / 60000));
  if (minutes < 2) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function runEvidence(run: {
  status: string;
  startedAt: Date;
  finishedAt?: Date | null;
  errorSummary?: string | null;
} | null): RunEvidence | null {
  if (!run) return null;
  return {
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? null,
    errorSummary: run.errorSummary ?? null,
  };
}

function invocationEvidence(invocation: CronInvocation | null): InvocationEvidence | null {
  if (!invocation) return null;
  return {
    outcome: invocation.outcome,
    receivedAt: invocation.receivedAt,
    finishedAt: invocation.finishedAt,
    durationMs: invocation.durationMs,
    responseStatus: invocation.responseStatus,
    errorSummary: invocation.errorSummary,
  };
}

function invocationSummary(invocation: CronInvocation): CronInvocationSummary {
  return {
    id: invocation.id,
    jobKey: invocation.jobKey,
    triggerSource: invocation.triggerSource,
    actorEmail: invocation.actorEmail,
    receivedAt: invocation.receivedAt.toISOString(),
    finishedAt: iso(invocation.finishedAt),
    durationMs: invocation.durationMs,
    responseStatus: invocation.responseStatus,
    outcome: invocation.outcome,
    errorSummary: compactError(invocation.errorSummary),
  };
}

function latestBy<T>(rows: T[], selector: (row: T) => Date | null | undefined): T | null {
  return rows.reduce<T | null>((winner, row) => {
    const value = selector(row);
    if (!value) return winner;
    if (!winner) return row;
    const winnerValue = selector(winner);
    return !winnerValue || value.getTime() > winnerValue.getTime() ? row : winner;
  }, null);
}

function latestSuccessful<T extends { status: string }>(
  rows: T[],
  selector: (row: T) => Date | null | undefined,
  successStatuses = new Set(["success", "sent", "completed", "published"]),
): T | null {
  return latestBy(rows.filter((row) => successStatuses.has(row.status)), selector);
}

function latestFailed<T extends { status: string }>(
  rows: T[],
  selector: (row: T) => Date | null | undefined,
  failedStatuses = new Set(["failed", "partial"]),
): T | null {
  return latestBy(rows.filter((row) => failedStatuses.has(row.status)), selector);
}

function latestRunning<T extends { status: string }>(
  rows: T[],
  selector: (row: T) => Date | null | undefined,
): T | null {
  return latestBy(rows.filter((row) => row.status === "running" || row.status === "pending"), selector);
}

interface JobRuns {
  latestRun: RunEvidence | null;
  latestSuccessfulRun: RunEvidence | null;
  latestFailedRun: RunEvidence | null;
  runningRun: RunEvidence | null;
}

function pickJobRuns(
  job: CronJobDefinition,
  allRuns: {
    wise: SyncRun[];
    activity: WiseActivityRun[];
    salesImports: SalesImportRun[];
    salesProjection: SalesProjectionRun[];
    competitor: CompetitorRun[];
    credit: CreditRun[];
    leave: LeaveRun[];
    progressTests: ProgressTestRun[];
    progressTestDigest: ProgressTestDigestRun[];
    classroom: ClassroomRun[];
    adminEmail: ClassroomAdminEmailRun[];
    roomUtilization: RoomUtilizationSession[];
  },
): JobRuns {
  if (job.key === "wise_snapshot") {
    return {
      latestRun: runEvidence(allRuns.wise[0] ?? null),
      latestSuccessfulRun: runEvidence(latestSuccessful(allRuns.wise, (run) => run.finishedAt)),
      latestFailedRun: runEvidence(latestFailed(allRuns.wise, (run) => run.finishedAt)),
      runningRun: runEvidence(latestRunning(allRuns.wise, (run) => run.startedAt)),
    };
  }

  if (job.key === "wise_activity") {
    return {
      latestRun: runEvidence(allRuns.activity[0] ?? null),
      latestSuccessfulRun: runEvidence(latestSuccessful(allRuns.activity, (run) => run.finishedAt)),
      latestFailedRun: runEvidence(latestFailed(allRuns.activity, (run) => run.finishedAt)),
      runningRun: runEvidence(latestRunning(allRuns.activity, (run) => run.startedAt)),
    };
  }

  if (job.key === "sales_dashboard") {
    const rows = [...allRuns.salesImports, ...allRuns.salesProjection].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    return {
      latestRun: runEvidence(rows[0] ?? null),
      latestSuccessfulRun: runEvidence(latestSuccessful(rows, (run) => run.finishedAt)),
      latestFailedRun: runEvidence(latestFailed(rows, (run) => run.finishedAt)),
      runningRun: runEvidence(latestRunning(rows, (run) => run.startedAt)),
    };
  }

  if (job.key === "competitor_intelligence") {
    return {
      latestRun: runEvidence(allRuns.competitor[0] ?? null),
      latestSuccessfulRun: runEvidence(latestSuccessful(allRuns.competitor, (run) => run.finishedAt)),
      latestFailedRun: runEvidence(latestFailed(allRuns.competitor, (run) => run.finishedAt)),
      runningRun: runEvidence(latestRunning(allRuns.competitor, (run) => run.startedAt)),
    };
  }

  if (job.key === "credit_control") {
    return {
      latestRun: runEvidence(allRuns.credit[0] ?? null),
      latestSuccessfulRun: runEvidence(latestSuccessful(allRuns.credit, (run) => run.finishedAt)),
      latestFailedRun: runEvidence(latestFailed(allRuns.credit, (run) => run.finishedAt)),
      runningRun: runEvidence(latestRunning(allRuns.credit, (run) => run.startedAt)),
    };
  }

  if (job.key === "leave_requests") {
    return {
      latestRun: runEvidence(allRuns.leave[0] ?? null),
      latestSuccessfulRun: runEvidence(latestSuccessful(allRuns.leave, (run) => run.finishedAt)),
      latestFailedRun: runEvidence(latestFailed(allRuns.leave, (run) => run.finishedAt)),
      runningRun: runEvidence(latestRunning(allRuns.leave, (run) => run.startedAt)),
    };
  }

  if (job.key === "progress_tests") {
    return {
      latestRun: runEvidence(allRuns.progressTests[0] ?? null),
      latestSuccessfulRun: runEvidence(latestSuccessful(allRuns.progressTests, (run) => run.finishedAt)),
      latestFailedRun: runEvidence(latestFailed(allRuns.progressTests, (run) => run.finishedAt)),
      runningRun: runEvidence(latestRunning(allRuns.progressTests, (run) => run.startedAt)),
    };
  }

  if (job.key === "progress_tests_digest") {
    // Daily job: a "skipped" run (nothing to report) is still proof it fired.
    return {
      latestRun: runEvidence(digestRunEvidence(allRuns.progressTestDigest[0] ?? null)),
      latestSuccessfulRun: runEvidence(digestRunEvidence(latestSuccessful(allRuns.progressTestDigest, (run) => run.sentAt ?? run.updatedAt, new Set(["sent", "skipped"])))),
      latestFailedRun: runEvidence(digestRunEvidence(latestFailed(allRuns.progressTestDigest, (run) => run.updatedAt))),
      runningRun: runEvidence(digestRunEvidence(latestRunning(allRuns.progressTestDigest, (run) => run.createdAt))),
    };
  }

  if (job.key === "student_promotions_july_1") {
    // The july-1 route is audit-wrapped, but its run table mixes admin drafts
    // with the cron apply, so there is no trustworthy durable fallback before
    // direct cron_invocations proof exists. Fail closed instead of borrowing
    // unrelated run evidence for this dangerous write-path cron.
    return {
      latestRun: null,
      latestSuccessfulRun: null,
      latestFailedRun: null,
      runningRun: null,
    };
  }

  if (job.key === "classroom_morning") {
    return {
      latestRun: runEvidence(classroomRunEvidence(allRuns.classroom[0] ?? null)),
      latestSuccessfulRun: runEvidence(classroomRunEvidence(latestSuccessful(allRuns.classroom, (run) => run.updatedAt))),
      latestFailedRun: runEvidence(classroomRunEvidence(latestFailed(allRuns.classroom, (run) => run.updatedAt))),
      runningRun: null,
    };
  }

  if (job.key === "classroom_admin_email") {
    return {
      latestRun: runEvidence(adminEmailRunEvidence(allRuns.adminEmail[0] ?? null)),
      latestSuccessfulRun: runEvidence(adminEmailRunEvidence(latestSuccessful(allRuns.adminEmail, (run) => run.sentAt ?? run.updatedAt, new Set(["sent"])))),
      latestFailedRun: runEvidence(adminEmailRunEvidence(latestFailed(allRuns.adminEmail, (run) => run.updatedAt))),
      runningRun: runEvidence(adminEmailRunEvidence(latestRunning(allRuns.adminEmail, (run) => run.createdAt))),
    };
  }

  if (job.key === "cron_watchdog") {
    // The watchdog has no domain run table; its health comes solely from
    // direct cron_invocations proof (the route is audit-wrapped).
    return {
      latestRun: null,
      latestSuccessfulRun: null,
      latestFailedRun: null,
      runningRun: null,
    };
  }

  // Only room_utilization reaches this fallback; every scheduled job above
  // maps to its own run table (or deliberately to no evidence) so stale
  // utilization rows can never stand in as another job's health proof.
  const latestUtilization = allRuns.roomUtilization[0] ?? null;
  return {
    latestRun: latestUtilization
      ? {
          status: "success",
          startedAt: latestUtilization.syncedAt,
          finishedAt: latestUtilization.updatedAt,
          errorSummary: null,
        }
      : null,
    latestSuccessfulRun: latestUtilization
      ? {
          status: "success",
          startedAt: latestUtilization.syncedAt,
          finishedAt: latestUtilization.updatedAt,
          errorSummary: null,
        }
      : null,
    latestFailedRun: null,
    runningRun: null,
  };
}

function classroomRunEvidence(run: ClassroomRun | null): { status: string; startedAt: Date; finishedAt: Date | null; errorSummary: string | null } | null {
  if (!run) return null;
  return {
    status: run.status,
    startedAt: run.createdAt,
    finishedAt: run.updatedAt,
    errorSummary: run.failedPublishCount > 0 ? `${run.failedPublishCount} publish failures` : null,
  };
}

function adminEmailRunEvidence(run: ClassroomAdminEmailRun | null): { status: string; startedAt: Date; finishedAt: Date | null; errorSummary: string | null } | null {
  if (!run) return null;
  return {
    status: run.status,
    startedAt: run.createdAt,
    finishedAt: run.sentAt ?? run.updatedAt,
    errorSummary: run.lastError,
  };
}

function digestRunEvidence(run: ProgressTestDigestRun | null): { status: string; startedAt: Date; finishedAt: Date | null; errorSummary: string | null } | null {
  if (!run) return null;
  return {
    status: run.status,
    startedAt: run.createdAt,
    finishedAt: run.sentAt ?? run.updatedAt,
    errorSummary: run.lastError,
  };
}

function issueDetailsFromIssues(issues: Array<{ type: string; entityName: string | null; message: string }>): IssueDetails {
  return {
    unresolvedAliases: issues
      .filter((issue) => issue.type === "alias")
      .map((issue) => ({ entityName: issue.entityName ?? "", message: issue.message })),
    unresolvedModality: issues
      .filter((issue) => issue.type === "modality" || issue.type === "conflict_model")
      .map((issue) => ({
        entityName: issue.entityName ?? "",
        message: issue.message,
        issueType: issue.type,
      })),
    unmappedTags: issues
      .filter((issue) => issue.type === "tag")
      .map((issue) => ({ entityName: issue.entityName ?? "", message: issue.message })),
  };
}

function buildCronJobs(
  invocations: CronInvocation[],
  allRuns: Parameters<typeof pickJobRuns>[1],
  now: Date,
): CronJobHealth[] {
  return CRON_JOBS.map((job) => {
    const jobInvocations = invocations.filter((invocation) => invocation.jobKey === job.key);
    const latestInvocation = jobInvocations[0] ?? null;
    const latestCronInvocation = jobInvocations.find((invocation) => invocation.triggerSource === "cron") ?? null;
    const jobRuns = pickJobRuns(job, allRuns);
    const status = evaluateCronJobStatus({
      job,
      now,
      latestInvocation: invocationEvidence(latestInvocation),
      latestCronInvocation: invocationEvidence(latestCronInvocation),
      ...jobRuns,
    });

    return {
      key: job.key,
      label: job.label,
      feature: job.feature,
      path: job.path,
      schedule: job.schedule,
      cadenceLabel: job.cadenceLabel,
      maxDurationSeconds: job.maxDurationSeconds,
      manualOnly: job.manualOnly,
      dangerous: job.dangerous,
      status: status.status,
      proof: status.proof,
      proofLabel: status.proofLabel,
      lastSeenAt: iso(status.lastSeenAt),
      lastSuccessAt: iso(status.lastSuccessAt),
      lastFailureAt: iso(status.lastFailureAt),
      nextExpectedAt: iso(status.nextExpectedAt),
      lastExpectedAt: iso(status.lastExpectedAt),
      lateAfterAt: iso(status.lateAfterAt),
      durationMs: status.durationMs,
      responseStatus: status.responseStatus,
      errorSummary: compactError(status.errorSummary),
      healthDetail: status.healthDetail,
      latestInvocation: latestInvocation ? invocationSummary(latestInvocation) : null,
      recentInvocations: jobInvocations.slice(0, 4).map(invocationSummary),
      canRunManually: true,
    };
  });
}

function domainStatusFor(job: CronJobHealth | undefined): CronJobStatus {
  return job?.status ?? "unknown";
}

function buildDomains(
  cronJobs: CronJobHealth[],
  allRuns: Parameters<typeof pickJobRuns>[1],
  wiseStats: DataHealthDashboardPayload["stats"],
  now: Date,
): DataDomainHealth[] {
  const jobByKey = new Map(cronJobs.map((job) => [job.key, job]));
  const latestSales = latestBy([...allRuns.salesImports, ...allRuns.salesProjection], (run) => run.finishedAt ?? run.startedAt);

  return [
    {
      key: "wise_snapshot",
      label: "Tutor Snapshot",
      status: domainStatusFor(jobByKey.get("wise_snapshot")),
      freshnessLabel: freshnessLabel(iso(allRuns.wise.find((run) => run.status === "success")?.finishedAt), now),
      lastSuccessAt: iso(allRuns.wise.find((run) => run.status === "success")?.finishedAt),
      lastRunAt: iso(allRuns.wise[0]?.startedAt),
      recordCountLabel: wiseStats ? `${wiseStats.totalWiseTeachers} teachers` : "No active snapshot",
      issueCount: wiseStats?.totalDataIssues ?? 0,
      detail: "Primary search and compare source of truth.",
    },
    {
      key: "wise_activity",
      label: "Wise Activity Audit",
      status: domainStatusFor(jobByKey.get("wise_activity")),
      freshnessLabel: freshnessLabel(iso(allRuns.activity.find((run) => run.status === "success")?.finishedAt), now),
      lastSuccessAt: iso(allRuns.activity.find((run) => run.status === "success")?.finishedAt),
      lastRunAt: iso(allRuns.activity[0]?.startedAt),
      recordCountLabel: `${allRuns.activity[0]?.insertedCount ?? 0} inserted last run`,
      issueCount: allRuns.activity[0]?.status === "failed" ? 1 : 0,
      detail: "Read-only Wise audit event ingestion.",
    },
    {
      key: "sales_dashboard",
      label: "Sales Dashboard",
      status: domainStatusFor(jobByKey.get("sales_dashboard")),
      freshnessLabel: freshnessLabel(iso(latestSales?.finishedAt ?? latestSales?.startedAt), now),
      lastSuccessAt: iso(latestSuccessful([...allRuns.salesImports, ...allRuns.salesProjection], (run) => run.finishedAt)?.finishedAt),
      lastRunAt: iso(latestSales?.startedAt),
      recordCountLabel: `${allRuns.salesImports[0]?.normalRowCount ?? 0} sales rows`,
      issueCount: latestSales?.status === "failed" ? 1 : 0,
      detail: "Google Sheets imports and projection workbook refresh.",
    },
    {
      key: "competitor_intelligence",
      label: "Competitor Intelligence",
      status: domainStatusFor(jobByKey.get("competitor_intelligence")),
      freshnessLabel: freshnessLabel(iso(allRuns.competitor.find((run) => run.status === "success")?.finishedAt), now),
      lastSuccessAt: iso(allRuns.competitor.find((run) => run.status === "success")?.finishedAt),
      lastRunAt: iso(allRuns.competitor[0]?.startedAt),
      recordCountLabel: `${allRuns.competitor[0]?.newItemCount ?? 0} new signals`,
      issueCount: (allRuns.competitor[0]?.sourceFailedCount ?? 0) + (allRuns.competitor[0]?.status === "failed" ? 1 : 0),
      detail: "Market source ingestion, SERP checks, AI brief, and task suggestions.",
    },
    {
      key: "credit_control",
      label: "Credit Control",
      status: domainStatusFor(jobByKey.get("credit_control")),
      freshnessLabel: freshnessLabel(iso(allRuns.credit.find((run) => run.status === "success")?.finishedAt), now),
      lastSuccessAt: iso(allRuns.credit.find((run) => run.status === "success")?.finishedAt),
      lastRunAt: iso(allRuns.credit[0]?.startedAt),
      recordCountLabel: `${allRuns.credit[0]?.studentCount ?? 0} students`,
      issueCount: allRuns.credit[0]?.status === "failed" ? 1 : 0,
      detail: "Student credit depletion and follow-up queue snapshot.",
    },
    {
      key: "leave_requests",
      label: "Leave Requests",
      status: domainStatusFor(jobByKey.get("leave_requests")),
      freshnessLabel: freshnessLabel(iso(allRuns.leave.find((run) => run.status === "success")?.finishedAt), now),
      lastSuccessAt: iso(allRuns.leave.find((run) => run.status === "success")?.finishedAt),
      lastRunAt: iso(allRuns.leave[0]?.startedAt),
      recordCountLabel: `${allRuns.leave[0]?.scannedRowCount ?? 0} sheet rows`,
      issueCount: allRuns.leave[0]?.status === "failed" ? 1 : 0,
      detail: "Google Sheet leave-form ingestion and matching.",
    },
    {
      key: "class_assignments",
      label: "Class Assignments",
      status: domainStatusFor(jobByKey.get("classroom_morning")),
      freshnessLabel: freshnessLabel(iso(allRuns.classroom[0]?.updatedAt), now),
      lastSuccessAt: iso(allRuns.classroom[0]?.updatedAt),
      lastRunAt: iso(allRuns.classroom[0]?.createdAt),
      recordCountLabel: `${allRuns.classroom[0]?.publishedCount ?? 0} published last row`,
      issueCount: allRuns.classroom[0]?.failedPublishCount ?? 0,
      detail: "Daily classroom assignment automation and Wise location publish.",
    },
    {
      key: "room_utilization",
      label: "Room Utilization",
      status: domainStatusFor(jobByKey.get("room_utilization")),
      freshnessLabel: freshnessLabel(iso(allRuns.roomUtilization[0]?.syncedAt), now),
      lastSuccessAt: iso(allRuns.roomUtilization[0]?.updatedAt),
      lastRunAt: iso(allRuns.roomUtilization[0]?.syncedAt),
      recordCountLabel: allRuns.roomUtilization[0] ? "Sessions synced" : "No sync evidence",
      issueCount: 0,
      detail: "Manual-only utilization sync; not scheduled in vercel.json.",
    },
  ];
}

function runHistoryItem(input: {
  id: string;
  jobKey: string;
  label: string;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  triggerType?: string | null;
  countLabel: string;
  errorSummary?: string | null;
}): RunHistoryItem {
  return {
    id: input.id,
    jobKey: input.jobKey,
    label: input.label,
    status: input.status,
    startedAt: input.startedAt.toISOString(),
    finishedAt: iso(input.finishedAt),
    durationMs: durationMs(input.startedAt, input.finishedAt),
    triggerType: input.triggerType ?? null,
    countLabel: input.countLabel,
    errorSummary: compactError(input.errorSummary),
  };
}

function buildRecentRuns(allRuns: Parameters<typeof pickJobRuns>[1]): RunHistoryItem[] {
  const rows: RunHistoryItem[] = [
    ...allRuns.wise.map((run) => runHistoryItem({
      id: run.id,
      jobKey: "wise_snapshot",
      label: "Wise Snapshot",
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      countLabel: run.teacherCount === null ? "-" : `${run.teacherCount} teachers`,
      errorSummary: run.errorSummary,
    })),
    ...allRuns.activity.map((run) => runHistoryItem({
      id: run.id,
      jobKey: "wise_activity",
      label: "Wise Activity",
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      triggerType: run.triggerType,
      countLabel: `${run.insertedCount} inserted`,
      errorSummary: run.errorSummary,
    })),
    ...allRuns.salesImports.map((run) => runHistoryItem({
      id: run.id,
      jobKey: "sales_dashboard",
      label: "Sales Sources",
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      triggerType: run.triggerType,
      countLabel: `${run.normalRowCount} normal / ${run.additionalRowCount} addl`,
      errorSummary: run.errorSummary,
    })),
    ...allRuns.salesProjection.map((run) => runHistoryItem({
      id: run.id,
      jobKey: "sales_dashboard",
      label: "Sales Projection",
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      triggerType: run.triggerType,
      countLabel: `${run.monthRowCount} months`,
      errorSummary: run.errorSummary,
    })),
    ...allRuns.competitor.map((run) => runHistoryItem({
      id: run.id,
      jobKey: "competitor_intelligence",
      label: "Competitor Intelligence",
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      triggerType: run.triggerType,
      countLabel: `${run.newItemCount} new / ${run.sourceFailedCount} failed`,
      errorSummary: run.errorSummary,
    })),
    ...allRuns.credit.map((run) => runHistoryItem({
      id: run.id,
      jobKey: "credit_control",
      label: "Credit Control",
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      countLabel: `${run.studentCount} students`,
      errorSummary: run.errorSummary,
    })),
    ...allRuns.leave.map((run) => runHistoryItem({
      id: run.id,
      jobKey: "leave_requests",
      label: "Leave Requests",
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      triggerType: run.triggerType,
      countLabel: `${run.scannedRowCount} rows`,
      errorSummary: run.errorSummary,
    })),
    ...allRuns.classroom.map((run) => runHistoryItem({
      id: run.id,
      jobKey: "classroom_morning",
      label: "Classroom Morning",
      status: run.status,
      startedAt: run.createdAt,
      finishedAt: run.updatedAt,
      triggerType: run.createdBy,
      countLabel: `${run.publishedCount} published`,
      errorSummary: run.failedPublishCount ? `${run.failedPublishCount} publish failures` : null,
    })),
    ...allRuns.adminEmail.map((run) => runHistoryItem({
      id: run.id,
      jobKey: "classroom_admin_email",
      label: "Admin Email",
      status: run.status,
      startedAt: run.createdAt,
      finishedAt: run.sentAt ?? run.updatedAt,
      triggerType: run.createdBy,
      countLabel: `${run.successCount}/${run.attemptedCount} sent`,
      errorSummary: run.lastError,
    })),
  ];

  return rows
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    .slice(0, 30);
}

async function fetchAllRuns(db: Database) {
  const [
    wise,
    activity,
    salesImports,
    salesProjection,
    competitor,
    credit,
    leave,
    progressTests,
    progressTestDigest,
    classroom,
    adminEmail,
    roomUtilization,
  ] = await Promise.all([
    db.select().from(schema.syncRuns).orderBy(desc(schema.syncRuns.startedAt)).limit(RECENT_LIMIT),
    db.select().from(schema.wiseActivitySyncRuns).orderBy(desc(schema.wiseActivitySyncRuns.startedAt)).limit(RECENT_LIMIT),
    db.select().from(schema.salesDashboardImportRuns).orderBy(desc(schema.salesDashboardImportRuns.startedAt)).limit(RECENT_LIMIT),
    db.select().from(schema.salesDashboardProjectionImportRuns).orderBy(desc(schema.salesDashboardProjectionImportRuns.startedAt)).limit(RECENT_LIMIT),
    db.select().from(schema.competitorSyncRuns).orderBy(desc(schema.competitorSyncRuns.startedAt)).limit(RECENT_LIMIT),
    db.select().from(schema.creditControlSyncRuns).orderBy(desc(schema.creditControlSyncRuns.startedAt)).limit(RECENT_LIMIT),
    db.select().from(schema.leaveRequestSyncRuns).orderBy(desc(schema.leaveRequestSyncRuns.startedAt)).limit(RECENT_LIMIT),
    db.select().from(schema.progressTestSyncRuns).orderBy(desc(schema.progressTestSyncRuns.startedAt)).limit(RECENT_LIMIT),
    db.select().from(schema.progressTestAdminDigestRuns).orderBy(desc(schema.progressTestAdminDigestRuns.createdAt)).limit(RECENT_LIMIT),
    db
      .select()
      .from(schema.classroomAssignmentRuns)
      .where(sql`${schema.classroomAssignmentRuns.automationBatchId} IS NOT NULL OR ${schema.classroomAssignmentRuns.createdBy} LIKE 'cron%'`)
      .orderBy(desc(schema.classroomAssignmentRuns.createdAt))
      .limit(RECENT_LIMIT),
    db.select().from(schema.classroomAdminEmailRuns).orderBy(desc(schema.classroomAdminEmailRuns.createdAt)).limit(RECENT_LIMIT),
    db.select().from(schema.roomUtilizationSessions).orderBy(desc(schema.roomUtilizationSessions.syncedAt)).limit(1),
  ]);

  return {
    wise,
    activity,
    salesImports,
    salesProjection,
    competitor,
    credit,
    leave,
    progressTests,
    progressTestDigest,
    classroom,
    adminEmail,
    roomUtilization,
  };
}

const INVOCATIONS_PER_JOB = 8;

/**
 * Latest invocations per jobKey (not a global recency window). A global
 * LIMIT used to let chatty 30-minute jobs push a daily job's only invocation
 * out of the window within hours, flipping its health evidence to stale
 * fallbacks; ranking per jobKey keeps every job's own proof visible.
 */
async function fetchCronInvocations(db: Database): Promise<CronInvocation[]> {
  try {
    const ranked = db
      .select({
        ...getTableColumns(schema.cronInvocations),
        rowNumber: sql<number>`row_number() over (partition by ${schema.cronInvocations.jobKey} order by ${schema.cronInvocations.receivedAt} desc)`.as("row_number"),
      })
      .from(schema.cronInvocations)
      .as("ranked");
    const rows = await db
      .select()
      .from(ranked)
      .where(lte(ranked.rowNumber, INVOCATIONS_PER_JOB))
      .orderBy(desc(ranked.receivedAt));
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- strips the window-rank helper column
    return rows.map(({ rowNumber: _rowNumber, ...invocation }) => invocation as CronInvocation);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("cron_invocations") || message.includes("relation") || message.includes("does not exist")) {
      console.info("cron_invocations table is unavailable; Data Health will use inferred run-table proof.");
      return [];
    }
    throw error;
  }
}

function overallFromJobs(jobs: CronJobHealth[]): DataHealthDashboardPayload["overall"] {
  const counts = {
    healthyCount: jobs.filter((job) => job.status === "healthy").length,
    lateCount: jobs.filter((job) => job.status === "late").length,
    failingCount: jobs.filter((job) => job.status === "failing").length,
    runningCount: jobs.filter((job) => job.status === "running").length,
    unknownCount: jobs.filter((job) => job.status === "unknown").length,
    manualOnlyCount: jobs.filter((job) => job.status === "manual-only").length,
  };
  const worst = jobs
    .filter((job) => !job.manualOnly)
    .sort((a, b) => statusRank(b.status) - statusRank(a.status))[0]?.status ?? "unknown";
  const status = worst === "unknown" && counts.healthyCount > 0 ? "healthy" : worst;
  const headline =
    status === "failing"
      ? "One or more operations are failing"
      : status === "late"
        ? "One or more crons are late"
        : status === "running"
          ? "Operations are currently running"
          : status === "unknown"
            ? "Cron health is not fully known yet"
            : "Operations are healthy";

  return {
    status,
    headline,
    detail: `${counts.healthyCount} healthy, ${counts.lateCount} late, ${counts.failingCount} failing, ${counts.runningCount} running, ${counts.manualOnlyCount} manual-only.`,
    ...counts,
  };
}

/**
 * Cron-job health only — the same status derivation `/data-health` renders,
 * without the snapshot/issue queries. Used by the cron watchdog sweep.
 */
export async function getCronJobsHealth(now = new Date()): Promise<CronJobHealth[]> {
  const db = getDb();
  const invocations = await fetchCronInvocations(db);
  const allRuns = await fetchAllRuns(db);
  return buildCronJobs(invocations, allRuns, now);
}

export async function getDataHealthDashboardPayload(now = new Date()): Promise<DataHealthDashboardPayload> {
  const db = getDb();

  const [lastSuccess] = await db
    .select()
    .from(schema.syncRuns)
    .where(eq(schema.syncRuns.status, "success"))
    .orderBy(desc(schema.syncRuns.finishedAt))
    .limit(1);

  const [lastFailure] = await db
    .select()
    .from(schema.syncRuns)
    .where(eq(schema.syncRuns.status, "failed"))
    .orderBy(desc(schema.syncRuns.finishedAt))
    .limit(1);

  const [activeSnapshot] = await db
    .select()
    .from(schema.snapshots)
    .where(eq(schema.snapshots.active, true))
    .limit(1);

  let stats: DataHealthDashboardPayload["stats"] = null;
  let issuesByType: Record<string, number> = {};
  let issueDetails: IssueDetails = {
    unresolvedAliases: [],
    unresolvedModality: [],
    unmappedTags: [],
  };

  if (activeSnapshot) {
    const [snapshotStat] = await db
      .select()
      .from(schema.snapshotStats)
      .where(eq(schema.snapshotStats.snapshotId, activeSnapshot.id))
      .limit(1);

    if (snapshotStat) {
      stats = {
        totalWiseTeachers: snapshotStat.totalWiseTeachers,
        totalIdentityGroups: snapshotStat.totalIdentityGroups,
        resolvedGroups: snapshotStat.resolvedGroups,
        unresolvedGroups: snapshotStat.unresolvedGroups,
        totalDataIssues: snapshotStat.totalDataIssues,
        totalQualifications: snapshotStat.totalQualifications,
        totalAvailabilityWindows: snapshotStat.totalAvailabilityWindows,
        totalLeaves: snapshotStat.totalLeaves,
        totalFutureSessions: snapshotStat.totalFutureSessions,
      };
      issuesByType = snapshotStat.issuesByType ?? {};
    }

    const issues = await db
      .select({
        type: schema.dataIssues.type,
        entityName: schema.dataIssues.entityName,
        message: schema.dataIssues.message,
      })
      .from(schema.dataIssues)
      .where(eq(schema.dataIssues.snapshotId, activeSnapshot.id));
    issueDetails = issueDetailsFromIssues(issues);
  }

  const invocations = await fetchCronInvocations(db);
  const allRuns = await fetchAllRuns(db);
  const cronJobs = buildCronJobs(invocations, allRuns, now);
  const staleAgeMs = lastSuccess?.finishedAt
    ? now.getTime() - new Date(lastSuccess.finishedAt).getTime()
    : null;

  const wiseSnapshot = {
    activeSnapshotId: activeSnapshot?.id ?? null,
    lastSuccessfulSync: iso(lastSuccess?.finishedAt),
    lastFailedSync: iso(lastFailure?.finishedAt),
    lastFailureError: lastFailure?.errorSummary ?? null,
    staleAgeMs,
    staleMinutes: staleAgeMs === null ? null : Math.round(staleAgeMs / 60000),
    stats,
  };

  return {
    checkedAt: now.toISOString(),
    overall: overallFromJobs(cronJobs),
    cronJobs,
    dataDomains: buildDomains(cronJobs, allRuns, stats, now),
    wiseSnapshot,
    issueSummary: issuesByType,
    issueDetails,
    recentRuns: buildRecentRuns(allRuns),
    manualActions: CRON_JOBS.map((job) => ({
      key: job.key,
      label: job.label,
      dangerous: job.dangerous,
      confirmationLabel: job.confirmationLabel,
    })),
    lastSuccessfulSync: wiseSnapshot.lastSuccessfulSync,
    lastFailedSync: wiseSnapshot.lastFailedSync,
    lastFailureError: wiseSnapshot.lastFailureError,
    staleAgeMs,
    staleMinutes: wiseSnapshot.staleMinutes,
    activeSnapshotId: wiseSnapshot.activeSnapshotId,
    stats,
    issuesByType,
    unresolvedAliases: issueDetails.unresolvedAliases,
    unresolvedModality: issueDetails.unresolvedModality,
    unmappedTags: issueDetails.unmappedTags,
    recentSyncs: allRuns.wise.map((run) => ({
      id: run.id,
      status: run.status,
      startedAt: run.startedAt.toISOString(),
      finishedAt: iso(run.finishedAt),
      teacherCount: run.teacherCount,
      errorSummary: run.errorSummary,
    })),
  };
}

export function dataHealthSummaryIsStale(payload: DataHealthDashboardPayload): boolean {
  return payload.staleAgeMs !== null && isApiSnapshotStale(payload.staleAgeMs);
}
