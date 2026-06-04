// Progress Tests — canonical DTOs and unions shared across phases.
//
// These shapes are the contract later phases (sync, service, API, UI) import.
// Keep field names aligned with the schema (src/lib/db/schema.ts) and the page
// dashboard requirements.

/** Lifecycle state of a single enrollment's current progress-test cycle. */
export type ProgressTestStatus =
  | "accumulating"
  | "approaching"
  | "due"
  | "scheduled"
  | "completed";

/** Mode used to book the progress test into Wise. */
export type ProgressTestBookingMode = "wise" | "manual";

/** One dashboard row: a student's progress within their current cycle for a subject. */
export interface ProgressTestRow {
  enrollmentKey: string;
  wiseStudentId: string;
  wiseClassId: string;
  studentKey: string;
  studentName: string;
  parentName: string;
  subject: string;
  currentCount: number;
  threshold: number;
  cycleIndex: number;
  status: ProgressTestStatus;
  mostFrequentTutorCanonicalKey: string | null;
  mostFrequentTutorDisplayName: string | null;
  teacherNotifiedAt: string | null;
  teacherNotifiedForCycle: number | null;
  bookedTestWiseSessionId: string | null;
  bookedTestDate: string | null;
  bookedTestBookingMode: ProgressTestBookingMode | null;
  lastClassDate: string | null;
  lastAiSummary: ProgressTestAiSummary | null;
  lastAiSummaryAt: string | null;
  updatedByEmail: string | null;
  updatedAt: string | null;
}

/** Counts by lifecycle state for the dashboard summary cards. */
export interface ProgressTestsSummary {
  accumulating: number;
  approaching: number;
  due: number;
  scheduled: number;
  completed: number;
  total: number;
}

/** Full payload returned by the progress-tests list endpoint. */
export interface ProgressTestsPayload {
  rows: ProgressTestRow[];
  summary: ProgressTestsSummary;
  subjects: string[];
  lastSyncedAt: string | null;
  generatedAt: string;
}

/** Structured AI summary of a teacher's recent per-class feedback for the heads-up email. */
export interface ProgressTestAiSummary {
  headline: string;
  strengths: string[];
  focusAreas: string[];
  recommendation: string;
}

/**
 * Result of generating an AI summary. Fail-closed on content: sparse/empty
 * feedback returns `sparse` (no fabrication, no API call); disabled/no-key
 * returns `skipped`; any error returns `failed`. Only `ok` carries a usable
 * summary, the model that produced it, and how many notes were fed in.
 */
export type ProgressTestAiSummaryResult =
  | { status: "ok"; summary: ProgressTestAiSummary; model: string; sessionsUsed: number }
  | { status: "sparse"; reason: string; sessionsUsed: number }
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: string };

/** Minimal authenticated user shape used by the page guard and actions. */
export interface AppSessionUser {
  email: string;
  name: string;
}
