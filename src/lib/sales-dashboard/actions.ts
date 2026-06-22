import { normalizeStudentKey } from "@/lib/sales-dashboard/cohorts";
import {
  addMonths,
  currentBangkokDate,
  currentBangkokMonthEnd,
  currentBangkokMonthStart,
  monthStartOf,
} from "@/lib/sales-dashboard/dates";
import { formatCurrency, formatPercent } from "@/lib/sales-dashboard/format";
import { buildGmDashboardInsights } from "@/lib/sales-dashboard/gm-insights";
import type {
  ActualVsProjectionInsight,
  GmException,
  SalesTeamInsightRow,
} from "@/lib/sales-dashboard/gm-insights";
import type {
  SalesDashboardPayload,
  SalesDimensionsPayload,
  SalesWorkspaceTab,
  StudentDirectoryEntry,
} from "@/lib/sales-dashboard/types";
import type {
  DashboardPayload as CreditControlPayload,
  PackageStatus,
  StudentRecord,
} from "@/types/credit-control";

export type SalesActionFamily =
  | "renewal_rescue"
  | "target_gap"
  | "trial_conversion"
  | "rep_recovery"
  | "data_trust";

export type SalesActionSeverity = "critical" | "warning" | "info";
export type SalesActionsMode = "current" | "historical";

export type SalesActionPrimaryActionKind =
  | "credit-control"
  | "sales-tab"
  | "source-manager"
  | "wise-reconciliation"
  | "none";

export interface SalesActionValue {
  amount: number | null;
  label: string;
  unit: "thb" | "count" | "percent" | "text";
}

export interface SalesActionPrimaryAction {
  kind: SalesActionPrimaryActionKind;
  label: string;
  href: string | null;
  enabled: boolean;
  tab?: SalesWorkspaceTab;
  reason?: string;
}

export interface SalesActionMatch {
  status: "unique" | "ambiguous" | "unmatched" | "not-applicable";
  salesStudentKey?: string;
  salesStudentName?: string;
  creditStudentKey?: string;
  creditStudentName?: string;
  candidateCount?: number;
  canOpenCreditControl: boolean;
  reason?: string;
}

export interface SalesActionEvidence {
  label: string;
  value: string;
  tone?: SalesActionSeverity;
}

export interface SalesActionSourceRange {
  from: string;
  to: string;
  mode: SalesActionsMode;
}

export interface SalesActionItem {
  id: string;
  family: SalesActionFamily;
  severity: SalesActionSeverity;
  title: string;
  detail: string;
  value: SalesActionValue | null;
  rankScore: number;
  primaryAction: SalesActionPrimaryAction;
  match: SalesActionMatch;
  evidence: SalesActionEvidence[];
  sourceRange: SalesActionSourceRange;
}

export interface SalesActionDependencyWarning {
  id: string;
  severity: SalesActionSeverity;
  title: string;
  detail: string;
}

export interface SalesActionChartPoint {
  month: string;
  label: string;
  actualNormalRevenue: number | null;
  baseProjectedRevenue: number | null;
  target: number;
}

export interface SalesActionChartAnnotation {
  id: string;
  family: SalesActionFamily;
  severity: SalesActionSeverity;
  label: string;
  value: number | null;
}

export interface SalesActionsPayload {
  generatedAt: string;
  mode: SalesActionsMode;
  modeLabel: string;
  period: {
    from: string;
    to: string;
    currentMonthStart: string;
    currentMonthEnd: string;
    isCurrentMonth: boolean;
  };
  kpis: {
    projectedNormalSales: number;
    targetGap: number;
    matchedAtRiskValue: number;
    actionsReady: number;
    target: number;
    normalSales: number;
    dailyPaceNeeded: number;
  };
  chart: {
    points: SalesActionChartPoint[];
    annotations: SalesActionChartAnnotation[];
  };
  items: SalesActionItem[];
  dependencyWarnings: SalesActionDependencyWarning[];
  matchStats: {
    unique: number;
    ambiguous: number;
    unmatched: number;
    creditControlAvailable: boolean;
    creditControlAccessible: boolean;
  };
}

