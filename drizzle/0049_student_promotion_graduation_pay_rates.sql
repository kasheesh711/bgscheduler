CREATE TABLE "student_promotion_graduation_actions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL,
  "wise_student_id" text NOT NULL,
  "student_name" text DEFAULT '' NOT NULL,
  "parent_name" text DEFAULT '' NOT NULL,
  "student_key" text DEFAULT '' NOT NULL,
  "current_grade_raw" text DEFAULT '' NOT NULL,
  "disposition" text,
  "status" text DEFAULT 'pending_review' NOT NULL,
  "reviewed_by_email" text,
  "reviewed_by_name" text,
  "reviewed_at" timestamp with time zone,
  "applied_at" timestamp with time zone,
  "error_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "student_promotion_pay_rate_impacts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL,
  "course_action_id" uuid,
  "impact_key" text NOT NULL,
  "wise_class_id" text NOT NULL,
  "teacher_wise_id" text,
  "teacher_wise_user_id" text,
  "teacher_name" text DEFAULT '' NOT NULL,
  "raw_tier" text,
  "normalized_tier" text DEFAULT 'Unassigned' NOT NULL,
  "student_band" text NOT NULL,
  "current_subject" text NOT NULL,
  "target_subject" text NOT NULL,
  "current_normalized_course_key" text,
  "target_normalized_course_key" text,
  "before_rate_rule_id" uuid,
  "after_rate_rule_id" uuid,
  "before_expected_hourly_rate" double precision,
  "after_expected_hourly_rate" double precision,
  "rate_delta" double precision,
  "future_session_count" integer DEFAULT 0 NOT NULL,
  "first_session_start_time" timestamp with time zone,
  "last_session_start_time" timestamp with time zone,
  "affected_student_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "affected_student_names" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "review_status" text DEFAULT 'pending_review' NOT NULL,
  "blocker_reason" text,
  "reviewed_by_email" text,
  "reviewed_by_name" text,
  "reviewed_at" timestamp with time zone,
  "review_note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "student_promotion_graduation_actions" ADD CONSTRAINT "student_promotion_graduation_actions_run_id_student_promotion_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."student_promotion_runs"("id") ON DELETE no action ON UPDATE no action;

ALTER TABLE "student_promotion_pay_rate_impacts" ADD CONSTRAINT "student_promotion_pay_rate_impacts_run_id_student_promotion_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."student_promotion_runs"("id") ON DELETE no action ON UPDATE no action;

ALTER TABLE "student_promotion_pay_rate_impacts" ADD CONSTRAINT "student_promotion_pay_rate_impacts_course_action_id_student_promotion_course_actions_id_fk" FOREIGN KEY ("course_action_id") REFERENCES "public"."student_promotion_course_actions"("id") ON DELETE no action ON UPDATE no action;

ALTER TABLE "student_promotion_pay_rate_impacts" ADD CONSTRAINT "student_promotion_pay_rate_impacts_before_rate_rule_id_payroll_rate_rules_id_fk" FOREIGN KEY ("before_rate_rule_id") REFERENCES "public"."payroll_rate_rules"("id") ON DELETE no action ON UPDATE no action;

ALTER TABLE "student_promotion_pay_rate_impacts" ADD CONSTRAINT "student_promotion_pay_rate_impacts_after_rate_rule_id_payroll_rate_rules_id_fk" FOREIGN KEY ("after_rate_rule_id") REFERENCES "public"."payroll_rate_rules"("id") ON DELETE no action ON UPDATE no action;

CREATE UNIQUE INDEX "sp_graduation_actions_run_student_idx" ON "student_promotion_graduation_actions" USING btree ("run_id","wise_student_id");

CREATE INDEX "sp_graduation_actions_run_status_idx" ON "student_promotion_graduation_actions" USING btree ("run_id","status");

CREATE INDEX "sp_graduation_actions_student_idx" ON "student_promotion_graduation_actions" USING btree ("wise_student_id");

CREATE UNIQUE INDEX "sp_pay_rate_impacts_run_key_idx" ON "student_promotion_pay_rate_impacts" USING btree ("run_id","impact_key");

CREATE INDEX "sp_pay_rate_impacts_run_review_idx" ON "student_promotion_pay_rate_impacts" USING btree ("run_id","review_status");

CREATE INDEX "sp_pay_rate_impacts_class_idx" ON "student_promotion_pay_rate_impacts" USING btree ("wise_class_id");

CREATE INDEX "sp_pay_rate_impacts_course_action_idx" ON "student_promotion_pay_rate_impacts" USING btree ("course_action_id");
