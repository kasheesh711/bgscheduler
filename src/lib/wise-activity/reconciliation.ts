import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { addBangkokDays, bangkokDateKey, bangkokDateStartUtc, endOfBangkokMonth, todayBangkok } from "@/lib/room-capacity/dates";
import type { SalesDashboardSourceRecord, SalesSourceStatus } from "@/lib/sales-dashboard/types";
import { createWiseClient } from "@/lib/wise/client";
import {
  fetchWiseFeesPaidTrends,
  fetchWiseReceiptTransactions,
  type WiseFeesPaidTrend,
  type WiseReceiptTransaction,
} from "@/lib/wise/fetchers";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const MAX_CANDIDATES_PER_ROW = 5;
const DEFAULT_INSTITUTE_ID = "696e1f4d90102225641cc413";

export interface ReconciliationSourceSummary {
  id: string;
  sourceMonth: string;
  label: string;
  status: SalesSourceStatus;
  lastImportedAt: string | null;
  lastNormalRowCount: number;
}

export interface PackageSaleInput {
  id: string;
  rowNumber: number;
  studentNickname: string;
  program: string;
  packageHours: string;
  paymentAmount: number;
  paymentDate: string;
  enrollmentType: string;
  programWiseName: string;
  packageHoursClean: string;
  raw: Record<string, unknown>;
}

export interface WiseInvoiceEventInput {
  id: string;
  eventId: string;
  eventType: string;
  eventName: string;
  eventTimestamp: Date;
  actorName: string | null;
  actorWiseUserId: string | null;
  classroomId: string | null;
  classroomName: string | null;
  classroomSubject: string | null;
  transactionId: string | null;
  transactionStatus: string | null;
  transactionAmount: number | null;
  transactionCurrency: string | null;
  payload: Record<string, unknown>;
  raw: Record<string, unknown>;
}

export interface CreditPackageInput {
  wiseStudentId: string;
  wiseClassId: string;
  studentKey: string;
  studentName: string;
  parentName: string;
  packageName: string;
  subject: string;
}

export interface ReconciliationCandidate {
  source: "wise_receipt";
  id: string;
  eventId: string;
  eventName: string;
  eventTimestamp: string;
  eventDate: string;
  receiptType: string | null;
  receiptStatus: string | null;
  actorName: string | null;
  classroomId: string | null;
  classroomName: string | null;
  classroomSubject: string | null;
  transactionId: string | null;
  transactionStatus: string | null;
  transactionAmount: number | null;
  transactionCurrency: string | null;
  score: number;
  confidence: "high" | "medium" | "low";
  reasons: string[];
  payload: Record<string, unknown>;
  raw: Record<string, unknown>;
}

export interface ReconciliationSaleRow {
  id: string;
  rowNumber: number;
  studentNickname: string;
  studentKey: string;
  parentAccount: string;
  transactionNo: string;
  paymentDate: string;
  paymentAmount: number;
  packageName: string;
  program: string;
  packageHours: string;
  enrollmentType: string;
  recordedInWise: string;
  reviewFlags: string[];
  candidates: ReconciliationCandidate[];
}

export interface ReconciliationStudentGroup {
  studentKey: string;
  studentNickname: string;
  rowCount: number;
  totalAmount: number;
  rowsWithCandidates: number;
  rowsNeedingReview: number;
  rows: ReconciliationSaleRow[];
}

export interface ReconciliationCoverage {
  status: "complete" | "partial" | "empty";
  requiredStartDate: string;
  requiredEndDate: string;
  firstInboundEventAt: string | null;
  lastInboundEventAt: string | null;
  firstInboundEventDate: string | null;
  lastInboundEventDate: string | null;
  inboundEventCount: number;
  message: string;
}

export interface ReconciliationRevenueVariance {
  startDate: string;
  endDate: string;
  periodLabel: string;
  sheetPackageSalesTotal: number;
  wiseRevenueTotal: number | null;
  difference: number | null;
  differencePct: number | null;
  currency: "THB";
  wiseRevenueAvailable: boolean;
  wiseRevenueUnavailableReason: string | null;
  wiseRevenueTrendTimestamp: string | null;
  wiseRevenueTransactionCount: number | null;
  wiseReceiptsAvailable: boolean;
  wiseReceiptsUnavailableReason: string | null;
  wiseReceiptTotal: number | null;
  wiseReceiptCount: number | null;
  wiseReceiptSkippedCount: number | null;
  sheetMinusReceipts: number | null;
  receiptsMinusTrend: number | null;
  source: "wise_fees_paid_trend";
}

