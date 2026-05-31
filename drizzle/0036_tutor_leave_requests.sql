CREATE TYPE "public"."leave_request_workflow_status" AS ENUM('new', 'needs_review', 'in_progress', 'done', 'ignored', 'canceled_by_tutor');--> statement-breakpoint
CREATE TYPE "public"."leave_request_sheet_write_status" AS ENUM('not_required', 'pending', 'success', 'failed');--> statement-breakpoint
CREATE TABLE "leave_request_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "sync_status" DEFAULT 'running' NOT NULL,
	"trigger_type" text NOT NULL,
	"actor_email" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"scanned_row_count" integer DEFAULT 0 NOT NULL,
	"inserted_count" integer DEFAULT 0 NOT NULL,
	"updated_count" integer DEFAULT 0 NOT NULL,
	"notification_count" integer DEFAULT 0 NOT NULL,
	"error_summary" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leave_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"spreadsheet_id" text NOT NULL,
	"sheet_name" text NOT NULL,
	"source_row_number" integer NOT NULL,
	"source_fingerprint" text NOT NULL,
	"source_submitted_at" timestamp with time zone,
	"tutor_name" text NOT NULL,
	"tutor_email" text,
	"start_date" date,
	"end_date" date,
	"time_period" text,
	"specific_time_text" text,
	"leave_start_time" timestamp with time zone,
	"leave_end_time" timestamp with time zone,
	"start_minute" integer,
	"end_minute" integer,
	"normalization_status" text DEFAULT 'ok' NOT NULL,
	"normalization_error" text,
	"reported_has_classes" text,
	"reported_affected_classes" text,
	"makeup_options" text,
	"reason" text,
	"certificate_url" text,
	"situation_text" text,
	"policy_agreement" text,
	"days_notice" integer,
	"late_notice" text,
	"admin_fee" integer,
	"emergency_used" integer,
	"source_sheet_status" text,
	"workflow_status" "leave_request_workflow_status" DEFAULT 'new' NOT NULL,
	"staff_note" text,
	"unread" boolean DEFAULT true NOT NULL,
	"sheet_write_status" "leave_request_sheet_write_status" DEFAULT 'not_required' NOT NULL,
	"sheet_write_error" text,
	"sheet_written_at" timestamp with time zone,
	"tutor_group_id" uuid,
	"tutor_canonical_key" text,
	"tutor_display_name" text,
	"match_confidence" text DEFAULT 'unmatched' NOT NULL,
	"match_reason" text,
	"affected_class_count" integer DEFAULT 0 NOT NULL,
	"cancellation_preview_count" integer DEFAULT 0 NOT NULL,
	"raw_values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_sync_run_id" uuid,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leave_request_affected_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"leave_request_id" uuid NOT NULL,
	"snapshot_id" uuid,
	"group_id" uuid,
	"wise_teacher_id" text NOT NULL,
	"wise_teacher_user_id" text,
	"wise_class_id" text,
	"wise_session_id" text NOT NULL,
	"start_time" timestamp with time zone NOT NULL,
	"end_time" timestamp with time zone NOT NULL,
	"weekday" integer NOT NULL,
	"start_minute" integer NOT NULL,
	"end_minute" integer NOT NULL,
	"wise_status" text NOT NULL,
	"session_type" text,
	"location" text,
	"student_name" text,
	"student_count" integer,
	"subject" text,
	"class_type" text,
	"title" text,
	"overlap_minutes" integer DEFAULT 0 NOT NULL,
	"cancel_preview_selected" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leave_request_activity_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"leave_request_id" uuid,
	"action_type" text NOT NULL,
	"status" text DEFAULT 'success' NOT NULL,
	"message" text,
	"request_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"response_payload" jsonb,
	"error_message" text,
	"created_by_email" text,
	"created_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leave_request_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sync_run_id" uuid,
	"leave_request_id" uuid,
	"notification_type" text DEFAULT 'new_submission_email' NOT NULL,
	"recipient_email" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider_message_id" text,
	"error" text,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_tutor_group_id_tutor_identity_groups_id_fk" FOREIGN KEY ("tutor_group_id") REFERENCES "public"."tutor_identity_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_last_sync_run_id_leave_request_sync_runs_id_fk" FOREIGN KEY ("last_sync_run_id") REFERENCES "public"."leave_request_sync_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_request_affected_sessions" ADD CONSTRAINT "leave_request_affected_sessions_leave_request_id_leave_requests_id_fk" FOREIGN KEY ("leave_request_id") REFERENCES "public"."leave_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_request_affected_sessions" ADD CONSTRAINT "leave_request_affected_sessions_snapshot_id_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_request_affected_sessions" ADD CONSTRAINT "leave_request_affected_sessions_group_id_tutor_identity_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."tutor_identity_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_request_activity_logs" ADD CONSTRAINT "leave_request_activity_logs_leave_request_id_leave_requests_id_fk" FOREIGN KEY ("leave_request_id") REFERENCES "public"."leave_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_request_notifications" ADD CONSTRAINT "leave_request_notifications_sync_run_id_leave_request_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."leave_request_sync_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_request_notifications" ADD CONSTRAINT "leave_request_notifications_leave_request_id_leave_requests_id_fk" FOREIGN KEY ("leave_request_id") REFERENCES "public"."leave_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "leave_request_sync_runs_single_running_idx" ON "leave_request_sync_runs" USING btree ("status") WHERE "leave_request_sync_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "leave_request_sync_runs_started_idx" ON "leave_request_sync_runs" USING btree ("status","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "leave_requests_source_row_idx" ON "leave_requests" USING btree ("spreadsheet_id","sheet_name","source_row_number");--> statement-breakpoint
CREATE INDEX "leave_requests_workflow_idx" ON "leave_requests" USING btree ("workflow_status","leave_start_time");--> statement-breakpoint
CREATE INDEX "leave_requests_unread_idx" ON "leave_requests" USING btree ("unread","created_at");--> statement-breakpoint
CREATE INDEX "leave_requests_tutor_idx" ON "leave_requests" USING btree ("tutor_canonical_key","leave_start_time");--> statement-breakpoint
CREATE UNIQUE INDEX "leave_request_affected_session_unique_idx" ON "leave_request_affected_sessions" USING btree ("leave_request_id","wise_session_id");--> statement-breakpoint
CREATE INDEX "leave_request_affected_sessions_request_idx" ON "leave_request_affected_sessions" USING btree ("leave_request_id","start_time");--> statement-breakpoint
CREATE INDEX "leave_request_affected_sessions_wise_idx" ON "leave_request_affected_sessions" USING btree ("wise_session_id");--> statement-breakpoint
CREATE INDEX "leave_request_activity_logs_request_idx" ON "leave_request_activity_logs" USING btree ("leave_request_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "leave_request_notifications_idempotency_idx" ON "leave_request_notifications" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "leave_request_notifications_request_idx" ON "leave_request_notifications" USING btree ("leave_request_id");--> statement-breakpoint
CREATE INDEX "leave_request_notifications_sync_idx" ON "leave_request_notifications" USING btree ("sync_run_id");
