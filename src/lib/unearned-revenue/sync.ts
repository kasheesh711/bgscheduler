import "server-only";

import { count, desc, eq, notInArray, sql } from "drizzle-orm";

import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import {
  fetchGoogleSheetRange,
  listGoogleSheetProperties,
  quoteGoogleSheetName,
  type GoogleSheetProperties,
} from "@/lib/sales-dashboard/sheets";
import { withUnearnedRevenueTransaction } from "./transaction";
import {
  parseUnearnedRevenueWorkbook,
  WORKBOOK_LIMITS,
  type ParsedWorkbookContract,
} from "./workbook";
import { UNEARNED_REVENUE_WORKBOOK_ID } from "./types";

const REQUIRED_TABS = [
  "Model Status",
  "QA Checks",
  "Model Comparison",
  "CALC_Student_Period",
  "CALC_Account_Period",
  "CALC_Package_Lot_Period",
] as const;
const OPTIONAL_CONTRACT_TABS = ["SRC_Wise_Receipt", "CALC_Exact_Package_Overview"] as const;

export interface UnearnedRevenueSyncResult {
  ok: boolean;
  skipped: boolean;
  idempotent: boolean;
  syncRunId: string | null;
  snapshotId: string | null;
  cutoff: string | null;
  counts: {
    periods: number;
    students: number;
    accounts: number;
    lots: number;
    exactPackages: number;
  } | null;
  errorSummary?: string;
}

interface SyncOptions {
  triggerType: "cron" | "manual";
  actorEmail?: string | null;
  db?: Database;
}

export function getUnearnedRevenueSpreadsheetId(): string {
  return process.env.UNEARNED_REVENUE_SPREADSHEET_ID?.trim() || UNEARNED_REVENUE_WORKBOOK_ID;
}

export function getUnearnedRevenueConnectedEmail(): string {
  return process.env.UNEARNED_REVENUE_CONNECTED_EMAIL?.trim().toLowerCase() || "kevhsh7@gmail.com";
}

function rangesForLimit(tab: string, lastColumn: string, limit: number): string {
  // Header + limit data rows + one sentinel row. The parser rejects the sentinel
  // if the workbook contract exceeds its declared maximum.
  return `${quoteGoogleSheetName(tab)}!A1:${lastColumn}${limit + 2}`;
}

function propertiesByTitle(rows: GoogleSheetProperties[]): Map<string, GoogleSheetProperties> {
  return new Map(rows.map((row) => [row.title, row]));
}

function assertRequiredTabs(rows: GoogleSheetProperties[]): Map<string, GoogleSheetProperties> {
  const byTitle = propertiesByTitle(rows);
  const missing = REQUIRED_TABS.filter((title) => !byTitle.has(title));
  if (missing.length > 0) throw new Error(`Workbook is missing required tabs: ${missing.join(", ")}`);
  return byTitle;
}

export function assertStableSheetIds(
  before: Map<string, GoogleSheetProperties>,
  after: Map<string, GoogleSheetProperties>,
): void {
  for (const title of REQUIRED_TABS) {
    if (before.get(title)?.sheetId !== after.get(title)?.sheetId) {
      throw new Error(`Workbook tab changed during import: ${title}`);
    }
  }
  for (const title of OPTIONAL_CONTRACT_TABS) {
    if (before.has(title) !== after.has(title)
      || (before.has(title) && before.get(title)?.sheetId !== after.get(title)?.sheetId)) {
      throw new Error(`Workbook tab changed during import: ${title}`);
    }
  }
}