export interface WisePackageSalesReconciliation {
  sources: ReconciliationSourceSummary[];
  selectedSource: ReconciliationSourceSummary | null;
  dateRange: {
    startDate: string;
    endDate: string;
  };
  coverage: ReconciliationCoverage;
  summary: {
    saleRows: number;
    students: number;
    sheetTotal: number;
    rowsWithCandidates: number;
    rowsNeedingReview: number;
    candidateCount: number;
    wiseInboundEvents: number;
    wiseReceipts: number;
  };
  revenueVariance: ReconciliationRevenueVariance;
  students: ReconciliationStudentGroup[];
}

export interface WiseReconciliationActionSummary {
  selectedSourceLabel: string | null;
  selectedSourceMonth: string | null;
  saleRows: number;
  rowsWithPersistedCandidates: number;
  rowsNeedingReview: number;
  coverageStatus: ReconciliationCoverage["status"];
}

export interface ReconciliationBuildInput {
  sources: ReconciliationSourceSummary[];
  selectedSource: ReconciliationSourceSummary | null;
  saleRows: PackageSaleInput[];
  wiseEvents: WiseInvoiceEventInput[];
  wiseReceipts?: WiseReceiptTransaction[];
  wiseReceiptsError?: string | null;
  creditPackages: CreditPackageInput[];
  startDate: string;
  endDate: string;
  wiseFeesPaidTrends?: WiseFeesPaidTrend[];
  wiseFeesPaidTrendsError?: string | null;
}

interface SaleEvidence {
  transactionNo: string;
  parentAccount: string;
  recordedInWise: string;
  packageName: string;
  packageHints: string[];
  mappedStudentIds: Set<string>;
  mappedClassIds: Set<string>;
}

function sourceSummary(source: SalesDashboardSourceRecord): ReconciliationSourceSummary {
  return {
    id: source.id,
    sourceMonth: source.sourceMonth,
    label: source.label,
    status: source.status,
    lastImportedAt: source.lastImportedAt?.toISOString() ?? null,
    lastNormalRowCount: source.lastNormalRowCount,
  };
}

function normalizeText(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function compactKey(value: unknown): string {
  return normalizeText(value).replace(/[^a-z0-9]+/g, "");
}

function stringCell(raw: Record<string, unknown>, names: string[]): string {
  for (const name of names) {
    const value = String(raw[name] ?? "").trim();
    if (value) return value;
  }
  return "";
}

function moneyEqual(left: number, right: number | null): boolean {
  return typeof right === "number" && Math.abs(left - right) < 0.01;
}

function dayDistance(left: string, right: string): number {
  return Math.abs((bangkokDateStartUtc(left).getTime() - bangkokDateStartUtc(right).getTime()) / DAY_MS);
}

function nestedString(value: unknown, path: string[]): string {
  let cursor: unknown = value;
  for (const key of path) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return "";
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return String(cursor ?? "").trim();
}

function allNestedStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(allNestedStrings);
  return Object.values(value).flatMap(allNestedStrings);
}

function receiptIdentifiers(receipt: WiseReceiptTransaction): Set<string> {
  return new Set(receipt.identifiers.map(compactKey).filter(Boolean));
}

function receiptClassIds(receipt: WiseReceiptTransaction): Set<string> {
  return new Set([
    receipt.classId,
    nestedString(receipt.raw, ["metadata", "classId"]),
    nestedString(receipt.raw, ["classroom", "_id"]),
  ].map((value) => String(value ?? "").trim()).filter(Boolean));
}

function receiptStudentIds(receipt: WiseReceiptTransaction): Set<string> {
  return new Set([
    receipt.studentId,
    nestedString(receipt.raw, ["student", "_id"]),
    nestedString(receipt.raw, ["participant", "_id"]),
    nestedString(receipt.raw, ["metadata", "studentId"]),
  ].map((value) => String(value ?? "").trim()).filter(Boolean));
}

function receiptSearchText(receipt: WiseReceiptTransaction): string {
  return normalizeText([
    receipt.studentName,
    ...receipt.parentNames,
    receipt.classroomName,
    receipt.classroomSubject,
    receipt.note,
    ...receipt.identifiers,
    ...allNestedStrings(receipt.raw),
  ].join(" "));
}

export function isInboundWiseInvoiceEvent(event: {
  eventType?: string | null;
  eventName?: string | null;
  transactionId?: string | null;
}): boolean {
  const eventName = event.eventName ?? "";
  if (/payout/i.test(eventName)) return false;
  return event.eventType === "BILLING" ||
    Boolean(event.transactionId) ||
    /invoice|payment|transaction/i.test(eventName);
}

