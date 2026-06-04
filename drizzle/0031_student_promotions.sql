CREATE TYPE "public"."student_promotion_run_status" AS ENUM('draft', 'verified', 'applying', 'applied', 'applied_with_errors', 'failed');
--> statement-breakpoint
CREATE TYPE "public"."student_promotion_action_status" AS ENUM('pending', 'skipped', 'applied', 'failed');
--> statement-breakpoint
CREATE TABLE "student_promotion_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "target_date" date NOT NULL,
  "status" "student_promotion_run_status" DEFAULT 'draft' NOT NULL,
  "source_snapshot_id" uuid,
  "wise_accepted_student_count" integer DEFAULT 0 NOT NULL,
  "website_snapshot_student_count" integer DEFAULT 0 NOT NULL,
  "grade_only_count" integer DEFAULT 0 NOT NULL,
  "year8_course_move_count" integer DEFAULT 0 NOT NULL,
  "year11_course_move_count" integer DEFAULT 0 NOT NULL,
  "skipped_grade_count" integer DEFAULT 0 NOT NULL,
  "pending_course_action_count" integer DEFAULT 0 NOT NULL,
  "skipped_course_action_count" integer DEFAULT 0 NOT NULL,
  "verified_at" timestamp with time zone,
  "verified_by_email" text,
  "verified_by_name" text,
  "endpoint_verification_note" text,
  "apply_started_at" timestamp with time zone,
  "apply_finished_at" timestamp with time zone,
  "applied_by_email" text,
  "applied_by_name" text,
  "error_summary" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_by_email" text,
  "created_by_name" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "student_promotion_grade_actions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL,
  "wise_student_id" text NOT NULL,
  "student_name" text DEFAULT '' NOT NULL,
  "student_key" text DEFAULT '' NOT NULL,
  "current_grade_raw" text DEFAULT '' NOT NULL,
  "parsed_current_year" integer,
  "target_grade" text,
  "action_type" text NOT NULL,
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
CREATE TABLE "student_promotion_course_actions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL,
  "wise_class_id" text NOT NULL,
  "current_subject" text NOT NULL,
  "target_subject" text,
  "transition_type" text NOT NULL,
  "student_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "qualifying_student_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
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
ALTER TABLE "student_promotion_runs" ADD CONSTRAINT "student_promotion_runs_source_snapshot_id_credit_control_snapshots_id_fk" FOREIGN KEY ("source_snapshot_id") REFERENCES "public"."credit_control_snapshots"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "student_promotion_grade_actions" ADD CONSTRAINT "student_promotion_grade_actions_run_id_student_promotion_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."student_promotion_runs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "student_promotion_course_actions" ADD CONSTRAINT "student_promotion_course_actions_run_id_student_promotion_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."student_promotion_runs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "student_promotion_runs_target_status_idx" ON "student_promotion_runs" USING btree ("target_date","status");
--> statement-breakpoint
CREATE INDEX "student_promotion_runs_created_at_idx" ON "student_promotion_runs" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX "student_promotion_runs_verified_idx" ON "student_promotion_runs" USING btree ("verified_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "sp_grade_actions_run_student_idx" ON "student_promotion_grade_actions" USING btree ("run_id","wise_student_id");
--> statement-breakpoint
CREATE INDEX "sp_grade_actions_run_status_idx" ON "student_promotion_grade_actions" USING btree ("run_id","status");
--> statement-breakpoint
CREATE INDEX "sp_grade_actions_student_idx" ON "student_promotion_grade_actions" USING btree ("wise_student_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "sp_course_actions_run_class_idx" ON "student_promotion_course_actions" USING btree ("run_id","wise_class_id");
--> statement-breakpoint
CREATE INDEX "sp_course_actions_run_status_idx" ON "student_promotion_course_actions" USING btree ("run_id","status");
--> statement-breakpoint
CREATE INDEX "sp_course_actions_class_idx" ON "student_promotion_course_actions" USING btree ("wise_class_id");
