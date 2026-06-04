import type {
  AffectedSession,
  LeaveRequestDetail,
  LeaveRequestRow,
  SheetWriteStatus,
  TimelineBucket,
  WorkflowStatus,
} from "./types";

export const SHEETS_WRITE_SCOPE = "openid email profile https://www.googleapis.com/auth/spreadsheets";

export const STATUS_OPTIONS: Array<{ value: WorkflowStatus; label: string }> = [
  { value: "new", label: "New" },
  { value: "needs_review", label: "Needs review" },
  { value: "in_progress", label: "In progress" },
  { value: "done", label: "Done" },
  { value: "ignored", label: "Ignored" },
  { value: "canceled_by_tutor", label: "Canceled by tutor" },
];

export type QueueFilter = "action" | "new" | "review" | "done" | "all";

export const QUEUE_FILTERS: Array<{ key: QueueFilter; label: string }> = [
  { key: "action", label: "Action needed" },
  { key: "new", label: "New" },
  { key: "review", label: "Review" },
  { key: "done", label: "Done" },
  { key: "all", label: "All" },
];

export type DatePreset = "any" | "today" | "week" | "month";

export const DATE_PRESETS: Array<{ key: DatePreset; label: string }> = [
  { key: "any", label: "Any time" },
  { key: "today", label: "Today" },
  { key: "week", label: "This week" },
  { key: "month", label: "This month" },
];

const STATUS_LABELS = new Map(STATUS_OPTIONS.map((option) => [option.value, option.label]));

export function statusLabel(status: string): string {
  return STATUS_LABELS.get(status as WorkflowStatus) ?? status.replaceAll("_", " ");
}

export function statusToneClass(status: string): string {
  if (status === "new") return "border-sky-200 bg-sky-50 text-sky-800";
  if (status === "needs_review") return "border-amber-200 bg-amber-50 text-amber-900";
  if (status === "done") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "ignored") return "border-slate-200 bg-slate-50 text-slate-700";
  if (status === "canceled_by_tutor") return "border-purple-200 bg-purple-50 text-purple-800";
  return "border-blue-200 bg-blue-50 text-blue-800";
}

export function sheetStatusMeta(status: SheetWriteStatus): { label: string; className: string } {
  if (status === "success") {
    return { label: "Written", className: "text-emerald-700" };
  }
  if (status === "failed") {
    return { label: "Failed", className: "text-red-700" };
  }
  if (status === "pending") {
    return { label: "Pending", className: "text-amber-700" };
  }
  return { label: "Not required", className: "text-muted-foreground" };
}

export function isActionNeeded(row: Pick<LeaveRequestRow, "workflowStatus" | "sheetWriteStatus">): boolean {
  return row.workflowStatus === "new" || row.workflowStatus === "needs_review" || row.sheetWriteStatus === "failed";
}

export function filterQueueRows(rows: LeaveRequestRow[], filter: QueueFilter): LeaveRequestRow[] {
  if (filter === "action") return rows.filter(isActionNeeded);
  if (filter === "new") return rows.filter((row) => row.workflowStatus === "new");
  if (filter === "review") return rows.filter((row) => row.workflowStatus === "needs_review");
  if (filter === "done") return rows.filter((row) => row.workflowStatus === "done");
  return rows;
}

export function serverStatusForFilter(filter: QueueFilter): WorkflowStatus | undefined {
  if (filter === "new") return "new";
  if (filter === "review") return "needs_review";
  if (filter === "done") return "done";
  return undefined;
}

function bangkokParts(date: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: value("year"), month: value("month"), day: value("day") };
}

