CREATE TABLE "onsite_foot_traffic_report_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_by_email" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"payload" jsonb NOT NULL,
	"source_sync_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onsite_foot_traffic_sessions" (
	"wise_session_id" text PRIMARY KEY NOT NULL,
	"attendance_date" date NOT NULL,
	"scheduled_start_at" timestamp with time zone NOT NULL,
	"scheduled_end_at" timestamp with time zone NOT NULL,
	"wise_status" text NOT NULL,
	"session_type" text,
	"normalized_location" text,
	"room_name" text,
	"room_category" text,
	"subject" text,
	"tutor_name" text,
	"scheduled_student_count" integer,
	"participant_count" integer DEFAULT 0 NOT NULL,
	"counted_visit_count" integer DEFAULT 0 NOT NULL,
	"missing_attendance_evidence_count" integer DEFAULT 0 NOT NULL,
	"missing_stable_id_count" integer DEFAULT 0 NOT NULL,
	"is_counted_onsite" boolean DEFAULT false NOT NULL,
	"exclusion_reason" text,
	"last_sync_run_id" uuid NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onsite_foot_traffic_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "sync_status" DEFAULT 'running' NOT NULL,
	"trigger_type" text DEFAULT 'cron' NOT NULL,
	"actor_email" text,
	"mode" text DEFAULT 'rolling' NOT NULL,
	"requested_start_date" date NOT NULL,
	"requested_end_date" date NOT NULL,
	"fetched_session_count" integer DEFAULT 0 NOT NULL,
	"stored_session_count" integer DEFAULT 0 NOT NULL,
	"visit_count" integer DEFAULT 0 NOT NULL,
	"unknown_room_count" integer DEFAULT 0 NOT NULL,
	"missing_attendance_evidence_count" integer DEFAULT 0 NOT NULL,
	"missing_stable_id_count" integer DEFAULT 0 NOT NULL,
	"error_summary" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "onsite_foot_traffic_visits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wise_session_id" text NOT NULL,
	"participant_key" text NOT NULL,
	"student_fingerprint" text,
	"attendance_date" date NOT NULL,
	"consumed_credits" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "onsite_foot_traffic_report_snapshots" ADD CONSTRAINT "onsite_foot_traffic_report_snapshots_source_sync_run_id_onsite_foot_traffic_sync_runs_id_fk" FOREIGN KEY ("source_sync_run_id") REFERENCES "public"."onsite_foot_traffic_sync_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onsite_foot_traffic_sessions" ADD CONSTRAINT "onsite_foot_traffic_sessions_last_sync_run_id_onsite_foot_traffic_sync_runs_id_fk" FOREIGN KEY ("last_sync_run_id") REFERENCES "public"."onsite_foot_traffic_sync_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onsite_foot_traffic_visits" ADD CONSTRAINT "onsite_foot_traffic_visits_wise_session_id_onsite_foot_traffic_sessions_wise_session_id_fk" FOREIGN KEY ("wise_session_id") REFERENCES "public"."onsite_foot_traffic_sessions"("wise_session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oft_report_expiry_idx" ON "onsite_foot_traffic_report_snapshots" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oft_report_creator_idx" ON "onsite_foot_traffic_report_snapshots" USING btree ("created_by_email","created_at");--> statement-breakpoint
CREATE INDEX "oft_session_date_idx" ON "onsite_foot_traffic_sessions" USING btree ("attendance_date");--> statement-breakpoint
CREATE INDEX "oft_session_room_date_idx" ON "onsite_foot_traffic_sessions" USING btree ("room_name","attendance_date");--> statement-breakpoint
CREATE INDEX "oft_session_counted_date_idx" ON "onsite_foot_traffic_sessions" USING btree ("is_counted_onsite","attendance_date");--> statement-breakpoint
CREATE UNIQUE INDEX "oft_sync_single_running_idx" ON "onsite_foot_traffic_sync_runs" USING btree ("status") WHERE "onsite_foot_traffic_sync_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "oft_sync_status_started_idx" ON "onsite_foot_traffic_sync_runs" USING btree ("status","started_at");--> statement-breakpoint
CREATE INDEX "oft_sync_range_idx" ON "onsite_foot_traffic_sync_runs" USING btree ("requested_start_date","requested_end_date");--> statement-breakpoint
CREATE UNIQUE INDEX "oft_visit_session_participant_idx" ON "onsite_foot_traffic_visits" USING btree ("wise_session_id","participant_key");--> statement-breakpoint
CREATE INDEX "oft_visit_date_idx" ON "onsite_foot_traffic_visits" USING btree ("attendance_date");--> statement-breakpoint
CREATE INDEX "oft_visit_student_date_idx" ON "onsite_foot_traffic_visits" USING btree ("student_fingerprint","attendance_date");