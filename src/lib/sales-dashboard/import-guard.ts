import { and, desc, eq, inArray, lt } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import type { SalesImportTrigger, SalesSourceStatus } from "@/lib/sales-dashboard/types";

export const STALE_RUNNING_SALES_IMPORT_MS = 20 * 60 * 1000;

const STALE_RUNNING_SALES_IMPORT_ERROR =
  "Sales dashboard import marked failed because it was still running after 20 minutes; likely timed out or the request was aborted.";

interface RunningSalesImportRun {
  id: string;
  startedAt: Date;
}

export interface SalesDashboardImportResult {
  sourceId: string;
  runId: string;
  normalRows: number;
  additionalRows: number;
  skipped?: false;
  alreadyRunning?: false;
  staleRunningImportsFailed?: number;
}

export interface SkippedSalesDashboardImportResult {
  sourceId: string;
  runId: string;
  normalRows: 0;
  additionalRows: 0;
  skipped: true;
  alreadyRunning: true;
  runningStartedAt: string;
  message: string;
  staleRunningImportsFailed: number;
}

export type SalesDashboardImportOutcome =
  | SalesDashboardImportResult
  | SkippedSalesDashboardImportResult;

interface AcquireSalesImportRunInput {
  sourceId: string;
  sourceLabel: string;
  previousStatus: SalesSourceStatus;
  triggerType: SalesImportTrigger;
  actorEmail: string;
  now: Date;
  staleRunningImportsFailed?: number;
}

interface AcquiredSalesImportRun {
  runId: string;
  staleRunningImportsFailed: number;
  skipped?: false;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "23505"
  );
}

function metadataStatus(value: unknown): "active" | "finalized" | "reopened" {
  if (value === "active" || value === "finalized" || value === "reopened") {
    return value;
  }
  return "active";
}

async function restoreStaleSourceStatuses(
  db: Database,
  rows: Array<{ sourceId: string | null; metadata: Record<string, unknown> }>,
  now: Date,
): Promise<void> {
  const statusBySourceId = new Map<string, "active" | "finalized" | "reopened">();
  for (const row of rows) {
    if (!row.sourceId) continue;
    statusBySourceId.set(row.sourceId, metadataStatus(row.metadata.previousStatus));
  }

  for (const status of ["active", "finalized", "reopened"] as const) {
    const sourceIds = [...statusBySourceId]
      .filter(([, sourceStatus]) => sourceStatus === status)
      .map(([sourceId]) => sourceId);
    if (sourceIds.length === 0) continue;
    await db
      .update(schema.salesDashboardSources)
      .set({ status, updatedAt: now })
      .where(inArray(schema.salesDashboardSources.id, sourceIds));
  }
}

export async function failStaleSalesDashboardImports(
  db: Database,
  sourceId: string,
  now: Date,
): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_RUNNING_SALES_IMPORT_MS);
  const rows = await db
    .update(schema.salesDashboardImportRuns)
    .set({
      status: "failed",
      finishedAt: now,
      errorSummary: STALE_RUNNING_SALES_IMPORT_ERROR,
    })
    .where(
      and(
        eq(schema.salesDashboardImportRuns.sourceId, sourceId),
        eq(schema.salesDashboardImportRuns.status, "running"),
        lt(schema.salesDashboardImportRuns.startedAt, cutoff),
      ),
    )
    .returning({
      id: schema.salesDashboardImportRuns.id,
      sourceId: schema.salesDashboardImportRuns.sourceId,
      metadata: schema.salesDashboardImportRuns.metadata,
    });

  await restoreStaleSourceStatuses(db, rows, now);
  return rows.length;
}

async function findRunningSalesImportRun(
  db: Database,
  sourceId: string,
): Promise<RunningSalesImportRun | null> {
  const [running] = await db
    .select({
      id: schema.salesDashboardImportRuns.id,
      startedAt: schema.salesDashboardImportRuns.startedAt,
    })
    .from(schema.salesDashboardImportRuns)
    .where(
      and(
        eq(schema.salesDashboardImportRuns.sourceId, sourceId),
        eq(schema.salesDashboardImportRuns.status, "running"),
      ),
    )
    .orderBy(desc(schema.salesDashboardImportRuns.startedAt))
    .limit(1);

  return running ?? null;
}

function skippedImportResult(
  sourceId: string,
  sourceLabel: string,
  running: RunningSalesImportRun,
  staleRunningImportsFailed: number,
): SkippedSalesDashboardImportResult {
  return {
    sourceId,
    runId: running.id,
    normalRows: 0,
    additionalRows: 0,
    skipped: true,
    alreadyRunning: true,
    runningStartedAt: running.startedAt.toISOString(),
    staleRunningImportsFailed,
    message: `Sales dashboard import for ${sourceLabel} is already running.`,
  };
}

export async function acquireSalesImportRun(
  db: Database,
  input: AcquireSalesImportRunInput,
): Promise<AcquiredSalesImportRun | SkippedSalesDashboardImportResult> {
  const staleRunningImportsFailed = input.staleRunningImportsFailed
    ?? await failStaleSalesDashboardImports(db, input.sourceId, input.now);
  const currentRunning = await findRunningSalesImportRun(db, input.sourceId);

  if (currentRunning) {
    return skippedImportResult(
      input.sourceId,
      input.sourceLabel,
      currentRunning,
      staleRunningImportsFailed,
    );
  }

  try {
    const [run] = await db
      .insert(schema.salesDashboardImportRuns)
      .values({
        sourceId: input.sourceId,
        triggerType: input.triggerType,
        actorEmail: input.actorEmail,
        sourceCount: 1,
        startedAt: input.now,
        metadata: { previousStatus: input.previousStatus },
      })
      .returning({ id: schema.salesDashboardImportRuns.id });

    return { runId: run.id, staleRunningImportsFailed };
  } catch (err) {
    if (!isUniqueViolation(err)) {
      throw err;
    }

    const running = await findRunningSalesImportRun(db, input.sourceId);
    if (!running) {
      throw err;
    }

    return skippedImportResult(
      input.sourceId,
      input.sourceLabel,
      running,
      staleRunningImportsFailed,
    );
  }
}
