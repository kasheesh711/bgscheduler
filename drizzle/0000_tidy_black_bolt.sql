CREATE TYPE "public"."data_issue_severity" AS ENUM('critical', 'high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."data_issue_type" AS ENUM('alias', 'modality', 'tag', 'completeness', 'conflict_model', 'sync');--> statement-breakpoint
CREATE TYPE "public"."modality" AS ENUM('online', 'onsite', 'both', 'unresolved');--> statement-breakpoint
CREATE TYPE "public"."sync_status" AS ENUM('running', 'success', 'failed');--> statement-breakpoint
CREATE TABLE "admin_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"type" "data_issue_type" NOT NULL,
	"severity" "data_issue_severity" DEFAULT 'high' NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"entity_name" text,
	"message" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dated_leaves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"wise_teacher_id" text NOT NULL,
	"start_time" timestamp with time zone NOT NULL,
	"end_time" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "future_session_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"wise_teacher_id" text NOT NULL,
	"wise_session_id" text NOT NULL,
	"start_time" timestamp with time zone NOT NULL,
	"end_time" timestamp with time zone NOT NULL,
	"weekday" integer NOT NULL,
	"start_minute" integer NOT NULL,
	"end_minute" integer NOT NULL,
	"wise_status" text NOT NULL,
	"is_blocking" boolean DEFAULT true NOT NULL,
	"title" text,
	"session_type" text,
	"location" text
);
--> statement-breakpoint
CREATE TABLE "raw_teacher_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"wise_teacher_id" text NOT NULL,
	"tag_value" text NOT NULL,
	"tag_raw" jsonb
);
--> statement-breakpoint
CREATE TABLE "recurring_availability_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"wise_teacher_id" text NOT NULL,
	"weekday" integer NOT NULL,
	"start_minute" integer NOT NULL,
	"end_minute" integer NOT NULL,
	"modality" "modality" DEFAULT 'unresolved' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "snapshot_stats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"total_wise_teachers" integer DEFAULT 0 NOT NULL,
	"total_identity_groups" integer DEFAULT 0 NOT NULL,
	"resolved_groups" integer DEFAULT 0 NOT NULL,
	"unresolved_groups" integer DEFAULT 0 NOT NULL,
	"total_qualifications" integer DEFAULT 0 NOT NULL,
	"total_availability_windows" integer DEFAULT 0 NOT NULL,
	"total_leaves" integer DEFAULT 0 NOT NULL,
	"total_future_sessions" integer DEFAULT 0 NOT NULL,
	"total_data_issues" integer DEFAULT 0 NOT NULL,
	"issues_by_type" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subject_level_qualifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"curriculum" text NOT NULL,
	"level" text NOT NULL,
	"exam_prep" text,
	"source_tag" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "sync_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"snapshot_id" uuid,
	"promoted_snapshot_id" uuid,
	"teacher_count" integer,
	"error_summary" text,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "tutor_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_key" text NOT NULL,
	"to_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tutor_identity_group_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"wise_teacher_id" text NOT NULL,
	"wise_user_id" text,
	"wise_display_name" text NOT NULL,
	"is_online_variant" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tutor_identity_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"canonical_key" text NOT NULL,
	"display_name" text NOT NULL,
	"supported_modality" "modality" DEFAULT 'unresolved' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tutors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"supported_modes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "data_issues" ADD CONSTRAINT "data_issues_snapshot_id_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dated_leaves" ADD CONSTRAINT "dated_leaves_snapshot_id_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dated_leaves" ADD CONSTRAINT "dated_leaves_group_id_tutor_identity_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."tutor_identity_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "future_session_blocks" ADD CONSTRAINT "future_session_blocks_snapshot_id_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "future_session_blocks" ADD CONSTRAINT "future_session_blocks_group_id_tutor_identity_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."tutor_identity_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_teacher_tags" ADD CONSTRAINT "raw_teacher_tags_snapshot_id_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_teacher_tags" ADD CONSTRAINT "raw_teacher_tags_group_id_tutor_identity_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."tutor_identity_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_availability_windows" ADD CONSTRAINT "recurring_availability_windows_snapshot_id_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_availability_windows" ADD CONSTRAINT "recurring_availability_windows_group_id_tutor_identity_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."tutor_identity_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot_stats" ADD CONSTRAINT "snapshot_stats_snapshot_id_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_level_qualifications" ADD CONSTRAINT "subject_level_qualifications_snapshot_id_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_level_qualifications" ADD CONSTRAINT "subject_level_qualifications_group_id_tutor_identity_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."tutor_identity_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_snapshot_id_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_promoted_snapshot_id_snapshots_id_fk" FOREIGN KEY ("promoted_snapshot_id") REFERENCES "public"."snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tutor_identity_group_members" ADD CONSTRAINT "tutor_identity_group_members_group_id_tutor_identity_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."tutor_identity_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tutor_identity_group_members" ADD CONSTRAINT "tutor_identity_group_members_snapshot_id_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tutor_identity_groups" ADD CONSTRAINT "tutor_identity_groups_snapshot_id_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tutors" ADD CONSTRAINT "tutors_snapshot_id_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tutors" ADD CONSTRAINT "tutors_group_id_tutor_identity_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."tutor_identity_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_users_email_idx" ON "admin_users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "di_snapshot_idx" ON "data_issues" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "di_type_idx" ON "data_issues" USING btree ("snapshot_id","type");--> statement-breakpoint
CREATE INDEX "dl_snapshot_idx" ON "dated_leaves" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "dl_group_idx" ON "dated_leaves" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "fsb_snapshot_idx" ON "future_session_blocks" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "fsb_weekday_idx" ON "future_session_blocks" USING btree ("snapshot_id","weekday");--> statement-breakpoint
CREATE INDEX "fsb_group_idx" ON "future_session_blocks" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "rtt_snapshot_idx" ON "raw_teacher_tags" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "raw_snapshot_idx" ON "recurring_availability_windows" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "raw_weekday_idx" ON "recurring_availability_windows" USING btree ("snapshot_id","weekday");--> statement-breakpoint
CREATE UNIQUE INDEX "ss_snapshot_idx" ON "snapshot_stats" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "slq_snapshot_idx" ON "subject_level_qualifications" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "slq_group_idx" ON "subject_level_qualifications" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tutor_aliases_from_idx" ON "tutor_aliases" USING btree ("from_key");--> statement-breakpoint
CREATE INDEX "tigm_snapshot_idx" ON "tutor_identity_group_members" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "tigm_group_idx" ON "tutor_identity_group_members" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "tig_snapshot_idx" ON "tutor_identity_groups" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "tutors_snapshot_idx" ON "tutors" USING btree ("snapshot_id");