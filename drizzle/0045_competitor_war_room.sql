CREATE TABLE "competitor_war_room_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"week_start" date NOT NULL,
	"week_end" date NOT NULL,
	"lookback_start" date NOT NULL,
	"lookback_end" date NOT NULL,
	"sync_run_id" uuid,
	"ai_run_id" uuid,
	"status" text DEFAULT 'ready' NOT NULL,
	"confidence" double precision DEFAULT 0.5 NOT NULL,
	"executive_summary" text DEFAULT '' NOT NULL,
	"matrix" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"content_angles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"score_drilldowns" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_health" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "competitor_war_room_snapshots" ADD CONSTRAINT "competitor_war_room_snapshots_sync_run_id_competitor_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."competitor_sync_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_war_room_snapshots" ADD CONSTRAINT "competitor_war_room_snapshots_ai_run_id_competitor_ai_runs_id_fk" FOREIGN KEY ("ai_run_id") REFERENCES "public"."competitor_ai_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "competitor_war_room_snapshots_week_idx" ON "competitor_war_room_snapshots" USING btree ("week_start");--> statement-breakpoint
CREATE INDEX "competitor_war_room_snapshots_generated_idx" ON "competitor_war_room_snapshots" USING btree ("generated_at");--> statement-breakpoint
CREATE INDEX "competitor_war_room_snapshots_sync_idx" ON "competitor_war_room_snapshots" USING btree ("sync_run_id");