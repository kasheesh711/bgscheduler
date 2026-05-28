import {
  addDaysIso,
  currentBangkokDate,
  currentBangkokMonthEnd,
  dateComparisonValue,
} from "./dates";
import type {
  SalesAdditionalDayAggregate,
  SalesDashboardPayload,
  SalesDayAggregate,
  SalesDayRepAggregate,
} from "./types";

export const MONTHLY_NORMAL_SALES_TARGET = 4_000_000;
const STALE_SOURCE_MINUTES = 90;
const DAY_MS = 86_400_000;
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export type GmExceptionSeverity = "critical" | "warning" | "info";

export interface GmException {
  id: string;
  severity: GmExceptionSeverity;
  title: string;
  detail: string;
  value?: string;
}

export interface RevenuePaceInsight {
  target: number;
  normalRevenue: number;
  additionalRevenue: number;
  totalRevenue: number;
  normalTransactions: number;
  additionalTransactions: number;
  completionRatio: number;
  completionSamples: number;
  projectedNormalRevenue: number;
  currentGap: number;
  projectedGap: number;
  dailyPaceNeeded: number;
  daysRemaining: number;
  goalProgressPct: number;
  projectedProgressPct: number;
  referenceDate: string;
  isCurrentMonthRange: boolean;
}

export interface PipelineInsight {
  trials: number;
  newStudents: number;
  renewals: number;
  trialCohortSize: number;
  trialConverted: number;
  conversionRate: number;
  retentionCohortSize: number;
  retained: number;
  churned: number;
  retentionRate: number;
  replacementRatio: number | null;
}

export interface SalesTeamInsightRow {
  name: string;
  revenue: number;
  count: number;
  trialCount: number;
  newCount: number;
  renewalCount: number;
  averageOrderValue: number;
  revenueShare: number;
  previousRevenue: number;
  deltaRevenue: number;
  deltaPct: number | null;
}

export interface MixInsightRow {
  label: string;
  count: number;
  revenue: number;
  share: number;
}

export interface MonthlyRevenueInsight {
  label: string;
  shortLabel: string;
  newRevenue: number;
  renewalRevenue: number;
  trialRevenue: number;
  additionalRevenue: number;
}

export interface GmDashboardInsights {
  filteredNormalDays: SalesDayAggregate[];
  filteredAdditionalDays: SalesAdditionalDayAggregate[];
  revenuePace: RevenuePaceInsight;
  pipeline: PipelineInsight;
  exceptions: GmException[];
  salesTeam: SalesTeamInsightRow[];
  monthlyRevenue: MonthlyRevenueInsight[];
  programMix: MixInsightRow[];
  packageMix: MixInsightRow[];
  paymentConcentration: MixInsightRow[];
  failedSourceCount: number;
}

export function buildGmDashboardInsights(
  data: SalesDashboardPayload,
  range: { from: string; to: string },
  now = new Date(),
): GmDashboardInsights {
  const today = currentBangkokDate(now);
  const effectiveTo = range.from <= today && range.to > today ? today : range.to;
  const filteredNormalDays = filterByRange(data.normalDays, range.from, range.to);
  const filteredAdditionalDays = filterByRange(data.addDays, range.from, range.to);
  const activeSources = data.sources.filter((source) => source.status !== "archived");
  const failedSourceCount = activeSources.filter((source) => source.lastImportError).length;
  const pipeline = buildPipeline(data, range.from, effectiveTo);
  const revenuePace = buildRevenuePace(data, filteredNormalDays, filteredAdditionalDays, range, effectiveTo, now);
  const salesTeam = buildSalesTeamRows(data.normalDays, filteredNormalDays, range.from, effectiveTo);
  const exceptions = buildExceptions(data, revenuePace, pipeline, failedSourceCount, now);

  return {
    filteredNormalDays,
    filteredAdditionalDays,
    revenuePace,
    pipeline,
    exceptions,
    salesTeam,
    monthlyRevenue: buildMonthlyRevenue(filteredNormalDays, filteredAdditionalDays),
    programMix: buildCountMix(filteredNormalDays, "program"),
    packageMix: buildCountMix(filteredNormalDays, "package"),
    paymentConcentration: buildPaymentConcentration(filteredNormalDays),
    failedSourceCount,
  };
}

