CREATE TABLE "credit_control_admin_ownership" (
	"student_key" text PRIMARY KEY NOT NULL,
	"admin_key" text NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assigned_by_email" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_control_credit_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"wise_credit_history_id" text NOT NULL,
	"wise_student_id" text NOT NULL,
	"wise_class_id" text NOT NULL,
	"package_key" text NOT NULL,
	"credit" double precision DEFAULT 0 NOT NULL,
	"type" text,
	"meeting_status" text,
	"duration_minutes" integer DEFAULT 0 NOT NULL,
	"created_at_wise" timestamp with time zone,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_control_follow_up_log" (
	"event_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_key" text NOT NULL,
	"student_name" text NOT NULL,
	"parent_name" text NOT NULL,
	"action_type" text NOT NULL,
	"status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_email" text NOT NULL,
	"actor_name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_control_follow_up_state" (
	"student_key" text PRIMARY KEY NOT NULL,
	"student_name" text NOT NULL,
	"parent_name" text NOT NULL,
	"status" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_email" text NOT NULL,
	"updated_by_name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_control_inactive_students" (
	"student_key" text PRIMARY KEY NOT NULL,
	"student_name" text NOT NULL,
	"parent_name" text NOT NULL,
	"marked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"marked_by_email" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_control_packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"wise_student_id" text NOT NULL,
	"wise_class_id" text NOT NULL,
	"student_key" text NOT NULL,
	"package_key" text NOT NULL,
	"student_name" text NOT NULL,
	"parent_name" text DEFAULT '' NOT NULL,
	"package_name" text NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"class_type" text,
	"total_credits" double precision DEFAULT 0 NOT NULL,
	"consumed_credits" double precision DEFAULT 0 NOT NULL,
	"remaining_credits" double precision DEFAULT 0 NOT NULL,
	"available_credits" double precision DEFAULT 0 NOT NULL,
	"booked_sessions" double precision DEFAULT 0 NOT NULL,
	"excluded_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_control_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"wise_session_id" text NOT NULL,
	"wise_class_id" text NOT NULL,
	"wise_student_id" text NOT NULL,
	"student_key" text NOT NULL,
	"package_key" text NOT NULL,
	"student_name" text NOT NULL,
	"package_name" text NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"scheduled_start_time" timestamp with time zone NOT NULL,
	"scheduled_end_time" timestamp with time zone,
	"duration_minutes" integer DEFAULT 0 NOT NULL,
	"meeting_status" text NOT NULL,
	"session_kind" text NOT NULL,
	"teacher_feedback" text,
	"credit_applied" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_control_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'wise' NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_control_students" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"wise_student_id" text NOT NULL,
	"student_key" text NOT NULL,
	"student_name" text NOT NULL,
	"parent_name" text DEFAULT '' NOT NULL,
	"email" text,
	"activated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_control_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "sync_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"snapshot_id" uuid,
	"promoted_snapshot_id" uuid,
	"student_count" integer DEFAULT 0 NOT NULL,
	"package_count" integer DEFAULT 0 NOT NULL,
	"session_count" integer DEFAULT 0 NOT NULL,
	"error_summary" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credit_control_credit_history" ADD CONSTRAINT "credit_control_credit_history_snapshot_id_credit_control_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."credit_control_snapshots"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "credit_control_packages" ADD CONSTRAINT "credit_control_packages_snapshot_id_credit_control_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."credit_control_snapshots"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "credit_control_sessions" ADD CONSTRAINT "credit_control_sessions_snapshot_id_credit_control_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."credit_control_snapshots"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "credit_control_students" ADD CONSTRAINT "credit_control_students_snapshot_id_credit_control_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."credit_control_snapshots"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "credit_control_sync_runs" ADD CONSTRAINT "credit_control_sync_runs_snapshot_id_credit_control_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."credit_control_snapshots"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "credit_control_sync_runs" ADD CONSTRAINT "credit_control_sync_runs_promoted_snapshot_id_credit_control_snapshots_id_fk" FOREIGN KEY ("promoted_snapshot_id") REFERENCES "public"."credit_control_snapshots"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "cc_admin_ownership_admin_idx" ON "credit_control_admin_ownership" USING btree ("admin_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "cc_history_snapshot_history_idx" ON "credit_control_credit_history" USING btree ("snapshot_id","wise_credit_history_id","wise_student_id","wise_class_id");
--> statement-breakpoint
CREATE INDEX "cc_history_package_idx" ON "credit_control_credit_history" USING btree ("snapshot_id","package_key");
--> statement-breakpoint
CREATE INDEX "cc_follow_up_log_student_created_idx" ON "credit_control_follow_up_log" USING btree ("student_key","created_at");
--> statement-breakpoint
CREATE INDEX "cc_follow_up_log_created_idx" ON "credit_control_follow_up_log" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX "cc_follow_up_state_updated_at_idx" ON "credit_control_follow_up_state" USING btree ("updated_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "cc_packages_snapshot_pair_idx" ON "credit_control_packages" USING btree ("snapshot_id","wise_class_id","wise_student_id");
--> statement-breakpoint
CREATE INDEX "cc_packages_snapshot_key_idx" ON "credit_control_packages" USING btree ("snapshot_id","package_key");
--> statement-breakpoint
CREATE INDEX "cc_packages_student_key_idx" ON "credit_control_packages" USING btree ("snapshot_id","student_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "cc_sessions_snapshot_session_student_idx" ON "credit_control_sessions" USING btree ("snapshot_id","wise_session_id","wise_student_id");
--> statement-breakpoint
CREATE INDEX "cc_sessions_snapshot_kind_idx" ON "credit_control_sessions" USING btree ("snapshot_id","session_kind");
--> statement-breakpoint
CREATE INDEX "cc_sessions_package_idx" ON "credit_control_sessions" USING btree ("snapshot_id","package_key");
--> statement-breakpoint
CREATE INDEX "cc_sessions_start_idx" ON "credit_control_sessions" USING btree ("snapshot_id","scheduled_start_time");
--> statement-breakpoint
CREATE INDEX "ccs_active_idx" ON "credit_control_snapshots" USING btree ("active");
--> statement-breakpoint
CREATE INDEX "ccs_generated_at_idx" ON "credit_control_snapshots" USING btree ("generated_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "cc_students_snapshot_wise_idx" ON "credit_control_students" USING btree ("snapshot_id","wise_student_id");
--> statement-breakpoint
CREATE INDEX "cc_students_snapshot_key_idx" ON "credit_control_students" USING btree ("snapshot_id","student_key");
--> statement-breakpoint
CREATE INDEX "ccsr_status_idx" ON "credit_control_sync_runs" USING btree ("status");
--> statement-breakpoint
CREATE INDEX "ccsr_started_at_idx" ON "credit_control_sync_runs" USING btree ("started_at");
