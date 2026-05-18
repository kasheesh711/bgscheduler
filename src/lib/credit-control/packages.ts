import {
  ADMIN_OWNER_REGISTRY,
  ALERT_THRESHOLD,
  EXCLUDED_PACKAGE_KEYWORDS,
  UNASSIGNED_ADMIN_KEY,
  UNASSIGNED_ADMIN_NAME,
} from "@/lib/credit-control/config";
import type {
  AdminViewKey,
  PackageRecord,
  PendingDeductionDetail,
  StudentRecord,
} from "@/types/credit-control";
import {
  buildDashboardStudentKey,
  buildStudentPackageKey,
  formatDate,
  getStatusSortValue,
  normalizeText,
  parseDate,
  parseNumber,
  readTrimmedCell,
  readUpperCell,
  roundToTenth,
  roundToHundredth,
} from "@/lib/credit-control/helpers";
import { computeProjection, worstStatus } from "@/lib/credit-control/projection";
import type { AdminOwnership, PendingDeductionContext, SheetSnapshot } from "@/lib/credit-control/domain";

export function buildActiveStudentSet(studentsSnapshot: SheetSnapshot): Set<string> {
  const activeStudents = new Set<string>();

  studentsSnapshot.rows.forEach((row) => {
    const studentName = readTrimmedCell(row, studentsSnapshot.cols, "student_name");
    const remainingCredits = readUpperCell(row, studentsSnapshot.cols, "Remaining Credits");

    if (!studentName) return;
    if (remainingCredits !== "N/A" && remainingCredits !== "") {
      activeStudents.add(studentName);
    }
  });

  return activeStudents;
}

export function buildExcludedPackageReasons(studentsCoursesSnapshot: SheetSnapshot) {
  const excludedPackageReasons: Record<string, string> = {};

  studentsCoursesSnapshot.rows.forEach((row) => {
    const studentName = readTrimmedCell(row, studentsCoursesSnapshot.cols, "Student Name");
    const className = readTrimmedCell(row, studentsCoursesSnapshot.cols, "Student Full Name");
    const packageName = readTrimmedCell(row, studentsCoursesSnapshot.cols, "Class Subject");
    const exclusionReason = getPackageExclusionReason(className, packageName);

    if (!studentName || !packageName || !exclusionReason) return;
    excludedPackageReasons[buildStudentPackageKey(studentName, packageName)] = exclusionReason;
  });

  return excludedPackageReasons;
}

export function buildStudentAdminOwnershipMap(remainingCreditsSnapshot: SheetSnapshot) {
  const ownershipStats: Record<
    string,
    Record<string, { count: number; firstRowIndex: number; fullName: string }>
  > = {};

  remainingCreditsSnapshot.rows.forEach((row, rowIndex) => {
    const studentName = readTrimmedCell(row, remainingCreditsSnapshot.cols, "Student");
    const adminName = readTrimmedCell(row, remainingCreditsSnapshot.cols, "Admin");

    if (!studentName) return;

    ownershipStats[studentName] ??= {};

    const recognizedAdmin = getRecognizedAdminByName(adminName);
    if (!recognizedAdmin) return;

    ownershipStats[studentName][recognizedAdmin.key] ??= {
      count: 0,
      firstRowIndex: rowIndex,
      fullName: recognizedAdmin.fullName,
    };

    ownershipStats[studentName][recognizedAdmin.key].count += 1;
  });

  return Object.keys(ownershipStats).reduce<Record<string, AdminOwnership>>((map, studentName) => {
    const adminStats = ownershipStats[studentName];
    const winningKey = Object.keys(adminStats).sort((keyA, keyB) => {
      const countDelta = adminStats[keyB].count - adminStats[keyA].count;
      if (countDelta !== 0) return countDelta;
      return adminStats[keyA].firstRowIndex - adminStats[keyB].firstRowIndex;
    })[0];

    if (!winningKey) {
      map[studentName] = createUnassignedAdminOwnership();
      return map;
    }

    map[studentName] = {
      key: winningKey,
      name: adminStats[winningKey].fullName,
      source: "resolved",
    };
    return map;
  }, {});
}

export function getRecognizedAdminByName(adminName: string) {
  const normalizedAdminName = normalizeText(adminName);
  if (!normalizedAdminName) return null;

  return (
    ADMIN_OWNER_REGISTRY.find((admin) => normalizeText(admin.fullName) === normalizedAdminName) ??
    null
  );
}

