CREATE TYPE "public"."line_message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."line_scheduler_classifier_category" AS ENUM('scheduling_request', 'scheduling_change', 'non_scheduling', 'unclear');--> statement-breakpoint
CREATE TYPE "public"."line_scheduler_review_status" AS ENUM('pending_review', 'approved_sent', 'accepted_no_send', 'rejected', 'dismissed');--> statement-breakpoint
ALTER TYPE "public"."ai_scheduler_message_role" ADD VALUE 'parent' BEFORE 'assistant';--> statement-breakpoint
CREATE TABLE "line_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"line_user_id" text NOT NULL,
	"display_name" text,
	"picture_url" text,
	"status_message" text,
	"linked_parent_label" text,
	"linked_student_label" text,
	"profile_raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "line_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"direction" "line_message_direction" NOT NULL,
	"line_message_id" text,
	"webhook_event_id" text,
	"source_type" text DEFAULT 'user' NOT NULL,
	"message_type" text NOT NULL,
	"text" text,
	"reply_token" text,
	"event_timestamp" timestamp with time zone,
	"is_redelivery" boolean DEFAULT false NOT NULL,
	"is_retracted" boolean DEFAULT false NOT NULL,
	"retracted_at" timestamp with time zone,
	"classifier_category" "line_scheduler_classifier_category",
	"classifier_confidence" double precision,
	"classifier_summary" text,
	"classifier_payload" jsonb,
	"classified_at" timestamp with time zone,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "line_scheduler_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"inbound_message_id" uuid NOT NULL,
	"conversation_id" uuid,
	"scheduler_message_id" uuid,
	"scheduler_run_id" uuid,
	"classifier_category" "line_scheduler_classifier_category" NOT NULL,
	"classifier_confidence" double precision,
	"classifier_summary" text,
	"classifier_payload" jsonb,
	"status" "line_scheduler_review_status" DEFAULT 'pending_review' NOT NULL,
	"proposed_draft" text DEFAULT '' NOT NULL,
	"selected_suggestion" jsonb,
	"final_text" text,
	"rejection_reason" text,
	"staff_correction" text,
	"send_line_message_id" text,
	"send_response" jsonb,
	"send_error" text,
	"reviewed_by_email" text,
	"reviewed_by_name" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "line_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"line_user_id" text NOT NULL,
	"ai_scheduler_conversation_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "line_messages" ADD CONSTRAINT "line_messages_thread_id_line_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."line_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "line_messages" ADD CONSTRAINT "line_messages_contact_id_line_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."line_contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "line_scheduler_reviews" ADD CONSTRAINT "line_scheduler_reviews_thread_id_line_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."line_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "line_scheduler_reviews" ADD CONSTRAINT "line_scheduler_reviews_contact_id_line_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."line_contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "line_scheduler_reviews" ADD CONSTRAINT "line_scheduler_reviews_inbound_message_id_line_messages_id_fk" FOREIGN KEY ("inbound_message_id") REFERENCES "public"."line_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "line_scheduler_reviews" ADD CONSTRAINT "line_scheduler_reviews_conversation_id_ai_scheduler_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_scheduler_conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "line_scheduler_reviews" ADD CONSTRAINT "line_scheduler_reviews_scheduler_message_id_ai_scheduler_messages_id_fk" FOREIGN KEY ("scheduler_message_id") REFERENCES "public"."ai_scheduler_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "line_scheduler_reviews" ADD CONSTRAINT "line_scheduler_reviews_scheduler_run_id_ai_scheduler_runs_id_fk" FOREIGN KEY ("scheduler_run_id") REFERENCES "public"."ai_scheduler_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "line_threads" ADD CONSTRAINT "line_threads_contact_id_line_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."line_contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "line_threads" ADD CONSTRAINT "line_threads_ai_scheduler_conversation_id_ai_scheduler_conversations_id_fk" FOREIGN KEY ("ai_scheduler_conversation_id") REFERENCES "public"."ai_scheduler_conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "line_contacts_user_id_idx" ON "line_contacts" USING btree ("line_user_id");--> statement-breakpoint
CREATE INDEX "line_contacts_last_seen_idx" ON "line_contacts" USING btree ("last_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "line_messages_webhook_event_idx" ON "line_messages" USING btree ("webhook_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "line_messages_line_message_idx" ON "line_messages" USING btree ("line_message_id");--> statement-breakpoint
CREATE INDEX "line_messages_thread_created_idx" ON "line_messages" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "line_messages_classifier_idx" ON "line_messages" USING btree ("classifier_category","classified_at");--> statement-breakpoint
CREATE UNIQUE INDEX "line_scheduler_reviews_inbound_message_idx" ON "line_scheduler_reviews" USING btree ("inbound_message_id");--> statement-breakpoint
CREATE INDEX "line_scheduler_reviews_status_idx" ON "line_scheduler_reviews" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "line_scheduler_reviews_conversation_idx" ON "line_scheduler_reviews" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "line_threads_user_id_idx" ON "line_threads" USING btree ("line_user_id");--> statement-breakpoint
CREATE INDEX "line_threads_conversation_idx" ON "line_threads" USING btree ("ai_scheduler_conversation_id");--> statement-breakpoint
CREATE INDEX "line_threads_last_message_idx" ON "line_threads" USING btree ("last_message_at");