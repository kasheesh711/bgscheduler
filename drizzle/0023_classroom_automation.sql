ALTER TABLE "classroom_assignment_runs" ADD COLUMN "source_run_id" uuid;
--> statement-breakpoint
ALTER TABLE "classroom_assignment_runs" ADD COLUMN "automation_batch_id" uuid;
--> statement-breakpoint
ALTER TABLE "classroom_assignment_runs" ADD COLUMN "reconciliation_mode" text;
--> statement-breakpoint
ALTER TABLE "classroom_assignment_runs" ADD COLUMN "change_summary" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "classroom_assignment_rows" ADD COLUMN "source_row_id" uuid;
--> statement-breakpoint
ALTER TABLE "classroom_assignment_rows" ADD COLUMN "change_type" text DEFAULT 'manual' NOT NULL;
--> statement-breakpoint
ALTER TABLE "classroom_assignment_rows" ADD COLUMN "assignment_fingerprint" text;
--> statement-breakpoint
ALTER TABLE "classroom_publish_jobs" ADD COLUMN "target_row_ids" jsonb;
--> statement-breakpoint
CREATE TABLE "classroom_automation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_batch_id" uuid NOT NULL,
	"assignment_run_id" uuid,
	"assignment_date" date NOT NULL,
	"event_type" text NOT NULL,
	"wise_session_id" text,
	"source_row_id" uuid,
	"target_row_id" uuid,
	"message" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "classroom_admin_email_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assignment_date" date NOT NULL,
	"assignment_run_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"subject" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"trigger_kind" text DEFAULT 'ready' NOT NULL,
	"created_by" text,
	"attempted_count" integer DEFAULT 0 NOT NULL,
	"success_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "classroom_admin_email_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_run_id" uuid NOT NULL,
	"assignment_date" date NOT NULL,
	"recipient_email" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider_message_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "classroom_automation_events" ADD CONSTRAINT "classroom_automation_events_assignment_run_id_classroom_assignment_runs_id_fk" FOREIGN KEY ("assignment_run_id") REFERENCES "public"."classroom_assignment_runs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "classroom_admin_email_runs" ADD CONSTRAINT "classroom_admin_email_runs_assignment_run_id_classroom_assignment_runs_id_fk" FOREIGN KEY ("assignment_run_id") REFERENCES "public"."classroom_assignment_runs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "classroom_admin_email_recipients" ADD CONSTRAINT "classroom_admin_email_recipients_email_run_id_classroom_admin_email_runs_id_fk" FOREIGN KEY ("email_run_id") REFERENCES "public"."classroom_admin_email_runs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "car_automation_batch_idx" ON "classroom_assignment_runs" USING btree ("automation_batch_id");
--> statement-breakpoint
CREATE INDEX "car_rows_source_row_idx" ON "classroom_assignment_rows" USING btree ("source_row_id");
--> statement-breakpoint
CREATE INDEX "car_rows_change_type_idx" ON "classroom_assignment_rows" USING btree ("change_type");
--> statement-breakpoint
CREATE INDEX "cae_batch_idx" ON "classroom_automation_events" USING btree ("automation_batch_id");
--> statement-breakpoint
CREATE INDEX "cae_run_idx" ON "classroom_automation_events" USING btree ("assignment_run_id");
--> statement-breakpoint
CREATE INDEX "cae_date_idx" ON "classroom_automation_events" USING btree ("assignment_date");
--> statement-breakpoint
CREATE INDEX "cae_type_idx" ON "classroom_automation_events" USING btree ("event_type");
--> statement-breakpoint
CREATE UNIQUE INDEX "caer_idempotency_idx" ON "classroom_admin_email_runs" USING btree ("idempotency_key");
--> statement-breakpoint
CREATE INDEX "caer_date_idx" ON "classroom_admin_email_runs" USING btree ("assignment_date");
--> statement-breakpoint
CREATE INDEX "caer_assignment_run_idx" ON "classroom_admin_email_runs" USING btree ("assignment_run_id");
--> statement-breakpoint
CREATE INDEX "caer_recipients_email_run_idx" ON "classroom_admin_email_recipients" USING btree ("email_run_id");
--> statement-breakpoint
CREATE INDEX "caer_recipients_date_idx" ON "classroom_admin_email_recipients" USING btree ("assignment_date");
--> statement-breakpoint
CREATE INDEX "caer_recipients_email_idx" ON "classroom_admin_email_recipients" USING btree ("recipient_email");
