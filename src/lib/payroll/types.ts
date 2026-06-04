export type PayrollTier = "BG0" | "BG1" | "BG2" | "BG3" | "Unassigned";

export type PayrollIssueType =
  | "missing_payout_invoice"
  | "orphan_payout_invoice"
  | "zero_credit_or_zero_amount"
  | "missing_tier"
  | "unresolved_tutor_identity"
  | "duration_mismatch"
  | "expected_rate_mismatch"
  | "missing_expected_rate_rule"
  | "unmapped_rate_course";

export interface PayrollIssue {
  type: PayrollIssueType;
  severity: "high" | "medium" | "low";
  tutorKey: string;
  tutorName: string;
  wiseSessionId?: string | null;
  transactionId?: string | null;
  sessionDate?: string | null;
  course?: string | null;
  normalizedCourseKey?: string | null;
  studentBand?: "1" | "2" | "3_plus" | null;
  tier?: PayrollTier | null;
  expectedRate?: number | null;
  actualRate?: number | null;
  rateDifference?: number | null;
  message: string;
}

export interface PayrollRateBucket {
  rate: number;
  hours: number;
  amount: number;
  invoiceCount: number;
}

export interface PayrollTutorRow {
  tutorKey: string;
  canonicalKey: string | null;
  tutorName: string;
  tier: PayrollTier;
  rawTier: string | null;
  paidHours: number;
  utilizationHours: number;
  payoutAmount: number;
  invoiceCount: number;
  endedSessionCount: number;
  effectiveRate: number | null;
  rateBuckets: PayrollRateBucket[];
  varianceHours: number;
  flags: PayrollIssueType[];
  isKevin: boolean;
  freePayHours: number;
  expectedRateCheckedCount: number;
  expectedRateIssueCount: number;
  expectedRateMismatchCount: number;
  expectedRateMissingCount: number;
}

export interface PayrollAdjustmentDto {
  id: string;
  payrollMonth: string;
  adjustmentType: string;
  tutorCanonicalKey: string | null;
  tutorDisplayName: string | null;
  hours: number;
  amount: number;
  description: string;
  source: string;
  createdByEmail: string | null;
  createdByName: string | null;
  createdAt: string;
}

export interface PayrollPayload {
  month: string;
  payrollMonth: string;
  rateCard: {
    id: string;
    versionName: string;
    effectiveMonth: string;
    sourceLabel: string;
    active: boolean;
  } | null;
  review: {
    status: "draft" | "approved";
    notes: string;
    approvedByEmail: string | null;
    approvedByName: string | null;
    approvedAt: string | null;
    updatedAt: string | null;
  };
  lastSync: {
    id: string;
    status: "running" | "success" | "failed";
    startedAt: string;
    finishedAt: string | null;
    teacherCount: number;
    sessionCount: number;
    invoiceCount: number;
    errorSummary: string | null;
  } | null;
  summary: {
    totalPayoutAmount: number;
    paidHours: number;
    utilizationHours: number;
    varianceHours: number;
    detectedFreePayHours: number;
    kevinHours: number;
    kevinPaidHours: number;
    kevinPayoutAmount: number;
    manualAdjustmentHours: number;
    manualAdjustmentAmount: number;
    unresolvedTutorCount: number;
    issueCount: number;
    expectedRateCheckedCount: number;
    expectedRateMismatchCount: number;
    missingRateRuleCount: number;
    unmappedRateCourseCount: number;
    tutorCount: number;
  };
  tutors: PayrollTutorRow[];
  issues: PayrollIssue[];
  adjustments: PayrollAdjustmentDto[];
}
