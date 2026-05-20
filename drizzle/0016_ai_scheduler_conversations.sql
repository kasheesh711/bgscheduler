CREATE TYPE "public"."ai_scheduler_conversation_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."ai_scheduler_message_role" AS ENUM('admin', 'assistant', 'system');--> statement-breakpoint
CREATE TABLE "ai_scheduler_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text DEFAULT 'Untitled scheduler chat' NOT NULL,
	"status" "ai_scheduler_conversation_status" DEFAULT 'active' NOT NULL,
	"customer_parent_name" text,
	"customer_student_name" text,
	"customer_contact" text,
	"notes" text DEFAULT '' NOT NULL,
	"extracted_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_email" text,
	"created_by_name" text,
	"archived_at" timestamp with time zone,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_scheduler_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" "ai_scheduler_message_role" NOT NULL,
	"content" text NOT NULL,
	"structured_payload" jsonb,
	"model" text,
	"latency_ms" integer,
	"created_by_email" text,
	"created_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_scheduler_runs" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_scheduler_runs" ADD COLUMN "message_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_scheduler_messages" ADD CONSTRAINT "ai_scheduler_messages_conversation_id_ai_scheduler_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_scheduler_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_scheduler_conversations_status_idx" ON "ai_scheduler_conversations" USING btree ("status","last_message_at");--> statement-breakpoint
CREATE INDEX "ai_scheduler_conversations_created_by_idx" ON "ai_scheduler_conversations" USING btree ("created_by_email","last_message_at");--> statement-breakpoint
CREATE INDEX "ai_scheduler_conversations_last_message_idx" ON "ai_scheduler_conversations" USING btree ("last_message_at");--> statement-breakpoint
CREATE INDEX "ai_scheduler_messages_conversation_idx" ON "ai_scheduler_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_scheduler_messages_created_at_idx" ON "ai_scheduler_messages" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "ai_scheduler_runs" ADD CONSTRAINT "ai_scheduler_runs_conversation_id_ai_scheduler_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_scheduler_conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_scheduler_runs" ADD CONSTRAINT "ai_scheduler_runs_message_id_ai_scheduler_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."ai_scheduler_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_scheduler_runs_conversation_idx" ON "ai_scheduler_runs" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "ai_scheduler_runs_message_idx" ON "ai_scheduler_runs" USING btree ("message_id");