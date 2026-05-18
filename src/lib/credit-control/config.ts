import type { AdminViewOption } from "@/types/credit-control";

export const ALERT_THRESHOLD = 2;
export const NOTIFY_WINDOW_DAYS = 30;
export const DAY_MS = 1000 * 60 * 60 * 24;
export const EXCLUDED_PACKAGE_KEYWORDS = ["pretest", "trial"] as const;
export const STATUS_ORDER = { notify: 0, watch: 1, ok: 2, nodata: 3 } as const;
export const UNASSIGNED_ADMIN_KEY = "unassigned" as const;
export const UNASSIGNED_ADMIN_NAME = "Unassigned";
export const DASHBOARD_CACHE_TAG = "dashboard-payload";
export const CREDIT_CONTROL_CACHE_TAG = "credit-control";
export const DASHBOARD_CACHE_REVALIDATE_SECONDS = 60;
export const SHEETS_IN_MEMORY_TTL_MS = 15_000;
export const HISTORY_LIMIT = 12;

export const SHEET_AGGREGATIONS = "Aggregations";
export const SHEET_CREDIT_CONTROL = "Credit_Control";
export const SHEET_UPCOMING = "Upcoming Sessions";
export const SHEET_STUDENTS = "Students";
export const SHEET_STUDENTS_COURSES = "Students & Courses";
export const SHEET_REMAINING_CREDITS = "RemainingCredits";

export const ADMIN_OWNER_REGISTRY = Object.freeze([
  { key: "palm", label: "Palm", fullName: "Chiraya (Palm) Takornkulwut" },
  { key: "kem", label: "Kem", fullName: "Kemjira (Kem) Waritpariya" },
  { key: "care", label: "Care", fullName: "Kittiya (Care) Taweesinprasarn" },
  { key: "aya", label: "Aya", fullName: "Pakwalan (Aya) Singkhorn" },
  { key: "petchy", label: "Petchy", fullName: "Panida (Petchy) Wiya" },
  { key: "muk", label: "Muk", fullName: "Suphitsara (Muk) Manosamrit" },
] as const);

export const DASHBOARD_ACTION_STATE_SHEET = "DashboardActionsState";
export const DASHBOARD_ACTION_LOG_SHEET = "DashboardActionLog";
export const DASHBOARD_ACTION_STATE_HEADERS = [
  "student_key",
  "student_name",
  "parent_name",
  "status",
  "updated_at",
  "updated_by_email",
  "updated_by_name",
] as const;
export const DASHBOARD_ACTION_LOG_HEADERS = [
  "event_id",
  "student_key",
  "student_name",
  "parent_name",
  "status",
  "action_type",
  "updated_at",
  "updated_by_email",
  "updated_by_name",
] as const;

export const INACTIVE_STUDENTS_SHEET = "InactiveStudents";
export const INACTIVE_STUDENTS_HEADERS = [
  "student_key",
  "student_name",
  "parent_name",
  "marked_at",
  "marked_by_email",
  "marked_by_name",
] as const;

export const REQUIRED_COLUMNS = Object.freeze({
  aggregations: [
    "Student Name",
    "Parent Name",
    "Class Subject",
    "Current Remaining Credits",
    "Current Total Credits",
  ],
  creditControl: [
    "Student Name",
    "Package/Program",
    "final_status",
    "teacher_feedback",
    "credits_consumed",
    "session_duration",
    "session_date",
    "Should_Credit",
  ],
  upcoming: [
    "Student Name",
    "Package/Program",
    "Session Status",
    "Session Duration",
    "Scheduled Date",
  ],
  students: [
    "student_name",
    "Remaining Credits",
  ],
  studentsCourses: [
    "Student Name",
    "Student Full Name",
    "Class Subject",
  ],
  remainingCredits: [
    "Student",
    "Admin",
  ],
});

export function getAdminViewOptions(): AdminViewOption[] {
  return [
    { key: "all", label: "All" },
    ...ADMIN_OWNER_REGISTRY.map(({ key, label }) => ({ key, label })),
    { key: UNASSIGNED_ADMIN_KEY, label: "Unassigned" },
  ];
}