function packageMatchesSale(row: PackageSaleInput, creditPackage: CreditPackageInput): boolean {
  const student = compactKey(row.studentNickname);
  const packageStudent = compactKey(creditPackage.studentName);
  const parent = compactKey(stringCell(row.raw, ["Parent's Account", "Parent Account", "Parent"]));
  const packageParent = compactKey(creditPackage.parentName);
  const packageName = normalizeText(creditPackage.packageName);
  const subject = normalizeText(creditPackage.subject);
  const hints = [
    row.programWiseName,
    row.program,
    row.packageHoursClean,
    row.packageHours,
  ].map(normalizeText).filter(Boolean);

  const studentMatches = Boolean(student) && (
    packageStudent === student ||
    packageStudent.includes(student) ||
    student.includes(packageStudent)
  );
  const parentMatches = Boolean(parent) && Boolean(packageParent) && (
    packageParent.includes(parent) ||
    parent.includes(packageParent)
  );
  const packageMatches = hints.some((hint) =>
    hint.length >= 3 && (packageName.includes(hint) || subject.includes(hint)),
  );

  return studentMatches || (parentMatches && packageMatches) || (studentMatches && packageMatches);
}

function buildSaleEvidence(row: PackageSaleInput, creditPackages: CreditPackageInput[]): SaleEvidence {
  const parentAccount = stringCell(row.raw, ["Parent's Account", "Parent Account", "Parent"]);
  const transactionNo = stringCell(row.raw, ["Transaction No.", "Transaction No", "Transaction ID", "Invoice No.", "Invoice No"]);
  const recordedInWise = stringCell(row.raw, ["Recorded in WISE?", "Recorded in WISE", "Recorded in Wise?"]);
  const packageName = [row.programWiseName || row.program, row.packageHoursClean || row.packageHours]
    .filter(Boolean)
    .join(" ")
    .trim();
  const packageHints = [
    row.programWiseName,
    row.program,
    row.packageHoursClean,
    row.packageHours,
    packageName,
    parentAccount,
    row.studentNickname,
  ].map(normalizeText).filter(Boolean);
  const mappedPackages = creditPackages.filter((creditPackage) => packageMatchesSale(row, creditPackage));

  return {
    transactionNo,
    parentAccount,
    recordedInWise,
    packageName,
    packageHints,
    mappedStudentIds: new Set(mappedPackages.map((item) => item.wiseStudentId).filter(Boolean)),
    mappedClassIds: new Set(mappedPackages.map((item) => item.wiseClassId).filter(Boolean)),
  };
}

function scoreReceiptCandidate(row: PackageSaleInput, evidence: SaleEvidence, receipt: WiseReceiptTransaction): ReconciliationCandidate | null {
  const reasons: string[] = [];
  let score = 0;
  const transactionAmount = receipt.amount;

  const normalizedTransactionNo = compactKey(evidence.transactionNo);
  if (normalizedTransactionNo && receiptIdentifiers(receipt).has(normalizedTransactionNo)) {
    score += 100;
    reasons.push("Sheet transaction number appears on the Wise receipt.");
  }

  const classIds = receiptClassIds(receipt);
  if ([...classIds].some((id) => evidence.mappedClassIds.has(id))) {
    score += 50;
    reasons.push("Wise class ID matches the student's active Credit Control package.");
  }

  const studentIds = receiptStudentIds(receipt);
  if ([...studentIds].some((id) => evidence.mappedStudentIds.has(id))) {
    score += 50;
    reasons.push("Wise student ID matches the student's active Credit Control package.");
  }

  if (moneyEqual(row.paymentAmount, transactionAmount)) {
    score += 30;
    reasons.push("Payment amount matches the package-sale row.");
  }

  const receiptTimestamp = new Date(receipt.chargedAt);
  if (Number.isNaN(receiptTimestamp.getTime())) return null;
  const eventDate = bangkokDateKey(receiptTimestamp);
  const distance = dayDistance(row.paymentDate, eventDate);
  if (distance === 0) {
    score += 20;
    reasons.push("Wise receipt date matches the sheet payment date.");
  } else if (distance <= 3) {
    score += 10;
    reasons.push(`Wise receipt date is within ${distance} day${distance === 1 ? "" : "s"} of the sheet payment date.`);
  }

  const searchText = receiptSearchText(receipt);
  const packageTextHit = evidence.packageHints.some((hint) => hint.length >= 3 && searchText.includes(hint));
  if (packageTextHit) {
    score += 15;
    reasons.push("Wise receipt text overlaps with the sheet student, parent, program, or package text.");
  }

  if (score < 20) return null;

  return {
    source: "wise_receipt",
    id: receipt.id,
    eventId: receipt.id,
    eventName: "WiseReceiptTransaction",
    eventTimestamp: receiptTimestamp.toISOString(),
    eventDate,
    receiptType: receipt.type || null,
    receiptStatus: receipt.status || null,
    actorName: receipt.studentName,
    classroomId: receipt.classId,
    classroomName: receipt.classroomName,
    classroomSubject: receipt.classroomSubject,
    transactionId: receipt.id,
    transactionStatus: receipt.status,
    transactionAmount,
    transactionCurrency: receipt.currency,
    score,
    confidence: score >= 80 ? "high" : score >= 45 ? "medium" : "low",
    reasons,
    payload: receipt.raw,
    raw: receipt.raw,
  };
}

