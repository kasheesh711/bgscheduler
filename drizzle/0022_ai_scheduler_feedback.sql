CREATE TABLE "ai_scheduler_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid,
	"message_id" uuid,
	"scheduler_run_id" uuid,
	"action" text NOT NULL,
	"selected_tutor_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rejected_tutor_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"edited_parent_draft" text,
	"rejection_reason" text,
	"staff_correction" text,
	"created_by_email" text,
	"created_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_scheduler_feedback" ADD CONSTRAINT "ai_scheduler_feedback_conversation_id_ai_scheduler_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_scheduler_conversations"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ai_scheduler_feedback" ADD CONSTRAINT "ai_scheduler_feedback_message_id_ai_scheduler_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."ai_scheduler_messages"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ai_scheduler_feedback" ADD CONSTRAINT "ai_scheduler_feedback_scheduler_run_id_ai_scheduler_runs_id_fk" FOREIGN KEY ("scheduler_run_id") REFERENCES "public"."ai_scheduler_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "ai_scheduler_feedback_message_idx" ON "ai_scheduler_feedback" USING btree ("message_id");
--> statement-breakpoint
CREATE INDEX "ai_scheduler_feedback_run_idx" ON "ai_scheduler_feedback" USING btree ("scheduler_run_id");
--> statement-breakpoint
CREATE INDEX "ai_scheduler_feedback_created_at_idx" ON "ai_scheduler_feedback" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX "ai_scheduler_feedback_action_idx" ON "ai_scheduler_feedback" USING btree ("action");
