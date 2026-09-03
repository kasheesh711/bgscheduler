import "server-only";

import { and, asc, count, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";

import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { makeTraceAnchor } from "./trace";
import { getUnearnedRevenueConnectedEmail } from "./sync";
import {
  FIFO_PACKAGE_MODEL,
  LEGACY_ACCOUNT_MODEL,
  type UnearnedRevenueCapability,
  type UnearnedRevenueCanonicalModel,
  type UnearnedRevenueDashboardPayload,
  type UnearnedRevenuePeriodKind,
  type UnearnedRevenuePeriodSummary,
  type UnearnedRevenueReviewState,
  type UnearnedRevenueStudentDetailPayload,
  type UnearnedRevenueStudentRow,
} from "./types";

export class UnearnedRevenueDataError extends Error {
  constructor(message: string, public readonly status: 404 | 503) {
    super(message);
    this.name = "UnearnedRevenueDataError";
  }
}

export interface DashboardQuery {
  period?: string;
  search: string;
  scope: "positive" | "all";
  attribution: "all" | "attributed" | "residual" | "ambiguous" | "unattributed";
  review: "all" | "needs_review" | "clear";
  sort: "liability_desc" | "liability_asc" | "name_asc" | "credits_desc";
  page: number;
  pageSize: number;
}

function numberFromDb(value: string | number): number {
  return Number(value);
}

function canonicalModel(value: string): UnearnedRevenueCanonicalModel {
  return value === FIFO_PACKAGE_MODEL ? FIFO_PACKAGE_MODEL : LEGACY_ACCOUNT_MODEL;
}

function periodKind(value: string): UnearnedRevenuePeriodKind {
  return value === "LATEST" ? "LATEST" : "MONTH_END";
}

function reviewState(value: string): UnearnedRevenueReviewState {
  if (["NEEDS_REVIEW", "REVIEWED", "REVIEWED_RESIDUAL"].includes(value)) {
    return value as UnearnedRevenueReviewState;
  }
  return "NO_REVIEW";
}

function periodPayload(row: typeof schema.unearnedRevenuePeriods.$inferSelect): UnearnedRevenuePeriodSummary {
  return {
    periodEnd: row.periodEnd,
    periodKind: periodKind(row.periodKind),
    isLatest: row.isLatest,
    openingLiabilityThb: numberFromDb(row.openingLiabilityThb),
    deferredNewLiabilityThb: numberFromDb(row.deferredNewLiabilityThb),
    recognizedRevenueThb: numberFromDb(row.recognizedRevenueThb),
    closingLiabilityThb: numberFromDb(row.closingLiabilityThb),
    legacyClosingLiabilityThb: numberFromDb(row.legacyClosingLiabilityThb),
    fifoClosingLiabilityThb: numberFromDb(row.fifoClosingLiabilityThb),
    fifoVsLegacyDifferenceThb: numberFromDb(row.fifoVsLegacyDifferenceThb),
    remainingPaidCredits: numberFromDb(row.remainingPaidCredits),
    attributedLiabilityThb: numberFromDb(row.attributedLiabilityThb),
    residualLiabilityThb: numberFromDb(row.residualLiabilityThb),
    attributionPercent: numberFromDb(row.attributionPercent),
    studentCount: row.studentCount,
    accountCount: row.accountCount,
    trace: makeTraceAnchor({
      spreadsheetId: row.traceSpreadsheetId,
      sheetId: row.traceSheetId,
      row: row.traceRow,
      a1: row.traceA1,
    }),
  };
}

function studentPayload(
  row: typeof schema.unearnedRevenueStudentPeriods.$inferSelect,
): UnearnedRevenueStudentRow {
  const legacy = numberFromDb(row.legacyClosingLiabilityThb);
  const fifo = numberFromDb(row.fifoClosingLiabilityThb);
  return {
    studentId: row.studentId,
    studentName: row.studentName,
    parentName: row.parentName,
    accountCount: row.accountCount,
    ledgerRemainingCredits: numberFromDb(row.ledgerRemainingCredits),
    remainingPaidCredits: numberFromDb(row.remainingPaidCredits),
    legacyClosingLiabilityThb: legacy,
    fifoClosingLiabilityThb: fifo,
    canonicalClosingLiabilityThb: numberFromDb(row.canonicalClosingLiabilityThb),
    fifoVsLegacyDifferenceThb: fifo - legacy,
    attributedLiabilityThb: numberFromDb(row.attributedLiabilityThb),
    residualLiabilityThb: numberFromDb(row.residualLiabilityThb),
    attributionPercent: numberFromDb(row.attributionPercent),
    reviewState: reviewState(row.reviewState),
    trace: makeTraceAnchor({
      spreadsheetId: row.traceSpreadsheetId,
      sheetId: row.traceSheetId,
      row: row.traceRow,
      a1: row.traceA1,
    }),
  };
}

function latestCompletedBangkokDay(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const today = new Date(`${values.year}-${values.month}-${values.day}T00:00:00Z`);
  today.setUTCDate(today.getUTCDate() - 1);
  return today.toISOString().slice(0, 10);
}

async function activeSnapshot(db: Database) {
  const [snapshot] = await db.select().from(schema.unearnedRevenueSnapshots)
    .where(eq(schema.unearnedRevenueSnapshots.active, true)).limit(1);
  if (!snapshot) {
    throw new UnearnedRevenueDataError("No QA-passed unearned revenue snapshot has been imported yet", 503);
  }
  return snapshot;
}

function studentFilters(input: {
  snapshotId: string;
  periodEnd: string;
  query: DashboardQuery;
}): SQL[] {
  const filters: SQL[] = [
    eq(schema.unearnedRevenueStudentPeriods.snapshotId, input.snapshotId),
    eq(schema.unearnedRevenueStudentPeriods.periodEnd, input.periodEnd),
  ];
  if (input.query.scope === "positive") {
    filters.push(sql`${schema.unearnedRevenueStudentPeriods.canonicalClosingLiabilityThb} > 0`);
  }
  if (input.query.search) {
    const pattern = `%${input.query.search.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    filters.push(or(
      ilike(schema.unearnedRevenueStudentPeriods.studentName, pattern),
      ilike(schema.unearnedRevenueStudentPeriods.studentId, pattern),
      ilike(schema.unearnedRevenueStudentPeriods.parentName, pattern),
    )!);
  }
  if (input.query.review === "needs_review") {
    filters.push(eq(schema.unearnedRevenueStudentPeriods.reviewState, "NEEDS_REVIEW"));
  } else if (input.query.review === "clear") {
    filters.push(sql`${schema.unearnedRevenueStudentPeriods.reviewState} <> 'NEEDS_REVIEW'`);
  }
  if (input.query.attribution === "attributed") {
    filters.push(sql`${schema.unearnedRevenueStudentPeriods.residualLiabilityThb} = 0`);
  } else if (input.query.attribution === "residual") {
    filters.push(sql`${schema.unearnedRevenueStudentPeriods.residualLiabilityThb} > 0`);
  } else if (input.query.attribution === "ambiguous" || input.query.attribution === "unattributed") {
    const wanted = input.query.attribution === "ambiguous" ? "AMBIGUOUS" : "UNATTRIBUTED";
    filters.push(sql`exists (
      select 1 from ${schema.unearnedRevenueLotPeriods} lot
      where lot.snapshot_id = ${schema.unearnedRevenueStudentPeriods.snapshotId}
        and lot.period_end = ${schema.unearnedRevenueStudentPeriods.periodEnd}
        and lot.student_id = ${schema.unearnedRevenueStudentPeriods.studentId}
        and lot.match_status = ${wanted}
        and lot.closing_liability_thb > 0
    )`);
  }
  return filters;
}

export async function getUnearnedRevenueDashboard(
  query: DashboardQuery,
  capabilities: UnearnedRevenueCapability[],
  db: Database = getDb(),
): Promise<UnearnedRevenueDashboardPayload> {
  const snapshot = await activeSnapshot(db);
  const [periodRows, lastSync] = await Promise.all([
    db.select().from(schema.unearnedRevenuePeriods)
      .where(eq(schema.unearnedRevenuePeriods.snapshotId, snapshot.id))
      .orderBy(asc(schema.unearnedRevenuePeriods.periodEnd)),
    db.select().from(schema.unearnedRevenueSyncRuns)
      .orderBy(desc(schema.unearnedRevenueSyncRuns.startedAt)).limit(1).then((rows) => rows[0] ?? null),
  ]);
  if (periodRows.length === 0) throw new UnearnedRevenueDataError("The active snapshot has no periods", 503);
  const defaultPeriod = periodRows.find((row) => row.isLatest) ?? periodRows.at(-1)!;
  const selectedRow = query.period
    ? periodRows.find((row) => row.periodEnd === query.period)
    : defaultPeriod;
  if (!selectedRow) throw new UnearnedRevenueDataError("Reporting period not found", 404);

  const filters = studentFilters({ snapshotId: snapshot.id, periodEnd: selectedRow.periodEnd, query });
  const orderBy = query.sort === "liability_asc"
    ? [asc(schema.unearnedRevenueStudentPeriods.canonicalClosingLiabilityThb), asc(schema.unearnedRevenueStudentPeriods.studentName)]
    : query.sort === "name_asc"
      ? [asc(schema.unearnedRevenueStudentPeriods.studentName), asc(schema.unearnedRevenueStudentPeriods.studentId)]
      : query.sort === "credits_desc"
        ? [desc(schema.unearnedRevenueStudentPeriods.remainingPaidCredits), asc(schema.unearnedRevenueStudentPeriods.studentName)]
        : [desc(schema.unearnedRevenueStudentPeriods.canonicalClosingLiabilityThb), asc(schema.unearnedRevenueStudentPeriods.studentName)];
  const [studentRows, total] = await Promise.all([
    db.select().from(schema.unearnedRevenueStudentPeriods)
      .where(and(...filters)).orderBy(...orderBy)
      .limit(query.pageSize).offset((query.page - 1) * query.pageSize),
    db.select({ value: count() }).from(schema.unearnedRevenueStudentPeriods)
      .where(and(...filters)).then((rows) => Number(rows[0]?.value ?? 0)),
  ]);
  const selected = periodPayload(selectedRow);
  return {
    metadata: {
      snapshotId: snapshot.id,
      sourceRunId: snapshot.sourceRunId,
      sourceFingerprint: snapshot.sourceFingerprint,
      sourceRevision: snapshot.sourceRevision,
      cutoff: snapshot.cutoff,
      generatedAtBangkok: snapshot.generatedAtBangkok.toISOString(),
      importedAt: snapshot.importedAt.toISOString(),
      canonicalModel: canonicalModel(snapshot.canonicalModel),
      modelVersion: snapshot.modelVersion,
      modelMode: snapshot.modelMode === "CANONICAL" ? "CANONICAL" : "SHADOW",
      workbookUrl: `https://docs.google.com/spreadsheets/d/${encodeURIComponent(snapshot.spreadsheetId)}/edit`,
      connectedEmail: getUnearnedRevenueConnectedEmail(),
      lastSyncStatus: lastSync?.status ?? null,
      lastSyncAt: lastSync?.finishedAt?.toISOString() ?? lastSync?.startedAt.toISOString() ?? null,
      lastSyncError: lastSync?.errorSummary ?? null,
      stale: snapshot.cutoff < latestCompletedBangkokDay(),
      capabilities,
    },
    periods: periodRows.map(periodPayload),
    selectedPeriod: selected,
    quality: {
      ambiguousCount: selectedRow.ambiguousCount,
      unattributedCount: selectedRow.unattributedCount,
      fallbackValuedCount: selectedRow.fallbackValuedCount,
      negativeBalanceCount: selectedRow.negativeBalanceCount,
      apiVarianceCount: selectedRow.apiVarianceCount,
      reviewConditions: snapshot.reviewConditions,
    },
    students: studentRows.map(studentPayload),
    pagination: {
      page: query.page,
      pageSize: query.pageSize,
      totalRows: total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    },
    filters: {
      period: selectedRow.periodEnd,
      search: query.search,
      scope: query.scope,
      attribution: query.attribution,
      review: query.review,
      sort: query.sort,
    },
  };
}