export function filterByRange<T extends { d: string }>(rows: T[], from: string, to: string): T[] {
  return rows.filter((row) => row.d >= from && row.d <= to);
}

function buildRevenuePace(
  data: SalesDashboardPayload,
  normalDays: SalesDayAggregate[],
  additionalDays: SalesAdditionalDayAggregate[],
  range: { from: string; to: string },
  effectiveTo: string,
  now: Date,
): RevenuePaceInsight {
  const normalRevenue = sum(normalDays, (row) => row.rev);
  const additionalRevenue = sum(additionalDays, (row) => row.rev);
  const normalTransactions = sum(normalDays, (row) => row.count);
  const additionalTransactions = sum(additionalDays, (row) => row.count);
  const referenceDay = Number(effectiveTo.slice(8, 10));
  const fallbackCompletion = referenceDay / daysInMonth(effectiveTo);
  const sampledCompletion = data.completionMonths > 0 ? data.completionRate[String(referenceDay)] : undefined;
  const completionRatio = clamp(sampledCompletion && sampledCompletion > 0 ? sampledCompletion : fallbackCompletion, 0.01, 1);
  const projectedNormalRevenue = normalRevenue > 0 ? normalRevenue / completionRatio : 0;
  const currentGap = Math.max(0, MONTHLY_NORMAL_SALES_TARGET - normalRevenue);
  const projectedGap = Math.max(0, MONTHLY_NORMAL_SALES_TARGET - projectedNormalRevenue);
  const isCurrentMonthRange = range.from.slice(0, 7) === currentBangkokDate(now).slice(0, 7);
  const paceEnd = isCurrentMonthRange ? currentBangkokMonthEnd(now) : range.to;
  const daysRemaining = Math.max(0, daysBetween(effectiveTo, paceEnd));
  const dailyPaceNeeded = currentGap > 0 ? currentGap / Math.max(1, daysRemaining) : 0;

  return {
    target: MONTHLY_NORMAL_SALES_TARGET,
    normalRevenue,
    additionalRevenue,
    totalRevenue: normalRevenue + additionalRevenue,
    normalTransactions,
    additionalTransactions,
    completionRatio,
    completionSamples: data.completionMonths,
    projectedNormalRevenue,
    currentGap,
    projectedGap,
    dailyPaceNeeded,
    daysRemaining,
    goalProgressPct: Math.min(100, Math.round((normalRevenue / MONTHLY_NORMAL_SALES_TARGET) * 100)),
    projectedProgressPct: Math.min(140, Math.round((projectedNormalRevenue / MONTHLY_NORMAL_SALES_TARGET) * 100)),
    referenceDate: effectiveTo,
    isCurrentMonthRange,
  };
}

function buildPipeline(data: SalesDashboardPayload, from: string, to: string): PipelineInsight {
  const normalDays = filterByRange(data.normalDays, from, to);
  const trials = sum(normalDays, (row) => row.trial);
  const newStudents = sum(normalDays, (row) => row.newS);
  const renewals = sum(normalDays, (row) => row.renew);
  const trialCohort = data.trialCohort.filter((row) => row.trialDate >= from && row.trialDate <= to);
  const trialConverted = trialCohort.filter((row) => row.convertedDate !== null && row.convertedDate <= to).length;
  const retentionCohort = data.retentionCohort.filter((row) => row.decisionDate >= from && row.decisionDate <= to);
  const retained = retentionCohort.filter((row) => row.renewedDate !== null).length;
  const churned = retentionCohort.filter((row) => row.status === "Churned").length;
  const conversionRate = trialCohort.length > 0 ? trialConverted / trialCohort.length : 0;
  const retentionRate = retentionCohort.length > 0 ? retained / retentionCohort.length : 0;

  return {
    trials,
    newStudents,
    renewals,
    trialCohortSize: trialCohort.length,
    trialConverted,
    conversionRate,
    retentionCohortSize: retentionCohort.length,
    retained,
    churned,
    retentionRate,
    replacementRatio: churned > 0 ? trialConverted / churned : null,
  };
}

