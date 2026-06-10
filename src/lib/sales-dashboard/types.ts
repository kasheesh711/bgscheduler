export type SalesSourceStatus = "active" | "refreshing" | "finalized" | "reopened" | "archived";
export type SalesImportTrigger = "manual" | "backfill" | "cron";
export type SalesProjectionScenario = "Bear" | "Base" | "Bull";
export type SalesProjectionSourceStatus = "active" | "archived";

export interface SalesDashboardSourceRecord {
  id: string;
  sourceMonth: string;
  label: string;
  spreadsheetId: string;
  spreadsheetUrl: string;
  normalSheetName: string | null;
  additionalSheetName: string | null;
  status: SalesSourceStatus;
  lastSuccessfulImportRunId: string | null;
  lastImportedAt: Date | null;
  lastImportError: string | null;
  lastNormalRowCount: number;
  lastAdditionalRowCount: number;
  finalizedAt: Date | null;
  reopenedAt: Date | null;
  archivedAt: Date | null;
  archivedByEmail: string | null;
  statusBeforeArchive: SalesSourceStatus | null;
  connectedEmail: string;
  createdByEmail: string;
  updatedByEmail: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ParsedNormalSaleRow {
  sourceMonth: string;
  sourceLabel: string;
  rowNumber: number;
  studentNickname: string;
  program: string;
  packageHours: string;
  numberOfStudents: number;
  paymentAmount: number;
  salesRepresentative: string;
  paymentDate: string;
  enrollmentType: string;
  programWiseName: string;
  packageHoursClean: string;
  validUntil: string | null;
  churnStatus: string;
  raw: Record<string, unknown>;
}

export interface ParsedAdditionalSaleRow {
  sourceMonth: string;
  sourceLabel: string;
  rowNumber: number;
  studentNickname: string;
  salesType: string;
  packageName: string;
  paymentAmount: number;
  paymentDate: string;
  raw: Record<string, unknown>;
}

export interface SalesDashboardPayload {
  normalDays: SalesDayAggregate[];
  addDays: SalesAdditionalDayAggregate[];
  pkgCount: Record<string, number>;
  progCount: Record<string, number>;
  addPkgCount: Record<string, number>;
  repArr: SalesRepAggregate[];
  dayCount: Record<string, number>;
  totalTxn: number;
  totalAddTxn: number;
  uniqueTrials: number;
  uniqueNewStudents: number;
  uniqueRenewals: number;
  churnedStudents: number;
  eligibleStudents: number;
  completionRate: Record<string, number>;
  completionMonths: number;
  weekBandPct: number[];
  churnList: SalesChurnListEntry[];
  trialCohort: SalesTrialCohortEntry[];
  retentionCohort: SalesRetentionCohortEntry[];
  lastUpdated: string | null;
  sources: SalesDashboardSourceSummary[];
  projection: SalesDashboardProjectionPayload;
  token: {
    connected: boolean;
    email: string | null;
    expiresAt: string | null;
    lastError: string | null;
  };
}

export interface SalesDashboardProjectionPayload {
  source: SalesDashboardProjectionSourceSummary | null;
  targetMonthlyRevenue: number | null;
  targetSource: "projection" | "fallback";
  scenarioSummaries: SalesProjectionScenarioSummary[];
  months: SalesProjectionMonthRecord[];
  lastImportedAt: string | null;
  lastImportError: string | null;
}

export interface SalesDashboardSourceSummary {
  id: string;
  sourceMonth: string;
  label: string;
  spreadsheetId: string;
  spreadsheetUrl: string;
  normalSheetName: string | null;
  additionalSheetName: string | null;
  status: SalesSourceStatus;
  lastImportedAt: string | null;
  lastImportError: string | null;
  lastNormalRowCount: number;
  lastAdditionalRowCount: number;
  connectedEmail: string;
  archivedAt: string | null;
  archivedByEmail: string | null;
  statusBeforeArchive: SalesSourceStatus | null;
}

export interface SalesDashboardProjectionSourceRecord {
  id: string;
  spreadsheetId: string;
  spreadsheetUrl: string;
  summarySheetName: string;
  whatIfSheetName: string;
  calcMultiSheetName: string;
  status: SalesProjectionSourceStatus;
  lastSuccessfulImportRunId: string | null;
  lastImportedAt: Date | null;
  lastImportError: string | null;
  lastProjectionMonthCount: number;
  lastTargetMonthlyRevenue: number | null;
  connectedEmail: string;
  createdByEmail: string;
  updatedByEmail: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SalesDashboardProjectionSourceSummary {
  id: string;
  spreadsheetId: string;
  spreadsheetUrl: string;
  summarySheetName: string;
  whatIfSheetName: string;
  calcMultiSheetName: string;
  status: SalesProjectionSourceStatus;
  lastImportedAt: string | null;
  lastImportError: string | null;
  lastProjectionMonthCount: number;
  lastTargetMonthlyRevenue: number | null;
  connectedEmail: string;
}

export interface SalesProjectionScenarioSummary {
  scenario: SalesProjectionScenario;
  totalRevenue21Month: number;
  revenueAprDec2026: number;
  revenueCy2027: number;
  avgMonthlyRevenue: number;
  endActiveStudents: number;
  studentGrowthPct: number;
  endPackRenewals: number;
  revenueStatus: string;
}

export interface ParsedSalesProjectionWorkbook {
  targetMonthlyRevenue: number;
  scenarioSummaries: SalesProjectionScenarioSummary[];
  months: SalesProjectionMonthRecord[];
  metadata: Record<string, unknown>;
}

export interface SalesProjectionMonthRecord {
  scenario: SalesProjectionScenario;
  projectionMonth: string;
  monthLabel: string;
  monthKind: "actual" | "forecast";
  totalNetRevenue: number;
  renewalRevenue: number;
  newStudentRevenue: number;
  trialRevenue: number;
  activeStudents: number;
  trialBookings: number;
  newStudents: number;
  packRenewals: number;
  renewalHours: number;
  newStudentHours: number;
  trialHours: number;
  totalHours: number;
  roomCapacity: number;
  roomUtilization: number;
}

export interface SalesDayAggregate {
  d: string;
  m: string;
  rev: number;
  trial: number;
  newS: number;
  renew: number;
  count: number;
  revT: number;
  revN: number;
  revR: number;
  pkgs: Record<string, number>;
  prgs: Record<string, number>;
  reps: Record<string, SalesDayRepAggregate>;
  dow: string;
}

export interface SalesAdditionalDayAggregate {
  d: string;
  m: string;
  rev: number;
  count: number;
}

export interface SalesDayRepAggregate {
  rev: number;
  count: number;
  revT: number;
  revN: number;
  revR: number;
  cntT: number;
  cntN: number;
  cntR: number;
}

export interface SalesRepAggregate {
  name: string;
  revenue: number;
  count: number;
}

export interface SalesChurnListEntry {
  nick: string;
  validUntil: string;
  status: "Churned" | "Retained" | "Active";
}

export interface SalesTrialCohortEntry {
  nick: string;
  trialDate: string;
  convertedDate: string | null;
}

export interface SalesRetentionCohortEntry {
  nick: string;
  saleDate: string;
  validUntil: string;
  decisionDate: string;
  renewedDate: string | null;
  status: "Retained" | "Churned";
}

// ————————————————————————————————————————————————————————————————————————————
// Sales Dashboard v2 — tabbed workspace dimensions + transactions (additive)
// ————————————————————————————————————————————————————————————————————————————

/** Grain: (normalized rep, month "YYYY-MM-01"). */
export interface RepMonthAgg {
  rep: string;
  month: string;
  rev: number;
  count: number;
  revT: number;
  revN: number;
  revR: number;
  cntT: number;
  cntN: number;
  cntR: number;
}

/** Grain: rep, whole-history. Trial conversion is credited to the rep on the student's first Trial row. */
export interface RepFunnel {
  rep: string;
  trialsHandled: number;
  trialsConverted: number;
  medianDaysToConvert: number | null;
  topPrograms: { name: string; rev: number }[];
  topPackages: { band: string; rev: number }[];
}

/** Grain: (programWiseName||program, month). */
export interface ProgramMonthAgg {
  program: string;
  month: string;
  rev: number;
  count: number;
  students: number;
  revT: number;
  revN: number;
  revR: number;
}

/** Grain: (packageBand, month). */
export interface PackageMonthAgg {
  packageBand: string;
  packageLabel: string;
  hours: number | null;
  month: string;
  rev: number;
  count: number;
  totalHoursSold: number | null;
}

/** Live-recomputed student status (validUntil+14d rule) — never the stored churn_status. */
export type StudentLiveStatus = "Active" | "Retained" | "Churned" | "Pending" | "Trial-only";

/** Grain: distinct normalized student nickname. */
export interface StudentDirectoryEntry {
  key: string;
  displayName: string;
  displayNameVariants: string[];
  firstSeen: string;
  lastPaymentDate: string;
  totalRevenue: number;
  txnCount: number;
  addTxnCount: number;
  programs: string[];
  reps: string[];
  latestValidUntil: string | null;
  status: StudentLiveStatus;
  decisionDate: string | null;
}

export interface AdditionalMixMonthAgg {
  month: string;
  salesType: string;
  rev: number;
  count: number;
}

export interface SalesDimensionsPayload {
  months: string[];
  reps: RepMonthAgg[];
  repFunnels: RepFunnel[];
  programs: ProgramMonthAgg[];
  packages: PackageMonthAgg[];
  additionalMix: AdditionalMixMonthAgg[];
  students: StudentDirectoryEntry[];
  targetMonthlyRevenue: number | null;
  unparsedPackageCount: number;
  generatedAt: string;
}

/** Slim row for the transactions endpoint. The `raw` jsonb column is NEVER serialized here. */
export interface SlimTransaction {
  date: string;
  student: string;
  studentKey: string;
  rep: string;
  program: string;
  packageLabel: string;
  band: string;
  hours: number | null;
  amount: number;
  enrollmentType: string;
  validUntil: string | null;
  sourceMonth: string;
  numberOfStudents: number | null;
  kind: "normal" | "additional";
  salesType?: string;
}

/** Student-journey renewal timeline segment, chained on validUntil. */
export interface CoverageWindow {
  from: string;
  until: string;
  status: "covered" | "gap" | "open";
}

export type SalesWorkspaceTab = "overview" | "reps" | "programs" | "packages" | "students";

/** GM command-center cross-link seed: shell switches tab + seeds the panel filter. */
export interface ExploreSeed {
  tab: SalesWorkspaceTab;
  rep?: string;
  program?: string;
  band?: string;
  studentKey?: string;
  filter?: string;
}

/** Locked prop contract for the four workspace tab panels (Wave-2 agents). */
export interface SalesTabProps {
  dimensions: SalesDimensionsPayload | null;
  loading: boolean;
  from: string;
  to: string;
  seed?: ExploreSeed;
  /**
   * Whether this panel is the currently visible tab. Drives ChartCanvas
   * resize-on-reactivation for keepMounted (hidden) panels. Defaults to
   * visible so standalone renders/tests need not pass it.
   */
  active?: boolean;
}
