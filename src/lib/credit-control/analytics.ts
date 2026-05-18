import { ALERT_THRESHOLD, DAY_MS, HISTORY_LIMIT, UNASSIGNED_ADMIN_KEY, UNASSIGNED_ADMIN_NAME, getAdminViewOptions } from "@/lib/credit-control/config";
import {
  buildDashboardStudentKey,
  compareIsoDateValues,
  formatDate,
  formatDateTime,
  getStatusChangeLabel,
  getStatusSortValue,
  isStatusWorse,
  parseDate,
  roundToTenth,
} from "@/lib/credit-control/helpers";
import type {
  ActionState,
  CalendarDay,
  CalendarStudentEntry,
  PackageRecord,
  StudentRecord,
  StudentQueueRow,
  SummaryPayload,
} from "@/types/credit-control";
import type {
  DashboardModelResult,
  DashboardSnapshotState,
  PackageRow,
  PersistedSnapshotState,
} from "@/lib/credit-control/domain";
import { worstStatus } from "@/lib/credit-control/projection";

export function buildDashboardModel(
  students: StudentRecord[],
  snapshotState: DashboardSnapshotState,
  today: Date,
  now: Date,
): DashboardModelResult {
  const previousSnapshot = snapshotState.lastSnapshot;
  const packageRows = buildPackageRows(students, previousSnapshot);

  packageRows.forEach((row) => {
    const student = students[row.studentIndex];
    if (student?.packages[row.packageIndex]) {
      student.packages[row.packageIndex].priorityScore = row.priorityScore;
      student.packages[row.packageIndex].statusChange = row.statusChange;
      student.packages[row.packageIndex].balanceDelta = row.balanceDelta;
    }
  });

  const studentQueue = buildStudentQueue(students);
  const summary = buildSummary(students, packageRows, previousSnapshot, studentQueue);
  const calendar = buildCalendarData(students, studentQueue, today);
  const snapshotForPersistence = buildSnapshotForPersistence(summary, packageRows, now);
  const nextHistory = updateHistory(snapshotState.history, summary, now);

  return {
    payload: {
      adminViews: getAdminViewOptions(),
      lastUpdatedAt: formatDateTime(now),
      previousUpdatedAt: previousSnapshot ? previousSnapshot.generatedAt : null,
      summary,
      studentQueue,
      calendar,
      students,
    },
    snapshotState: {
      lastSnapshot: snapshotForPersistence,
      history: nextHistory,
    },
  };
}

export function buildPackageRows(
  students: StudentRecord[],
  previousSnapshot: PersistedSnapshotState | null,
): PackageRow[] {
  const previousPackages = previousSnapshot?.packages ?? {};
  const flatRows: PackageRow[] = [];
  const riskyCountByStudent: Record<string, number> = {};

  students.forEach((student, studentIndex) => {
    student.packages.forEach((pkg, packageIndex) => {
      const previous = previousPackages[pkg.key] ?? null;
      const isRisky = pkg.status === "notify" || pkg.status === "watch";
      riskyCountByStudent[student.student] ??= 0;
      if (isRisky) riskyCountByStudent[student.student] += 1;

      flatRows.push({
        key: pkg.key,
        student: student.student,
        parent: student.parent || "Missing parent",
        packageName: pkg.name,
        subject: pkg.subject,
        status: pkg.status,
        currentRemaining: pkg.currentRemaining,
        adjustedRemaining: pkg.adjustedRemaining,
        pendingDeduction: pkg.pendingDeduction,
        totalCredits: pkg.totalCredits,
        alertDate: pkg.alertDate,
        exhaustDate: pkg.exhaustDate,
        daysUntilAlert: pkg.daysUntilAlert,
        daysUntilExhaust: pkg.daysUntilExhaust,
        nextSessionDate: pkg.nextSessionDate,
        upcomingCount: pkg.upcomingCount,
        sessionCadencePerWeek: pkg.sessionCadencePerWeek,
        averageCreditsPerWeek: pkg.averageCreditsPerWeek,
        cadenceLabel: pkg.cadenceLabel,
        dataQualityFlags: pkg.dataQualityFlags,
        recommendedAction: pkg.recommendedAction,
        whyNow: pkg.whyNow,
        previousStatus: previous ? previous.status : null,
        balanceDelta: previous ? roundToTenth(pkg.adjustedRemaining - previous.adjustedRemaining) : null,
        statusChange: getStatusChangeLabel(previous ? previous.status : null, pkg.status),
        studentIndex,
        packageIndex,
        priorityScore: 0,
      });
    });
  });

  flatRows.forEach((row) => {
    row.priorityScore = computePriorityScore(
      row,
      riskyCountByStudent[row.student] ?? 0,
      row.previousStatus,
      row.balanceDelta,
    );
    row.changeSummary = describeChange(row);
  });

  flatRows.sort(compareQueueRows);
  return flatRows;
}

