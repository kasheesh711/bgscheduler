ALTER TABLE "line_scheduler_reviews" ADD COLUMN "intent_type" text DEFAULT 'new_request' NOT NULL;
--> statement-breakpoint
ALTER TABLE "line_scheduler_reviews" ADD COLUMN "intent_payload" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "line_scheduler_reviews" ADD COLUMN "matched_student_keys" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "line_scheduler_reviews" ADD COLUMN "candidate_sessions" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "line_scheduler_reviews" ADD COLUMN "proposed_wise_actions" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "line_scheduler_reviews" ADD COLUMN "admin_selected_session_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "line_scheduler_reviews" ADD COLUMN "writeback_status" text DEFAULT 'not_applicable' NOT NULL;
--> statement-breakpoint
CREATE INDEX "line_scheduler_reviews_intent_idx" ON "line_scheduler_reviews" USING btree ("intent_type","created_at");
--> statement-breakpoint
CREATE TABLE "line_wise_action_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"line_review_id" uuid,
	"action_type" text NOT NULL,
	"status" text DEFAULT 'dry_run' NOT NULL,
	"dry_run" boolean DEFAULT true NOT NULL,
	"wise_session_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"request_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"response_payload" jsonb,
	"error_message" text,
	"created_by_email" text,
	"created_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "line_wise_action_logs" ADD CONSTRAINT "line_wise_action_logs_review_id_fk" FOREIGN KEY ("line_review_id") REFERENCES "public"."line_scheduler_reviews"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "line_wise_action_logs_review_idx" ON "line_wise_action_logs" USING btree ("line_review_id","created_at");