export interface BuildSalesActionsInput {
  sales: SalesDashboardPayload;
  dimensions: SalesDimensionsPayload;
  creditControl?: CreditControlPayload | null;
  creditControlError?: string | null;
  from: string;
  to: string;
  canAccessCreditControl?: boolean;
  now?: Date;
}

type CreditMatch =
  | { status: "unique"; salesKey: string; salesName: string; student: StudentRecord; candidateCount: 1 }
  | { status: "ambiguous"; salesKey: string; salesName: string; candidateCount: number }
  | { status: "unmatched"; salesKey: string; salesName: string; candidateCount: 0 };

interface CreditIndex {
  bySalesKey: Map<string, StudentRecord[]>;
  available: boolean;
}

interface CreditRisk {
  risky: boolean;
  worstStatus: PackageStatus;
  riskyPackageCount: number;
  priorityScore: number;
  nextDate: string | null;
  recommendedAction: string | null;
  whyNow: string | null;
}

const EMPTY_RISK: CreditRisk = {
  risky: false,
  worstStatus: "ok",
  riskyPackageCount: 0,
  priorityScore: 0,
  nextDate: null,
  recommendedAction: null,
  whyNow: null,
};

export function buildSalesActionsPayload(input: BuildSalesActionsInput): SalesActionsPayload {
  const now = input.now ?? new Date();
  const currentMonthStart = currentBangkokMonthStart(now);
  const currentMonthEnd = currentBangkokMonthEnd(now);
  const isCurrentMonth = input.from.slice(0, 7) === currentMonthStart.slice(0, 7)
    && input.to.slice(0, 7) === currentMonthStart.slice(0, 7);
  const mode: SalesActionsMode = isCurrentMonth ? "current" : "historical";
  const sourceRange: SalesActionSourceRange = { from: input.from, to: input.to, mode };
  const insights = buildGmDashboardInsights(input.sales, { from: input.from, to: input.to }, now);
  const creditIndex = buildCreditIndex(input.creditControl ?? null);
  const canAccessCreditControl = input.canAccessCreditControl !== false;
  const dependencyWarnings = buildDependencyWarnings(input.creditControlError ?? null);
  const matchRows = input.dimensions.students.map((student) =>
    matchSalesStudentToCredit(student, creditIndex, canAccessCreditControl),
  );
  const items: SalesActionItem[] = [];

  const renewalItems = buildRenewalRescueItems({
    salesStudents: input.dimensions.students,
    matches: matchRows,
    creditControlAvailable: creditIndex.available,
    canAccessCreditControl,
    sourceRange,
    mode,
    today: currentBangkokDate(now),
  });
  items.push(...renewalItems);

  const targetGap = buildTargetGapItem(insights.revenuePace, sourceRange, mode);
  if (targetGap) items.push(targetGap);

  const trialConversion = buildTrialConversionItem(insights.pipeline, sourceRange);
  if (trialConversion) items.push(trialConversion);

  items.push(...buildRepRecoveryItems(insights.salesTeam, sourceRange));
  items.push(...buildDataTrustItems(insights.exceptions, dependencyWarnings, matchRows, input.dimensions.students, sourceRange));

  const sortedItems = items
    .sort((left, right) => right.rankScore - left.rankScore || left.id.localeCompare(right.id))
    .map((item, index) => ({ ...item, rankScore: Math.round(item.rankScore + Math.max(0, 0.99 - index / 100)) }));

  const matchedAtRiskValue = renewalItems
    .filter((item) => item.match.status === "unique")
    .reduce((total, item) => total + (item.value?.amount ?? 0), 0);
  const actionsReady = sortedItems.filter((item) =>
    item.primaryAction.enabled && (item.severity === "critical" || item.severity === "warning")
  ).length;

  return {
    generatedAt: new Date(now).toISOString(),
    mode,
    modeLabel: mode === "current"
      ? "Current-month action mode"
      : "Historical analysis mode",
    period: {
      from: input.from,
      to: input.to,
      currentMonthStart,
      currentMonthEnd,
      isCurrentMonth,
    },
    kpis: {
      projectedNormalSales: Math.round(insights.revenuePace.projectedNormalRevenue),
      targetGap: Math.round(insights.revenuePace.projectedGap),
      matchedAtRiskValue: Math.round(matchedAtRiskValue),
      actionsReady,
      target: Math.round(insights.revenuePace.target),
      normalSales: Math.round(insights.revenuePace.normalRevenue),
      dailyPaceNeeded: Math.round(insights.revenuePace.dailyPaceNeeded),
    },
    chart: {
      points: buildChartPoints(insights.actualVsProjection, insights.revenuePace.target, input.from, input.to),
      annotations: sortedItems.slice(0, 4).map((item) => ({
        id: item.id,
        family: item.family,
        severity: item.severity,
        label: item.title,
        value: item.value?.amount ?? null,
      })),
    },
    items: sortedItems,
    dependencyWarnings,
    matchStats: {
      unique: matchRows.filter((row) => row.status === "unique").length,
      ambiguous: matchRows.filter((row) => row.status === "ambiguous").length,
      unmatched: matchRows.filter((row) => row.status === "unmatched").length,
      creditControlAvailable: creditIndex.available,
      creditControlAccessible: canAccessCreditControl,
    },
  };
}

