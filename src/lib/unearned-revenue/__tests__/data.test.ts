import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import {
  getUnearnedRevenueDashboard,
  getUnearnedRevenueStudentDetail,
} from "@/lib/unearned-revenue/data";

function baseSnapshot() {
  return {
    id: "snapshot-1",
    syncRunId: "sync-1",
    active: true,
    spreadsheetId: "workbook-1",
    sourceRunId: "source-run",
    sourceFingerprint: "fingerprint",
    sourceRevision: "8",
    cutoff: "2026-09-03",
    generatedAtBangkok: new Date("2026-09-04T00:15:00+07:00"),
    importedAt: new Date("2026-09-04T00:20:00+07:00"),
    workbookSchemaVersion: 2,
    canonicalModel: "LEGACY_ACCOUNT_RATE",
    modelVersion: "FIFO_PACKAGE_LOT_V1",
    modelMode: "SHADOW",
    reviewConditions: ["UNATTRIBUTED:1"],
    sheetIds: {},
    rowCounts: {},
  };
}

function periodRow() {
  return {
    id: "period-1", snapshotId: "snapshot-1", periodEnd: "2026-09-03",
    periodKind: "LATEST", isLatest: true, openingLiabilityThb: "100.00000000",
    deferredNewLiabilityThb: "20.00000000", recognizedRevenueThb: "10.00000000",
    closingLiabilityThb: "110.00000000", legacyClosingLiabilityThb: "110.00000000",
    fifoClosingLiabilityThb: "105.00000000", fifoVsLegacyDifferenceThb: "-5.00000000",
    remainingPaidCredits: "1.00000000", attributedLiabilityThb: "80.00000000",
    residualLiabilityThb: "25.00000000", attributionPercent: "76.19047619",
    studentCount: 51, accountCount: 60, ambiguousCount: 0, unattributedCount: 1,
    fallbackValuedCount: 1, negativeBalanceCount: 2, apiVarianceCount: 3,
    traceSpreadsheetId: "workbook-1", traceSheetId: 101, traceRow: 7, traceA1: "F7",
  };
}

function studentRow() {
  return {
    id: "student-row", snapshotId: "snapshot-1", periodEnd: "2026-09-03",
    periodKind: "LATEST", isLatest: true, studentId: "wise-student-1", studentName: "Ada",
    parentName: "Parent", accountCount: 2, ledgerRemainingCredits: "1.50000000",
    remainingPaidCredits: "1.00000000", legacyClosingLiabilityThb: "110.00000000",
    fifoOpeningLiabilityThb: "95.00000000", fifoDeferredNewLiabilityThb: "20.00000000",
    fifoRecognizedRevenueThb: "10.00000000", fifoClosingLiabilityThb: "105.00000000",
    canonicalClosingLiabilityThb: "110.00000000", attributedLiabilityThb: "80.00000000",
    residualLiabilityThb: "25.00000000", attributionPercent: "76.19047619",
    reviewState: "NEEDS_REVIEW", traceSpreadsheetId: "workbook-1", traceSheetId: 102,
    traceRow: 8, traceA1: "O8",
  };
}

function queueDb(
  rowsByTable: Map<unknown, unknown[][]>,
  countByTable: Map<unknown, number> = new Map(),
) {
  const calls: Array<{ table: unknown; limit?: number; offset?: number }> = [];
  const db = {
    select: vi.fn((selection?: Record<string, unknown>) => {
      const isCount = Boolean(selection && Object.keys(selection).length === 1 && "value" in selection);
      const call: { table: unknown; limit?: number; offset?: number } = { table: null };
      const chain = {
        from(table: unknown) { call.table = table; return chain; },
        where() { return chain; },
        orderBy() { return chain; },
        limit(value: number) { call.limit = value; return chain; },
        offset(value: number) { call.offset = value; return chain; },
        then(resolve: (value: unknown[]) => unknown, reject?: (error: unknown) => unknown) {
          calls.push(call);
          const queue = rowsByTable.get(call.table) ?? [];
          const rows = isCount ? [{ value: countByTable.get(call.table) ?? 0 }] : (queue.shift() ?? []);
          return Promise.resolve(rows).then(resolve, reject);
        },
      };
      return chain;
    }),
  } as unknown as Database;
  return { db, calls };
}

