CREATE TABLE "wise_activity_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text DEFAULT 'unknown' NOT NULL,
	"event_name" text NOT NULL,
	"event_timestamp" timestamp with time zone NOT NULL,
	"actor_wise_user_id" text,
	"actor_name" text,
	"actor_role" text,
	"classroom_id" text,
	"classroom_name" text,
	"classroom_subject" text,
	"session_id" text,
	"session_start_time" timestamp with time zone,
	"session_end_time" timestamp with time zone,
	"transaction_id" text,
	"transaction_type" text,
	"transaction_status" text,
	"transaction_amount" double precision,
	"transaction_currency" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wise_activity_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "sync_status" DEFAULT 'running' NOT NULL,
	"trigger_type" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"pages_fetched" integer DEFAULT 0 NOT NULL,
	"events_fetched" integer DEFAULT 0 NOT NULL,
	"inserted_count" integer DEFAULT 0 NOT NULL,
	"oldest_event_timestamp" timestamp with time zone,
	"newest_event_timestamp" timestamp with time zone,
	"error_summary" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "wise_activity_events_event_id_idx" ON "wise_activity_events" USING btree ("event_id");
--> statement-breakpoint
CREATE INDEX "wise_activity_events_timestamp_idx" ON "wise_activity_events" USING btree ("event_timestamp");
--> statement-breakpoint
CREATE INDEX "wise_activity_events_type_timestamp_idx" ON "wise_activity_events" USING btree ("event_type","event_timestamp");
--> statement-breakpoint
CREATE INDEX "wise_activity_events_name_timestamp_idx" ON "wise_activity_events" USING btree ("event_name","event_timestamp");
--> statement-breakpoint
CREATE INDEX "wise_activity_events_actor_idx" ON "wise_activity_events" USING btree ("actor_wise_user_id","event_timestamp");
--> statement-breakpoint
CREATE INDEX "wise_activity_events_classroom_idx" ON "wise_activity_events" USING btree ("classroom_id","event_timestamp");
--> statement-breakpoint
CREATE INDEX "wise_activity_events_session_idx" ON "wise_activity_events" USING btree ("session_id");
--> statement-breakpoint
CREATE INDEX "wise_activity_events_transaction_idx" ON "wise_activity_events" USING btree ("transaction_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "wise_activity_sync_runs_single_running_idx" ON "wise_activity_sync_runs" USING btree ("status") WHERE "wise_activity_sync_runs"."status" = 'running';
--> statement-breakpoint
CREATE INDEX "wise_activity_sync_runs_status_started_idx" ON "wise_activity_sync_runs" USING btree ("status","started_at");