export function matchSalesStudentToCredit(
  salesStudent: StudentDirectoryEntry,
  creditIndex: CreditIndex,
  canAccessCreditControl = true,
): SalesActionMatch & CreditMatch {
  const salesKey = normalizeStudentKey(salesStudent.key || salesStudent.displayName);
  const candidates = creditIndex.bySalesKey.get(salesKey) ?? [];
  if (candidates.length === 1) {
    const student = candidates[0];
    return {
      status: "unique",
      salesKey,
      salesName: salesStudent.displayName,
      student,
      candidateCount: 1,
      salesStudentKey: salesKey,
      salesStudentName: salesStudent.displayName,
      creditStudentKey: student.studentKey,
      creditStudentName: student.student,
      canOpenCreditControl: canAccessCreditControl,
    };
  }
  if (candidates.length > 1) {
    return {
      status: "ambiguous",
      salesKey,
      salesName: salesStudent.displayName,
      candidateCount: candidates.length,
      salesStudentKey: salesKey,
      salesStudentName: salesStudent.displayName,
      canOpenCreditControl: false,
      reason: `${candidates.length} active Credit Control students share this normalized nickname.`,
    };
  }
  return {
    status: "unmatched",
    salesKey,
    salesName: salesStudent.displayName,
    candidateCount: 0,
    salesStudentKey: salesKey,
    salesStudentName: salesStudent.displayName,
    canOpenCreditControl: false,
    reason: creditIndex.available
      ? "No active Credit Control student matched this normalized Sales nickname."
      : "Credit Control was unavailable for this build.",
  };
}

function buildCreditIndex(creditControl: CreditControlPayload | null): CreditIndex {
  const bySalesKey = new Map<string, StudentRecord[]>();
  if (!creditControl) return { bySalesKey, available: false };

  for (const student of creditControl.students) {
    const key = normalizeStudentKey(student.student);
    const list = bySalesKey.get(key) ?? [];
    list.push(student);
    bySalesKey.set(key, list);
  }
  return { bySalesKey, available: true };
}

function buildDependencyWarnings(error: string | null): SalesActionDependencyWarning[] {
  if (!error) return [];
  return [{
    id: "credit-control-unavailable",
    severity: "warning",
    title: "Credit Control unavailable",
    detail: `Sales-only actions are still shown. Credit handoffs were skipped because Credit Control failed to load: ${error}`,
  }];
}

