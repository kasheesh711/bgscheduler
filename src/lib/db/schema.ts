import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  integer,
  date,
  pgEnum,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

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
});

// ── Auth ────────────────────────────────────────────────────────────────

export const adminUsers = pgTable("admin_users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  name: text("name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("admin_users_email_idx").on(table.email),
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
  uniqueIndex("car_rows_run_session_idx").on(table.runId, table.wiseSessionId),
]);

export const classroomPublishJobs = pgTable("classroom_publish_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull().references(() => classroomAssignmentRuns.id),
  status: classroomPublishJobStatusEnum("status").notNull().default("pending"),
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