export function computePriorityScore(
  row: PackageRow,
  riskyPackageCount: number,
  previousStatus: string | null,
  balanceDelta: number | null,
) {
  let score = 0;

  if (row.adjustedRemaining <= 0) score += 140;
  else if (row.status === "notify") score += 120;
  else if (row.status === "watch") score += 80;
  else if (row.status === "nodata") score += 28;

  if (row.daysUntilAlert !== null) {
    score += Math.max(0, 35 - Math.min(row.daysUntilAlert, 35));
  }
  if (row.daysUntilExhaust !== null) {
    score += Math.max(0, 45 - Math.min(row.daysUntilExhaust, 45));
  }
  if (row.pendingDeduction > 0) {
    score += Math.min(20, row.pendingDeduction * 4);
  }
  if (row.dataQualityFlags.includes("low-balance-no-schedule")) {
    score += 18;
  } else if (row.dataQualityFlags.includes("no-upcoming-sessions")) {
    score += 8;
  }
  if (row.dataQualityFlags.includes("duplicate-source-rows")) {
    score += 5;
  }
  if (previousStatus && isStatusWorse(row.status, previousStatus)) {
    score += 25;
  }
  if (balanceDelta !== null && balanceDelta < 0) {
    score += Math.min(20, Math.abs(balanceDelta) * 6);
  }
  if (riskyPackageCount > 1) {
    score += 10;
  }

  return roundToTenth(score);
}

function describeChange(row: PackageRow) {
  if (!row.previousStatus) return "New to dashboard";
  if (isStatusWorse(row.status, row.previousStatus)) return "Worsened since last refresh";
  if (isStatusWorse(row.previousStatus, row.status)) return "Improved since last refresh";
  if (row.balanceDelta !== null && row.balanceDelta < 0) {
    return `Down ${Math.abs(row.balanceDelta).toFixed(1)} credits`;
  }
  if (row.balanceDelta !== null && row.balanceDelta > 0) {
    return `Up ${row.balanceDelta.toFixed(1)} credits`;
  }
  return "Stable";
}

function compareQueueRows(a: PackageRow, b: PackageRow) {
  if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;

  const statusDelta = getStatusSortValue(a.status) - getStatusSortValue(b.status);
  if (statusDelta !== 0) return statusDelta;

  const exhaustA = a.daysUntilExhaust === null ? Number.POSITIVE_INFINITY : a.daysUntilExhaust;
  const exhaustB = b.daysUntilExhaust === null ? Number.POSITIVE_INFINITY : b.daysUntilExhaust;
  if (exhaustA !== exhaustB) return exhaustA - exhaustB;

  const alertA = a.daysUntilAlert === null ? Number.POSITIVE_INFINITY : a.daysUntilAlert;
  const alertB = b.daysUntilAlert === null ? Number.POSITIVE_INFINITY : b.daysUntilAlert;
  if (alertA !== alertB) return alertA - alertB;

  return a.student.localeCompare(b.student);
}

export function buildStudentQueue(students: StudentRecord[]): StudentQueueRow[] {
  return students
    .map((student, studentIndex) => buildStudentQueueRow(student, studentIndex))
    .filter((row) => row.includeInQueue)
    .sort(compareStudentQueueRows);
}

