import { eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getCreditControlPayload } from "@/lib/credit-control/service";
import { getDataHealthDashboardPayload } from "@/lib/data-health/dashboard";
import type { CronJobStatus } from "@/lib/data-health/types";
import { listLeaveRequests } from "@/lib/leave-requests/data";
import { canAccessHref, NAV_TOOLS, type NavBadgeKey, type NavToolId } from "@/lib/navigation/tools";
import { todayBangkok } from "@/lib/room-capacity/dates";
import { getGoogleTokenStatus } from "@/lib/sales-dashboard/google-oauth";
import { getPayrollPayload } from "@/lib/payroll/data";
import { getWiseReconciliationActionSummary } from "@/lib/wise-activity/reconciliation";

export type HomeSummaryStatus = "ok" | "error";

export interface HomeActionSummary {
  id: NavBadgeKey;
  toolId: NavToolId;
  label: string;
  href: string;
  value: number | null;
  detail: string;
  status: HomeSummaryStatus;
  error: string | null;
}

export interface HomeFreshnessSummary {
  status: HomeSummaryStatus;
  checkedAt: string | null;
  overallStatus: CronJobStatus | "unknown";
  overallHeadline: string;
  staleAgeMs: number | null;
  staleMinutes: number | null;
  wiseSnapshotLastSuccess: string | null;
  cronCounts: {
    healthy: number;
    late: number;
    failing: number;
    running: number;
    manualOnly: number;
    unknown: number;
  };
  googleSheets: {
    connected: boolean;
    writeConnected: boolean;
    email: string | null;
    lastError: string | null;
  };
  error: string | null;
}

export interface HomeSummaryPayload {
  generatedAt: string;
  actions: HomeActionSummary[];
  freshness: HomeFreshnessSummary;
}

interface SourceResult<T> {
  data: T | null;
  error: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Summary unavailable";
}

async function loadSource<T>(loader: () => Promise<T>): Promise<SourceResult<T>> {
  try {
    return { data: await loader(), error: null };
  } catch (error) {
    return { data: null, error: errorMessage(error) };
  }
}

function toolForBadge(badgeKey: NavBadgeKey) {
  const tool = NAV_TOOLS.find((item) => item.badgeKey === badgeKey);
  if (!tool) throw new Error(`Missing navigation tool for badge ${badgeKey}`);
  return tool;
}

function actionItem(
  badgeKey: NavBadgeKey,
  value: number | null,
  detail: string,
  error: string | null,
): HomeActionSummary {
  const tool = toolForBadge(badgeKey);
  return {
    id: badgeKey,
    toolId: tool.id,
    label: tool.label,
    href: tool.href,
    value: error ? null : value,
    detail: error ? "Summary unavailable" : detail,
    status: error ? "error" : "ok",
    error,
  };
}

async function countLinePendingReviews(db: Database): Promise<number> {
  const [row] = await db
    .select({ count: sql<string>`count(*)::text` })
    .from(schema.lineSchedulerReviews)
    .where(eq(schema.lineSchedulerReviews.status, "pending_review"));
  return Number(row?.count ?? "0");
}

async function countProgressTestActions(db: Database): Promise<{ due: number; approaching: number }> {
  const rows = await db
    .select({
      status: schema.progressTestCycleState.status,
      count: sql<string>`count(*)::text`,
    })
    .from(schema.progressTestCycleState)
    .where(inArray(schema.progressTestCycleState.status, ["due", "approaching"]))
    .groupBy(schema.progressTestCycleState.status);
  return {
    due: Number(rows.find((row) => row.status === "due")?.count ?? "0"),
    approaching: Number(rows.find((row) => row.status === "approaching")?.count ?? "0"),
  };
}

function freshnessError(email: string | null | undefined, message: string): HomeFreshnessSummary {
  return {
    status: "error",
    checkedAt: null,
    overallStatus: "unknown",
    overallHeadline: "Data freshness unavailable",
    staleAgeMs: null,
    staleMinutes: null,
    wiseSnapshotLastSuccess: null,
    cronCounts: {
      healthy: 0,
      late: 0,
      failing: 0,
      running: 0,
      manualOnly: 0,
      unknown: 0,
    },
    googleSheets: {
      connected: false,
      writeConnected: false,
      email: email?.trim().toLowerCase() ?? null,
      lastError: null,
    },
    error: message,
  };
}

