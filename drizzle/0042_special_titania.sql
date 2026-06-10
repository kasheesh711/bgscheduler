CREATE TABLE "line_backlog_recovery_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "sync_status" DEFAULT 'running' NOT NULL,
	"trigger_type" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"follower_count" integer DEFAULT 0 NOT NULL,
	"targets_count" integer DEFAULT 0 NOT NULL,
	"matched_count" integer DEFAULT 0 NOT NULL,
	"inserted_count" integer DEFAULT 0 NOT NULL,
	"dry_run" boolean DEFAULT false NOT NULL,
	"error_summary" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "line_backlog_recovery_sync_runs_single_running_idx" ON "line_backlog_recovery_sync_runs" USING btree ("status") WHERE "line_backlog_recovery_sync_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "line_backlog_recovery_sync_runs_status_started_idx" ON "line_backlog_recovery_sync_runs" USING btree ("status","started_at");