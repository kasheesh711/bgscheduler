CREATE TYPE "public"."admissions_notification_outbox_status" AS ENUM('pending', 'processing', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."admissions_test_sitting_status" AS ENUM('planned', 'registered', 'taken', 'score_received', 'canceled');--> statement-breakpoint
CREATE TABLE "admissions_awards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"title" text NOT NULL,
	"organization" text,
	"grade_levels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recognition_levels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"award_date" date,
	"common_app_rank" integer,
	"uc_eligibility_narrative" text,
	"uc_achievement_narrative" text,
	"internal_notes" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admissions_awards_common_app_rank_check" CHECK ("admissions_awards"."common_app_rank" IS NULL OR ("admissions_awards"."common_app_rank" >= 1 AND "admissions_awards"."common_app_rank" <= 5)),
	CONSTRAINT "admissions_awards_uc_eligibility_length_check" CHECK ("admissions_awards"."uc_eligibility_narrative" IS NULL OR char_length("admissions_awards"."uc_eligibility_narrative") <= 250),
	CONSTRAINT "admissions_awards_uc_achievement_length_check" CHECK ("admissions_awards"."uc_achievement_narrative" IS NULL OR char_length("admissions_awards"."uc_achievement_narrative") <= 350)
);
--> statement-breakpoint
CREATE TABLE "admissions_college_requirements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"list_item_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"status" "admissions_task_status" DEFAULT 'not_started' NOT NULL,
	"owner" "admissions_task_owner" DEFAULT 'student' NOT NULL,
	"due_date" date,
	"required" boolean DEFAULT true NOT NULL,
	"source_url" text,
	"notes" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"verified_by_email" text,
	"verified_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admissions_college_research" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"list_item_id" uuid NOT NULL,
	"fit_rating" integer,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"campus_visit_date" date,
	"campus_visit_notes" text,
	"academic_notes" text,
	"opportunities" text,
	"questions" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admissions_college_research_fit_rating_check" CHECK ("admissions_college_research"."fit_rating" IS NULL OR ("admissions_college_research"."fit_rating" >= 1 AND "admissions_college_research"."fit_rating" <= 5))
);
--> statement-breakpoint
CREATE TABLE "admissions_essay_prompt_catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"unit_id" integer,
	"institution" text NOT NULL,
	"program" text DEFAULT '' NOT NULL,
	"cycle" text NOT NULL,
	"prompt_key" text NOT NULL,
	"prompt" text NOT NULL,
	"word_limit" integer,
	"required" boolean DEFAULT true NOT NULL,
	"source_url" text,
	"verified_at" timestamp with time zone,
	"verified_by_email" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admissions_essay_prompt_catalog_word_limit_check" CHECK ("admissions_essay_prompt_catalog"."word_limit" IS NULL OR "admissions_essay_prompt_catalog"."word_limit" > 0)
);
--> statement-breakpoint
CREATE TABLE "admissions_financial_aid_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"list_item_id" uuid NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"award_year" integer NOT NULL,
	"cost_breakdown" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"gift_aid_breakdown" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"loan_breakdown" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"work_study_amount" numeric,
	"net_cost" numeric,
	"remaining_balance" numeric,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admissions_import_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"severity" text NOT NULL,
	"code" text NOT NULL,
	"sheet_name" text,
	"source_ref" text,
	"message" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admissions_import_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"source_key" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"source_value_fingerprint" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admissions_import_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"spreadsheet_id" text NOT NULL,
	"spreadsheet_url" text NOT NULL,
	"source_fingerprint" text NOT NULL,
	"status" text DEFAULT 'preview' NOT NULL,
	"conflict_policy" text,
	"source_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_email" text NOT NULL,
	"committed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"error_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admissions_interest_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"list_item_id" uuid NOT NULL,
	"type" text NOT NULL,
	"event_date" date NOT NULL,
	"notes" text,
	"actor_email" text NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admissions_notification_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid,
	"member_id" uuid,
	"recipient_email" text NOT NULL,
	"category" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" "admissions_notification_outbox_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"provider_message_id" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admissions_scholarships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"list_item_id" uuid,
	"name" text NOT NULL,
	"provider" text,
	"url" text,
	"requirements" text,
	"deadline" date,
	"status" text DEFAULT 'researching' NOT NULL,
	"outcome" text,
	"offered_amount" numeric,
	"notes" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admissions_academic_records" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admissions_cases" ADD COLUMN "family_portal_open" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "admissions_cases" ADD COLUMN "family_portal_opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admissions_cases" ADD COLUMN "family_portal_opened_by_email" text;--> statement-breakpoint
