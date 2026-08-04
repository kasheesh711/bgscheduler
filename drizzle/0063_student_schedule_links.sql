CREATE TABLE "line_group_schedule_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" text NOT NULL,
	"student_key" text NOT NULL,
	"student_name" text NOT NULL,
	"month_key" text NOT NULL,
	"requested_by_line_user_id" text NOT NULL,
	"link_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "line_schedule_bot_pending" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"line_user_id" text NOT NULL,
	"scope_key" text DEFAULT 'dm' NOT NULL,
	"group_id" text,
	"student_key" text NOT NULL,
	"wise_student_id" text NOT NULL,
	"student_name" text NOT NULL,
	"parent_name" text DEFAULT '' NOT NULL,
	"target_line_user_id" text DEFAULT '' NOT NULL,
	"target_display_name" text DEFAULT '' NOT NULL,
	"month_key" text NOT NULL,
	"session_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "student_schedule_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"student_key" text NOT NULL,
	"wise_student_id" text NOT NULL,
	"student_name" text NOT NULL,
	"month_key" text NOT NULL,
	"created_by_email" text,
	"created_by_line_user_id" text,
	"sent_to_line_user_id" text,
	"sent_to_group_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"view_count" integer DEFAULT 0 NOT NULL,
	"last_viewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credit_control_sessions" ADD COLUMN "wise_teacher_user_id" text;--> statement-breakpoint
ALTER TABLE "credit_control_sessions" ADD COLUMN "wise_teacher_id" text;--> statement-breakpoint
ALTER TABLE "credit_control_sessions" ADD COLUMN "teacher_name" text;--> statement-breakpoint
ALTER TABLE "line_group_schedule_sends" ADD CONSTRAINT "line_group_schedule_sends_link_id_student_schedule_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."student_schedule_links"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "line_group_schedule_sends_group_student_idx" ON "line_group_schedule_sends" USING btree ("group_id","student_key");--> statement-breakpoint
CREATE INDEX "line_group_schedule_sends_created_idx" ON "line_group_schedule_sends" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "line_schedule_bot_pending_scope_idx" ON "line_schedule_bot_pending" USING btree ("line_user_id","scope_key");--> statement-breakpoint
CREATE UNIQUE INDEX "student_schedule_links_token_hash_idx" ON "student_schedule_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "student_schedule_links_student_idx" ON "student_schedule_links" USING btree ("student_key","created_at");