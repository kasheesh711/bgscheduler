import type {
  ActionState,
  CalendarPayload,
  PendingDeductionDetail,
  StudentRecord,
  StudentQueueRow,
  SummaryPayload,
} from "@/types/credit-control";

export interface SheetSnapshot {
  sheetName: string;
  headerRowIndex: number;
  dataRowStartIndex: number;
  cols: Record<string, number>;
  rows: unknown[][];
}

export interface DashboardSources {
  aggregations: SheetSnapshot;
  creditControl: SheetSnapshot;
  upcoming: SheetSnapshot;
  students: SheetSnapshot;
  studentsCourses: SheetSnapshot;
  remainingCredits: SheetSnapshot;
}

export interface AdminOwnership {
  key: string;
  name: string;
  source: string;
}

export interface PendingDeductionContext {
  amountsByKey: Record<string, number>;
  detailsByKey: Record<string, PendingDeductionDetail[]>;
  fallbackKeys: Record<string, boolean>;
  fallbackRows: PendingDeductionDetail[];
}

export interface PackageRow {
  key: string;
  student: string;
  parent: string;
  packageName: string;
  subject: string;
  status: string;
  currentRemaining: number;
  adjustedRemaining: number;
  pendingDeduction: number;
  totalCredits: number;
  alertDate: string | null;
  exhaustDate: string | null;
  daysUntilAlert: number | null;
  daysUntilExhaust: number | null;
  nextSessionDate: string | null;
  upcomingCount: number;
  sessionCadencePerWeek: number;
  averageCreditsPerWeek: number;
  cadenceLabel: string;
  dataQualityFlags: string[];
  recommendedAction: string;
  whyNow: string;
  previousStatus: string | null;
  balanceDelta: number | null;
  statusChange: "new" | "worsened" | "improved" | "stable";
  studentIndex: number;
  packageIndex: number;
  priorityScore: number;
  changeSummary?: string;
}

export interface SnapshotPackageState {
  status: string;
  adjustedRemaining: number;
  priorityScore: number;
}

export interface PersistedSnapshotState {
  generatedAt: string;
  summary: SummaryPayload;
  packages: Record<string, SnapshotPackageState>;
}

export interface DashboardSnapshotState {
  lastSnapshot: PersistedSnapshotState | null;
  history: Array<{
    generatedAt: string;
    notify: number;
    watch: number;
    ok: number;
    nodata: number;
    exhaustedNow: number;
    risk7: number;
    risk30: number;
  }>;
}

export interface DashboardModelResult {
  payload: {
    adminViews: { key: string; label: string }[];
    lastUpdatedAt: string;
    previousUpdatedAt: string | null;
    summary: SummaryPayload;
    studentQueue: StudentQueueRow[];
    calendar: CalendarPayload;
    students: StudentRecord[];
  };
  snapshotState: DashboardSnapshotState;
}

export interface ActionStateMap {
  [studentKey: string]: ActionState | null;
}