export function bangkokDateKey(date = new Date()): string {
  const { year, month, day } = bangkokParts(date);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function addUtcDays(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function monthEnd(dateKey: string): string {
  const year = Number(dateKey.slice(0, 4));
  const monthIndex = Number(dateKey.slice(5, 7));
  return new Date(Date.UTC(year, monthIndex, 0)).toISOString().slice(0, 10);
}

export function dateRangeForPreset(preset: DatePreset, now = new Date()): { startDate?: string; endDate?: string } {
  if (preset === "any") return {};
  const today = bangkokDateKey(now);
  if (preset === "today") return { startDate: today, endDate: today };
  if (preset === "month") return { startDate: `${today.slice(0, 7)}-01`, endDate: monthEnd(today) };
  const day = new Date(`${today}T00:00:00.000Z`).getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const startDate = addUtcDays(today, mondayOffset);
  return { startDate, endDate: addUtcDays(startDate, 6) };
}

export function buildListParams(input: {
  filter: QueueFilter;
  query: string;
  datePreset: DatePreset;
  now?: Date;
}): URLSearchParams {
  const params = new URLSearchParams();
  const serverStatus = serverStatusForFilter(input.filter);
  if (serverStatus) params.set("status", serverStatus);
  const trimmed = input.query.trim();
  if (trimmed) params.set("q", trimmed);
  const range = dateRangeForPreset(input.datePreset, input.now);
  if (range.startDate) params.set("startDate", range.startDate);
  if (range.endDate) params.set("endDate", range.endDate);
  return params;
}

export function timeLabel(minute: number): string {
  const hours = Math.floor(minute / 60);
  const minutes = minute % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function dateRange(row: Pick<LeaveRequestRow, "startDate" | "endDate">): string {
  if (!row.startDate) return "Needs review";
  if (!row.endDate || row.endDate === row.startDate) return row.startDate;
  return `${row.startDate} - ${row.endDate}`;
}

export function leaveTimeLabel(row: Pick<LeaveRequestRow, "timePeriod" | "specificTimeText" | "startMinute" | "endMinute">): string {
  if (row.specificTimeText?.trim()) return row.specificTimeText.trim();
  if (row.timePeriod?.trim()) return row.timePeriod.trim();
  if (typeof row.startMinute === "number" && typeof row.endMinute === "number") {
    if (row.startMinute === 0 && row.endMinute === 1440) return "Full day";
    return `${timeLabel(row.startMinute)}-${timeLabel(row.endMinute)}`;
  }
  return "Full day";
}

export function formatDateTime(value: string | null): string {
  if (!value) return "Not synced";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

export function formatShortDate(value: string | null): string {
  if (!value) return "Needs review";
  const date = new Date(`${value}T00:00:00.000Z`);
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
  }).format(date);
}

export function latestUpdatedAt(rows: LeaveRequestRow[]): string | null {
  const timestamps = rows
    .map((row) => row.updatedAt)
    .filter((value): value is string => Boolean(value))
    .sort();
  return timestamps.at(-1) ?? null;
}

export function buildTimelineBucketsFromRows(rows: LeaveRequestRow[]): TimelineBucket[] {
  const buckets = new Map<string, TimelineBucket>();
  for (const row of rows) {
    if (!row.startDate) continue;
    const existing = buckets.get(row.startDate) ?? {
      date: row.startDate,
      total: 0,
      needsAction: 0,
      affectedClasses: 0,
    };
    existing.total += 1;
    existing.needsAction += isActionNeeded(row) ? 1 : 0;
    existing.affectedClasses += row.affectedClassCount;
    buckets.set(row.startDate, existing);
  }
  return [...buckets.values()].sort((left, right) => left.date.localeCompare(right.date));
}

export function buildNext14DayTimeline(
  buckets: TimelineBucket[],
  now = new Date(),
): TimelineBucket[] {
  const byDate = new Map(buckets.map((bucket) => [bucket.date, bucket]));
  const start = bangkokDateKey(now);
  return Array.from({ length: 14 }, (_, index) => {
    const date = addUtcDays(start, index);
    return byDate.get(date) ?? {
      date,
      total: 0,
      needsAction: 0,
      affectedClasses: 0,
    };
  });
}

export function formatTimelineDay(value: string): { weekday: string; dateLabel: string } {
  const date = new Date(`${value}T00:00:00.000Z`);
  return {
    weekday: new Intl.DateTimeFormat("en-GB", { weekday: "short" }).format(date),
    dateLabel: new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short" }).format(date),
  };
}

function formatRangeEndpoint(value: string, includeYear: boolean): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    ...(includeYear ? { year: "numeric" } : {}),
  }).format(date);
}

