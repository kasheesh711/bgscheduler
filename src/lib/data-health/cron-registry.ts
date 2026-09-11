import { creditControlActive } from "@/lib/credit-control/mode";
import type { CronJobStatus } from "./types";

export type CronJobKey =
  | "classroom_publish_recovery"
  | "room_booking"
  | "classroom_weekend_check"
  | "wise_snapshot"
  | "wise_activity"
  | "sales_dashboard"
  | "unearned_revenue"
  | "credit_control"
  | "progress_tests"
  | "progress_tests_digest"
  | "post_class_feedback"
  | "post_class_feedback_backfill"
  | "post_class_feedback_digest"
  | "post_class_feedback_day_after"
  | "post_class_feedback_deadline"
  | "post_class_feedback_payout_accrual"
  | "leave_requests"
  | "classroom_morning"
  | "classroom_admin_email"
  | "student_promotions_july_1"
  | "admissions_notifications"
  | "cron_watchdog"
  | "room_utilization"
  | "onsite_foot_traffic"
  | "line_backlog_recovery"
  | "line_credit_digest"
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
  paused?: boolean;
  requiresSuccessfulRun?: boolean;
  dangerous: boolean;
  confirmationLabel: string | null;
  expectedBangkokMinute?: number;
  expectedBangkokWeekday?: number;
  expectedBangkokWeekdays?: number[];
  enabledAtEnv?: string;
  expectedBangkokWindowStartMinute?: number;
  expectedBangkokWindowEndMinute?: number;
  routeMethod: "GET" | "POST";
}

