import { formatShortTimestamp } from "@/lib/credit-control/helpers";
import type {
  CalendarDay,
  CalendarPayload,
  PackageRecord,
  PackageStatus,
  StudentActionStatus,
  StudentQueueRow,
  StudentRecord,
  SummaryPayload,
} from "@/types/credit-control";

// ---------------------------------------------------------------------------
// Shared types used across decomposed dashboard components
// ---------------------------------------------------------------------------

export type RiskFilter = "all" | "notify" | "watch" | "ok";
export type CalendarView = "month" | "week" | "day";
export type SortField =
  | "priorityScore"
  | "student"
  | "totalCurrentRemaining"
  | "totalAdjustedRemaining"
  | "nextSessionDate"
  | "packageCount";
export type SortState = { field: SortField; dir: "asc" | "desc" };
export type Toast = {
  message: string;
  tone: "success" | "error";
  undo?: {
    studentKey: string;
    previousStatus: StudentActionStatus | null;
    previousActionState: StudentRecord["actionState"];
  };
} | null;
export type LinePreview = { student: StudentRecord; pkg: PackageRecord; message: string } | null;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;
export const STATUS_ORDER: Record<PackageStatus, number> = {
  notify: 0,
  watch: 1,
  ok: 2,
  nodata: 3,
};

// ---------------------------------------------------------------------------
// Admin-scoped summary computation
// ---------------------------------------------------------------------------

