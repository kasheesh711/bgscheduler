export type PackageStatus = "notify" | "watch" | "ok" | "nodata";
export type StudentActionStatus = "contacted" | "pending-callback" | "resolved";
export type AdminViewKey =
  | "all"
  | "palm"
  | "kem"
  | "care"
  | "aya"
  | "petchy"
  | "muk"
  | "unassigned";

export interface AdminViewOption {
  key: AdminViewKey;
  label: string;
}

export interface PendingDeductionDetail {
  key: string;
  rowNumber: number;
  sessionId: string;
  studentName: string;
  packageName: string;
  sessionDate: string;
  sessionDurationMin: number;
  shouldCreditRaw: string | number | null;
  shouldCreditValue: number | null;
  durationDeduction: number;
  deductionCredits: number;
  deductionSource: "Should_Credit" | "session_duration";
  usingFallback: boolean;
}

export interface ProjectionRow {
  date: string;
  dur: number;
  deduct: number;
  bal: number;
  flag: string;
}

export interface SessionRecord {
  date: string;
  durationMin: number;
  deduct: number;
}

export interface CalendarSessionRecord extends SessionRecord {
  packageName: string;
}

export interface PackageRecord {
  key: string;
  student: string;
  parent: string;
  name: string;
  subject: string;
  currentRemaining: number;
  pendingDeduction: number;
  pendingDeductionDetails: PendingDeductionDetail[];
  pendingDeductionUsesFallback: boolean;
  adjustedRemaining: number;
  totalCredits: number;
  alertDate: string | null;
  exhaustDate: string | null;
  daysUntilAlert: number | null;
  daysUntilExhaust: number | null;
  status: PackageStatus;
  projection: ProjectionRow[];
  upcomingSessions: SessionRecord[];
  upcomingCount: number;
  nextSessionDate: string | null;
  totalScheduledCredits: number;
  sessionCadencePerWeek: number;
  averageCreditsPerWeek: number;
  cadenceLabel: string;
  duplicateCount: number;
  priorityScore: number;
  recommendedAction: string;
  whyNow: string;
  statusChange: "new" | "worsened" | "improved" | "stable";
  balanceDelta: number | null;
  dataQualityFlags: string[];
  ruleContext: {
    included: boolean;
    exclusionReason: string | null;
    pendingDeductionApplied: boolean;
    pendingDeductionUsesFallback: boolean;
    projectionStatus: PackageStatus;
  };
}

export interface StudentRecord {
  student: string;
  parent: string;
  packages: PackageRecord[];
  dataQualityFlags: string[];
  adminOwnerKey: AdminViewKey;
  adminOwnerName: string;
  adminOwnershipSource: string;
  studentKey: string;
  actionState: ActionState | null;
}

export interface ActionState {
  status: StudentActionStatus;
  updatedAt: string;
  updatedByName: string;
  isToday: boolean;
}

export interface StudentQueueRow {
  key: string;
  studentKey: string;
  student: string;
  parent: string;
  studentIndex: number;
  adminOwnerKey: AdminViewKey;
  adminOwnerName: string;
  actionState: ActionState | null;
  worstStatus: PackageStatus;
  packageCount: number;
  riskyPackageCount: number;
  totalCurrentRemaining: number;
  totalAdjustedRemaining: number;
  totalPendingDeduction: number;
  totalCredits: number;
  packageNames: string[];
  nextSessionDate: string | null;
  nextSessionPackageName: string | null;
  nextSessionCount: number;
  nextAlertDate: string | null;
  nextExhaustDate: string | null;
  daysUntilAlert: number | null;
  daysUntilExhaust: number | null;
  noFutureSchedule: boolean;
  pinned: boolean;
  includeInQueue: boolean;
  priorityScore: number;
  recommendedAction: string;
  whyNow: string;
  searchText: string;
}

export interface CalendarStudentEntry {
  key: string;
  student: string;
  parent: string;
  studentIndex: number;
  adminOwnerKey: AdminViewKey;
  adminOwnerName: string;
  worstStatus: PackageStatus;
  totalAdjustedRemaining: number;
  totalCurrentRemaining: number;
  priorityScore: number;
  pinned: boolean;
  nextSessionDate: string | null;
  packageCount: number;
  recommendedAction: string;
  whyNow: string;
  searchText: string;
  sessions: CalendarSessionRecord[];
  sessionCount?: number;
  totalMinutes?: number;
  totalDeduction?: number;
  isNextSessionDay?: boolean;
}

export interface CalendarDay {
  date: string;
  totalStudents: number;
  urgentStudents: number;
  watchStudents: number;
  students: CalendarStudentEntry[];
}

export interface CalendarPayload {
  availableStart: string | null;
  availableEnd: string | null;
  days: CalendarDay[];
}

export interface SummaryDeltas {
  packagesNotify: number | null;
  packagesWatch: number | null;
  risk7: number | null;
  risk30: number | null;
  pendingDeductionBacklog: number | null;
  noSchedule: number | null;
  queueStudents: number | null;
  pinnedStudents: number | null;
}

export interface SummaryPayload {
  students: Record<PackageStatus | "total", number>;
  packages: Record<PackageStatus | "total", number>;
  portfolio: {
    exhaustedNow: number;
    risk7: number;
    risk14: number;
    risk30: number;
    noSchedule: number;
    pendingDeductionBacklog: number;
    pendingDeductionPackages: number;
    lowBalanceNoSchedule: number;
    multiRiskStudents: number;
  };
  queue: {
    students: number;
    pinnedStudents: number;
  };
  deltas: SummaryDeltas;
}

export interface DashboardPayload {
  adminViews: AdminViewOption[];
  lastUpdatedAt: string;
  previousUpdatedAt: string | null;
  summary: SummaryPayload;
  studentQueue: StudentQueueRow[];
  /**
   * All active students as queue rows (no `includeInQueue` filter). The default
   * worklist uses `studentQueue` (at-risk only); the client switches to this list
   * when a search term is active so any active student is reachable by search.
   */
  studentQueueAll: StudentQueueRow[];
  calendar: CalendarPayload;
  students: StudentRecord[];
}

export interface SnapshotState {
  generatedAt: string;
  summary: SummaryPayload;
  packages: Record<string, { status: PackageStatus; adjustedRemaining: number; priorityScore: number }>;
}

export interface ActionStateRow {
  student_key: string;
  student_name: string;
  parent_name: string;
  status: string;
  updated_at: string;
  updated_by_email: string;
  updated_by_name: string;
}

export interface ActionLogRow extends Omit<ActionStateRow, "status"> {
  event_id: string;
  status: string | null;
  action_type: "set" | "clear" | "bulk-set" | "bulk-clear";
}

export interface AppSessionUser {
  email: string;
  name: string;
}