export function buildStudentQueueRow(student: StudentRecord, studentIndex: number): StudentQueueRow {
  const packages = student.packages ?? [];
  const totalCurrentRemaining = roundToTenth(packages.reduce((sum, pkg) => sum + pkg.currentRemaining, 0));
  const totalAdjustedRemaining = roundToTenth(packages.reduce((sum, pkg) => sum + pkg.adjustedRemaining, 0));
  const totalPendingDeduction = roundToTenth(packages.reduce((sum, pkg) => sum + pkg.pendingDeduction, 0));
  const totalCredits = roundToTenth(packages.reduce((sum, pkg) => sum + pkg.totalCredits, 0));
  const riskyPackages = packages.filter((pkg) => pkg.status === "notify" || pkg.status === "watch");
  const nextSession = findStudentNextSession(packages);
  const nextAlert = findEarliestPackageDate(packages, "alertDate");
  const nextExhaust = findEarliestPackageDate(packages, "exhaustDate");
  const daysUntilAlert = findMinimumPackageNumber(packages, "daysUntilAlert");
  const daysUntilExhaust = findMinimumPackageNumber(packages, "daysUntilExhaust");
  const worst = worstStatus(packages);
  const noFutureSchedule = !nextSession;
  const hasLowOrNegativeBalance =
    totalAdjustedRemaining < ALERT_THRESHOLD || totalCurrentRemaining <= 0;
  const pinned = noFutureSchedule && hasLowOrNegativeBalance;
  const includeInQueue = pinned || riskyPackages.length > 0;
  const maxPackagePriority = packages.reduce((maxScore, pkg) => Math.max(maxScore, pkg.priorityScore || 0), 0);
  const priorityScore = roundToTenth(
    maxPackagePriority +
      (pinned ? 90 : 0) +
      (noFutureSchedule ? 18 : 0) +
      (totalCurrentRemaining <= 0 ? 22 : 0) +
      Math.min(18, riskyPackages.length * 6) +
      Math.min(12, totalPendingDeduction * 2),
  );
  const packageNames = packages.map((pkg) => pkg.name).sort();

  return {
    key: student.student,
    studentKey: student.studentKey || buildDashboardStudentKey(student.student, student.parent),
    student: student.student,
    parent: student.parent || "Missing parent",
    studentIndex,
    adminOwnerKey: student.adminOwnerKey || UNASSIGNED_ADMIN_KEY,
    adminOwnerName: student.adminOwnerName || UNASSIGNED_ADMIN_NAME,
    actionState: cloneActionState(student.actionState),
    worstStatus: worst,
    packageCount: packages.length,
    riskyPackageCount: riskyPackages.length,
    totalCurrentRemaining,
    totalAdjustedRemaining,
    totalPendingDeduction,
    totalCredits,
    packageNames,
    nextSessionDate: nextSession ? nextSession.date : null,
    nextSessionPackageName: nextSession ? nextSession.packageName : null,
    nextSessionCount: packages.reduce((sum, pkg) => sum + (pkg.upcomingCount || 0), 0),
    nextAlertDate: nextAlert,
    nextExhaustDate: nextExhaust,
    daysUntilAlert,
    daysUntilExhaust,
    noFutureSchedule,
    pinned,
    includeInQueue,
    priorityScore,
    recommendedAction: getStudentRecommendedAction(
      worst,
      pinned,
      noFutureSchedule,
      totalAdjustedRemaining,
      totalCurrentRemaining,
    ),
    whyNow: getStudentActionReason(
      worst,
      pinned,
      noFutureSchedule,
      totalAdjustedRemaining,
      totalCurrentRemaining,
      nextAlert,
      nextSession,
    ),
    searchText: [student.student, student.parent || "", packageNames.join(" ")].join(" ").toLowerCase(),
  };
}

function compareStudentQueueRows(a: StudentQueueRow, b: StudentQueueRow) {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;

  const statusDelta = getStatusSortValue(a.worstStatus) - getStatusSortValue(b.worstStatus);
  if (statusDelta !== 0) return statusDelta;

  if (a.totalAdjustedRemaining !== b.totalAdjustedRemaining) {
    return a.totalAdjustedRemaining - b.totalAdjustedRemaining;
  }

  const nextSessionDelta = compareIsoDateValues(a.nextSessionDate, b.nextSessionDate);
  if (nextSessionDelta !== 0) return nextSessionDelta;

  return a.student.localeCompare(b.student);
}

