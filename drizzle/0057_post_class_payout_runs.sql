CREATE TYPE "public"."post_class_payout_run_status" AS ENUM('draft', 'published');--> statement-breakpoint
CREATE TYPE "public"."post_class_payout_match_status" AS ENUM('pending', 'matched', 'unmatched', 'ambiguous', 'no_sheet');--> statement-breakpoint
CREATE TYPE "public"."post_class_payout_write_status" AS ENUM('pending', 'written', 'failed', 'skipped');--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "post_class_payout_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"anchor_month" date NOT NULL,
	"window_start" date NOT NULL,
	"window_end" date NOT NULL,
	"status" "post_class_payout_run_status" DEFAULT 'draft' NOT NULL,
	"published_by_email" text,
	"published_at" timestamp with time zone,
	"csv_file_id" text,
	"csv_url" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "post_class_tutor_payout_sheets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canonical_key" text NOT NULL,
	"spreadsheet_id" text NOT NULL,
	"sheet_name" text NOT NULL,
	"sheet_gid" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"updated_by_email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "post_class_payout_run_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"deduction_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"canonical_tutor_key" text,
	"tutor_name" text,
	"wise_session_id" text NOT NULL,
	"student_names" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scheduled_start_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"tutor_submitted_at" timestamp with time zone,
	"amount_minor" integer NOT NULL,
	"currency" text DEFAULT 'THB' NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"match_status" "post_class_payout_match_status" DEFAULT 'pending' NOT NULL,
	"spreadsheet_id" text,
	"sheet_name" text,
	"matched_row_number" integer,
	"inserted_row_number" integer,
	"write_status" "post_class_payout_write_status" DEFAULT 'pending' NOT NULL,
	"write_error" text,
	"written_at" timestamp with time zone,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "post_class_payout_run_lines"
	ADD CONSTRAINT "pc_payout_run_lines_run_fk"
	FOREIGN KEY ("run_id") REFERENCES "public"."post_class_payout_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_class_payout_run_lines"
	ADD CONSTRAINT "pc_payout_run_lines_deduction_fk"
	FOREIGN KEY ("deduction_id") REFERENCES "public"."post_class_deductions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_class_payout_run_lines"
	ADD CONSTRAINT "pc_payout_run_lines_session_fk"
	FOREIGN KEY ("session_id") REFERENCES "public"."post_class_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "pc_payout_runs_window_idx" ON "post_class_payout_runs" ("window_start","window_end");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pc_payout_runs_anchor_idx" ON "post_class_payout_runs" ("anchor_month");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pc_payout_runs_status_idx" ON "post_class_payout_runs" ("status","window_end");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pc_tutor_payout_sheets_key_idx" ON "post_class_tutor_payout_sheets" ("canonical_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pc_tutor_payout_sheets_active_idx" ON "post_class_tutor_payout_sheets" ("active","canonical_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pc_payout_run_lines_run_deduction_idx" ON "post_class_payout_run_lines" ("run_id","deduction_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pc_payout_run_lines_idempotency_idx" ON "post_class_payout_run_lines" ("idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pc_payout_run_lines_run_status_idx" ON "post_class_payout_run_lines" ("run_id","write_status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pc_payout_run_lines_tutor_idx" ON "post_class_payout_run_lines" ("run_id","canonical_tutor_key");
