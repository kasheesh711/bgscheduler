import { describe, expect, it } from "vitest";
import type { GmDashboardInsights } from "@/lib/sales-dashboard/gm-insights";
import { buildOverviewExportRows } from "../gm-command-center";

function insightsFixture(): GmDashboardInsights {
  return {
    filteredNormalDays: [],
    filteredAdditionalDays: [],
    revenuePace: {
      target: 4_000_000,
      targetSource: "projection",
      normalRevenue: 1_000_000,
      additionalRevenue: 50_000,
      totalRevenue: 1_050_000,
      normalTransactions: 10,
      additionalTransactions: 2,
      completionRatio: 0.5,
      completionSamples: 3,
      projectedNormalRevenue: 2_000_000,
      currentGap: 3_000_000,
      projectedGap: 2_000_000,
      dailyPaceNeeded: 150_000,
      daysRemaining: 20,
      goalProgressPct: 25,
      projectedProgressPct: 50,
      referenceDate: "2026-06-10",
      isCurrentMonthRange: true,
    },
    pipeline: {
      trials: 4,
      newStudents: 3,
      renewals: 5,
      trialCohortSize: 8,
      trialConverted: 4,
      conversionRate: 0.5,
      retentionCohortSize: 10,
      retained: 7,
      churned: 3,
      retentionRate: 0.7,
      replacementRatio: 1,
    },
    exceptions: [
      {
        id: "stale-source",
        severity: "warning",
        title: "Stale source",
        detail: "Refresh sales imports",
        value: "90m",
      },
    ],
    salesTeam: [
      {
        name: "Alice Wong",
        revenue: 500_000,
        count: 5,
        trialCount: 1,
        newCount: 2,
        renewalCount: 2,
        averageOrderValue: 100_000,
        revenueShare: 0.5,
        previousRevenue: 400_000,
        deltaRevenue: 100_000,
        deltaPct: 0.25,
      },
    ],
    monthlyRevenue: [
      {
        label: "June 2026",
        shortLabel: "Jun 26",
        newRevenue: 300_000,
        renewalRevenue: 600_000,
        trialRevenue: 100_000,
        additionalRevenue: 50_000,
      },
    ],
    actualVsProjection: [
      {
        month: "2026-06-01",
        label: "Jun '26",
        actualNormalRevenue: 1_000_000,
        baseProjectedRevenue: 1_200_000,
        bearProjectedRevenue: 900_000,
        bullProjectedRevenue: 1_500_000,
        varianceToBase: -200_000,
        variancePctToBase: -0.1667,
        roomUtilization: 0.7,
      },
    ],
    programMix: [{ label: "Math", count: 3, revenue: 300_000, share: 0.3 }],
    packageMix: [{ label: "20h", count: 2, revenue: 200_000, share: 0.2 }],
    paymentConcentration: [{ label: "Alice Wong", count: 5, revenue: 500_000, share: 0.5 }],
    failedSourceCount: 0,
  };
}

describe("buildOverviewExportRows", () => {
  it("exports command-center sections with stable metric labels", () => {
    const rows = buildOverviewExportRows(insightsFixture());

    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ section: "Revenue Pace", label: "Normal sales", metric: "normalRevenue", value: 1_000_000 }),
        expect.objectContaining({ section: "Pipeline", label: "Trial conversion", metric: "conversionRate", value: 0.5 }),
        expect.objectContaining({ section: "GM Exceptions", label: "Stale source", metric: "warning", value: "90m" }),
        expect.objectContaining({ section: "Sales Team", label: "Alice Wong", metric: "revenue", value: 500_000 }),
        expect.objectContaining({ section: "Monthly Revenue", label: "June 2026", metric: "newRevenue", value: 300_000 }),
        expect.objectContaining({ section: "Actual vs Projection", label: "Jun '26", metric: "varianceToBase", value: -200_000 }),
        expect.objectContaining({ section: "Program Mix", label: "Math", metric: "revenue", value: 300_000 }),
        expect.objectContaining({ section: "Package Mix", label: "20h", metric: "share", value: 0.2 }),
        expect.objectContaining({ section: "Payment Concentration", label: "Alice Wong", metric: "count", value: 5 }),
      ]),
    );
  });
});
