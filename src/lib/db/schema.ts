import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  integer,
  date,
  doublePrecision,
  pgEnum,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ── Enums ──────────────────────────────────────────────────────────────

export const syncStatusEnum = pgEnum("sync_status", [
  "running",
  "success",
  "failed",
]);

export const dataIssueTypeEnum = pgEnum("data_issue_type", [
  "alias",
  "modality",
  "tag",
  "completeness",
  "conflict_model",
  "sync",
]);

export const dataIssueSeverityEnum = pgEnum("data_issue_severity", [
  "critical",
  "high",
  "medium",
  "low",
]);

export const modalityEnum = pgEnum("modality", [
  "online",
  "onsite",
  "both",
  "unresolved",
]);

export const classroomRoomCategoryEnum = pgEnum("classroom_room_category", [
  "standard",
  "overflow_only",
  "online_only",
]);

export const classroomAssignmentRunStatusEnum = pgEnum("classroom_assignment_run_status", [
  "completed",
  "published",
  "partial",
  "failed",
]);

export const classroomAssignmentRowStatusEnum = pgEnum("classroom_assignment_row_status", [
  "assigned",
  "needs_review",
  "no_room",
  "remote",
]);

export const classroomPublishStatusEnum = pgEnum("classroom_publish_status", [
  "not_published",
  "skipped",
  "success",
  "failed",
]);

export const classroomPublishJobStatusEnum = pgEnum("classroom_publish_job_status", [
  "pending",
  "running",
  "succeeded",
  "partial",
  "failed",
]);

export const proposalScopeEnum = pgEnum("proposal_scope", [
  "recurring",
  "one_time",
]);

export const proposalStatusEnum = pgEnum("proposal_status", [
  "pending",
  "confirmed",
  "released",
  "expired",
  "auto_resolved",
]);

export const aiSchedulerConversationStatusEnum = pgEnum("ai_scheduler_conversation_status", [
  "active",
  "archived",
]);

export const aiSchedulerMessageRoleEnum = pgEnum("ai_scheduler_message_role", [
  "admin",
  "parent",
  "assistant",
  "system",
]);

export const lineMessageDirectionEnum = pgEnum("line_message_direction", [
  "inbound",
  "outbound",
]);

export const lineSchedulerClassifierCategoryEnum = pgEnum("line_scheduler_classifier_category", [
  "scheduling_request",
  "scheduling_change",
  "non_scheduling",
  "unclear",
]);

export const lineSchedulerReviewStatusEnum = pgEnum("line_scheduler_review_status", [
  "pending_review",
  "approved_sent",
  "accepted_no_send",
  "rejected",
  "dismissed",
]);

export const lineContactStudentLinkStatusEnum = pgEnum("line_contact_student_link_status", [
  "suggested",
  "verified",
  "rejected",
]);

export const salesDashboardSourceStatusEnum = pgEnum("sales_dashboard_source_status", [
  "active",
  "refreshing",
  "finalized",
  "reopened",
  "archived",
]);

// ── Snapshots & Sync ───────────────────────────────────────────────────

export const snapshots = pgTable("snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  active: boolean("active").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const syncRuns = pgTable("sync_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  status: syncStatusEnum("status").notNull().default("running"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  snapshotId: uuid("snapshot_id").references(() => snapshots.id),
  promotedSnapshotId: uuid("promoted_snapshot_id").references(() => snapshots.id),
  teacherCount: integer("teacher_count"),
  errorSummary: text("error_summary"),
  metadata: jsonb("metadata"),
}, (table) => [
  uniqueIndex("sync_runs_single_running_idx")
    .on(table.status)
    .where(sql`${table.status} = 'running'`),
  index("sync_runs_status_started_idx").on(table.status, table.startedAt),
]);

// ── Wise Activity Audit ────────────────────────────────────────────────

export const wiseActivityEvents = pgTable("wise_activity_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: text("event_id").notNull(),
  eventType: text("event_type").notNull().default("unknown"),
  eventName: text("event_name").notNull(),
  eventTimestamp: timestamp("event_timestamp", { withTimezone: true }).notNull(),
  actorWiseUserId: text("actor_wise_user_id"),
  actorName: text("actor_name"),
  actorRole: text("actor_role"),
  classroomId: text("classroom_id"),
  classroomName: text("classroom_name"),
  classroomSubject: text("classroom_subject"),
  sessionId: text("session_id"),
  sessionStartTime: timestamp("session_start_time", { withTimezone: true }),
  sessionEndTime: timestamp("session_end_time", { withTimezone: true }),
  transactionId: text("transaction_id"),
  transactionType: text("transaction_type"),
  transactionStatus: text("transaction_status"),
  transactionAmount: doublePrecision("transaction_amount"),
  transactionCurrency: text("transaction_currency"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  raw: jsonb("raw").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("wise_activity_events_event_id_idx").on(table.eventId),
  index("wise_activity_events_timestamp_idx").on(table.eventTimestamp),
  index("wise_activity_events_type_timestamp_idx").on(table.eventType, table.eventTimestamp),
  index("wise_activity_events_name_timestamp_idx").on(table.eventName, table.eventTimestamp),
  index("wise_activity_events_actor_idx").on(table.actorWiseUserId, table.eventTimestamp),
  index("wise_activity_events_classroom_idx").on(table.classroomId, table.eventTimestamp),
  index("wise_activity_events_session_idx").on(table.sessionId),
  index("wise_activity_events_transaction_idx").on(table.transactionId),
]);

export const wiseActivitySyncRuns = pgTable("wise_activity_sync_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  status: syncStatusEnum("status").notNull().default("running"),
  triggerType: text("trigger_type").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  pagesFetched: integer("pages_fetched").notNull().default(0),
  eventsFetched: integer("events_fetched").notNull().default(0),
  insertedCount: integer("inserted_count").notNull().default(0),
  oldestEventTimestamp: timestamp("oldest_event_timestamp", { withTimezone: true }),
  newestEventTimestamp: timestamp("newest_event_timestamp", { withTimezone: true }),
  errorSummary: text("error_summary"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
}, (table) => [
  uniqueIndex("wise_activity_sync_runs_single_running_idx")
    .on(table.status)
    .where(sql`${table.status} = 'running'`),
  index("wise_activity_sync_runs_status_started_idx").on(table.status, table.startedAt),
]);

// ── Auth ────────────────────────────────────────────────────────────────

export const adminUsers = pgTable("admin_users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  name: text("name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("admin_users_email_idx").on(table.email),
]);