function buildSalesTeamRows(
  allNormalDays: SalesDayAggregate[],
  currentNormalDays: SalesDayAggregate[],
  from: string,
  effectiveTo: string,
): SalesTeamInsightRow[] {
  const current = aggregateReps(currentNormalDays);
  const dayCount = Math.max(1, daysBetween(from, effectiveTo) + 1);
  const previousTo = addDaysIso(from, -1);
  const previousFrom = addDaysIso(previousTo, -(dayCount - 1));
  const previous = aggregateReps(filterByRange(allNormalDays, previousFrom, previousTo));
  const totalRevenue = sum([...current.values()], (row) => row.rev);

  return [...current.entries()]
    .map(([name, row]) => {
      const previousRevenue = previous.get(name)?.rev ?? 0;
      return {
        name,
        revenue: row.rev,
        count: row.count,
        trialCount: row.cntT,
        newCount: row.cntN,
        renewalCount: row.cntR,
        averageOrderValue: row.count > 0 ? row.rev / row.count : 0,
        revenueShare: totalRevenue > 0 ? row.rev / totalRevenue : 0,
        previousRevenue,
        deltaRevenue: row.rev - previousRevenue,
        deltaPct: previousRevenue > 0 ? (row.rev - previousRevenue) / previousRevenue : null,
      };
    })
    .sort((left, right) => right.revenue - left.revenue);
}

function aggregateReps(days: SalesDayAggregate[]): Map<string, SalesDayRepAggregate> {
  const map = new Map<string, SalesDayRepAggregate>();
  for (const day of days) {
    for (const [rep, row] of Object.entries(day.reps)) {
      const existing = map.get(rep) ?? { rev: 0, count: 0, revT: 0, revN: 0, revR: 0, cntT: 0, cntN: 0, cntR: 0 };
      existing.rev += row.rev;
      existing.count += row.count;
      existing.revT += row.revT;
      existing.revN += row.revN;
      existing.revR += row.revR;
      existing.cntT += row.cntT;
      existing.cntN += row.cntN;
      existing.cntR += row.cntR;
      map.set(rep, existing);
    }
  }
  return map;
}

function buildExceptions(
  data: SalesDashboardPayload,
  revenuePace: RevenuePaceInsight,
  pipeline: PipelineInsight,
  failedSourceCount: number,
  now: Date,
): GmException[] {
  const exceptions: GmException[] = [];
  const staleMinutes = minutesSince(data.lastUpdated, now);

  if (failedSourceCount > 0) {
    exceptions.push({
      id: "source-failure",
      severity: "critical",
      title: "Source import failed",
      detail: `${failedSourceCount} active source${failedSourceCount === 1 ? "" : "s"} need attention before the next readout.`,
      value: String(failedSourceCount),
    });
  }

  if (staleMinutes === null) {
    exceptions.push({
      id: "source-never-imported",
      severity: "warning",
      title: "No import timestamp",
      detail: "Sales data has not reported a successful import timestamp.",
    });
  } else if (staleMinutes > STALE_SOURCE_MINUTES) {
    exceptions.push({
      id: "source-stale",
      severity: "warning",
      title: "Sales data is stale",
      detail: `Last successful import was ${Math.round(staleMinutes)} minutes ago.`,
      value: `${Math.round(staleMinutes)}m`,
    });
  }

  if (revenuePace.projectedNormalRevenue < revenuePace.target) {
    exceptions.push({
      id: "behind-pace",
      severity: revenuePace.projectedGap > revenuePace.target * 0.15 ? "critical" : "warning",
      title: "Behind monthly pace",
      detail: `Projected normal sales are short by ${formatCompactMoney(revenuePace.projectedGap)} at the current curve.`,
      value: formatCompactMoney(revenuePace.projectedGap),
    });
  }

  if (pipeline.trialCohortSize > 0 && pipeline.conversionRate < 0.35) {
    exceptions.push({
      id: "trial-conversion",
      severity: "warning",
      title: "Trial conversion below floor",
      detail: `${pipeline.trialConverted}/${pipeline.trialCohortSize} first trials converted in this period.`,
      value: formatPercent(pipeline.conversionRate),
    });
  }

  if (pipeline.retentionCohortSize > 0 && pipeline.retentionRate < 0.5) {
    exceptions.push({
      id: "retention",
      severity: "critical",
      title: "Retention below floor",
      detail: `${pipeline.retained}/${pipeline.retentionCohortSize} renewal decisions retained.`,
      value: formatPercent(pipeline.retentionRate),
    });
  }

  if (pipeline.replacementRatio !== null && pipeline.replacementRatio < 1) {
    exceptions.push({
      id: "replacement",
      severity: "critical",
      title: "Churn replacement is weak",
      detail: `${pipeline.trialConverted} trial conversions against ${pipeline.churned} churned students.`,
      value: `${pipeline.replacementRatio.toFixed(2)}x`,
    });
  }

  return exceptions;
}