export function timelineRangeLabel(buckets: TimelineBucket[]): string {
  const first = buckets[0]?.date;
  const last = buckets.at(-1)?.date;
  if (!first || !last) return "No dates loaded";
  const sameYear = first.slice(0, 4) === last.slice(0, 4);
  return `${formatRangeEndpoint(first, !sameYear)} - ${formatRangeEndpoint(last, true)}`;
}

export function timelineMonthLabel(buckets: TimelineBucket[]): string {
  const first = buckets[0]?.date;
  if (!first) return "Upcoming";
  return new Intl.DateTimeFormat("en-GB", {
    month: "long",
    year: "numeric",
  }).format(new Date(`${first}T00:00:00.000Z`));
}

export function pressureTone(affectedClasses: number): "none" | "low" | "medium" | "high" {
  if (affectedClasses <= 0) return "none";
  if (affectedClasses >= 10) return "high";
  if (affectedClasses >= 3) return "medium";
  return "low";
}

export function pressureLabel(affectedClasses: number): string {
  const tone = pressureTone(affectedClasses);
  if (tone === "none") return "No class impact";
  if (tone === "low") return "Low class impact";
  if (tone === "medium") return "Medium class impact";
  return "High class impact";
}

export function isTimelineDateSelected(bucket: TimelineBucket, selectedDate: string | null): boolean {
  return Boolean(selectedDate && bucket.date === selectedDate);
}

export function isTimelineDateToday(bucket: TimelineBucket, now = new Date()): boolean {
  return bucket.date === bangkokDateKey(now);
}

export function requestAlerts(detail: LeaveRequestDetail | null): string[] {
  if (!detail) return [];
  const alerts: string[] = [];
  if (detail.request.normalizationError) alerts.push(detail.request.normalizationError);
  if (detail.request.matchConfidence === "unmatched") {
    alerts.push(detail.request.matchReason ?? "Tutor could not be matched to Wise.");
  }
  if (detail.request.sheetWriteStatus === "failed") {
    alerts.push(detail.request.sheetWriteError ?? "Google Sheets writeback failed.");
  }
  if (detail.affectedSessions.length > 0) {
    alerts.push(`${detail.affectedSessions.length} Wise class${detail.affectedSessions.length === 1 ? "" : "es"} overlap${detail.affectedSessions.length === 1 ? "s" : ""} with this leave.`);
  }
  return alerts;
}

export function affectedSessionTitle(session: AffectedSession): string {
  return session.title || session.studentName || session.subject || "Class";
}

export function affectedSessionStudentLabel(session: AffectedSession): string {
  if (session.students.length === 1) return session.students[0].studentName;
  if (session.students.length > 1) return `${session.students.length} affected students`;
  return session.studentName || affectedSessionTitle(session);
}

export function affectedSessionClassLabel(session: AffectedSession): string {
  return session.title || session.subject || "Wise class";
}

export function studentContactState(student: AffectedSession["students"][number]): string {
  if (!student.parentName) return "Parent not found in Credit Control snapshot";
  if (student.lineContacts.length === 0) return "No verified LINE link";
  if (student.lineContacts.some((contact) => contact.lineChatUrl)) return "Verified LINE link";
  return "LINE verified, direct chat URL unavailable";
}

export function affectedSessionFallbackText(session: AffectedSession): string | null {
  if (session.students.length > 0) return null;
  return session.studentName
    ? "No student roster found; showing Wise session label"
    : "No student roster found in Credit Control snapshot";
}
