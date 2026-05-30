CREATE TYPE "public"."payroll_review_status" AS ENUM('draft', 'approved');--> statement-breakpoint
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
ALTER TABLE "payroll_reviews" ADD CONSTRAINT "payroll_reviews_last_sync_run_id_payroll_sync_runs_id_fk" FOREIGN KEY ("last_sync_run_id") REFERENCES "public"."payroll_sync_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_teacher_tiers" ADD CONSTRAINT "payroll_teacher_tiers_sync_run_id_payroll_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."payroll_sync_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_payout_invoices" ADD CONSTRAINT "payroll_payout_invoices_sync_run_id_payroll_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."payroll_sync_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_session_observations" ADD CONSTRAINT "payroll_session_observations_sync_run_id_payroll_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."payroll_sync_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_sync_runs_single_running_idx" ON "payroll_sync_runs" USING btree ("status") WHERE "payroll_sync_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "payroll_sync_runs_month_idx" ON "payroll_sync_runs" USING btree ("payroll_month","started_at");--> statement-breakpoint
CREATE INDEX "payroll_sync_runs_status_idx" ON "payroll_sync_runs" USING btree ("status","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_reviews_month_idx" ON "payroll_reviews" USING btree ("payroll_month");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_teacher_tiers_month_teacher_idx" ON "payroll_teacher_tiers" USING btree ("payroll_month","wise_teacher_id");--> statement-breakpoint
CREATE INDEX "payroll_teacher_tiers_month_user_idx" ON "payroll_teacher_tiers" USING btree ("payroll_month","wise_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_payout_invoices_event_idx" ON "payroll_payout_invoices" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_payout_invoices_transaction_idx" ON "payroll_payout_invoices" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "payroll_payout_invoices_month_idx" ON "payroll_payout_invoices" USING btree ("payroll_month");--> statement-breakpoint
CREATE INDEX "payroll_payout_invoices_month_teacher_idx" ON "payroll_payout_invoices" USING btree ("payroll_month","wise_teacher_user_id");--> statement-breakpoint
CREATE INDEX "payroll_payout_invoices_session_idx" ON "payroll_payout_invoices" USING btree ("wise_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_session_observations_month_session_idx" ON "payroll_session_observations" USING btree ("payroll_month","wise_session_id");--> statement-breakpoint
CREATE INDEX "payroll_session_observations_month_teacher_idx" ON "payroll_session_observations" USING btree ("payroll_month","wise_teacher_user_id");--> statement-breakpoint
CREATE INDEX "payroll_session_observations_month_group_idx" ON "payroll_session_observations" USING btree ("payroll_month","tutor_group_canonical_key");--> statement-breakpoint
CREATE INDEX "payroll_adjustments_month_idx" ON "payroll_adjustments" USING btree ("payroll_month","created_at");
