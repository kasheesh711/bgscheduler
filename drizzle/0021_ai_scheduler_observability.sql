ALTER TABLE "ai_scheduler_runs" ADD COLUMN "scheduler_version" text;--> statement-breakpoint
ALTER TABLE "ai_scheduler_runs" ADD COLUMN "prompt_version" text;--> statement-breakpoint
ALTER TABLE "ai_scheduler_runs" ADD COLUMN "latency_breakdown" jsonb;
