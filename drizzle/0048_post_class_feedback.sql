CREATE TYPE "public"."post_class_source_status" AS ENUM('ready', 'unavailable', 'form_drift', 'identity_review');
CREATE TYPE "public"."post_class_content_status" AS ENUM('missing', 'blank', 'substantive');
CREATE TYPE "public"."post_class_timing_status" AS ENUM('not_due', 'on_time', 'late', 'unknown');
CREATE TYPE "public"."post_class_deduction_status" AS ENUM('none', 'pending_review', 'approved', 'waived', 'processed', 'reversed');
CREATE TYPE "public"."post_class_enforcement_mode" AS ENUM('shadow', 'live', 'paused');
CREATE TYPE "public"."post_class_capability" AS ENUM('viewer', 'reviewer', 'finance', 'access_manager');
CREATE TYPE "public"."post_class_feedback_provenance" AS ENUM('manual', 'auto', 'unknown');
CREATE TYPE "public"."post_class_notification_kind" AS ENUM('tutor_day_after', 'tutor_deadline', 'admin_digest', 'test');
CREATE TYPE "public"."post_class_notification_status" AS ENUM('pending', 'sending', 'sent', 'failed', 'cancelled');
CREATE TYPE "public"."post_class_ai_status" AS ENUM('pending', 'running', 'succeeded', 'failed');
CREATE TYPE "public"."post_class_concern_decision" AS ENUM('pending', 'confirmed', 'dismissed');
CREATE TYPE "public"."post_class_finance_period_status" AS ENUM('open', 'closed');

ALTER TABLE "tutor_contacts" ADD COLUMN "primary_email" text;

CREATE TABLE "post_class_enforcement_windows" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "mode" "post_class_enforcement_mode" NOT NULL,
  "starts_at" timestamp with time zone DEFAULT now() NOT NULL,
  "ends_at" timestamp with time zone,
  "policy_effective_at" timestamp with time zone,
  "actor_email" text NOT NULL,
  "reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pc_enforcement_window_bounds_check" CHECK ("ends_at" IS NULL OR "ends_at" > "starts_at"),
  CONSTRAINT "pc_live_window_effective_check" CHECK ("mode" <> 'live' OR "policy_effective_at" IS NOT NULL)
);

CREATE TABLE "post_class_settings" (
  "id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
  "enforcement_mode" "post_class_enforcement_mode" DEFAULT 'shadow' NOT NULL,
  "current_window_id" uuid,
  "policy_effective_at" timestamp with time zone,
  "policy_version" integer DEFAULT 1 NOT NULL,
  "form_mapping_version" integer DEFAULT 1 NOT NULL,
  "form_mapping_valid" boolean DEFAULT true NOT NULL,
  "email_delivery_verified_at" timestamp with time zone,
  "shadow_reviewed_at" timestamp with time zone,
  "version" integer DEFAULT 1 NOT NULL,
  "updated_by_email" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pc_settings_window_fk"
    FOREIGN KEY ("current_window_id") REFERENCES "public"."post_class_enforcement_windows"("id") ON DELETE restrict,
  CONSTRAINT "pc_settings_singleton_check" CHECK ("id" = 'default'),
  CONSTRAINT "pc_settings_positive_versions_check" CHECK ("policy_version" > 0 AND "form_mapping_version" > 0 AND "version" > 0),
  CONSTRAINT "pc_settings_live_effective_check" CHECK ("enforcement_mode" <> 'live' OR "policy_effective_at" IS NOT NULL)
);

CREATE TABLE "post_class_field_mappings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "mapping_version" integer DEFAULT 1 NOT NULL,
  "field_key" text NOT NULL,
  "wise_question_text" text NOT NULL,
  "normalized_question_text" text NOT NULL,
  "required_for_compliance" boolean DEFAULT true NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "updated_by_email" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pc_field_mapping_key_check" CHECK ("field_key" IN ('topics', 'performance', 'improvement', 'homework')),
  CONSTRAINT "pc_field_mapping_version_check" CHECK ("mapping_version" > 0)
);

CREATE TABLE "post_class_access_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "email" text NOT NULL,
  "capability" "post_class_capability" NOT NULL,
  "granted_by_email" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pc_access_email_normalized_check" CHECK ("email" = lower(btrim("email")) AND "email" <> '')
);

CREATE TABLE "post_class_config_audit_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "entity_type" text NOT NULL,
  "entity_key" text NOT NULL,
  "action" text NOT NULL,
  "actor_email" text NOT NULL,
  "before_value" jsonb,
  "after_value" jsonb,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "post_class_digest_recipients" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "email" text NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "updated_by_email" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pc_digest_email_normalized_check" CHECK ("email" = lower(btrim("email")) AND "email" <> '')
);

