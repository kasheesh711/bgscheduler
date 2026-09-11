ALTER TABLE "classroom_publish_jobs" ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "classroom_publish_jobs" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "classroom_publish_jobs" ADD COLUMN "claim_token" uuid;
--> statement-breakpoint
ALTER TABLE "classroom_publish_jobs" ADD COLUMN "lease_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "classroom_publish_jobs" ADD COLUMN "verified_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX "classroom_publish_jobs_due_idx" ON "classroom_publish_jobs" ("status", "next_attempt_at");
--> statement-breakpoint
CREATE TABLE "classroom_publish_worker" (
 "id" text PRIMARY KEY NOT NULL,
 "job_id" uuid REFERENCES "classroom_publish_jobs"("id") ON DELETE SET NULL,
 "claim_token" uuid,
 "lease_expires_at" timestamp with time zone,
 "cooldown_until" timestamp with time zone
);
