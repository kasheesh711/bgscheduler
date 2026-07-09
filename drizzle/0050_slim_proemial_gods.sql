CREATE TYPE "public"."admissions_app_round" AS ENUM('ed', 'ed2', 'ea', 'rea', 'rd', 'rolling', 'priority', 'other');--> statement-breakpoint
CREATE TYPE "public"."admissions_app_status" AS ENUM('researching', 'applying', 'submitted', 'complete');--> statement-breakpoint
CREATE TYPE "public"."admissions_case_status" AS ENUM('active', 'committed', 'completed', 'withdrawn', 'archived');--> statement-breakpoint
CREATE TYPE "public"."admissions_college_category" AS ENUM('reach', 'match', 'safety', 'unset');--> statement-breakpoint
CREATE TYPE "public"."admissions_decision_event" AS ENUM('submitted', 'deferred', 'waitlisted', 'accepted', 'denied', 'withdrawn', 'committed');--> statement-breakpoint
CREATE TYPE "public"."admissions_essay_status" AS ENUM('not_started', 'brainstorming', 'drafting', 'feedback', 'final');--> statement-breakpoint
CREATE TYPE "public"."admissions_member_role" AS ENUM('counselor', 'student', 'parent');--> statement-breakpoint
CREATE TYPE "public"."admissions_member_status" AS ENUM('invited', 'active', 'revoked', 'bounced');--> statement-breakpoint
CREATE TYPE "public"."admissions_note_visibility" AS ENUM('staff_only', 'shared_with_family');--> statement-breakpoint
CREATE TYPE "public"."admissions_rec_status" AS ENUM('planned', 'asked', 'agreed', 'declined');--> statement-breakpoint
CREATE TYPE "public"."admissions_submission_state" AS ENUM('draft', 'submitted', 'reviewed');--> statement-breakpoint
CREATE TYPE "public"."admissions_task_owner" AS ENUM('student', 'counselor', 'parent');--> statement-breakpoint
CREATE TYPE "public"."admissions_task_status" AS ENUM('not_started', 'in_progress', 'done');--> statement-breakpoint
CREATE TYPE "public"."admissions_test_type" AS ENUM('sat', 'act', 'ap', 'ib', 'toefl', 'ielts', 'other');--> statement-breakpoint
CREATE TABLE "admissions_academic_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"system" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"effective_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admissions_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"name" text NOT NULL,
	"full_description" text,
	"common_app" jsonb,
	"uc" jsonb,
	"common_app_rank" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admissions_announcements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cohort_id" uuid,
	"case_id" uuid,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"author_email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admissions_announcements_target_check" CHECK (("admissions_announcements"."cohort_id" IS NULL) <> ("admissions_announcements"."case_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "admissions_application_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"list_item_id" uuid NOT NULL,
	"event" "admissions_decision_event" NOT NULL,
	"event_date" date NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admissions_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid,
	"actor_email" text NOT NULL,
	"actor_role" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"action" text NOT NULL,
	"diff" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admissions_case_meetings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"meeting_date" date NOT NULL,
	"mode" text,
	"attendees" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"next_meeting_date" date,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admissions_case_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "admissions_member_role" NOT NULL,
	"status" "admissions_member_status" DEFAULT 'invited' NOT NULL,
	"invited_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"added_by_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admissions_case_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"template_id" uuid,
	"template_version" integer,
	"item_key" text,
	"phase" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"owner" "admissions_task_owner" NOT NULL,
	"status" "admissions_task_status" DEFAULT 'not_started' NOT NULL,
	"due_date" date,
	"verified_by_email" text,
	"verified_at" timestamp with time zone,
	"recurrence" jsonb,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admissions_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" uuid NOT NULL,
	"cohort_id" uuid NOT NULL,
	"status" "admissions_case_status" DEFAULT 'active' NOT NULL,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"committed_list_item_id" uuid,
	"drive_folder" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admissions_checklist_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cohort_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"published_at" timestamp with time zone,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admissions_cohorts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"graduation_year" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admissions_college_docs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"list_item_id" uuid NOT NULL,
	"doc_type" text NOT NULL,
	"test_sitting_id" uuid,
	"sent" boolean DEFAULT false NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admissions_college_list_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"unit_id" integer,
	"inst_name" text NOT NULL,
	"city" text,
	"state_abbr" text,
	"country" text NOT NULL,
	"is_manual" boolean DEFAULT false NOT NULL,
	"round" "admissions_app_round" NOT NULL,
	"deadline" date,
	"app_status" "admissions_app_status" DEFAULT 'researching' NOT NULL,
	"category" "admissions_college_category" DEFAULT 'unset' NOT NULL,
	"aid_offered" numeric,
	"aid_notes" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admissions_counselors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admissions_essays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"list_item_id" uuid,
	"prompt" text NOT NULL,
	"status" "admissions_essay_status" DEFAULT 'not_started' NOT NULL,
	"counselor_stage" "admissions_essay_status",
	"deadline" date,
	"drive_url" text,
	"last_student_update_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admissions_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"author_email" text NOT NULL,
	"body" text NOT NULL,
	"visibility" "admissions_note_visibility" NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admissions_recommender_colleges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recommender_id" uuid NOT NULL,
	"list_item_id" uuid NOT NULL,
	"submitted" boolean DEFAULT false NOT NULL,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admissions_recommenders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"name" text NOT NULL,
	"role_subject" text,
	"contact" text,
	"ask_status" "admissions_rec_status" DEFAULT 'planned' NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admissions_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic" text NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admissions_self_report_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"section_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" "admissions_submission_state" DEFAULT 'draft' NOT NULL,
	"submitted_at" timestamp with time zone,
	"reviewed_by_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admissions_students" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"full_name" text NOT NULL,
	"preferred_name" text,
	"student_email" text NOT NULL,
	"phone" text,
	"school" text,
	"school_counselor" text,
	"cohort_id" uuid NOT NULL,
	"wise_student_key" text,
	"external_links" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admissions_template_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"phase" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"default_owner" "admissions_task_owner" DEFAULT 'student' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admissions_test_sittings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"test_type" "admissions_test_type" NOT NULL,
	"test_date" date NOT NULL,
	"registration_deadline" date,
	"target_score" text DEFAULT '' NOT NULL,
	"actual_score" text,
	"score_released_to_parent" boolean DEFAULT false NOT NULL,
	"accommodations" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admissions_academic_records" ADD CONSTRAINT "admissions_academic_records_case_id_admissions_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."admissions_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions_activities" ADD CONSTRAINT "admissions_activities_case_id_admissions_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."admissions_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions_application_events" ADD CONSTRAINT "admissions_application_events_list_item_id_admissions_college_list_items_id_fk" FOREIGN KEY ("list_item_id") REFERENCES "public"."admissions_college_list_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions_audit_log" ADD CONSTRAINT "admissions_audit_log_case_id_admissions_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."admissions_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions_case_meetings" ADD CONSTRAINT "admissions_case_meetings_case_id_admissions_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."admissions_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions_case_members" ADD CONSTRAINT "admissions_case_members_case_id_admissions_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."admissions_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions_case_tasks" ADD CONSTRAINT "admissions_case_tasks_case_id_admissions_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."admissions_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions_cases" ADD CONSTRAINT "admissions_cases_student_id_admissions_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."admissions_students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions_cases" ADD CONSTRAINT "admissions_cases_cohort_id_admissions_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."admissions_cohorts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions_checklist_templates" ADD CONSTRAINT "admissions_checklist_templates_cohort_id_admissions_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."admissions_cohorts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions_college_docs" ADD CONSTRAINT "admissions_college_docs_list_item_id_admissions_college_list_items_id_fk" FOREIGN KEY ("list_item_id") REFERENCES "public"."admissions_college_list_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions_college_list_items" ADD CONSTRAINT "admissions_college_list_items_case_id_admissions_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."admissions_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions_essays" ADD CONSTRAINT "admissions_essays_case_id_admissions_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."admissions_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions_notes" ADD CONSTRAINT "admissions_notes_case_id_admissions_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."admissions_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions_recommender_colleges" ADD CONSTRAINT "admissions_recommender_colleges_recommender_id_admissions_recommenders_id_fk" FOREIGN KEY ("recommender_id") REFERENCES "public"."admissions_recommenders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions_recommender_colleges" ADD CONSTRAINT "admissions_recommender_colleges_list_item_id_admissions_college_list_items_id_fk" FOREIGN KEY ("list_item_id") REFERENCES "public"."admissions_college_list_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions_recommenders" ADD CONSTRAINT "admissions_recommenders_case_id_admissions_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."admissions_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions_self_report_sections" ADD CONSTRAINT "admissions_self_report_sections_case_id_admissions_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."admissions_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions_students" ADD CONSTRAINT "admissions_students_cohort_id_admissions_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."admissions_cohorts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions_template_items" ADD CONSTRAINT "admissions_template_items_template_id_admissions_checklist_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."admissions_checklist_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions_test_sittings" ADD CONSTRAINT "admissions_test_sittings_case_id_admissions_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."admissions_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admissions_academic_records_case_system_idx" ON "admissions_academic_records" USING btree ("case_id","system");--> statement-breakpoint
CREATE INDEX "admissions_activities_case_sort_idx" ON "admissions_activities" USING btree ("case_id","sort_order");--> statement-breakpoint
CREATE INDEX "admissions_announcements_cohort_idx" ON "admissions_announcements" USING btree ("cohort_id");--> statement-breakpoint
CREATE INDEX "admissions_announcements_case_idx" ON "admissions_announcements" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "admissions_application_events_item_date_idx" ON "admissions_application_events" USING btree ("list_item_id","event_date");--> statement-breakpoint
CREATE INDEX "admissions_audit_log_case_created_idx" ON "admissions_audit_log" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE INDEX "admissions_audit_log_entity_idx" ON "admissions_audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "admissions_case_meetings_case_date_idx" ON "admissions_case_meetings" USING btree ("case_id","meeting_date");--> statement-breakpoint
CREATE UNIQUE INDEX "admissions_case_members_case_email_idx" ON "admissions_case_members" USING btree ("case_id","email");--> statement-breakpoint
CREATE INDEX "admissions_case_members_email_status_idx" ON "admissions_case_members" USING btree ("email","status");--> statement-breakpoint
CREATE INDEX "admissions_case_members_case_status_idx" ON "admissions_case_members" USING btree ("case_id","status");--> statement-breakpoint
CREATE INDEX "admissions_case_tasks_case_status_idx" ON "admissions_case_tasks" USING btree ("case_id","status");--> statement-breakpoint
CREATE INDEX "admissions_case_tasks_case_due_idx" ON "admissions_case_tasks" USING btree ("case_id","due_date");--> statement-breakpoint
CREATE UNIQUE INDEX "admissions_cases_live_student_idx" ON "admissions_cases" USING btree ("student_id") WHERE "admissions_cases"."status" IN ('active', 'committed');--> statement-breakpoint
CREATE INDEX "admissions_cases_cohort_status_idx" ON "admissions_cases" USING btree ("cohort_id","status");--> statement-breakpoint
CREATE INDEX "admissions_cases_student_idx" ON "admissions_cases" USING btree ("student_id");--> statement-breakpoint
CREATE UNIQUE INDEX "admissions_checklist_templates_cohort_version_idx" ON "admissions_checklist_templates" USING btree ("cohort_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "admissions_cohorts_name_idx" ON "admissions_cohorts" USING btree ("name");--> statement-breakpoint
CREATE INDEX "admissions_cohorts_grad_year_idx" ON "admissions_cohorts" USING btree ("graduation_year");--> statement-breakpoint
CREATE INDEX "admissions_college_docs_item_type_idx" ON "admissions_college_docs" USING btree ("list_item_id","doc_type");--> statement-breakpoint
CREATE INDEX "admissions_college_list_items_case_idx" ON "admissions_college_list_items" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "admissions_college_list_items_case_deadline_idx" ON "admissions_college_list_items" USING btree ("case_id","deadline");--> statement-breakpoint
CREATE INDEX "admissions_college_list_items_unit_idx" ON "admissions_college_list_items" USING btree ("unit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "admissions_counselors_email_idx" ON "admissions_counselors" USING btree ("email");--> statement-breakpoint
CREATE INDEX "admissions_essays_case_status_idx" ON "admissions_essays" USING btree ("case_id","status");--> statement-breakpoint
CREATE INDEX "admissions_notes_case_created_idx" ON "admissions_notes" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE INDEX "admissions_notes_case_visibility_idx" ON "admissions_notes" USING btree ("case_id","visibility");--> statement-breakpoint
CREATE UNIQUE INDEX "admissions_recommender_colleges_rec_item_idx" ON "admissions_recommender_colleges" USING btree ("recommender_id","list_item_id");--> statement-breakpoint
CREATE INDEX "admissions_recommender_colleges_item_idx" ON "admissions_recommender_colleges" USING btree ("list_item_id");--> statement-breakpoint
CREATE INDEX "admissions_recommenders_case_idx" ON "admissions_recommenders" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "admissions_resources_topic_sort_idx" ON "admissions_resources" USING btree ("topic","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "admissions_self_report_sections_case_key_idx" ON "admissions_self_report_sections" USING btree ("case_id","section_key");--> statement-breakpoint
CREATE INDEX "admissions_students_cohort_idx" ON "admissions_students" USING btree ("cohort_id");--> statement-breakpoint
CREATE INDEX "admissions_students_email_idx" ON "admissions_students" USING btree ("student_email");--> statement-breakpoint
CREATE INDEX "admissions_template_items_template_sort_idx" ON "admissions_template_items" USING btree ("template_id","sort_order");--> statement-breakpoint
CREATE INDEX "admissions_template_items_template_key_idx" ON "admissions_template_items" USING btree ("template_id","item_key");--> statement-breakpoint
CREATE INDEX "admissions_test_sittings_case_date_idx" ON "admissions_test_sittings" USING btree ("case_id","test_date");