function buildRenewalRescueItems(input: {
  salesStudents: StudentDirectoryEntry[];
  matches: Array<SalesActionMatch & CreditMatch>;
  creditControlAvailable: boolean;
  canAccessCreditControl: boolean;
  sourceRange: SalesActionSourceRange;
  mode: SalesActionsMode;
  today: string;
}): SalesActionItem[] {
  const matchBySalesKey = new Map(input.matches.map((match) => [match.salesKey, match]));

  return input.salesStudents
    .map((student): SalesActionItem | null => {
      const key = normalizeStudentKey(student.key || student.displayName);
      const match = matchBySalesKey.get(key);
      const creditRisk = match?.status === "unique" ? riskForCreditStudent(match.student) : EMPTY_RISK;
      const salesRisk = salesStudentRisk(student, input.today);
      if (!creditRisk.risky && !salesRisk.risky) return null;

      const severity: SalesActionSeverity =
        creditRisk.worstStatus === "notify" || student.status === "Churned" ? "critical" : "warning";
      const primaryAction = primaryActionForMatch(match, input.canAccessCreditControl, input.mode);
      const riskLabel = creditRisk.risky
        ? `${creditRisk.riskyPackageCount} risky package${creditRisk.riskyPackageCount === 1 ? "" : "s"}`
        : salesRisk.reason;
      const evidence: SalesActionEvidence[] = [
        { label: "Sales status", value: student.status, tone: student.status === "Churned" ? "critical" : "info" },
        { label: "Lifetime value", value: formatCurrency(student.totalRevenue, true) },
      ];
      if (student.decisionDate) evidence.push({ label: "Decision date", value: student.decisionDate });
      if (creditRisk.risky) {
        evidence.push({ label: "Credit risk", value: riskLabel, tone: severity });
        if (creditRisk.nextDate) evidence.push({ label: "Next class", value: creditRisk.nextDate });
      }

      return {
        id: `renewal-${slugify(key)}`,
        family: "renewal_rescue" as const,
        severity,
        title: `Renewal rescue: ${student.displayName}`,
        detail: buildRenewalDetail(student, match, creditRisk, input.creditControlAvailable, input.mode),
        value: moneyValue(student.totalRevenue),
        rankScore: renewalRankScore(match, creditRisk, salesRisk, student.totalRevenue),
        primaryAction,
        match: toPublicMatch(match),
        evidence,
        sourceRange: input.sourceRange,
      };
    })
    .filter((item): item is SalesActionItem => Boolean(item));
}

function buildRenewalDetail(
  student: StudentDirectoryEntry,
  match: (SalesActionMatch & CreditMatch) | undefined,
  creditRisk: CreditRisk,
  creditControlAvailable: boolean,
  mode: SalesActionsMode,
): string {
  const modePrefix = mode === "historical" ? "Historical Sales period; Credit Control link shows current state. " : "";
  if (match?.status === "unique" && creditRisk.risky) {
    return `${modePrefix}${student.displayName} has ${creditRisk.riskyPackageCount} Credit Control risk signal${creditRisk.riskyPackageCount === 1 ? "" : "s"} and ${formatCurrency(student.totalRevenue, true)} in Sales history. ${creditRisk.whyNow ?? creditRisk.recommendedAction ?? ""}`.trim();
  }
  if (match?.status === "ambiguous") {
    return `${modePrefix}${student.displayName} is a high-value Sales risk, but the nickname maps to ${match.candidateCount} active Credit Control students. Review before handoff.`;
  }
  if (match?.status === "unmatched") {
    return `${modePrefix}${student.displayName} is a Sales retention risk, but no unique active Credit Control match is available${creditControlAvailable ? "." : " because Credit Control did not load."}`;
  }
  return `${modePrefix}${student.displayName} is a Sales retention risk.`;
}