function buildCoverage(events: WiseInvoiceEventInput[], startDate: string, endDate: string): ReconciliationCoverage {
  const inboundDates = events
    .filter(isInboundWiseInvoiceEvent)
    .map((event) => ({ timestamp: event.eventTimestamp, date: bangkokDateKey(event.eventTimestamp) }))
    .sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());

  const first = inboundDates[0] ?? null;
  const last = inboundDates.at(-1) ?? null;
  const complete = Boolean(first && last && first.date <= startDate && last.date >= endDate);
  const status = inboundDates.length === 0 ? "empty" : complete ? "complete" : "partial";
  const span = first && last ? `${first.date} to ${last.date}` : "no persisted inbound invoice/payment events";

  return {
    status,
    requiredStartDate: startDate,
    requiredEndDate: endDate,
    firstInboundEventAt: first?.timestamp.toISOString() ?? null,
    lastInboundEventAt: last?.timestamp.toISOString() ?? null,
    firstInboundEventDate: first?.date ?? null,
    lastInboundEventDate: last?.date ?? null,
    inboundEventCount: inboundDates.length,
    message: complete
      ? `Persisted inbound Wise invoice/payment events span the selected range (${span}).`
      : `Persisted inbound Wise invoice/payment events span ${span}; backfill before trusting missing-candidate rows for ${startDate} to ${endDate}.`,
  };
}

function periodLabel(startDate: string, endDate: string): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const [startYear, startMonth, startDay] = startDate.split("-").map(Number);
  const [endYear, endMonth, endDay] = endDate.split("-").map(Number);
  if (startYear === endYear && startMonth === endMonth && startDay === endDay) {
    return `${months[startMonth - 1]} ${startDay}, ${startYear}`;
  }
  if (startYear === endYear && startMonth === endMonth) {
    return `${months[startMonth - 1]} ${startDay}-${endDay}, ${startYear}`;
  }
  return `${startDate} to ${endDate}`;
}

function sourceMonthForVariance(input: ReconciliationBuildInput): string {
  return input.selectedSource?.sourceMonth.slice(0, 7) ?? input.startDate.slice(0, 7);
}

function trendMonth(trend: WiseFeesPaidTrend): string {
  const timestamp = new Date(trend.timestamp);
  if (Number.isNaN(timestamp.getTime())) return "";
  return bangkokDateKey(timestamp).slice(0, 7);
}

function isReceiptRevenue(receipt: WiseReceiptTransaction): boolean {
  const type = receipt.type.toUpperCase();
  const status = receipt.status.toUpperCase();
  return (type === "PAYMENT" || type === "OFFLINE_PAYMENT") &&
    status === "CHARGED" &&
    typeof receipt.amount === "number" &&
    receipt.amount > 0;
}

function buildRevenueVariance(
  rows: ReconciliationSaleRow[],
  startDate: string,
  endDate: string,
  sourceMonth: string,
  trends: WiseFeesPaidTrend[] | undefined,
  trendsError: string | null | undefined,
  receipts: WiseReceiptTransaction[] | undefined,
  receiptsError: string | null | undefined,
): ReconciliationRevenueVariance {
  const sheetPackageSalesTotal = rows.reduce((sum, row) => sum + row.paymentAmount, 0);
  const trend = trends?.find((candidate) => trendMonth(candidate) === sourceMonth) ?? null;
  const wiseRevenueTotal = trend?.amount ?? null;
  const difference = typeof wiseRevenueTotal === "number" ? sheetPackageSalesTotal - wiseRevenueTotal : null;
  const unavailableReason = trendsError
    ? `Wise fees paid trend unavailable: ${trendsError}`
    : trend
      ? null
      : `Wise fees paid trend has no row for ${sourceMonth}.`;
  const revenueReceipts = (receipts ?? []).filter(isReceiptRevenue);
  const wiseReceiptTotal = receiptsError
    ? null
    : revenueReceipts.reduce((sum, receipt) => sum + (receipt.amount ?? 0), 0);
  const wiseReceiptCount = receiptsError ? null : revenueReceipts.length;
  const wiseReceiptSkippedCount = receiptsError ? null : (receipts ?? []).length - revenueReceipts.length;
  const sheetMinusReceipts = typeof wiseReceiptTotal === "number" ? sheetPackageSalesTotal - wiseReceiptTotal : null;
  const receiptsMinusTrend = typeof wiseReceiptTotal === "number" && typeof wiseRevenueTotal === "number"
    ? wiseReceiptTotal - wiseRevenueTotal
    : null;

  return {
    startDate,
    endDate,
    periodLabel: periodLabel(startDate, endDate),
    sheetPackageSalesTotal,
    wiseRevenueTotal,
    difference,
    differencePct: typeof difference === "number" && wiseRevenueTotal ? (difference / wiseRevenueTotal) * 100 : null,
    currency: "THB",
    wiseRevenueAvailable: Boolean(trend),
    wiseRevenueUnavailableReason: unavailableReason,
    wiseRevenueTrendTimestamp: trend?.timestamp ?? null,
    wiseRevenueTransactionCount: trend?.count ?? null,
    wiseReceiptsAvailable: !receiptsError,
    wiseReceiptsUnavailableReason: receiptsError ? `Wise receipts unavailable: ${receiptsError}` : null,
    wiseReceiptTotal,
    wiseReceiptCount,
    wiseReceiptSkippedCount,
    sheetMinusReceipts,
    receiptsMinusTrend,
    source: "wise_fees_paid_trend",
  };
}

