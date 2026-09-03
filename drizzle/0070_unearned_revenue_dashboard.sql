CREATE TABLE "unearned_revenue_access_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_email" text NOT NULL,
	"action" text NOT NULL,
	"actor_email" text NOT NULL,
	"before_value" jsonb,
	"after_value" jsonb,
	"version" integer NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unearned_revenue_access_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"capability" text NOT NULL,
	"granted_by_email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ur_access_capability_check" CHECK ("unearned_revenue_access_grants"."capability" in ('viewer', 'access_manager'))
);
--> statement-breakpoint
CREATE TABLE "unearned_revenue_account_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"period_end" date NOT NULL,
	"account_id" text NOT NULL,
	"student_id" text NOT NULL,
	"class_id" text NOT NULL,
	"student_name" text NOT NULL,
	"class_name" text NOT NULL,
	"class_subject" text DEFAULT '' NOT NULL,
	"ledger_remaining_credits" numeric(20, 8) NOT NULL,
	"opening_paid_credits" numeric(20, 8) NOT NULL,
	"deferred_paid_credits" numeric(20, 8) NOT NULL,
	"recognized_paid_credits" numeric(20, 8) NOT NULL,
	"closing_paid_credits" numeric(20, 8) NOT NULL,
	"legacy_closing_liability_thb" numeric(20, 8) NOT NULL,
	"fifo_opening_liability_thb" numeric(20, 8) NOT NULL,
	"fifo_deferred_new_liability_thb" numeric(20, 8) NOT NULL,
	"fifo_recognized_revenue_thb" numeric(20, 8) NOT NULL,
	"fifo_closing_liability_thb" numeric(20, 8) NOT NULL,
	"canonical_closing_liability_thb" numeric(20, 8) NOT NULL,
	"attributed_liability_thb" numeric(20, 8) NOT NULL,
	"residual_liability_thb" numeric(20, 8) NOT NULL,
	"review_state" text NOT NULL,
	"trace_spreadsheet_id" text NOT NULL,
	"trace_sheet_id" integer NOT NULL,
	"trace_row" integer NOT NULL,
	"trace_a1" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unearned_revenue_lot_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"period_end" date NOT NULL,
	"lot_id" text NOT NULL,
	"account_id" text NOT NULL,
	"student_id" text NOT NULL,
	"class_id" text NOT NULL,
	"student_name" text NOT NULL,
	"class_name" text NOT NULL,
	"lot_kind" text NOT NULL,
	"match_status" text NOT NULL,
	"review_state" text NOT NULL,
	"package_name" text NOT NULL,
	"transaction_number" text DEFAULT '' NOT NULL,
	"sales_key" text DEFAULT '' NOT NULL,
	"transaction_date" date,
	"credit_event_key" text DEFAULT '' NOT NULL,
	"original_credits" numeric(20, 8) NOT NULL,
	"package_credits" numeric(20, 8) NOT NULL,
	"negative_recovery_credits" numeric(20, 8) NOT NULL,
	"opening_credits" numeric(20, 8) NOT NULL,
	"deferred_credits" numeric(20, 8) NOT NULL,
	"recognized_credits" numeric(20, 8) NOT NULL,
	"remaining_credits" numeric(20, 8) NOT NULL,
	"unit_rate_thb" numeric(20, 8) NOT NULL,
	"net_payment_thb" numeric(20, 8) NOT NULL,
	"opening_liability_thb" numeric(20, 8) NOT NULL,
	"deferred_new_liability_thb" numeric(20, 8) NOT NULL,
	"recognized_revenue_thb" numeric(20, 8) NOT NULL,
	"closing_liability_thb" numeric(20, 8) NOT NULL,
	"candidate_sales_keys" text DEFAULT '' NOT NULL,
	"formula_spreadsheet_id" text NOT NULL,
	"formula_sheet_id" integer NOT NULL,
	"formula_row" integer NOT NULL,
	"formula_a1" text NOT NULL,
	"source_spreadsheet_id" text,
	"source_sheet_id" integer,
	"source_row" integer,
	"source_a1" text
);
--> statement-breakpoint
CREATE TABLE "unearned_revenue_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"period_end" date NOT NULL,
	"period_kind" text NOT NULL,
	"is_latest" boolean DEFAULT false NOT NULL,
	"opening_liability_thb" numeric(20, 8) NOT NULL,
	"deferred_new_liability_thb" numeric(20, 8) NOT NULL,
	"recognized_revenue_thb" numeric(20, 8) NOT NULL,
	"closing_liability_thb" numeric(20, 8) NOT NULL,
	"legacy_closing_liability_thb" numeric(20, 8) NOT NULL,
	"fifo_closing_liability_thb" numeric(20, 8) NOT NULL,
	"fifo_vs_legacy_difference_thb" numeric(20, 8) NOT NULL,
	"remaining_paid_credits" numeric(20, 8) NOT NULL,
	"attributed_liability_thb" numeric(20, 8) NOT NULL,
	"residual_liability_thb" numeric(20, 8) NOT NULL,
	"attribution_percent" numeric(20, 8) NOT NULL,
	"student_count" integer NOT NULL,
	"account_count" integer NOT NULL,
	"ambiguous_count" integer DEFAULT 0 NOT NULL,
	"unattributed_count" integer DEFAULT 0 NOT NULL,
	"fallback_valued_count" integer DEFAULT 0 NOT NULL,
	"negative_balance_count" integer DEFAULT 0 NOT NULL,
	"api_variance_count" integer DEFAULT 0 NOT NULL,
	"trace_spreadsheet_id" text NOT NULL,
	"trace_sheet_id" integer NOT NULL,
	"trace_row" integer NOT NULL,
	"trace_a1" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unearned_revenue_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sync_run_id" uuid NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"spreadsheet_id" text NOT NULL,
	"source_run_id" text NOT NULL,
	"source_fingerprint" text NOT NULL,
	"source_revision" text NOT NULL,
	"cutoff" date NOT NULL,
	"generated_at_bangkok" timestamp with time zone NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workbook_schema_version" integer NOT NULL,
	"canonical_model" text NOT NULL,
	"model_version" text NOT NULL,
	"model_mode" text NOT NULL,
	"review_conditions" text[] DEFAULT '{}'::text[] NOT NULL,
	"sheet_ids" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"row_counts" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unearned_revenue_student_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"period_end" date NOT NULL,
	"period_kind" text NOT NULL,
	"is_latest" boolean DEFAULT false NOT NULL,
	"student_id" text NOT NULL,
	"student_name" text NOT NULL,
	"parent_name" text DEFAULT '' NOT NULL,
	"account_count" integer NOT NULL,
	"ledger_remaining_credits" numeric(20, 8) NOT NULL,
	"remaining_paid_credits" numeric(20, 8) NOT NULL,
	"legacy_closing_liability_thb" numeric(20, 8) NOT NULL,
	"fifo_opening_liability_thb" numeric(20, 8) NOT NULL,
	"fifo_deferred_new_liability_thb" numeric(20, 8) NOT NULL,
	"fifo_recognized_revenue_thb" numeric(20, 8) NOT NULL,
	"fifo_closing_liability_thb" numeric(20, 8) NOT NULL,
	"canonical_closing_liability_thb" numeric(20, 8) NOT NULL,
	"attributed_liability_thb" numeric(20, 8) NOT NULL,
	"residual_liability_thb" numeric(20, 8) NOT NULL,
	"attribution_percent" numeric(20, 8) NOT NULL,
	"review_state" text NOT NULL,
	"trace_spreadsheet_id" text NOT NULL,
	"trace_sheet_id" integer NOT NULL,
	"trace_row" integer NOT NULL,
	"trace_a1" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unearned_revenue_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "sync_status" DEFAULT 'running' NOT NULL,
	"trigger_type" text DEFAULT 'cron' NOT NULL,
	"actor_email" text,
	"spreadsheet_id" text NOT NULL,
	"source_run_id" text,
	"source_fingerprint" text,
	"source_revision" text,
	"cutoff" date,
	"imported_snapshot_id" uuid,
	"period_count" integer DEFAULT 0 NOT NULL,
	"student_row_count" integer DEFAULT 0 NOT NULL,
	"account_row_count" integer DEFAULT 0 NOT NULL,
	"lot_row_count" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_summary" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "unearned_revenue_account_periods" ADD CONSTRAINT "unearned_revenue_account_periods_snapshot_id_unearned_revenue_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."unearned_revenue_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unearned_revenue_lot_periods" ADD CONSTRAINT "unearned_revenue_lot_periods_snapshot_id_unearned_revenue_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."unearned_revenue_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unearned_revenue_periods" ADD CONSTRAINT "unearned_revenue_periods_snapshot_id_unearned_revenue_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."unearned_revenue_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unearned_revenue_snapshots" ADD CONSTRAINT "unearned_revenue_snapshots_sync_run_id_unearned_revenue_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."unearned_revenue_sync_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unearned_revenue_student_periods" ADD CONSTRAINT "unearned_revenue_student_periods_snapshot_id_unearned_revenue_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."unearned_revenue_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ur_access_audit_target_idx" ON "unearned_revenue_access_audit_log" USING btree ("target_email","created_at");--> statement-breakpoint