export const googleOAuthTokens = pgTable("google_oauth_tokens", {
  email: text("email").primaryKey(),
  accessTokenCiphertext: text("access_token_ciphertext"),
  refreshTokenCiphertext: text("refresh_token_ciphertext"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  scope: text("scope"),
  tokenType: text("token_type"),
  lastError: text("last_error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Sales Dashboard ────────────────────────────────────────────────────

export const salesDashboardSources = pgTable("sales_dashboard_sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceMonth: date("source_month", { mode: "string" }).notNull(),
  label: text("label").notNull(),
  spreadsheetId: text("spreadsheet_id").notNull(),
  spreadsheetUrl: text("spreadsheet_url").notNull(),
  normalSheetName: text("normal_sheet_name"),
  additionalSheetName: text("additional_sheet_name"),
  status: salesDashboardSourceStatusEnum("status").notNull().default("active"),
  lastSuccessfulImportRunId: uuid("last_successful_import_run_id"),
  lastImportedAt: timestamp("last_imported_at", { withTimezone: true }),
  lastImportError: text("last_import_error"),
  lastNormalRowCount: integer("last_normal_row_count").notNull().default(0),
  lastAdditionalRowCount: integer("last_additional_row_count").notNull().default(0),
  finalizedAt: timestamp("finalized_at", { withTimezone: true }),
  reopenedAt: timestamp("reopened_at", { withTimezone: true }),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  archivedByEmail: text("archived_by_email"),
  statusBeforeArchive: salesDashboardSourceStatusEnum("status_before_archive"),
  connectedEmail: text("connected_email").notNull(),
  createdByEmail: text("created_by_email").notNull(),
  updatedByEmail: text("updated_by_email").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("sds_source_month_active_idx")
    .on(table.sourceMonth)
    .where(sql`${table.archivedAt} IS NULL`),
  index("sds_status_month_idx").on(table.status, table.sourceMonth),
  index("sds_connected_email_idx").on(table.connectedEmail),
]);

export const salesDashboardImportRuns = pgTable("sales_dashboard_import_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceId: uuid("source_id").references(() => salesDashboardSources.id),
  status: syncStatusEnum("status").notNull().default("running"),
  triggerType: text("trigger_type").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  sourceCount: integer("source_count").notNull().default(0),
  normalRowCount: integer("normal_row_count").notNull().default(0),
  additionalRowCount: integer("additional_row_count").notNull().default(0),
  errorSummary: text("error_summary"),
  actorEmail: text("actor_email"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
}, (table) => [
  index("sdir_source_started_idx").on(table.sourceId, table.startedAt),
  index("sdir_status_started_idx").on(table.status, table.startedAt),
  uniqueIndex("sdir_source_single_running_idx")
    .on(table.sourceId)
    .where(sql`${table.status} = 'running' AND ${table.sourceId} IS NOT NULL`),
]);

export const salesDashboardNormalRows = pgTable("sales_dashboard_normal_rows", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceId: uuid("source_id").notNull().references(() => salesDashboardSources.id),
  importRunId: uuid("import_run_id").notNull().references(() => salesDashboardImportRuns.id),
  sourceMonth: date("source_month", { mode: "string" }).notNull(),
  rowNumber: integer("row_number").notNull(),
  studentNickname: text("student_nickname").notNull(),
  program: text("program").notNull().default(""),
  packageHours: text("package_hours").notNull().default(""),
  numberOfStudents: doublePrecision("number_of_students").notNull().default(0),
  paymentAmount: doublePrecision("payment_amount").notNull().default(0),
  salesRepresentative: text("sales_representative").notNull().default(""),
  paymentDate: date("payment_date", { mode: "string" }).notNull(),
  enrollmentType: text("enrollment_type").notNull().default(""),
  programWiseName: text("program_wise_name").notNull().default(""),
  packageHoursClean: text("package_hours_clean").notNull().default(""),
  validUntil: date("valid_until", { mode: "string" }),
  churnStatus: text("churn_status").notNull().default(""),
  raw: jsonb("raw").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("sdnr_run_row_idx").on(table.importRunId, table.rowNumber),
  index("sdnr_source_run_idx").on(table.sourceId, table.importRunId),
  index("sdnr_payment_date_idx").on(table.paymentDate),
  index("sdnr_source_month_idx").on(table.sourceMonth),
]);

export const salesDashboardAdditionalRows = pgTable("sales_dashboard_additional_rows", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceId: uuid("source_id").notNull().references(() => salesDashboardSources.id),
  importRunId: uuid("import_run_id").notNull().references(() => salesDashboardImportRuns.id),
  sourceMonth: date("source_month", { mode: "string" }).notNull(),
  rowNumber: integer("row_number").notNull(),
  studentNickname: text("student_nickname").notNull(),
  salesType: text("sales_type").notNull().default(""),
  packageName: text("package_name").notNull().default(""),
  paymentAmount: doublePrecision("payment_amount").notNull().default(0),
  paymentDate: date("payment_date", { mode: "string" }).notNull(),
  raw: jsonb("raw").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("sdar_run_row_idx").on(table.importRunId, table.rowNumber),
  index("sdar_source_run_idx").on(table.sourceId, table.importRunId),
  index("sdar_payment_date_idx").on(table.paymentDate),
  index("sdar_source_month_idx").on(table.sourceMonth),
]);

export const salesDashboardProjectionSources = pgTable("sales_dashboard_projection_sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  spreadsheetId: text("spreadsheet_id").notNull(),
  spreadsheetUrl: text("spreadsheet_url").notNull(),
  summarySheetName: text("summary_sheet_name").notNull().default("Summary"),
  whatIfSheetName: text("what_if_sheet_name").notNull().default("What_If"),
  calcMultiSheetName: text("calc_multi_sheet_name").notNull().default("Calc_Multi"),
  status: text("status").notNull().default("active"),
  lastSuccessfulImportRunId: uuid("last_successful_import_run_id"),
  lastImportedAt: timestamp("last_imported_at", { withTimezone: true }),
  lastImportError: text("last_import_error"),
  lastProjectionMonthCount: integer("last_projection_month_count").notNull().default(0),
  lastTargetMonthlyRevenue: doublePrecision("last_target_monthly_revenue"),
  connectedEmail: text("connected_email").notNull(),
  createdByEmail: text("created_by_email").notNull(),
  updatedByEmail: text("updated_by_email").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("sdps_single_active_idx")
    .on(table.status)
    .where(sql`${table.status} = 'active'`),
  index("sdps_connected_email_idx").on(table.connectedEmail),
]);

export const salesDashboardProjectionImportRuns = pgTable("sales_dashboard_projection_import_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceId: uuid("source_id").references(() => salesDashboardProjectionSources.id),
  status: syncStatusEnum("status").notNull().default("running"),
  triggerType: text("trigger_type").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  monthRowCount: integer("month_row_count").notNull().default(0),
  targetMonthlyRevenue: doublePrecision("target_monthly_revenue"),
  errorSummary: text("error_summary"),
  actorEmail: text("actor_email"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
}, (table) => [
  index("sdpir_source_started_idx").on(table.sourceId, table.startedAt),
  index("sdpir_status_started_idx").on(table.status, table.startedAt),
  uniqueIndex("sdpir_source_single_running_idx")
    .on(table.sourceId)
    .where(sql`${table.status} = 'running' AND ${table.sourceId} IS NOT NULL`),
]);

export const salesDashboardProjectionMonths = pgTable("sales_dashboard_projection_months", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceId: uuid("source_id").notNull().references(() => salesDashboardProjectionSources.id),
  importRunId: uuid("import_run_id").notNull().references(() => salesDashboardProjectionImportRuns.id),
  scenario: text("scenario").notNull(),
  projectionMonth: date("projection_month", { mode: "string" }).notNull(),
  monthLabel: text("month_label").notNull(),
  monthKind: text("month_kind").notNull().default("forecast"),
  totalNetRevenue: doublePrecision("total_net_revenue").notNull().default(0),
  renewalRevenue: doublePrecision("renewal_revenue").notNull().default(0),
  newStudentRevenue: doublePrecision("new_student_revenue").notNull().default(0),
  trialRevenue: doublePrecision("trial_revenue").notNull().default(0),
  activeStudents: doublePrecision("active_students").notNull().default(0),
  trialBookings: doublePrecision("trial_bookings").notNull().default(0),
  newStudents: doublePrecision("new_students").notNull().default(0),
  packRenewals: doublePrecision("pack_renewals").notNull().default(0),
  renewalHours: doublePrecision("renewal_hours").notNull().default(0),
  newStudentHours: doublePrecision("new_student_hours").notNull().default(0),
  trialHours: doublePrecision("trial_hours").notNull().default(0),
  totalHours: doublePrecision("total_hours").notNull().default(0),
  roomCapacity: doublePrecision("room_capacity").notNull().default(0),
  roomUtilization: doublePrecision("room_utilization").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("sdpm_run_scenario_month_idx").on(table.importRunId, table.scenario, table.projectionMonth),
  index("sdpm_source_run_idx").on(table.sourceId, table.importRunId),
  index("sdpm_month_idx").on(table.projectionMonth),
  index("sdpm_scenario_month_idx").on(table.scenario, table.projectionMonth),
]);