describe("unearned revenue dashboard queries", () => {
  it("paginates the selected period and returns exact formula trace URLs", async () => {
    const { db, calls } = queueDb(new Map<unknown, unknown[][]>([
      [schema.unearnedRevenueSnapshots, [[baseSnapshot()]]],
      [schema.unearnedRevenuePeriods, [[periodRow()]]],
      [schema.unearnedRevenueSyncRuns, [[{
        status: "success", startedAt: new Date("2026-09-04T00:19:00+07:00"),
        finishedAt: new Date("2026-09-04T00:20:00+07:00"), errorSummary: null,
      }]]],
      [schema.unearnedRevenueStudentPeriods, [[studentRow()]]],
    ]), new Map<unknown, number>([[schema.unearnedRevenueStudentPeriods, 51]]));

    const payload = await getUnearnedRevenueDashboard({
      search: "Ada", scope: "positive", attribution: "residual", review: "needs_review",
      sort: "liability_desc", page: 2, pageSize: 25,
    }, ["viewer"], db);

    expect(payload.pagination).toEqual({ page: 2, pageSize: 25, totalRows: 51, totalPages: 3 });
    expect(payload.filters.period).toBe("2026-09-03");
    expect(payload.students[0]).toMatchObject({
      studentId: "wise-student-1",
      fifoVsLegacyDifferenceThb: -5,
      trace: { sheetId: 102, a1: "O8" },
    });
    expect(payload.students[0].trace.url).toContain("#gid=102&range=O8");
    expect(calls.find((call) => call.table === schema.unearnedRevenueStudentPeriods && call.offset === 25))
      .toMatchObject({ limit: 25, offset: 25 });
  });

  it("keeps formula and sales-source links separate, and omits a source link for synthetic lots", async () => {
    const account = {
      id: "account-row", snapshotId: "snapshot-1", periodEnd: "2026-09-03",
      accountId: "account-1", studentId: "wise-student-1", classId: "class-1",
      studentName: "Ada", className: "Math", classSubject: "Mathematics",
      ledgerRemainingCredits: "1.00000000", openingPaidCredits: "1.00000000",
      deferredPaidCredits: "0.00000000", recognizedPaidCredits: "0.00000000",
      closingPaidCredits: "1.00000000", legacyClosingLiabilityThb: "110.00000000",
      fifoOpeningLiabilityThb: "105.00000000", fifoDeferredNewLiabilityThb: "0.00000000",
      fifoRecognizedRevenueThb: "0.00000000", fifoClosingLiabilityThb: "105.00000000",
      canonicalClosingLiabilityThb: "110.00000000", attributedLiabilityThb: "80.00000000",
      residualLiabilityThb: "25.00000000", reviewState: "NEEDS_REVIEW",
      traceSpreadsheetId: "workbook-1", traceSheetId: 103, traceRow: 9, traceA1: "T9",
    };
    const lotBase = {
      id: "lot-db", snapshotId: "snapshot-1", periodEnd: "2026-09-03", accountId: "account-1",
      studentId: "wise-student-1", classId: "class-1", studentName: "Ada", className: "Math",
      reviewState: "NEEDS_REVIEW", packageName: "", transactionNumber: "", salesKey: "",
      transactionDate: null, creditEventKey: "", originalCredits: "1.00000000",
      packageCredits: "1.00000000", negativeRecoveryCredits: "0.00000000",
      openingCredits: "1.00000000", deferredCredits: "0.00000000",
      recognizedCredits: "0.00000000", remainingCredits: "1.00000000",
      unitRateThb: "105.00000000", netPaymentThb: "105.00000000",
      openingLiabilityThb: "105.00000000", deferredNewLiabilityThb: "0.00000000",
      recognizedRevenueThb: "0.00000000", closingLiabilityThb: "105.00000000",
      candidateSalesKeys: "", formulaSpreadsheetId: "workbook-1", formulaSheetId: 104,
      formulaRow: 10, formulaA1: "AA10",
    };
    const { db } = queueDb(new Map<unknown, unknown[][]>([
      [schema.unearnedRevenueSnapshots, [[baseSnapshot()]]],
      [schema.unearnedRevenueStudentPeriods, [[studentRow()]]],
      [schema.unearnedRevenueAccountPeriods, [[account]]],
      [schema.unearnedRevenueLotPeriods, [[
        { ...lotBase, lotId: "opening", lotKind: "OPENING", matchStatus: "FROZEN_OPENING",
          sourceSpreadsheetId: null, sourceSheetId: null, sourceRow: null, sourceA1: null },
        { ...lotBase, lotId: "matched", lotKind: "PAID_PACKAGE", matchStatus: "EXACT_TRANSACTION",
          packageName: "Math 10", sourceSpreadsheetId: "sales-workbook", sourceSheetId: 205,
          sourceRow: 44, sourceA1: "A44:AZ44", matchConfidence: "COMPOSITE_VERIFIED",
          matchRuleId: "MATCH-COMPOSITE-VERIFIED-V2", matchEvidence: { credit_difference: 0 },
          candidateReceiptIds: "receipt-1", creditEventSpreadsheetId: "credit-ledger",
          creditEventSheetId: 206, creditEventRow: 45, creditEventA1: "A45:AZ45",
          receiptSpreadsheetId: "workbook-1", receiptSheetId: 207, receiptRow: 46,
          receiptA1: "A46:V46", receiptId: "receipt-1", receiptType: "OFFLINE_PAYMENT",
          receiptStatus: "CHARGED", receiptChargedAt: new Date("2026-09-01T10:00:00+07:00"),
          receiptAmountThb: "105.00000000", receiptCurrency: "THB", receiptNote: "Paid offline",
          receiptStudentId: "wise-student-1", receiptClassId: "class-1" },
      ]]],
    ]));

    const detail = await getUnearnedRevenueStudentDetail({ studentId: "wise-student-1", period: "2026-09-03" }, db);
    expect(detail.accounts[0].trace.url).toContain("#gid=103&range=T9");
    expect(detail.lots[0].sourceTrace).toBeNull();
    expect(detail.lots[1].formulaTrace.url).toContain("#gid=104&range=AA10");
    expect(detail.lots[1].sourceTrace?.url).toContain("#gid=205&range=A44%3AAZ44");
    expect(detail.lots[1].creditEventTrace?.url).toContain("#gid=206&range=A45%3AAZ45");
    expect(detail.lots[1].receiptTrace?.url).toContain("#gid=207&range=A46%3AV46");
    expect(detail.lots[1].receipt).toMatchObject({ id: "receipt-1", amountThb: 105 });
  });
});
