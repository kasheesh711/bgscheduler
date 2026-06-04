CREATE TABLE "cron_invocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_key" text NOT NULL,
	"path" text NOT NULL,
	"schedule" text,
	"trigger_source" text DEFAULT 'cron' NOT NULL,
	"actor_email" text,
	"request_method" text DEFAULT 'GET' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"response_status" integer,
	"outcome" text DEFAULT 'running' NOT NULL,
	"error_summary" text,
	"linked_run_ids" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "cron_invocations_job_received_idx" ON "cron_invocations" USING btree ("job_key","received_at");
--> statement-breakpoint
CREATE INDEX "cron_invocations_outcome_received_idx" ON "cron_invocations" USING btree ("outcome","received_at");
--> statement-breakpoint
CREATE INDEX "cron_invocations_trigger_received_idx" ON "cron_invocations" USING btree ("trigger_source","received_at");