export async function readUnearnedRevenueWorkbook(
  email = getUnearnedRevenueConnectedEmail(),
  spreadsheetId = getUnearnedRevenueSpreadsheetId(),
): Promise<{ contract: ParsedWorkbookContract; sheetIds: Record<string, number> }> {
  const startProperties = assertRequiredTabs(await listGoogleSheetProperties(email, spreadsheetId));
  const statusRange = rangesForLimit("Model Status", "C", WORKBOOK_LIMITS.status);
  const statusStart = await fetchGoogleSheetRange(email, spreadsheetId, statusRange);
  const receiptRowsPromise: Promise<unknown[][] | undefined> = startProperties.has("SRC_Wise_Receipt")
    ? fetchGoogleSheetRange(
      email,
      spreadsheetId,
      rangesForLimit("SRC_Wise_Receipt", "V", WORKBOOK_LIMITS.receipts),
    )
    : Promise.resolve(undefined);
  const exactPackageRowsPromise: Promise<unknown[][] | undefined> = startProperties.has("CALC_Exact_Package_Overview")
    ? fetchGoogleSheetRange(
      email,
      spreadsheetId,
      rangesForLimit("CALC_Exact_Package_Overview", "S", WORKBOOK_LIMITS.exactPackages),
    )
    : Promise.resolve(undefined);
  const exactPackageFormulasPromise: Promise<unknown[][] | undefined> = startProperties.has("CALC_Exact_Package_Overview")
    ? fetchGoogleSheetRange(
      email,
      spreadsheetId,
      rangesForLimit("CALC_Exact_Package_Overview", "S", WORKBOOK_LIMITS.exactPackages),
      { valueRenderOption: "FORMULA" },
    )
    : Promise.resolve(undefined);
  const [
    qa,
    periods,
    periodFormulas,
    students,
    studentFormulas,
    accounts,
    accountFormulas,
    lots,
    lotFormulas,
    receipts,
    exactPackages,
    exactPackageFormulas,
  ] = await Promise.all([
    fetchGoogleSheetRange(email, spreadsheetId, rangesForLimit("QA Checks", "H", WORKBOOK_LIMITS.qa)),
    fetchGoogleSheetRange(email, spreadsheetId, rangesForLimit("Model Comparison", "V", WORKBOOK_LIMITS.periods)),
    fetchGoogleSheetRange(email, spreadsheetId, rangesForLimit("Model Comparison", "V", WORKBOOK_LIMITS.periods), { valueRenderOption: "FORMULA" }),
    fetchGoogleSheetRange(email, spreadsheetId, rangesForLimit("CALC_Student_Period", "Y", WORKBOOK_LIMITS.students)),
    fetchGoogleSheetRange(email, spreadsheetId, rangesForLimit("CALC_Student_Period", "Y", WORKBOOK_LIMITS.students), { valueRenderOption: "FORMULA" }),
    fetchGoogleSheetRange(email, spreadsheetId, rangesForLimit("CALC_Account_Period", "AC", WORKBOOK_LIMITS.accounts)),
    fetchGoogleSheetRange(email, spreadsheetId, rangesForLimit("CALC_Account_Period", "AC", WORKBOOK_LIMITS.accounts), { valueRenderOption: "FORMULA" }),
    fetchGoogleSheetRange(email, spreadsheetId, rangesForLimit("CALC_Package_Lot_Period", "BP", WORKBOOK_LIMITS.lots)),
    fetchGoogleSheetRange(email, spreadsheetId, rangesForLimit("CALC_Package_Lot_Period", "BP", WORKBOOK_LIMITS.lots), { valueRenderOption: "FORMULA" }),
    receiptRowsPromise,
    exactPackageRowsPromise,
    exactPackageFormulasPromise,
  ]);
  const statusEnd = await fetchGoogleSheetRange(email, spreadsheetId, statusRange);
  const endProperties = assertRequiredTabs(await listGoogleSheetProperties(email, spreadsheetId));
  assertStableSheetIds(startProperties, endProperties);
  const contract = parseUnearnedRevenueWorkbook({
    statusStart,
    statusEnd,
    qa,
    periods,
    periodFormulas,
    students,
    studentFormulas,
    accounts,
    accountFormulas,
    lots,
    lotFormulas,
    receipts,
    exactPackages,
    exactPackageFormulas,
  });
  if (contract.status.workbookSchemaVersion >= 3 && !startProperties.has("SRC_Wise_Receipt")) {
    throw new Error("Workbook schema V3 is missing required tab: SRC_Wise_Receipt");
  }
  if (contract.status.workbookSchemaVersion >= 4
    && !startProperties.has("CALC_Exact_Package_Overview")) {
    throw new Error(
      "Workbook schema V4 is missing required tab: CALC_Exact_Package_Overview",
    );
  }
  return {
    contract,
    sheetIds: Object.fromEntries(
      [...REQUIRED_TABS, ...OPTIONAL_CONTRACT_TABS]
        .filter((title) => startProperties.has(title))
        .map((title) => [title, startProperties.get(title)!.sheetId]),
    ),
  };
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return "code" in error && (error as { code?: unknown }).code === "23505";
}

