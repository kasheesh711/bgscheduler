-- Tutor Offboarding PR 1, migration A (spec docs/superpowers/specs/2026-10-01-tutor-offboarding-design.md §7).
-- Additive only: four nullable roster columns and three new tables. OWNER GATE: apply this BEFORE deploying the
-- code that declares these columns, because the sync reads and upserts tutor_wise_accounts by column name (a
-- missing column fails every sync with 42703). Applying it early is safe for the code live today: additive, nullable.
ALTER TABLE "tutor_wise_accounts" ADD COLUMN "wise_relation" text;
--> statement-breakpoint
ALTER TABLE "tutor_wise_accounts" ADD COLUMN "wise_joined_on" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "tutor_wise_accounts" ADD COLUMN "wise_course_count" integer;
--> statement-breakpoint
ALTER TABLE "tutor_wise_accounts" ADD COLUMN "wise_activated" boolean;
--> statement-breakpoint
CREATE TABLE "tutor_offboarding_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canonical_key" text NOT NULL,
	"kind" text DEFAULT 'still_with_us' NOT NULL,
	"note" text,
	"snooze_until" timestamp with time zone NOT NULL,
	"likelihood_at_decision" integer NOT NULL,
	"band_at_decision" text NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"decided_by_email" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_email" text,
	CONSTRAINT "tod_kind_check" CHECK ("tutor_offboarding_decisions"."kind" in ('still_with_us')),
	CONSTRAINT "tod_band_check" CHECK ("tutor_offboarding_decisions"."band_at_decision" in ('very_likely_gone', 'likely_gone', 'unclear', 'active'))
);
--> statement-breakpoint
CREATE INDEX "tod_open_key_idx" ON "tutor_offboarding_decisions" USING btree ("canonical_key") WHERE "tutor_offboarding_decisions"."revoked_at" is null;
--> statement-breakpoint
CREATE INDEX "tod_decided_at_idx" ON "tutor_offboarding_decisions" USING btree ("decided_at");
--> statement-breakpoint
CREATE TABLE "tutor_offboarding_access_grants" (
	"email" text PRIMARY KEY NOT NULL,
	"granted_by_email" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tutor_offboarding_access_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" text NOT NULL,
	"email" text NOT NULL,
	"actor_email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "toaal_action_check" CHECK ("tutor_offboarding_access_audit_log"."action" in ('grant', 'revoke'))
);
--> statement-breakpoint
CREATE INDEX "toaal_created_at_idx" ON "tutor_offboarding_access_audit_log" USING btree ("created_at");
