import type { WiseActivityEvent, WiseSession, WiseTag } from "@/lib/wise/types";
import {
  getWiseSessionClassId,
  getWiseSessionClassName,
  getWiseSessionClassSubject,
  getWiseSessionClassType,
  getWiseSessionTeacherUserId,
  getWiseTagName,
} from "@/lib/wise/types";
import { bangkokDateKey, bangkokDateStartUtc, endOfBangkokMonth } from "@/lib/room-capacity/dates";
import type { PayrollTier } from "./types";

const PAYROLL_MONTH_RE = /^\d{4}-\d{2}$/;
const TIER_RE = /^Tier\s+/i;

export interface PayrollMonthRange {
  month: string;
  payrollMonth: string;
  startDate: string;
  endDate: string;
  queryStartDate: string;
  queryEndDate: string;
}

export interface NormalizedPayrollPayoutEvent {
  eventId: string;
  transactionId: string;
  eventTimestamp: Date;
  wiseTeacherUserId: string | null;
  actorWiseUserId: string | null;
  wiseClassId: string | null;
  wiseSessionId: string | null;
  sessionStartTime: Date | null;
  sessionCredits: number;
  amountMinor: number | null;
  amount: number;
  currency: string;
  transactionStatus: string | null;
  note: string | null;
  raw: Record<string, unknown>;
}