CREATE TABLE "post_class_sync_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "status" "sync_status" DEFAULT 'running' NOT NULL,
  "trigger_type" text DEFAULT 'cron' NOT NULL,
  "actor_email" text,
  "window_start" date NOT NULL,
  "window_end" date NOT NULL,
  "detail_cap" integer DEFAULT 50 NOT NULL,
  "discovered_count" integer DEFAULT 0 NOT NULL,
  "session_count" integer DEFAULT 0 NOT NULL,
  "detail_fetched_count" integer DEFAULT 0 NOT NULL,
  "version_inserted_count" integer DEFAULT 0 NOT NULL,
  "assessed_count" integer DEFAULT 0 NOT NULL,
  "source_issue_count" integer DEFAULT 0 NOT NULL,
  "cursor" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "error_summary" text,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  CONSTRAINT "pc_sync_window_check" CHECK ("window_end" >= "window_start"),
  CONSTRAINT "pc_sync_counts_check" CHECK (
    "detail_cap" > 0 AND "discovered_count" >= 0 AND "session_count" >= 0
    AND "detail_fetched_count" >= 0 AND "version_inserted_count" >= 0
    AND "assessed_count" >= 0 AND "source_issue_count" >= 0
  )
);

CREATE TABLE "post_class_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "wise_session_id" text NOT NULL,
  "wise_class_id" text NOT NULL,
  "recurrence_id" text,
  "class_name" text,
  "canonical_tutor_key" text,
  "canonical_tutor_name" text,
  "wise_teacher_user_id" text,
  "scheduled_start_at" timestamp with time zone NOT NULL,
  "scheduled_end_at" timestamp with time zone NOT NULL,
  "deadline_at" timestamp with time zone NOT NULL,
  "final_status" text NOT NULL,
  "credits_consumed" double precision DEFAULT 0 NOT NULL,
  "payable_eligible" boolean DEFAULT false NOT NULL,
  "eligible" boolean DEFAULT false NOT NULL,
  "eligibility_reason" text,
  "source_status" "post_class_source_status" DEFAULT 'unavailable' NOT NULL,
  "content_status" "post_class_content_status" DEFAULT 'missing' NOT NULL,
  "timing_status" "post_class_timing_status" DEFAULT 'not_due' NOT NULL,
  "deduction_status" "post_class_deduction_status" DEFAULT 'none' NOT NULL,
  "latest_feedback_version_id" uuid,
  "first_on_time_compliant_version_id" uuid,
  "enforcement_mode" "post_class_enforcement_mode" DEFAULT 'shadow' NOT NULL,
  "policy_version" integer DEFAULT 1 NOT NULL,
  "last_observed_at" timestamp with time zone,
  "last_assessed_at" timestamp with time zone,
  "source_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pc_session_schedule_check" CHECK ("scheduled_end_at" >= "scheduled_start_at"),
  CONSTRAINT "pc_session_deadline_check" CHECK ("deadline_at" >= "scheduled_end_at"),
  CONSTRAINT "pc_session_credit_check" CHECK ("credits_consumed" >= 0),
  CONSTRAINT "pc_session_version_check" CHECK ("policy_version" > 0 AND "version" > 0)
);

CREATE TABLE "post_class_session_participants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL,
  "participant_key" text NOT NULL,
  "wise_student_id" text,
  "student_name" text NOT NULL,
  "credits_consumed" double precision DEFAULT 0 NOT NULL,
  "billable" boolean DEFAULT false NOT NULL,
  "raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pc_participants_session_fk"
    FOREIGN KEY ("session_id") REFERENCES "public"."post_class_sessions"("id") ON DELETE cascade,
  CONSTRAINT "pc_participant_credit_check" CHECK ("credits_consumed" >= 0)
);

CREATE TABLE "post_class_feedback_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL,
  "version_key" text NOT NULL,
  "wise_submission_id" text,
  "content_hash" text NOT NULL,
  "profile" text DEFAULT 'teacher' NOT NULL,
  "provenance" "post_class_feedback_provenance" DEFAULT 'unknown' NOT NULL,
  "source_created_at" timestamp with time zone,
  "source_timestamp_trustworthy" boolean DEFAULT false NOT NULL,
  "source_timestamp_kind" text,
  "observed_at" timestamp with time zone NOT NULL,
  "actor_wise_user_id" text,
  "actor_name" text,
  "topics" text DEFAULT '' NOT NULL,
  "performance" text DEFAULT '' NOT NULL,
  "improvement" text DEFAULT '' NOT NULL,
  "homework" text DEFAULT '' NOT NULL,
  "answers" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "raw_char_count" integer DEFAULT 0 NOT NULL,
  "substantive" boolean DEFAULT false NOT NULL,
  "compliant" boolean DEFAULT false NOT NULL,
  "field_failures" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pc_feedback_session_fk"
    FOREIGN KEY ("session_id") REFERENCES "public"."post_class_sessions"("id") ON DELETE cascade,
  CONSTRAINT "pc_feedback_raw_char_count_check" CHECK ("raw_char_count" >= 0)
);