export function createUnassignedAdminOwnership(): AdminOwnership {
  return {
    key: UNASSIGNED_ADMIN_KEY,
    name: UNASSIGNED_ADMIN_NAME,
    source: "unassigned",
  };
}

export function getStudentAdminOwnership(
  adminOwnershipMap: Record<string, AdminOwnership>,
  studentName: string,
): AdminOwnership {
  const ownership = adminOwnershipMap?.[studentName];
  return ownership
    ? { key: ownership.key, name: ownership.name, source: ownership.source }
    : createUnassignedAdminOwnership();
}

export function getPackageExclusionReason(className: string, packageName: string) {
  const normalizedClassName = normalizeText(className);
  const normalizedPackageName = normalizeText(packageName);

  for (const keyword of EXCLUDED_PACKAGE_KEYWORDS) {
    if (normalizedClassName.includes(keyword) || normalizedPackageName.includes(keyword)) {
      return keyword;
    }
  }

  return null;
}

export function buildPendingDeductionContext(
  creditControlSnapshot: SheetSnapshot,
  activeStudents: Set<string>,
  excludedPackageReasons: Record<string, string>,
  today: Date,
): PendingDeductionContext {
  const pendingDeductionMap: Record<string, number> = {};
  const pendingDetailsByKey: Record<string, PendingDeductionDetail[]> = {};
  const fallbackKeys: Record<string, boolean> = {};
  const fallbackRows: PendingDeductionDetail[] = [];

  creditControlSnapshot.rows.forEach((row, rowIndex) => {
    const studentName = readTrimmedCell(row, creditControlSnapshot.cols, "Student Name");
    const packageName = readTrimmedCell(row, creditControlSnapshot.cols, "Package/Program");
    const sessionDate = parseDate(row[creditControlSnapshot.cols.session_date]);

    if (!studentName || !packageName || !sessionDate) return;
    if (!activeStudents.has(studentName)) return;
    if (isExcludedPackage(studentName, packageName, excludedPackageReasons)) return;
    if (sessionDate > today) return;

    const finalStatus = readUpperCell(row, creditControlSnapshot.cols, "final_status");
    const teacherFeedback = readTrimmedCell(row, creditControlSnapshot.cols, "teacher_feedback");
    const creditsConsumed = parseNumber(row[creditControlSnapshot.cols.credits_consumed]);
    const sessionDuration = parseNumber(row[creditControlSnapshot.cols.session_duration], 60);

    if (!shouldCountAsPendingDeduction(finalStatus, teacherFeedback, creditsConsumed)) return;

    const detail = buildPendingDeductionDetail(
      creditControlSnapshot,
      row,
      rowIndex,
      studentName,
      packageName,
      sessionDate,
      sessionDuration,
    );
    const key = buildStudentPackageKey(studentName, packageName);
    pendingDeductionMap[key] = roundToTenth((pendingDeductionMap[key] ?? 0) + detail.deductionCredits);
    pendingDetailsByKey[key] ??= [];
    pendingDetailsByKey[key].push(detail);

    if (detail.usingFallback) {
      fallbackKeys[key] = true;
      fallbackRows.push(detail);
    }
  });

  return {
    amountsByKey: pendingDeductionMap,
    detailsByKey: pendingDetailsByKey,
    fallbackKeys,
    fallbackRows,
  };
}

export function shouldCountAsPendingDeduction(
  finalStatus: string,
  teacherFeedback: string,
  creditsConsumed: number,
) {
  const normalizedStatus = normalizeText(finalStatus).toUpperCase();
  const normalizedFeedback = normalizeText(teacherFeedback);

  return (
    normalizedStatus === "ENDED" &&
    (normalizedFeedback === "" || normalizedFeedback === "0") &&
    creditsConsumed === 0
  );
}

