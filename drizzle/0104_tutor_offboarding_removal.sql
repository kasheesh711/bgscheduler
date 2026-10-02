-- Tutor Offboarding PR 2 (spec docs/superpowers/specs/2026-10-01-tutor-offboarding-design.md §6-12).
-- Additive run/audit storage. Apply to production only with owner authorization, before deploying removal controls.
CREATE TABLE "tutor_offboarding_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "status" text NOT NULL,
  "mode" text NOT NULL,
  "reason" text,
  "preview_token" text NOT NULL,
  "preview_expires_at" timestamp with time zone NOT NULL,
  "tutor_count" integer NOT NULL,
  "account_count" integer NOT NULL,
  "created_by_email" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "applied_by_email" text,
  "applied_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  CONSTRAINT "tutor_offboarding_run_status_check" CHECK ("status" in ('previewed', 'applying', 'applied', 'applied_with_errors', 'expired')),
  CONSTRAINT "tutor_offboarding_run_mode_check" CHECK ("mode" in ('live', 'manual'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tutor_offboarding_one_applying_uidx" ON "tutor_offboarding_runs" USING btree ("status") WHERE "status" = 'applying';
--> statement-breakpoint
CREATE INDEX "tutor_offboarding_runs_created_at_idx" ON "tutor_offboarding_runs" USING btree ("created_at");
--> statement-breakpoint
CREATE TABLE "tutor_offboarding_run_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL REFERENCES "tutor_offboarding_runs"("id") ON DELETE CASCADE,
  "canonical_key" text NOT NULL,
  "display_name" text NOT NULL,
  "wise_teacher_id" text NOT NULL,
  "wise_user_id" text,
  "is_online_variant" boolean NOT NULL,
  "account_snapshot" jsonb NOT NULL,
  "likelihood_at_preview" integer NOT NULL,
  "reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "plan" text NOT NULL,
  "skip_reason" text,
  "status" text DEFAULT 'planned' NOT NULL,
  "request_payload" jsonb,
  "response_payload" jsonb,
  "error_message" text,
  "local_state_before" jsonb,
  "sent_at" timestamp with time zone,
  "verified_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "tutor_offboarding_run_account_plan_check" CHECK ("plan" in ('remove', 'skip')),
  CONSTRAINT "tutor_offboarding_run_account_status_check" CHECK ("status" in ('planned', 'skipped', 'sending', 'sent', 'rejected', 'unknown', 'verified', 'not_removed', 'manual_required', 'removed_manually', 'restored'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tutor_offboarding_run_account_teacher_uidx" ON "tutor_offboarding_run_accounts" USING btree ("run_id", "wise_teacher_id");
--> statement-breakpoint
CREATE INDEX "tutor_offboarding_run_accounts_run_idx" ON "tutor_offboarding_run_accounts" USING btree ("run_id");
