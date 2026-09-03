import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { importUnearnedRevenueContract } from "@/lib/unearned-revenue/sync";
import type { ParsedWorkbookContract } from "@/lib/unearned-revenue/workbook";

type Event = {
  type: "transaction" | "insert" | "update" | "delete";
  table?: unknown;
  value?: Record<string, unknown> | Record<string, unknown>[];
};

function contract(): ParsedWorkbookContract {
  return {
    status: {
      workbookSchemaVersion: 2,
      sourceRunId: "source-run",
      sourceFingerprint: "fingerprint",
      sourceRevision: "3",
      cutoff: "2026-09-03",
      generatedAtBangkok: "2026-09-04T00:15:00+07:00",
      canonicalModel: "LEGACY_ACCOUNT_RATE",
      modelVersion: "FIFO_PACKAGE_LOT_V1",
      modelMode: "SHADOW",
      reviewConditions: ["UNATTRIBUTED:1"],
    },
    periods: [{
      periodEnd: "2026-09-03", periodKind: "LATEST", isLatest: true,
      openingLiabilityThb: "100.00000000", deferredNewLiabilityThb: "20.00000000",
      recognizedRevenueThb: "10.00000000", closingLiabilityThb: "110.00000000",
      legacyClosingLiabilityThb: "110.00000000", fifoClosingLiabilityThb: "105.00000000",
      fifoVsLegacyDifferenceThb: "-5.00000000", remainingPaidCredits: "1.00000000",
      attributedLiabilityThb: "0.00000000", residualLiabilityThb: "105.00000000",
      attributionPercent: "0.00000000", studentCount: 1, accountCount: 1,
      ambiguousCount: 0, unattributedCount: 1, fallbackValuedCount: 1,
      negativeBalanceCount: 0, apiVarianceCount: 0, sourceRow: 2,
    }],
    students: [{
      periodEnd: "2026-09-03", periodKind: "LATEST", isLatest: true,
      studentId: "student-1", studentName: "Ada", parentName: "Parent", accountCount: 1,
      ledgerRemainingCredits: "1.00000000", remainingPaidCredits: "1.00000000",
      legacyClosingLiabilityThb: "110.00000000", fifoOpeningLiabilityThb: "95.00000000",
      fifoDeferredNewLiabilityThb: "20.00000000", fifoRecognizedRevenueThb: "10.00000000",
      fifoClosingLiabilityThb: "105.00000000", canonicalClosingLiabilityThb: "110.00000000",
      attributedLiabilityThb: "0.00000000", residualLiabilityThb: "105.00000000",
      attributionPercent: "0.00000000", reviewState: "NEEDS_REVIEW", sourceRow: 2,
    }],
    accounts: [{
      periodEnd: "2026-09-03", accountId: "account-1", studentId: "student-1", classId: "class-1",
      studentName: "Ada", className: "Math", classSubject: "Mathematics",
      ledgerRemainingCredits: "1.00000000", openingPaidCredits: "1.00000000",
      deferredPaidCredits: "0.00000000", recognizedPaidCredits: "0.00000000",
      closingPaidCredits: "1.00000000", lotClosingAllCredits: "1.00000000",
      legacyClosingLiabilityThb: "110.00000000", fifoOpeningLiabilityThb: "95.00000000",
      fifoDeferredNewLiabilityThb: "20.00000000", fifoRecognizedRevenueThb: "10.00000000",
      fifoClosingLiabilityThb: "105.00000000", canonicalClosingLiabilityThb: "110.00000000",
      attributedLiabilityThb: "0.00000000", residualLiabilityThb: "105.00000000",
      reviewState: "NEEDS_REVIEW", sourceRow: 2,
    }],
    lots: [{
      periodEnd: "2026-09-03", lotId: "lot-1", accountId: "account-1", studentId: "student-1",
      classId: "class-1", studentName: "Ada", className: "Math", lotKind: "UNATTRIBUTED",
      matchStatus: "UNATTRIBUTED", reviewState: "NEEDS_REVIEW", packageName: "",
      transactionNumber: "", salesKey: "", transactionDate: "2026-09-01", creditEventKey: "event-1",
      originalCredits: "1.00000000", packageCredits: "1.00000000",
      negativeRecoveryCredits: "0.00000000", openingCredits: "1.00000000",
      deferredCredits: "0.00000000", recognizedCredits: "0.00000000",
      remainingCredits: "1.00000000", unitRateThb: "105.00000000",
      netPaymentThb: "105.00000000", openingLiabilityThb: "105.00000000",
      deferredNewLiabilityThb: "0.00000000", recognizedRevenueThb: "0.00000000",
      closingLiabilityThb: "105.00000000", candidateSalesKeys: "", sourceSpreadsheetId: null,
      sourceSheetId: null, sourceRow: null, formulaRow: 2,
    }],
    rowCounts: { periods: 1, students: 1, accounts: 1, lots: 1 },
  };
}

