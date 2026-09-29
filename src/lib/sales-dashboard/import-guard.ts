import { and, desc, eq, inArray, lt } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import type { SalesImportTrigger, SalesSourceStatus } from "@/lib/sales-dashboard/types";

export const STALE_RUNNING_SALES_IMPORT_MS = 20 * 60 * 1000;

const STALE_RUNNING_SALES_IMPORT_ERROR =
  "Sales dashboard import marked failed because it was still running after 20 minutes; likely timed out or the request was aborted.";

const STALE_RUNNING_SALES_PROJECTION_IMPORT_ERROR =
  "Sales dashboard projection import marked failed because it was still running after 20 minutes; likely timed out or the request was aborted.";

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

export interface SalesDashboardProjectionImportResult {
  sourceId: string;
  runId: string;
  projectionMonths: number;
  targetMonthlyRevenue: number | null;
  skipped?: false;
  alreadyRunning?: false;
  staleRunningImportsFailed?: number;
}

export interface SkippedSalesDashboardProjectionImportResult {
  sourceId: string;
  runId: string;
  projectionMonths: 0;
  targetMonthlyRevenue: null;
  skipped: true;
  alreadyRunning: true;
  runningStartedAt: string;
  message: string;
  staleRunningImportsFailed: number;
}

export type SalesDashboardProjectionImportOutcome =
  | SalesDashboardProjectionImportResult
  | SkippedSalesDashboardProjectionImportResult;

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

interface AcquireSalesProjectionImportRunInput {
  sourceId: string;
  triggerType: SalesImportTrigger;
  actorEmail: string;
  now: Date;
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  // drizzle-orm wraps driver errors in DrizzleQueryError; the SQLSTATE is on `.cause`.
  const candidate = err as { code?: unknown; cause?: { code?: unknown } };
  return candidate.code === "23505" || candidate.cause?.code === "23505";
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

/**
 * Projection imports share the monthly imports' 20-minute lease and entry routes
 * (all `maxDuration = 800`), but never flip a source status, so there is no
 * status to restore when a stale run is failed.
 */
export async function failStaleSalesDashboardProjectionImports(
  db: Database,
  sourceId: string,
  now: Date,
): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_RUNNING_SALES_IMPORT_MS);
  const rows = await db
    .update(schema.salesDashboardProjectionImportRuns)
    .set({
      status: "failed",
      finishedAt: now,
      errorSummary: STALE_RUNNING_SALES_PROJECTION_IMPORT_ERROR,
    })
    .where(
      and(
        eq(schema.salesDashboardProjectionImportRuns.sourceId, sourceId),
        eq(schema.salesDashboardProjectionImportRuns.status, "running"),
        lt(schema.salesDashboardProjectionImportRuns.startedAt, cutoff),
      ),
    )
    .returning({ id: schema.salesDashboardProjectionImportRuns.id });

  return rows.length;
}

async function findRunningSalesProjectionImportRun(
  db: Database,
  sourceId: string,
): Promise<RunningSalesImportRun | null> {
  const [running] = await db
    .select({
      id: schema.salesDashboardProjectionImportRuns.id,
      startedAt: schema.salesDashboardProjectionImportRuns.startedAt,
    })
    .from(schema.salesDashboardProjectionImportRuns)
    .where(
      and(
        eq(schema.salesDashboardProjectionImportRuns.sourceId, sourceId),
        eq(schema.salesDashboardProjectionImportRuns.status, "running"),
      ),
    )
    .orderBy(desc(schema.salesDashboardProjectionImportRuns.startedAt))
    .limit(1);

  return running ?? null;
}

function skippedProjectionImportResult(
  sourceId: string,
  running: RunningSalesImportRun,
  staleRunningImportsFailed: number,
): SkippedSalesDashboardProjectionImportResult {
  return {
    sourceId,
    runId: running.id,
    projectionMonths: 0,
    targetMonthlyRevenue: null,
    skipped: true,
    alreadyRunning: true,
    runningStartedAt: running.startedAt.toISOString(),
    staleRunningImportsFailed,
    message: "Sales dashboard projection import is already running.",
  };
}

export async function acquireSalesProjectionImportRun(
  db: Database,
  input: AcquireSalesProjectionImportRunInput,
): Promise<AcquiredSalesImportRun | SkippedSalesDashboardProjectionImportResult> {
  const staleRunningImportsFailed = await failStaleSalesDashboardProjectionImports(
    db,
    input.sourceId,
    input.now,
  );
  const currentRunning = await findRunningSalesProjectionImportRun(db, input.sourceId);

  if (currentRunning) {
    return skippedProjectionImportResult(input.sourceId, currentRunning, staleRunningImportsFailed);
  }

  try {
    const [run] = await db
      .insert(schema.salesDashboardProjectionImportRuns)
      .values({
        sourceId: input.sourceId,
        status: "running",
        triggerType: input.triggerType,
        actorEmail: input.actorEmail,
        startedAt: input.now,
      })
      .returning({ id: schema.salesDashboardProjectionImportRuns.id });

    return { runId: run.id, staleRunningImportsFailed };
  } catch (err) {
    if (!isUniqueViolation(err)) {
      throw err;
    }

    const running = await findRunningSalesProjectionImportRun(db, input.sourceId);
    if (!running) {
      throw err;
    }

    return skippedProjectionImportResult(input.sourceId, running, staleRunningImportsFailed);
  }
}
