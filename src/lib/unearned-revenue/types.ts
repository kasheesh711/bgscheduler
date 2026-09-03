export const UNEARNED_REVENUE_ROUTE = "/unearned-revenue";
export const UNEARNED_REVENUE_WORKBOOK_ID = "1AY6sAjw3rwAhdJCzMWR6qW0utBU91sv-JZWH1223mZc";
export const FIFO_PACKAGE_MODEL = "FIFO_PACKAGE_LOT_V1" as const;
export const LEGACY_ACCOUNT_MODEL = "LEGACY_ACCOUNT_RATE" as const;

export type UnearnedRevenueCanonicalModel =
  | typeof LEGACY_ACCOUNT_MODEL
  | typeof FIFO_PACKAGE_MODEL;

export type UnearnedRevenuePeriodKind = "MONTH_END" | "LATEST";
export type UnearnedRevenueLotKind =
  | "OPENING"
  | "PAID_PACKAGE"
  | "COMPLIMENTARY"
  | "AMBIGUOUS"
  | "UNATTRIBUTED";
export type UnearnedRevenueMatchStatus =
  | "FROZEN_OPENING"
  | "EXACT_TRANSACTION"
  | "UNIQUE_HEURISTIC"
  | "OVERRIDE"
  | "COMPLIMENTARY_MATCH"
  | "AMBIGUOUS"
  | "UNATTRIBUTED";
export type UnearnedRevenueReviewState =
  | "NO_REVIEW"
  | "NEEDS_REVIEW"
  | "REVIEWED"
  | "REVIEWED_RESIDUAL";
export type UnearnedRevenueCapability = "viewer" | "access_manager";

export interface TraceAnchor {
  spreadsheetId: string;
  sheetId: number;
  row: number;
  a1: string;
  url: string;
}

export interface UnearnedRevenueMetadata {
  snapshotId: string;
  sourceRunId: string;
  sourceFingerprint: string;
  sourceRevision: string;
  cutoff: string;
  generatedAtBangkok: string;
  importedAt: string;
  canonicalModel: UnearnedRevenueCanonicalModel;
  modelVersion: string;
  modelMode: "CANONICAL" | "SHADOW";
  workbookUrl: string;
  connectedEmail: string;
  lastSyncStatus: "success" | "failed" | "running" | null;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  stale: boolean;
  capabilities: UnearnedRevenueCapability[];
}

export interface UnearnedRevenuePeriodSummary {
  periodEnd: string;
  periodKind: UnearnedRevenuePeriodKind;
  isLatest: boolean;
  openingLiabilityThb: number;
  deferredNewLiabilityThb: number;
  recognizedRevenueThb: number;
  closingLiabilityThb: number;
  legacyClosingLiabilityThb: number;
  fifoClosingLiabilityThb: number;
  fifoVsLegacyDifferenceThb: number;
  remainingPaidCredits: number;
  attributedLiabilityThb: number;
  residualLiabilityThb: number;
  attributionPercent: number;
  studentCount: number;
  accountCount: number;
  trace: TraceAnchor;
}

export interface UnearnedRevenueQuality {
  ambiguousCount: number;
  unattributedCount: number;
  fallbackValuedCount: number;
  negativeBalanceCount: number;
  apiVarianceCount: number;
  reviewConditions: string[];
}

export interface UnearnedRevenueStudentRow {
  studentId: string;
  studentName: string;
  parentName: string;
  accountCount: number;
  ledgerRemainingCredits: number;
  remainingPaidCredits: number;
  legacyClosingLiabilityThb: number;
  fifoClosingLiabilityThb: number;
  canonicalClosingLiabilityThb: number;
  fifoVsLegacyDifferenceThb: number;
  attributedLiabilityThb: number;
  residualLiabilityThb: number;
  attributionPercent: number;
  reviewState: UnearnedRevenueReviewState;
  trace: TraceAnchor;
}

export interface UnearnedRevenueDashboardPayload {
  metadata: UnearnedRevenueMetadata;
  periods: UnearnedRevenuePeriodSummary[];
  selectedPeriod: UnearnedRevenuePeriodSummary;
  quality: UnearnedRevenueQuality;
  students: UnearnedRevenueStudentRow[];
  pagination: {
    page: number;
    pageSize: number;
    totalRows: number;
    totalPages: number;
  };
  filters: {
    period: string;
    search: string;
    scope: "positive" | "all";
    attribution: "all" | "attributed" | "residual" | "ambiguous" | "unattributed";
    review: "all" | "needs_review" | "clear";
    sort: "liability_desc" | "liability_asc" | "name_asc" | "credits_desc";
  };
}

export interface UnearnedRevenueAccountDetail {
  accountId: string;
  classId: string;
  className: string;
  classSubject: string;
  ledgerRemainingCredits: number;
  openingPaidCredits: number;
  deferredPaidCredits: number;
  recognizedPaidCredits: number;
  closingPaidCredits: number;
  legacyClosingLiabilityThb: number;
  fifoOpeningLiabilityThb: number;
  fifoDeferredNewLiabilityThb: number;
  fifoRecognizedRevenueThb: number;
  fifoClosingLiabilityThb: number;
  canonicalClosingLiabilityThb: number;
  attributedLiabilityThb: number;
  residualLiabilityThb: number;
  reviewState: UnearnedRevenueReviewState;
  trace: TraceAnchor;
}

export interface UnearnedRevenueLotDetail {
  lotId: string;
  accountId: string;
  lotKind: UnearnedRevenueLotKind;
  matchStatus: UnearnedRevenueMatchStatus;
  reviewState: UnearnedRevenueReviewState;
  packageName: string;
  transactionNumber: string;
  transactionDate: string | null;
  originalCredits: number;
  packageCredits: number;
  negativeRecoveryCredits: number;
  openingCredits: number;
  deferredCredits: number;
  recognizedCredits: number;
  remainingCredits: number;
  unitRateThb: number;
  netPaymentThb: number;
  openingLiabilityThb: number;
  deferredNewLiabilityThb: number;
  recognizedRevenueThb: number;
  closingLiabilityThb: number;
  candidateSalesKeys: string[];
  formulaTrace: TraceAnchor;
  sourceTrace: TraceAnchor | null;
}

export interface UnearnedRevenueStudentDetailPayload {
  periodEnd: string;
  canonicalModel: UnearnedRevenueCanonicalModel;
  modelVersion: string;
  student: UnearnedRevenueStudentRow;
  accounts: UnearnedRevenueAccountDetail[];
  lots: UnearnedRevenueLotDetail[];
}

export interface UnearnedRevenueAccessRow {
  email: string;
  name: string | null;
  capabilities: UnearnedRevenueCapability[];
  version: number;
}
