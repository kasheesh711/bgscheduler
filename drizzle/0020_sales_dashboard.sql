CREATE TYPE "public"."sales_dashboard_source_status" AS ENUM('active', 'refreshing', 'finalized', 'reopened');--> statement-breakpoint
CREATE TABLE "google_oauth_tokens" (
	"email" text PRIMARY KEY NOT NULL,
	"access_token_ciphertext" text,
	"refresh_token_ciphertext" text,
	"expires_at" timestamp with time zone,
	"scope" text,
	"token_type" text,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_dashboard_additional_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"import_run_id" uuid NOT NULL,
	"source_month" date NOT NULL,
	"row_number" integer NOT NULL,
	"student_nickname" text NOT NULL,
	"sales_type" text DEFAULT '' NOT NULL,
	"package_name" text DEFAULT '' NOT NULL,
	"payment_amount" double precision DEFAULT 0 NOT NULL,
	"payment_date" date NOT NULL,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_dashboard_import_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid,
	"status" "sync_status" DEFAULT 'running' NOT NULL,
	"trigger_type" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"source_count" integer DEFAULT 0 NOT NULL,
	"normal_row_count" integer DEFAULT 0 NOT NULL,
	"additional_row_count" integer DEFAULT 0 NOT NULL,
	"error_summary" text,
	"actor_email" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_dashboard_normal_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"import_run_id" uuid NOT NULL,
	"source_month" date NOT NULL,
	"row_number" integer NOT NULL,
	"student_nickname" text NOT NULL,
	"program" text DEFAULT '' NOT NULL,
	"package_hours" text DEFAULT '' NOT NULL,
	"number_of_students" double precision DEFAULT 0 NOT NULL,
	"payment_amount" double precision DEFAULT 0 NOT NULL,
	"sales_representative" text DEFAULT '' NOT NULL,
	"payment_date" date NOT NULL,
	"enrollment_type" text DEFAULT '' NOT NULL,
	"program_wise_name" text DEFAULT '' NOT NULL,
	"package_hours_clean" text DEFAULT '' NOT NULL,
	"valid_until" date,
	"churn_status" text DEFAULT '' NOT NULL,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_dashboard_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_month" date NOT NULL,
	"label" text NOT NULL,
	"spreadsheet_id" text NOT NULL,
	"spreadsheet_url" text NOT NULL,
	"normal_sheet_name" text,
	"additional_sheet_name" text,
	"status" "sales_dashboard_source_status" DEFAULT 'active' NOT NULL,
	"last_successful_import_run_id" uuid,
	"last_imported_at" timestamp with time zone,
	"last_import_error" text,
	"last_normal_row_count" integer DEFAULT 0 NOT NULL,
	"last_additional_row_count" integer DEFAULT 0 NOT NULL,
	"finalized_at" timestamp with time zone,
	"reopened_at" timestamp with time zone,
	"connected_email" text NOT NULL,
	"created_by_email" text NOT NULL,
	"updated_by_email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sales_dashboard_additional_rows" ADD CONSTRAINT "sales_dashboard_additional_rows_source_id_sales_dashboard_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sales_dashboard_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_dashboard_additional_rows" ADD CONSTRAINT "sales_dashboard_additional_rows_import_run_id_sales_dashboard_import_runs_id_fk" FOREIGN KEY ("import_run_id") REFERENCES "public"."sales_dashboard_import_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_dashboard_import_runs" ADD CONSTRAINT "sales_dashboard_import_runs_source_id_sales_dashboard_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sales_dashboard_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_dashboard_normal_rows" ADD CONSTRAINT "sales_dashboard_normal_rows_source_id_sales_dashboard_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sales_dashboard_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_dashboard_normal_rows" ADD CONSTRAINT "sales_dashboard_normal_rows_import_run_id_sales_dashboard_import_runs_id_fk" FOREIGN KEY ("import_run_id") REFERENCES "public"."sales_dashboard_import_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sdar_run_row_idx" ON "sales_dashboard_additional_rows" USING btree ("import_run_id","row_number");--> statement-breakpoint
CREATE INDEX "sdar_source_run_idx" ON "sales_dashboard_additional_rows" USING btree ("source_id","import_run_id");--> statement-breakpoint
CREATE INDEX "sdar_payment_date_idx" ON "sales_dashboard_additional_rows" USING btree ("payment_date");--> statement-breakpoint
CREATE INDEX "sdar_source_month_idx" ON "sales_dashboard_additional_rows" USING btree ("source_month");--> statement-breakpoint
CREATE INDEX "sdir_source_started_idx" ON "sales_dashboard_import_runs" USING btree ("source_id","started_at");--> statement-breakpoint
CREATE INDEX "sdir_status_started_idx" ON "sales_dashboard_import_runs" USING btree ("status","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sdnr_run_row_idx" ON "sales_dashboard_normal_rows" USING btree ("import_run_id","row_number");--> statement-breakpoint
CREATE INDEX "sdnr_source_run_idx" ON "sales_dashboard_normal_rows" USING btree ("source_id","import_run_id");--> statement-breakpoint
CREATE INDEX "sdnr_payment_date_idx" ON "sales_dashboard_normal_rows" USING btree ("payment_date");--> statement-breakpoint
CREATE INDEX "sdnr_source_month_idx" ON "sales_dashboard_normal_rows" USING btree ("source_month");--> statement-breakpoint
CREATE UNIQUE INDEX "sds_source_month_idx" ON "sales_dashboard_sources" USING btree ("source_month");--> statement-breakpoint
CREATE INDEX "sds_status_month_idx" ON "sales_dashboard_sources" USING btree ("status","source_month");--> statement-breakpoint
CREATE INDEX "sds_connected_email_idx" ON "sales_dashboard_sources" USING btree ("connected_email");