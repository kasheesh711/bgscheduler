ALTER TYPE "public"."post_class_notification_kind" ADD VALUE 'deduction_report' BEFORE 'tutor_day_after';--> statement-breakpoint
CREATE TABLE "post_class_feedback_captures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"binding" jsonb NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"mode" text NOT NULL,
	"state" text NOT NULL,
	"timing" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"pathname" text,
	"mime" text,
	"sha256" text,
	"size" integer,
	"upload_status" text NOT NULL,
	"upload_error" text,
	"uploaded_by" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pc_capture_mode_check" CHECK ("post_class_feedback_captures"."mode" in ('deadline', 'current')),
	CONSTRAINT "pc_capture_state_check" CHECK ("post_class_feedback_captures"."state" in ('missing', 'present', 'uncheckable')),
	CONSTRAINT "pc_capture_timing_check" CHECK ("post_class_feedback_captures"."timing" in ('within_window', 'late', 'later_check')),
	CONSTRAINT "pc_capture_upload_check" CHECK ("post_class_feedback_captures"."upload_status" in ('pending', 'ready', 'failed', 'no_image'))
);--> statement-breakpoint
ALTER TABLE "post_class_feedback_captures" ADD CONSTRAINT "post_class_feedback_captures_session_id_post_class_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."post_class_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pc_capture_key_idx" ON "post_class_feedback_captures" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "pc_capture_session_deadline_idx" ON "post_class_feedback_captures" USING btree ("session_id","deadline_at");
