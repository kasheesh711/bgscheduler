import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  integer,
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
}, (table) => [
  index("fsb_snapshot_idx").on(table.snapshotId),
  index("fsb_weekday_idx").on(table.snapshotId, table.weekday),
  index("fsb_group_idx").on(table.groupId),
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