ALTER TABLE "post_class_sessions"
  ADD CONSTRAINT "pc_sessions_latest_feedback_fk"
  FOREIGN KEY ("latest_feedback_version_id") REFERENCES "public"."post_class_feedback_versions"("id") ON DELETE set null;
ALTER TABLE "post_class_sessions"
  ADD CONSTRAINT "pc_sessions_first_ontime_feedback_fk"
  FOREIGN KEY ("first_on_time_compliant_version_id") REFERENCES "public"."post_class_feedback_versions"("id") ON DELETE set null;

CREATE TABLE "post_class_feedback_event_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL,
  "feedback_version_id" uuid,
  "wise_activity_event_id" uuid,
  "wise_event_id" text NOT NULL,
  "event_timestamp" timestamp with time zone NOT NULL,
  "auto_submitted" boolean,
  "link_confidence" double precision,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pc_event_links_session_fk"
    FOREIGN KEY ("session_id") REFERENCES "public"."post_class_sessions"("id") ON DELETE cascade,
  CONSTRAINT "pc_event_links_feedback_fk"
    FOREIGN KEY ("feedback_version_id") REFERENCES "public"."post_class_feedback_versions"("id") ON DELETE set null,
  CONSTRAINT "pc_event_links_activity_fk"
    FOREIGN KEY ("wise_activity_event_id") REFERENCES "public"."wise_activity_events"("id") ON DELETE set null,
  CONSTRAINT "pc_event_link_confidence_check" CHECK ("link_confidence" IS NULL OR ("link_confidence" >= 0 AND "link_confidence" <= 1))
);

CREATE TABLE "post_class_assessments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL,
  "feedback_version_id" uuid,
  "assessment_key" text NOT NULL,
  "policy_version" integer NOT NULL,
  "mapping_version" integer NOT NULL,
  "source_status" "post_class_source_status" NOT NULL,
  "content_status" "post_class_content_status" NOT NULL,
  "timing_status" "post_class_timing_status" NOT NULL,
  "deduction_status" "post_class_deduction_status" DEFAULT 'none' NOT NULL,
  "enforcement_mode" "post_class_enforcement_mode" NOT NULL,
  "assessed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "required_fields_passed" boolean DEFAULT false NOT NULL,
  "combined_raw_char_count" integer DEFAULT 0 NOT NULL,
  "field_failures" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "objective_violation" boolean DEFAULT false NOT NULL,
  "raw_on_time" boolean DEFAULT false NOT NULL,
  "adjusted_compliant" boolean DEFAULT false NOT NULL,
  "remediated_late" boolean DEFAULT false NOT NULL,
  "timing_unknown" boolean DEFAULT false NOT NULL,
  "timing_evidence" text,
  "source_ready" boolean DEFAULT false NOT NULL,
  "details" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pc_assessments_session_fk"
    FOREIGN KEY ("session_id") REFERENCES "public"."post_class_sessions"("id") ON DELETE cascade,
  CONSTRAINT "pc_assessments_feedback_fk"
    FOREIGN KEY ("feedback_version_id") REFERENCES "public"."post_class_feedback_versions"("id") ON DELETE set null,
  CONSTRAINT "pc_assessment_versions_check" CHECK ("policy_version" > 0 AND "mapping_version" > 0),
  CONSTRAINT "pc_assessment_raw_char_count_check" CHECK ("combined_raw_char_count" >= 0)
);

CREATE TABLE "post_class_source_issues" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "sync_run_id" uuid,
  "session_id" uuid,
  "scope" text NOT NULL,
  "issue_type" text NOT NULL,
  "severity" text DEFAULT 'warning' NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "fingerprint" text NOT NULL,
  "blocks_enforcement" boolean DEFAULT true NOT NULL,
  "message" text NOT NULL,
  "details" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp with time zone,
  "resolved_by_email" text,
  CONSTRAINT "pc_source_issues_sync_run_fk"
    FOREIGN KEY ("sync_run_id") REFERENCES "public"."post_class_sync_runs"("id") ON DELETE set null,
  CONSTRAINT "pc_source_issues_session_fk"
    FOREIGN KEY ("session_id") REFERENCES "public"."post_class_sessions"("id") ON DELETE cascade,
  CONSTRAINT "pc_source_issue_status_check" CHECK ("status" IN ('open', 'resolved'))
);