function makeSaleRow(row: PackageSaleInput, candidates: ReconciliationCandidate[], evidence: SaleEvidence): ReconciliationSaleRow {
  const reviewFlags: string[] = [];
  if (candidates.length === 0) reviewFlags.push("No Wise receipt candidates found.");
  if (!evidence.transactionNo) reviewFlags.push("Sheet row has no transaction number.");
  if (evidence.recordedInWise && !/yes|y|true|recorded/i.test(evidence.recordedInWise)) {
    reviewFlags.push(`Sheet WISE status is "${evidence.recordedInWise}".`);
  }

  return {
    id: row.id,
    rowNumber: row.rowNumber,
    studentNickname: row.studentNickname,
    studentKey: compactKey(row.studentNickname) || `row-${row.rowNumber}`,
    parentAccount: evidence.parentAccount,
    transactionNo: evidence.transactionNo,
    paymentDate: row.paymentDate,
    paymentAmount: row.paymentAmount,
    packageName: evidence.packageName,
    program: row.program,
    packageHours: row.packageHours,
    enrollmentType: row.enrollmentType,
    recordedInWise: evidence.recordedInWise,
    reviewFlags,
    candidates,
  };
}

function persistedEventMatchesSale(
  row: PackageSaleInput,
  evidence: SaleEvidence,
  event: WiseInvoiceEventInput,
): boolean {
  const transactionNo = compactKey(evidence.transactionNo);
  if (transactionNo) {
    const identifiers = [
      event.transactionId,
      event.eventId,
      nestedString(event.payload, ["transactionId"]),
      nestedString(event.payload, ["transaction", "_id"]),
      nestedString(event.raw, ["transactionId"]),
      nestedString(event.raw, ["transaction", "_id"]),
    ].map(compactKey).filter(Boolean);
    if (identifiers.includes(transactionNo)) return true;
  }

  if (!moneyEqual(row.paymentAmount, event.transactionAmount)) return false;
  const eventDate = bangkokDateKey(event.eventTimestamp);
  if (dayDistance(row.paymentDate, eventDate) > 3) return false;
  const eventText = normalizeText([
    event.actorName,
    event.classroomName,
    event.classroomSubject,
    event.transactionId,
    ...allNestedStrings(event.payload),
    ...allNestedStrings(event.raw),
  ].join(" "));
  return evidence.packageHints.some((hint) => hint.length >= 3 && eventText.includes(hint));
}

export function buildPackageSalesReconciliation(input: ReconciliationBuildInput): WisePackageSalesReconciliation {
  const wiseEvents = input.wiseEvents.filter(isInboundWiseInvoiceEvent);
  const wiseReceipts = input.wiseReceipts ?? [];
  const rows = input.saleRows.map((row) => {
    const evidence = buildSaleEvidence(row, input.creditPackages);
    const candidates = wiseReceipts
      .map((receipt) => scoreReceiptCandidate(row, evidence, receipt))
      .filter((candidate): candidate is ReconciliationCandidate => Boolean(candidate))
      .sort((left, right) => right.score - left.score || left.eventTimestamp.localeCompare(right.eventTimestamp))
      .slice(0, MAX_CANDIDATES_PER_ROW);
    return makeSaleRow(row, candidates, evidence);
  });

  const groupMap = new Map<string, ReconciliationStudentGroup>();
  for (const row of rows) {
    const key = row.studentKey;
    const current = groupMap.get(key) ?? {
      studentKey: key,
      studentNickname: row.studentNickname,
      rowCount: 0,
      totalAmount: 0,
      rowsWithCandidates: 0,
      rowsNeedingReview: 0,
      rows: [],
    };
    current.rowCount += 1;
    current.totalAmount += row.paymentAmount;
    if (row.candidates.length > 0) current.rowsWithCandidates += 1;
    if (row.reviewFlags.length > 0) current.rowsNeedingReview += 1;
    current.rows.push(row);
    groupMap.set(key, current);
  }

  const students = [...groupMap.values()].sort((left, right) =>
    right.rowsNeedingReview - left.rowsNeedingReview ||
    left.studentNickname.localeCompare(right.studentNickname),
  );
  const rowsWithCandidates = rows.filter((row) => row.candidates.length > 0).length;
  const rowsNeedingReview = rows.filter((row) => row.reviewFlags.length > 0).length;
  const coverage = buildCoverage(wiseEvents, input.startDate, input.endDate);

  return {
    sources: input.sources,
    selectedSource: input.selectedSource,
    dateRange: {
      startDate: input.startDate,
      endDate: input.endDate,
    },
    coverage,
    summary: {
      saleRows: rows.length,
      students: students.length,
      sheetTotal: rows.reduce((sum, row) => sum + row.paymentAmount, 0),
      rowsWithCandidates,
      rowsNeedingReview,
      candidateCount: rows.reduce((sum, row) => sum + row.candidates.length, 0),
      wiseInboundEvents: wiseEvents.length,
      wiseReceipts: wiseReceipts.length,
    },
    revenueVariance: buildRevenueVariance(
      rows,
      input.startDate,
      input.endDate,
      sourceMonthForVariance(input),
      input.wiseFeesPaidTrends,
      input.wiseFeesPaidTrendsError,
      input.wiseReceipts,
      input.wiseReceiptsError,
    ),
    students,
  };
}

