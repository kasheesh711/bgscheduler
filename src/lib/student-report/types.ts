import type { StudentScheduleModality } from "@/lib/student-schedule/types";

export type KnownSessionBucket = "attended" | "ended-no-credit" | "cancelled" | "upcoming";

/** Known buckets plus fail-closed `other:<verbatim status>` strings. */
export type SessionBucket = KnownSessionBucket | (string & {});

export interface ReportClassRow {
  wiseSessionId: string;
  dateKey: string;
  weekday: string;
  startLabel: string;
  durationMinutes: number;
  classLabel: string;
  modality: StudentScheduleModality;
  teacher: string;
  bucket: SessionBucket;
  creditApplied: number;
  hasFeedback: boolean;
  packageName: string;
  subjectBand: string;
  meetingStatus: string;
}

export interface BucketTotal {
  bucket: SessionBucket;
  sessions: number;
  hours: number;
  credits: number;
}

export type SummaryDimension = "class" | "teacher" | "month" | "modality";

export interface SummaryLine {
  dimension: SummaryDimension;
  key: string;
  sessions: number;
  hours: number;
  credits: number;
}

export interface ReportPackageRow {
  packageName: string;
  subject: string;
  classType: string | null;
  totalCredits: number;
  consumedCredits: number;
  remainingCredits: number;
  availableCredits: number;
  bookedSessions: number;
  excludedReason: string | null;
}

export interface ReportStudent {
  studentKey: string;
  wiseStudentId: string;
  studentName: string;
  parentName: string;
  code: string | null;
  shortName: string;
  activated: boolean;
}

export interface StudentReportSection {
  student: ReportStudent;
  rows: ReportClassRow[];
  bucketTotals: BucketTotal[];
  summaries: SummaryLine[];
  packages: ReportPackageRow[];
  ledger: { entries: number; netCredit: number };
}

export interface ReportWindowMeta {
  fromDateKey: string;
  toDateKey: string;
  startUtc: string;
  endUtc: string;
  label: string;
}

export interface ParentReportPayload {
  meta: {
    snapshotId: string;
    snapshotGeneratedAt: string;
    generatedAt: string;
    window: ReportWindowMeta;
    snapshotFloorDateKey: string;
    snapshotCeilingDateKey: string;
    floorWarning: boolean;
    ceilingWarning: boolean;
  };
  combined: { bucketTotals: BucketTotal[] };
  students: StudentReportSection[];
}

export type ParentReportResult =
  | { status: "ok"; payload: ParentReportPayload }
  | { status: "no-snapshot" }
  | { status: "students-not-found"; missing: string[] };
