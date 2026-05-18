import { DAY_MS, STATUS_ORDER } from "@/lib/credit-control/config";

export function parseNumber(value: unknown, fallback = 0): number {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizeText(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

export function normalizeIdentityPart(value: unknown, fallback: string): string {
  const normalized = normalizeText(value).replace(/\s+/g, " ");
  return normalized || fallback;
}

export function buildDashboardStudentKey(studentName: string, parentName: string): string {
  return [
    normalizeIdentityPart(studentName, "unknown-student"),
    normalizeIdentityPart(parentName, "missing-parent"),
  ].join("::");
}

export function readTrimmedCell(row: unknown[], cols: Record<string, number>, columnName: string): string {
  return String(row[cols[columnName]] ?? "").trim();
}

export function readUpperCell(row: unknown[], cols: Record<string, number>, columnName: string): string {
  return readTrimmedCell(row, cols, columnName).toUpperCase();
}

export function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

export function roundToHundredth(value: number): number {
  return Math.round(value * 100) / 100;
}

export function parseDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }

  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
}

export function getTodayDate(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

export function formatDate(date: Date | null): string | null {
  if (!date) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatDateTime(date: Date | null): string {
  if (!date) return "";
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+07:00`;
}

export function formatShortTimestamp(isoValue: string | null): string {
  if (!isoValue) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(isoValue));
}

export function compareIsoDateValues(valueA: string | null, valueB: string | null): number {
  const normalizedA = valueA ? parseDate(valueA)?.getTime() ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY;
  const normalizedB = valueB ? parseDate(valueB)?.getTime() ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY;
  return normalizedA - normalizedB;
}

export function buildStudentPackageKey(studentName: string, packageName: string): string {
  return `${String(studentName).trim()}|||${String(packageName).trim()}`;
}

export function getStatusSortValue(status: string): number {
  return status in STATUS_ORDER ? STATUS_ORDER[status as keyof typeof STATUS_ORDER] : 9;
}

export function isStatusWorse(currentStatus: string, previousStatus: string): boolean {
  return getStatusSortValue(currentStatus) < getStatusSortValue(previousStatus);
}

export function getStatusChangeLabel(previousStatus: string | null, currentStatus: string) {
  if (!previousStatus) return "new" as const;
  if (isStatusWorse(currentStatus, previousStatus)) return "worsened" as const;
  if (isStatusWorse(previousStatus, currentStatus)) return "improved" as const;
  return "stable" as const;
}

export function sortByEarliestDate(values: (string | null)[]): string[] {
  return values.filter((value): value is string => !!value).sort(compareIsoDateValues);
}

export function daysBetween(date: Date, today: Date): number {
  return Math.round((date.getTime() - today.getTime()) / DAY_MS);
}