function validateDateRange(startDate: string, endDate: string): void {
  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate) || startDate > endDate) {
    throw new Error("Invalid date range");
  }
}

function defaultDateRange(rows: PackageSaleInput[], source: SalesDashboardSourceRecord): { startDate: string; endDate: string } {
  const dates = rows.map((row) => row.paymentDate).filter((date) => DATE_RE.test(date)).sort();
  if (dates.length > 0) {
    return {
      startDate: dates[0],
      endDate: dates.at(-1) ?? dates[0],
    };
  }
  return {
    startDate: source.sourceMonth,
    endDate: endOfBangkokMonth(source.sourceMonth),
  };
}

function toSaleInput(row: typeof schema.salesDashboardNormalRows.$inferSelect): PackageSaleInput {
  return {
    id: row.id,
    rowNumber: row.rowNumber,
    studentNickname: row.studentNickname,
    program: row.program,
    packageHours: row.packageHours,
    paymentAmount: row.paymentAmount,
    paymentDate: row.paymentDate,
    enrollmentType: row.enrollmentType,
    programWiseName: row.programWiseName,
    packageHoursClean: row.packageHoursClean,
    raw: row.raw,
  };
}

function toWiseInvoiceInput(row: typeof schema.wiseActivityEvents.$inferSelect): WiseInvoiceEventInput {
  return {
    id: row.id,
    eventId: row.eventId,
    eventType: row.eventType,
    eventName: row.eventName,
    eventTimestamp: row.eventTimestamp,
    actorName: row.actorName,
    actorWiseUserId: row.actorWiseUserId,
    classroomId: row.classroomId,
    classroomName: row.classroomName,
    classroomSubject: row.classroomSubject,
    transactionId: row.transactionId,
    transactionStatus: row.transactionStatus,
    transactionAmount: row.transactionAmount,
    transactionCurrency: row.transactionCurrency,
    payload: row.payload,
    raw: row.raw,
  };
}

async function listReconciliationSources(db: Database): Promise<SalesDashboardSourceRecord[]> {
  const rows = await db
    .select()
    .from(schema.salesDashboardSources)
    .where(sql`${schema.salesDashboardSources.status}::text <> 'archived'`)
    .orderBy(desc(schema.salesDashboardSources.sourceMonth));
  return rows as SalesDashboardSourceRecord[];
}

function selectSource(
  sources: SalesDashboardSourceRecord[],
  input: { sourceId?: string; month?: string },
): SalesDashboardSourceRecord | null {
  if (input.sourceId) return sources.find((source) => source.id === input.sourceId) ?? null;
  if (input.month) return sources.find((source) => source.sourceMonth.slice(0, 7) === input.month) ?? null;
  return sources.find((source) => source.lastSuccessfulImportRunId) ?? sources[0] ?? null;
}

async function loadWiseFeesPaidTrends(): Promise<{
  trends: WiseFeesPaidTrend[] | undefined;
  error: string | null;
}> {
  if (!process.env.WISE_USER_ID || !process.env.WISE_API_KEY) {
    return {
      trends: undefined,
      error: "WISE_USER_ID and WISE_API_KEY are required to fetch Wise fees paid trends.",
    };
  }

  try {
    return {
      trends: await fetchWiseFeesPaidTrends(
        createWiseClient(),
        process.env.WISE_INSTITUTE_ID ?? DEFAULT_INSTITUTE_ID,
      ),
      error: null,
    };
  } catch (error) {
    return {
      trends: undefined,
      error: error instanceof Error ? error.message : "Wise fees paid trend fetch failed.",
    };
  }
}

