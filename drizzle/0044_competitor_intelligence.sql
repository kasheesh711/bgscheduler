CREATE TYPE "public"."competitor_entity_kind" AS ENUM('competitor', 'own_brand');--> statement-breakpoint
CREATE TYPE "public"."competitor_source_status" AS ENUM('active', 'disabled', 'needs_review', 'archived');--> statement-breakpoint
CREATE TYPE "public"."competitor_source_type" AS ENUM('website', 'sitemap', 'instagram', 'facebook', 'serp', 'manual');--> statement-breakpoint
CREATE TYPE "public"."competitor_sync_trigger" AS ENUM('cron', 'manual', 'backfill');--> statement-breakpoint
CREATE TYPE "public"."competitor_task_status" AS ENUM('todo', 'in_progress', 'blocked', 'done', 'ignored');--> statement-breakpoint
CREATE TABLE "competitor_ai_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sync_run_id" uuid,
	"run_type" text NOT NULL,
	"status" "sync_status" DEFAULT 'running' NOT NULL,
	"model" text,
	"prompt_version" text NOT NULL,
	"input_item_count" integer DEFAULT 0 NOT NULL,
	"output" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_summary" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"latency_ms" integer
);
--> statement-breakpoint
CREATE TABLE "competitor_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"asset_type" text NOT NULL,
	"storage_provider" text DEFAULT 'vercel_blob' NOT NULL,
	"storage_key" text NOT NULL,
	"source_url" text,
	"mime_type" text,
	"size_bytes" integer,
	"checksum" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competitor_briefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brief_date" date NOT NULL,
	"sync_run_id" uuid,
	"ai_run_id" uuid,
	"title" text NOT NULL,
	"executive_summary" text NOT NULL,
	"what_changed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"why_it_matters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recommended_responses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" double precision DEFAULT 0.5 NOT NULL,
	"coverage_score" double precision DEFAULT 0 NOT NULL,
	"seo_visibility_score" double precision DEFAULT 0 NOT NULL,
	"open_task_count" integer DEFAULT 0 NOT NULL,
	"budget_usage_ratio" double precision DEFAULT 0 NOT NULL,
	"source_health" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competitor_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"kind" "competitor_entity_kind" DEFAULT 'competitor' NOT NULL,
	"category_tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"market_position" text,
	"website_url" text,
	"confidence" double precision DEFAULT 1 NOT NULL,
	"discovered_by" text DEFAULT 'seed' NOT NULL,
	"discovery_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competitor_evidence_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_key" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"source_id" uuid,
	"source_run_id" uuid,
	"channel" text NOT NULL,
	"category" text DEFAULT 'uncategorized' NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"content_text" text,
	"canonical_url" text,
	"language" text,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"impact_score" double precision DEFAULT 0 NOT NULL,
	"confidence" double precision DEFAULT 0.5 NOT NULL,
	"evidence_status" text DEFAULT 'captured' NOT NULL,
	"review_status" text DEFAULT 'new' NOT NULL,
	"pricing_signal" boolean DEFAULT false NOT NULL,
	"task_suggestion_status" text DEFAULT 'none' NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competitor_serp_keywords" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"keyword" text NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"location" text DEFAULT 'Bangkok, Thailand' NOT NULL,
	"device" text DEFAULT 'mobile' NOT NULL,
	"status" "competitor_source_status" DEFAULT 'active' NOT NULL,
	"discovered_by" text DEFAULT 'seed' NOT NULL,
	"confidence" double precision DEFAULT 1 NOT NULL,
	"auto_tracked" boolean DEFAULT false NOT NULL,
	"approved_by_email" text,
	"approved_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competitor_serp_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"observation_key" text NOT NULL,
	"keyword_id" uuid NOT NULL,
	"entity_id" uuid,
	"source_run_id" uuid,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"keyword" text NOT NULL,
	"language" text NOT NULL,
	"location" text NOT NULL,
	"device" text NOT NULL,
	"result_type" text DEFAULT 'organic' NOT NULL,
	"rank_absolute" integer,
	"rank_group" integer,
	"title" text,
	"url" text,
	"display_url" text,
	"snippet" text,
	"is_begifted" boolean DEFAULT false NOT NULL,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competitor_source_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sync_run_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"source_type" "competitor_source_type" NOT NULL,
	"status" "sync_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"fetched_count" integer DEFAULT 0 NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"new_item_count" integer DEFAULT 0 NOT NULL,
	"asset_count" integer DEFAULT 0 NOT NULL,
	"skipped_reason" text,
	"error_summary" text,
	"usage_units" double precision DEFAULT 0 NOT NULL,
	"estimated_cost_usd" double precision DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competitor_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"source_type" "competitor_source_type" NOT NULL,
	"label" text NOT NULL,
	"url" text NOT NULL,
	"handle" text,
	"provider" text DEFAULT 'internal' NOT NULL,
	"priority" integer DEFAULT 50 NOT NULL,
	"status" "competitor_source_status" DEFAULT 'active' NOT NULL,
	"reliability" text DEFAULT 'reliable' NOT NULL,
	"capture_media" boolean DEFAULT true NOT NULL,
	"best_effort" boolean DEFAULT false NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error" text,
	"created_by_email" text,
	"updated_by_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competitor_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "sync_status" DEFAULT 'running' NOT NULL,
	"trigger_type" "competitor_sync_trigger" DEFAULT 'manual' NOT NULL,
	"actor_email" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"source_count" integer DEFAULT 0 NOT NULL,
	"source_success_count" integer DEFAULT 0 NOT NULL,
	"source_failed_count" integer DEFAULT 0 NOT NULL,
	"source_skipped_count" integer DEFAULT 0 NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"new_item_count" integer DEFAULT 0 NOT NULL,
	"asset_count" integer DEFAULT 0 NOT NULL,
	"ai_run_count" integer DEFAULT 0 NOT NULL,
	"task_suggestion_count" integer DEFAULT 0 NOT NULL,
	"budget_skipped_count" integer DEFAULT 0 NOT NULL,
	"error_summary" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competitor_task_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"body" text NOT NULL,
	"attachment_asset_id" uuid,
	"created_by_email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competitor_task_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"actor_email" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competitor_task_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brief_id" uuid,
	"item_id" uuid,
	"ai_run_id" uuid,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"priority" text DEFAULT 'medium' NOT NULL,
	"due_date" date,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"suggested_owner_email" text,
	"status" text DEFAULT 'suggested' NOT NULL,
	"confidence" double precision DEFAULT 0.5 NOT NULL,
	"accepted_task_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by_email" text
);
--> statement-breakpoint
CREATE TABLE "competitor_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid,
	"brief_id" uuid,
	"suggestion_id" uuid,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" "competitor_task_status" DEFAULT 'todo' NOT NULL,
	"priority" text DEFAULT 'medium' NOT NULL,
	"owner_email" text,
	"due_date" date,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by_email" text NOT NULL,
	"updated_by_email" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competitor_vendor_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"usage_month" date NOT NULL,
	"provider" text NOT NULL,
	"source_type" "competitor_source_type" NOT NULL,
	"usage_units" double precision DEFAULT 0 NOT NULL,
	"estimated_cost_usd" double precision DEFAULT 0 NOT NULL,
	"hard_cap_usd" double precision DEFAULT 0 NOT NULL,
	"capped" boolean DEFAULT false NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "competitor_ai_runs" ADD CONSTRAINT "competitor_ai_runs_sync_run_id_competitor_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."competitor_sync_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_assets" ADD CONSTRAINT "competitor_assets_item_id_competitor_evidence_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."competitor_evidence_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_briefs" ADD CONSTRAINT "competitor_briefs_sync_run_id_competitor_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."competitor_sync_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_briefs" ADD CONSTRAINT "competitor_briefs_ai_run_id_competitor_ai_runs_id_fk" FOREIGN KEY ("ai_run_id") REFERENCES "public"."competitor_ai_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_evidence_items" ADD CONSTRAINT "competitor_evidence_items_entity_id_competitor_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."competitor_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_evidence_items" ADD CONSTRAINT "competitor_evidence_items_source_id_competitor_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."competitor_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_evidence_items" ADD CONSTRAINT "competitor_evidence_items_source_run_id_competitor_source_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."competitor_source_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_serp_observations" ADD CONSTRAINT "competitor_serp_observations_keyword_id_competitor_serp_keywords_id_fk" FOREIGN KEY ("keyword_id") REFERENCES "public"."competitor_serp_keywords"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_serp_observations" ADD CONSTRAINT "competitor_serp_observations_entity_id_competitor_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."competitor_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_serp_observations" ADD CONSTRAINT "competitor_serp_observations_source_run_id_competitor_source_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."competitor_source_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_source_runs" ADD CONSTRAINT "competitor_source_runs_sync_run_id_competitor_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."competitor_sync_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_source_runs" ADD CONSTRAINT "competitor_source_runs_source_id_competitor_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."competitor_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_source_runs" ADD CONSTRAINT "competitor_source_runs_entity_id_competitor_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."competitor_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_sources" ADD CONSTRAINT "competitor_sources_entity_id_competitor_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."competitor_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_task_comments" ADD CONSTRAINT "competitor_task_comments_task_id_competitor_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."competitor_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_task_comments" ADD CONSTRAINT "competitor_task_comments_attachment_asset_id_competitor_assets_id_fk" FOREIGN KEY ("attachment_asset_id") REFERENCES "public"."competitor_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_task_events" ADD CONSTRAINT "competitor_task_events_task_id_competitor_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."competitor_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_task_suggestions" ADD CONSTRAINT "competitor_task_suggestions_brief_id_competitor_briefs_id_fk" FOREIGN KEY ("brief_id") REFERENCES "public"."competitor_briefs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_task_suggestions" ADD CONSTRAINT "competitor_task_suggestions_item_id_competitor_evidence_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."competitor_evidence_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_task_suggestions" ADD CONSTRAINT "competitor_task_suggestions_ai_run_id_competitor_ai_runs_id_fk" FOREIGN KEY ("ai_run_id") REFERENCES "public"."competitor_ai_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_tasks" ADD CONSTRAINT "competitor_tasks_item_id_competitor_evidence_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."competitor_evidence_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_tasks" ADD CONSTRAINT "competitor_tasks_brief_id_competitor_briefs_id_fk" FOREIGN KEY ("brief_id") REFERENCES "public"."competitor_briefs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_tasks" ADD CONSTRAINT "competitor_tasks_suggestion_id_competitor_task_suggestions_id_fk" FOREIGN KEY ("suggestion_id") REFERENCES "public"."competitor_task_suggestions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "competitor_ai_runs_sync_idx" ON "competitor_ai_runs" USING btree ("sync_run_id");--> statement-breakpoint
