CREATE TABLE "room_capacity_model_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_label" text NOT NULL,
	"source_fingerprint" text NOT NULL,
	"forecast_start" date NOT NULL,
	"forecast_end" date NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_capacity_forecast_drivers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_run_id" uuid NOT NULL,
	"scenario" text NOT NULL,
	"month" date NOT NULL,
	"leads" double precision DEFAULT 0 NOT NULL,
	"lead_to_paid_conversion" double precision DEFAULT 0 NOT NULL,
	"new_paid_students" double precision DEFAULT 0 NOT NULL,
	"active_base_prior_month" double precision DEFAULT 0 NOT NULL,
	"projected_revenue_thb" double precision DEFAULT 0 NOT NULL,
	"uncapped_revenue_thb" double precision DEFAULT 0 NOT NULL,
	"forecast_consumed_hours" double precision DEFAULT 0 NOT NULL,
	"scheduled_hours" double precision DEFAULT 0 NOT NULL,
	"teacher_capacity_hours" double precision DEFAULT 0 NOT NULL,
	"capacity_utilization_pct" double precision DEFAULT 0 NOT NULL,
	"capacity_exceeded" boolean DEFAULT false NOT NULL,
	"seasonality_index" double precision DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_capacity_demand_mix" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_run_id" uuid NOT NULL,
	"weekday" integer NOT NULL,
	"start_minute" integer NOT NULL,
	"duration_minutes" integer NOT NULL,
	"mode" text NOT NULL,
	"student_count" integer DEFAULT 1 NOT NULL,
	"subject" text,
	"class_type" text,
	"share" double precision NOT NULL,
	"observed_sessions" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "room_capacity_forecast_drivers" ADD CONSTRAINT "room_capacity_forecast_drivers_model_run_id_room_capacity_model_runs_id_fk" FOREIGN KEY ("model_run_id") REFERENCES "public"."room_capacity_model_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_capacity_demand_mix" ADD CONSTRAINT "room_capacity_demand_mix_model_run_id_room_capacity_model_runs_id_fk" FOREIGN KEY ("model_run_id") REFERENCES "public"."room_capacity_model_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rcmr_created_at_idx" ON "room_capacity_model_runs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "rcmr_source_fingerprint_idx" ON "room_capacity_model_runs" USING btree ("source_fingerprint");--> statement-breakpoint
CREATE INDEX "rcfd_model_run_idx" ON "room_capacity_forecast_drivers" USING btree ("model_run_id");--> statement-breakpoint
CREATE INDEX "rcfd_scenario_month_idx" ON "room_capacity_forecast_drivers" USING btree ("model_run_id","scenario","month");--> statement-breakpoint
CREATE INDEX "rcdm_model_run_idx" ON "room_capacity_demand_mix" USING btree ("model_run_id");--> statement-breakpoint
CREATE INDEX "rcdm_weekday_idx" ON "room_capacity_demand_mix" USING btree ("model_run_id","weekday");
