ALTER TABLE "classroom_publish_jobs" ADD COLUMN "preflight_warning_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "classroom_publish_jobs" ADD COLUMN "live_catalog_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "classroom_publish_jobs" ADD COLUMN "final_verification" jsonb;