function primaryActionForMatch(
  match: (SalesActionMatch & CreditMatch) | undefined,
  canAccessCreditControl: boolean,
  mode: SalesActionsMode,
): SalesActionPrimaryAction {
  if (match?.status === "unique" && canAccessCreditControl) {
    return {
      kind: "credit-control",
      label: mode === "current" ? "Open Credit Control" : "View current credit state",
      href: `/credit-control?studentKey=${encodeURIComponent(match.student.studentKey)}`,
      enabled: true,
      reason: mode === "historical" ? "Historical Sales action; Credit Control is current-state context." : undefined,
    };
  }
  return {
    kind: "sales-tab",
    label: match?.status === "ambiguous" ? "Review Sales student" : "Explore in Sales",
    href: `/sales-dashboard?tab=students`,
    enabled: true,
    tab: "students",
    reason: match?.status === "unique" ? "Credit Control access is not available for this user." : match?.reason,
  };
}

function toPublicMatch(match: (SalesActionMatch & CreditMatch) | undefined): SalesActionMatch {
  if (!match) {
    return { status: "not-applicable", canOpenCreditControl: false };
  }
  return {
    status: match.status,
    salesStudentKey: match.salesStudentKey,
    salesStudentName: match.salesStudentName,
    creditStudentKey: match.creditStudentKey,
    creditStudentName: match.creditStudentName,
    candidateCount: match.candidateCount,
    canOpenCreditControl: match.canOpenCreditControl,
    reason: match.reason,
  };
}

function riskForCreditStudent(student: StudentRecord): CreditRisk {
  const riskyPackages = student.packages.filter((pkg) => pkg.status === "notify" || pkg.status === "watch");
  if (riskyPackages.length === 0) return EMPTY_RISK;
  const worstStatus: PackageStatus = riskyPackages.some((pkg) => pkg.status === "notify") ? "notify" : "watch";
  const sorted = [...riskyPackages].sort((left, right) => right.priorityScore - left.priorityScore);
  const top = sorted[0];
  return {
    risky: true,
    worstStatus,
    riskyPackageCount: riskyPackages.length,
    priorityScore: Math.max(...riskyPackages.map((pkg) => pkg.priorityScore)),
    nextDate: top.nextSessionDate,
    recommendedAction: top.recommendedAction,
    whyNow: top.whyNow,
  };
}

function salesStudentRisk(student: StudentDirectoryEntry, today: string): { risky: boolean; reason: string; score: number } {
  if (student.status === "Churned") return { risky: true, reason: "Churned in Sales", score: 80 };
  if (student.decisionDate && student.decisionDate >= today && student.decisionDate <= addDaysIsoLocal(today, 21)) {
    return { risky: true, reason: "Renewal decision inside 21 days", score: 45 };
  }
  return { risky: false, reason: "", score: 0 };
}

function renewalRankScore(
  match: (SalesActionMatch & CreditMatch) | undefined,
  creditRisk: CreditRisk,
  salesRisk: { score: number },
  value: number,
): number {
  const matchWeight = match?.status === "unique" ? 860 : match?.status === "ambiguous" ? 740 : 650;
  const creditWeight = creditRisk.worstStatus === "notify" ? 90 : creditRisk.worstStatus === "watch" ? 45 : 0;
  return matchWeight + creditWeight + salesRisk.score + Math.min(90, value / 100_000);
}