CREATE TABLE "post_class_notification_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" "post_class_notification_kind" NOT NULL,
  "status" "post_class_notification_status" DEFAULT 'pending' NOT NULL,
  "scheduled_for" timestamp with time zone NOT NULL,
  "idempotency_key" text NOT NULL,
  "trigger_type" text DEFAULT 'cron' NOT NULL,
  "actor_email" text,
  "eligible_count" integer DEFAULT 0 NOT NULL,
  "delivery_count" integer DEFAULT 0 NOT NULL,
  "sent_count" integer DEFAULT 0 NOT NULL,
  "failed_count" integer DEFAULT 0 NOT NULL,
  "cancelled_count" integer DEFAULT 0 NOT NULL,
  "error_summary" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pc_notification_run_counts_check" CHECK (
    "eligible_count" >= 0 AND "delivery_count" >= 0 AND "sent_count" >= 0
    AND "failed_count" >= 0 AND "cancelled_count" >= 0
  )
);

CREATE TABLE "post_class_notification_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL,
  "canonical_tutor_key" text,
  "recipient_email" text NOT NULL,
  "subject" text NOT NULL,
  "status" "post_class_notification_status" DEFAULT 'pending' NOT NULL,
  "idempotency_key" text NOT NULL,
  "provider" text,
  "provider_message_id" text,
  "next_attempt_at" timestamp with time zone,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "final_error" text,
  "sent_at" timestamp with time zone,
  "cancelled_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pc_notification_deliveries_run_fk"
    FOREIGN KEY ("run_id") REFERENCES "public"."post_class_notification_runs"("id") ON DELETE cascade,
  CONSTRAINT "pc_notification_delivery_attempts_check" CHECK ("attempt_count" >= 0)
);

CREATE TABLE "post_class_notification_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "delivery_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "failure_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "raw_char_count" integer DEFAULT 0 NOT NULL,
  "deadline_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pc_notification_items_delivery_fk"
    FOREIGN KEY ("delivery_id") REFERENCES "public"."post_class_notification_deliveries"("id") ON DELETE cascade,
  CONSTRAINT "pc_notification_items_session_fk"
    FOREIGN KEY ("session_id") REFERENCES "public"."post_class_sessions"("id") ON DELETE cascade,
  CONSTRAINT "pc_notification_item_char_count_check" CHECK ("raw_char_count" >= 0)
);

CREATE TABLE "post_class_notification_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "delivery_id" uuid NOT NULL,
  "attempt_number" integer NOT NULL,
  "provider" text NOT NULL,
  "status" "post_class_notification_status" NOT NULL,
  "provider_message_id" text,
  "error_code" text,
  "error_message" text,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  CONSTRAINT "pc_notification_attempts_delivery_fk"
    FOREIGN KEY ("delivery_id") REFERENCES "public"."post_class_notification_deliveries"("id") ON DELETE cascade,
  CONSTRAINT "pc_notification_attempt_number_check" CHECK ("attempt_number" > 0)
);

CREATE TABLE "post_class_ai_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL,
  "feedback_version_id" uuid NOT NULL,
  "status" "post_class_ai_status" DEFAULT 'pending' NOT NULL,
  "trigger_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "model" text NOT NULL,
  "request_hash" text NOT NULL,
  "redaction_version" integer DEFAULT 1 NOT NULL,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "error_message" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pc_ai_runs_session_fk"
    FOREIGN KEY ("session_id") REFERENCES "public"."post_class_sessions"("id") ON DELETE cascade,
  CONSTRAINT "pc_ai_runs_feedback_fk"
    FOREIGN KEY ("feedback_version_id") REFERENCES "public"."post_class_feedback_versions"("id") ON DELETE cascade,
  CONSTRAINT "pc_ai_redaction_version_check" CHECK ("redaction_version" > 0)
);

CREATE TABLE "post_class_ai_concerns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL,
  "dimension" text NOT NULL,
  "summary" text NOT NULL,
  "confidence" double precision,
  "decision" "post_class_concern_decision" DEFAULT 'pending' NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pc_ai_concerns_run_fk"
    FOREIGN KEY ("run_id") REFERENCES "public"."post_class_ai_runs"("id") ON DELETE cascade,
  CONSTRAINT "pc_ai_concern_confidence_check" CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1)),
  CONSTRAINT "pc_ai_concern_version_check" CHECK ("version" > 0)
);