// ── Credit Control ──────────────────────────────────────────────────────

export const creditControlSnapshots = pgTable("credit_control_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  active: boolean("active").notNull().default(false),
  source: text("source").notNull().default("wise"),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("ccs_active_idx").on(table.active),
  index("ccs_generated_at_idx").on(table.generatedAt),
]);

export const creditControlSyncRuns = pgTable("credit_control_sync_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  status: syncStatusEnum("status").notNull().default("running"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  snapshotId: uuid("snapshot_id").references(() => creditControlSnapshots.id),
  promotedSnapshotId: uuid("promoted_snapshot_id").references(() => creditControlSnapshots.id),
  studentCount: integer("student_count").notNull().default(0),
  packageCount: integer("package_count").notNull().default(0),
  sessionCount: integer("session_count").notNull().default(0),
  errorSummary: text("error_summary"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
}, (table) => [
  index("ccsr_status_idx").on(table.status),
  index("ccsr_started_at_idx").on(table.startedAt),
  uniqueIndex("ccsr_single_running_idx")
    .on(table.status)
    .where(sql`${table.status} = 'running'`),
]);

export const creditControlStudents = pgTable("credit_control_students", {
  id: uuid("id").primaryKey().defaultRandom(),
  snapshotId: uuid("snapshot_id").notNull().references(() => creditControlSnapshots.id),
  wiseStudentId: text("wise_student_id").notNull(),
  studentKey: text("student_key").notNull(),
  studentName: text("student_name").notNull(),
  parentName: text("parent_name").notNull().default(""),
  email: text("email"),
  activated: boolean("activated").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("cc_students_snapshot_wise_idx").on(table.snapshotId, table.wiseStudentId),
  index("cc_students_snapshot_key_idx").on(table.snapshotId, table.studentKey),
]);

export const creditControlPackages = pgTable("credit_control_packages", {
  id: uuid("id").primaryKey().defaultRandom(),
  snapshotId: uuid("snapshot_id").notNull().references(() => creditControlSnapshots.id),
  wiseStudentId: text("wise_student_id").notNull(),
  wiseClassId: text("wise_class_id").notNull(),
  studentKey: text("student_key").notNull(),
  packageKey: text("package_key").notNull(),
  studentName: text("student_name").notNull(),
  parentName: text("parent_name").notNull().default(""),
  packageName: text("package_name").notNull(),
  subject: text("subject").notNull().default(""),
  classType: text("class_type"),
  totalCredits: doublePrecision("total_credits").notNull().default(0),
  consumedCredits: doublePrecision("consumed_credits").notNull().default(0),
  remainingCredits: doublePrecision("remaining_credits").notNull().default(0),
  availableCredits: doublePrecision("available_credits").notNull().default(0),
  bookedSessions: doublePrecision("booked_sessions").notNull().default(0),
  excludedReason: text("excluded_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("cc_packages_snapshot_pair_idx").on(table.snapshotId, table.wiseClassId, table.wiseStudentId),
  index("cc_packages_snapshot_key_idx").on(table.snapshotId, table.packageKey),
  index("cc_packages_student_key_idx").on(table.snapshotId, table.studentKey),
]);

export const creditControlSessions = pgTable("credit_control_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  snapshotId: uuid("snapshot_id").notNull().references(() => creditControlSnapshots.id),
  wiseSessionId: text("wise_session_id").notNull(),
  wiseClassId: text("wise_class_id").notNull(),
  wiseStudentId: text("wise_student_id").notNull(),
  studentKey: text("student_key").notNull(),
  packageKey: text("package_key").notNull(),
  studentName: text("student_name").notNull(),
  packageName: text("package_name").notNull(),
  subject: text("subject").notNull().default(""),
  scheduledStartTime: timestamp("scheduled_start_time", { withTimezone: true }).notNull(),
  scheduledEndTime: timestamp("scheduled_end_time", { withTimezone: true }),
  durationMinutes: integer("duration_minutes").notNull().default(0),
  meetingStatus: text("meeting_status").notNull(),
  sessionKind: text("session_kind").notNull(),
  teacherFeedback: text("teacher_feedback"),
  creditApplied: doublePrecision("credit_applied").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("cc_sessions_snapshot_session_student_idx").on(table.snapshotId, table.wiseSessionId, table.wiseStudentId),
  index("cc_sessions_snapshot_kind_idx").on(table.snapshotId, table.sessionKind),
  index("cc_sessions_package_idx").on(table.snapshotId, table.packageKey),
  index("cc_sessions_start_idx").on(table.snapshotId, table.scheduledStartTime),
]);

export const creditControlCreditHistory = pgTable("credit_control_credit_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  snapshotId: uuid("snapshot_id").notNull().references(() => creditControlSnapshots.id),
  wiseCreditHistoryId: text("wise_credit_history_id").notNull(),
  wiseStudentId: text("wise_student_id").notNull(),
  wiseClassId: text("wise_class_id").notNull(),
  packageKey: text("package_key").notNull(),
  credit: doublePrecision("credit").notNull().default(0),
  type: text("type"),
  meetingStatus: text("meeting_status"),
  durationMinutes: integer("duration_minutes").notNull().default(0),
  createdAtWise: timestamp("created_at_wise", { withTimezone: true }),
  raw: jsonb("raw").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("cc_history_snapshot_history_idx").on(table.snapshotId, table.wiseCreditHistoryId, table.wiseStudentId, table.wiseClassId),
  index("cc_history_package_idx").on(table.snapshotId, table.packageKey),
]);

export const creditControlFollowUpState = pgTable("credit_control_follow_up_state", {
  studentKey: text("student_key").primaryKey(),
  studentName: text("student_name").notNull(),
  parentName: text("parent_name").notNull(),
  status: text("status").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedByEmail: text("updated_by_email").notNull(),
  updatedByName: text("updated_by_name").notNull(),
}, (table) => [
  index("cc_follow_up_state_updated_at_idx").on(table.updatedAt),
]);