function buildMonthlyRevenue(
  normalDays: SalesDayAggregate[],
  additionalDays: SalesAdditionalDayAggregate[],
): MonthlyRevenueInsight[] {
  const map = new Map<string, MonthlyRevenueInsight>();
  for (const row of normalDays) {
    const existing = ensureMonth(map, row.m);
    existing.newRevenue += row.revN;
    existing.renewalRevenue += row.revR;
    existing.trialRevenue += row.revT;
  }
  for (const row of additionalDays) {
    const existing = ensureMonth(map, row.m);
    existing.additionalRevenue += row.rev;
  }
  return [...map.values()].sort((left, right) => left.label.localeCompare(right.label));
}

function ensureMonth(map: Map<string, MonthlyRevenueInsight>, label: string): MonthlyRevenueInsight {
  const existing = map.get(label);
  if (existing) return existing;
  const row = {
    label,
    shortLabel: shortMonth(label),
    newRevenue: 0,
    renewalRevenue: 0,
    trialRevenue: 0,
    additionalRevenue: 0,
  };
  map.set(label, row);
  return row;
}

function buildCountMix(days: SalesDayAggregate[], mode: "program" | "package"): MixInsightRow[] {
  const counts: Record<string, number> = {};
  const total = sum(days, (row) => row.count);
  for (const day of days) {
    const source = mode === "program" ? day.prgs : day.pkgs;
    for (const [label, count] of Object.entries(source)) {
      counts[label] = (counts[label] ?? 0) + count;
    }
  }
  return Object.entries(counts)
    .map(([label, count]) => ({ label, count, revenue: 0, share: total > 0 ? count / total : 0 }))
    .sort((left, right) => right.count - left.count)
    .slice(0, 8);
}

function buildPaymentConcentration(days: SalesDayAggregate[]): MixInsightRow[] {
  const total = sum(days, (row) => row.count);
  const rows = DAYS.map((day) => {
    const dayRows = days.filter((row) => row.dow === day);
    const count = sum(dayRows, (row) => row.count);
    return {
      label: day,
      count,
      revenue: sum(dayRows, (row) => row.rev),
      share: total > 0 ? count / total : 0,
    };
  });
  return rows.sort((left, right) => right.count - left.count);
}

function filterDateSortValue(date: string): number {
  return dateComparisonValue(date);
}

function daysBetween(from: string, to: string): number {
  return Math.round((filterDateSortValue(to) - filterDateSortValue(from)) / DAY_MS);
}

function daysInMonth(date: string): number {
  const [year, month] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function minutesSince(value: string | null, now: Date): number | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return (now.getTime() - parsed.getTime()) / 60_000;
}

function sum<T>(items: T[], selector: (item: T) => number): number {
  return items.reduce((total, item) => total + selector(item), 0);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function shortMonth(monthLabel: string): string {
  const [ym, monthName] = monthLabel.split(" ");
  const year = ym?.slice(2, 4) ?? "";
  return `${monthName ?? ym} '${year}`;
}

function formatCompactMoney(value: number): string {
  const rounded = Math.round(value);
  if (Math.abs(rounded) >= 1_000_000) return `${(rounded / 1_000_000).toFixed(1)}M`;
  if (Math.abs(rounded) >= 1_000) return `${Math.round(rounded / 1_000)}k`;
  return String(rounded);
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