CREATE TABLE "post_class_ai_reviews" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "concern_id" uuid NOT NULL,
  "decision" "post_class_concern_decision" NOT NULL,
  "note" text NOT NULL,
  "actor_email" text NOT NULL,
  "expected_version" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pc_ai_reviews_concern_fk"
    FOREIGN KEY ("concern_id") REFERENCES "public"."post_class_ai_concerns"("id") ON DELETE cascade,
  CONSTRAINT "pc_ai_review_decision_check" CHECK ("decision" <> 'pending'),
  CONSTRAINT "pc_ai_review_note_check" CHECK (btrim("note") <> ''),
  CONSTRAINT "pc_ai_review_version_check" CHECK ("expected_version" > 0)
);

CREATE TABLE "post_class_finance_periods" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "month" date NOT NULL,
  "status" "post_class_finance_period_status" DEFAULT 'open' NOT NULL,
  "opened_by_email" text NOT NULL,
  "opened_at" timestamp with time zone DEFAULT now() NOT NULL,
  "closed_by_email" text,
  "closed_at" timestamp with time zone,
  "close_reason" text,
  "reopen_reason" text,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pc_finance_period_month_check" CHECK ("month" = date_trunc('month', "month")::date),
  CONSTRAINT "pc_finance_period_version_check" CHECK ("version" > 0),
  CONSTRAINT "pc_finance_period_closed_check" CHECK (
    "status" <> 'closed' OR ("closed_by_email" IS NOT NULL AND "closed_at" IS NOT NULL)
  )
);

CREATE TABLE "post_class_deductions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL,
  "status" "post_class_deduction_status" DEFAULT 'pending_review' NOT NULL,
  "amount_minor" integer DEFAULT 10000 NOT NULL,
  "currency" text DEFAULT 'THB' NOT NULL,
  "default_finance_month" date NOT NULL,
  "finance_period_id" uuid,
  "waiver_category" text,
  "waiver_note" text,
  "decision_by_email" text,
  "decision_at" timestamp with time zone,
  "processing_reference" text,
  "processed_by_email" text,
  "processed_at" timestamp with time zone,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pc_deductions_session_fk"
    FOREIGN KEY ("session_id") REFERENCES "public"."post_class_sessions"("id") ON DELETE restrict,
  CONSTRAINT "pc_deductions_finance_period_fk"
    FOREIGN KEY ("finance_period_id") REFERENCES "public"."post_class_finance_periods"("id") ON DELETE restrict,
  CONSTRAINT "pc_deduction_status_check" CHECK ("status" <> 'none'),
  CONSTRAINT "pc_deduction_amount_check" CHECK ("amount_minor" = 10000 AND "currency" = 'THB'),
  CONSTRAINT "pc_deduction_month_check" CHECK ("default_finance_month" = date_trunc('month', "default_finance_month")::date),
  CONSTRAINT "pc_deduction_version_check" CHECK ("version" > 0)
);

CREATE TABLE "post_class_deduction_actions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "deduction_id" uuid NOT NULL,
  "action" text NOT NULL,
  "from_status" "post_class_deduction_status",
  "to_status" "post_class_deduction_status" NOT NULL,
  "amount_minor" integer NOT NULL,
  "finance_period_id" uuid,
  "waiver_category" text,
  "note" text,
  "reference" text,
  "actor_email" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  CONSTRAINT "pc_deduction_actions_deduction_fk"
    FOREIGN KEY ("deduction_id") REFERENCES "public"."post_class_deductions"("id") ON DELETE restrict,
  CONSTRAINT "pc_deduction_actions_finance_period_fk"
    FOREIGN KEY ("finance_period_id") REFERENCES "public"."post_class_finance_periods"("id") ON DELETE restrict,
  CONSTRAINT "pc_deduction_action_to_status_check" CHECK ("to_status" <> 'none')
);

CREATE TABLE "post_class_deduction_offsets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "deduction_id" uuid NOT NULL,
  "finance_period_id" uuid NOT NULL,
  "amount_minor" integer DEFAULT -10000 NOT NULL,
  "currency" text DEFAULT 'THB' NOT NULL,
  "reason" text NOT NULL,
  "reference" text NOT NULL,
  "actor_email" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pc_deduction_offsets_deduction_fk"
    FOREIGN KEY ("deduction_id") REFERENCES "public"."post_class_deductions"("id") ON DELETE restrict,
  CONSTRAINT "pc_deduction_offsets_period_fk"
    FOREIGN KEY ("finance_period_id") REFERENCES "public"."post_class_finance_periods"("id") ON DELETE restrict,
  CONSTRAINT "pc_deduction_offset_amount_check" CHECK ("amount_minor" = -10000 AND "currency" = 'THB'),
  CONSTRAINT "pc_deduction_offset_reason_check" CHECK (btrim("reason") <> '' AND btrim("reference") <> '')
);

