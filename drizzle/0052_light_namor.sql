CREATE TABLE "admissions_notification_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid,
	"recipient_email" text NOT NULL,
	"category" text NOT NULL,
	"tier" text NOT NULL,
	"subject" text NOT NULL,
	"resend_email_id" text,
	"dedupe_key" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admissions_notification_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "sync_status" DEFAULT 'running' NOT NULL,
	"run_type" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"sent_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"error_summary" text
);
--> statement-breakpoint
ALTER TABLE "admissions_case_members" ADD COLUMN "notification_prefs" jsonb;--> statement-breakpoint
ALTER TABLE "admissions_notification_log" ADD CONSTRAINT "admissions_notification_log_case_id_admissions_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."admissions_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admissions_notification_log_recipient_sent_idx" ON "admissions_notification_log" USING btree ("recipient_email","sent_at");--> statement-breakpoint
CREATE UNIQUE INDEX "admissions_notification_log_dedupe_key_idx" ON "admissions_notification_log" USING btree ("dedupe_key") WHERE "admissions_notification_log"."dedupe_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "admissions_notification_runs_single_running_idx" ON "admissions_notification_runs" USING btree ("status") WHERE "admissions_notification_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "admissions_notification_runs_status_started_idx" ON "admissions_notification_runs" USING btree ("status","started_at");