async function loadWiseReceipts(startDate: string, endDate: string): Promise<{
  receipts: WiseReceiptTransaction[] | undefined;
  error: string | null;
}> {
  if (!process.env.WISE_USER_ID || !process.env.WISE_API_KEY) {
    return {
      receipts: undefined,
      error: "WISE_USER_ID and WISE_API_KEY are required to fetch Wise receipts.",
    };
  }

  try {
    return {
      receipts: await fetchWiseReceiptTransactions(
        createWiseClient(),
        process.env.WISE_INSTITUTE_ID ?? DEFAULT_INSTITUTE_ID,
        { startDate, endDate },
      ),
      error: null,
    };
  } catch (error) {
    return {
      receipts: undefined,
      error: error instanceof Error ? error.message : "Wise receipt fetch failed.",
    };
  }
}

export async function getWisePackageSalesReconciliation(
  db: Database = getDb(),
  input: {
    sourceId?: string;
    month?: string;
    startDate?: string;
    endDate?: string;
  } = {},
): Promise<WisePackageSalesReconciliation> {
  const sources = await listReconciliationSources(db);
  const selectedSource = selectSource(sources, input);
  if (!selectedSource) {
    return buildPackageSalesReconciliation({
      sources: sources.map(sourceSummary),
      selectedSource: null,
      saleRows: [],
      wiseEvents: [],
      creditPackages: [],
      startDate: input.startDate ?? todayBangkok(),
      endDate: input.endDate ?? todayBangkok(),
    });
  }
  if (!selectedSource.lastSuccessfulImportRunId) {
    throw new Error("Selected Sales Dashboard source has no successful package-sales import.");
  }

  const allSaleRows = (await db
    .select()
    .from(schema.salesDashboardNormalRows)
    .where(eq(schema.salesDashboardNormalRows.importRunId, selectedSource.lastSuccessfulImportRunId))
    .orderBy(schema.salesDashboardNormalRows.rowNumber))
    .map(toSaleInput);

  const fallbackRange = defaultDateRange(allSaleRows, selectedSource);
  const startDate = input.startDate ?? fallbackRange.startDate;
  const endDate = input.endDate ?? fallbackRange.endDate;
  validateDateRange(startDate, endDate);
  const saleRows = allSaleRows.filter((row) => row.paymentDate >= startDate && row.paymentDate <= endDate);

  const start = bangkokDateStartUtc(startDate);
  const end = new Date(bangkokDateStartUtc(addBangkokDays(endDate, 1)).getTime() - 1);

  const [eventRows, snapshotRows] = await Promise.all([
    db
      .select()
      .from(schema.wiseActivityEvents)
      .where(and(
        gte(schema.wiseActivityEvents.eventTimestamp, start),
        lte(schema.wiseActivityEvents.eventTimestamp, end),
        sql`(
          ${schema.wiseActivityEvents.eventType} = 'BILLING'
          OR ${schema.wiseActivityEvents.transactionId} IS NOT NULL
          OR ${schema.wiseActivityEvents.eventName} ILIKE '%invoice%'
          OR ${schema.wiseActivityEvents.eventName} ILIKE '%payment%'
          OR ${schema.wiseActivityEvents.eventName} ILIKE '%transaction%'
        )`,
        sql`${schema.wiseActivityEvents.eventName} NOT ILIKE '%payout%'`,
      ))
      .orderBy(schema.wiseActivityEvents.eventTimestamp),
    db
      .select({ id: schema.creditControlSnapshots.id })
      .from(schema.creditControlSnapshots)
      .where(eq(schema.creditControlSnapshots.active, true))
      .orderBy(desc(schema.creditControlSnapshots.generatedAt))
      .limit(1),
  ]);
  const [wiseFeesPaidTrends, wiseReceipts] = await Promise.all([
    loadWiseFeesPaidTrends(),
    loadWiseReceipts(startDate, endDate),
  ]);

  const activeSnapshotId = snapshotRows[0]?.id;
  const creditPackages = activeSnapshotId
    ? await db
      .select({
        wiseStudentId: schema.creditControlPackages.wiseStudentId,
        wiseClassId: schema.creditControlPackages.wiseClassId,
        studentKey: schema.creditControlPackages.studentKey,
        studentName: schema.creditControlPackages.studentName,
        parentName: schema.creditControlPackages.parentName,
        packageName: schema.creditControlPackages.packageName,
        subject: schema.creditControlPackages.subject,
      })
      .from(schema.creditControlPackages)
      .where(eq(schema.creditControlPackages.snapshotId, activeSnapshotId))
    : [];

  return buildPackageSalesReconciliation({
    sources: sources.map(sourceSummary),
    selectedSource: sourceSummary(selectedSource),
    saleRows,
    wiseEvents: eventRows.map(toWiseInvoiceInput),
    wiseReceipts: wiseReceipts.receipts,
    wiseReceiptsError: wiseReceipts.error,
    creditPackages,
    startDate,
    endDate,
    wiseFeesPaidTrends: wiseFeesPaidTrends.trends,
    wiseFeesPaidTrendsError: wiseFeesPaidTrends.error,
  });
}

