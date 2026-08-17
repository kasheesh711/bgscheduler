CREATE TABLE "line_credit_digest_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"digest_date" date NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"runs_out_count" integer DEFAULT 0 NOT NULL,
	"already_out_count" integer DEFAULT 0 NOT NULL,
	"group_count" integer DEFAULT 0 NOT NULL,
	"attempted_count" integer DEFAULT 0 NOT NULL,
	"success_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "line_group_settings" ADD COLUMN "credit_digest_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "line_group_settings" ADD COLUMN "credit_digest_set_by_line_user_id" text;--> statement-breakpoint
ALTER TABLE "line_group_settings" ADD COLUMN "credit_digest_updated_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "line_credit_digest_runs_date_idx" ON "line_credit_digest_runs" USING btree ("digest_date");--> statement-breakpoint
CREATE UNIQUE INDEX "line_credit_digest_runs_idempotency_idx" ON "line_credit_digest_runs" USING btree ("idempotency_key");