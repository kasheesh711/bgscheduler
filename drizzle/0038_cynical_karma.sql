CREATE TYPE "public"."leave_request_sheet_write_status" AS ENUM('not_required', 'pending', 'success', 'failed');--> statement-breakpoint
CREATE TYPE "public"."leave_request_workflow_status" AS ENUM('new', 'needs_review', 'in_progress', 'done', 'ignored', 'canceled_by_tutor');--> statement-breakpoint
CREATE TYPE "public"."line_contact_student_link_status" AS ENUM('suggested', 'verified', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."payroll_review_status" AS ENUM('draft', 'approved');--> statement-breakpoint
CREATE TYPE "public"."progress_test_booking_status" AS ENUM('recorded', 'dry_run', 'wise_created', 'manual_required', 'manual_confirmed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."progress_test_status" AS ENUM('accumulating', 'approaching', 'due', 'scheduled', 'completed');--> statement-breakpoint
CREATE TYPE "public"."student_promotion_action_status" AS ENUM('pending', 'skipped', 'applied', 'failed');--> statement-breakpoint
CREATE TYPE "public"."student_promotion_run_status" AS ENUM('draft', 'verified', 'applying', 'applied', 'applied_with_errors', 'failed');--> statement-breakpoint
ALTER TYPE "public"."sales_dashboard_source_status" ADD VALUE 'archived';--> statement-breakpoint
CREATE TABLE "ai_scheduler_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid,
	"message_id" uuid,
	"scheduler_run_id" uuid,
	"action" text NOT NULL,
	"selected_tutor_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rejected_tutor_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"edited_parent_draft" text,
	"rejection_reason" text,
	"staff_correction" text,
	"line_review_id" uuid,
	"classifier_confidence" double precision,
	"time_to_review_ms" integer,
	"created_by_email" text,
	"created_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "classroom_admin_email_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_run_id" uuid NOT NULL,
	"assignment_date" date NOT NULL,
	"recipient_email" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider_message_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "classroom_admin_email_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assignment_date" date NOT NULL,
	"assignment_run_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"subject" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"trigger_kind" text DEFAULT 'ready' NOT NULL,
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
CREATE TABLE "classroom_automation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_batch_id" uuid NOT NULL,
	"assignment_run_id" uuid,
	"assignment_date" date NOT NULL,
	"event_type" text NOT NULL,
	"wise_session_id" text,
	"source_row_id" uuid,
	"target_row_id" uuid,
	"message" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cron_invocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_key" text NOT NULL,
	"path" text NOT NULL,
	"schedule" text,
	"trigger_source" text DEFAULT 'cron' NOT NULL,
	"actor_email" text,
	"request_method" text DEFAULT 'GET' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"response_status" integer,
	"outcome" text DEFAULT 'running' NOT NULL,
	"error_summary" text,
	"linked_run_ids" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
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
CREATE TABLE "line_contact_student_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"wise_student_id" text NOT NULL,
	"student_key" text NOT NULL,
	"student_name" text NOT NULL,
	"parent_name" text DEFAULT '' NOT NULL,
	"status" "line_contact_student_link_status" DEFAULT 'suggested' NOT NULL,
	"confidence" double precision,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_kind" text,
	"source_run_id" uuid,
	"reviewed_by_email" text,
	"reviewed_by_name" text,
	"reviewed_at" timestamp with time zone,
	"validation_assigned_to_email" text,
	"validation_assigned_to_name" text,
	"validation_assigned_run_id" uuid,
	"validation_assigned_at" timestamp with time zone,
	"validation_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "line_oa_resolver_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"wise_student_id" text NOT NULL,
	"student_key" text NOT NULL,
	"student_name" text NOT NULL,
	"parent_name" text DEFAULT '' NOT NULL,
	"search_code" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"line_oa_account_id" text,
	"line_user_id" text,
	"line_chat_url" text,
	"chat_title" text,
	"match_mode" text,
	"capture_mode" text,
	"error_message" text,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"committed_contact_id" uuid,
	"committed_link_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "line_oa_resolver_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"worklist_source" text DEFAULT 'current_credit_control_snapshot' NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"pending_rows" integer DEFAULT 0 NOT NULL,
	"matched_rows" integer DEFAULT 0 NOT NULL,
	"ambiguous_rows" integer DEFAULT 0 NOT NULL,
	"no_match_rows" integer DEFAULT 0 NOT NULL,
	"error_rows" integer DEFAULT 0 NOT NULL,
	"needs_manual_code_rows" integer DEFAULT 0 NOT NULL,
	"committed_rows" integer DEFAULT 0 NOT NULL,
	"created_by_email" text,
	"created_by_name" text,
	"expires_at" timestamp with time zone NOT NULL,
	"committed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "line_wise_action_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"line_review_id" uuid,
	"action_type" text NOT NULL,
	"status" text DEFAULT 'dry_run' NOT NULL,
	"dry_run" boolean DEFAULT true NOT NULL,
	"wise_session_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"request_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"response_payload" jsonb,
	"error_message" text,
	"created_by_email" text,
	"created_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payroll_month" date NOT NULL,
	"adjustment_type" text DEFAULT 'manual' NOT NULL,
	"tutor_canonical_key" text,
	"tutor_display_name" text,
	"hours" double precision DEFAULT 0 NOT NULL,
	"amount" double precision DEFAULT 0 NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_by_email" text,
	"created_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_payout_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payroll_month" date NOT NULL,
	"sync_run_id" uuid NOT NULL,
	"event_id" text NOT NULL,
	"transaction_id" text NOT NULL,
	"event_timestamp" timestamp with time zone NOT NULL,
	"wise_teacher_user_id" text,
	"actor_wise_user_id" text,
	"wise_class_id" text,
	"wise_session_id" text,
	"session_start_time" timestamp with time zone,
	"session_credits" double precision DEFAULT 0 NOT NULL,
	"amount_minor" integer,
	"amount" double precision DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'THB' NOT NULL,
	"transaction_status" text,
	"note" text,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_rate_card_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_name" text NOT NULL,
	"effective_month" date NOT NULL,
	"source_label" text NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_by_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_rate_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"student_band" text NOT NULL,
	"curriculum" text NOT NULL,
	"course" text NOT NULL,
	"normalized_course_key" text NOT NULL,
	"tier_key" text NOT NULL,
	"source_tier_key" text NOT NULL,
	"price_per_hour" double precision,
	"expected_revenue_per_hour" double precision NOT NULL,
	"revenue_share" double precision,
	"raw_source_row" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payroll_month" date NOT NULL,
	"status" "payroll_review_status" DEFAULT 'draft' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"approved_by_email" text,
	"approved_by_name" text,
	"approved_at" timestamp with time zone,
	"last_sync_run_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_session_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payroll_month" date NOT NULL,
	"sync_run_id" uuid NOT NULL,
	"wise_session_id" text NOT NULL,
	"wise_teacher_user_id" text,
	"wise_teacher_id" text,
	"tutor_group_canonical_key" text,
	"tutor_display_name" text,
	"wise_class_id" text,
	"class_name" text,
	"subject" text,
	"class_type" text,
	"start_time" timestamp with time zone NOT NULL,
	"end_time" timestamp with time zone,
	"duration_minutes" integer DEFAULT 0 NOT NULL,
	"meeting_status" text NOT NULL,
	"session_type" text,
	"student_count" integer,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payroll_month" date NOT NULL,
	"status" "sync_status" DEFAULT 'running' NOT NULL,
	"trigger_type" text DEFAULT 'manual' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"teacher_count" integer DEFAULT 0 NOT NULL,
	"session_count" integer DEFAULT 0 NOT NULL,
	"invoice_count" integer DEFAULT 0 NOT NULL,
	"error_summary" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_teacher_tiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payroll_month" date NOT NULL,
	"sync_run_id" uuid NOT NULL,
	"wise_teacher_id" text NOT NULL,
	"wise_user_id" text,
	"wise_display_name" text NOT NULL,
	"raw_tier" text,
	"normalized_tier" text DEFAULT 'Unassigned' NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE "sales_dashboard_projection_import_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid,
	"status" "sync_status" DEFAULT 'running' NOT NULL,
	"trigger_type" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"month_row_count" integer DEFAULT 0 NOT NULL,
	"target_monthly_revenue" double precision,
	"error_summary" text,
	"actor_email" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_dashboard_projection_months" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"import_run_id" uuid NOT NULL,
	"scenario" text NOT NULL,
	"projection_month" date NOT NULL,
	"month_label" text NOT NULL,
	"month_kind" text DEFAULT 'forecast' NOT NULL,
	"total_net_revenue" double precision DEFAULT 0 NOT NULL,
	"renewal_revenue" double precision DEFAULT 0 NOT NULL,
	"new_student_revenue" double precision DEFAULT 0 NOT NULL,
	"trial_revenue" double precision DEFAULT 0 NOT NULL,
	"active_students" double precision DEFAULT 0 NOT NULL,
	"trial_bookings" double precision DEFAULT 0 NOT NULL,
	"new_students" double precision DEFAULT 0 NOT NULL,
	"pack_renewals" double precision DEFAULT 0 NOT NULL,
	"renewal_hours" double precision DEFAULT 0 NOT NULL,
	"new_student_hours" double precision DEFAULT 0 NOT NULL,
	"trial_hours" double precision DEFAULT 0 NOT NULL,
	"total_hours" double precision DEFAULT 0 NOT NULL,
	"room_capacity" double precision DEFAULT 0 NOT NULL,
	"room_utilization" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_dashboard_projection_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"spreadsheet_id" text NOT NULL,
	"spreadsheet_url" text NOT NULL,
	"summary_sheet_name" text DEFAULT 'Summary' NOT NULL,
	"what_if_sheet_name" text DEFAULT 'What_If' NOT NULL,
	"calc_multi_sheet_name" text DEFAULT 'Calc_Multi' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_successful_import_run_id" uuid,
	"last_imported_at" timestamp with time zone,
	"last_import_error" text,
	"last_projection_month_count" integer DEFAULT 0 NOT NULL,
	"last_target_monthly_revenue" double precision,
	"connected_email" text NOT NULL,
	"created_by_email" text NOT NULL,
	"updated_by_email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "student_promotion_course_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"wise_class_id" text NOT NULL,
	"current_subject" text NOT NULL,
	"target_subject" text,
	"transition_type" text NOT NULL,
	"student_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"qualifying_student_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "student_promotion_action_status" DEFAULT 'pending' NOT NULL,
	"skip_reason" text,
	"request_payload" jsonb,
	"response_payload" jsonb,
	"error_message" text,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "student_promotion_grade_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"wise_student_id" text NOT NULL,
	"student_name" text DEFAULT '' NOT NULL,
	"student_key" text DEFAULT '' NOT NULL,
	"current_grade_raw" text DEFAULT '' NOT NULL,
	"parsed_current_year" integer,
	"target_grade" text,
	"action_type" text NOT NULL,
	"status" "student_promotion_action_status" DEFAULT 'pending' NOT NULL,
	"skip_reason" text,
	"request_payload" jsonb,
	"response_payload" jsonb,
	"error_message" text,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "student_promotion_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_date" date NOT NULL,
	"status" "student_promotion_run_status" DEFAULT 'draft' NOT NULL,
	"source_snapshot_id" uuid,
	"wise_accepted_student_count" integer DEFAULT 0 NOT NULL,
	"website_snapshot_student_count" integer DEFAULT 0 NOT NULL,
	"grade_only_count" integer DEFAULT 0 NOT NULL,
	"year8_course_move_count" integer DEFAULT 0 NOT NULL,
	"year11_course_move_count" integer DEFAULT 0 NOT NULL,
	"skipped_grade_count" integer DEFAULT 0 NOT NULL,
	"pending_course_action_count" integer DEFAULT 0 NOT NULL,
	"skipped_course_action_count" integer DEFAULT 0 NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_by_email" text,
	"verified_by_name" text,
	"endpoint_verification_note" text,
	"apply_started_at" timestamp with time zone,
	"apply_finished_at" timestamp with time zone,
	"applied_by_email" text,
	"applied_by_name" text,
	"error_summary" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_email" text,
	"created_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wise_activity_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text DEFAULT 'unknown' NOT NULL,
	"event_name" text NOT NULL,
	"event_timestamp" timestamp with time zone NOT NULL,
	"actor_wise_user_id" text,
	"actor_name" text,
	"actor_role" text,
	"classroom_id" text,
	"classroom_name" text,
	"classroom_subject" text,
	"session_id" text,
	"session_start_time" timestamp with time zone,
	"session_end_time" timestamp with time zone,
	"transaction_id" text,
	"transaction_type" text,
	"transaction_status" text,
	"transaction_amount" double precision,
	"transaction_currency" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wise_activity_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "sync_status" DEFAULT 'running' NOT NULL,
	"trigger_type" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"pages_fetched" integer DEFAULT 0 NOT NULL,
	"events_fetched" integer DEFAULT 0 NOT NULL,
	"inserted_count" integer DEFAULT 0 NOT NULL,
	"oldest_event_timestamp" timestamp with time zone,
	"newest_event_timestamp" timestamp with time zone,
	"error_summary" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
DROP INDEX "sds_source_month_idx";--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "allowed_pages" jsonb;--> statement-breakpoint
ALTER TABLE "classroom_assignment_rows" ADD COLUMN "source_row_id" uuid;--> statement-breakpoint
ALTER TABLE "classroom_assignment_rows" ADD COLUMN "change_type" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "classroom_assignment_rows" ADD COLUMN "assignment_fingerprint" text;--> statement-breakpoint
ALTER TABLE "classroom_assignment_runs" ADD COLUMN "source_run_id" uuid;--> statement-breakpoint
ALTER TABLE "classroom_assignment_runs" ADD COLUMN "automation_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "classroom_assignment_runs" ADD COLUMN "reconciliation_mode" text;--> statement-breakpoint
ALTER TABLE "classroom_assignment_runs" ADD COLUMN "change_summary" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "classroom_publish_jobs" ADD COLUMN "target_row_ids" jsonb;--> statement-breakpoint
ALTER TABLE "line_messages" ADD COLUMN "classification_reviewed_category" "line_scheduler_classifier_category";--> statement-breakpoint
ALTER TABLE "line_messages" ADD COLUMN "classification_reviewed_correct" boolean;--> statement-breakpoint
ALTER TABLE "line_messages" ADD COLUMN "classification_reviewed_by_email" text;--> statement-breakpoint
ALTER TABLE "line_messages" ADD COLUMN "classification_reviewed_by_name" text;--> statement-breakpoint
ALTER TABLE "line_messages" ADD COLUMN "classification_reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "line_scheduler_reviews" ADD COLUMN "intent_type" text DEFAULT 'new_request' NOT NULL;--> statement-breakpoint
ALTER TABLE "line_scheduler_reviews" ADD COLUMN "intent_payload" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "line_scheduler_reviews" ADD COLUMN "reason_category" text;--> statement-breakpoint
ALTER TABLE "line_scheduler_reviews" ADD COLUMN "selected_tutor_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "line_scheduler_reviews" ADD COLUMN "student_link_override" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "line_scheduler_reviews" ADD COLUMN "verified_student_keys" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "line_scheduler_reviews" ADD COLUMN "matched_student_keys" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "line_scheduler_reviews" ADD COLUMN "candidate_sessions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "line_scheduler_reviews" ADD COLUMN "proposed_wise_actions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "line_scheduler_reviews" ADD COLUMN "admin_selected_session_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "line_scheduler_reviews" ADD COLUMN "writeback_status" text DEFAULT 'not_applicable' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_dashboard_sources" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sales_dashboard_sources" ADD COLUMN "archived_by_email" text;--> statement-breakpoint
ALTER TABLE "sales_dashboard_sources" ADD COLUMN "status_before_archive" "sales_dashboard_source_status";--> statement-breakpoint
ALTER TABLE "ai_scheduler_feedback" ADD CONSTRAINT "ai_scheduler_feedback_conversation_id_ai_scheduler_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_scheduler_conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_scheduler_feedback" ADD CONSTRAINT "ai_scheduler_feedback_message_id_ai_scheduler_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."ai_scheduler_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_scheduler_feedback" ADD CONSTRAINT "ai_scheduler_feedback_scheduler_run_id_ai_scheduler_runs_id_fk" FOREIGN KEY ("scheduler_run_id") REFERENCES "public"."ai_scheduler_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_scheduler_feedback" ADD CONSTRAINT "ai_scheduler_feedback_line_review_id_line_scheduler_reviews_id_fk" FOREIGN KEY ("line_review_id") REFERENCES "public"."line_scheduler_reviews"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classroom_admin_email_recipients" ADD CONSTRAINT "classroom_admin_email_recipients_email_run_id_classroom_admin_email_runs_id_fk" FOREIGN KEY ("email_run_id") REFERENCES "public"."classroom_admin_email_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classroom_admin_email_runs" ADD CONSTRAINT "classroom_admin_email_runs_assignment_run_id_classroom_assignment_runs_id_fk" FOREIGN KEY ("assignment_run_id") REFERENCES "public"."classroom_assignment_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classroom_automation_events" ADD CONSTRAINT "classroom_automation_events_assignment_run_id_classroom_assignment_runs_id_fk" FOREIGN KEY ("assignment_run_id") REFERENCES "public"."classroom_assignment_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_request_activity_logs" ADD CONSTRAINT "leave_request_activity_logs_leave_request_id_leave_requests_id_fk" FOREIGN KEY ("leave_request_id") REFERENCES "public"."leave_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_request_affected_sessions" ADD CONSTRAINT "leave_request_affected_sessions_leave_request_id_leave_requests_id_fk" FOREIGN KEY ("leave_request_id") REFERENCES "public"."leave_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_request_affected_sessions" ADD CONSTRAINT "leave_request_affected_sessions_snapshot_id_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_request_affected_sessions" ADD CONSTRAINT "leave_request_affected_sessions_group_id_tutor_identity_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."tutor_identity_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_request_notifications" ADD CONSTRAINT "leave_request_notifications_sync_run_id_leave_request_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."leave_request_sync_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_request_notifications" ADD CONSTRAINT "leave_request_notifications_leave_request_id_leave_requests_id_fk" FOREIGN KEY ("leave_request_id") REFERENCES "public"."leave_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_tutor_group_id_tutor_identity_groups_id_fk" FOREIGN KEY ("tutor_group_id") REFERENCES "public"."tutor_identity_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_last_sync_run_id_leave_request_sync_runs_id_fk" FOREIGN KEY ("last_sync_run_id") REFERENCES "public"."leave_request_sync_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "line_contact_student_links" ADD CONSTRAINT "line_contact_student_links_contact_id_line_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."line_contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "line_oa_resolver_rows" ADD CONSTRAINT "line_oa_resolver_rows_run_id_line_oa_resolver_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."line_oa_resolver_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "line_oa_resolver_rows" ADD CONSTRAINT "line_oa_resolver_rows_committed_contact_id_line_contacts_id_fk" FOREIGN KEY ("committed_contact_id") REFERENCES "public"."line_contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "line_oa_resolver_rows" ADD CONSTRAINT "line_oa_resolver_rows_committed_link_id_line_contact_student_links_id_fk" FOREIGN KEY ("committed_link_id") REFERENCES "public"."line_contact_student_links"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "line_wise_action_logs" ADD CONSTRAINT "line_wise_action_logs_line_review_id_line_scheduler_reviews_id_fk" FOREIGN KEY ("line_review_id") REFERENCES "public"."line_scheduler_reviews"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_payout_invoices" ADD CONSTRAINT "payroll_payout_invoices_sync_run_id_payroll_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."payroll_sync_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_rate_rules" ADD CONSTRAINT "payroll_rate_rules_version_id_payroll_rate_card_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."payroll_rate_card_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_reviews" ADD CONSTRAINT "payroll_reviews_last_sync_run_id_payroll_sync_runs_id_fk" FOREIGN KEY ("last_sync_run_id") REFERENCES "public"."payroll_sync_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_session_observations" ADD CONSTRAINT "payroll_session_observations_sync_run_id_payroll_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."payroll_sync_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_teacher_tiers" ADD CONSTRAINT "payroll_teacher_tiers_sync_run_id_payroll_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."payroll_sync_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progress_test_admin_digest_recipients" ADD CONSTRAINT "progress_test_admin_digest_recipients_digest_run_id_progress_test_admin_digest_runs_id_fk" FOREIGN KEY ("digest_run_id") REFERENCES "public"."progress_test_admin_digest_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progress_test_notifications" ADD CONSTRAINT "progress_test_notifications_email_run_id_progress_test_email_runs_id_fk" FOREIGN KEY ("email_run_id") REFERENCES "public"."progress_test_email_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_dashboard_projection_import_runs" ADD CONSTRAINT "sales_dashboard_projection_import_runs_source_id_sales_dashboard_projection_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sales_dashboard_projection_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_dashboard_projection_months" ADD CONSTRAINT "sales_dashboard_projection_months_source_id_sales_dashboard_projection_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sales_dashboard_projection_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_dashboard_projection_months" ADD CONSTRAINT "sales_dashboard_projection_months_import_run_id_sales_dashboard_projection_import_runs_id_fk" FOREIGN KEY ("import_run_id") REFERENCES "public"."sales_dashboard_projection_import_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_promotion_course_actions" ADD CONSTRAINT "student_promotion_course_actions_run_id_student_promotion_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."student_promotion_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_promotion_grade_actions" ADD CONSTRAINT "student_promotion_grade_actions_run_id_student_promotion_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."student_promotion_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_promotion_runs" ADD CONSTRAINT "student_promotion_runs_source_snapshot_id_credit_control_snapshots_id_fk" FOREIGN KEY ("source_snapshot_id") REFERENCES "public"."credit_control_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_scheduler_feedback_message_idx" ON "ai_scheduler_feedback" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "ai_scheduler_feedback_run_idx" ON "ai_scheduler_feedback" USING btree ("scheduler_run_id");--> statement-breakpoint
CREATE INDEX "ai_scheduler_feedback_created_at_idx" ON "ai_scheduler_feedback" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ai_scheduler_feedback_action_idx" ON "ai_scheduler_feedback" USING btree ("action");--> statement-breakpoint
CREATE INDEX "ai_scheduler_feedback_line_review_idx" ON "ai_scheduler_feedback" USING btree ("line_review_id");--> statement-breakpoint
CREATE INDEX "caer_recipients_email_run_idx" ON "classroom_admin_email_recipients" USING btree ("email_run_id");--> statement-breakpoint
CREATE INDEX "caer_recipients_date_idx" ON "classroom_admin_email_recipients" USING btree ("assignment_date");--> statement-breakpoint
CREATE INDEX "caer_recipients_email_idx" ON "classroom_admin_email_recipients" USING btree ("recipient_email");--> statement-breakpoint
CREATE UNIQUE INDEX "caer_idempotency_idx" ON "classroom_admin_email_runs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "caer_date_idx" ON "classroom_admin_email_runs" USING btree ("assignment_date");--> statement-breakpoint
CREATE INDEX "caer_assignment_run_idx" ON "classroom_admin_email_runs" USING btree ("assignment_run_id");--> statement-breakpoint
CREATE INDEX "cae_batch_idx" ON "classroom_automation_events" USING btree ("automation_batch_id");--> statement-breakpoint
CREATE INDEX "cae_run_idx" ON "classroom_automation_events" USING btree ("assignment_run_id");--> statement-breakpoint
CREATE INDEX "cae_date_idx" ON "classroom_automation_events" USING btree ("assignment_date");--> statement-breakpoint
CREATE INDEX "cae_type_idx" ON "classroom_automation_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "cron_invocations_job_received_idx" ON "cron_invocations" USING btree ("job_key","received_at");--> statement-breakpoint
CREATE INDEX "cron_invocations_outcome_received_idx" ON "cron_invocations" USING btree ("outcome","received_at");--> statement-breakpoint
CREATE INDEX "cron_invocations_trigger_received_idx" ON "cron_invocations" USING btree ("trigger_source","received_at");--> statement-breakpoint
CREATE INDEX "leave_request_activity_logs_request_idx" ON "leave_request_activity_logs" USING btree ("leave_request_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "leave_request_affected_session_unique_idx" ON "leave_request_affected_sessions" USING btree ("leave_request_id","wise_session_id");--> statement-breakpoint
CREATE INDEX "leave_request_affected_sessions_request_idx" ON "leave_request_affected_sessions" USING btree ("leave_request_id","start_time");--> statement-breakpoint
CREATE INDEX "leave_request_affected_sessions_wise_idx" ON "leave_request_affected_sessions" USING btree ("wise_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "leave_request_notifications_idempotency_idx" ON "leave_request_notifications" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "leave_request_notifications_request_idx" ON "leave_request_notifications" USING btree ("leave_request_id");--> statement-breakpoint
CREATE INDEX "leave_request_notifications_sync_idx" ON "leave_request_notifications" USING btree ("sync_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "leave_request_sync_runs_single_running_idx" ON "leave_request_sync_runs" USING btree ("status") WHERE "leave_request_sync_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "leave_request_sync_runs_started_idx" ON "leave_request_sync_runs" USING btree ("status","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "leave_requests_source_row_idx" ON "leave_requests" USING btree ("spreadsheet_id","sheet_name","source_row_number");--> statement-breakpoint
CREATE INDEX "leave_requests_workflow_idx" ON "leave_requests" USING btree ("workflow_status","leave_start_time");--> statement-breakpoint
CREATE INDEX "leave_requests_unread_idx" ON "leave_requests" USING btree ("unread","created_at");--> statement-breakpoint
CREATE INDEX "leave_requests_tutor_idx" ON "leave_requests" USING btree ("tutor_canonical_key","leave_start_time");--> statement-breakpoint
CREATE UNIQUE INDEX "line_contact_student_links_contact_student_idx" ON "line_contact_student_links" USING btree ("contact_id","student_key");--> statement-breakpoint
CREATE INDEX "line_contact_student_links_contact_status_idx" ON "line_contact_student_links" USING btree ("contact_id","status");--> statement-breakpoint
CREATE INDEX "line_contact_student_links_student_key_idx" ON "line_contact_student_links" USING btree ("student_key");--> statement-breakpoint
CREATE INDEX "line_contact_student_links_validation_assignee_idx" ON "line_contact_student_links" USING btree ("validation_assigned_to_email","status");--> statement-breakpoint
CREATE INDEX "line_contact_student_links_validation_run_idx" ON "line_contact_student_links" USING btree ("validation_assigned_run_id","status");--> statement-breakpoint
CREATE INDEX "line_contact_student_links_source_run_status_sort_idx" ON "line_contact_student_links" USING btree ("source_run_id","status","parent_name","student_name","student_key") WHERE "line_contact_student_links"."source_kind" = 'line_oa_resolver';--> statement-breakpoint
CREATE INDEX "line_contact_student_links_source_assignee_status_sort_idx" ON "line_contact_student_links" USING btree ("validation_assigned_to_email","status","source_run_id","parent_name","student_name","student_key") WHERE "line_contact_student_links"."source_kind" = 'line_oa_resolver';--> statement-breakpoint
CREATE INDEX "line_contact_student_links_source_reviewed_idx" ON "line_contact_student_links" USING btree ("source_run_id","status","reviewed_at","updated_at") WHERE "line_contact_student_links"."source_kind" = 'line_oa_resolver' AND "line_contact_student_links"."status" IN ('verified', 'rejected');--> statement-breakpoint
CREATE UNIQUE INDEX "line_oa_resolver_rows_run_student_code_idx" ON "line_oa_resolver_rows" USING btree ("run_id","student_key","search_code");--> statement-breakpoint
CREATE INDEX "line_oa_resolver_rows_run_status_idx" ON "line_oa_resolver_rows" USING btree ("run_id","status");--> statement-breakpoint
CREATE INDEX "line_oa_resolver_rows_line_user_idx" ON "line_oa_resolver_rows" USING btree ("line_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "line_oa_resolver_runs_token_hash_idx" ON "line_oa_resolver_runs" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "line_oa_resolver_runs_status_idx" ON "line_oa_resolver_runs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "line_oa_resolver_runs_created_by_idx" ON "line_oa_resolver_runs" USING btree ("created_by_email","created_at");--> statement-breakpoint
CREATE INDEX "line_wise_action_logs_review_idx" ON "line_wise_action_logs" USING btree ("line_review_id","created_at");--> statement-breakpoint
CREATE INDEX "payroll_adjustments_month_idx" ON "payroll_adjustments" USING btree ("payroll_month","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_payout_invoices_event_idx" ON "payroll_payout_invoices" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "payroll_payout_invoices_transaction_idx" ON "payroll_payout_invoices" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "payroll_payout_invoices_month_idx" ON "payroll_payout_invoices" USING btree ("payroll_month");--> statement-breakpoint
CREATE INDEX "payroll_payout_invoices_month_teacher_idx" ON "payroll_payout_invoices" USING btree ("payroll_month","wise_teacher_user_id");--> statement-breakpoint
CREATE INDEX "payroll_payout_invoices_session_idx" ON "payroll_payout_invoices" USING btree ("wise_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_rate_card_versions_active_idx" ON "payroll_rate_card_versions" USING btree ("active") WHERE "payroll_rate_card_versions"."active" = true;--> statement-breakpoint
CREATE INDEX "payroll_rate_card_versions_effective_idx" ON "payroll_rate_card_versions" USING btree ("effective_month");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_rate_rules_unique_idx" ON "payroll_rate_rules" USING btree ("version_id","student_band","normalized_course_key","tier_key");--> statement-breakpoint
CREATE INDEX "payroll_rate_rules_lookup_idx" ON "payroll_rate_rules" USING btree ("version_id","student_band","normalized_course_key");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_reviews_month_idx" ON "payroll_reviews" USING btree ("payroll_month");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_session_observations_month_session_idx" ON "payroll_session_observations" USING btree ("payroll_month","wise_session_id");--> statement-breakpoint
CREATE INDEX "payroll_session_observations_month_teacher_idx" ON "payroll_session_observations" USING btree ("payroll_month","wise_teacher_user_id");--> statement-breakpoint
CREATE INDEX "payroll_session_observations_month_group_idx" ON "payroll_session_observations" USING btree ("payroll_month","tutor_group_canonical_key");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_sync_runs_single_running_idx" ON "payroll_sync_runs" USING btree ("status") WHERE "payroll_sync_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "payroll_sync_runs_month_idx" ON "payroll_sync_runs" USING btree ("payroll_month","started_at");--> statement-breakpoint
CREATE INDEX "payroll_sync_runs_status_idx" ON "payroll_sync_runs" USING btree ("status","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_teacher_tiers_month_teacher_idx" ON "payroll_teacher_tiers" USING btree ("payroll_month","wise_teacher_id");--> statement-breakpoint
CREATE INDEX "payroll_teacher_tiers_month_user_idx" ON "payroll_teacher_tiers" USING btree ("payroll_month","wise_user_id");--> statement-breakpoint
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
CREATE UNIQUE INDEX "pt_sync_runs_single_running_idx" ON "progress_test_sync_runs" USING btree ("status") WHERE "progress_test_sync_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "sdpir_source_started_idx" ON "sales_dashboard_projection_import_runs" USING btree ("source_id","started_at");--> statement-breakpoint
CREATE INDEX "sdpir_status_started_idx" ON "sales_dashboard_projection_import_runs" USING btree ("status","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sdpir_source_single_running_idx" ON "sales_dashboard_projection_import_runs" USING btree ("source_id") WHERE "sales_dashboard_projection_import_runs"."status" = 'running' AND "sales_dashboard_projection_import_runs"."source_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "sdpm_run_scenario_month_idx" ON "sales_dashboard_projection_months" USING btree ("import_run_id","scenario","projection_month");--> statement-breakpoint
CREATE INDEX "sdpm_source_run_idx" ON "sales_dashboard_projection_months" USING btree ("source_id","import_run_id");--> statement-breakpoint
CREATE INDEX "sdpm_month_idx" ON "sales_dashboard_projection_months" USING btree ("projection_month");--> statement-breakpoint
CREATE INDEX "sdpm_scenario_month_idx" ON "sales_dashboard_projection_months" USING btree ("scenario","projection_month");--> statement-breakpoint
CREATE UNIQUE INDEX "sdps_single_active_idx" ON "sales_dashboard_projection_sources" USING btree ("status") WHERE "sales_dashboard_projection_sources"."status" = 'active';--> statement-breakpoint
CREATE INDEX "sdps_connected_email_idx" ON "sales_dashboard_projection_sources" USING btree ("connected_email");--> statement-breakpoint
CREATE UNIQUE INDEX "sp_course_actions_run_class_idx" ON "student_promotion_course_actions" USING btree ("run_id","wise_class_id");--> statement-breakpoint
CREATE INDEX "sp_course_actions_run_status_idx" ON "student_promotion_course_actions" USING btree ("run_id","status");--> statement-breakpoint
CREATE INDEX "sp_course_actions_class_idx" ON "student_promotion_course_actions" USING btree ("wise_class_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sp_grade_actions_run_student_idx" ON "student_promotion_grade_actions" USING btree ("run_id","wise_student_id");--> statement-breakpoint
CREATE INDEX "sp_grade_actions_run_status_idx" ON "student_promotion_grade_actions" USING btree ("run_id","status");--> statement-breakpoint
CREATE INDEX "sp_grade_actions_student_idx" ON "student_promotion_grade_actions" USING btree ("wise_student_id");--> statement-breakpoint
CREATE INDEX "student_promotion_runs_target_status_idx" ON "student_promotion_runs" USING btree ("target_date","status");--> statement-breakpoint
CREATE INDEX "student_promotion_runs_created_at_idx" ON "student_promotion_runs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "student_promotion_runs_verified_idx" ON "student_promotion_runs" USING btree ("verified_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wise_activity_events_event_id_idx" ON "wise_activity_events" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "wise_activity_events_timestamp_idx" ON "wise_activity_events" USING btree ("event_timestamp");--> statement-breakpoint
CREATE INDEX "wise_activity_events_type_timestamp_idx" ON "wise_activity_events" USING btree ("event_type","event_timestamp");--> statement-breakpoint
CREATE INDEX "wise_activity_events_name_timestamp_idx" ON "wise_activity_events" USING btree ("event_name","event_timestamp");--> statement-breakpoint
CREATE INDEX "wise_activity_events_actor_idx" ON "wise_activity_events" USING btree ("actor_wise_user_id","event_timestamp");--> statement-breakpoint
CREATE INDEX "wise_activity_events_classroom_idx" ON "wise_activity_events" USING btree ("classroom_id","event_timestamp");--> statement-breakpoint
CREATE INDEX "wise_activity_events_session_idx" ON "wise_activity_events" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "wise_activity_events_transaction_idx" ON "wise_activity_events" USING btree ("transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wise_activity_sync_runs_single_running_idx" ON "wise_activity_sync_runs" USING btree ("status") WHERE "wise_activity_sync_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "wise_activity_sync_runs_status_started_idx" ON "wise_activity_sync_runs" USING btree ("status","started_at");--> statement-breakpoint
CREATE INDEX "car_rows_source_row_idx" ON "classroom_assignment_rows" USING btree ("source_row_id");--> statement-breakpoint
CREATE INDEX "car_rows_change_type_idx" ON "classroom_assignment_rows" USING btree ("change_type");--> statement-breakpoint
CREATE INDEX "car_automation_batch_idx" ON "classroom_assignment_runs" USING btree ("automation_batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ccsr_single_running_idx" ON "credit_control_sync_runs" USING btree ("status") WHERE "credit_control_sync_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "line_messages_classification_review_idx" ON "line_messages" USING btree ("classification_reviewed_category","classification_reviewed_at");--> statement-breakpoint
CREATE INDEX "line_scheduler_reviews_intent_idx" ON "line_scheduler_reviews" USING btree ("intent_type","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sdir_source_single_running_idx" ON "sales_dashboard_import_runs" USING btree ("source_id") WHERE "sales_dashboard_import_runs"."status" = 'running' AND "sales_dashboard_import_runs"."source_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "sds_source_month_active_idx" ON "sales_dashboard_sources" USING btree ("source_month") WHERE "sales_dashboard_sources"."archived_at" IS NULL;