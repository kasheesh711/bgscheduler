import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { addBangkokDays, bangkokDateKey, bangkokDateStartUtc, endOfBangkokMonth, todayBangkok } from "@/lib/room-capacity/dates";
import type { SalesDashboardSourceRecord, SalesSourceStatus } from "@/lib/sales-dashboard/types";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const MAX_CANDIDATES_PER_ROW = 5;

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
  id: string;
  eventId: string;
  eventName: string;
  eventTimestamp: string;
  eventDate: string;
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
  wiseRevenueTotal: number;
  difference: number;
  differencePct: number | null;
  currency: "THB";
  wiseRevenueTransactionCount: number;
  wiseRevenueEventCount: number;
  skippedEventCount: number;
  skippedEventBreakdown: {
    payoutOrRefund: number;
    failedStatus: number;
    nonPositiveAmount: number;
    unsupportedCurrency: number;
    duplicate: number;
  };
  source: "persisted_wise_activity_events";
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
  };
  revenueVariance: ReconciliationRevenueVariance;
  students: ReconciliationStudentGroup[];
}

export interface ReconciliationBuildInput {
  sources: ReconciliationSourceSummary[];
  selectedSource: ReconciliationSourceSummary | null;
  saleRows: PackageSaleInput[];
  wiseEvents: WiseInvoiceEventInput[];
  creditPackages: CreditPackageInput[];
  startDate: string;
  endDate: string;
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

function nestedRecord(value: unknown, key: string): Record<string, unknown> {
  const candidate = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : null;
  return candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : {};
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

function eventIdentifiers(event: WiseInvoiceEventInput): Set<string> {
  const payload = event.payload;
  const metadata = nestedRecord(nestedRecord(payload, "transaction"), "metadata");
  const values = [
    event.transactionId,
    nestedString(payload, ["transaction", "id"]),
    metadata.invoiceNumber,
    metadata.transactionId,
    metadata.paymentOptionId,
  ];
  return new Set(values.map(compactKey).filter(Boolean));
}

function firstString(values: unknown[]): string {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function eventClassIds(event: WiseInvoiceEventInput): Set<string> {
  return new Set([
    event.classroomId,
    nestedString(event.payload, ["transaction", "metadata", "classId"]),
    nestedString(event.payload, ["class", "id"]),
    nestedString(event.raw, ["classroom", "_id"]),
  ].map((value) => String(value ?? "").trim()).filter(Boolean));
}

function eventStudentIds(event: WiseInvoiceEventInput): Set<string> {
  return new Set([
    nestedString(event.payload, ["transaction", "senderId"]),
    nestedString(event.payload, ["transaction", "receiverId"]),
    nestedString(event.payload, ["transaction", "metadata", "senderId"]),
    nestedString(event.payload, ["transaction", "metadata", "receiverId"]),
    nestedString(event.payload, ["user", "id"]),
    nestedString(event.raw, ["participant", "_id"]),
  ].map((value) => String(value ?? "").trim()).filter(Boolean));
}

function eventSearchText(event: WiseInvoiceEventInput): string {
  return normalizeText([
    event.actorName,
    event.classroomName,
    event.classroomSubject,
    event.transactionId,
    ...allNestedStrings(event.payload),
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

function scoreCandidate(row: PackageSaleInput, evidence: SaleEvidence, event: WiseInvoiceEventInput): ReconciliationCandidate | null {
  const reasons: string[] = [];
  let score = 0;
  const transactionAmount = eventTransactionAmount(event);

  const normalizedTransactionNo = compactKey(evidence.transactionNo);
  if (normalizedTransactionNo && eventIdentifiers(event).has(normalizedTransactionNo)) {
    score += 100;
    reasons.push("Sheet transaction number appears on the Wise event.");
  }

  const classIds = eventClassIds(event);
  if ([...classIds].some((id) => evidence.mappedClassIds.has(id))) {
    score += 50;
    reasons.push("Wise class ID matches the student's active Credit Control package.");
  }

  const studentIds = eventStudentIds(event);
  if ([...studentIds].some((id) => evidence.mappedStudentIds.has(id))) {
    score += 50;
    reasons.push("Wise student ID matches the student's active Credit Control package.");
  }

  if (moneyEqual(row.paymentAmount, transactionAmount)) {
    score += 30;
    reasons.push("Payment amount matches the package-sale row.");
  }

  const eventDate = bangkokDateKey(event.eventTimestamp);
  const distance = dayDistance(row.paymentDate, eventDate);
  if (distance === 0) {
    score += 20;
    reasons.push("Wise event date matches the sheet payment date.");
  } else if (distance <= 3) {
    score += 10;
    reasons.push(`Wise event date is within ${distance} day${distance === 1 ? "" : "s"} of the sheet payment date.`);
  }

  const searchText = eventSearchText(event);
  const packageTextHit = evidence.packageHints.some((hint) => hint.length >= 3 && searchText.includes(hint));
  if (packageTextHit) {
    score += 15;
    reasons.push("Wise event text overlaps with the sheet student, parent, program, or package text.");
  }

  if (score < 20) return null;

  return {
    id: event.id,
    eventId: event.eventId,
    eventName: event.eventName,
    eventTimestamp: event.eventTimestamp.toISOString(),
    eventDate,
    actorName: event.actorName,
    classroomId: event.classroomId,
    classroomName: event.classroomName,
    classroomSubject: event.classroomSubject,
    transactionId: event.transactionId,
    transactionStatus: event.transactionStatus,
    transactionAmount,
    transactionCurrency: event.transactionCurrency,
    score,
    confidence: score >= 80 ? "high" : score >= 45 ? "medium" : "low",
    reasons,
    payload: event.payload,
    raw: event.raw,
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

function isRefundOrPayoutEvent(event: WiseInvoiceEventInput): boolean {
  const transactionType = nestedString(event.payload, ["transaction", "type"]);
  const text = `${event.eventName} ${event.transactionStatus ?? ""} ${transactionType}`;
  return /payout|refund|reversal|chargeback/i.test(text);
}

function isFailedRevenueStatus(status: string | null): boolean {
  return Boolean(status && /fail|cancel|void|declin|refund|revers|chargeback|delete/i.test(status));
}

function isDeletedRevenueEvent(event: WiseInvoiceEventInput): boolean {
  return /delete|void/i.test(`${event.eventName} ${event.transactionStatus ?? ""}`);
}

function normalizeWiseAmountValue(value: number | null, currency: string): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return currency === "THB" ? value / 100 : value;
}

function eventTransactionAmount(event: WiseInvoiceEventInput): number | null {
  const currency = revenueCurrency(event);
  if (typeof event.transactionAmount === "number" && Number.isFinite(event.transactionAmount)) {
    return normalizeWiseAmountValue(event.transactionAmount, currency);
  }
  const nestedAmount = nestedString(event.payload, ["transaction", "amount", "value"]);
  if (!nestedAmount) return null;
  const parsed = Number(nestedAmount.replace(/,/g, ""));
  return normalizeWiseAmountValue(Number.isFinite(parsed) ? parsed : null, currency);
}

function revenueAmount(event: WiseInvoiceEventInput): number | null {
  return eventTransactionAmount(event);
}

function revenueCurrency(event: WiseInvoiceEventInput): string {
  return firstString([
    event.transactionCurrency,
    nestedString(event.payload, ["transaction", "amount", "currency"]),
  ]).toUpperCase();
}

function revenueTransactionKey(event: WiseInvoiceEventInput): string {
  const payload = event.payload;
  const metadata = nestedRecord(nestedRecord(payload, "transaction"), "metadata");
  const rawKey = firstString([
    event.transactionId,
    nestedString(payload, ["transaction", "id"]),
    metadata.invoiceNumber,
    metadata.transactionId,
    metadata.paymentOptionId,
    event.eventId,
    event.id,
  ]);
  return compactKey(rawKey) || compactKey(event.id);
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

function buildRevenueVariance(
  rows: ReconciliationSaleRow[],
  events: WiseInvoiceEventInput[],
  startDate: string,
  endDate: string,
): ReconciliationRevenueVariance {
  const sheetPackageSalesTotal = rows.reduce((sum, row) => sum + row.paymentAmount, 0);
  const deletedTransactionKeys = new Set(events
    .filter((event) => isInboundWiseInvoiceEvent(event) && isDeletedRevenueEvent(event))
    .map(revenueTransactionKey));
  const transactions = new Map<string, { amount: number; timestamp: number }>();
  const skippedEventBreakdown = {
    payoutOrRefund: 0,
    failedStatus: 0,
    nonPositiveAmount: 0,
    unsupportedCurrency: 0,
    duplicate: 0,
  };
  let wiseRevenueEventCount = 0;

  for (const event of events) {
    if (isRefundOrPayoutEvent(event)) {
      skippedEventBreakdown.payoutOrRefund += 1;
      continue;
    }
    if (!isInboundWiseInvoiceEvent(event)) continue;
    const key = revenueTransactionKey(event);
    if (deletedTransactionKeys.has(key)) {
      skippedEventBreakdown.failedStatus += 1;
      continue;
    }
    if (isFailedRevenueStatus(event.transactionStatus)) {
      skippedEventBreakdown.failedStatus += 1;
      continue;
    }

    const amount = revenueAmount(event);
    if (typeof amount !== "number" || amount <= 0) {
      skippedEventBreakdown.nonPositiveAmount += 1;
      continue;
    }

    const currency = revenueCurrency(event);
    if (currency && currency !== "THB") {
      skippedEventBreakdown.unsupportedCurrency += 1;
      continue;
    }

    wiseRevenueEventCount += 1;
    const timestamp = event.eventTimestamp.getTime();
    const existing = transactions.get(key);
    if (existing) {
      skippedEventBreakdown.duplicate += 1;
      if (timestamp >= existing.timestamp) {
        transactions.set(key, { amount, timestamp });
      }
      continue;
    }
    transactions.set(key, { amount, timestamp });
  }

  const wiseRevenueTotal = [...transactions.values()].reduce((sum, item) => sum + item.amount, 0);
  const difference = sheetPackageSalesTotal - wiseRevenueTotal;
  const skippedEventCount = Object.values(skippedEventBreakdown).reduce((sum, count) => sum + count, 0);

  return {
    startDate,
    endDate,
    periodLabel: periodLabel(startDate, endDate),
    sheetPackageSalesTotal,
    wiseRevenueTotal,
    difference,
    differencePct: wiseRevenueTotal === 0 ? null : (difference / wiseRevenueTotal) * 100,
    currency: "THB",
    wiseRevenueTransactionCount: transactions.size,
    wiseRevenueEventCount,
    skippedEventCount,
    skippedEventBreakdown,
    source: "persisted_wise_activity_events",
  };
}

function makeSaleRow(row: PackageSaleInput, candidates: ReconciliationCandidate[], evidence: SaleEvidence): ReconciliationSaleRow {
  const reviewFlags: string[] = [];
  if (candidates.length === 0) reviewFlags.push("No Wise invoice/payment candidates found.");
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

export function buildPackageSalesReconciliation(input: ReconciliationBuildInput): WisePackageSalesReconciliation {
  const wiseEvents = input.wiseEvents.filter(isInboundWiseInvoiceEvent);
  const rows = input.saleRows.map((row) => {
    const evidence = buildSaleEvidence(row, input.creditPackages);
    const candidates = wiseEvents
      .map((event) => scoreCandidate(row, evidence, event))
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
    },
    revenueVariance: buildRevenueVariance(rows, input.wiseEvents, input.startDate, input.endDate),
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
    creditPackages,
    startDate,
    endDate,
  });
}

export function wiseReconciliationBackfillLookbackDays(startDate: string, now = new Date()): number {
  if (!DATE_RE.test(startDate)) throw new Error("Invalid date range");
  const todayStart = bangkokDateStartUtc(todayBangkok(now));
  const start = bangkokDateStartUtc(startDate);
  const days = Math.ceil((todayStart.getTime() - start.getTime()) / DAY_MS) + 1;
  return Math.max(1, Math.min(365, days));
}