ALTER TABLE "admissions_college_list_items" ADD COLUMN "first_choice_major" text;--> statement-breakpoint
ALTER TABLE "admissions_college_list_items" ADD COLUMN "second_choice_major" text;--> statement-breakpoint
ALTER TABLE "admissions_college_list_items" ADD COLUMN "admissions_url" text;--> statement-breakpoint
ALTER TABLE "admissions_college_list_items" ADD COLUMN "portal_url" text;--> statement-breakpoint
ALTER TABLE "admissions_essays" ADD COLUMN "shared_with_family" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "admissions_self_report_sections" ADD COLUMN "shared_with_family" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "admissions_test_sittings" ADD COLUMN "late_registration_deadline" date;--> statement-breakpoint
ALTER TABLE "admissions_test_sittings" ADD COLUMN "status" "admissions_test_sitting_status" DEFAULT 'planned' NOT NULL;--> statement-breakpoint
ALTER TABLE "admissions_test_sittings" ADD COLUMN "subject" text;--> statement-breakpoint
ALTER TABLE "admissions_test_sittings" ADD COLUMN "score_details" jsonb;--> statement-breakpoint
ALTER TABLE "admissions_test_sittings" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admissions_awards" ADD CONSTRAINT "admissions_awards_case_id_admissions_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."admissions_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions_college_requirements" ADD CONSTRAINT "admissions_college_requirements_list_item_id_admissions_college_list_items_id_fk" FOREIGN KEY ("list_item_id") REFERENCES "public"."admissions_college_list_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions_college_research" ADD CONSTRAINT "admissions_college_research_list_item_id_admissions_college_list_items_id_fk" FOREIGN KEY ("list_item_id") REFERENCES "public"."admissions_college_list_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions_financial_aid_offers" ADD CONSTRAINT "admissions_financial_aid_offers_list_item_id_admissions_college_list_items_id_fk" FOREIGN KEY ("list_item_id") REFERENCES "public"."admissions_college_list_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions_import_issues" ADD CONSTRAINT "admissions_import_issues_run_id_admissions_import_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."admissions_import_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions_import_mappings" ADD CONSTRAINT "admissions_import_mappings_run_id_admissions_import_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."admissions_import_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions_import_runs" ADD CONSTRAINT "admissions_import_runs_case_id_admissions_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."admissions_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions_interest_events" ADD CONSTRAINT "admissions_interest_events_list_item_id_admissions_college_list_items_id_fk" FOREIGN KEY ("list_item_id") REFERENCES "public"."admissions_college_list_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions_notification_outbox" ADD CONSTRAINT "admissions_notification_outbox_case_id_admissions_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."admissions_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions_notification_outbox" ADD CONSTRAINT "admissions_notification_outbox_member_id_admissions_case_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."admissions_case_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions_scholarships" ADD CONSTRAINT "admissions_scholarships_case_id_admissions_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."admissions_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions_scholarships" ADD CONSTRAINT "admissions_scholarships_list_item_id_admissions_college_list_items_id_fk" FOREIGN KEY ("list_item_id") REFERENCES "public"."admissions_college_list_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admissions_awards_case_common_app_rank_idx" ON "admissions_awards" USING btree ("case_id","common_app_rank") WHERE "admissions_awards"."deleted_at" IS NULL AND "admissions_awards"."common_app_rank" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "admissions_awards_case_date_idx" ON "admissions_awards" USING btree ("case_id","award_date");--> statement-breakpoint
CREATE INDEX "admissions_college_requirements_item_sort_idx" ON "admissions_college_requirements" USING btree ("list_item_id","sort_order");--> statement-breakpoint
CREATE INDEX "admissions_college_requirements_item_due_idx" ON "admissions_college_requirements" USING btree ("list_item_id","due_date");--> statement-breakpoint
CREATE UNIQUE INDEX "admissions_college_research_list_item_idx" ON "admissions_college_research" USING btree ("list_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "admissions_essay_prompt_catalog_identity_idx" ON "admissions_essay_prompt_catalog" USING btree ("institution","program","cycle","prompt_key");--> statement-breakpoint
CREATE INDEX "admissions_essay_prompt_catalog_unit_cycle_idx" ON "admissions_essay_prompt_catalog" USING btree ("unit_id","cycle");--> statement-breakpoint
CREATE UNIQUE INDEX "admissions_financial_aid_offers_list_item_idx" ON "admissions_financial_aid_offers" USING btree ("list_item_id");--> statement-breakpoint
CREATE INDEX "admissions_import_issues_run_severity_idx" ON "admissions_import_issues" USING btree ("run_id","severity");--> statement-breakpoint
CREATE UNIQUE INDEX "admissions_import_mappings_source_idx" ON "admissions_import_mappings" USING btree ("run_id","source_type","source_key");--> statement-breakpoint
CREATE INDEX "admissions_import_mappings_target_idx" ON "admissions_import_mappings" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "admissions_import_runs_source_fingerprint_idx" ON "admissions_import_runs" USING btree ("case_id","spreadsheet_id","source_fingerprint");--> statement-breakpoint
CREATE INDEX "admissions_import_runs_case_created_idx" ON "admissions_import_runs" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE INDEX "admissions_interest_events_item_date_idx" ON "admissions_interest_events" USING btree ("list_item_id","event_date");--> statement-breakpoint
CREATE UNIQUE INDEX "admissions_notification_outbox_dedupe_key_idx" ON "admissions_notification_outbox" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "admissions_notification_outbox_delivery_idx" ON "admissions_notification_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "admissions_notification_outbox_case_idx" ON "admissions_notification_outbox" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "admissions_scholarships_case_deadline_idx" ON "admissions_scholarships" USING btree ("case_id","deadline");--> statement-breakpoint
CREATE INDEX "admissions_scholarships_list_item_idx" ON "admissions_scholarships" USING btree ("list_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "admissions_academic_records_case_system_date_idx" ON "admissions_academic_records" USING btree ("case_id","system","effective_date") WHERE "admissions_academic_records"."deleted_at" IS NULL;