CREATE TABLE "student_promotion_future_session_actions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL,
  "course_action_id" uuid,
  "wise_class_id" text NOT NULL,
  "wise_session_id" text NOT NULL,
  "scheduled_start_time" timestamp with time zone NOT NULL,
  "current_subject" text DEFAULT '' NOT NULL,
  "target_subject" text NOT NULL,
  "current_normalized_course_key" text,
  "target_normalized_course_key" text,
  "status" "student_promotion_action_status" DEFAULT 'pending' NOT NULL,
  "skip_reason" text,
  "request_payload" jsonb,
  "response_payload" jsonb,
  "error_message" text,
  "applied_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "student_promotion_future_session_actions" ADD CONSTRAINT "student_promotion_future_session_actions_run_id_student_promotion_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."student_promotion_runs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "student_promotion_future_session_actions" ADD CONSTRAINT "student_promotion_future_session_actions_course_action_id_student_promotion_course_actions_id_fk" FOREIGN KEY ("course_action_id") REFERENCES "public"."student_promotion_course_actions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "sp_future_session_actions_run_session_idx" ON "student_promotion_future_session_actions" USING btree ("run_id","wise_session_id");
--> statement-breakpoint
CREATE INDEX "sp_future_session_actions_run_status_idx" ON "student_promotion_future_session_actions" USING btree ("run_id","status");
--> statement-breakpoint
CREATE INDEX "sp_future_session_actions_class_idx" ON "student_promotion_future_session_actions" USING btree ("wise_class_id");
--> statement-breakpoint
CREATE INDEX "sp_future_session_actions_course_action_idx" ON "student_promotion_future_session_actions" USING btree ("course_action_id");
--> statement-breakpoint
CREATE INDEX "sp_future_session_actions_start_idx" ON "student_promotion_future_session_actions" USING btree ("scheduled_start_time");
