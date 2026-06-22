CREATE TABLE "ipeds_completions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"data_year" text NOT NULL,
	"unit_id" integer NOT NULL,
	"import_run_id" uuid,
	"cip_code" text NOT NULL,
	"cip_title" text,
	"cip2" text NOT NULL,
	"award_level" integer,
	"award_level_label" text,
	"count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ipeds_import_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"data_year" text NOT NULL,
	"status" "sync_status" DEFAULT 'running' NOT NULL,
	"institution_count" integer DEFAULT 0 NOT NULL,
	"completion_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"error_summary" text,
	"triggered_by_email" text
);
--> statement-breakpoint
CREATE TABLE "ipeds_institutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"data_year" text NOT NULL,
	"unit_id" integer NOT NULL,
	"import_run_id" uuid,
	"inst_name" text NOT NULL,
	"alias" text,
	"city" text,
	"state_abbr" text,
	"zip" text,
	"region" integer,
	"website" text,
	"admissions_url" text,
	"net_price_calc_url" text,
	"control" integer,
	"sector" integer,
	"iclevel" integer,
	"locale" integer,
	"inst_size" integer,
	"hbcu" boolean,
	"land_grant" boolean,
	"carnegie_basic" integer,
	"latitude" double precision,
	"longitude" double precision,
	"county_name" text,
	"applicants_total" integer,
	"admits_total" integer,
	"enrolled_total" integer,
	"acceptance_rate" double precision,
	"yield_rate" double precision,
	"adm_considerations" jsonb,
	"sat_submit_pct" double precision,
	"act_submit_pct" double precision,
	"sat_reading_p25" integer,
	"sat_reading_p75" integer,
	"sat_math_p25" integer,
	"sat_math_p75" integer,
	"act_composite_p25" integer,
	"act_composite_p75" integer,
	"enrollment_total" integer,
	"enrollment_ug" integer,
	"enrollment_grad" integer,
	"fte" double precision,
	"pct_women" double precision,
	"pct_full_time_first_time" double precision,
	"pct_white" double precision,
	"pct_black" double precision,
	"pct_hispanic" double precision,
	"pct_asian_pac_isl" double precision,
	"pct_am_ind" double precision,
	"pct_two_or_more" double precision,
	"pct_unknown" double precision,
	"pct_nonresident" double precision,
	"pct_in_state" double precision,
	"pct_out_of_state" double precision,
	"retention_ft" double precision,
	"retention_pt" double precision,
	"student_faculty_ratio" double precision,
	"grad_rate_total" double precision,
	"grad_rate_bach_6yr" double precision,
	"transfer_out_rate" double precision,
	"om_award_8yr" double precision,
	"om_still_enrolled_8yr" double precision,
	"app_fee_ug" integer,
	"tuition_in_state" integer,
	"tuition_out_state" integer,
	"total_price_in_state" integer,
	"total_price_out_state" integer,
	"room_board_amt" integer,
	"avg_net_price" integer,
	"pct_awarded_aid" double precision,
	"avg_grant_aid" integer,
	"deg_bachelors" integer,
	"deg_masters" integer,
	"deg_doctoral" integer,
	"deg_associate" integer,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ipeds_completions" ADD CONSTRAINT "ipeds_completions_import_run_id_ipeds_import_runs_id_fk" FOREIGN KEY ("import_run_id") REFERENCES "public"."ipeds_import_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipeds_institutions" ADD CONSTRAINT "ipeds_institutions_import_run_id_ipeds_import_runs_id_fk" FOREIGN KEY ("import_run_id") REFERENCES "public"."ipeds_import_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ipeds_compl_year_unit_idx" ON "ipeds_completions" USING btree ("data_year","unit_id");--> statement-breakpoint
CREATE INDEX "ipeds_compl_year_cip2_idx" ON "ipeds_completions" USING btree ("data_year","cip2");--> statement-breakpoint
CREATE INDEX "ipeds_compl_year_unit_count_idx" ON "ipeds_completions" USING btree ("data_year","unit_id","count");--> statement-breakpoint
CREATE INDEX "ipeds_runs_year_started_idx" ON "ipeds_import_runs" USING btree ("data_year","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ipeds_runs_single_running_idx" ON "ipeds_import_runs" USING btree ("data_year") WHERE "ipeds_import_runs"."status" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "ipeds_inst_year_unit_idx" ON "ipeds_institutions" USING btree ("data_year","unit_id");--> statement-breakpoint
CREATE INDEX "ipeds_inst_year_state_idx" ON "ipeds_institutions" USING btree ("data_year","state_abbr");--> statement-breakpoint
CREATE INDEX "ipeds_inst_year_control_idx" ON "ipeds_institutions" USING btree ("data_year","control");--> statement-breakpoint
CREATE INDEX "ipeds_inst_year_acceptance_idx" ON "ipeds_institutions" USING btree ("data_year","acceptance_rate");