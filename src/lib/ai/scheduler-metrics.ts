import { desc } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";

export interface AiSchedulerMetrics {
  totalRuns: number;
  solvedRuns: number;
  needsClarificationRuns: number;
  failedRuns: number;
  parentReadyConstraintFailures: number;
  latency: {
    p50Ms: number | null;
    p95Ms: number | null;
    averageMs: number | null;
    averageDbMs: number | null;
    averageModelMs: number | null;
    averageSearchMs: number | null;
  };
  versions: Array<{ schedulerVersion: string; promptVersion: string; count: number }>;
  recentFailures: Array<{
    id: string;
    createdAt: string;
    errorMessage: string | null;
    inputPreviewRedacted: string;
  }>;
}

interface LatencyBreakdownPayload {
  dbMs?: unknown;
  modelMs?: unknown;
  searchMs?: unknown;
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

function hasConstraintFailure(solverPayload: Record<string, unknown> | null): boolean {
  const ledger = solverPayload?.constraintLedger;
  if (!Array.isArray(ledger)) return false;
  return ledger.some((item) => (
    item &&
    typeof item === "object" &&
    "status" in item &&
    item.status === "needs_clarification"
  ));
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export async function getAiSchedulerMetrics(db: Database): Promise<AiSchedulerMetrics> {
  const rows = await db
    .select({
      id: schema.aiSchedulerRuns.id,
      status: schema.aiSchedulerRuns.status,
      inputPreviewRedacted: schema.aiSchedulerRuns.inputPreviewRedacted,
      schedulerVersion: schema.aiSchedulerRuns.schedulerVersion,
      promptVersion: schema.aiSchedulerRuns.promptVersion,
      latencyMs: schema.aiSchedulerRuns.latencyMs,
      latencyBreakdown: schema.aiSchedulerRuns.latencyBreakdown,
      solverPayload: schema.aiSchedulerRuns.solverPayload,
      errorMessage: schema.aiSchedulerRuns.errorMessage,
      createdAt: schema.aiSchedulerRuns.createdAt,
    })
    .from(schema.aiSchedulerRuns)
    .orderBy(desc(schema.aiSchedulerRuns.createdAt))
    .limit(500);

  const latencies = rows
    .map((row) => row.latencyMs)
    .filter((value): value is number => typeof value === "number");
  const breakdowns = rows
    .map((row) => row.latencyBreakdown as LatencyBreakdownPayload | null)
    .filter((value): value is LatencyBreakdownPayload => Boolean(value));
  const dbLatencies = breakdowns.map((value) => numeric(value.dbMs)).filter((value): value is number => value !== null);
  const modelLatencies = breakdowns.map((value) => numeric(value.modelMs)).filter((value): value is number => value !== null);
  const searchLatencies = breakdowns.map((value) => numeric(value.searchMs)).filter((value): value is number => value !== null);

  const versionCounts = new Map<string, { schedulerVersion: string; promptVersion: string; count: number }>();
  for (const row of rows) {
    const schedulerVersion = row.schedulerVersion ?? "unknown";
    const promptVersion = row.promptVersion ?? "unknown";
    const key = `${schedulerVersion}\n${promptVersion}`;
    const entry = versionCounts.get(key) ?? { schedulerVersion, promptVersion, count: 0 };
    entry.count += 1;
    versionCounts.set(key, entry);
  }

  return {
    totalRuns: rows.length,
    solvedRuns: rows.filter((row) => row.status === "solved").length,
    needsClarificationRuns: rows.filter((row) => row.status === "needs_clarification").length,
    failedRuns: rows.filter((row) => row.status === "failed").length,
    parentReadyConstraintFailures: rows.filter((row) => (
      row.status === "solved" &&
      hasConstraintFailure(row.solverPayload)
    )).length,
    latency: {
      p50Ms: percentile(latencies, 50),
      p95Ms: percentile(latencies, 95),
      averageMs: average(latencies),
      averageDbMs: average(dbLatencies),
      averageModelMs: average(modelLatencies),
      averageSearchMs: average(searchLatencies),
    },
    versions: [...versionCounts.values()].sort((a, b) => b.count - a.count),
    recentFailures: rows
      .filter((row) => row.status === "failed")
      .slice(0, 10)
      .map((row) => ({
        id: row.id,
        createdAt: iso(row.createdAt),
        errorMessage: row.errorMessage,
        inputPreviewRedacted: row.inputPreviewRedacted,
      })),
  };
}