export function buildPendingDeductionDetail(
  creditControlSnapshot: SheetSnapshot,
  row: unknown[],
  rowIndex: number,
  studentName: string,
  packageName: string,
  sessionDate: Date,
  sessionDuration: number,
): PendingDeductionDetail {
  const cols = creditControlSnapshot.cols;
  const shouldCreditRaw = Object.prototype.hasOwnProperty.call(cols, "Should_Credit")
    ? row[cols.Should_Credit]
    : null;
  const parsedShouldCredit = Number.parseFloat(String(shouldCreditRaw ?? ""));
  const durationDeduction = roundToTenth(sessionDuration / 60);
  const useShouldCredit = Number.isFinite(parsedShouldCredit) && parsedShouldCredit > 0;
  const deductionCredits = useShouldCredit ? roundToTenth(parsedShouldCredit) : durationDeduction;
  const rowNumber = (creditControlSnapshot.dataRowStartIndex || 2) + rowIndex;
  const sessionId = Object.prototype.hasOwnProperty.call(cols, "session_id")
    ? readTrimmedCell(row, cols, "session_id")
    : "";

  return {
    key: buildStudentPackageKey(studentName, packageName),
    rowNumber,
    sessionId,
    studentName,
    packageName,
    sessionDate: formatDate(sessionDate) ?? "",
    sessionDurationMin: sessionDuration,
    shouldCreditRaw: shouldCreditRaw as string | number | null,
    shouldCreditValue: useShouldCredit ? roundToTenth(parsedShouldCredit) : null,
    durationDeduction,
    deductionCredits,
    deductionSource: useShouldCredit ? "Should_Credit" : "session_duration",
    usingFallback: !useShouldCredit,
  };
}

export function buildUpcomingSessionMap(
  upcomingSnapshot: SheetSnapshot,
  activeStudents: Set<string>,
  excludedPackageReasons: Record<string, string>,
  today: Date,
) {
  const upcomingSessionMap: Record<string, Array<{ date: Date; durationMin: number }>> = {};

  upcomingSnapshot.rows.forEach((row) => {
    const studentName = readTrimmedCell(row, upcomingSnapshot.cols, "Student Name");
    const packageName = readTrimmedCell(row, upcomingSnapshot.cols, "Package/Program");
    const scheduledDate = parseDate(row[upcomingSnapshot.cols["Scheduled Date"]]);

    if (!studentName || !packageName || !scheduledDate) return;
    if (!activeStudents.has(studentName)) return;
    if (isExcludedPackage(studentName, packageName, excludedPackageReasons)) return;
    if (scheduledDate <= today) return;

    const sessionStatus = readUpperCell(row, upcomingSnapshot.cols, "Session Status");
    if (sessionStatus !== "UPCOMING") return;

    const sessionDuration = parseNumber(row[upcomingSnapshot.cols["Session Duration"]], 60);
    const key = buildStudentPackageKey(studentName, packageName);
    upcomingSessionMap[key] ??= [];
    upcomingSessionMap[key].push({ date: scheduledDate, durationMin: sessionDuration });
  });

  Object.values(upcomingSessionMap).forEach((sessions) => {
    sessions.sort((a, b) => a.date.getTime() - b.date.getTime());
  });

  return upcomingSessionMap;
}