export const creditControlFollowUpLog = pgTable("credit_control_follow_up_log", {
  eventId: uuid("event_id").primaryKey().defaultRandom(),
  studentKey: text("student_key").notNull(),
  studentName: text("student_name").notNull(),
  parentName: text("parent_name").notNull(),
  actionType: text("action_type").notNull(),
  status: text("status"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  actorEmail: text("actor_email").notNull(),
  actorName: text("actor_name").notNull(),
}, (table) => [
  index("cc_follow_up_log_student_created_idx").on(table.studentKey, table.createdAt),
  index("cc_follow_up_log_created_idx").on(table.createdAt),
]);

export const creditControlInactiveStudents = pgTable("credit_control_inactive_students", {
  studentKey: text("student_key").primaryKey(),
  studentName: text("student_name").notNull(),
  parentName: text("parent_name").notNull(),
  markedAt: timestamp("marked_at", { withTimezone: true }).notNull().defaultNow(),
  markedByEmail: text("marked_by_email").notNull(),
});

export const creditControlAdminOwnership = pgTable("credit_control_admin_ownership", {
  studentKey: text("student_key").primaryKey(),
  adminKey: text("admin_key").notNull(),
  assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  assignedByEmail: text("assigned_by_email").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("cc_admin_ownership_admin_idx").on(table.adminKey),
]);

// ── Tutor Identity ──────────────────────────────────────────────────────

export const tutorIdentityGroups = pgTable("tutor_identity_groups", {
  id: uuid("id").primaryKey().defaultRandom(),
  snapshotId: uuid("snapshot_id").notNull().references(() => snapshots.id),
  canonicalKey: text("canonical_key").notNull(),
  displayName: text("display_name").notNull(),
  supportedModality: modalityEnum("supported_modality").notNull().default("unresolved"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("tig_snapshot_idx").on(table.snapshotId),
]);

export const tutorIdentityGroupMembers = pgTable("tutor_identity_group_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  groupId: uuid("group_id").notNull().references(() => tutorIdentityGroups.id),
  snapshotId: uuid("snapshot_id").notNull().references(() => snapshots.id),
  wiseTeacherId: text("wise_teacher_id").notNull(),
  wiseUserId: text("wise_user_id"),
  wiseDisplayName: text("wise_display_name").notNull(),
  isOnlineVariant: boolean("is_online_variant").notNull().default(false),
}, (table) => [
  index("tigm_snapshot_idx").on(table.snapshotId),
  index("tigm_group_idx").on(table.groupId),
]);

export const tutorAliases = pgTable("tutor_aliases", {
  id: uuid("id").primaryKey().defaultRandom(),
  fromKey: text("from_key").notNull(),
  toKey: text("to_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("tutor_aliases_from_idx").on(table.fromKey),
]);

export const tutors = pgTable("tutors", {
  id: uuid("id").primaryKey().defaultRandom(),
  snapshotId: uuid("snapshot_id").notNull().references(() => snapshots.id),
  groupId: uuid("group_id").notNull().references(() => tutorIdentityGroups.id),
  displayName: text("display_name").notNull(),
  supportedModes: jsonb("supported_modes").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("tutors_snapshot_idx").on(table.snapshotId),
]);

// ── Tags & Qualifications ───────────────────────────────────────────────

export const rawTeacherTags = pgTable("raw_teacher_tags", {
  id: uuid("id").primaryKey().defaultRandom(),
  snapshotId: uuid("snapshot_id").notNull().references(() => snapshots.id),
  groupId: uuid("group_id").notNull().references(() => tutorIdentityGroups.id),
  wiseTeacherId: text("wise_teacher_id").notNull(),
  tagValue: text("tag_value").notNull(),
  tagRaw: jsonb("tag_raw"),
}, (table) => [
  index("rtt_snapshot_idx").on(table.snapshotId),
]);

export const subjectLevelQualifications = pgTable("subject_level_qualifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  snapshotId: uuid("snapshot_id").notNull().references(() => snapshots.id),
  groupId: uuid("group_id").notNull().references(() => tutorIdentityGroups.id),
  subject: text("subject").notNull(),
  curriculum: text("curriculum").notNull(),
  level: text("level").notNull(),
  examPrep: text("exam_prep"),
  sourceTag: text("source_tag").notNull(),
}, (table) => [
  index("slq_snapshot_idx").on(table.snapshotId),
  index("slq_group_idx").on(table.groupId),
]);

// ── Availability ────────────────────────────────────────────────────────

export const recurringAvailabilityWindows = pgTable("recurring_availability_windows", {
  id: uuid("id").primaryKey().defaultRandom(),
  snapshotId: uuid("snapshot_id").notNull().references(() => snapshots.id),
  groupId: uuid("group_id").notNull().references(() => tutorIdentityGroups.id),
  wiseTeacherId: text("wise_teacher_id").notNull(),
  weekday: integer("weekday").notNull(), // 0=Sunday .. 6=Saturday
  startMinute: integer("start_minute").notNull(), // minutes since midnight Asia/Bangkok
  endMinute: integer("end_minute").notNull(),
  modality: modalityEnum("modality").notNull().default("unresolved"),
}, (table) => [
  index("raw_snapshot_idx").on(table.snapshotId),
  index("raw_weekday_idx").on(table.snapshotId, table.weekday),
]);

export const datedLeaves = pgTable("dated_leaves", {
  id: uuid("id").primaryKey().defaultRandom(),
  snapshotId: uuid("snapshot_id").notNull().references(() => snapshots.id),
  groupId: uuid("group_id").notNull().references(() => tutorIdentityGroups.id),
  wiseTeacherId: text("wise_teacher_id").notNull(),
  startTime: timestamp("start_time", { withTimezone: true }).notNull(),
  endTime: timestamp("end_time", { withTimezone: true }).notNull(),
}, (table) => [
  index("dl_snapshot_idx").on(table.snapshotId),
  index("dl_group_idx").on(table.groupId),
]);

export const futureSessionBlocks = pgTable("future_session_blocks", {
  id: uuid("id").primaryKey().defaultRandom(),
  snapshotId: uuid("snapshot_id").notNull().references(() => snapshots.id),
  groupId: uuid("group_id").notNull().references(() => tutorIdentityGroups.id),
  wiseTeacherId: text("wise_teacher_id").notNull(),
  wiseTeacherUserId: text("wise_teacher_user_id"),
  wiseSessionId: text("wise_session_id").notNull(),
  wiseClassId: text("wise_class_id"),
  startTime: timestamp("start_time", { withTimezone: true }).notNull(),
  endTime: timestamp("end_time", { withTimezone: true }).notNull(),
  weekday: integer("weekday").notNull(),
  startMinute: integer("start_minute").notNull(),
  endMinute: integer("end_minute").notNull(),
  wiseStatus: text("wise_status").notNull(),
  isBlocking: boolean("is_blocking").notNull().default(true),
  title: text("title"),
  sessionType: text("session_type"),
  location: text("location"),
  studentName: text("student_name"),
  studentCount: integer("student_count"),
  subject: text("subject"),
  classType: text("class_type"),
  recurrenceId: text("recurrence_id"),
}, (table) => [
  index("fsb_snapshot_idx").on(table.snapshotId),
  index("fsb_weekday_idx").on(table.snapshotId, table.weekday),
  index("fsb_group_idx").on(table.groupId),
]);

// ── Classroom Assignment ────────────────────────────────────────────────

export const classroomRooms = pgTable("classroom_rooms", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  hasTv: boolean("has_tv").notNull().default(false),
  capacity: integer("capacity").notNull(),
  category: classroomRoomCategoryEnum("category").notNull().default("standard"),
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("classroom_rooms_name_idx").on(table.name),
  index("classroom_rooms_active_idx").on(table.active),
]);

export const classroomAssignmentRuns = pgTable("classroom_assignment_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  assignmentDate: date("assignment_date", { mode: "string" }).notNull(),
  snapshotId: uuid("snapshot_id").notNull().references(() => snapshots.id),
  status: classroomAssignmentRunStatusEnum("status").notNull().default("completed"),
  forceReassign: boolean("force_reassign").notNull().default(false),
  sourceRunId: uuid("source_run_id"),
  automationBatchId: uuid("automation_batch_id"),
  reconciliationMode: text("reconciliation_mode"),
  changeSummary: jsonb("change_summary").$type<Record<string, unknown>>().notNull().default({}),
  totalSessions: integer("total_sessions").notNull().default(0),
  assignedCount: integer("assigned_count").notNull().default(0),
  needsReviewCount: integer("needs_review_count").notNull().default(0),
  noRoomCount: integer("no_room_count").notNull().default(0),
  remoteCount: integer("remote_count").notNull().default(0),
  publishedCount: integer("published_count").notNull().default(0),
  failedPublishCount: integer("failed_publish_count").notNull().default(0),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("car_date_idx").on(table.assignmentDate),
  index("car_snapshot_idx").on(table.snapshotId),
  index("car_automation_batch_idx").on(table.automationBatchId),
]);

