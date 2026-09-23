import "server-only";
import { desc, eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import type { Database } from "@/lib/db";

/** A manual sync request within this window of the last success is treated as already fresh. */
export const MANUAL_WISE_SYNC_FRESH_MS = 12 * 60_000;

/** How many completed syncs to sample when estimating a typical duration. */
const TYPICAL_DURATION_SAMPLE_SIZE = 5;

export type ManualWiseSyncDecision =
  | { action: "wait"; runningStartedAt: string }
  | { action: "skip_fresh"; finishedAt: string }
  | { action: "start" };

/**
 * Decide whether a manually triggered Wise sync should wait for an
 * already-running sync, skip because a recent success is still fresh, or
 * start a new one. A live running sync always wins over the freshness
 * heuristic, so it is checked first.
 */
export function decideManualWiseSync(input: {
  latestSuccessFinishedAt: Date | null;
  runningStartedAt: Date | null;
  now: Date;
}): ManualWiseSyncDecision {
  if (input.runningStartedAt) {
    return { action: "wait", runningStartedAt: input.runningStartedAt.toISOString() };
  }
  if (
    input.latestSuccessFinishedAt &&
    input.now.getTime() - input.latestSuccessFinishedAt.getTime() < MANUAL_WISE_SYNC_FRESH_MS
  ) {
    return { action: "skip_fresh", finishedAt: input.latestSuccessFinishedAt.toISOString() };
  }
  return { action: "start" };
}

/** Median duration of a set of completed syncs; null when there is no evidence. */
export function computeTypicalSyncDurationMs(durationsMs: number[]): number | null {
  if (durationsMs.length === 0) return null;
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export async function getLatestSuccessfulSyncFinishedAt(db: Database): Promise<Date | null> {
  const [row] = await db
    .select({ finishedAt: schema.syncRuns.finishedAt })
    .from(schema.syncRuns)
    .where(eq(schema.syncRuns.status, "success"))
    .orderBy(desc(schema.syncRuns.finishedAt))
    .limit(1);
  return row?.finishedAt ?? null;
}

export async function getRunningSyncStartedAt(db: Database): Promise<Date | null> {
  const [row] = await db
    .select({ startedAt: schema.syncRuns.startedAt })
    .from(schema.syncRuns)
    .where(eq(schema.syncRuns.status, "running"))
    .orderBy(desc(schema.syncRuns.startedAt))
    .limit(1);
  return row?.startedAt ?? null;
}

export async function getTypicalSyncDurationMs(db: Database): Promise<number | null> {
  const rows = await db
    .select({ startedAt: schema.syncRuns.startedAt, finishedAt: schema.syncRuns.finishedAt })
    .from(schema.syncRuns)
    .where(eq(schema.syncRuns.status, "success"))
    .orderBy(desc(schema.syncRuns.finishedAt))
    .limit(TYPICAL_DURATION_SAMPLE_SIZE);
  const durationsMs = rows
    .filter((row): row is { startedAt: Date; finishedAt: Date } => row.finishedAt !== null)
    .map(row => row.finishedAt.getTime() - row.startedAt.getTime());
  return computeTypicalSyncDurationMs(durationsMs);
}