export function buildDashboardStudents(
  aggregationsSnapshot: SheetSnapshot,
  activeStudents: Set<string>,
  excludedPackageReasons: Record<string, string>,
  pendingDeductionInput: PendingDeductionContext | Record<string, number> | null,
  upcomingSessionMap: Record<string, Array<{ date: Date; durationMin: number }>>,
  today: Date,
  adminOwnershipMap: Record<string, AdminOwnership>,
): StudentRecord[] {
  const studentMap: Record<string, Omit<StudentRecord, "studentKey" | "actionState">> = {};
  const pendingDeductionContext = normalizePendingDeductionInput(pendingDeductionInput);

  aggregationsSnapshot.rows.forEach((row) => {
    const studentName = readTrimmedCell(row, aggregationsSnapshot.cols, "Student Name");
    const parentName = readTrimmedCell(row, aggregationsSnapshot.cols, "Parent Name");
    const packageName = readTrimmedCell(row, aggregationsSnapshot.cols, "Class Subject");

    if (!studentName || !packageName) return;
    if (!activeStudents.has(studentName)) return;
    if (isExcludedPackage(studentName, packageName, excludedPackageReasons)) return;

    const currentRemaining = parseNumber(row[aggregationsSnapshot.cols["Current Remaining Credits"]]);
    const totalCredits = parseNumber(row[aggregationsSnapshot.cols["Current Total Credits"]]);
    const key = buildStudentPackageKey(studentName, packageName);
    const adminOwnership = getStudentAdminOwnership(adminOwnershipMap, studentName);
    const pendingDeduction = roundToTenth(pendingDeductionContext.amountsByKey[key] ?? 0);
    const pendingDeductionDetails = pendingDeductionContext.detailsByKey[key] ?? [];
    const pendingDeductionUsesFallback = !!pendingDeductionContext.fallbackKeys[key];
    const adjustedRemaining = roundToTenth(Math.max(0, currentRemaining - pendingDeduction));
    const sessions = upcomingSessionMap[key] ?? [];
    const projection = computeProjection(adjustedRemaining, sessions, today);

    const packageRecord = createPackageRecord(
      studentName,
      parentName,
      packageName,
      currentRemaining,
      pendingDeduction,
      adjustedRemaining,
      totalCredits,
      sessions,
      projection,
      pendingDeductionDetails,
      pendingDeductionUsesFallback,
    );

    upsertPackageRecord(studentMap, studentName, parentName, packageRecord, adminOwnership);
  });

  return Object.values(studentMap)
    .map((studentRecord) => {
      studentRecord.dataQualityFlags = buildStudentDataQualityFlags(studentRecord);
      studentRecord.packages = studentRecord.packages
        .map((pkg) => finalizePackageRecord(pkg, studentRecord))
        .sort(comparePackages);

      return {
        ...studentRecord,
        studentKey: buildDashboardStudentKey(studentRecord.student, studentRecord.parent),
        actionState: null,
      };
    })
    .sort(compareStudents);
}

function createPackageRecord(
  studentName: string,
  parentName: string,
  packageName: string,
  currentRemaining: number,
  pendingDeduction: number,
  adjustedRemaining: number,
  totalCredits: number,
  sessions: Array<{ date: Date; durationMin: number }>,
  projection: ReturnType<typeof computeProjection>,
  pendingDeductionDetails: PendingDeductionDetail[],
  pendingDeductionUsesFallback: boolean,
): PackageRecord {
  const cadence = computeSessionCadence(sessions);

  return {
    key: buildStudentPackageKey(studentName, packageName),
    student: studentName,
    parent: parentName,
    name: packageName,
    subject: packageName,
    currentRemaining,
    pendingDeduction,
    pendingDeductionDetails: pendingDeductionDetails ?? [],
    pendingDeductionUsesFallback: !!pendingDeductionUsesFallback,
    adjustedRemaining,
    totalCredits,
    alertDate: projection.alertDate,
    exhaustDate: projection.exhaustDate,
    daysUntilAlert: projection.daysUntilAlert,
    daysUntilExhaust: projection.daysUntilExhaust,
    status: projection.status,
    projection: projection.rows,
    upcomingSessions: sessions.map((session) => ({
      date: formatDate(session.date) ?? "",
      durationMin: session.durationMin,
      deduct: roundToHundredth(session.durationMin / 60),
    })),
    upcomingCount: sessions.length,
    nextSessionDate: sessions.length ? formatDate(sessions[0].date) : null,
    totalScheduledCredits: cadence.totalScheduledCredits,
    sessionCadencePerWeek: cadence.sessionCadencePerWeek,
    averageCreditsPerWeek: cadence.averageCreditsPerWeek,
    cadenceLabel: cadence.cadenceLabel,
    duplicateCount: 1,
    priorityScore: 0,
    recommendedAction: "",
    whyNow: "",
    statusChange: "new",
    balanceDelta: null,
    dataQualityFlags: [],
    ruleContext: {
      included: true,
      exclusionReason: null,
      pendingDeductionApplied: pendingDeduction > 0,
      pendingDeductionUsesFallback: !!pendingDeductionUsesFallback,
      projectionStatus: projection.status,
    },
  };
}

function finalizePackageRecord(
  packageRecord: PackageRecord,
  studentRecord: Omit<StudentRecord, "studentKey" | "actionState">,
): PackageRecord {
  const dataQualityFlags = buildPackageDataQualityFlags(packageRecord, studentRecord);
  return {
    ...packageRecord,
    dataQualityFlags,
    recommendedAction: getRecommendedAction(packageRecord, dataQualityFlags),
    whyNow: getActionReason(packageRecord, dataQualityFlags),
  };
}