export const classroomAssignmentRows = pgTable("classroom_assignment_rows", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull().references(() => classroomAssignmentRuns.id),
  snapshotId: uuid("snapshot_id").notNull().references(() => snapshots.id),
  groupId: uuid("group_id").notNull().references(() => tutorIdentityGroups.id),
  tutorDisplayName: text("tutor_display_name").notNull(),
  wiseTeacherId: text("wise_teacher_id").notNull(),
  wiseTeacherUserId: text("wise_teacher_user_id"),
  wiseSessionId: text("wise_session_id").notNull(),
  wiseClassId: text("wise_class_id"),
  startTime: timestamp("start_time", { withTimezone: true }).notNull(),
  endTime: timestamp("end_time", { withTimezone: true }).notNull(),
  weekday: integer("weekday").notNull(),
  startMinute: integer("start_minute").notNull(),
  endMinute: integer("end_minute").notNull(),
  wiseStatus: text("wise_status").notNull(),
  sessionType: text("session_type"),
  currentWiseLocation: text("current_wise_location"),
  studentName: text("student_name"),
  studentCount: integer("student_count"),
  subject: text("subject"),
  classType: text("class_type"),
  title: text("title"),
  minCapacity: integer("min_capacity").notNull(),
  needsTv: boolean("needs_tv").notNull().default(false),
  preferredRoom: text("preferred_room"),
  overrideRoom: text("override_room"),
  assignedRoom: text("assigned_room").notNull(),
  status: classroomAssignmentRowStatusEnum("status").notNull().default("assigned"),
  sourceRowId: uuid("source_row_id"),
  changeType: text("change_type").notNull().default("manual"),
  assignmentFingerprint: text("assignment_fingerprint"),
  warnings: jsonb("warnings").$type<string[]>().notNull().default([]),
  ruleTrace: jsonb("rule_trace").$type<string[]>().notNull().default([]),
  publishStatus: classroomPublishStatusEnum("publish_status").notNull().default("not_published"),
  publishError: text("publish_error"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("car_rows_run_idx").on(table.runId),
  index("car_rows_snapshot_idx").on(table.snapshotId),
  index("car_rows_source_row_idx").on(table.sourceRowId),
  index("car_rows_change_type_idx").on(table.changeType),
  uniqueIndex("car_rows_run_session_idx").on(table.runId, table.wiseSessionId),
]);

// ── Room Utilization Sessions ──────────────────────────────────────────

export const roomUtilizationSessions = pgTable("room_utilization_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  wiseSessionId: text("wise_session_id").notNull(),
  startTime: timestamp("start_time", { withTimezone: true }).notNull(),
  endTime: timestamp("end_time", { withTimezone: true }).notNull(),
  utilizationDate: date("utilization_date", { mode: "string" }).notNull(),
  weekday: integer("weekday").notNull(),
  startMinute: integer("start_minute").notNull(),
  endMinute: integer("end_minute").notNull(),
  wiseStatus: text("wise_status").notNull(),
  sessionType: text("session_type"),
  rawLocation: text("raw_location"),
  normalizedRoomLabel: text("normalized_room_label"),
  studentCount: integer("student_count"),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("rus_wise_session_id_idx").on(table.wiseSessionId),
  index("rus_date_idx").on(table.utilizationDate),
  index("rus_room_date_idx").on(table.normalizedRoomLabel, table.utilizationDate),
]);

export const classroomPublishJobs = pgTable("classroom_publish_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull().references(() => classroomAssignmentRuns.id),
  status: classroomPublishJobStatusEnum("status").notNull().default("pending"),
  targetRowIds: jsonb("target_row_ids").$type<string[] | null>(),
  totalCount: integer("total_count").notNull().default(0),
  eligibleCount: integer("eligible_count").notNull().default(0),
  completedCount: integer("completed_count").notNull().default(0),
  successCount: integer("success_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
  skippedCount: integer("skipped_count").notNull().default(0),
  lastError: text("last_error"),
  createdBy: text("created_by"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("classroom_publish_jobs_run_idx").on(table.runId),
  index("classroom_publish_jobs_status_idx").on(table.status),
]);

export const classroomAutomationEvents = pgTable("classroom_automation_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  automationBatchId: uuid("automation_batch_id").notNull(),
  assignmentRunId: uuid("assignment_run_id").references(() => classroomAssignmentRuns.id),
  assignmentDate: date("assignment_date", { mode: "string" }).notNull(),
  eventType: text("event_type").notNull(),
  wiseSessionId: text("wise_session_id"),
  sourceRowId: uuid("source_row_id"),
  targetRowId: uuid("target_row_id"),
  message: text("message").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("cae_batch_idx").on(table.automationBatchId),
  index("cae_run_idx").on(table.assignmentRunId),
  index("cae_date_idx").on(table.assignmentDate),
  index("cae_type_idx").on(table.eventType),
]);

export const tutorContacts = pgTable("tutor_contacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  canonicalKey: text("canonical_key").notNull(),
  displayName: text("display_name").notNull(),
  onsiteEmail: text("onsite_email"),
  onlineEmail: text("online_email"),
  onsitePhone: text("onsite_phone"),
  onlinePhone: text("online_phone"),
  sourceNames: jsonb("source_names").$type<string[]>().notNull().default([]),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("tutor_contacts_canonical_key_idx").on(table.canonicalKey),
  index("tutor_contacts_active_idx").on(table.active),
]);

export const tutorBusinessProfiles = pgTable("tutor_business_profiles", {
  canonicalKey: text("canonical_key").primaryKey(),
  displayName: text("display_name").notNull(),
  parentSafeSummary: text("parent_safe_summary").notNull().default(""),
  internalNotes: text("internal_notes").notNull().default(""),
  education: jsonb("education").$type<Array<{
    institution: string;
    country?: string;
    program?: string;
    notes?: string;
  }>>().notNull().default([]),
  languages: jsonb("languages").$type<Array<{
    language: string;
    proficiency: string;
    verificationSource?: string;
  }>>().notNull().default([]),
  englishProficiency: text("english_proficiency").notNull().default("unknown"),
  youngLearnerFit: text("young_learner_fit").notNull().default("unknown"),
  youngestComfortableAge: integer("youngest_comfortable_age"),
  youngLearnerNotes: text("young_learner_notes").notNull().default(""),
  teachingStyleTags: jsonb("teaching_style_tags").$type<string[]>().notNull().default([]),
  teachingStyleNotes: text("teaching_style_notes").notNull().default(""),
  strengthTags: jsonb("strength_tags").$type<string[]>().notNull().default([]),
  curriculumExperience: jsonb("curriculum_experience").$type<string[]>().notNull().default([]),
  studentFitNotes: text("student_fit_notes").notNull().default(""),
  doNotUseForNotes: text("do_not_use_for_notes").notNull().default(""),
  verifiedBy: text("verified_by"),
  lastReviewedAt: timestamp("last_reviewed_at", { withTimezone: true }),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("tutor_business_profiles_display_name_idx").on(table.displayName),
  index("tutor_business_profiles_active_idx").on(table.active),
]);

