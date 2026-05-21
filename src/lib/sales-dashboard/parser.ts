import { PROGRAM_MAP } from "./program-map";
import { addDaysIso, dateComparisonValue, parseSalesDate } from "./dates";
import type { ParsedAdditionalSaleRow, ParsedNormalSaleRow } from "./types";
import { bangkokDateKey } from "@/lib/room-capacity/dates";

export const HEADER_ROW = 3;
export const DEFAULT_NORMAL_SHEET = "(1)PackageSales";
export const LEGACY_NORMAL_SHEET = "SalesRecord";
export const DEFAULT_ADDITIONAL_SHEET = "(2)AdditionalSales";

interface ParseContext {
  sourceMonth: string;
  sourceLabel: string;
  today?: Date;
}

function compact(value: unknown): string {
  return String(value ?? "").trim();
}

function lower(value: unknown): string {
  return compact(value).toLowerCase();
}

function numberValue(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const cleaned = String(value ?? "")
    .replace(/[฿,\s]/g, "")
    .replace(/[()]/g, "")
    .trim();
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function paidValue(value: unknown): boolean {
  if (value === true || value === 1) return true;
  const normalized = lower(value);
  return normalized === "true" || normalized === "yes" || normalized === "paid" || normalized.includes("ชำระ");
}

function colMap(headers: unknown[]): Record<string, number> {
  const map: Record<string, number> = {};
  headers.forEach((header, index) => {
    map[compact(header)] = index;
  });
  return map;
}

function cell(row: unknown[], cols: Record<string, number>, name: string): unknown {
  const index = cols[name];
  return index === undefined || index < 0 ? null : row[index];
}

function rawObject(headers: unknown[], row: unknown[]): Record<string, unknown> {
  return Object.fromEntries(headers.map((header, index) => [compact(header) || `col_${index + 1}`, row[index] ?? null]));
}

function normalizedEnrollment(value: unknown): string {
  const raw = lower(value);
  if (raw === "trial") return "Trial";
  if (raw === "new") return "New Student";
  if (raw === "renew" || raw === "renewal") return "Renewal";
  if (raw === "new student") return "New Student";
  return "";
}

function cleanPackageHours(value: string): string {
  return value.trim().replace(/\s*\(.*?\)/g, "").trim();
}

export function extractSpreadsheetId(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (match) return match[1];
  if (/^[a-zA-Z0-9-_]{20,}$/.test(trimmed)) return trimmed;
  throw new Error("Invalid Google Sheet URL or spreadsheet ID");
}

export function parseNormalSalesRows(rows: unknown[][], context: ParseContext): ParsedNormalSaleRow[] {
  const header = rows[HEADER_ROW - 1]?.map(compact) ?? [];
  if (header.length === 0) return [];
  const cols = colMap(header);
  const isNewFormat = cols["Payment Date"] !== undefined;
  const hasEnrollmentType = cols["Enrollment Type"] !== undefined;

  const parsed: ParsedNormalSaleRow[] = [];
  rows.slice(HEADER_ROW).forEach((row, rowIndex) => {
    const studentNickname = compact(cell(row, cols, "Student's Nickname"));
    if (!studentNickname) return;

    let paymentDate: string | null;
    let salesRepresentative = "";
    let paymentAmount = 0;
    let validUntil: string | null = null;
    let enrollmentType = "";

    if (isNewFormat) {
      if (!paidValue(cell(row, cols, "Already Paid?"))) return;
      paymentDate = parseSalesDate(cell(row, cols, "Payment Date"));
      salesRepresentative = compact(cell(row, cols, "Sales Person"));
      paymentAmount = numberValue(cell(row, cols, "Total Price"));
      validUntil = parseSalesDate(cell(row, cols, "Valid Until"));
    } else {
      paymentDate = parseSalesDate(cell(row, cols, "วันที่ชำระเงิน"));
      salesRepresentative = compact(cell(row, cols, "ผู้ขาย"));
      paymentAmount = numberValue(cell(row, cols, "ยอดชำระสุทธิ"));
      validUntil = parseSalesDate(cell(row, cols, "Valid Until"));
    }

    if (!paymentDate) return;
    if (hasEnrollmentType) enrollmentType = normalizedEnrollment(cell(row, cols, "Enrollment Type"));

    const program = compact(cell(row, cols, "Program"));
    const packageHours = compact(cell(row, cols, "Package"));

    parsed.push({
      sourceMonth: context.sourceMonth,
      sourceLabel: context.sourceLabel,
      rowNumber: HEADER_ROW + rowIndex + 1,
      studentNickname,
      program,
      packageHours,
      numberOfStudents: numberValue(cell(row, cols, "No. of Student")),
      paymentAmount,
      salesRepresentative,
      paymentDate,
      enrollmentType,
      programWiseName: "",
      packageHoursClean: "",
      validUntil,
      churnStatus: "",
      raw: rawObject(header, row),
    });
  });

  return analyzeNormalSalesRows(parsed, context.today);
}

export function parseAdditionalSalesRows(rows: unknown[][], context: ParseContext): ParsedAdditionalSaleRow[] {
  const header = rows[HEADER_ROW - 1]?.map(compact) ?? [];
  if (header.length === 0) return [];
  const cols = colMap(header);

  const parsed: ParsedAdditionalSaleRow[] = [];
  rows.slice(HEADER_ROW).forEach((row, rowIndex) => {
    const studentNickname = compact(cell(row, cols, "Student's Nickname"));
    if (!studentNickname) return;
    const paymentDate = parseSalesDate(cell(row, cols, "วันที่ชำระเงิน"));
    if (!paymentDate) return;
    parsed.push({
      sourceMonth: context.sourceMonth,
      sourceLabel: context.sourceLabel,
      rowNumber: HEADER_ROW + rowIndex + 1,
      studentNickname,
      salesType: compact(cell(row, cols, "Sales Type")),
      packageName: compact(cell(row, cols, "Package")),
      paymentAmount: numberValue(cell(row, cols, "ยอดชำระสุทธิ")),
      paymentDate,
      raw: rawObject(header, row),
    });
  });
  return parsed;
}

export function analyzeNormalSalesRows(rows: ParsedNormalSaleRow[], today = new Date()): ParsedNormalSaleRow[] {
  const sorted = [...rows].sort((left, right) => {
    const dateDelta = dateComparisonValue(left.paymentDate) - dateComparisonValue(right.paymentDate);
    return dateDelta || left.rowNumber - right.rowNumber;
  });

  const groups = new Map<string, ParsedNormalSaleRow[]>();
  for (const row of sorted) {
    const key = row.studentNickname.toLowerCase().trim();
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  for (const items of groups.values()) {
    const trialIndices: number[] = [];
    const paidIndices: number[] = [];
    items.forEach((item, index) => {
      if (["Trial", "New Student", "Renewal"].includes(item.enrollmentType)) return;
      if (item.packageHours.trim().toLowerCase() === "trial") trialIndices.push(index);
      else paidIndices.push(index);
    });

    for (const index of trialIndices) items[index].enrollmentType = "Trial";
    paidIndices.forEach((itemIndex, paidIndex) => {
      const previousIsTrial = itemIndex > 0 && items[itemIndex - 1].packageHours.trim().toLowerCase() === "trial";
      items[itemIndex].enrollmentType = paidIndex === 0 && previousIsTrial ? "New Student" : "Renewal";
    });
  }

  for (const row of sorted) {
    row.programWiseName = PROGRAM_MAP[row.program] ?? row.program;
    row.packageHoursClean = cleanPackageHours(row.packageHours);
    row.churnStatus = "—";
  }

  const todayIso = bangkokDateKey(today);
  for (const items of groups.values()) {
    const latest = items.at(-1);
    if (!latest) continue;
    const allTrial = items.every((item) => item.packageHours.trim().toLowerCase() === "trial");
    if (allTrial) {
      latest.churnStatus = "N/A";
      continue;
    }

    const latestPaid = [...items].reverse().find((item) => item.packageHours.trim().toLowerCase() !== "trial");
    if (!latestPaid?.validUntil) {
      latest.churnStatus = "N/A";
      continue;
    }

    const graceDeadline = addDaysIso(latestPaid.validUntil, 14);
    if (dateComparisonValue(graceDeadline) >= dateComparisonValue(todayIso)) {
      latest.churnStatus = "Active";
      continue;
    }

    const renewed = items.some((item) => dateComparisonValue(item.paymentDate) > dateComparisonValue(graceDeadline));
    latest.churnStatus = renewed ? "Retained" : "Churned";
  }

  return sorted;
}
