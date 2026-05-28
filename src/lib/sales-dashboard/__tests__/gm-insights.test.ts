import { describe, expect, it } from "vitest";
import {
  buildGmDashboardInsights,
  MONTHLY_NORMAL_SALES_TARGET,
} from "@/lib/sales-dashboard/gm-insights";
import type {
  SalesDashboardPayload,
  SalesDashboardSourceSummary,
  SalesDayAggregate,
  SalesDayRepAggregate,
} from "@/lib/sales-dashboard/types";

function rep(overrides: Partial<SalesDayRepAggregate>): SalesDayRepAggregate {
  return {
    rev: 0,
    count: 0,
    revT: 0,
    revN: 0,
    revR: 0,
    cntT: 0,
    cntN: 0,
    cntR: 0,
    ...overrides,
  };
}

function normalDay(overrides: Partial<SalesDayAggregate>): SalesDayAggregate {
  return {
    d: "2026-05-10",
    m: "2026-05 May",
    rev: 0,
    trial: 0,
    newS: 0,
    renew: 0,
    count: 0,
    revT: 0,
    revN: 0,
    revR: 0,
    pkgs: {},
    prgs: {},
    reps: {},
    dow: "Mon",
    ...overrides,
  };
}

function source(overrides: Partial<SalesDashboardSourceSummary> = {}): SalesDashboardSourceSummary {
  return {
    id: "source-1",
    sourceMonth: "2026-05-01",
    label: "2026-05 May",
    spreadsheetId: "sheet-1",
    spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-1/edit",
    normalSheetName: null,
    additionalSheetName: null,
    status: "active",
    lastImportedAt: "2026-05-15T10:00:00.000Z",
    lastImportError: null,
    lastNormalRowCount: 10,
    lastAdditionalRowCount: 1,
    connectedEmail: "admin@example.com",
    archivedAt: null,
    archivedByEmail: null,
    statusBeforeArchive: null,
    ...overrides,
  };
}

function payload(overrides: Partial<SalesDashboardPayload> = {}): SalesDashboardPayload {
  return {
    normalDays: [],
    addDays: [],
    pkgCount: {},
    progCount: {},
    addPkgCount: {},
    repArr: [],
    dayCount: {},
    totalTxn: 0,
    totalAddTxn: 0,
    uniqueTrials: 0,
    uniqueNewStudents: 0,
    uniqueRenewals: 0,
    churnedStudents: 0,
    eligibleStudents: 0,
    completionRate: { "15": 0.5 },
    completionMonths: 3,
    weekBandPct: [],
    churnList: [],
    trialCohort: [],
    retentionCohort: [],
    lastUpdated: "2026-05-15T10:00:00.000Z",
    sources: [source()],
    token: { connected: true, email: "admin@example.com", expiresAt: null, lastError: null },
    ...overrides,
  };
}

describe("GM sales dashboard insights", () => {
  it("projects month-end normal revenue from historical completion curves", () => {
    const insights = buildGmDashboardInsights(
      payload({
        normalDays: [
          normalDay({
            d: "2026-05-10",
            rev: 2_000_000,
            count: 20,
            revN: 1_600_000,
            revR: 400_000,
            reps: { Palm: rep({ rev: 2_000_000, count: 20, cntN: 16, cntR: 4 }) },
          }),
        ],
        addDays: [{ d: "2026-05-11", m: "2026-05 May", rev: 100_000, count: 2 }],
      }),
      { from: "2026-05-01", to: "2026-05-31" },
      new Date("2026-05-15T12:00:00.000Z"),
    );

    expect(insights.revenuePace.target).toBe(MONTHLY_NORMAL_SALES_TARGET);
    expect(insights.revenuePace.completionRatio).toBe(0.5);
    expect(insights.revenuePace.projectedNormalRevenue).toBe(4_000_000);
    expect(insights.revenuePace.currentGap).toBe(2_000_000);
    expect(insights.revenuePace.projectedGap).toBe(0);
    expect(Math.round(insights.revenuePace.dailyPaceNeeded)).toBe(125_000);
  });

  it("returns deterministic GM exceptions for stale, failed, pace, conversion, retention, and replacement risks", () => {
    const insights = buildGmDashboardInsights(
      payload({
        normalDays: [normalDay({ rev: 1_000_000, count: 5 })],
        trialCohort: [
          { nick: "a", trialDate: "2026-05-01", convertedDate: "2026-05-03" },
          { nick: "b", trialDate: "2026-05-02", convertedDate: null },
          { nick: "c", trialDate: "2026-05-03", convertedDate: null },
          { nick: "d", trialDate: "2026-05-04", convertedDate: null },
        ],
        retentionCohort: [
          { nick: "a", saleDate: "2026-01-01", validUntil: "2026-04-20", decisionDate: "2026-05-04", renewedDate: "2026-05-08", status: "Retained" },
          { nick: "b", saleDate: "2026-01-02", validUntil: "2026-04-21", decisionDate: "2026-05-05", renewedDate: null, status: "Churned" },
          { nick: "c", saleDate: "2026-01-03", validUntil: "2026-04-22", decisionDate: "2026-05-06", renewedDate: null, status: "Churned" },
          { nick: "d", saleDate: "2026-01-04", validUntil: "2026-04-23", decisionDate: "2026-05-07", renewedDate: null, status: "Churned" },
        ],
        lastUpdated: "2026-05-15T09:00:00.000Z",
        sources: [source({ lastImportError: "Sheet not found" })],
      }),
      { from: "2026-05-01", to: "2026-05-31" },
      new Date("2026-05-15T12:00:00.000Z"),
    );

    expect(insights.exceptions.map((item) => item.id)).toEqual([
      "source-failure",
      "source-stale",
      "behind-pace",
      "trial-conversion",
      "retention",
      "replacement",
    ]);
  });

  it("computes previous-equivalent-period deltas for the sales team table", () => {
    const insights = buildGmDashboardInsights(
      payload({
        normalDays: [
          normalDay({
            d: "2026-04-20",
            m: "2026-04 Apr",
            rev: 50_000,
            count: 2,
            reps: { Palm: rep({ rev: 50_000, count: 2, cntN: 2 }) },
          }),
          normalDay({
            d: "2026-05-10",
            rev: 100_000,
            count: 4,
            revN: 75_000,
            revR: 25_000,
            reps: { Palm: rep({ rev: 100_000, count: 4, cntN: 3, cntR: 1 }) },
          }),
        ],
      }),
      { from: "2026-05-01", to: "2026-05-31" },
      new Date("2026-05-15T12:00:00.000Z"),
    );

    expect(insights.salesTeam).toHaveLength(1);
    expect(insights.salesTeam[0]).toMatchObject({
      name: "Palm",
      revenue: 100_000,
      previousRevenue: 50_000,
      deltaRevenue: 50_000,
      deltaPct: 1,
      averageOrderValue: 25_000,
    });
  });
});
