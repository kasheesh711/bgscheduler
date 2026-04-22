CREATE TABLE "past_session_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_canonical_key" text NOT NULL,
	"captured_in_snapshot_id" uuid,
	"wise_teacher_id" text NOT NULL,
	"wise_session_id" text NOT NULL,
	"start_time" timestamp with time zone NOT NULL,
	"end_time" timestamp with time zone NOT NULL,
	"weekday" integer NOT NULL,
	"start_minute" integer NOT NULL,
	"end_minute" integer NOT NULL,
	"wise_status" text NOT NULL,
	"is_blocking" boolean DEFAULT true NOT NULL,
	"title" text,
	"session_type" text,
	"location" text,
	"student_name" text,
	"subject" text,
	"class_type" text,
	"recurrence_id" text,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "psb_wise_session_id_idx" ON "past_session_blocks" USING btree ("wise_session_id");--> statement-breakpoint
CREATE INDEX "psb_group_key_start_idx" ON "past_session_blocks" USING btree ("group_canonical_key","start_time");--> statement-breakpoint
CREATE INDEX "psb_start_time_idx" ON "past_session_blocks" USING btree ("start_time");