CREATE INDEX "pc_enforcement_mode_start_idx" ON "post_class_enforcement_windows" USING btree ("mode", "starts_at");
CREATE INDEX "pc_enforcement_open_idx" ON "post_class_enforcement_windows" USING btree ("ends_at");
CREATE UNIQUE INDEX "pc_enforcement_one_open_idx" ON "post_class_enforcement_windows" ((1)) WHERE "ends_at" IS NULL;
CREATE UNIQUE INDEX "pc_field_mapping_version_key_idx" ON "post_class_field_mappings" USING btree ("mapping_version", "field_key");
CREATE INDEX "pc_field_mapping_active_idx" ON "post_class_field_mappings" USING btree ("active", "mapping_version");
CREATE UNIQUE INDEX "pc_access_email_capability_idx" ON "post_class_access_grants" USING btree ("email", "capability");
CREATE INDEX "pc_access_capability_idx" ON "post_class_access_grants" USING btree ("capability", "email");
CREATE INDEX "pc_config_audit_entity_idx" ON "post_class_config_audit_log" USING btree ("entity_type", "entity_key", "created_at");
CREATE INDEX "pc_config_audit_actor_idx" ON "post_class_config_audit_log" USING btree ("actor_email", "created_at");
CREATE UNIQUE INDEX "pc_digest_recipient_email_idx" ON "post_class_digest_recipients" USING btree ("email");
CREATE INDEX "pc_digest_recipient_enabled_idx" ON "post_class_digest_recipients" USING btree ("enabled", "email");
CREATE UNIQUE INDEX "pc_sync_single_running_idx" ON "post_class_sync_runs" USING btree ("status") WHERE "status" = 'running';
CREATE INDEX "pc_sync_status_started_idx" ON "post_class_sync_runs" USING btree ("status", "started_at");
CREATE INDEX "pc_sync_window_idx" ON "post_class_sync_runs" USING btree ("window_start", "window_end");
CREATE UNIQUE INDEX "pc_sessions_wise_session_idx" ON "post_class_sessions" USING btree ("wise_session_id");
CREATE INDEX "pc_sessions_tutor_end_idx" ON "post_class_sessions" USING btree ("canonical_tutor_key", "scheduled_end_at");
CREATE INDEX "pc_sessions_deadline_idx" ON "post_class_sessions" USING btree ("deadline_at");
CREATE INDEX "pc_sessions_ops_idx" ON "post_class_sessions" USING btree ("eligible", "source_status", "timing_status");
CREATE INDEX "pc_sessions_deduction_idx" ON "post_class_sessions" USING btree ("deduction_status", "deadline_at");
CREATE UNIQUE INDEX "pc_participants_session_key_idx" ON "post_class_session_participants" USING btree ("session_id", "participant_key");
CREATE INDEX "pc_participants_student_idx" ON "post_class_session_participants" USING btree ("wise_student_id");
CREATE UNIQUE INDEX "pc_feedback_session_version_idx" ON "post_class_feedback_versions" USING btree ("session_id", "version_key");
CREATE INDEX "pc_feedback_session_observed_idx" ON "post_class_feedback_versions" USING btree ("session_id", "observed_at");
CREATE INDEX "pc_feedback_submission_idx" ON "post_class_feedback_versions" USING btree ("wise_submission_id");
CREATE INDEX "pc_feedback_hash_idx" ON "post_class_feedback_versions" USING btree ("content_hash");
CREATE UNIQUE INDEX "pc_event_links_session_event_idx" ON "post_class_feedback_event_links" USING btree ("session_id", "wise_event_id");
CREATE INDEX "pc_event_links_feedback_idx" ON "post_class_feedback_event_links" USING btree ("feedback_version_id");
CREATE UNIQUE INDEX "pc_assessments_key_idx" ON "post_class_assessments" USING btree ("assessment_key");
CREATE INDEX "pc_assessments_session_time_idx" ON "post_class_assessments" USING btree ("session_id", "assessed_at");
CREATE INDEX "pc_assessments_metrics_idx" ON "post_class_assessments" USING btree ("source_ready", "adjusted_compliant", "assessed_at");
CREATE UNIQUE INDEX "pc_source_issues_fingerprint_idx" ON "post_class_source_issues" USING btree ("fingerprint");
CREATE INDEX "pc_source_issues_status_idx" ON "post_class_source_issues" USING btree ("status", "severity", "last_seen_at");
CREATE INDEX "pc_source_issues_session_idx" ON "post_class_source_issues" USING btree ("session_id");
CREATE UNIQUE INDEX "pc_notification_runs_idempotency_idx" ON "post_class_notification_runs" USING btree ("idempotency_key");
CREATE INDEX "pc_notification_runs_kind_time_idx" ON "post_class_notification_runs" USING btree ("kind", "scheduled_for");
CREATE INDEX "pc_notification_runs_status_idx" ON "post_class_notification_runs" USING btree ("status", "created_at");
CREATE UNIQUE INDEX "pc_notification_delivery_idempotency_idx" ON "post_class_notification_deliveries" USING btree ("idempotency_key");
CREATE INDEX "pc_notification_delivery_run_idx" ON "post_class_notification_deliveries" USING btree ("run_id");
CREATE INDEX "pc_notification_delivery_retry_idx" ON "post_class_notification_deliveries" USING btree ("status", "next_attempt_at");
CREATE INDEX "pc_notification_delivery_tutor_idx" ON "post_class_notification_deliveries" USING btree ("canonical_tutor_key", "created_at");
CREATE UNIQUE INDEX "pc_notification_item_delivery_session_idx" ON "post_class_notification_items" USING btree ("delivery_id", "session_id");
CREATE INDEX "pc_notification_item_session_idx" ON "post_class_notification_items" USING btree ("session_id");
CREATE UNIQUE INDEX "pc_notification_attempt_number_idx" ON "post_class_notification_attempts" USING btree ("delivery_id", "attempt_number");
CREATE INDEX "pc_notification_attempt_status_idx" ON "post_class_notification_attempts" USING btree ("status", "started_at");
CREATE UNIQUE INDEX "pc_ai_runs_request_hash_idx" ON "post_class_ai_runs" USING btree ("request_hash");
CREATE INDEX "pc_ai_runs_session_idx" ON "post_class_ai_runs" USING btree ("session_id", "created_at");
CREATE INDEX "pc_ai_runs_status_idx" ON "post_class_ai_runs" USING btree ("status", "created_at");
CREATE UNIQUE INDEX "pc_ai_concern_run_dimension_idx" ON "post_class_ai_concerns" USING btree ("run_id", "dimension");
CREATE INDEX "pc_ai_concern_decision_idx" ON "post_class_ai_concerns" USING btree ("decision", "updated_at");
CREATE INDEX "pc_ai_reviews_concern_idx" ON "post_class_ai_reviews" USING btree ("concern_id", "created_at");
CREATE INDEX "pc_ai_reviews_actor_idx" ON "post_class_ai_reviews" USING btree ("actor_email", "created_at");
CREATE UNIQUE INDEX "pc_finance_period_month_idx" ON "post_class_finance_periods" USING btree ("month");
CREATE INDEX "pc_finance_period_status_idx" ON "post_class_finance_periods" USING btree ("status", "month");
CREATE UNIQUE INDEX "pc_deductions_session_idx" ON "post_class_deductions" USING btree ("session_id");
CREATE INDEX "pc_deductions_status_idx" ON "post_class_deductions" USING btree ("status", "created_at");
CREATE INDEX "pc_deductions_period_idx" ON "post_class_deductions" USING btree ("finance_period_id", "status");
CREATE UNIQUE INDEX "pc_deduction_actions_idempotency_idx" ON "post_class_deduction_actions" USING btree ("idempotency_key");
CREATE INDEX "pc_deduction_actions_deduction_idx" ON "post_class_deduction_actions" USING btree ("deduction_id", "occurred_at");
CREATE INDEX "pc_deduction_actions_actor_idx" ON "post_class_deduction_actions" USING btree ("actor_email", "occurred_at");
CREATE UNIQUE INDEX "pc_deduction_offsets_deduction_idx" ON "post_class_deduction_offsets" USING btree ("deduction_id");
CREATE UNIQUE INDEX "pc_deduction_offsets_idempotency_idx" ON "post_class_deduction_offsets" USING btree ("idempotency_key");
CREATE INDEX "pc_deduction_offsets_period_idx" ON "post_class_deduction_offsets" USING btree ("finance_period_id", "created_at");

