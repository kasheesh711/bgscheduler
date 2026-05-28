ALTER TABLE "ai_scheduler_feedback" ADD COLUMN "line_review_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_scheduler_feedback" ADD COLUMN "classifier_confidence" double precision;--> statement-breakpoint
ALTER TABLE "ai_scheduler_feedback" ADD COLUMN "time_to_review_ms" integer;--> statement-breakpoint
ALTER TABLE "ai_scheduler_feedback" ADD CONSTRAINT "ai_scheduler_feedback_line_review_id_line_scheduler_reviews_id_fk" FOREIGN KEY ("line_review_id") REFERENCES "public"."line_scheduler_reviews"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_scheduler_feedback_line_review_idx" ON "ai_scheduler_feedback" USING btree ("line_review_id");