async function insertChunks<T>(
  rows: T[],
  chunkSize: number,
  insert: (chunk: T[]) => Promise<unknown>,
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    await insert(rows.slice(offset, offset + chunkSize));
  }
}

function sourceA1(row: number): string {
  return `A${row}:AZ${row}`;
}

function parseTimestamp(value: string, label: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${label} is not a valid timestamp`);
  return parsed;
}

export async function importUnearnedRevenueContract(input: {
  db: Database;
  syncRunId: string;
  spreadsheetId: string;
  contract: ParsedWorkbookContract;
  sheetIds: Record<string, number>;
}): Promise<{ snapshotId: string; idempotent: boolean }> {
  const { db, syncRunId, spreadsheetId, contract, sheetIds } = input;
  return withUnearnedRevenueTransaction(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('unearned_revenue_snapshot_promotion'))`);
    const [existing] = await tx.select({ id: schema.unearnedRevenueSnapshots.id })
      .from(schema.unearnedRevenueSnapshots)
      .where(sql<boolean>`${schema.unearnedRevenueSnapshots.sourceRunId} = ${contract.status.sourceRunId}
        and ${schema.unearnedRevenueSnapshots.sourceFingerprint} = ${contract.status.sourceFingerprint}
        and ${schema.unearnedRevenueSnapshots.sourceRevision} = ${contract.status.sourceRevision}
        and ${schema.unearnedRevenueSnapshots.cutoff} = ${contract.status.cutoff}`)
      .limit(1);
    if (existing) {
      await tx.update(schema.unearnedRevenueSyncRuns).set({
        status: "success",
        sourceRunId: contract.status.sourceRunId,
        sourceFingerprint: contract.status.sourceFingerprint,
        sourceRevision: contract.status.sourceRevision,
        cutoff: contract.status.cutoff,
        importedSnapshotId: existing.id,
        periodCount: contract.periods.length,
        studentRowCount: contract.students.length,
        accountRowCount: contract.accounts.length,
        lotRowCount: contract.lots.length,
        metadata: { idempotent: true, exactPackageRowCount: contract.exactPackages.length },
        finishedAt: new Date(),
      }).where(eq(schema.unearnedRevenueSyncRuns.id, syncRunId));
      return { snapshotId: existing.id, idempotent: true };
    }

    const [snapshot] = await tx.insert(schema.unearnedRevenueSnapshots).values({
      syncRunId,
      active: false,
      spreadsheetId,
      sourceRunId: contract.status.sourceRunId,
      sourceFingerprint: contract.status.sourceFingerprint,
      sourceRevision: contract.status.sourceRevision,
      cutoff: contract.status.cutoff,
      generatedAtBangkok: parseTimestamp(contract.status.generatedAtBangkok, "generated_at_bangkok"),
      workbookSchemaVersion: contract.status.workbookSchemaVersion,
      canonicalModel: contract.status.canonicalModel,
      modelVersion: contract.status.modelVersion,
      modelMode: contract.status.modelMode,
      reviewConditions: contract.status.reviewConditions,
      sheetIds,
      rowCounts: contract.rowCounts,
    }).returning({ id: schema.unearnedRevenueSnapshots.id });

    await insertChunks(contract.periods, 500, (chunk) => tx.insert(schema.unearnedRevenuePeriods).values(chunk.map((row) => ({
      snapshotId: snapshot.id,
      periodEnd: row.periodEnd,
      periodKind: row.periodKind,
      isLatest: row.isLatest,
      openingLiabilityThb: row.openingLiabilityThb,
      deferredNewLiabilityThb: row.deferredNewLiabilityThb,
      recognizedRevenueThb: row.recognizedRevenueThb,
      closingLiabilityThb: row.closingLiabilityThb,
      legacyClosingLiabilityThb: row.legacyClosingLiabilityThb,
      fifoClosingLiabilityThb: row.fifoClosingLiabilityThb,
      fifoVsLegacyDifferenceThb: row.fifoVsLegacyDifferenceThb,
      remainingPaidCredits: row.remainingPaidCredits,
      attributedLiabilityThb: row.attributedLiabilityThb,
      residualLiabilityThb: row.residualLiabilityThb,
      attributionPercent: row.attributionPercent,
      studentCount: row.studentCount,
      accountCount: row.accountCount,
      ambiguousCount: row.ambiguousCount,
      unattributedCount: row.unattributedCount,
      fallbackValuedCount: row.fallbackValuedCount,
      negativeBalanceCount: row.negativeBalanceCount,
      apiVarianceCount: row.apiVarianceCount,
      compositeVerifiedCount: row.compositeVerifiedCount ?? 0,
      receiptCandidateCount: row.receiptCandidateCount ?? 0,
      reversalConflictCount: row.reversalConflictCount ?? 0,
      missingReceiptEvidenceCount: row.missingReceiptEvidenceCount ?? 0,
      traceSpreadsheetId: spreadsheetId,
      traceSheetId: sheetIds["Model Comparison"],
      traceRow: row.sourceRow,
      traceA1: `F${row.sourceRow}`,
    }))));

    await insertChunks(contract.exactPackages, 500, (chunk) => tx
      .insert(schema.unearnedRevenuePackagePeriods)
      .values(chunk.map((row) => ({
        snapshotId: snapshot.id,
        periodEnd: row.periodEnd,
        periodKind: row.periodKind,
        isLatest: row.isLatest,
        packageName: row.packageName,
        openingLiabilityThb: row.openingLiabilityThb,
        deferredNewLiabilityThb: row.deferredNewLiabilityThb,
        recognizedRevenueThb: row.recognizedRevenueThb,
        automaticExactLiabilityThb: row.automaticExactLiabilityThb,
        financeReviewedLiabilityThb: row.financeReviewedLiabilityThb,
        closingExactLiabilityThb: row.closingExactLiabilityThb,
        remainingCredits: row.remainingCredits,
        studentCount: row.studentCount,
        accountCount: row.accountCount,
        activeLotCount: row.activeLotCount,
        shareOfExactLiability: row.shareOfExactLiability,
        traceSpreadsheetId: spreadsheetId,
        traceSheetId: sheetIds["CALC_Exact_Package_Overview"],
        traceRow: row.sourceRow,
        traceA1: `J${row.sourceRow}`,
      }))));

    await insertChunks(contract.students, 700, (chunk) => tx.insert(schema.unearnedRevenueStudentPeriods).values(chunk.map((row) => ({
      snapshotId: snapshot.id,
      periodEnd: row.periodEnd,
      periodKind: row.periodKind,
      isLatest: row.isLatest,
      studentId: row.studentId,
      studentName: row.studentName,
      parentName: row.parentName,
      accountCount: row.accountCount,
      ledgerRemainingCredits: row.ledgerRemainingCredits,
      remainingPaidCredits: row.remainingPaidCredits,
      legacyClosingLiabilityThb: row.legacyClosingLiabilityThb,
      fifoOpeningLiabilityThb: row.fifoOpeningLiabilityThb,
      fifoDeferredNewLiabilityThb: row.fifoDeferredNewLiabilityThb,
      fifoRecognizedRevenueThb: row.fifoRecognizedRevenueThb,
      fifoClosingLiabilityThb: row.fifoClosingLiabilityThb,
      canonicalClosingLiabilityThb: row.canonicalClosingLiabilityThb,
      attributedLiabilityThb: row.attributedLiabilityThb,
      residualLiabilityThb: row.residualLiabilityThb,
      attributionPercent: row.attributionPercent,
      reviewState: row.reviewState,
      traceSpreadsheetId: spreadsheetId,
      traceSheetId: sheetIds["CALC_Student_Period"],
      traceRow: row.sourceRow,
      traceA1: `O${row.sourceRow}`,
    }))));

    await insertChunks(contract.accounts, 600, (chunk) => tx.insert(schema.unearnedRevenueAccountPeriods).values(chunk.map((row) => ({
      snapshotId: snapshot.id,
      periodEnd: row.periodEnd,
      accountId: row.accountId,
      studentId: row.studentId,
      classId: row.classId,
      studentName: row.studentName,
      className: row.className,
      classSubject: row.classSubject,
      ledgerRemainingCredits: row.ledgerRemainingCredits,
      openingPaidCredits: row.openingPaidCredits,
      deferredPaidCredits: row.deferredPaidCredits,
      recognizedPaidCredits: row.recognizedPaidCredits,
      closingPaidCredits: row.closingPaidCredits,
      legacyClosingLiabilityThb: row.legacyClosingLiabilityThb,
      fifoOpeningLiabilityThb: row.fifoOpeningLiabilityThb,
      fifoDeferredNewLiabilityThb: row.fifoDeferredNewLiabilityThb,
      fifoRecognizedRevenueThb: row.fifoRecognizedRevenueThb,
      fifoClosingLiabilityThb: row.fifoClosingLiabilityThb,
      canonicalClosingLiabilityThb: row.canonicalClosingLiabilityThb,
      attributedLiabilityThb: row.attributedLiabilityThb,
      residualLiabilityThb: row.residualLiabilityThb,
      reviewState: row.reviewState,
      traceSpreadsheetId: spreadsheetId,
      traceSheetId: sheetIds["CALC_Account_Period"],
      traceRow: row.sourceRow,
      traceA1: `T${row.sourceRow}`,
    }))));

    await insertChunks(contract.lots, 300, (chunk) => tx.insert(schema.unearnedRevenueLotPeriods).values(chunk.map((row) => ({
      snapshotId: snapshot.id,
      periodEnd: row.periodEnd,
      lotId: row.lotId,
      accountId: row.accountId,
      studentId: row.studentId,
      classId: row.classId,
      studentName: row.studentName,
      className: row.className,
      lotKind: row.lotKind,
      matchStatus: row.matchStatus,
      matchConfidence: row.matchConfidence ?? "RESIDUAL",
      matchRuleId: row.matchRuleId ?? "",
      matchEvidence: row.matchEvidence ?? {},
      reviewState: row.reviewState,
      packageName: row.packageName,
      transactionNumber: row.transactionNumber,
      salesKey: row.salesKey,
      transactionDate: row.transactionDate,
      creditEventKey: row.creditEventKey,
      originalCredits: row.originalCredits,
      packageCredits: row.packageCredits,
      negativeRecoveryCredits: row.negativeRecoveryCredits,
      openingCredits: row.openingCredits,
      deferredCredits: row.deferredCredits,
      recognizedCredits: row.recognizedCredits,
      remainingCredits: row.remainingCredits,
      unitRateThb: row.unitRateThb,
      netPaymentThb: row.netPaymentThb,
      openingLiabilityThb: row.openingLiabilityThb,
      deferredNewLiabilityThb: row.deferredNewLiabilityThb,
      recognizedRevenueThb: row.recognizedRevenueThb,
      closingLiabilityThb: row.closingLiabilityThb,
      candidateSalesKeys: row.candidateSalesKeys,
      candidateReceiptIds: row.candidateReceiptIds ?? "",
      formulaSpreadsheetId: spreadsheetId,
      formulaSheetId: sheetIds["CALC_Package_Lot_Period"],
      formulaRow: row.formulaRow,
      formulaA1: `AA${row.formulaRow}`,
      sourceSpreadsheetId: row.sourceSpreadsheetId,
      sourceSheetId: row.sourceSheetId,
      sourceRow: row.sourceRow,
      sourceA1: row.sourceRow ? sourceA1(row.sourceRow) : null,
      creditEventSpreadsheetId: row.creditEventSpreadsheetId ?? null,
      creditEventSheetId: row.creditEventSheetId ?? null,
      creditEventRow: row.creditEventRow ?? null,
      creditEventA1: row.creditEventRow ? sourceA1(row.creditEventRow) : null,
      receiptSpreadsheetId: row.receiptSourceRow ? spreadsheetId : null,
      receiptSheetId: row.receiptSourceRow ? sheetIds["SRC_Wise_Receipt"] ?? null : null,
      receiptRow: row.receiptSourceRow ?? null,
      receiptA1: row.receiptSourceRow ? `A${row.receiptSourceRow}:V${row.receiptSourceRow}` : null,
      receiptId: row.receiptId ?? "",
      receiptType: row.receiptType ?? "",
      receiptStatus: row.receiptStatus ?? "",
      receiptChargedAt: row.receiptChargedAt ? parseTimestamp(row.receiptChargedAt, "receipt_charged_at") : null,
      receiptAmountThb: row.receiptAmountThb ?? "0.00000000",
      receiptCurrency: row.receiptCurrency ?? "",
      receiptNote: row.receiptNote ?? "",
      receiptStudentId: row.receiptStudentId ?? "",
      receiptClassId: row.receiptClassId ?? "",
    }))));

    // A transaction owns one pg client; keep its statements serial. pg currently
    // queues concurrent query() calls but deprecates that behavior for pg 9.
    const periodCount = await tx.select({ value: count() }).from(schema.unearnedRevenuePeriods)
      .where(eq(schema.unearnedRevenuePeriods.snapshotId, snapshot.id));
    const studentCount = await tx.select({ value: count() }).from(schema.unearnedRevenueStudentPeriods)
      .where(eq(schema.unearnedRevenueStudentPeriods.snapshotId, snapshot.id));
    const accountCount = await tx.select({ value: count() }).from(schema.unearnedRevenueAccountPeriods)
      .where(eq(schema.unearnedRevenueAccountPeriods.snapshotId, snapshot.id));
    const lotCount = await tx.select({ value: count() }).from(schema.unearnedRevenueLotPeriods)
      .where(eq(schema.unearnedRevenueLotPeriods.snapshotId, snapshot.id));
    const exactPackageCount = await tx.select({ value: count() })
      .from(schema.unearnedRevenuePackagePeriods)
      .where(eq(schema.unearnedRevenuePackagePeriods.snapshotId, snapshot.id));
    const actualCounts = [
      periodCount[0]?.value,
      studentCount[0]?.value,
      accountCount[0]?.value,
      lotCount[0]?.value,
      exactPackageCount[0]?.value,
    ].map(Number);
    const expectedCounts = [
      contract.periods.length,
      contract.students.length,
      contract.accounts.length,
      contract.lots.length,
      contract.exactPackages.length,
    ];
    if (actualCounts.some((value, index) => value !== expectedCounts[index])) {
      throw new Error(`Staged snapshot row counts do not reconcile: ${actualCounts.join("/")} vs ${expectedCounts.join("/")}`);
    }

    await tx.update(schema.unearnedRevenueSnapshots).set({ active: false })
      .where(eq(schema.unearnedRevenueSnapshots.active, true));
    await tx.update(schema.unearnedRevenueSnapshots).set({ active: true })
      .where(eq(schema.unearnedRevenueSnapshots.id, snapshot.id));

    const retained = await tx.select({ id: schema.unearnedRevenueSnapshots.id })
      .from(schema.unearnedRevenueSnapshots)
      .orderBy(desc(schema.unearnedRevenueSnapshots.importedAt))
      .limit(2);
    const retainedIds = retained.map((row) => row.id);
    if (retainedIds.length > 0) {
      await tx.delete(schema.unearnedRevenuePeriods)
        .where(notInArray(schema.unearnedRevenuePeriods.snapshotId, retainedIds));
      await tx.delete(schema.unearnedRevenueStudentPeriods)
        .where(notInArray(schema.unearnedRevenueStudentPeriods.snapshotId, retainedIds));
      await tx.delete(schema.unearnedRevenueAccountPeriods)
        .where(notInArray(schema.unearnedRevenueAccountPeriods.snapshotId, retainedIds));
      await tx.delete(schema.unearnedRevenueLotPeriods)
        .where(notInArray(schema.unearnedRevenueLotPeriods.snapshotId, retainedIds));
      await tx.delete(schema.unearnedRevenuePackagePeriods)
        .where(notInArray(schema.unearnedRevenuePackagePeriods.snapshotId, retainedIds));
    }

    await tx.update(schema.unearnedRevenueSyncRuns).set({
      status: "success",
      sourceRunId: contract.status.sourceRunId,
      sourceFingerprint: contract.status.sourceFingerprint,
      sourceRevision: contract.status.sourceRevision,
      cutoff: contract.status.cutoff,
      importedSnapshotId: snapshot.id,
      periodCount: contract.periods.length,
      studentRowCount: contract.students.length,
      accountRowCount: contract.accounts.length,
      lotRowCount: contract.lots.length,
      metadata: {
        canonicalModel: contract.status.canonicalModel,
        modelVersion: contract.status.modelVersion,
        exactPackageRowCount: contract.exactPackages.length,
      },
      finishedAt: new Date(),
    }).where(eq(schema.unearnedRevenueSyncRuns.id, syncRunId));
    return { snapshotId: snapshot.id, idempotent: false };
  });
}

