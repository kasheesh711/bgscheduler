import { describe, expect, it } from "vitest";
import { getCorrectionTelemetry } from "@/lib/ai/correction-telemetry";
import type { Database } from "@/lib/db";

type FeedbackRow = { action: string; classifierConfidence: number | null; timeToReviewMs: number | null };

function dbReturning(rows: FeedbackRow[]): Database {
  return {
    select: () => ({
      from: () => ({
        orderBy: () => ({
          limit: async () => rows,
        }),
      }),
    }),
  } as unknown as Database;
}

describe("getCorrectionTelemetry", () => {
  it("computes outcome rates that sum to 1", async () => {
    const result = await getCorrectionTelemetry(dbReturning([
      { action: "accept", classifierConfidence: 0.9, timeToReviewMs: 1000 },
      { action: "edit", classifierConfidence: 0.7, timeToReviewMs: 3000 },
      { action: "reject", classifierConfidence: 0.4, timeToReviewMs: 5000 },
      { action: "dismiss", classifierConfidence: 0.5, timeToReviewMs: null },
    ]));

    expect(result.totalActions).toBe(4);
    expect(result.acceptRate).toBeCloseTo(0.25);
    expect(result.editRate).toBeCloseTo(0.25);
    expect(result.rejectRate).toBeCloseTo(0.25);
    expect(result.dismissRate).toBeCloseTo(0.25);
  });

  it("buckets confidence by band and counts by action", async () => {
    const result = await getCorrectionTelemetry(dbReturning([
      { action: "accept", classifierConfidence: 0.95, timeToReviewMs: 1000 },
      { action: "edit", classifierConfidence: 0.7, timeToReviewMs: 2000 },
      { action: "reject", classifierConfidence: 0.3, timeToReviewMs: 4000 },
      { action: "dismiss", classifierConfidence: null, timeToReviewMs: 6000 },
    ]));

    const byBand = Object.fromEntries(result.confidenceByOutcome.map((row) => [row.band, row]));
    expect(byBand.high.accept).toBe(1);
    expect(byBand.medium.edit).toBe(1);
    expect(byBand.low.reject).toBe(1);
    expect(byBand.unknown.dismiss).toBe(1);
    expect(byBand.unknown.total).toBe(1);
  });

  it("handles an empty feedback table", async () => {
    const result = await getCorrectionTelemetry(dbReturning([]));
    expect(result.totalActions).toBe(0);
    expect(result.acceptRate).toBe(0);
    expect(result.avgTimeToReviewMs).toBeNull();
    expect(result.p50TimeToReviewMs).toBeNull();
    expect(result.confidenceByOutcome).toEqual([]);
  });

  it("averages time only over rows that recorded timing", async () => {
    const result = await getCorrectionTelemetry(dbReturning([
      { action: "accept", classifierConfidence: 0.9, timeToReviewMs: 1000 },
      { action: "accept", classifierConfidence: 0.9, timeToReviewMs: 3000 },
      { action: "accept", classifierConfidence: 0.9, timeToReviewMs: null },
    ]));

    expect(result.avgTimeToReviewMs).toBe(2000);
    expect(result.p50TimeToReviewMs).toBe(3000);
  });
});
