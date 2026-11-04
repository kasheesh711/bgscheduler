ALTER TABLE "hiring_candidates" ADD COLUMN "seek_job_id" text;--> statement-breakpoint
-- Every SEEK row so far came from the one configured job, which is what each SEEK link already assumed.
UPDATE "hiring_candidates" SET "seek_job_id" = '94844236' WHERE "seek_application_id" IS NOT NULL OR jsonb_array_length("source_ids") > 0;