export async function getHomeSummaryPayload(
  input: {
    allowedPages: string[] | null;
    email: string | null | undefined;
  },
  db: Database = getDb(),
): Promise<HomeSummaryPayload> {
  const canAccess = (badgeKey: NavBadgeKey) => canAccessHref(toolForBadge(badgeKey).href, input.allowedPages);
  const [
    leaveRequests,
    lineReviews,
    progressTests,
    creditControl,
    payroll,
    wiseReconciliation,
    dataHealth,
    googleSheets,
  ] = await Promise.all([
    canAccess("leaveRequests")
      ? loadSource(() => listLeaveRequests(db, { summaryOnly: true }))
      : Promise.resolve({ data: null, error: null }),
    canAccess("lineReviews")
      ? loadSource(() => countLinePendingReviews(db))
      : Promise.resolve({ data: null, error: null }),
    canAccess("progressTests")
      ? loadSource(() => countProgressTestActions(db))
      : Promise.resolve({ data: null, error: null }),
    canAccess("creditControl")
      ? loadSource(() => getCreditControlPayload(undefined, { clearRecoveredActionStates: false }))
      : Promise.resolve({ data: null, error: null }),
    canAccess("payroll")
      ? loadSource(() => getPayrollPayload(db, todayBangkok().slice(0, 7)))
      : Promise.resolve({ data: null, error: null }),
    canAccess("wiseReconciliation")
      ? loadSource(() => getWiseReconciliationActionSummary(db))
      : Promise.resolve({ data: null, error: null }),
    canAccess("dataHealth")
      ? loadSource(() => getDataHealthDashboardPayload())
      : Promise.resolve({ data: null, error: null }),
    loadSource(() => getGoogleTokenStatus(input.email, db)),
  ]);

  const actions = [
    canAccess("leaveRequests")
      ? actionItem(
        "leaveRequests",
        leaveRequests.data?.unreadActionCount ?? 0,
        `${leaveRequests.data?.cards.new ?? 0} new, ${leaveRequests.data?.cards.needsReview ?? 0} needs review`,
        leaveRequests.error,
      )
      : null,
    canAccess("lineReviews")
      ? actionItem(
        "lineReviews",
        lineReviews.data ?? 0,
        "Pending parent-message reviews",
        lineReviews.error,
      )
      : null,
    canAccess("progressTests")
      ? actionItem(
        "progressTests",
        (progressTests.data?.due ?? 0) + (progressTests.data?.approaching ?? 0),
        `${progressTests.data?.due ?? 0} due, ${progressTests.data?.approaching ?? 0} approaching`,
        progressTests.error,
      )
      : null,
    canAccess("creditControl")
      ? actionItem(
        "creditControl",
        creditControl.data?.summary.queue.students ?? 0,
        `${creditControl.data?.summary.packages.notify ?? 0} notify packages`,
        creditControl.error,
      )
      : null,
    canAccess("payroll")
      ? actionItem(
        "payroll",
        payroll.data?.summary.issueCount ?? 0,
        `${payroll.data?.summary.unresolvedTutorCount ?? 0} unresolved tutors`,
        payroll.error,
      )
      : null,
    canAccess("wiseReconciliation")
      ? actionItem(
        "wiseReconciliation",
        wiseReconciliation.data?.rowsNeedingReview ?? 0,
        wiseReconciliation.data?.selectedSourceLabel
          ? `${wiseReconciliation.data.rowsWithPersistedCandidates} matched of ${wiseReconciliation.data.saleRows} rows`
          : "No imported package-sales source",
        wiseReconciliation.error,
      )
      : null,
    canAccess("dataHealth")
      ? actionItem(
        "dataHealth",
        (dataHealth.data?.overall.lateCount ?? 0) + (dataHealth.data?.overall.failingCount ?? 0),
        dataHealth.data?.overall.detail ?? "Cron and freshness status",
        dataHealth.error,
      )
      : null,
  ].filter((item): item is HomeActionSummary => Boolean(item));

  const freshness = dataHealth.data
    ? {
      status: "ok" as const,
      checkedAt: dataHealth.data.checkedAt,
      overallStatus: dataHealth.data.overall.status,
      overallHeadline: dataHealth.data.overall.headline,
      staleAgeMs: dataHealth.data.staleAgeMs,
      staleMinutes: dataHealth.data.staleMinutes,
      wiseSnapshotLastSuccess: dataHealth.data.lastSuccessfulSync,
      cronCounts: {
        healthy: dataHealth.data.overall.healthyCount,
        late: dataHealth.data.overall.lateCount,
        failing: dataHealth.data.overall.failingCount,
        running: dataHealth.data.overall.runningCount,
        manualOnly: dataHealth.data.overall.manualOnlyCount,
        unknown: dataHealth.data.overall.unknownCount,
      },
      googleSheets: {
        connected: Boolean(googleSheets.data?.connected),
        writeConnected: Boolean(googleSheets.data?.writeConnected),
        email: googleSheets.data?.email ?? input.email?.trim().toLowerCase() ?? null,
        lastError: googleSheets.data?.lastError ?? googleSheets.error,
      },
      error: null,
    }
    : freshnessError(input.email, dataHealth.error ?? "Data Health is not accessible.");

  return {
    generatedAt: new Date().toISOString(),
    actions,
    freshness,
  };
}