function buildTargetGapItem(
  pace: ReturnType<typeof buildGmDashboardInsights>["revenuePace"],
  sourceRange: SalesActionSourceRange,
  mode: SalesActionsMode,
): SalesActionItem | null {
  if (pace.projectedGap <= 0) return null;
  const severity: SalesActionSeverity = pace.projectedGap > pace.target * 0.15 ? "critical" : "warning";
  return {
    id: "target-gap",
    family: "target_gap",
    severity,
    title: mode === "current" ? "Close current-month target gap" : "Analyze historical target gap",
    detail: mode === "current"
      ? `Projected normal sales are ${formatCurrency(pace.projectedGap, true)} short. Current gap needs ${formatCurrency(pace.dailyPaceNeeded, true)} per remaining day.`
      : `This historical period projected ${formatCurrency(pace.projectedGap, true)} below the target curve.`,
    value: moneyValue(pace.projectedGap),
    rankScore: (mode === "current" ? 780 : 620) + Math.min(120, pace.projectedGap / 50_000),
    primaryAction: {
      kind: "sales-tab",
      label: mode === "current" ? "Inspect sales drivers" : "Review period drivers",
      href: "/sales-dashboard?tab=overview",
      enabled: true,
      tab: "overview",
    },
    match: { status: "not-applicable", canOpenCreditControl: false },
    evidence: [
      { label: "Projected normal sales", value: formatCurrency(pace.projectedNormalRevenue, true) },
      { label: "Target", value: formatCurrency(pace.target, true) },
      { label: "Projected progress", value: `${pace.projectedProgressPct}%` },
    ],
    sourceRange,
  };
}

function buildTrialConversionItem(
  pipeline: ReturnType<typeof buildGmDashboardInsights>["pipeline"],
  sourceRange: SalesActionSourceRange,
): SalesActionItem | null {
  if (pipeline.trialCohortSize === 0 || pipeline.conversionRate >= 0.35) return null;
  return {
    id: "trial-conversion",
    family: "trial_conversion",
    severity: "warning",
    title: "Recover trial conversion",
    detail: `${pipeline.trialConverted}/${pipeline.trialCohortSize} trial students converted in this period.`,
    value: {
      amount: pipeline.conversionRate,
      label: formatPercent(pipeline.conversionRate),
      unit: "percent",
    },
    rankScore: 560 + Math.min(80, pipeline.trialCohortSize * 8),
    primaryAction: {
      kind: "sales-tab",
      label: "Open student cohort",
      href: "/sales-dashboard?tab=students",
      enabled: true,
      tab: "students",
    },
    match: { status: "not-applicable", canOpenCreditControl: false },
    evidence: [
      { label: "Converted", value: `${pipeline.trialConverted}/${pipeline.trialCohortSize}` },
      { label: "Floor", value: "35%" },
    ],
    sourceRange,
  };
}

function buildRepRecoveryItems(
  salesTeam: SalesTeamInsightRow[],
  sourceRange: SalesActionSourceRange,
): SalesActionItem[] {
  return salesTeam
    .filter((rep) => rep.deltaRevenue < 0 && rep.revenue > 0)
    .sort((left, right) => left.deltaRevenue - right.deltaRevenue)
    .slice(0, 3)
    .map((rep) => ({
      id: `rep-${slugify(rep.name)}`,
      family: "rep_recovery" as const,
      severity: rep.deltaRevenue < -250_000 ? "warning" as const : "info" as const,
      title: `Rep recovery: ${rep.name}`,
      detail: `${rep.name} is down ${formatCurrency(Math.abs(rep.deltaRevenue), true)} versus the prior equal-length window.`,
      value: moneyValue(Math.abs(rep.deltaRevenue)),
      rankScore: 500 + Math.min(90, Math.abs(rep.deltaRevenue) / 25_000),
      primaryAction: {
        kind: "sales-tab" as const,
        label: "Open rep view",
        href: `/sales-dashboard?tab=reps&rep=${encodeURIComponent(rep.name)}`,
        enabled: true,
        tab: "reps" as SalesWorkspaceTab,
      },
      match: { status: "not-applicable" as const, canOpenCreditControl: false },
      evidence: [
        { label: "Revenue", value: formatCurrency(rep.revenue, true) },
        { label: "Previous", value: formatCurrency(rep.previousRevenue, true) },
        { label: "AOV", value: formatCurrency(rep.averageOrderValue, true) },
      ],
      sourceRange,
    }));
}