export function buildCalendarData(
  students: StudentRecord[],
  studentQueue: StudentQueueRow[],
  today: Date,
) {
  const queueByStudent: Record<string, StudentQueueRow> = {};
  const dayMap: Record<string, { date: string; studentMap: Record<string, CalendarStudentEntry> }> = {};
  let minDate = formatDate(today) ?? null;
  let maxDate = formatDate(today) ?? null;

  studentQueue.forEach((row) => {
    queueByStudent[row.student] = row;
  });

  students.forEach((student, studentIndex) => {
    const queueRow = queueByStudent[student.student];

    student.packages.forEach((pkg) => {
      (pkg.upcomingSessions || []).forEach((session) => {
        const date = session.date;
        if (!date) return;
        if (!minDate || date < minDate) minDate = date;
        if (!maxDate || date > maxDate) maxDate = date;

        dayMap[date] ??= { date, studentMap: {} };

        if (!dayMap[date].studentMap[student.student]) {
          dayMap[date].studentMap[student.student] = {
            key: `${student.student}::${date}`,
            student: student.student,
            parent: student.parent || "Missing parent",
            studentIndex,
            adminOwnerKey: student.adminOwnerKey || UNASSIGNED_ADMIN_KEY,
            adminOwnerName: student.adminOwnerName || UNASSIGNED_ADMIN_NAME,
            worstStatus: queueRow ? queueRow.worstStatus : worstStatus(student.packages),
            totalAdjustedRemaining: queueRow
              ? queueRow.totalAdjustedRemaining
              : roundToTenth(student.packages.reduce((sum, item) => sum + item.adjustedRemaining, 0)),
            totalCurrentRemaining: queueRow
              ? queueRow.totalCurrentRemaining
              : roundToTenth(student.packages.reduce((sum, item) => sum + item.currentRemaining, 0)),
            priorityScore: queueRow ? queueRow.priorityScore : 0,
            pinned: queueRow ? queueRow.pinned : false,
            nextSessionDate: queueRow ? queueRow.nextSessionDate : null,
            packageCount: student.packages.length,
            recommendedAction: queueRow ? queueRow.recommendedAction : "Monitor",
            whyNow: queueRow ? queueRow.whyNow : "Upcoming sessions scheduled.",
            searchText: [
              student.student,
              student.parent || "",
              student.packages.map((item) => item.name).join(" "),
            ]
              .join(" ")
              .toLowerCase(),
            sessions: [],
          };
        }

        dayMap[date].studentMap[student.student].sessions.push({
          packageName: pkg.name,
          durationMin: session.durationMin,
          deduct: session.deduct,
          date: session.date,
        });
      });
    });
  });

  const days: CalendarDay[] = Object.keys(dayMap)
    .sort()
    .map((date) => {
      const studentsForDay = Object.keys(dayMap[date].studentMap)
        .map((studentName) => {
          const studentEntry = dayMap[date].studentMap[studentName];
          studentEntry.sessions.sort((a, b) => a.packageName.localeCompare(b.packageName));
          studentEntry.sessionCount = studentEntry.sessions.length;
          studentEntry.totalMinutes = studentEntry.sessions.reduce((sum, session) => sum + session.durationMin, 0);
          studentEntry.totalDeduction = roundToTenth(
            studentEntry.sessions.reduce((sum, session) => sum + session.deduct, 0),
          );
          studentEntry.isNextSessionDay = studentEntry.nextSessionDate === date;
          return studentEntry;
        })
        .sort(compareCalendarStudents);

      return {
        date,
        totalStudents: studentsForDay.length,
        urgentStudents: studentsForDay.filter((item) => item.pinned || item.worstStatus === "notify").length,
        watchStudents: studentsForDay.filter((item) => item.worstStatus === "watch").length,
        students: studentsForDay,
      };
    });

  return {
    availableStart: minDate,
    availableEnd: maxDate,
    days,
  };
}

function compareCalendarStudents(a: CalendarStudentEntry, b: CalendarStudentEntry) {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
  if (a.isNextSessionDay !== b.isNextSessionDay) return a.isNextSessionDay ? -1 : 1;
  return a.student.localeCompare(b.student);
}

function findStudentNextSession(packages: PackageRecord[]) {
  const sessions = packages.flatMap((pkg) =>
    (pkg.upcomingSessions || []).map((session) => ({
      date: session.date,
      packageName: pkg.name,
    })),
  );
  sessions.sort((a, b) => compareIsoDateValues(a.date, b.date));
  return sessions.length ? sessions[0] : null;
}

