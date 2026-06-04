import crypto from "node:crypto";
import { addBangkokDays } from "@/lib/room-capacity/dates";

const DAY_MS = 24 * 60 * 60 * 1000;
const EXCEL_UNIX_EPOCH_SERIAL = 25569;

export type LeaveNormalizationStatus = "ok" | "needs_review";

export interface ParsedLeaveRequestRow {
  sourceRowNumber: number;
  sourceFingerprint: string;
  sourceSubmittedAt: Date | null;
  tutorName: string;
  tutorEmail: string | null;
  startDate: string | null;
  endDate: string | null;
  timePeriod: string | null;
  specificTimeText: string | null;
  leaveStartTime: Date | null;
  leaveEndTime: Date | null;
  startMinute: number | null;
  endMinute: number | null;
  normalizationStatus: LeaveNormalizationStatus;
  normalizationError: string | null;
  reportedHasClasses: string | null;
  reportedAffectedClasses: string | null;
  makeupOptions: string | null;
  reason: string | null;
  certificateUrl: string | null;
  situationText: string | null;
  policyAgreement: string | null;
  daysNotice: number | null;
  lateNotice: string | null;
  adminFee: number | null;
  emergencyUsed: number | null;
  sourceSheetStatus: string | null;
  rawValues: Record<string, unknown>;
}

const FALLBACK_HEADERS = [
  "Timestamp",
  "Tutor Name",
  "Email Address",
  "Start Leave Date",
  "End Leave Date",
  "Time Period of Leave",
  "Specific Time",
  "Scheduled Classes",
  "Affected Classes",
  "Make-up Options",
  "Reason",
  "Medical Certificate",
  "Situation",
  "Agreement",
  "Days Notice",
  "Late Notice",
  "Admin Fee",
  "Emergency Used",
  "Status",
];

