import type { CronJobStatus } from "./types";

export type CronJobKey =
  | "wise_snapshot"
  | "wise_activity"
  | "sales_dashboard"
  | "credit_control"
  | "progress_tests"
  | "progress_tests_digest"
  | "leave_requests"
  | "classroom_morning"
  | "classroom_admin_email"
  | "student_promotions_july_1"
  | "cron_watchdog"
  | "room_utilization"
  | "line_backlog_recovery"
  | "competitor_intelligence";

export interface CronJobDefinition {
  key: CronJobKey;
  label: string;
  feature: string;
  path: string;
  schedule: string | null;
  cadenceLabel: string;
  cadenceMinutes: number | null;
  lateAfterMinutes: number;
  maxDurationSeconds: number;
  manualOnly: boolean;
  manualRunSupported: boolean;
  dangerous: boolean;
  confirmationLabel: string | null;
  expectedBangkokMinute?: number;
  expectedBangkokWeekday?: number;
  expectedBangkokWindowStartMinute?: number;
  expectedBangkokWindowEndMinute?: number;
  routeMethod: "GET" | "POST";
}

export const CRON_JOBS = [
  {
    key: "wise_snapshot",
    label: "Wise Snapshot",
    feature: "Tutor Search",
    path: "/api/internal/sync-wise",
    schedule: "*/30 * * * *",
    cadenceLabel: "Every 30 min",
    cadenceMinutes: 30,
    lateAfterMinutes: 45,
    maxDurationSeconds: 800,
    manualOnly: false,
    manualRunSupported: true,
    dangerous: false,
    confirmationLabel: null,
    routeMethod: "GET",
  },
  {
    key: "wise_activity",
    label: "Wise Activity",
    feature: "Wise Audit",
    path: "/api/internal/sync-wise-activity",
    schedule: "5,35 * * * *",
    cadenceLabel: "Every 30 min",
    cadenceMinutes: 30,
    lateAfterMinutes: 45,
    maxDurationSeconds: 800,
    manualOnly: false,
    manualRunSupported: true,
    dangerous: false,
    confirmationLabel: null,
    routeMethod: "GET",
  },
  {
    key: "sales_dashboard",
    label: "Sales Dashboard",
    feature: "Sales Dashboard",
    path: "/api/internal/sync-sales-dashboard",
    schedule: "10,40 * * * *",
    cadenceLabel: "Every 30 min",
    cadenceMinutes: 30,
    lateAfterMinutes: 45,
    maxDurationSeconds: 800,
    manualOnly: false,
    manualRunSupported: true,
    dangerous: false,
    confirmationLabel: null,
    routeMethod: "GET",
  },
  {
    key: "competitor_intelligence",
    label: "Competitor Intelligence",
    feature: "Market Intelligence",
    path: "/api/internal/sync-competitor-intelligence",
    schedule: "25 18 * * 0",
    cadenceLabel: "Weekly Monday 01:25 Bangkok",
    cadenceMinutes: 7 * 24 * 60,
    lateAfterMinutes: 120,
    maxDurationSeconds: 800,
    manualOnly: false,
    manualRunSupported: true,
    dangerous: false,
    confirmationLabel: null,
    expectedBangkokWeekday: 1,
    expectedBangkokMinute: 1 * 60 + 25,
    routeMethod: "GET",
  },
  {
    key: "credit_control",
    label: "Credit Control",
    feature: "Credit Control",
    path: "/api/internal/sync-credit-control",
    schedule: "20,50 * * * *",
    cadenceLabel: "Every 30 min",
    cadenceMinutes: 30,
    lateAfterMinutes: 45,
    maxDurationSeconds: 300,
    manualOnly: false,
    manualRunSupported: true,
    dangerous: false,
    confirmationLabel: null,
    routeMethod: "GET",
  },
  {
    key: "progress_tests",
    label: "Progress Tests",
    feature: "Progress Tests",
    path: "/api/internal/sync-progress-tests",
    schedule: "25,55 * * * *",
    cadenceLabel: "Every 30 min",
    cadenceMinutes: 30,
    lateAfterMinutes: 45,
    maxDurationSeconds: 300,
    manualOnly: false,
    manualRunSupported: false,
    dangerous: false,
    confirmationLabel: null,
    routeMethod: "GET",
  },
  {
    key: "progress_tests_digest",
    label: "Progress Tests Digest",
    feature: "Progress Tests",
    path: "/api/internal/progress-tests/admin-digest",
    schedule: "35 0 * * *",
    cadenceLabel: "Daily 07:35 Bangkok",
    cadenceMinutes: 24 * 60,
    lateAfterMinutes: 60,
    maxDurationSeconds: 300,
    manualOnly: false,
    manualRunSupported: false,
    dangerous: false,
    confirmationLabel: null,
    expectedBangkokMinute: 7 * 60 + 35,
    routeMethod: "GET",
  },
  {
    key: "leave_requests",
    label: "Leave Requests",
    feature: "Leave Requests",
    path: "/api/internal/sync-leave-requests",
    schedule: "15,45 * * * *",
    cadenceLabel: "Every 30 min",
    cadenceMinutes: 30,
    lateAfterMinutes: 45,
    maxDurationSeconds: 800,
    manualOnly: false,
    manualRunSupported: true,
    dangerous: false,
    confirmationLabel: null,
    routeMethod: "GET",
  },
  {
    key: "classroom_morning",
    label: "Classroom Morning",
    feature: "Class Assignments",
    path: "/api/internal/class-assignments/morning",
    schedule: "45 23 * * *",
    cadenceLabel: "Daily 06:45 Bangkok",
    cadenceMinutes: 24 * 60,
    lateAfterMinutes: 75,
    maxDurationSeconds: 800,
    manualOnly: false,
    manualRunSupported: true,
    dangerous: true,
    confirmationLabel: "Runs assignment automation, publishes eligible rooms, and sends tutor schedule emails.",
    expectedBangkokMinute: 6 * 60 + 45,
    routeMethod: "GET",
  },
  {
    key: "classroom_admin_email",
    label: "Admin Classroom Email",
    feature: "Class Assignments",
    path: "/api/internal/class-assignments/admin-email",
    schedule: "0,10,20,30 0 * * *",
    cadenceLabel: "Daily 07:00-07:30 Bangkok",
    cadenceMinutes: 24 * 60,
    lateAfterMinutes: 30,
    maxDurationSeconds: 300,
    manualOnly: false,
    manualRunSupported: true,
    dangerous: true,
    confirmationLabel: "May send or retry the daily admin classroom summary email.",
    expectedBangkokWindowStartMinute: 7 * 60,
    expectedBangkokWindowEndMinute: 7 * 60 + 30,
    routeMethod: "GET",
  },
  {
    key: "student_promotions_july_1",
    label: "Student Promotions July 1",
    feature: "Student Promotions",
    path: "/api/internal/student-promotions/july-1",
    schedule: "5 17 30 6 *",
    cadenceLabel: "July 1, 2026 00:05 Bangkok",
    cadenceMinutes: 365 * 24 * 60,
    lateAfterMinutes: 24 * 60,
    maxDurationSeconds: 800,
    manualOnly: false,
    manualRunSupported: false,
    dangerous: true,
    confirmationLabel: "Applies verified Wise student grade and course promotion writes.",
    expectedBangkokMinute: 5,
    routeMethod: "GET",
  },
  {
    key: "cron_watchdog",
    label: "Cron Watchdog",
    feature: "Data Health",
    path: "/api/internal/cron-watchdog",
    schedule: "7,37 * * * *",
    cadenceLabel: "Every 30 min",
    cadenceMinutes: 30,
    lateAfterMinutes: 45,
    maxDurationSeconds: 300,
    manualOnly: false,
    manualRunSupported: true,
    dangerous: false,
    confirmationLabel: null,
    routeMethod: "GET",
  },
  {
    key: "room_utilization",
    label: "Room Utilization",
    feature: "Room Capacity",
    path: "/api/internal/sync-room-utilization",
    schedule: null,
    cadenceLabel: "Manual only",
    cadenceMinutes: null,
    lateAfterMinutes: 0,
    maxDurationSeconds: 800,
    manualOnly: true,
    manualRunSupported: true,
    dangerous: false,
    confirmationLabel: null,
    routeMethod: "POST",
  },
  {
    key: "line_backlog_recovery",
    label: "LINE Backlog Recovery",
    feature: "LINE Integration",
    path: "/api/internal/line-backlog-recovery",
    schedule: null,
    cadenceLabel: "Manual only",
    cadenceMinutes: null,
    lateAfterMinutes: 0,
    maxDurationSeconds: 300,
    manualOnly: true,
    manualRunSupported: false,
    dangerous: false,
    confirmationLabel: null,
    routeMethod: "GET",
  },
] as const satisfies readonly CronJobDefinition[];

export const SCHEDULED_CRON_JOBS = CRON_JOBS.filter((job) => !job.manualOnly);

export function getCronJobDefinition(key: string): CronJobDefinition | null {
  return CRON_JOBS.find((job) => job.key === key) ?? null;
}

export function statusRank(status: CronJobStatus): number {
  if (status === "failing") return 5;
  if (status === "late") return 4;
  if (status === "running") return 3;
  if (status === "unknown") return 2;
  if (status === "manual-only") return 1;
  return 0;
}
