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
ALTER TABLE "sales_dashboard_projection_import_runs" ADD CONSTRAINT "sales_dashboard_projection_import_runs_source_id_sales_dashboard_projection_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sales_dashboard_projection_sources"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales_dashboard_projection_months" ADD CONSTRAINT "sales_dashboard_projection_months_source_id_sales_dashboard_projection_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sales_dashboard_projection_sources"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales_dashboard_projection_months" ADD CONSTRAINT "sales_dashboard_projection_months_import_run_id_sales_dashboard_projection_import_runs_id_fk" FOREIGN KEY ("import_run_id") REFERENCES "public"."sales_dashboard_projection_import_runs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "sdps_single_active_idx" ON "sales_dashboard_projection_sources" USING btree ("status") WHERE "status" = 'active';
--> statement-breakpoint
CREATE INDEX "sdps_connected_email_idx" ON "sales_dashboard_projection_sources" USING btree ("connected_email");
--> statement-breakpoint
CREATE INDEX "sdpir_source_started_idx" ON "sales_dashboard_projection_import_runs" USING btree ("source_id","started_at");
--> statement-breakpoint
CREATE INDEX "sdpir_status_started_idx" ON "sales_dashboard_projection_import_runs" USING btree ("status","started_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "sdpir_source_single_running_idx" ON "sales_dashboard_projection_import_runs" USING btree ("source_id") WHERE "status" = 'running' AND "source_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "sdpm_run_scenario_month_idx" ON "sales_dashboard_projection_months" USING btree ("import_run_id","scenario","projection_month");
--> statement-breakpoint
CREATE INDEX "sdpm_source_run_idx" ON "sales_dashboard_projection_months" USING btree ("source_id","import_run_id");
--> statement-breakpoint
CREATE INDEX "sdpm_month_idx" ON "sales_dashboard_projection_months" USING btree ("projection_month");
--> statement-breakpoint
CREATE INDEX "sdpm_scenario_month_idx" ON "sales_dashboard_projection_months" USING btree ("scenario","projection_month");