CREATE INDEX "ur_access_audit_actor_idx" ON "unearned_revenue_access_audit_log" USING btree ("actor_email","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ur_access_email_capability_idx" ON "unearned_revenue_access_grants" USING btree ("email","capability");--> statement-breakpoint
CREATE INDEX "ur_access_capability_idx" ON "unearned_revenue_access_grants" USING btree ("capability","email");--> statement-breakpoint
CREATE UNIQUE INDEX "ur_account_snapshot_period_idx" ON "unearned_revenue_account_periods" USING btree ("snapshot_id","period_end","account_id");--> statement-breakpoint
CREATE INDEX "ur_account_student_period_idx" ON "unearned_revenue_account_periods" USING btree ("snapshot_id","period_end","student_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ur_lot_snapshot_period_idx" ON "unearned_revenue_lot_periods" USING btree ("snapshot_id","period_end","lot_id");--> statement-breakpoint
CREATE INDEX "ur_lot_student_period_idx" ON "unearned_revenue_lot_periods" USING btree ("snapshot_id","period_end","student_id");--> statement-breakpoint
CREATE INDEX "ur_lot_account_period_idx" ON "unearned_revenue_lot_periods" USING btree ("snapshot_id","period_end","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ur_period_snapshot_end_idx" ON "unearned_revenue_periods" USING btree ("snapshot_id","period_end");--> statement-breakpoint
CREATE INDEX "ur_period_latest_idx" ON "unearned_revenue_periods" USING btree ("snapshot_id","is_latest");--> statement-breakpoint
CREATE UNIQUE INDEX "ur_snapshot_source_contract_idx" ON "unearned_revenue_snapshots" USING btree ("source_run_id","source_fingerprint","source_revision","cutoff");--> statement-breakpoint
CREATE UNIQUE INDEX "ur_snapshot_one_active_idx" ON "unearned_revenue_snapshots" USING btree ("active") WHERE "unearned_revenue_snapshots"."active" = true;--> statement-breakpoint
CREATE INDEX "ur_snapshot_cutoff_idx" ON "unearned_revenue_snapshots" USING btree ("cutoff","imported_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ur_student_snapshot_period_idx" ON "unearned_revenue_student_periods" USING btree ("snapshot_id","period_end","student_id");--> statement-breakpoint
CREATE INDEX "ur_student_period_liability_idx" ON "unearned_revenue_student_periods" USING btree ("snapshot_id","period_end","canonical_closing_liability_thb");--> statement-breakpoint
CREATE INDEX "ur_student_name_idx" ON "unearned_revenue_student_periods" USING btree ("snapshot_id","student_name");--> statement-breakpoint
CREATE UNIQUE INDEX "ur_sync_single_running_idx" ON "unearned_revenue_sync_runs" USING btree ("status") WHERE "unearned_revenue_sync_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "ur_sync_status_started_idx" ON "unearned_revenue_sync_runs" USING btree ("status","started_at");
--> statement-breakpoint
INSERT INTO "unearned_revenue_access_grants" ("email", "capability", "granted_by_email")
SELECT 'kevhsh7@gmail.com', capability, 'kevhsh7@gmail.com'
FROM (VALUES ('viewer'), ('access_manager')) AS seed(capability)
WHERE EXISTS (
	SELECT 1 FROM "admin_users" WHERE lower(btrim("email")) = 'kevhsh7@gmail.com'
)
ON CONFLICT ("email", "capability") DO NOTHING;