CREATE INDEX "competitor_ai_runs_type_started_idx" ON "competitor_ai_runs" USING btree ("run_type","started_at");--> statement-breakpoint
CREATE INDEX "competitor_ai_runs_status_idx" ON "competitor_ai_runs" USING btree ("status","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "competitor_assets_storage_key_idx" ON "competitor_assets" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "competitor_assets_item_idx" ON "competitor_assets" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "competitor_assets_type_idx" ON "competitor_assets" USING btree ("asset_type");--> statement-breakpoint
CREATE UNIQUE INDEX "competitor_briefs_date_idx" ON "competitor_briefs" USING btree ("brief_date");--> statement-breakpoint
CREATE INDEX "competitor_briefs_created_idx" ON "competitor_briefs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "competitor_entities_slug_idx" ON "competitor_entities" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "competitor_entities_kind_active_idx" ON "competitor_entities" USING btree ("kind","active");--> statement-breakpoint
CREATE INDEX "competitor_entities_name_idx" ON "competitor_entities" USING btree ("display_name");--> statement-breakpoint
CREATE UNIQUE INDEX "competitor_evidence_items_key_idx" ON "competitor_evidence_items" USING btree ("item_key");--> statement-breakpoint
CREATE INDEX "competitor_evidence_items_entity_observed_idx" ON "competitor_evidence_items" USING btree ("entity_id","observed_at");--> statement-breakpoint
CREATE INDEX "competitor_evidence_items_channel_observed_idx" ON "competitor_evidence_items" USING btree ("channel","observed_at");--> statement-breakpoint
CREATE INDEX "competitor_evidence_items_category_idx" ON "competitor_evidence_items" USING btree ("category","observed_at");--> statement-breakpoint
CREATE INDEX "competitor_evidence_items_review_idx" ON "competitor_evidence_items" USING btree ("review_status","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "competitor_serp_keywords_unique_idx" ON "competitor_serp_keywords" USING btree ("keyword","language","location","device");--> statement-breakpoint
CREATE INDEX "competitor_serp_keywords_status_idx" ON "competitor_serp_keywords" USING btree ("status");--> statement-breakpoint
CREATE INDEX "competitor_serp_keywords_discovered_idx" ON "competitor_serp_keywords" USING btree ("discovered_by","confidence");--> statement-breakpoint
CREATE UNIQUE INDEX "competitor_serp_observations_key_idx" ON "competitor_serp_observations" USING btree ("observation_key");--> statement-breakpoint
CREATE INDEX "competitor_serp_observations_keyword_observed_idx" ON "competitor_serp_observations" USING btree ("keyword_id","observed_at");--> statement-breakpoint
CREATE INDEX "competitor_serp_observations_entity_observed_idx" ON "competitor_serp_observations" USING btree ("entity_id","observed_at");--> statement-breakpoint
CREATE INDEX "competitor_serp_observations_rank_idx" ON "competitor_serp_observations" USING btree ("rank_absolute");--> statement-breakpoint
CREATE INDEX "competitor_source_runs_sync_idx" ON "competitor_source_runs" USING btree ("sync_run_id");--> statement-breakpoint
CREATE INDEX "competitor_source_runs_source_started_idx" ON "competitor_source_runs" USING btree ("source_id","started_at");--> statement-breakpoint
CREATE INDEX "competitor_source_runs_status_started_idx" ON "competitor_source_runs" USING btree ("status","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "competitor_sources_entity_type_url_idx" ON "competitor_sources" USING btree ("entity_id","source_type","url");--> statement-breakpoint
CREATE INDEX "competitor_sources_entity_idx" ON "competitor_sources" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "competitor_sources_status_type_idx" ON "competitor_sources" USING btree ("status","source_type");--> statement-breakpoint
CREATE INDEX "competitor_sources_provider_idx" ON "competitor_sources" USING btree ("provider");--> statement-breakpoint
CREATE UNIQUE INDEX "competitor_sync_runs_single_running_idx" ON "competitor_sync_runs" USING btree ("status") WHERE "competitor_sync_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "competitor_sync_runs_status_started_idx" ON "competitor_sync_runs" USING btree ("status","started_at");--> statement-breakpoint
CREATE INDEX "competitor_sync_runs_trigger_started_idx" ON "competitor_sync_runs" USING btree ("trigger_type","started_at");--> statement-breakpoint
CREATE INDEX "competitor_task_comments_task_idx" ON "competitor_task_comments" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "competitor_task_events_task_idx" ON "competitor_task_events" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "competitor_task_suggestions_status_idx" ON "competitor_task_suggestions" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "competitor_task_suggestions_item_idx" ON "competitor_task_suggestions" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "competitor_task_suggestions_brief_idx" ON "competitor_task_suggestions" USING btree ("brief_id");--> statement-breakpoint
CREATE INDEX "competitor_tasks_status_due_idx" ON "competitor_tasks" USING btree ("status","due_date");--> statement-breakpoint
CREATE INDEX "competitor_tasks_owner_idx" ON "competitor_tasks" USING btree ("owner_email","status");--> statement-breakpoint
CREATE INDEX "competitor_tasks_item_idx" ON "competitor_tasks" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "competitor_tasks_brief_idx" ON "competitor_tasks" USING btree ("brief_id");--> statement-breakpoint
CREATE UNIQUE INDEX "competitor_vendor_usage_month_provider_idx" ON "competitor_vendor_usage" USING btree ("usage_month","provider","source_type");--> statement-breakpoint
CREATE INDEX "competitor_vendor_usage_capped_idx" ON "competitor_vendor_usage" USING btree ("capped","usage_month");