function buildDataTrustItems(
  exceptions: GmException[],
  dependencyWarnings: SalesActionDependencyWarning[],
  matches: Array<SalesActionMatch & CreditMatch>,
  salesStudents: StudentDirectoryEntry[],
  sourceRange: SalesActionSourceRange,
): SalesActionItem[] {
  const items: SalesActionItem[] = [];
  for (const exception of exceptions.filter((item) => item.id.startsWith("source-"))) {
    items.push({
      id: `data-${exception.id}`,
      family: "data_trust",
      severity: exception.severity,
      title: exception.title,
      detail: exception.detail,
      value: exception.value ? { amount: null, label: exception.value, unit: "text" } : null,
      rankScore: exception.severity === "critical" ? 1_250 : 330,
      primaryAction: {
        kind: "source-manager",
        label: "Open data sources",
        href: null,
        enabled: true,
      },
      match: { status: "not-applicable", canOpenCreditControl: false },
      evidence: exception.value ? [{ label: "Signal", value: exception.value, tone: exception.severity }] : [],
      sourceRange,
    });
  }

  for (const warning of dependencyWarnings) {
    items.push({
      id: `data-${warning.id}`,
      family: "data_trust",
      severity: warning.severity,
      title: warning.title,
      detail: warning.detail,
      value: null,
      rankScore: 420,
      primaryAction: {
        kind: "sales-tab",
        label: "Continue Sales-only review",
        href: "/sales-dashboard?tab=students",
        enabled: true,
        tab: "students",
      },
      match: { status: "not-applicable", canOpenCreditControl: false },
      evidence: [{ label: "Fallback", value: "Credit handoffs skipped", tone: "warning" }],
      sourceRange,
    });
  }

  const ambiguous = matches.filter((match) => match.status === "ambiguous");
  if (ambiguous.length > 0) {
    const ambiguousKeys = new Set(ambiguous.map((match) => match.salesKey));
    const ambiguousValue = salesStudents
      .filter((student) => ambiguousKeys.has(normalizeStudentKey(student.key || student.displayName)))
      .reduce((total, student) => total + student.totalRevenue, 0);
    items.push({
      id: "data-ambiguous-student-matches",
      family: "data_trust",
      severity: "warning",
      title: "Ambiguous Sales-to-Credit matches",
      detail: `${ambiguous.length} Sales nickname${ambiguous.length === 1 ? "" : "s"} map to multiple active Credit Control students. These are review context only.`,
      value: moneyValue(ambiguousValue),
      rankScore: 610 + Math.min(90, ambiguousValue / 100_000),
      primaryAction: {
        kind: "sales-tab",
        label: "Review student directory",
        href: "/sales-dashboard?tab=students",
        enabled: true,
        tab: "students",
      },
      match: { status: "not-applicable", canOpenCreditControl: false },
      evidence: [
        { label: "Ambiguous nicknames", value: String(ambiguous.length), tone: "warning" },
        { label: "Sales value", value: formatCurrency(ambiguousValue, true) },
      ],
      sourceRange,
    });
  }

  return items;
}

function buildChartPoints(
  rows: ActualVsProjectionInsight[],
  target: number,
  from: string,
  to: string,
): SalesActionChartPoint[] {
  if (rows.length === 0) return [];
  const windowStart = addMonths(monthStartOf(from), -3);
  const windowEnd = addMonths(monthStartOf(to), 3);
  return rows
    .filter((row) => row.month >= windowStart && row.month <= windowEnd)
    .map((row) => ({
      month: row.month,
      label: row.label,
      actualNormalRevenue: row.actualNormalRevenue,
      baseProjectedRevenue: row.baseProjectedRevenue,
      target,
    }));
}

function moneyValue(amount: number): SalesActionValue {
  return {
    amount: Math.round(amount),
    label: formatCurrency(amount, true),
    unit: "thb",
  };
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown";
}

function addDaysIsoLocal(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day + days));
  return utc.toISOString().slice(0, 10);
}