function buildStudentDataQualityFlags(studentRecord: Omit<StudentRecord, "studentKey" | "actionState">) {
  const flags: string[] = [];

  if (!studentRecord.parent) {
    flags.push("missing-parent");
  }
  if (studentRecord.packages.some((pkg) => pkg.duplicateCount > 1)) {
    flags.push("duplicate-source-rows");
  }

  return flags;
}

function buildPackageDataQualityFlags(
  packageRecord: PackageRecord,
  studentRecord: Omit<StudentRecord, "studentKey" | "actionState">,
) {
  const flags: string[] = [];

  if (!studentRecord.parent) flags.push("missing-parent");
  if (!packageRecord.upcomingCount) flags.push("no-upcoming-sessions");
  if (packageRecord.pendingDeduction > 0) flags.push("pending-deduction");
  if (packageRecord.pendingDeductionUsesFallback) flags.push("pending-deduction-fallback");
  if (packageRecord.duplicateCount > 1) flags.push("duplicate-source-rows");
  if (packageRecord.adjustedRemaining < ALERT_THRESHOLD && !packageRecord.upcomingCount) {
    flags.push("low-balance-no-schedule");
  }
  if (packageRecord.adjustedRemaining <= 0) {
    flags.push("exhausted-now");
  }

  return flags;
}

function computeSessionCadence(sessions: Array<{ date: Date; durationMin: number }>) {
  if (!sessions.length) {
    return {
      totalScheduledCredits: 0,
      sessionCadencePerWeek: 0,
      averageCreditsPerWeek: 0,
      cadenceLabel: "No schedule",
    };
  }

  const totalScheduledCredits = roundToTenth(
    sessions.reduce((sum, session) => sum + session.durationMin / 60, 0),
  );
  const firstDate = sessions[0].date;
  const lastDate = sessions[sessions.length - 1].date;
  const spanDays = Math.max(7, Math.round((lastDate.getTime() - firstDate.getTime()) / 86_400_000) + 7);
  const spanWeeks = spanDays / 7;
  const sessionsPerWeek = roundToTenth(sessions.length / spanWeeks);
  const creditsPerWeek = roundToTenth(totalScheduledCredits / spanWeeks);

  return {
    totalScheduledCredits,
    sessionCadencePerWeek: sessionsPerWeek,
    averageCreditsPerWeek: creditsPerWeek,
    cadenceLabel: getCadenceLabel(sessionsPerWeek),
  };
}

function getCadenceLabel(sessionsPerWeek: number) {
  if (sessionsPerWeek <= 0) return "No schedule";
  if (sessionsPerWeek < 1) return "Light";
  if (sessionsPerWeek < 2) return "Steady";
  return "Intense";
}

function getRecommendedAction(packageRecord: PackageRecord, dataQualityFlags: string[]) {
  if (packageRecord.adjustedRemaining <= 0) return "Renew immediately";
  if (packageRecord.status === "notify") return "Contact parent today";
  if (
    packageRecord.status === "watch" &&
    packageRecord.daysUntilAlert !== null &&
    packageRecord.daysUntilAlert <= 7
  ) {
    return "Prepare outreach this week";
  }
  if (dataQualityFlags.includes("low-balance-no-schedule")) return "Check schedule before outreach";
  if (packageRecord.pendingDeduction > 0) return "Confirm pending teacher feedback";
  if (packageRecord.status === "watch") return "Queue renewal follow-up";
  if (packageRecord.status === "nodata") return "Verify future sessions";
  return "Monitor";
}

function getActionReason(packageRecord: PackageRecord, dataQualityFlags: string[]) {
  if (packageRecord.adjustedRemaining <= 0) {
    return "The package has no credits left after pending deductions.";
  }
  if (packageRecord.status === "notify") {
    return "Actual balance is already below the two-credit alert threshold.";
  }
  if (packageRecord.status === "watch" && packageRecord.alertDate) {
    return `Projection drops below two credits on ${packageRecord.alertDate}.`;
  }
  if (dataQualityFlags.includes("low-balance-no-schedule")) {
    return "Balance is already low, but the student has no upcoming sessions to project from.";
  }
  if (packageRecord.pendingDeduction > 0) {
    return "Pending deductions mean the source balance is currently understated.";
  }
  if (!packageRecord.upcomingCount) {
    return "No upcoming sessions are scheduled, so projected depletion is uncertain.";
  }
  return "Balance is healthy for now, but still visible in the monitoring queue.";
}