function findEarliestPackageDate(packages: PackageRecord[], fieldName: "alertDate" | "exhaustDate") {
  const values = packages
    .map((pkg) => pkg[fieldName])
    .filter((value): value is string => !!value)
    .sort(compareIsoDateValues);
  return values.length ? values[0] : null;
}

function findMinimumPackageNumber(
  packages: PackageRecord[],
  fieldName: "daysUntilAlert" | "daysUntilExhaust",
) {
  const values = packages
    .map((pkg) => pkg[fieldName])
    .filter((value): value is number => value !== null && value !== undefined);
  return values.length ? Math.min(...values) : null;
}

function getStudentRecommendedAction(
  worstStatusValue: string,
  pinned: boolean,
  noFutureSchedule: boolean,
  totalAdjustedRemaining: number,
  totalCurrentRemaining: number,
) {
  if (pinned && totalCurrentRemaining <= 0) return "Contact parent immediately";
  if (pinned || (noFutureSchedule && totalAdjustedRemaining < ALERT_THRESHOLD)) {
    return "Review schedule and renew";
  }
  if (worstStatusValue === "notify") return "Contact parent today";
  if (worstStatusValue === "watch") return "Prepare outreach";
  return "Monitor";
}

function getStudentActionReason(
  worstStatusValue: string,
  pinned: boolean,
  noFutureSchedule: boolean,
  totalAdjustedRemaining: number,
  totalCurrentRemaining: number,
  nextAlert: string | null,
  nextSession: { date: string; packageName: string } | null,
) {
  if (pinned && totalCurrentRemaining <= 0) {
    return "No future schedule is on file and the rolled-up system balance is already zero or negative.";
  }
  if (pinned) {
    return "No future schedule is on file and the rolled-up balance is already below the alert threshold.";
  }
  if (worstStatusValue === "notify") {
    return "At least one active package is already below the two-credit alert threshold.";
  }
  if (worstStatusValue === "watch" && nextAlert) {
    return `An active package is projected to fall below two credits on ${nextAlert}.`;
  }
  if (noFutureSchedule) {
    return "No future schedule is on file, so operations should confirm the next class plan.";
  }
  if (nextSession) {
    return `The next scheduled session is on ${nextSession.date}.`;
  }
  return "The student remains in monitoring with no immediate action.";
}

