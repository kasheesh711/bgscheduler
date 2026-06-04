CREATE TYPE "public"."progress_test_booking_status" AS ENUM('recorded', 'dry_run', 'wise_created', 'manual_required', 'manual_confirmed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."progress_test_status" AS ENUM('accumulating', 'approaching', 'due', 'scheduled', 'completed');--> statement-breakpoint
CREATE TABLE "progress_test_admin_digest_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"digest_run_id" uuid NOT NULL,
	"digest_date" date NOT NULL,
	"recipient_email" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider_message_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "progress_test_admin_digest_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"digest_date" date NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"subject" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"trigger_kind" text DEFAULT 'daily' NOT NULL,
	"created_by" text,
	"approaching_count" integer DEFAULT 0 NOT NULL,
	"due_count" integer DEFAULT 0 NOT NULL,
	"attempted_count" integer DEFAULT 0 NOT NULL,
	"success_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "progress_test_attendance_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrollment_key" text NOT NULL,
	"wise_session_id" text NOT NULL,
	"wise_class_id" text NOT NULL,
	"wise_student_id" text NOT NULL,
	"student_key" text NOT NULL,
	"student_name" text NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"scheduled_start_time" timestamp with time zone NOT NULL,
	"credit_applied" double precision DEFAULT 0 NOT NULL,
	"meeting_status" text NOT NULL,
	"wise_teacher_user_id" text,
	"wise_teacher_id" text,
	"tutor_canonical_key" text,
	"tutor_display_name" text,
	"is_progress_test" boolean DEFAULT false NOT NULL,
	"counts_toward_cycle" boolean DEFAULT true NOT NULL,
	"first_observed_snapshot_id" uuid,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "progress_test_bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrollment_key" text NOT NULL,
	"cycle_index" integer DEFAULT 0 NOT NULL,
	"status" "progress_test_booking_status" DEFAULT 'recorded' NOT NULL,
	"dry_run" boolean DEFAULT true NOT NULL,
	"scheduled_test_date" timestamp with time zone,
	"wise_class_id" text,
	"wise_student_id" text,
	"wise_session_id" text,
	"wise_teacher_user_id" text,
	"location" text,
	"request_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"response_payload" jsonb,
	"error_message" text,
	"created_by_email" text,
	"created_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "progress_test_cycle_state" (
	"enrollment_key" text PRIMARY KEY NOT NULL,
	"wise_student_id" text NOT NULL,
	"wise_class_id" text NOT NULL,
	"student_key" text NOT NULL,
	"student_name" text NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"current_count" integer DEFAULT 0 NOT NULL,
	"current_cycle_start" timestamp with time zone,
	"cycle_index" integer DEFAULT 0 NOT NULL,
	"status" "progress_test_status" DEFAULT 'accumulating' NOT NULL,
	"booked_test_wise_session_id" text,
	"booked_test_date" timestamp with time zone,
	"booked_test_booking_mode" text,
	"teacher_notified_at" timestamp with time zone,
	"teacher_notified_for_cycle" integer,
	"most_frequent_tutor_canonical_key" text,
	"most_frequent_tutor_display_name" text,
	"last_ai_summary" jsonb,
	"last_ai_summary_at" timestamp with time zone,
	"last_class_date" timestamp with time zone,
	"updated_by_email" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "progress_test_email_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrollment_key" text NOT NULL,
	"cycle_index" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"subject" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"trigger_kind" text DEFAULT 'approaching' NOT NULL,
	"created_by" text,
	"attempted_count" integer DEFAULT 0 NOT NULL,
	"success_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "progress_test_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_run_id" uuid,
	"enrollment_key" text NOT NULL,
	"cycle_index" integer DEFAULT 0 NOT NULL,
	"notification_type" text DEFAULT 'teacher_heads_up_email' NOT NULL,
	"recipient_email" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider_message_id" text,
	"error" text,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "progress_test_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "sync_status" DEFAULT 'running' NOT NULL,
	"trigger_type" text DEFAULT 'manual' NOT NULL,
	"actor_email" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"ledger_row_count" integer DEFAULT 0 NOT NULL,
	"enrollment_count" integer DEFAULT 0 NOT NULL,
	"approaching_count" integer DEFAULT 0 NOT NULL,
	"due_count" integer DEFAULT 0 NOT NULL,
	"notification_count" integer DEFAULT 0 NOT NULL,
	"error_summary" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "allowed_pages" jsonb;--> statement-breakpoint
ALTER TABLE "progress_test_admin_digest_recipients" ADD CONSTRAINT "progress_test_admin_digest_recipients_digest_run_id_progress_test_admin_digest_runs_id_fk" FOREIGN KEY ("digest_run_id") REFERENCES "public"."progress_test_admin_digest_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progress_test_notifications" ADD CONSTRAINT "progress_test_notifications_email_run_id_progress_test_email_runs_id_fk" FOREIGN KEY ("email_run_id") REFERENCES "public"."progress_test_email_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pt_admin_digest_recipients_run_idx" ON "progress_test_admin_digest_recipients" USING btree ("digest_run_id");--> statement-breakpoint
CREATE INDEX "pt_admin_digest_recipients_date_idx" ON "progress_test_admin_digest_recipients" USING btree ("digest_date");--> statement-breakpoint
CREATE INDEX "pt_admin_digest_recipients_email_idx" ON "progress_test_admin_digest_recipients" USING btree ("recipient_email");--> statement-breakpoint
CREATE UNIQUE INDEX "pt_admin_digest_runs_idempotency_idx" ON "progress_test_admin_digest_runs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "pt_admin_digest_runs_date_idx" ON "progress_test_admin_digest_runs" USING btree ("digest_date");--> statement-breakpoint
CREATE UNIQUE INDEX "ptal_session_student_idx" ON "progress_test_attendance_ledger" USING btree ("wise_session_id","wise_student_id");--> statement-breakpoint
CREATE INDEX "ptal_enrollment_start_idx" ON "progress_test_attendance_ledger" USING btree ("enrollment_key","scheduled_start_time");--> statement-breakpoint
CREATE INDEX "pt_bookings_enrollment_idx" ON "progress_test_bookings" USING btree ("enrollment_key","created_at");--> statement-breakpoint
CREATE INDEX "pt_bookings_status_idx" ON "progress_test_bookings" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ptcs_status_idx" ON "progress_test_cycle_state" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ptcs_student_key_idx" ON "progress_test_cycle_state" USING btree ("student_key");--> statement-breakpoint
CREATE INDEX "ptcs_updated_at_idx" ON "progress_test_cycle_state" USING btree ("updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pt_email_runs_idempotency_idx" ON "progress_test_email_runs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "pt_email_runs_enrollment_idx" ON "progress_test_email_runs" USING btree ("enrollment_key");--> statement-breakpoint
CREATE UNIQUE INDEX "pt_notifications_idempotency_idx" ON "progress_test_notifications" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "pt_notifications_enrollment_idx" ON "progress_test_notifications" USING btree ("enrollment_key");--> statement-breakpoint
CREATE INDEX "pt_notifications_email_run_idx" ON "progress_test_notifications" USING btree ("email_run_id");--> statement-breakpoint
CREATE INDEX "pt_sync_runs_status_idx" ON "progress_test_sync_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "pt_sync_runs_started_at_idx" ON "progress_test_sync_runs" USING btree ("started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pt_sync_runs_single_running_idx" ON "progress_test_sync_runs" USING btree ("status") WHERE "progress_test_sync_runs"."status" = 'running';