function upsertPackageRecord(
  studentMap: Record<string, Omit<StudentRecord, "studentKey" | "actionState">>,
  studentName: string,
  parentName: string,
  packageRecord: PackageRecord,
  adminOwnership: AdminOwnership,
) {
  if (!studentMap[studentName]) {
    studentMap[studentName] = {
      student: studentName,
      parent: parentName,
      packages: [],
      dataQualityFlags: [],
      adminOwnerKey: adminOwnership?.key as AdminViewKey,
      adminOwnerName: adminOwnership?.name ?? UNASSIGNED_ADMIN_NAME,
      adminOwnershipSource: adminOwnership?.source ?? "unassigned",
    };
  }

  if (!studentMap[studentName].parent && parentName) {
    studentMap[studentName].parent = parentName;
  }

  if (
    adminOwnership &&
    (!studentMap[studentName].adminOwnerKey ||
      (studentMap[studentName].adminOwnershipSource === "unassigned" &&
        adminOwnership.source === "resolved"))
  ) {
    studentMap[studentName].adminOwnerKey = adminOwnership.key as AdminViewKey;
    studentMap[studentName].adminOwnerName = adminOwnership.name;
    studentMap[studentName].adminOwnershipSource = adminOwnership.source;
  }

  const existingIndex = studentMap[studentName].packages.findIndex(
    (existingPackage) => existingPackage.name === packageRecord.name,
  );

  if (existingIndex === -1) {
    studentMap[studentName].packages.push(packageRecord);
    return;
  }

  const existingPackage = studentMap[studentName].packages[existingIndex];
  const duplicateCount = (existingPackage.duplicateCount || 1) + 1;
  const winner =
    packageRecord.totalCredits > existingPackage.totalCredits ? packageRecord : existingPackage;

  winner.duplicateCount = duplicateCount;
  studentMap[studentName].packages[existingIndex] = winner;
}

export function compareStudents(a: StudentRecord, b: StudentRecord) {
  return getStatusSortValue(worstStatus(a.packages)) - getStatusSortValue(worstStatus(b.packages));
}

export function normalizePendingDeductionInput(
  pendingDeductionInput: PendingDeductionContext | Record<string, number> | null,
): PendingDeductionContext {
  if (!pendingDeductionInput) {
    return {
      amountsByKey: {},
      detailsByKey: {},
      fallbackKeys: {},
      fallbackRows: [],
    };
  }

  if (isPendingDeductionContext(pendingDeductionInput)) {
    return pendingDeductionInput;
  }

  return {
    amountsByKey: pendingDeductionInput,
    detailsByKey: {},
    fallbackKeys: {},
    fallbackRows: [],
  };
}

function isPendingDeductionContext(
  value: PendingDeductionContext | Record<string, number>,
): value is PendingDeductionContext {
  return (
    Object.prototype.hasOwnProperty.call(value, "amountsByKey") &&
    Object.prototype.hasOwnProperty.call(value, "detailsByKey") &&
    Object.prototype.hasOwnProperty.call(value, "fallbackKeys") &&
    Object.prototype.hasOwnProperty.call(value, "fallbackRows")
  );
}

export function comparePackages(a: PackageRecord, b: PackageRecord) {
  const statusDelta = getStatusSortValue(a.status) - getStatusSortValue(b.status);
  if (statusDelta !== 0) return statusDelta;

  const scoreDelta = (b.priorityScore || 0) - (a.priorityScore || 0);
  if (scoreDelta !== 0) return scoreDelta;

  const dayA = a.daysUntilAlert === null ? Number.POSITIVE_INFINITY : a.daysUntilAlert;
  const dayB = b.daysUntilAlert === null ? Number.POSITIVE_INFINITY : b.daysUntilAlert;
  if (dayA !== dayB) return dayA - dayB;

  return a.name.localeCompare(b.name);
}

export function isExcludedPackage(
  studentName: string,
  packageName: string,
  excludedPackageReasons: Record<string, string>,
) {
  return Object.prototype.hasOwnProperty.call(
    excludedPackageReasons,
    buildStudentPackageKey(studentName, packageName),
  );
}