export const classroomScheduleEmailRuns = pgTable("classroom_schedule_email_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  assignmentRunId: uuid("assignment_run_id").notNull().references(() => classroomAssignmentRuns.id),
  status: text("status").notNull().default("pending"),
  subject: text("subject").notNull(),
  createdBy: text("created_by"),
  attemptedCount: integer("attempted_count").notNull().default(0),
  successCount: integer("success_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
  blockedCount: integer("blocked_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("cser_assignment_run_idx").on(table.assignmentRunId),
]);

export const classroomScheduleEmailRecipients = pgTable("classroom_schedule_email_recipients", {
  id: uuid("id").primaryKey().defaultRandom(),
  emailRunId: uuid("email_run_id").notNull().references(() => classroomScheduleEmailRuns.id),
  assignmentRunId: uuid("assignment_run_id").notNull().references(() => classroomAssignmentRuns.id),
  groupId: uuid("group_id").notNull().references(() => tutorIdentityGroups.id),
  canonicalKey: text("canonical_key").notNull(),
  tutorDisplayName: text("tutor_display_name").notNull(),
  recipientEmail: text("recipient_email"),
  status: text("status").notNull().default("pending"),
  resendEmailId: text("resend_email_id"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("cser_recipients_email_run_idx").on(table.emailRunId),
  index("cser_recipients_assignment_run_idx").on(table.assignmentRunId),
  index("cser_recipients_group_idx").on(table.groupId),
]);

export const classroomAdminEmailRuns = pgTable("classroom_admin_email_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  assignmentDate: date("assignment_date", { mode: "string" }).notNull(),
  assignmentRunId: uuid("assignment_run_id").references(() => classroomAssignmentRuns.id),
  status: text("status").notNull().default("pending"),
  subject: text("subject").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  triggerKind: text("trigger_kind").notNull().default("ready"),
  createdBy: text("created_by"),
  attemptedCount: integer("attempted_count").notNull().default(0),
  successCount: integer("success_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("caer_idempotency_idx").on(table.idempotencyKey),
  index("caer_date_idx").on(table.assignmentDate),
  index("caer_assignment_run_idx").on(table.assignmentRunId),
]);

export const classroomAdminEmailRecipients = pgTable("classroom_admin_email_recipients", {
  id: uuid("id").primaryKey().defaultRandom(),
  emailRunId: uuid("email_run_id").notNull().references(() => classroomAdminEmailRuns.id),
  assignmentDate: date("assignment_date", { mode: "string" }).notNull(),
  recipientEmail: text("recipient_email").notNull(),
  status: text("status").notNull().default("pending"),
  providerMessageId: text("provider_message_id"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("caer_recipients_email_run_idx").on(table.emailRunId),
  index("caer_recipients_date_idx").on(table.assignmentDate),
  index("caer_recipients_email_idx").on(table.recipientEmail),
]);

// ── Past Sessions (cross-snapshot capture) ──────────────────────────────
//
// PAST-01 (Phase 7): sessions that were FUTURE in the prior snapshot but
// have dropped out of Wise's FUTURE response and whose startTime is in the
// past are captured into this table by the daily-sync diff-hook.
//
// DEVIATION from project convention: this is the ONLY cross-snapshot table
// (all other data tables are snapshot-scoped via `snapshot_id`). Per D-04,
// `group_canonical_key` denormalizes the stable `tutor_identity_groups.canonical_key`
// so rows survive snapshot rotation — THE cross-snapshot identity anchor
// required by PAST-05. `captured_in_snapshot_id` is nullable (non-FK) because
// snapshots may be pruned in principle without cascading.
//
// Retention: unbounded in v1.1 (admin-scale ~40k rows/year is trivial for Neon).
// Pruning policy deferred to v1.2+ if the table ever exceeds ~1M rows.
//
// Edge case (D-03 discretion): if a later sync observes a captured session as
// retroactively cancelled (via `wise_status` change), the past row stays as
// originally captured. First-observation-wins, no drift detection in v1.1.
export const pastSessionBlocks = pgTable("past_session_blocks", {
  id: uuid("id").primaryKey().defaultRandom(),

  // D-04: cross-snapshot identity anchor. Read path resolves tutor via
  // `tutor_identity_groups.canonical_key` lookup against the active snapshot.
  groupCanonicalKey: text("group_canonical_key").notNull(),

  // D-04: provenance — which snapshot first captured this row. Nullable and
  // intentionally NOT a foreign key (snapshots may be pruned independently).
  capturedInSnapshotId: uuid("captured_in_snapshot_id"),

  // First-observation-wins canonical fields (D-03). Columns mirror
  // futureSessionBlocks minus the snapshot-scoped `snapshotId`/`groupId`.
  wiseTeacherId: text("wise_teacher_id").notNull(),
  wiseSessionId: text("wise_session_id").notNull(),
  startTime: timestamp("start_time", { withTimezone: true }).notNull(),
  endTime: timestamp("end_time", { withTimezone: true }).notNull(),
  weekday: integer("weekday").notNull(),
  startMinute: integer("start_minute").notNull(),
  endMinute: integer("end_minute").notNull(),
  wiseStatus: text("wise_status").notNull(),
  isBlocking: boolean("is_blocking").notNull().default(true),
  title: text("title"),
  sessionType: text("session_type"),
  location: text("location"),
  studentName: text("student_name"),
  subject: text("subject"),
  classType: text("class_type"),
  recurrenceId: text("recurrence_id"),

  // First-observation audit timestamp (D-04; foundation for v1.2 drift-detection).
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // PAST-05 / D-03: idempotency — only one row per Wise session, ever.
  uniqueIndex("psb_wise_session_id_idx").on(table.wiseSessionId),
  // D-06 read-path index: buildCompareTutor queries (group_canonical_key, dateRange).
  index("psb_group_key_start_idx").on(table.groupCanonicalKey, table.startTime),
  // Time-range scans (admin retention queries, v1.2 pruning).
  index("psb_start_time_idx").on(table.startTime),
]);

// ── Admin Proposal Holds ────────────────────────────────────────────────
//
// Local-only admin holds for parent proposals. These rows intentionally do
// not write to Wise; Wise remains the source of truth for actual bookings.
export const proposalBundles = pgTable("proposal_bundles", {
  id: uuid("id").primaryKey().defaultRandom(),
  studentLabel: text("student_label").notNull(),
  notes: text("notes"),
  createdByEmail: text("created_by_email"),
  createdByName: text("created_by_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("proposal_bundles_created_at_idx").on(table.createdAt),
]);

export const proposalItems = pgTable("proposal_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  bundleId: uuid("bundle_id").notNull().references(() => proposalBundles.id),
  tutorGroupId: uuid("tutor_group_id"),
  tutorCanonicalKey: text("tutor_canonical_key").notNull(),
  tutorDisplayName: text("tutor_display_name").notNull(),
  scope: proposalScopeEnum("scope").notNull(),
  weekday: integer("weekday").notNull(),
  proposalDate: date("proposal_date", { mode: "string" }),
  startMinute: integer("start_minute").notNull(),
  endMinute: integer("end_minute").notNull(),
  subject: text("subject"),
  curriculum: text("curriculum"),
  level: text("level"),
  status: proposalStatusEnum("status").notNull().default("pending"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  releasedAt: timestamp("released_at", { withTimezone: true }),
  autoResolvedAt: timestamp("auto_resolved_at", { withTimezone: true }),
  lastActionByEmail: text("last_action_by_email"),
  lastActionByName: text("last_action_by_name"),
  lastActionAt: timestamp("last_action_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("proposal_items_bundle_idx").on(table.bundleId),
  index("proposal_items_active_lookup_idx").on(table.tutorCanonicalKey, table.status, table.weekday),
  index("proposal_items_date_idx").on(table.proposalDate),
]);

// ── AI Scheduler Conversations & Audit ─────────────────────────────────

export const aiSchedulerConversations = pgTable("ai_scheduler_conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull().default("Untitled scheduler chat"),
  status: aiSchedulerConversationStatusEnum("status").notNull().default("active"),
  customerParentName: text("customer_parent_name"),
  customerStudentName: text("customer_student_name"),
  customerContact: text("customer_contact"),
  notes: text("notes").notNull().default(""),
  extractedState: jsonb("extracted_state").$type<Record<string, unknown>>().notNull().default({}),
  createdByEmail: text("created_by_email"),
  createdByName: text("created_by_name"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("ai_scheduler_conversations_status_idx").on(table.status, table.lastMessageAt),
  index("ai_scheduler_conversations_created_by_idx").on(table.createdByEmail, table.lastMessageAt),
  index("ai_scheduler_conversations_last_message_idx").on(table.lastMessageAt),
]);

export const aiSchedulerMessages = pgTable("ai_scheduler_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => aiSchedulerConversations.id, { onDelete: "cascade" }),
  role: aiSchedulerMessageRoleEnum("role").notNull(),
  content: text("content").notNull(),
  structuredPayload: jsonb("structured_payload").$type<Record<string, unknown> | null>(),
  model: text("model"),
  latencyMs: integer("latency_ms"),
  createdByEmail: text("created_by_email"),
  createdByName: text("created_by_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("ai_scheduler_messages_conversation_idx").on(table.conversationId, table.createdAt),
  index("ai_scheduler_messages_created_at_idx").on(table.createdAt),
]);

export const aiSchedulerRuns = pgTable("ai_scheduler_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id").references(() => aiSchedulerConversations.id, { onDelete: "set null" }),
  messageId: uuid("message_id").references(() => aiSchedulerMessages.id, { onDelete: "set null" }),
  createdByEmail: text("created_by_email"),
  status: text("status").notNull(),
  inputPreviewRedacted: text("input_preview_redacted").notNull(),
  model: text("model"),
  latencyMs: integer("latency_ms"),
  schedulerVersion: text("scheduler_version"),
  promptVersion: text("prompt_version"),
  latencyBreakdown: jsonb("latency_breakdown").$type<Record<string, unknown> | null>(),
  parsedPayload: jsonb("parsed_payload").$type<Record<string, unknown> | null>(),
  solverPayload: jsonb("solver_payload").$type<Record<string, unknown> | null>(),
  warnings: jsonb("warnings").$type<string[]>().notNull().default([]),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("ai_scheduler_runs_conversation_idx").on(table.conversationId),
  index("ai_scheduler_runs_message_idx").on(table.messageId),
  index("ai_scheduler_runs_created_at_idx").on(table.createdAt),
  index("ai_scheduler_runs_status_idx").on(table.status),
]);

export const aiSchedulerFeedback = pgTable("ai_scheduler_feedback", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id").references(() => aiSchedulerConversations.id, { onDelete: "set null" }),
  messageId: uuid("message_id").references(() => aiSchedulerMessages.id, { onDelete: "set null" }),
  schedulerRunId: uuid("scheduler_run_id").references(() => aiSchedulerRuns.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  selectedTutorIds: jsonb("selected_tutor_ids").$type<string[]>().notNull().default([]),
  rejectedTutorIds: jsonb("rejected_tutor_ids").$type<string[]>().notNull().default([]),
  editedParentDraft: text("edited_parent_draft"),
  rejectionReason: text("rejection_reason"),
  staffCorrection: text("staff_correction"),
  lineReviewId: uuid("line_review_id").references(() => lineSchedulerReviews.id, { onDelete: "set null" }),
  classifierConfidence: doublePrecision("classifier_confidence"),
  timeToReviewMs: integer("time_to_review_ms"),
  createdByEmail: text("created_by_email"),
  createdByName: text("created_by_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("ai_scheduler_feedback_message_idx").on(table.messageId),
  index("ai_scheduler_feedback_run_idx").on(table.schedulerRunId),
  index("ai_scheduler_feedback_created_at_idx").on(table.createdAt),
  index("ai_scheduler_feedback_action_idx").on(table.action),
  index("ai_scheduler_feedback_line_review_idx").on(table.lineReviewId),
]);

// ── LINE Scheduler Review ───────────────────────────────────────────────

export const lineContacts = pgTable("line_contacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  lineUserId: text("line_user_id").notNull(),
  displayName: text("display_name"),
  pictureUrl: text("picture_url"),
  statusMessage: text("status_message"),
  linkedParentLabel: text("linked_parent_label"),
  linkedStudentLabel: text("linked_student_label"),
  profileRaw: jsonb("profile_raw").$type<Record<string, unknown>>().notNull().default({}),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("line_contacts_user_id_idx").on(table.lineUserId),
  index("line_contacts_last_seen_idx").on(table.lastSeenAt),
]);

export const lineThreads = pgTable("line_threads", {
  id: uuid("id").primaryKey().defaultRandom(),
  contactId: uuid("contact_id").notNull().references(() => lineContacts.id, { onDelete: "cascade" }),
  lineUserId: text("line_user_id").notNull(),
  aiSchedulerConversationId: uuid("ai_scheduler_conversation_id")
    .references(() => aiSchedulerConversations.id, { onDelete: "set null" }),
  status: text("status").notNull().default("active"),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("line_threads_user_id_idx").on(table.lineUserId),
  index("line_threads_conversation_idx").on(table.aiSchedulerConversationId),
  index("line_threads_last_message_idx").on(table.lastMessageAt),
]);

export const lineMessages = pgTable("line_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  threadId: uuid("thread_id").notNull().references(() => lineThreads.id, { onDelete: "cascade" }),
  contactId: uuid("contact_id").notNull().references(() => lineContacts.id, { onDelete: "cascade" }),
  direction: lineMessageDirectionEnum("direction").notNull(),
  lineMessageId: text("line_message_id"),
  webhookEventId: text("webhook_event_id"),
  sourceType: text("source_type").notNull().default("user"),
  messageType: text("message_type").notNull(),
  text: text("text"),
  replyToken: text("reply_token"),
  eventTimestamp: timestamp("event_timestamp", { withTimezone: true }),
  isRedelivery: boolean("is_redelivery").notNull().default(false),
  isRetracted: boolean("is_retracted").notNull().default(false),
  retractedAt: timestamp("retracted_at", { withTimezone: true }),
  classifierCategory: lineSchedulerClassifierCategoryEnum("classifier_category"),
  classifierConfidence: doublePrecision("classifier_confidence"),
  classifierSummary: text("classifier_summary"),
  classifierPayload: jsonb("classifier_payload").$type<Record<string, unknown> | null>(),
  classifiedAt: timestamp("classified_at", { withTimezone: true }),
  classificationReviewedCategory: lineSchedulerClassifierCategoryEnum("classification_reviewed_category"),
  classificationReviewedCorrect: boolean("classification_reviewed_correct"),
  classificationReviewedByEmail: text("classification_reviewed_by_email"),
  classificationReviewedByName: text("classification_reviewed_by_name"),
  classificationReviewedAt: timestamp("classification_reviewed_at", { withTimezone: true }),
  raw: jsonb("raw").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("line_messages_webhook_event_idx").on(table.webhookEventId),
  uniqueIndex("line_messages_line_message_idx").on(table.lineMessageId),
  index("line_messages_thread_created_idx").on(table.threadId, table.createdAt),
  index("line_messages_classifier_idx").on(table.classifierCategory, table.classifiedAt),
  index("line_messages_classification_review_idx").on(table.classificationReviewedCategory, table.classificationReviewedAt),
]);

export const lineContactStudentLinks = pgTable("line_contact_student_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  contactId: uuid("contact_id").notNull().references(() => lineContacts.id, { onDelete: "cascade" }),
  wiseStudentId: text("wise_student_id").notNull(),
  studentKey: text("student_key").notNull(),
  studentName: text("student_name").notNull(),
  parentName: text("parent_name").notNull().default(""),
  status: lineContactStudentLinkStatusEnum("status").notNull().default("suggested"),
  confidence: doublePrecision("confidence"),
  evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull().default({}),
  reviewedByEmail: text("reviewed_by_email"),
  reviewedByName: text("reviewed_by_name"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("line_contact_student_links_contact_student_idx").on(table.contactId, table.studentKey),
  index("line_contact_student_links_contact_status_idx").on(table.contactId, table.status),
  index("line_contact_student_links_student_key_idx").on(table.studentKey),
]);

export const lineSchedulerReviews = pgTable("line_scheduler_reviews", {
  id: uuid("id").primaryKey().defaultRandom(),
  threadId: uuid("thread_id").notNull().references(() => lineThreads.id, { onDelete: "cascade" }),
  contactId: uuid("contact_id").notNull().references(() => lineContacts.id, { onDelete: "cascade" }),
  inboundMessageId: uuid("inbound_message_id")
    .notNull()
    .references(() => lineMessages.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id")
    .references(() => aiSchedulerConversations.id, { onDelete: "set null" }),
  schedulerMessageId: uuid("scheduler_message_id")
    .references(() => aiSchedulerMessages.id, { onDelete: "set null" }),
  schedulerRunId: uuid("scheduler_run_id")
    .references(() => aiSchedulerRuns.id, { onDelete: "set null" }),
  classifierCategory: lineSchedulerClassifierCategoryEnum("classifier_category").notNull(),
  classifierConfidence: doublePrecision("classifier_confidence"),
  classifierSummary: text("classifier_summary"),
  classifierPayload: jsonb("classifier_payload").$type<Record<string, unknown> | null>(),
  status: lineSchedulerReviewStatusEnum("status").notNull().default("pending_review"),
  proposedDraft: text("proposed_draft").notNull().default(""),
  selectedSuggestion: jsonb("selected_suggestion").$type<Record<string, unknown> | null>(),
  finalText: text("final_text"),
  rejectionReason: text("rejection_reason"),
  reasonCategory: text("reason_category"),
  staffCorrection: text("staff_correction"),
  selectedTutorIds: jsonb("selected_tutor_ids").$type<string[]>().notNull().default([]),
  studentLinkOverride: boolean("student_link_override").notNull().default(false),
  verifiedStudentKeys: jsonb("verified_student_keys").$type<string[]>().notNull().default([]),
  sendLineMessageId: text("send_line_message_id"),
  sendResponse: jsonb("send_response").$type<Record<string, unknown> | null>(),
  sendError: text("send_error"),
  reviewedByEmail: text("reviewed_by_email"),
  reviewedByName: text("reviewed_by_name"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("line_scheduler_reviews_inbound_message_idx").on(table.inboundMessageId),
  index("line_scheduler_reviews_status_idx").on(table.status, table.createdAt),
  index("line_scheduler_reviews_conversation_idx").on(table.conversationId),
]);

// ── Data Issues ─────────────────────────────────────────────────────────

export const dataIssues = pgTable("data_issues", {
  id: uuid("id").primaryKey().defaultRandom(),
  snapshotId: uuid("snapshot_id").notNull().references(() => snapshots.id),
  type: dataIssueTypeEnum("type").notNull(),
  severity: dataIssueSeverityEnum("severity").notNull().default("high"),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  entityName: text("entity_name"),
  message: text("message").notNull(),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("di_snapshot_idx").on(table.snapshotId),
  index("di_type_idx").on(table.snapshotId, table.type),
]);

// ── Snapshot Stats ──────────────────────────────────────────────────────

export const snapshotStats = pgTable("snapshot_stats", {
  id: uuid("id").primaryKey().defaultRandom(),
  snapshotId: uuid("snapshot_id").notNull().references(() => snapshots.id),
  totalWiseTeachers: integer("total_wise_teachers").notNull().default(0),
  totalIdentityGroups: integer("total_identity_groups").notNull().default(0),
  resolvedGroups: integer("resolved_groups").notNull().default(0),
  unresolvedGroups: integer("unresolved_groups").notNull().default(0),
  totalQualifications: integer("total_qualifications").notNull().default(0),
  totalAvailabilityWindows: integer("total_availability_windows").notNull().default(0),
  totalLeaves: integer("total_leaves").notNull().default(0),
  totalFutureSessions: integer("total_future_sessions").notNull().default(0),
  totalDataIssues: integer("total_data_issues").notNull().default(0),
  issuesByType: jsonb("issues_by_type").$type<Record<string, number>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("ss_snapshot_idx").on(table.snapshotId),
]);

// ── Room Capacity Forecast Aggregates ──────────────────────────────────
//
// These tables intentionally store only aggregate forecast/model inputs from
// the private BeGifted datasets workspace. Vercel runtime must not read local
// workbook paths such as /Users/kevinhsieh/Developer/BeGifted Datasets.
export const roomCapacityModelRuns = pgTable("room_capacity_model_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceLabel: text("source_label").notNull(),
  sourceFingerprint: text("source_fingerprint").notNull(),
  forecastStart: date("forecast_start", { mode: "string" }).notNull(),
  forecastEnd: date("forecast_end", { mode: "string" }).notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("rcmr_created_at_idx").on(table.createdAt),
  uniqueIndex("rcmr_source_fingerprint_idx").on(table.sourceFingerprint),
]);

export const roomCapacityForecastDrivers = pgTable("room_capacity_forecast_drivers", {
  id: uuid("id").primaryKey().defaultRandom(),
  modelRunId: uuid("model_run_id").notNull().references(() => roomCapacityModelRuns.id),
  scenario: text("scenario").notNull(),
  month: date("month", { mode: "string" }).notNull(),
  leads: doublePrecision("leads").notNull().default(0),
  leadToPaidConversion: doublePrecision("lead_to_paid_conversion").notNull().default(0),
  newPaidStudents: doublePrecision("new_paid_students").notNull().default(0),
  activeBasePriorMonth: doublePrecision("active_base_prior_month").notNull().default(0),
  projectedRevenueThb: doublePrecision("projected_revenue_thb").notNull().default(0),
  uncappedRevenueThb: doublePrecision("uncapped_revenue_thb").notNull().default(0),
  forecastConsumedHours: doublePrecision("forecast_consumed_hours").notNull().default(0),
  scheduledHours: doublePrecision("scheduled_hours").notNull().default(0),
  teacherCapacityHours: doublePrecision("teacher_capacity_hours").notNull().default(0),
  capacityUtilizationPct: doublePrecision("capacity_utilization_pct").notNull().default(0),
  capacityExceeded: boolean("capacity_exceeded").notNull().default(false),
  seasonalityIndex: doublePrecision("seasonality_index").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("rcfd_model_run_idx").on(table.modelRunId),
  index("rcfd_scenario_month_idx").on(table.modelRunId, table.scenario, table.month),
]);

export const roomCapacityDemandMix = pgTable("room_capacity_demand_mix", {
  id: uuid("id").primaryKey().defaultRandom(),
  modelRunId: uuid("model_run_id").notNull().references(() => roomCapacityModelRuns.id),
  weekday: integer("weekday").notNull(),
  startMinute: integer("start_minute").notNull(),
  durationMinutes: integer("duration_minutes").notNull(),
  mode: text("mode").notNull(),
  studentCount: integer("student_count").notNull().default(1),
  subject: text("subject"),
  classType: text("class_type"),
  share: doublePrecision("share").notNull(),
  observedSessions: integer("observed_sessions").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("rcdm_model_run_idx").on(table.modelRunId),
  index("rcdm_weekday_idx").on(table.modelRunId, table.weekday),
]);

export const roomCapacityPackageMix = pgTable("room_capacity_package_mix", {
  id: uuid("id").primaryKey().defaultRandom(),
  modelRunId: uuid("model_run_id").notNull().references(() => roomCapacityModelRuns.id),
  packageHourBucket: text("package_hour_bucket").notNull(),
  packageHours: doublePrecision("package_hours").notNull(),
  averageRevenueThb: doublePrecision("average_revenue_thb").notNull(),
  share: doublePrecision("share").notNull(),
  observedSaleCount: integer("observed_sale_count").notNull().default(0),
  observedStudentCount: doublePrecision("observed_student_count").notNull().default(0),
  sourceLabel: text("source_label").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("rcpm_model_run_idx").on(table.modelRunId),
  index("rcpm_bucket_idx").on(table.modelRunId, table.packageHourBucket),
]);