export const CRON_JOBS = [
  { key: "classroom_publish_recovery", label: "Classroom Publish Recovery", feature: "Class Assignments",
    path: "/api/internal/class-assignments/publish-recovery", schedule: "1-56/5 * * * *", cadenceLabel: "Every 5 min; resumes queued room publishing",
    cadenceMinutes: 5, lateAfterMinutes: 15, maxDurationSeconds: 300, manualOnly: false,
    dangerous: true, confirmationLabel: "Retries previously requested Wise room publishing with live verification.", routeMethod: "GET" },
  { key: "room_booking", label: "Tutor Room Availability", feature: "Class Assignments",
    path: "/api/internal/room-booking", schedule: "1,5,9,13,17,21,25,29,33,37,41,45,49,53,57 * * * *", cadenceLabel: "Every 4 min; today and tomorrow, 24 hours",
    cadenceMinutes: 4, lateAfterMinutes: 10, maxDurationSeconds: 300, manualOnly: false,
    dangerous: true, confirmationLabel: "Refreshes rooms, releases reservations superseded by Wise classes, and retries tutor notifications.", routeMethod: "GET" },
  {
    key: "classroom_weekend_check",
    label: "Weekend Classroom Check",
    feature: "Class Assignments",
    path: "/api/internal/class-assignments/weekend-check",
    schedule: "0,16,31 2 * * 3-5",
    cadenceLabel: "Wed–Fri 09:00 Bangkok; retries 09:16 / 09:31",
    cadenceMinutes: null,
    lateAfterMinutes: 15,
    maxDurationSeconds: 800,
    manualOnly: false,
    dangerous: true,
    confirmationLabel: "Checks this weekend and may email the configured private recipient. Does not publish rooms or email tutors.",
    expectedBangkokWeekdays: [3, 4, 5],
    expectedBangkokWindowStartMinute: 9 * 60,
    expectedBangkokWindowEndMinute: 9 * 60 + 31,
    enabledAtEnv: "CLASSROOM_WEEKEND_ALERTS_ENABLED_AT",
    routeMethod: "GET",
  },
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
    dangerous: false,
    confirmationLabel: null,
    routeMethod: "GET",
  },
  {
    key: "wise_activity",
    label: "Wise Activity",
    feature: "Wise Audit",
    path: "/api/internal/sync-wise-activity",
    schedule: "2,17,32,47 * * * *",
    cadenceLabel: "Every 15 min",
    cadenceMinutes: 15,
    lateAfterMinutes: 30,
    maxDurationSeconds: 800,
    manualOnly: false,
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
    dangerous: false,
    confirmationLabel: null,
    routeMethod: "GET",
  },
  {
    key: "unearned_revenue",
    label: "Unearned Revenue",
    feature: "Unearned Revenue",
    path: "/api/internal/sync-unearned-revenue",
    schedule: "30 18 * * *",
    cadenceLabel: "Daily 01:30 Bangkok",
    cadenceMinutes: 24 * 60,
    lateAfterMinutes: 90,
    maxDurationSeconds: 800,
    manualOnly: false,
    dangerous: false,
    confirmationLabel: null,
    expectedBangkokMinute: 1 * 60 + 30,
    routeMethod: "GET",
  },
  {
    key: "onsite_foot_traffic",
    label: "Onsite Foot Traffic",
    feature: "Foot Traffic",
    path: "/api/internal/sync-onsite-foot-traffic",
    schedule: "18 18 * * *",
    cadenceLabel: "Daily 01:18 Bangkok",
    cadenceMinutes: 24 * 60,
    lateAfterMinutes: 90,
    maxDurationSeconds: 800,
    manualOnly: false,
    dangerous: false,
    confirmationLabel: null,
    expectedBangkokMinute: 1 * 60 + 18,
    routeMethod: "GET",
  },
  {
    key: "competitor_intelligence",
    label: "Competitor Intelligence",
    feature: "Market Intelligence",
    path: "/api/internal/sync-competitor-intelligence",
    schedule: "28 18 * * 0",
    cadenceLabel: "Weekly Monday 01:28 Bangkok",
    cadenceMinutes: 7 * 24 * 60,
    lateAfterMinutes: 120,
    maxDurationSeconds: 800,
    manualOnly: false,
    dangerous: false,
    confirmationLabel: null,
    expectedBangkokWeekday: 1,
    expectedBangkokMinute: 1 * 60 + 28,
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
    // Mirrors `export const maxDuration = 800` on the route. Health derivation
    // uses this value for stuck detection, so a lower number here reports a
    // legitimate long run as `failing`.
    maxDurationSeconds: 800,
    manualOnly: false,
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
    dangerous: false,
    confirmationLabel: null,
    expectedBangkokMinute: 7 * 60 + 35,
    routeMethod: "GET",
  },
  {
    key: "post_class_feedback",
    label: "Post-class Feedback",
    feature: "Class Feedback",
    path: "/api/internal/sync-post-class-feedback",
    schedule: "13,43 * * * *",
    cadenceLabel: "Every 30 min",
    cadenceMinutes: 30,
    lateAfterMinutes: 45,
    maxDurationSeconds: 800,
    manualOnly: false,
    dangerous: false,
    confirmationLabel: null,
    routeMethod: "GET",
  },
  {
    key: "post_class_feedback_backfill",
    label: "Post-class Feedback Backfill",
    feature: "Class Feedback",
    path: "/api/internal/post-class-feedback-backfill",
    schedule: "23,53 * * * *",
    cadenceLabel: "Every 30 min",
    cadenceMinutes: 30,
    lateAfterMinutes: 45,
    maxDurationSeconds: 800,
    manualOnly: false,
    dangerous: false,
    confirmationLabel: null,
    routeMethod: "GET",
  },
  // Parked: outbound tutor reminders and the admin digest have no Vercel cron
  // entry. They stay registered as manual-only so Data Health never reports
  // them late, while the routes remain runnable from the Data Health job list.
  {
    key: "post_class_feedback_digest",
    label: "Feedback Admin Digest (parked)",
    feature: "Class Feedback",
    path: "/api/internal/post-class-feedback/admin-digest",
    schedule: null,
    cadenceLabel: "Parked \u2014 no cron",
    cadenceMinutes: null,
    lateAfterMinutes: 0,
    maxDurationSeconds: 300,
    manualOnly: true,
    dangerous: true,
    confirmationLabel: "Emails the admin digest. Reminders are parked; only run deliberately.",
    routeMethod: "GET",
  },
  {
    key: "post_class_feedback_day_after",
    label: "Feedback Day-after Reminder (parked)",
    feature: "Class Feedback",
    path: "/api/internal/post-class-feedback/reminder-day-after",
    schedule: null,
    cadenceLabel: "Parked \u2014 no cron",
    cadenceMinutes: null,
    lateAfterMinutes: 0,
    maxDurationSeconds: 800,
    manualOnly: true,
    dangerous: true,
    confirmationLabel: "May email tutors whose post-class feedback is incomplete.",
    routeMethod: "GET",
  },
  {
    key: "post_class_feedback_deadline",
    label: "Feedback Deadline Reminder (parked)",
    feature: "Class Feedback",
    path: "/api/internal/post-class-feedback/reminder-deadline",
    schedule: null,
    cadenceLabel: "Parked \u2014 no cron",
    cadenceMinutes: null,
    lateAfterMinutes: 0,
    maxDurationSeconds: 800,
    manualOnly: true,
    dangerous: true,
    confirmationLabel: "May email tutors whose feedback is due tonight.",
    routeMethod: "GET",
  },
  {
    key: "post_class_feedback_payout_accrual",
    // Re-armed for unattended charging (POST_CLASS_AUTO_APPROVE_ENABLED):
    // each tick sweeps deadline-passed violations to approved, retires rows
    // whose evidence cleared, appends new obligations in accrual mode, and
    // finalizes a window once its settlement lag has passed. With the flag
    // off the sweep approves nothing and the pass only writes rows a human
    // already approved.
    label: "Payout Accrual",
    feature: "Class Feedback",
    path: "/api/internal/post-class-feedback/payout-accrual",
    schedule: "33 * * * *",
    cadenceLabel: "Hourly",
    cadenceMinutes: 60,
    lateAfterMinutes: 90,
    maxDurationSeconds: 800,
    manualOnly: false,
    dangerous: true,
    confirmationLabel: "Appends real payout deductions to the master ledger.",
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
    dangerous: false,
    confirmationLabel: null,
    routeMethod: "GET",
  },
  {
    key: "classroom_morning",
    label: "Next-day Classroom Preparation",
    feature: "Class Assignments",
    path: "/api/internal/class-assignments/morning",
    schedule: "0 10 * * *",
    cadenceLabel: "Daily 17:00 Bangkok · next day's classrooms",
    cadenceMinutes: 24 * 60,
    lateAfterMinutes: 75,
    maxDurationSeconds: 800,
    manualOnly: false,
    dangerous: true,
    confirmationLabel: "Prepares and publishes classrooms for the next seven days, starting tomorrow. Schedule delivery is a separate job.",
    expectedBangkokMinute: 17 * 60,
    routeMethod: "GET",
  },
  {
    key: "classroom_admin_email",
    label: "Next-day Classroom Schedule Delivery",
    feature: "Class Assignments",
    path: "/api/internal/class-assignments/admin-email",
    schedule: "0,16,31,46 12 * * *",
    cadenceLabel: "Daily 19:00 Bangkok · retries until 19:46",
    cadenceMinutes: 24 * 60,
    lateAfterMinutes: 30,
    maxDurationSeconds: 800,
    manualOnly: false,
    dangerous: true,
    confirmationLabel: "Sends or retries tomorrow's tutor schedules and admin classroom summary.",
    expectedBangkokWindowStartMinute: 19 * 60,
    expectedBangkokWindowEndMinute: 19 * 60 + 46,
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
    dangerous: true,
    confirmationLabel: "Applies verified Wise student grade and course promotion writes.",
    expectedBangkokMinute: 5,
    routeMethod: "GET",
  },
  {
    key: "admissions_notifications",
    label: "Admissions Notifications",
    feature: "Admissions",
    path: "/api/internal/admissions-notifications",
    schedule: "12 1 * * *",
    cadenceLabel: "Daily 08:12 Bangkok",
    cadenceMinutes: 24 * 60,
    lateAfterMinutes: 60,
    maxDurationSeconds: 300,
    manualOnly: false,
    dangerous: true,
    confirmationLabel: "Sends deadline reminder emails (and the weekly digest on Sundays) to admissions case members.",
    expectedBangkokMinute: 8 * 60 + 12,
    routeMethod: "GET",
  },
  {
    key: "line_credit_digest",
    label: "LINE Credit Digest",
    feature: "Credit Control",
    path: "/api/internal/line-credit-digest",
    schedule: "3 2 * * *",
    cadenceLabel: "Daily 09:03 Bangkok",
    cadenceMinutes: 24 * 60,
    lateAfterMinutes: 60,
    maxDurationSeconds: 300,
    manualOnly: false,
    dangerous: true,
    confirmationLabel: "Pushes the credit-runout digest to registered LINE staff groups.",
    expectedBangkokMinute: 9 * 60 + 3,
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

/** Physical cron schedules remain registered; expected work follows feature mode. */
export function effectiveCronJob(job: CronJobDefinition): CronJobDefinition {
  if (job.key === "line_credit_digest" && !creditControlActive()) return { ...job, paused: true, cadenceLabel: "Paused while Credit Control is retired" };
  if (job.key === "progress_tests") return { ...job, requiresSuccessfulRun: true, cadenceMinutes: 1440, expectedBangkokMinute: 445, lateAfterMinutes: 90, cadenceLabel: "Daily 07:25 Bangkok; recovery 07:55 / 08:25" };
  if (job.key === "credit_control" && !creditControlActive()) return { ...job, label: "Shared Student Data", feature: "Student Data", requiresSuccessfulRun: true, cadenceMinutes: 1440, expectedBangkokMinute: 380, lateAfterMinutes: 90, cadenceLabel: "Daily 06:20 Bangkok; recovery 06:50 / 07:20" };
  return job;
}