export function buildSummary(
  students: StudentRecord[],
  packageRows: PackageRow[],
  previousSnapshot: PersistedSnapshotState | null,
  studentQueue: StudentQueueRow[],
): SummaryPayload {
  const studentCounts: Record<string, number> = { total: students.length, notify: 0, watch: 0, ok: 0, nodata: 0 };
  const packageCounts: Record<string, number> = { total: packageRows.length, notify: 0, watch: 0, ok: 0, nodata: 0 };
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
    studentCounts[worstStatus(student.packages)] += 1;
    const riskyPackages = student.packages.filter((pkg) => pkg.status === "notify" || pkg.status === "watch").length;
    if (riskyPackages > 1) multiRiskStudents += 1;
  });

  packageRows.forEach((row) => {
    packageCounts[row.status] += 1;
    if (row.adjustedRemaining <= 0) exhaustedNow += 1;
    if (row.daysUntilAlert !== null && row.daysUntilAlert <= 7) risk7 += 1;
    if (row.daysUntilAlert !== null && row.daysUntilAlert <= 14) risk14 += 1;
    if (row.daysUntilAlert !== null && row.daysUntilAlert <= 30) risk30 += 1;
    if (row.dataQualityFlags.includes("no-upcoming-sessions")) noSchedule += 1;
    if (row.pendingDeduction > 0) {
      pendingDeductionBacklog += row.pendingDeduction;
      pendingDeductionPackages += 1;
    }
    if (row.dataQualityFlags.includes("low-balance-no-schedule")) lowBalanceNoSchedule += 1;
  });

  const currentSummary: SummaryPayload = {
    students: studentCounts as SummaryPayload["students"],
    packages: packageCounts as SummaryPayload["packages"],
    portfolio: {
      exhaustedNow,
      risk7,
      risk14,
      risk30,
      noSchedule,
      pendingDeductionBacklog: roundToTenth(pendingDeductionBacklog),
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

  currentSummary.deltas = buildSummaryDeltas(currentSummary, previousSnapshot?.summary ?? null);
  return currentSummary;
}

export function buildSummaryDeltas(
  currentSummary: SummaryPayload,
  previousSummary: SummaryPayload | null,
) {
  if (!previousSummary) {
    return {
      packagesNotify: null,
      packagesWatch: null,
      risk7: null,
      risk30: null,
      pendingDeductionBacklog: null,
      noSchedule: null,
      queueStudents: null,
      pinnedStudents: null,
    };
  }

  return {
    packagesNotify: currentSummary.packages.notify - previousSummary.packages.notify,
    packagesWatch: currentSummary.packages.watch - previousSummary.packages.watch,
    risk7: currentSummary.portfolio.risk7 - previousSummary.portfolio.risk7,
    risk30: currentSummary.portfolio.risk30 - previousSummary.portfolio.risk30,
    pendingDeductionBacklog: roundToTenth(
      currentSummary.portfolio.pendingDeductionBacklog - previousSummary.portfolio.pendingDeductionBacklog,
    ),
    noSchedule: currentSummary.portfolio.noSchedule - previousSummary.portfolio.noSchedule,
    queueStudents: currentSummary.queue.students - (previousSummary.queue?.students || 0),
    pinnedStudents: currentSummary.queue.pinnedStudents - (previousSummary.queue?.pinnedStudents || 0),
  };
}

export interface WeeklyBucket {
  label: string;
  start: string | null;
  end: string | null;
  count: number;
}

export function buildWeeklyBuckets(
  packageRows: Array<Record<string, unknown>>,
  dateField: string,
  today: Date,
  numberOfWeeks: number,
): WeeklyBucket[] {
  const buckets: WeeklyBucket[] = [];

  for (let weekIndex = 0; weekIndex < numberOfWeeks; weekIndex++) {
    const bucketStart = new Date(today.getTime() + weekIndex * 7 * DAY_MS);
    const bucketEnd = new Date(bucketStart.getTime() + 7 * DAY_MS);

    buckets.push({
      label: "W" + (weekIndex + 1),
      start: formatDate(bucketStart),
      end: formatDate(new Date(bucketEnd.getTime() - DAY_MS)),
      count: packageRows.filter((row) => {
        const value = row[dateField];
        if (!value) return false;
        const bucketDate = parseDate(value);
        if (!bucketDate) return false;
        return bucketDate >= bucketStart && bucketDate < bucketEnd;
      }).length,
    });
  }

  return buckets;
}

export function buildHistoryPoint(summary: SummaryPayload, now: Date) {
  return {
    generatedAt: formatDateTime(now),
    notify: summary.packages.notify,
    watch: summary.packages.watch,
    ok: summary.packages.ok,
    nodata: summary.packages.nodata,
    exhaustedNow: summary.portfolio.exhaustedNow,
    risk7: summary.portfolio.risk7,
    risk30: summary.portfolio.risk30,
  };
}

export function updateHistory(
  history: DashboardSnapshotState["history"],
  summary: SummaryPayload,
  now: Date,
) {
  return [...(history || []), buildHistoryPoint(summary, now)].slice(-HISTORY_LIMIT);
}

export function buildSnapshotForPersistence(
  summary: SummaryPayload,
  packageRows: PackageRow[],
  now: Date,
): PersistedSnapshotState {
  const packages: Record<string, PersistedSnapshotState["packages"][string]> = {};

  packageRows.forEach((row) => {
    packages[row.key] = {
      status: row.status,
      adjustedRemaining: row.adjustedRemaining,
      priorityScore: row.priorityScore,
    };
  });

  return {
    generatedAt: formatDateTime(now),
    summary,
    packages,
  };
}

export function cloneActionState(actionState: ActionState | null): ActionState | null {
  if (!actionState) return null;
  return {
    status: actionState.status,
    updatedAt: actionState.updatedAt,
    updatedByName: actionState.updatedByName || "",
    isToday: !!actionState.isToday,
  };
}

export function isActionStateToday(updatedAt: string, today: Date) {
  const parsed = parseDate(updatedAt);
  return !!parsed && formatDate(parsed) === formatDate(today);
}
