CREATE TABLE "unearned_revenue_package_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"period_end" date NOT NULL,
	"period_kind" text NOT NULL,
	"is_latest" boolean DEFAULT false NOT NULL,
	"package_name" text NOT NULL,
	"opening_liability_thb" numeric(20, 8) NOT NULL,
	"deferred_new_liability_thb" numeric(20, 8) NOT NULL,
	"recognized_revenue_thb" numeric(20, 8) NOT NULL,
	"automatic_exact_liability_thb" numeric(20, 8) NOT NULL,
	"finance_reviewed_liability_thb" numeric(20, 8) NOT NULL,
	"closing_exact_liability_thb" numeric(20, 8) NOT NULL,
	"remaining_credits" numeric(20, 8) NOT NULL,
	"student_count" integer NOT NULL,
	"account_count" integer NOT NULL,
	"active_lot_count" integer NOT NULL,
	"share_of_exact_liability" numeric(20, 8) NOT NULL,
	"trace_spreadsheet_id" text NOT NULL,
	"trace_sheet_id" integer NOT NULL,
	"trace_row" integer NOT NULL,
	"trace_a1" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "unearned_revenue_package_periods" ADD CONSTRAINT "unearned_revenue_package_periods_snapshot_id_unearned_revenue_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."unearned_revenue_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ur_package_snapshot_period_name_idx" ON "unearned_revenue_package_periods" USING btree ("snapshot_id","period_end","package_name");--> statement-breakpoint
CREATE INDEX "ur_package_period_liability_idx" ON "unearned_revenue_package_periods" USING btree ("snapshot_id","period_end","closing_exact_liability_thb");