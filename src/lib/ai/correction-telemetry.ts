import { desc } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { confidenceBand, type ConfidenceBand } from "@/lib/line/confidence";

export interface CorrectionOutcomeCounts {
  accept: number;
  edit: number;
  reject: number;
  dismiss: number;
  total: number;
}

export interface CorrectionConfidenceRow extends CorrectionOutcomeCounts {
  band: ConfidenceBand | "unknown";
}

export interface CorrectionTelemetry {
  totalActions: number;
  acceptRate: number;
  editRate: number;
  rejectRate: number;
  dismissRate: number;
  avgTimeToReviewMs: number | null;
  p50TimeToReviewMs: number | null;
  confidenceByOutcome: CorrectionConfidenceRow[];
}

function emptyCounts(): CorrectionOutcomeCounts {
  return { accept: 0, edit: 0, reject: 0, dismiss: 0, total: 0 };
}

function addAction(counts: CorrectionOutcomeCounts, action: string): void {
  if (action === "accept" || action === "edit" || action === "reject" || action === "dismiss") {
    counts[action] += 1;
  }
  counts.total += 1;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

export async function getCorrectionTelemetry(db: Database): Promise<CorrectionTelemetry> {
  const rows = await db
    .select({
      action: schema.aiSchedulerFeedback.action,
      classifierConfidence: schema.aiSchedulerFeedback.classifierConfidence,
      timeToReviewMs: schema.aiSchedulerFeedback.timeToReviewMs,
    })
    .from(schema.aiSchedulerFeedback)
    .orderBy(desc(schema.aiSchedulerFeedback.createdAt))
    .limit(5000);

  const overall = emptyCounts();
  const byBand = new Map<ConfidenceBand | "unknown", CorrectionOutcomeCounts>();
  const times: number[] = [];

  for (const row of rows) {
    addAction(overall, row.action);
    const band = confidenceBand(row.classifierConfidence) ?? "unknown";
    const bucket = byBand.get(band) ?? emptyCounts();
    addAction(bucket, row.action);
    byBand.set(band, bucket);
    if (typeof row.timeToReviewMs === "number") times.push(row.timeToReviewMs);
  }

  const total = overall.total;
  const rate = (count: number): number => (total > 0 ? count / total : 0);
  const avg = times.length > 0 ? times.reduce((sum, value) => sum + value, 0) / times.length : null;

  const bandOrder: Array<ConfidenceBand | "unknown"> = ["high", "medium", "low", "unknown"];
  const confidenceByOutcome = bandOrder
    .filter((band) => byBand.has(band))
    .map((band) => ({ band, ...byBand.get(band)! }));

  return {
    totalActions: total,
    acceptRate: rate(overall.accept),
    editRate: rate(overall.edit),
    rejectRate: rate(overall.reject),
    dismissRate: rate(overall.dismiss),
    avgTimeToReviewMs: avg,
    p50TimeToReviewMs: percentile(times, 50),
    confidenceByOutcome,
  };
}