export async function runUnearnedRevenueSync(options: SyncOptions): Promise<UnearnedRevenueSyncResult> {
  const db = options.db ?? getDb();
  const spreadsheetId = getUnearnedRevenueSpreadsheetId();
  let syncRunId: string | null = null;
  try {
    const [run] = await db.insert(schema.unearnedRevenueSyncRuns).values({
      status: "running",
      triggerType: options.triggerType,
      actorEmail: options.actorEmail ?? null,
      spreadsheetId,
    }).returning({ id: schema.unearnedRevenueSyncRuns.id });
    syncRunId = run.id;
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { ok: true, skipped: true, idempotent: false, syncRunId: null, snapshotId: null, cutoff: null, counts: null };
    }
    throw error;
  }

  try {
    const { contract, sheetIds } = await readUnearnedRevenueWorkbook(
      getUnearnedRevenueConnectedEmail(),
      spreadsheetId,
    );
    const imported = await importUnearnedRevenueContract({ db, syncRunId, spreadsheetId, contract, sheetIds });
    return {
      ok: true,
      skipped: false,
      idempotent: imported.idempotent,
      syncRunId,
      snapshotId: imported.snapshotId,
      cutoff: contract.status.cutoff,
      counts: {
        periods: contract.periods.length,
        students: contract.students.length,
        accounts: contract.accounts.length,
        lots: contract.lots.length,
        exactPackages: contract.exactPackages.length,
      },
    };
  } catch (error) {
    const errorSummary = error instanceof Error ? error.message.slice(0, 2_000) : "Unknown import failure";
    await db.update(schema.unearnedRevenueSyncRuns).set({
      status: "failed",
      errorSummary,
      finishedAt: new Date(),
    }).where(eq(schema.unearnedRevenueSyncRuns.id, syncRunId));
    return {
      ok: false,
      skipped: false,
      idempotent: false,
      syncRunId,
      snapshotId: null,
      cutoff: null,
      counts: null,
      errorSummary,
    };
  }
}