export async function getUnearnedRevenueStudentDetail(
  input: { studentId: string; period?: string },
  db: Database = getDb(),
): Promise<UnearnedRevenueStudentDetailPayload> {
  const snapshot = await activeSnapshot(db);
  let periodEnd = input.period;
  if (!periodEnd) {
    const [latest] = await db.select({ periodEnd: schema.unearnedRevenuePeriods.periodEnd })
      .from(schema.unearnedRevenuePeriods)
      .where(and(
        eq(schema.unearnedRevenuePeriods.snapshotId, snapshot.id),
        eq(schema.unearnedRevenuePeriods.isLatest, true),
      )).limit(1);
    periodEnd = latest?.periodEnd;
  }
  if (!periodEnd) throw new UnearnedRevenueDataError("Reporting period not found", 404);

  const [student, accounts, lots] = await Promise.all([
    db.select().from(schema.unearnedRevenueStudentPeriods).where(and(
      eq(schema.unearnedRevenueStudentPeriods.snapshotId, snapshot.id),
      eq(schema.unearnedRevenueStudentPeriods.periodEnd, periodEnd),
      eq(schema.unearnedRevenueStudentPeriods.studentId, input.studentId),
    )).limit(1).then((rows) => rows[0]),
    db.select().from(schema.unearnedRevenueAccountPeriods).where(and(
      eq(schema.unearnedRevenueAccountPeriods.snapshotId, snapshot.id),
      eq(schema.unearnedRevenueAccountPeriods.periodEnd, periodEnd),
      eq(schema.unearnedRevenueAccountPeriods.studentId, input.studentId),
    )).orderBy(asc(schema.unearnedRevenueAccountPeriods.className)),
    db.select().from(schema.unearnedRevenueLotPeriods).where(and(
      eq(schema.unearnedRevenueLotPeriods.snapshotId, snapshot.id),
      eq(schema.unearnedRevenueLotPeriods.periodEnd, periodEnd),
      eq(schema.unearnedRevenueLotPeriods.studentId, input.studentId),
    )).orderBy(asc(schema.unearnedRevenueLotPeriods.transactionDate), asc(schema.unearnedRevenueLotPeriods.lotId)),
  ]);
  if (!student) throw new UnearnedRevenueDataError("Student not found for this reporting period", 404);
  return {
    periodEnd,
    canonicalModel: canonicalModel(snapshot.canonicalModel),
    modelVersion: snapshot.modelVersion,
    student: studentPayload(student),
    accounts: accounts.map((row) => ({
      accountId: row.accountId,
      classId: row.classId,
      className: row.className,
      classSubject: row.classSubject,
      ledgerRemainingCredits: numberFromDb(row.ledgerRemainingCredits),
      openingPaidCredits: numberFromDb(row.openingPaidCredits),
      deferredPaidCredits: numberFromDb(row.deferredPaidCredits),
      recognizedPaidCredits: numberFromDb(row.recognizedPaidCredits),
      closingPaidCredits: numberFromDb(row.closingPaidCredits),
      legacyClosingLiabilityThb: numberFromDb(row.legacyClosingLiabilityThb),
      fifoOpeningLiabilityThb: numberFromDb(row.fifoOpeningLiabilityThb),
      fifoDeferredNewLiabilityThb: numberFromDb(row.fifoDeferredNewLiabilityThb),
      fifoRecognizedRevenueThb: numberFromDb(row.fifoRecognizedRevenueThb),
      fifoClosingLiabilityThb: numberFromDb(row.fifoClosingLiabilityThb),
      canonicalClosingLiabilityThb: numberFromDb(row.canonicalClosingLiabilityThb),
      attributedLiabilityThb: numberFromDb(row.attributedLiabilityThb),
      residualLiabilityThb: numberFromDb(row.residualLiabilityThb),
      reviewState: reviewState(row.reviewState),
      trace: makeTraceAnchor({
        spreadsheetId: row.traceSpreadsheetId,
        sheetId: row.traceSheetId,
        row: row.traceRow,
        a1: row.traceA1,
      }),
    })),
    lots: lots.map((row) => ({
      lotId: row.lotId,
      accountId: row.accountId,
      lotKind: row.lotKind as UnearnedRevenueStudentDetailPayload["lots"][number]["lotKind"],
      matchStatus: row.matchStatus as UnearnedRevenueStudentDetailPayload["lots"][number]["matchStatus"],
      reviewState: reviewState(row.reviewState),
      packageName: row.packageName,
      transactionNumber: row.transactionNumber,
      transactionDate: row.transactionDate,
      originalCredits: numberFromDb(row.originalCredits),
      packageCredits: numberFromDb(row.packageCredits),
      negativeRecoveryCredits: numberFromDb(row.negativeRecoveryCredits),
      openingCredits: numberFromDb(row.openingCredits),
      deferredCredits: numberFromDb(row.deferredCredits),
      recognizedCredits: numberFromDb(row.recognizedCredits),
      remainingCredits: numberFromDb(row.remainingCredits),
      unitRateThb: numberFromDb(row.unitRateThb),
      netPaymentThb: numberFromDb(row.netPaymentThb),
      openingLiabilityThb: numberFromDb(row.openingLiabilityThb),
      deferredNewLiabilityThb: numberFromDb(row.deferredNewLiabilityThb),
      recognizedRevenueThb: numberFromDb(row.recognizedRevenueThb),
      closingLiabilityThb: numberFromDb(row.closingLiabilityThb),
      candidateSalesKeys: row.candidateSalesKeys.split(";").map((item) => item.trim()).filter(Boolean),
      formulaTrace: makeTraceAnchor({
        spreadsheetId: row.formulaSpreadsheetId,
        sheetId: row.formulaSheetId,
        row: row.formulaRow,
        a1: row.formulaA1,
      }),
      sourceTrace: row.sourceSpreadsheetId && row.sourceSheetId !== null && row.sourceRow !== null && row.sourceA1
        ? makeTraceAnchor({
            spreadsheetId: row.sourceSpreadsheetId,
            sheetId: row.sourceSheetId,
            row: row.sourceRow,
            a1: row.sourceA1,
          })
        : null,
    })),
  };
}