function compact(value: unknown): string {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function nullableString(value: unknown): string | null {
  const text = compact(value);
  return text ? text : null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = compact(value).replace(/,/g, "");
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function toIntOrNull(value: unknown): number | null {
  const parsed = numberOrNull(value);
  return parsed === null ? null : Math.round(parsed);
}

function isoDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function serialParts(value: number): { date: string; minute: number } | null {
  if (!Number.isFinite(value) || value < 1) return null;
  const utc = new Date(Math.round((value - EXCEL_UNIX_EPOCH_SERIAL) * DAY_MS));
  const date = isoDate(utc.getUTCFullYear(), utc.getUTCMonth() + 1, utc.getUTCDate());
  const minute = utc.getUTCHours() * 60 + utc.getUTCMinutes();
  return { date, minute };
}

function bangkokDateTimeUtc(date: string, minute: number): Date {
  const targetDate = minute >= 1440 ? addBangkokDays(date, 1) : date;
  const boundedMinute = minute >= 1440 ? minute - 1440 : minute;
  const hours = Math.floor(boundedMinute / 60);
  const minutes = boundedMinute % 60;
  return new Date(`${targetDate}T${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00+07:00`);
}

export function parseSheetDate(value: unknown): string | null {
  if (typeof value === "number") return serialParts(value)?.date ?? null;
  const text = compact(value);
  if (!text) return null;
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const slash = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (slash) {
    const year = Number(slash[3].length === 2 ? `20${slash[3]}` : slash[3]);
    return isoDate(year, Number(slash[2]), Number(slash[1]));
  }
  return null;
}

export function parseSheetTimestamp(value: unknown): Date | null {
  if (typeof value === "number") {
    const parts = serialParts(value);
    return parts ? bangkokDateTimeUtc(parts.date, parts.minute) : null;
  }
  const text = compact(value);
  if (!text) return null;
  const match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) return null;
  const year = Number(match[3].length === 2 ? `20${match[3]}` : match[3]);
  const date = isoDate(year, Number(match[2]), Number(match[1]));
  const hours = Number(match[4] ?? 0);
  const minutes = Number(match[5] ?? 0);
  return bangkokDateTimeUtc(date, hours * 60 + minutes);
}

function parseClock(raw: string, fallbackSuffix?: "am" | "pm"): number | null {
  const text = raw.trim().toLowerCase();
  const match = text.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const suffix = (match[3] as "am" | "pm" | undefined) ?? fallbackSuffix;
  if (hour > 24 || minute > 59) return null;
  if (suffix === "pm" && hour < 12) hour += 12;
  if (suffix === "am" && hour === 12) hour = 0;
  if (hour === 24 && minute === 0) return 1440;
  if (hour >= 24) return null;
  return hour * 60 + minute;
}

export function parseSpecificTimeWindow(value: string | null | undefined): {
  startMinute: number | null;
  endMinute: number | null;
  error: string | null;
} {
  const source = compact(value);
  if (!source) return { startMinute: null, endMinute: null, error: "Specific time is missing." };
  const normalized = source
    .toLowerCase()
    .replace(/[–—]/g, "-")
    .replace(/\./g, ":")
    .replace(/\s+/g, " ");
  const timeToken = "(\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?)";

  const before = normalized.match(new RegExp(`\\b(?:before|until|till)\\s+${timeToken}`));
  if (before) {
    const end = parseClock(before[1]);
    return end && end > 0 ? { startMinute: 0, endMinute: end, error: null } : ambiguousSpecificTime(source);
  }

  const after = normalized.match(new RegExp(`\\b(?:after|from)\\s+${timeToken}\\s*(?:onwards|onward|and after)?`));
  if (after && !normalized.includes(" to ") && !normalized.includes("-")) {
    const start = parseClock(after[1]);
    return start !== null && start < 1440 ? { startMinute: start, endMinute: 1440, error: null } : ambiguousSpecificTime(source);
  }

  const onwards = normalized.match(new RegExp(`^${timeToken}\\s*(?:onwards|onward|and after)$`));
  if (onwards) {
    const start = parseClock(onwards[1]);
    return start !== null && start < 1440 ? { startMinute: start, endMinute: 1440, error: null } : ambiguousSpecificTime(source);
  }

  const range = normalized.match(new RegExp(`${timeToken}\\s*(?:-|to|until|till)\\s*${timeToken}`));
  if (range) {
    const endSuffix = range[2].match(/(am|pm)$/)?.[1] as "am" | "pm" | undefined;
    const startSuffix = range[1].match(/(am|pm)$/)?.[1];
    const plainStart = parseClock(range[1]);
    const suffixStart = parseClock(range[1], endSuffix);
    const end = parseClock(range[2]);
    let start = plainStart;
    if (!startSuffix && endSuffix === "pm" && plainStart !== null && suffixStart !== null && end !== null) {
      start = end - plainStart > 8 * 60 && suffixStart < end ? suffixStart : plainStart;
    }
    if (start !== null && end !== null && end > start) {
      return { startMinute: start, endMinute: end, error: null };
    }
  }

  return ambiguousSpecificTime(source);
}

function ambiguousSpecificTime(source: string) {
  return {
    startMinute: null,
    endMinute: null,
    error: `Could not parse specific time "${source}".`,
  };
}

export function normalizeLeaveWindow(input: {
  startDate: string | null;
  endDate: string | null;
  timePeriod: string | null;
  specificTimeText: string | null;
}): {
  leaveStartTime: Date | null;
  leaveEndTime: Date | null;
  startMinute: number | null;
  endMinute: number | null;
  normalizationStatus: LeaveNormalizationStatus;
  normalizationError: string | null;
} {
  if (!input.startDate || !input.endDate) {
    return {
      leaveStartTime: null,
      leaveEndTime: null,
      startMinute: null,
      endMinute: null,
      normalizationStatus: "needs_review",
      normalizationError: "Start or end leave date is missing.",
    };
  }
  if (input.endDate < input.startDate) {
    return {
      leaveStartTime: bangkokDateTimeUtc(input.startDate, 0),
      leaveEndTime: bangkokDateTimeUtc(input.endDate, 1440),
      startMinute: 0,
      endMinute: 1440,
      normalizationStatus: "needs_review",
      normalizationError: "End leave date is before start leave date.",
    };
  }

  const period = compact(input.timePeriod).toLowerCase();
  let startMinute = 0;
  let endMinute = 1440;
  let error: string | null = null;

  if (period.includes("morning")) {
    endMinute = 12 * 60;
  } else if (period.includes("afternoon")) {
    startMinute = 12 * 60;
    endMinute = 17 * 60;
  } else if (period.includes("evening")) {
    startMinute = 17 * 60;
  } else if (period.includes("specific") || input.specificTimeText) {
    const parsed = parseSpecificTimeWindow(input.specificTimeText);
    if (parsed.startMinute === null || parsed.endMinute === null) {
      error = parsed.error;
      startMinute = 0;
      endMinute = 1440;
    } else {
      startMinute = parsed.startMinute;
      endMinute = parsed.endMinute;
    }
  }

  return {
    leaveStartTime: bangkokDateTimeUtc(input.startDate, startMinute),
    leaveEndTime: bangkokDateTimeUtc(input.endDate, endMinute),
    startMinute,
    endMinute,
    normalizationStatus: error ? "needs_review" : "ok",
    normalizationError: error,
  };
}

function headerIndex(headers: string[], fallbackIndex: number, candidates: string[]): number {
  const normalized = headers.map((header) => compact(header).toLowerCase());
  for (const candidate of candidates.map((item) => item.toLowerCase())) {
    const exact = normalized.indexOf(candidate);
    if (exact >= 0) return exact;
    const contains = normalized.findIndex((header) => header.includes(candidate));
    if (contains >= 0) return contains;
  }
  return fallbackIndex;
}

function rowValue(row: unknown[], index: number): unknown {
  return index >= 0 ? row[index] : undefined;
}

function rawValues(headers: string[], row: unknown[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const labels = headers.length ? headers : FALLBACK_HEADERS;
  for (let index = 0; index < Math.max(labels.length, row.length); index += 1) {
    result[labels[index] || `Column ${index + 1}`] = row[index] ?? "";
  }
  return result;
}

function rowFingerprint(row: unknown[]): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(row.map((value) => value ?? "")))
    .digest("hex");
}

