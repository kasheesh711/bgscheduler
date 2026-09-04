import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  UnearnedRevenueDashboard,
  UnearnedRevenueLotTraceLinks,
  UnearnedRevenueStudentDetailContent,
  UNEARNED_REVENUE_STUDENT_DRAWER_LAYOUT,
} from "@/components/unearned-revenue/unearned-revenue-dashboard";
import {
  FIFO_PACKAGE_MODEL,
  LEGACY_ACCOUNT_MODEL,
  type TraceAnchor,
  type UnearnedRevenueDashboardPayload,
  type UnearnedRevenueLotDetail,
  type UnearnedRevenueStudentDetailPayload,
} from "@/lib/unearned-revenue/types";

const navigation = vi.hoisted(() => ({
  query: "period=2026-09-03&scope=positive",
  push: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/unearned-revenue",
  useRouter: () => ({ push: navigation.push, replace: navigation.replace }),
  useSearchParams: () => new URLSearchParams(navigation.query),
}));

vi.mock("@/components/sales-dashboard/chart-canvas", () => ({
  ChartCanvas: ({ ariaLabel, className }: { ariaLabel: string; className?: string }) => (
    <div role="img" aria-label={ariaLabel} className={className} />
  ),
  chartColors: () => ({
    chart: ["#0284c7", "#f59e0b", "#7c3aed", "#059669", "#64748b"],
    mutedForeground: "#64748b",
  }),
}));

function trace(sheetId = 101, a1 = "F8"): TraceAnchor {
  return {
    spreadsheetId: "workbook-id",
    sheetId,
    row: Number(a1.match(/\d+/)?.[0] ?? 1),
    a1,
    url: `https://docs.google.com/spreadsheets/d/workbook-id/edit#gid=${sheetId}&range=${a1}`,
  };
}

function payload(
  overrides: Partial<UnearnedRevenueDashboardPayload["metadata"]> = {},
): UnearnedRevenueDashboardPayload {
  const monthEnd = {
    periodEnd: "2026-08-31",
    periodKind: "MONTH_END" as const,
    isLatest: false,
    openingLiabilityThb: 900,
    deferredNewLiabilityThb: 200,
    recognizedRevenueThb: 100,
    closingLiabilityThb: 1000,
    legacyClosingLiabilityThb: 1000,
    fifoClosingLiabilityThb: 1025,
    fifoVsLegacyDifferenceThb: 25,
    remainingPaidCredits: 10,
    attributedLiabilityThb: 600,
    residualLiabilityThb: 425,
    attributionPercent: 58.5,
    studentCount: 1,
    accountCount: 2,
    trace: trace(100, "F7"),
  };
  const latest = {
    ...monthEnd,
    periodEnd: "2026-09-03",
    periodKind: "LATEST" as const,
    isLatest: true,
    openingLiabilityThb: 1000,
    deferredNewLiabilityThb: 100,
    recognizedRevenueThb: 50,
    closingLiabilityThb: 1050,
    legacyClosingLiabilityThb: 1050,
    fifoClosingLiabilityThb: 1100,
    fifoVsLegacyDifferenceThb: 50,
    attributedLiabilityThb: 0,
    residualLiabilityThb: 1100,
    attributionPercent: 0,
    trace: trace(101, "F8"),
  };
  return {
    metadata: {
      snapshotId: "snapshot-1",
      sourceRunId: "run-1",
      sourceFingerprint: "fingerprint",
      sourceRevision: "revision-1",
      cutoff: "2026-09-03",
      generatedAtBangkok: "2026-09-04T00:15:00+07:00",
      importedAt: "2026-09-04T01:30:00+07:00",
      canonicalModel: LEGACY_ACCOUNT_MODEL,
      modelVersion: FIFO_PACKAGE_MODEL,
      modelMode: "SHADOW",
      workbookUrl: "https://docs.google.com/spreadsheets/d/workbook-id/edit",
      connectedEmail: "finance@example.com",
      lastSyncStatus: "success",
      lastSyncAt: "2026-09-04T01:30:00+07:00",
      lastSyncError: null,
      stale: false,
      capabilities: ["viewer", "access_manager"],
      ...overrides,
    },
    periods: [monthEnd, latest],
    selectedPeriod: latest,
    exactPackageOverview: {
      available: true,
      totalLiabilityThb: 400,
      attributionPercent: 36.36363636,
      automaticLiabilityThb: 300,
      financeReviewedLiabilityThb: 100,
      residualLiabilityThb: 700,
      remainingCredits: 4,
      packageCount: 1,
      activeLotCount: 2,
      packages: [{
        packageName: "40-hr (free extra 1 hr)",
        openingLiabilityThb: 200,
        deferredNewLiabilityThb: 300,
        recognizedRevenueThb: 100,
        automaticExactLiabilityThb: 300,
        financeReviewedLiabilityThb: 100,
        closingExactLiabilityThb: 400,
        remainingCredits: 4,
        studentCount: 1,
        accountCount: 1,
        activeLotCount: 2,
        shareOfExactLiability: 100,
        trace: trace(111, "J12"),
      }],
    },
    quality: {
      ambiguousCount: 2,
      unattributedCount: 3,
      fallbackValuedCount: 4,
      negativeBalanceCount: 5,
      apiVarianceCount: 6,
      compositeVerifiedCount: 7,
      receiptCandidateCount: 8,
      reversalConflictCount: 1,
      missingReceiptEvidenceCount: 2,
      reviewConditions: ["PACKAGE_UNATTRIBUTED:3"],
    },
    students: [{
      studentId: "student-1",
      studentName: "Ada Student",
      parentName: "Parent Student",
      accountCount: 2,
      ledgerRemainingCredits: 10,
      remainingPaidCredits: 10,
      legacyClosingLiabilityThb: 1050,
      fifoClosingLiabilityThb: 1100,
      canonicalClosingLiabilityThb: 1050,
      fifoVsLegacyDifferenceThb: 50,
      attributedLiabilityThb: 0,
      residualLiabilityThb: 1100,
      attributionPercent: 0,
      reviewState: "NEEDS_REVIEW",
      trace: trace(202, "O42"),
    }],
    pagination: { page: 1, pageSize: 50, totalRows: 1, totalPages: 1 },
    filters: {
      period: "2026-09-03",
      search: "",
      scope: "positive",
      attribution: "all",
      review: "all",
      sort: "liability_desc",
    },
  };
}