export interface NormalizedPayrollSession {
  wiseSessionId: string;
  wiseTeacherUserId: string | null;
  wiseTeacherId: string | null;
  wiseClassId: string | null;
  className: string | null;
  subject: string | null;
  classType: string | null;
  startTime: Date;
  endTime: Date | null;
  durationMinutes: number;
  meetingStatus: string;
  sessionType: string | null;
  studentCount: number | null;
  raw: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function dateValue(value: unknown): Date | null {
  const raw = stringValue(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function assertPayrollMonth(value: string | null | undefined): string {
  const month = String(value ?? "").trim();
  if (!PAYROLL_MONTH_RE.test(month)) {
    throw new Error("Invalid month. Expected YYYY-MM.");
  }
  const parsed = new Date(`${month}-01T00:00:00+07:00`);
  if (Number.isNaN(parsed.getTime()) || bangkokDateKey(parsed).slice(0, 7) !== month) {
    throw new Error("Invalid month. Expected YYYY-MM.");
  }
  return month;
}

export function payrollMonthRange(monthInput: string): PayrollMonthRange {
  const month = assertPayrollMonth(monthInput);
  const startDate = `${month}-01`;
  const endDate = endOfBangkokMonth(startDate);
  const start = bangkokDateStartUtc(startDate);
  start.setUTCDate(start.getUTCDate() - 1);
  const end = bangkokDateStartUtc(endDate);
  end.setUTCDate(end.getUTCDate() + 1);
  return {
    month,
    payrollMonth: startDate,
    startDate,
    endDate,
    queryStartDate: bangkokDateKey(start),
    queryEndDate: bangkokDateKey(end),
  };
}

export function normalizeTierLabel(rawTier: string | null | undefined): PayrollTier {
  const value = String(rawTier ?? "").trim();
  if (!value) return "Unassigned";
  if (/^Tier\s+0/i.test(value)) return "BG0";
  if (/^Tier\s+1\b/i.test(value)) return "BG1";
  if (/^Tier\s+2\b/i.test(value)) return "BG2";
  if (/^Tier\s+3\b/i.test(value)) return "BG3";
  return "Unassigned";
}

export function extractTierTag(tags: WiseTag[] | string[] | undefined): string | null {
  for (const tag of tags ?? []) {
    const name = typeof tag === "string" ? tag : getWiseTagName(tag);
    if (TIER_RE.test(name.trim())) return name.trim();
  }
  return null;
}

export function amountMinorToMajor(value: number | null | undefined, currency: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return currency.toUpperCase() === "THB" ? value / 100 : value;
}

export function isKevinCanonicalKey(value: string | null | undefined): boolean {
  return String(value ?? "").trim().toLowerCase() === "kevin";
}

export function payrollDurationMinutes(input: {
  scheduledStartTime?: string;
  scheduledEndTime?: string;
  duration?: number;
}): number {
  const start = dateValue(input.scheduledStartTime);
  const end = dateValue(input.scheduledEndTime);
  if (start && end && end > start) {
    return Math.round((end.getTime() - start.getTime()) / 60_000);
  }
  const durationMs = numberValue(input.duration);
  return durationMs && durationMs > 0 ? Math.round(durationMs / 60_000) : 0;
}

export function roundPayrollNumber(value: number, digits = 2): number {
  const scale = 10 ** digits;
  return Math.round((Number.isFinite(value) ? value : 0) * scale) / scale;
}

export function isEndedPayrollSession(status: string | null | undefined): boolean {
  return String(status ?? "").trim().toUpperCase() === "ENDED";
}

export function isZeroCreditOrAmount(input: {
  sessionCredits: number | null | undefined;
  amount: number | null | undefined;
}): boolean {
  return (Number(input.sessionCredits) || 0) <= 0 || (Number(input.amount) || 0) <= 0;
}

export function normalizePayrollPayoutEvent(raw: WiseActivityEvent): NormalizedPayrollPayoutEvent | null {
  const event = raw.event ?? {};
  if (event.eventName !== "TutorPayoutInvoiceCreatedEvent") return null;

  const payload = isRecord(event.payload) ? event.payload : {};
  const transaction = isRecord(payload.transaction) ? payload.transaction : {};
  const metadata = isRecord(transaction.metadata) ? transaction.metadata : {};
  const amount = isRecord(transaction.amount) ? transaction.amount : {};

  const eventId = stringValue(event.eventId);
  const transactionId = stringValue(transaction.id) ?? stringValue(transaction._id);
  const eventTimestamp = dateValue(event.eventTimestamp);
  if (!eventId || !transactionId || !eventTimestamp) return null;

  const currency = stringValue(amount.currency) ?? "THB";
  const amountMinor = numberValue(amount.value);
  return {
    eventId,
    transactionId,
    eventTimestamp,
    wiseTeacherUserId: stringValue(transaction.senderId),
    actorWiseUserId: stringValue(raw.user?._id),
    wiseClassId: stringValue(metadata.classId) ?? stringValue(payload.class && isRecord(payload.class) ? payload.class.id : null),
    wiseSessionId: stringValue(metadata.sessionId) ?? stringValue(payload.session && isRecord(payload.session) ? payload.session.id : null),
    sessionStartTime: dateValue(metadata.sessionStartTime),
    sessionCredits: numberValue(metadata.sessionCredits) ?? 0,
    amountMinor,
    amount: amountMinorToMajor(amountMinor, currency),
    currency,
    transactionStatus: stringValue(transaction.status),
    note: stringValue(transaction.note),
    raw: raw as Record<string, unknown>,
  };
}

export function normalizePayrollSession(raw: WiseSession): NormalizedPayrollSession | null {
  const startTime = dateValue(raw.scheduledStartTime);
  if (!raw._id || !startTime) return null;
  const endTime = dateValue(raw.scheduledEndTime);
  return {
    wiseSessionId: raw._id,
    wiseTeacherUserId: getWiseSessionTeacherUserId(raw) ?? null,
    wiseTeacherId: typeof raw.teacherId === "string" ? raw.teacherId : null,
    wiseClassId: getWiseSessionClassId(raw) ?? null,
    className: getWiseSessionClassName(raw) ?? null,
    subject: getWiseSessionClassSubject(raw) ?? null,
    classType: getWiseSessionClassType(raw) ?? null,
    startTime,
    endTime,
    durationMinutes: payrollDurationMinutes(raw),
    meetingStatus: raw.meetingStatus ?? "UNKNOWN",
    sessionType: raw.type ?? null,
    studentCount: typeof raw.studentCount === "number" ? raw.studentCount : null,
    raw: raw as Record<string, unknown>,
  };
}

export function dateIsInPayrollMonth(date: Date | null, range: PayrollMonthRange): boolean {
  if (!date) return false;
  const key = bangkokDateKey(date);
  return key >= range.startDate && key <= range.endDate;
}