CREATE FUNCTION "post_class_reject_immutable_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE FUNCTION "post_class_protect_feedback_evidence"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  IF OLD."session_id" IS DISTINCT FROM NEW."session_id"
    OR OLD."version_key" IS DISTINCT FROM NEW."version_key"
    OR OLD."wise_submission_id" IS DISTINCT FROM NEW."wise_submission_id"
    OR OLD."content_hash" IS DISTINCT FROM NEW."content_hash"
    OR OLD."profile" IS DISTINCT FROM NEW."profile"
    OR OLD."source_created_at" IS DISTINCT FROM NEW."source_created_at"
    OR OLD."source_timestamp_trustworthy" IS DISTINCT FROM NEW."source_timestamp_trustworthy"
    OR OLD."source_timestamp_kind" IS DISTINCT FROM NEW."source_timestamp_kind"
    OR OLD."observed_at" IS DISTINCT FROM NEW."observed_at"
    OR OLD."answers" IS DISTINCT FROM NEW."answers"
  THEN
    RAISE EXCEPTION 'source evidence in % is immutable', TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "pc_feedback_versions_immutable"
  BEFORE UPDATE OR DELETE ON "post_class_feedback_versions"
  FOR EACH ROW EXECUTE FUNCTION "post_class_protect_feedback_evidence"();