export function parseLeaveRequestSheetRows(rows: unknown[][]): ParsedLeaveRequestRow[] {
  const [headerRow = [], ...bodyRows] = rows;
  const headers = headerRow.map((value) => compact(value));
  const idx = {
    timestamp: headerIndex(headers, 0, ["timestamp"]),
    tutorName: headerIndex(headers, 1, ["tutor name"]),
    tutorEmail: headerIndex(headers, 2, ["email address", "email"]),
    startDate: headerIndex(headers, 3, ["start leave date", "start date"]),
    endDate: headerIndex(headers, 4, ["end leave date", "end date"]),
    timePeriod: headerIndex(headers, 5, ["time period"]),
    specificTime: headerIndex(headers, 6, ["specific time"]),
    hasClasses: headerIndex(headers, 7, ["scheduled classes", "classes affected"]),
    affectedCount: headerIndex(headers, 8, ["how many", "affected class"]),
    makeup: headerIndex(headers, 9, ["make-up", "makeup"]),
    reason: headerIndex(headers, 10, ["reason"]),
    certificate: headerIndex(headers, 11, ["medical", "certificate"]),
    situation: headerIndex(headers, 12, ["situation"]),
    agreement: headerIndex(headers, 13, ["agreement"]),
    daysNotice: headerIndex(headers, 14, ["days notice"]),
    lateNotice: headerIndex(headers, 15, ["late notice"]),
    adminFee: headerIndex(headers, 16, ["admin fee"]),
    emergencyUsed: headerIndex(headers, 17, ["emergency used"]),
    status: headerIndex(headers, 18, ["status"]),
  };

  return bodyRows.flatMap((row, offset) => {
    const tutorName = nullableString(rowValue(row, idx.tutorName)) ?? "";
    const startDate = parseSheetDate(rowValue(row, idx.startDate));
    const submittedAt = parseSheetTimestamp(rowValue(row, idx.timestamp));
    if (!tutorName && !startDate && !submittedAt) return [];

    const endDate = parseSheetDate(rowValue(row, idx.endDate)) ?? startDate;
    const timePeriod = nullableString(rowValue(row, idx.timePeriod));
    const specificTimeText = nullableString(rowValue(row, idx.specificTime));
    const window = normalizeLeaveWindow({ startDate, endDate, timePeriod, specificTimeText });

    return [{
      sourceRowNumber: offset + 2,
      sourceFingerprint: rowFingerprint(row),
      sourceSubmittedAt: submittedAt,
      tutorName,
      tutorEmail: nullableString(rowValue(row, idx.tutorEmail))?.toLowerCase() ?? null,
      startDate,
      endDate,
      timePeriod,
      specificTimeText,
      ...window,
      reportedHasClasses: nullableString(rowValue(row, idx.hasClasses)),
      reportedAffectedClasses: nullableString(rowValue(row, idx.affectedCount)),
      makeupOptions: nullableString(rowValue(row, idx.makeup)),
      reason: nullableString(rowValue(row, idx.reason)),
      certificateUrl: nullableString(rowValue(row, idx.certificate)),
      situationText: nullableString(rowValue(row, idx.situation)),
      policyAgreement: nullableString(rowValue(row, idx.agreement)),
      daysNotice: toIntOrNull(rowValue(row, idx.daysNotice)),
      lateNotice: nullableString(rowValue(row, idx.lateNotice)),
      adminFee: toIntOrNull(rowValue(row, idx.adminFee)),
      emergencyUsed: toIntOrNull(rowValue(row, idx.emergencyUsed)),
      sourceSheetStatus: nullableString(rowValue(row, idx.status)),
      rawValues: rawValues(headers, row),
    }];
  });
}