function lot(sourceTrace: TraceAnchor | null): UnearnedRevenueLotDetail {
  return {
    lotId: "lot-1",
    accountId: "account-1",
    lotKind: sourceTrace ? "PAID_PACKAGE" : "OPENING",
    matchStatus: sourceTrace ? "EXACT_TRANSACTION" : "FROZEN_OPENING",
    matchConfidence: sourceTrace ? "EXACT" : "RESIDUAL",
    matchRuleId: sourceTrace ? "MATCH-DIRECT-TRANSACTION-ID" : "OPENING",
    matchEvidence: {},
    reviewState: "NO_REVIEW",
    packageName: sourceTrace ? "10-credit package" : "",
    transactionNumber: sourceTrace ? "TX-1" : "",
    transactionDate: sourceTrace ? "2026-03-03" : null,
    originalCredits: 10,
    packageCredits: 10,
    negativeRecoveryCredits: 0,
    openingCredits: 10,
    deferredCredits: 0,
    recognizedCredits: 2,
    remainingCredits: 8,
    unitRateThb: 100,
    netPaymentThb: 1000,
    openingLiabilityThb: 1000,
    deferredNewLiabilityThb: 0,
    recognizedRevenueThb: 200,
    closingLiabilityThb: 800,
    candidateSalesKeys: [],
    candidateReceiptIds: [],
    formulaTrace: trace(303, "AA9"),
    salesTrace: sourceTrace,
    creditEventTrace: sourceTrace,
    receiptTrace: null,
    receipt: null,
    sourceTrace,
  };
}

