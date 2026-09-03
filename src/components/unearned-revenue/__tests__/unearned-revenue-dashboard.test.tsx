import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  UnearnedRevenueDashboard,
  UnearnedRevenueLotTraceLinks,
} from "@/components/unearned-revenue/unearned-revenue-dashboard";
import {
  FIFO_PACKAGE_MODEL,
  LEGACY_ACCOUNT_MODEL,
  type TraceAnchor,
  type UnearnedRevenueDashboardPayload,
  type UnearnedRevenueLotDetail,
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
    quality: {
      ambiguousCount: 2,
      unattributedCount: 3,
      fallbackValuedCount: 4,
      negativeBalanceCount: 5,
      apiVarianceCount: 6,
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
    formulaTrace: trace(303, "AA9"),
    sourceTrace,
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

    expect(html).toContain("FIFO shadow · legacy canonical");
    expect(html).toContain("03 Sept 2026 (latest completed day)");
    expect(html).not.toContain("30 Sept 2026");
    expect(html).toContain("Column chart of completed month-end closing unearned revenue");
    expect(html).toContain("Waterfall chart showing opening plus deferred minus recognized equals closing liability");
    expect(html).toContain("THB 1,100.00 residual");
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

    expect(html).toContain("FIFO canonical");
    expect(html).toContain("Canonical package-lot model");
    expect(html).not.toContain("FIFO shadow · legacy canonical");
  });

  it("opens the URL-selected student drawer state", () => {
    navigation.query = "period=2026-09-03&scope=positive&student=student-1";
    const html = renderToStaticMarkup(<UnearnedRevenueDashboard initialPayload={payload()} />);

    expect(html).toContain('data-selected-student="student-1"');
    expect(html).toContain("student=student-1");
  });
});

describe("UnearnedRevenueLotTraceLinks", () => {
  it("renders separate formula and source-row links when source evidence exists", () => {
    const source = trace(404, "A22:AZ22");
    const html = renderToStaticMarkup(<UnearnedRevenueLotTraceLinks lot={lot(source)} />);

    expect(html).toContain("Open formula");
    expect(html).toContain("Open source row");
    expect(html).toContain("gid=303&amp;range=AA9");
    expect(html).toContain("gid=404&amp;range=A22:AZ22");
  });

  it("keeps the formula link but labels an absent synthetic source row", () => {
    const html = renderToStaticMarkup(<UnearnedRevenueLotTraceLinks lot={lot(null)} />);

    expect(html).toContain("Open formula");
    expect(html).not.toContain("Open source row</a>");
    expect(html).toContain("No source row for this synthetic lot");
  });
});