export async function getWiseReconciliationActionSummary(
  db: Database = getDb(),
): Promise<WiseReconciliationActionSummary> {
  const sources = await listReconciliationSources(db);
  const selectedSource = selectSource(sources, {});
  if (!selectedSource || !selectedSource.lastSuccessfulImportRunId) {
    return {
      selectedSourceLabel: selectedSource?.label ?? null,
      selectedSourceMonth: selectedSource?.sourceMonth ?? null,
      saleRows: 0,
      rowsWithPersistedCandidates: 0,
      rowsNeedingReview: 0,
      coverageStatus: "empty",
    };
  }

  const allSaleRows = (await db
    .select()
    .from(schema.salesDashboardNormalRows)
    .where(eq(schema.salesDashboardNormalRows.importRunId, selectedSource.lastSuccessfulImportRunId))
    .orderBy(schema.salesDashboardNormalRows.rowNumber))
    .map(toSaleInput);

  const fallbackRange = defaultDateRange(allSaleRows, selectedSource);
  const start = bangkokDateStartUtc(fallbackRange.startDate);
  const end = new Date(bangkokDateStartUtc(addBangkokDays(fallbackRange.endDate, 1)).getTime() - 1);

  const [eventRows, snapshotRows] = await Promise.all([
    db
      .select()
      .from(schema.wiseActivityEvents)
      .where(and(
        gte(schema.wiseActivityEvents.eventTimestamp, start),
        lte(schema.wiseActivityEvents.eventTimestamp, end),
        sql`(
          ${schema.wiseActivityEvents.eventType} = 'BILLING'
          OR ${schema.wiseActivityEvents.transactionId} IS NOT NULL
          OR ${schema.wiseActivityEvents.eventName} ILIKE '%invoice%'
          OR ${schema.wiseActivityEvents.eventName} ILIKE '%payment%'
          OR ${schema.wiseActivityEvents.eventName} ILIKE '%transaction%'
        )`,
        sql`${schema.wiseActivityEvents.eventName} NOT ILIKE '%payout%'`,
      ))
      .orderBy(schema.wiseActivityEvents.eventTimestamp),
    db
      .select({ id: schema.creditControlSnapshots.id })
      .from(schema.creditControlSnapshots)
      .where(eq(schema.creditControlSnapshots.active, true))
      .orderBy(desc(schema.creditControlSnapshots.generatedAt))
      .limit(1),
  ]);

  const activeSnapshotId = snapshotRows[0]?.id;
  const creditPackages = activeSnapshotId
    ? await db
      .select({
        wiseStudentId: schema.creditControlPackages.wiseStudentId,
        wiseClassId: schema.creditControlPackages.wiseClassId,
        studentKey: schema.creditControlPackages.studentKey,
        studentName: schema.creditControlPackages.studentName,
        parentName: schema.creditControlPackages.parentName,
        packageName: schema.creditControlPackages.packageName,
        subject: schema.creditControlPackages.subject,
      })
      .from(schema.creditControlPackages)
      .where(eq(schema.creditControlPackages.snapshotId, activeSnapshotId))
    : [];

  const wiseEvents = eventRows.map(toWiseInvoiceInput);
  let rowsWithPersistedCandidates = 0;
  let rowsNeedingReview = 0;

  for (const row of allSaleRows) {
    const evidence = buildSaleEvidence(row, creditPackages);
    const hasPersistedCandidate = wiseEvents.some((event) => persistedEventMatchesSale(row, evidence, event));
    if (hasPersistedCandidate) rowsWithPersistedCandidates += 1;
    const recordedOutsideWise = evidence.recordedInWise && !/yes|y|true|recorded/i.test(evidence.recordedInWise);
    if (!hasPersistedCandidate || !evidence.transactionNo || recordedOutsideWise) rowsNeedingReview += 1;
  }

  return {
    selectedSourceLabel: selectedSource.label,
    selectedSourceMonth: selectedSource.sourceMonth,
    saleRows: allSaleRows.length,
    rowsWithPersistedCandidates,
    rowsNeedingReview,
    coverageStatus: buildCoverage(wiseEvents, fallbackRange.startDate, fallbackRange.endDate).status,
  };
}

export function wiseReconciliationBackfillLookbackDays(startDate: string, now = new Date()): number {
  if (!DATE_RE.test(startDate)) throw new Error("Invalid date range");
  const todayStart = bangkokDateStartUtc(todayBangkok(now));
  const start = bangkokDateStartUtc(startDate);
  const days = Math.ceil((todayStart.getTime() - start.getTime()) / DAY_MS) + 1;
  return Math.max(1, Math.min(365, days));
}