function studentDetail(): UnearnedRevenueStudentDetailPayload {
  const student = payload().students[0];
  const source = trace(404, "A22:AZ22");

  return {
    periodEnd: "2026-09-03",
    canonicalModel: LEGACY_ACCOUNT_MODEL,
    modelVersion: FIFO_PACKAGE_MODEL,
    student: {
      ...student,
      studentName: "Alexandria-Cassandra Extremely Long Student Display Name for Drawer Regression",
      ledgerRemainingCredits: 987_654_321.25,
      remainingPaidCredits: 987_654_321.25,
      legacyClosingLiabilityThb: 987_654_321_098.76,
      fifoClosingLiabilityThb: 987_654_321_198.76,
      canonicalClosingLiabilityThb: 987_654_321_098.76,
      fifoVsLegacyDifferenceThb: 100,
      attributedLiabilityThb: 987_654_320_000,
      residualLiabilityThb: 1_098.76,
      attributionPercent: 99.9,
    },
    accounts: [{
      accountId: "account-with-an-unusually-long-stable-identifier-000000000000000001",
      classId: "class-1",
      className: "Years 9–11 International Mathematics and Advanced Sciences Programme with a Long Account Name",
      classSubject: "Mathematics / Physics / Chemistry",
      ledgerRemainingCredits: 987_654_321.25,
      openingPaidCredits: 987_654_321.25,
      deferredPaidCredits: 0,
      recognizedPaidCredits: 0,
      closingPaidCredits: 987_654_321.25,
      legacyClosingLiabilityThb: 987_654_321_098.76,
      fifoOpeningLiabilityThb: 987_654_321_198.76,
      fifoDeferredNewLiabilityThb: 0,
      fifoRecognizedRevenueThb: 0,
      fifoClosingLiabilityThb: 987_654_321_198.76,
      canonicalClosingLiabilityThb: 987_654_321_098.76,
      attributedLiabilityThb: 987_654_320_000,
      residualLiabilityThb: 1_098.76,
      reviewState: "NEEDS_REVIEW",
      trace: trace(303, "A123:AZ123"),
    }],
    lots: [{
      ...lot(source),
      packageName: "Extremely Long Premium International Programme Package Name with Weekend Add-on",
      transactionNumber: "TRANSACTION-WITH-A-LONG-REFERENCE-000000000000000001",
      originalCredits: 987_654_321.25,
      packageCredits: 987_654_321.25,
      openingCredits: 987_654_321.25,
      remainingCredits: 987_654_321.25,
      unitRateThb: 987_654.32,
      netPaymentThb: 987_654_321_098.76,
      openingLiabilityThb: 987_654_321_098.76,
      closingLiabilityThb: 987_654_321_098.76,
    }],
  };
}

describe("UnearnedRevenueDashboard", () => {
  beforeEach(() => {
    navigation.query = "period=2026-09-03&scope=positive";
    navigation.push.mockReset();
    navigation.replace.mockReset();
  });

  it("renders shadow values, actual-cutoff semantics, charts, residuals, and both responsive student layouts", () => {
    const html = renderToStaticMarkup(<UnearnedRevenueDashboard initialPayload={payload()} />);

    expect(html).toContain("FIFO V3 shadow · legacy canonical");
    expect(html).toContain("Legacy is still the official number");
    expect(html).toContain("Liability tied to exact packages");
    expect(html).toContain("40-hr (free extra 1 hr)");
    expect(html).toContain("Automatic exact");
    expect(html).toContain("Finance reviewed");
    expect(html).toContain("03 Sept 2026 (latest completed day)");
    expect(html).not.toContain("30 Sept 2026");
    expect(html).toContain("Column chart of completed month-end closing unearned revenue");
    expect(html).toContain("Waterfall chart showing opening plus deferred minus recognized equals closing liability");
    expect(html).toContain("THB 700.00 residual");
    expect(html).toContain('class="hidden md:block"');
    expect(html).toContain('class="divide-y md:hidden"');
    expect(html.match(/Ada Student/g)).toHaveLength(2);
    expect(html).toContain("student=student-1");
    expect(html).toContain("Open total formula");
    expect(html).toContain("Access");
    expect(html).toContain("Refresh");
  });

  it("moves FIFO to primary presentation only after canonical approval", () => {
    const html = renderToStaticMarkup(
      <UnearnedRevenueDashboard initialPayload={payload({
        canonicalModel: FIFO_PACKAGE_MODEL,
        modelMode: "CANONICAL",
      })} />,
    );

    expect(html).toContain("FIFO V3 canonical");
    expect(html).toContain("Canonical package-lot model");
    expect(html).not.toContain("FIFO V3 shadow · legacy canonical");
  });

  it("opens the URL-selected student drawer state", () => {
    navigation.query = "period=2026-09-03&scope=positive&student=student-1";
    const html = renderToStaticMarkup(<UnearnedRevenueDashboard initialPayload={payload()} />);

    expect(html).toContain('data-selected-student="student-1"');
    expect(html).toContain("student=student-1");
  });

  it("contains long student detail and large THB values without making the drawer the horizontal scroller", () => {
    const detail = studentDetail();
    const html = renderToStaticMarkup(<UnearnedRevenueStudentDetailContent detail={detail} />);
    const dialogClasses = UNEARNED_REVENUE_STUDENT_DRAWER_LAYOUT.dialog.split(" ");
    const scrollBodyClasses = UNEARNED_REVENUE_STUDENT_DRAWER_LAYOUT.scrollBody.split(" ");

    expect(dialogClasses).toContain("overflow-hidden");
    expect(dialogClasses).toContain("min-w-0");
    expect(dialogClasses).toContain("sm:w-[min(1180px,calc(100vw-2rem))]");
    expect(dialogClasses).not.toContain("overflow-y-auto");
    expect(scrollBodyClasses).toEqual(expect.arrayContaining([
      "min-h-0",
      "min-w-0",
      "overflow-y-auto",
      "overflow-x-hidden",
    ]));
    expect(UNEARNED_REVENUE_STUDENT_DRAWER_LAYOUT.accountTable).toBe("min-w-[920px]");
    expect(html).toContain("Alexandria-Cassandra Extremely Long Student Display Name for Drawer Regression");
    expect(html).toContain("Years 9–11 International Mathematics and Advanced Sciences Programme with a Long Account Name");
    expect(html).toContain("987,654,321,098.76");
    expect(html).toContain('data-slot="table-container" class="relative w-full overflow-x-auto"');
    expect(html).toContain("min-w-[920px]");
    expect(html).toContain("Open formula");
    expect(html).toContain("Open sales row");
    expect(html).toContain("Open credit event");
  });
});

