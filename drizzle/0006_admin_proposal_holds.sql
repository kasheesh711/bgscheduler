CREATE EXTENSION IF NOT EXISTS "btree_gist";--> statement-breakpoint
CREATE TYPE "public"."proposal_scope" AS ENUM('recurring', 'one_time');--> statement-breakpoint
CREATE TYPE "public"."proposal_status" AS ENUM('pending', 'confirmed', 'released', 'expired', 'auto_resolved');--> statement-breakpoint
CREATE TABLE "proposal_bundles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_label" text NOT NULL,
	"notes" text,
	"created_by_email" text,
	"created_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proposal_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bundle_id" uuid NOT NULL,
	"tutor_group_id" uuid,
	"tutor_canonical_key" text NOT NULL,
	"tutor_display_name" text NOT NULL,
	"scope" "proposal_scope" NOT NULL,
	"weekday" integer NOT NULL,
	"proposal_date" date,
	"start_minute" integer NOT NULL,
	"end_minute" integer NOT NULL,
	"subject" text,
	"curriculum" text,
	"level" text,
	"status" "proposal_status" DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"auto_resolved_at" timestamp with time zone,
	"last_action_by_email" text,
	"last_action_by_name" text,
	"last_action_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "proposal_items" ADD CONSTRAINT "proposal_items_bundle_id_proposal_bundles_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "public"."proposal_bundles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_items" ADD CONSTRAINT "proposal_items_time_order_chk" CHECK ("end_minute" > "start_minute");--> statement-breakpoint
ALTER TABLE "proposal_items" ADD CONSTRAINT "proposal_items_weekday_chk" CHECK ("weekday" >= 0 AND "weekday" <= 6);--> statement-breakpoint
ALTER TABLE "proposal_items" ADD CONSTRAINT "proposal_items_pending_expiry_chk" CHECK ("status" <> 'pending' OR "expires_at" IS NOT NULL);--> statement-breakpoint
CREATE INDEX "proposal_bundles_created_at_idx" ON "proposal_bundles" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "proposal_items_bundle_idx" ON "proposal_items" USING btree ("bundle_id");--> statement-breakpoint
CREATE INDEX "proposal_items_active_lookup_idx" ON "proposal_items" USING btree ("tutor_canonical_key","status","weekday");--> statement-breakpoint
CREATE INDEX "proposal_items_date_idx" ON "proposal_items" USING btree ("proposal_date");--> statement-breakpoint
ALTER TABLE "proposal_items" ADD CONSTRAINT "proposal_items_no_recurring_overlap" EXCLUDE USING gist (
	"tutor_canonical_key" WITH =,
	"weekday" WITH =,
	int4range("start_minute", "end_minute", '[)') WITH &&
) WHERE ("status" IN ('pending', 'confirmed') AND "scope" = 'recurring');--> statement-breakpoint
ALTER TABLE "proposal_items" ADD CONSTRAINT "proposal_items_no_one_time_overlap" EXCLUDE USING gist (
	"tutor_canonical_key" WITH =,
	"proposal_date" WITH =,
	int4range("start_minute", "end_minute", '[)') WITH &&
) WHERE ("status" IN ('pending', 'confirmed') AND "scope" = 'one_time');