CREATE TRIGGER "pc_assessments_immutable"
  BEFORE UPDATE OR DELETE ON "post_class_assessments"
  FOR EACH ROW EXECUTE FUNCTION "post_class_reject_immutable_mutation"();
CREATE TRIGGER "pc_config_audit_immutable"
  BEFORE UPDATE OR DELETE ON "post_class_config_audit_log"
  FOR EACH ROW EXECUTE FUNCTION "post_class_reject_immutable_mutation"();
CREATE TRIGGER "pc_ai_reviews_immutable"
  BEFORE UPDATE OR DELETE ON "post_class_ai_reviews"
  FOR EACH ROW EXECUTE FUNCTION "post_class_reject_immutable_mutation"();
CREATE TRIGGER "pc_deduction_actions_immutable"
  BEFORE UPDATE OR DELETE ON "post_class_deduction_actions"
  FOR EACH ROW EXECUTE FUNCTION "post_class_reject_immutable_mutation"();
CREATE TRIGGER "pc_deduction_offsets_immutable"
  BEFORE UPDATE OR DELETE ON "post_class_deduction_offsets"
  FOR EACH ROW EXECUTE FUNCTION "post_class_reject_immutable_mutation"();

CREATE FUNCTION "post_class_protect_processed_deduction"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status = 'processed' THEN
    RAISE EXCEPTION 'processed deduction records are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "pc_processed_deduction_immutable"
  BEFORE UPDATE OR DELETE ON "post_class_deductions"
  FOR EACH ROW EXECUTE FUNCTION "post_class_protect_processed_deduction"();

WITH initial_window AS (
  INSERT INTO "post_class_enforcement_windows" ("mode", "starts_at", "actor_email", "reason")
  VALUES ('shadow', now(), 'system:migration', 'Initial shadow-mode rollout')
  RETURNING "id"
)
INSERT INTO "post_class_settings" (
  "id", "enforcement_mode", "current_window_id", "policy_version",
  "form_mapping_version", "form_mapping_valid", "version", "updated_by_email"
)
SELECT 'default', 'shadow', "id", 1, 1, true, 1, 'system:migration'
FROM initial_window;

INSERT INTO "post_class_field_mappings" (
  "mapping_version", "field_key", "wise_question_text", "normalized_question_text",
  "required_for_compliance", "active", "updated_by_email"
) VALUES
  (1, 'topics', 'Topics covered', 'topics covered', true, true, 'system:migration'),
  (1, 'performance', 'How the student did in class', 'how the student did in class', true, true, 'system:migration'),
  (1, 'improvement', 'Need more work on', 'need more work on', true, true, 'system:migration'),
  (1, 'homework', 'Homework and due date', 'homework and due date', false, true, 'system:migration');

INSERT INTO "post_class_access_grants" ("email", "capability", "granted_by_email")
SELECT lower(btrim("email")), 'viewer', 'system:migration'
FROM "admin_users"
WHERE btrim("email") <> '' AND "allowed_pages" IS NULL
ON CONFLICT ("email", "capability") DO NOTHING;

INSERT INTO "post_class_access_grants" ("email", "capability", "granted_by_email") VALUES
  ('kevhsh7@gmail.com', 'viewer', 'system:migration'),
  ('kevhsh7@gmail.com', 'reviewer', 'system:migration'),
  ('kevhsh7@gmail.com', 'finance', 'system:migration'),
  ('kevhsh7@gmail.com', 'access_manager', 'system:migration')
ON CONFLICT ("email", "capability") DO NOTHING;

INSERT INTO "post_class_digest_recipients" ("email", "enabled", "updated_by_email")
VALUES ('kevhsh7@gmail.com', true, 'system:migration')
ON CONFLICT ("email") DO UPDATE SET
  "enabled" = EXCLUDED."enabled",
  "updated_by_email" = EXCLUDED."updated_by_email",
  "updated_at" = now();