function fakeDb(options: { existingSnapshotId?: string; lotCount?: number } = {}) {
  const events: Event[] = [];
  const insertedCounts = new Map<unknown, number>();
  const db: Record<string, unknown> = {};

  db.transaction = async (callback: (tx: Database) => Promise<unknown>) => {
    events.push({ type: "transaction", value: { state: "begin" } });
    try {
      const result = await callback(db as unknown as Database);
      events.push({ type: "transaction", value: { state: "commit" } });
      return result;
    } catch (error) {
      events.push({ type: "transaction", value: { state: "rollback" } });
      throw error;
    }
  };
  db.execute = vi.fn().mockResolvedValue([]);
  db.select = vi.fn(() => {
    let table: unknown;
    let ordered = false;
    const chain: Record<string, unknown> = {};
    chain.from = (value: unknown) => { table = value; return chain; };
    chain.where = () => chain;
    chain.orderBy = () => { ordered = true; return chain; };
    chain.limit = () => chain;
    chain.then = (resolve: (rows: unknown[]) => unknown, reject?: (error: unknown) => unknown) => {
      let rows: unknown[] = [];
      if (table === schema.unearnedRevenueSnapshots) {
        rows = ordered
          ? [{ id: "new-snapshot" }, { id: "previous-snapshot" }]
          : options.existingSnapshotId ? [{ id: options.existingSnapshotId }] : [];
      } else if (table === schema.unearnedRevenueLotPeriods && options.lotCount !== undefined) {
        rows = [{ value: options.lotCount }];
      } else if (insertedCounts.has(table)) {
        rows = [{ value: insertedCounts.get(table) }];
      }
      return Promise.resolve(rows).then(resolve, reject);
    };
    return chain;
  });
  db.insert = vi.fn((table: unknown) => ({
    values: (value: Record<string, unknown> | Record<string, unknown>[]) => {
      events.push({ type: "insert", table, value });
      insertedCounts.set(table, Array.isArray(value) ? value.length : 1);
      const promise = Promise.resolve([]) as unknown as Promise<unknown[]> & { returning: () => Promise<Array<{ id: string }>> };
      promise.returning = async () => [{ id: table === schema.unearnedRevenueSnapshots ? "new-snapshot" : "unused" }];
      return promise;
    },
  }));
  db.update = vi.fn((table: unknown) => ({
    set: (value: Record<string, unknown>) => ({
      where: async () => { events.push({ type: "update", table, value }); return []; },
    }),
  }));
  db.delete = vi.fn((table: unknown) => ({
    where: async () => { events.push({ type: "delete", table }); return []; },
  }));
  return { db: db as unknown as Database, events };
}

function updateSetsActive(event: Event): boolean {
  return event.type === "update"
    && !Array.isArray(event.value)
    && event.value?.active === true;
}

describe("unearned revenue atomic snapshot import", () => {
  const sheetIds = {
    "Model Comparison": 1,
    "CALC_Student_Period": 2,
    "CALC_Account_Period": 3,
    "CALC_Package_Lot_Period": 4,
  };

  it("stages all detail rows before one atomic promotion and retains only detail for two headers", async () => {
    const { db, events } = fakeDb();
    await expect(importUnearnedRevenueContract({
      db, syncRunId: "sync-1", spreadsheetId: "workbook", contract: contract(), sheetIds,
    })).resolves.toEqual({ snapshotId: "new-snapshot", idempotent: false });

    const detailTables = [
      schema.unearnedRevenuePeriods,
      schema.unearnedRevenueStudentPeriods,
      schema.unearnedRevenueAccountPeriods,
      schema.unearnedRevenueLotPeriods,
    ];
    const lastDetailInsert = Math.max(...detailTables.map((table) => events.findIndex((event) => event.type === "insert" && event.table === table)));
    const activation = events.findIndex((event) => (
      event.table === schema.unearnedRevenueSnapshots && updateSetsActive(event)
    ));
    const firstRetentionDelete = events.findIndex((event) => event.type === "delete");
    expect(lastDetailInsert).toBeLessThan(activation);
    expect(activation).toBeLessThan(firstRetentionDelete);
    expect(events.filter((event) => event.type === "delete").map((event) => event.table)).toEqual(detailTables);
    expect(events.at(-1)).toMatchObject({ type: "transaction", value: { state: "commit" } });
  });

  it("rolls back before promotion when staged counts do not reconcile, preserving last-good", async () => {
    const { db, events } = fakeDb({ lotCount: 0 });
    await expect(importUnearnedRevenueContract({
      db, syncRunId: "sync-1", spreadsheetId: "workbook", contract: contract(), sheetIds,
    })).rejects.toThrow(/row counts do not reconcile/i);

    expect(events.some((event) => (
      event.table === schema.unearnedRevenueSnapshots && updateSetsActive(event)
    ))).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "transaction", value: { state: "rollback" } });
  });

  it("treats an identical source run/fingerprint/revision/cutoff as idempotent", async () => {
    const { db, events } = fakeDb({ existingSnapshotId: "existing-snapshot" });
    await expect(importUnearnedRevenueContract({
      db, syncRunId: "sync-2", spreadsheetId: "workbook", contract: contract(), sheetIds,
    })).resolves.toEqual({ snapshotId: "existing-snapshot", idempotent: true });

    expect(events.some((event) => event.type === "insert")).toBe(false);
    expect(events.some((event) => event.table === schema.unearnedRevenueSnapshots)).toBe(false);
  });
});
