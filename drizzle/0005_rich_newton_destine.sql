CREATE TYPE "public"."classroom_publish_job_status" AS ENUM('pending', 'running', 'succeeded', 'partial', 'failed');--> statement-breakpoint
CREATE TABLE "classroom_publish_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"status" "classroom_publish_job_status" DEFAULT 'pending' NOT NULL,
	"total_count" integer DEFAULT 0 NOT NULL,
	"eligible_count" integer DEFAULT 0 NOT NULL,
	"completed_count" integer DEFAULT 0 NOT NULL,
	"success_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_by" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "classroom_publish_jobs" ADD CONSTRAINT "classroom_publish_jobs_run_id_classroom_assignment_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."classroom_assignment_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "classroom_publish_jobs_run_idx" ON "classroom_publish_jobs" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "classroom_publish_jobs_status_idx" ON "classroom_publish_jobs" USING btree ("status");