CREATE TABLE "tutor_contact_sync_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"canonical_key" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"before_value" jsonb,
	"after_value" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tutor_wise_accounts" (
	"wise_teacher_id" text PRIMARY KEY NOT NULL,
	"wise_user_id" text,
	"canonical_key" text NOT NULL,
	"display_name" text NOT NULL,
	"is_online_variant" boolean NOT NULL,
	"email" text,
	"status" text NOT NULL,
	"last_snapshot_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tutor_contacts" ADD COLUMN "wise_email_state" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "tutor_contact_sync_events_key_idx" ON "tutor_contact_sync_events" USING btree ("canonical_key");--> statement-breakpoint
CREATE INDEX "tutor_wise_accounts_key_idx" ON "tutor_wise_accounts" USING btree ("canonical_key");