describe("UnearnedRevenueLotTraceLinks", () => {
  it("renders separate formula and source-row links when source evidence exists", () => {
    const source = trace(404, "A22:AZ22");
    const html = renderToStaticMarkup(<UnearnedRevenueLotTraceLinks lot={lot(source)} />);

    expect(html).toContain("Open formula");
    expect(html).toContain("Open sales row");
    expect(html).toContain("Open credit event");
    expect(html).toContain("gid=303&amp;range=AA9");
    expect(html).toContain("gid=404&amp;range=A22:AZ22");
  });

  it("renders independent Wise receipt evidence and the V2 match audit", () => {
    const receiptTrace = trace(505, "A31:V31");
    const receiptLot: UnearnedRevenueLotDetail = {
      ...lot(trace(404, "A22:AZ22")),
      matchStatus: "COMPOSITE_VERIFIED",
      matchConfidence: "COMPOSITE_VERIFIED",
      matchRuleId: "MATCH-COMPOSITE-VERIFIED-V2",
      matchEvidence: { amount_difference_thb: 0, credit_difference: 0 },
      receiptTrace,
      receipt: {
        id: "receipt-1",
        type: "OFFLINE_PAYMENT",
        status: "CHARGED",
        chargedAt: "2026-03-03T10:00:00+07:00",
        amountThb: 1000,
        currency: "THB",
        note: "Paid offline",
        studentId: "student-1",
        classId: "class-1",
      },
    };
    const links = renderToStaticMarkup(<UnearnedRevenueLotTraceLinks lot={receiptLot} />);
    const detail = studentDetail();
    detail.lots = [receiptLot];
    const audit = renderToStaticMarkup(<UnearnedRevenueStudentDetailContent detail={detail} />);

    expect(links).toContain("Open receipt evidence");
    expect(links).toContain("gid=505&amp;range=A31:V31");
    expect(audit).toContain("Composite verified");
    expect(audit).toContain("MATCH-COMPOSITE-VERIFIED-V2");
    expect(audit).toContain("Matching evidence");
  });

  it("keeps the formula link but labels an absent synthetic source row", () => {
    const html = renderToStaticMarkup(<UnearnedRevenueLotTraceLinks lot={lot(null)} />);

    expect(html).toContain("Open formula");
    expect(html).not.toContain("Open sales row</a>");
    expect(html).toContain("No source links for this synthetic opening lot");
  });
});