export function buildAdminScopedSummary(
  students: StudentRecord[],
  studentQueue: StudentQueueRow[],
): SummaryPayload {
  const studentCounts: SummaryPayload["students"] = {
    total: students.length,
    notify: 0,
    watch: 0,
    ok: 0,
    nodata: 0,
  };
  const packageCounts: SummaryPayload["packages"] = {
    total: 0,
    notify: 0,
    watch: 0,
    ok: 0,
    nodata: 0,
  };
  let exhaustedNow = 0;
  let risk7 = 0;
  let risk14 = 0;
  let risk30 = 0;
  let noSchedule = 0;
  let pendingDeductionBacklog = 0;
  let pendingDeductionPackages = 0;
  let lowBalanceNoSchedule = 0;
  let multiRiskStudents = 0;

  students.forEach((student) => {
    const worst = worstStatus(student.packages);
    studentCounts[worst] += 1;
    const riskyPackages = student.packages.filter((pkg) => pkg.status === "notify" || pkg.status === "watch").length;
    if (riskyPackages > 1) multiRiskStudents += 1;

    student.packages.forEach((pkg) => {
      packageCounts.total += 1;
      packageCounts[pkg.status] += 1;
      if (pkg.adjustedRemaining <= 0) exhaustedNow += 1;
      if (pkg.daysUntilAlert !== null && pkg.daysUntilAlert <= 7) risk7 += 1;
      if (pkg.daysUntilAlert !== null && pkg.daysUntilAlert <= 14) risk14 += 1;
      if (pkg.daysUntilAlert !== null && pkg.daysUntilAlert <= 30) risk30 += 1;
      if (pkg.dataQualityFlags.includes("no-upcoming-sessions")) noSchedule += 1;
      if (pkg.pendingDeduction > 0) {
        pendingDeductionBacklog += pkg.pendingDeduction;
        pendingDeductionPackages += 1;
      }
      if (pkg.dataQualityFlags.includes("low-balance-no-schedule")) lowBalanceNoSchedule += 1;
    });
  });

  return {
    students: studentCounts,
    packages: packageCounts,
    portfolio: {
      exhaustedNow,
      risk7,
      risk14,
      risk30,
      noSchedule,
      pendingDeductionBacklog,
      pendingDeductionPackages,
      lowBalanceNoSchedule,
      multiRiskStudents,
    },
    queue: {
      students: studentQueue.length,
      pinnedStudents: studentQueue.filter((row) => row.pinned).length,
    },
    deltas: {
      packagesNotify: null,
      packagesWatch: null,
      risk7: null,
      risk30: null,
      pendingDeductionBacklog: null,
      noSchedule: null,
      queueStudents: null,
      pinnedStudents: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Visibility filters
// ---------------------------------------------------------------------------

export function isStudentVisibleForCurrentAdmin(student: StudentRecord, adminView: string) {
  if (adminView === "all") return true;
  if (adminView === "unassigned") return student.adminOwnerKey === "unassigned";
  return student.adminOwnerKey === adminView;
}

export function isQueueRowVisibleForCurrentAdmin(row: StudentQueueRow, adminView: string) {
  if (adminView === "all") return true;
  if (adminView === "unassigned") return row.adminOwnerKey === "unassigned";
  return row.adminOwnerKey === adminView;
}

// ---------------------------------------------------------------------------
// Calendar helpers
// ---------------------------------------------------------------------------

export function buildFilteredCalendarDayMap(days: CalendarDay[], currentSearch: string) {
  return days.reduce<Record<string, CalendarDay>>((map, day) => {
    const students = day.students.filter(
      (student) => !currentSearch || student.searchText.includes(currentSearch),
    );
    map[day.date] = {
      date: day.date,
      totalStudents: students.length,
      urgentStudents: students.filter((student) => student.pinned || student.worstStatus === "notify").length,
      watchStudents: students.filter((student) => student.worstStatus === "watch").length,
      students,
    };
    return map;
  }, {});
}

export function getDefaultCalendarDate(calendar: CalendarPayload) {
  const todayKey = formatDateKey(new Date());
  if (calendar.days.some((day) => day.date === todayKey && day.totalStudents > 0)) {
    return todayKey;
  }
  return calendar.days.find((day) => day.totalStudents > 0)?.date ?? todayKey;
}

export function getSelectedCalendarDay(
  filteredCalendarDayMap: Record<string, CalendarDay>,
  selectedCalendarDate: string,
) {
  return selectedCalendarDate
    ? filteredCalendarDayMap[selectedCalendarDate] || createEmptyCalendarDay(selectedCalendarDate)
    : null;
}

export function getVisibleCalendarDates(filteredCalendarDayMap: Record<string, CalendarDay>) {
  return Object.keys(filteredCalendarDayMap)
    .filter((key) => filteredCalendarDayMap[key].totalStudents > 0)
    .sort(compareNullableDates);
}

export function createEmptyCalendarDay(dateKey: string): CalendarDay {
  return {
    date: dateKey,
    totalStudents: 0,
    urgentStudents: 0,
    watchStudents: 0,
    students: [],
  };
}

export function getCalendarDayTone(day: CalendarDay | null) {
  if (!day || !day.totalStudents) return "empty";
  if (day.urgentStudents) return "urgent";
  if (day.watchStudents) return "watch";
  return "scheduled";
}

export function getCalendarSeverityLabel(day: CalendarDay | null) {
  if (!day || !day.totalStudents) return "No sessions";
  if (day.urgentStudents) return `${day.urgentStudents} urgent`;
  if (day.watchStudents) return `${day.watchStudents} watch`;
  return "Healthy day";
}

export function getActionableStripDays(
  filteredCalendarDayMap: Record<string, CalendarDay>,
  selectedCalendarDate: string,
) {
  const visibleDates = getVisibleCalendarDates(filteredCalendarDayMap);
  if (!visibleDates.length) return [];

  const referenceKey = selectedCalendarDate || formatDateKey(new Date());
  const startIndex = visibleDates.findIndex((key) => compareNullableDates(key, referenceKey) >= 0);
  const sliceStart = startIndex === -1 ? Math.max(0, visibleDates.length - 7) : startIndex;

  return visibleDates.slice(sliceStart, sliceStart + 7).map((key) => filteredCalendarDayMap[key]);
}

export function getAdjacentActionableDate(
  dateKey: string,
  direction: number,
  filteredCalendarDayMap: Record<string, CalendarDay>,
) {
  const visibleDates = getVisibleCalendarDates(filteredCalendarDayMap);
  if (!visibleDates.length) return null;
  const currentIndex = visibleDates.indexOf(dateKey);
  if (currentIndex === -1) {
    return direction > 0 ? visibleDates[0] : visibleDates[visibleDates.length - 1];
  }

  const nextIndex = currentIndex + direction;
  if (nextIndex < 0 || nextIndex >= visibleDates.length) {
    return null;
  }

  return visibleDates[nextIndex];
}

export function findNextCalendarDate(dateKeys: string[], referenceKey: string) {
  if (!dateKeys.length) return null;
  return dateKeys.find((key) => compareNullableDates(key, referenceKey) > 0) || dateKeys[0];
}

export function buildCalendarCells(view: CalendarView, cursor: Date) {
  if (view === "week") {
    const start = startOfWeek(cursor);
    return Array.from({ length: 7 }, (_, index) => addDays(start, index));
  }

  if (view === "day") {
    return [cursor];
  }

  const start = startOfWeek(startOfMonth(cursor));
  return Array.from({ length: 42 }, (_, index) => addDays(start, index));
}

export function getCalendarCursorForView(view: CalendarView, date: Date) {
  if (view === "month") return startOfMonth(date);
  if (view === "week") return startOfWeek(date);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function getDefaultDateForCurrentPeriod(
  cursorDate: Date,
  view: Exclude<CalendarView, "day">,
  filteredCalendarDayMap: Record<string, CalendarDay>,
) {
  const visibleDates = getVisibleCalendarDates(filteredCalendarDayMap);
  if (!visibleDates.length) {
    return formatDateKey(cursorDate);
  }

  if (view === "month") {
    const monthStart = startOfMonth(cursorDate);
    const monthEnd = new Date(cursorDate.getFullYear(), cursorDate.getMonth() + 1, 0);
    return (
      visibleDates.find(
        (key) =>
          compareNullableDates(key, formatDateKey(monthStart)) >= 0 &&
          compareNullableDates(key, formatDateKey(monthEnd)) <= 0,
      ) || formatDateKey(monthStart)
    );
  }

  const weekStart = startOfWeek(cursorDate);
  const weekEnd = addDays(weekStart, 6);
  return (
    visibleDates.find(
      (key) =>
        compareNullableDates(key, formatDateKey(weekStart)) >= 0 &&
        compareNullableDates(key, formatDateKey(weekEnd)) <= 0,
    ) || formatDateKey(weekStart)
  );
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

export function compareNullableDates(valueA: string | null, valueB: string | null) {
  const normalizedA = valueA ? parseDateKey(valueA).getTime() : Number.POSITIVE_INFINITY;
  const normalizedB = valueB ? parseDateKey(valueB).getTime() : Number.POSITIVE_INFINITY;
  return normalizedA - normalizedB;
}

export function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function startOfWeek(date: Date) {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  copy.setDate(copy.getDate() - copy.getDay());
  return copy;
}

export function addDays(date: Date, numberOfDays: number) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + numberOfDays);
}

export function parseDateKey(value: string) {
  const parts = String(value).split("-").map(Number);
  return new Date(parts[0], parts[1] - 1, parts[2]);
}

export function formatDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatShortDate(value: string) {
  const date = parseDateKey(value);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function formatShortWeekday(value: string) {
  const date = parseDateKey(value);
  return date.toLocaleDateString("en-US", { weekday: "short" });
}

export function formatLongDate(value: string) {
  const date = parseDateKey(value);
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export function formatMonthYear(date: Date) {
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

export function formatCurrentCalendarHeading(
  view: CalendarView,
  cursor: Date,
  selectedCalendarDate: string,
) {
  if (view === "month") {
    return formatMonthYear(cursor);
  }

  if (view === "week") {
    const start = startOfWeek(cursor);
    const end = addDays(start, 6);
    return `${formatShortDate(formatDateKey(start))} - ${formatShortDate(formatDateKey(end))}`;
  }

  return selectedCalendarDate
    ? formatLongDate(selectedCalendarDate)
    : formatLongDate(formatDateKey(cursor));
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function formatNumber(value: number) {
  return value % 1 === 0 ? String(value) : value.toFixed(1);
}

export function balanceTone(value: number) {
  if (value <= 0 || value < 2) return "balance-critical";
  if (value < 4) return "balance-warning";
  return "balance-positive";
}

export function statusLabel(status: PackageStatus) {
  return {
    notify: "Notify",
    watch: "Watch",
    ok: "Healthy",
    nodata: "No data",
  }[status];
}

export function actionStatusLabel(status: StudentActionStatus) {
  return {
    contacted: "Contacted",
    "pending-callback": "Pending callback",
    resolved: "Resolved",
  }[status];
}

export function formatActionStateSummary(actionState: StudentRecord["actionState"]) {
  if (!actionState) return "No active follow-up status";
  return `${actionStatusLabel(actionState.status)} ${formatShortTimestamp(actionState.updatedAt)} by ${actionState.updatedByName}`;
}

export function buildActionToastMessage(
  actionState: { status: StudentActionStatus } | null,
  count: number,
) {
  if (!actionState) {
    return count === 1
      ? "Cleared follow-up status."
      : `Cleared follow-up status for ${count} students.`;
  }

  const label = actionStatusLabel(actionState.status).toLowerCase();
  return count === 1 ? `Marked student as ${label}.` : `Marked ${count} students as ${label}.`;
}

export function worstStatus(packages: PackageRecord[]) {
  if (packages.some((pkg) => pkg.status === "notify")) return "notify";
  if (packages.some((pkg) => pkg.status === "watch")) return "watch";
  if (packages.some((pkg) => pkg.status === "ok")) return "ok";
  return "nodata";
}

export function buildParentMessage(student: StudentRecord, pkg: PackageRecord) {
  const studentFirst = String(student.student || "").split(" ")[0];
  const program = pkg.subject || "";
  const packageName = pkg.name || "";
  const remaining = pkg.adjustedRemaining;

  const packageDetails = [
    "ข้อมูลการซื้อแพ็กเกจครั้งล่าสุด",
    `▶️ Program: ${program}`,
    `▶️ Package: ${packageName}`,
    "▶️ Date of Purchase:  ",
  ];

  if (remaining === 0) {
    return [
      `สวัสดีค่ะ ขออนุญาตแจ้งว่า เครดิตของน้อง ${studentFirst}  ได้หมดลงแล้วนะคะ`,
      "",
      ...packageDetails,
      "",
      "ขออนุญาตส่งรายละเอียดสำหรับการ renew แพ็กเกจให้คุณแม่พิจารณานะคะ คุณแม่สะดวกรับแพ็กเกจระยะยาวให้น้องเลยดีไหมคะ",
    ].join("\n");
  }

  if (remaining < 0) {
    return [
      `สวัสดีค่ะ ขออนุญาตแจ้งอัปเดตยอดแพ็กเกจของน้อง ${studentFirst} นะคะ`,
      "",
      `☑️ ยอดแพ็กเกจคงเหลือ (as of today):  ติดลบ ${formatNumber(Math.abs(remaining))} Hrs`,
      "",
      ...packageDetails,
      "",
      "ขออนุญาตส่งรายละเอียดสำหรับการ renew แพ็กเกจให้คุณแม่พิจารณานะคะ คุณแม่สะดวกรับแพ็กเกจระยะยาวให้น้องเลยดีไหมคะ",
    ].join("\n");
  }

  return [
    `สวัสดีค่ะ ขออนุญาตแจ้งอัปเดตยอดแพ็กเกจของน้อง ${studentFirst} นะคะ`,
    "",
    `☑️ ยอดแพ็กเกจคงเหลือ (as of today):  คงเหลือ ${formatNumber(remaining)} Hrs`,
    "",
    ...packageDetails,
    "",
    "คุณแม่สะดวกรับแพ็กเกจไว้ให้น้องเลยดีไหมคะ",
  ].join("\n");
}

export function flagLabel(flag: string) {
  return {
    "no-upcoming-sessions": "No future schedule",
    "pending-deduction": "Pending deduction",
    "duplicate-source-rows": "Duplicate source rows",
    "low-balance-no-schedule": "Low balance + no schedule",
    "missing-parent": "Missing parent",
    "exhausted-now": "Exhausted now",
    "pending-deduction-fallback": "Pending deduction fallback",
  }[flag] || flag;
}

export function capitalize(value: string) {
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function clampPercentage(value: number) {
  return Math.max(0, Math.min(100, value));
}
