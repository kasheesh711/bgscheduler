CREATE TABLE "line_oa_resolver_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"worklist_source" text DEFAULT 'current_credit_control_snapshot' NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"pending_rows" integer DEFAULT 0 NOT NULL,
	"matched_rows" integer DEFAULT 0 NOT NULL,
	"ambiguous_rows" integer DEFAULT 0 NOT NULL,
	"no_match_rows" integer DEFAULT 0 NOT NULL,
	"error_rows" integer DEFAULT 0 NOT NULL,
	"needs_manual_code_rows" integer DEFAULT 0 NOT NULL,
	"committed_rows" integer DEFAULT 0 NOT NULL,
	"created_by_email" text,
	"created_by_name" text,
	"expires_at" timestamp with time zone NOT NULL,
	"committed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "line_oa_resolver_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"wise_student_id" text NOT NULL,
	"student_key" text NOT NULL,
	"student_name" text NOT NULL,
	"parent_name" text DEFAULT '' NOT NULL,
	"search_code" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"line_oa_account_id" text,
	"line_user_id" text,
	"line_chat_url" text,
	"chat_title" text,
	"match_mode" text,
	"capture_mode" text,
	"error_message" text,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"committed_contact_id" uuid,
	"committed_link_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "line_oa_resolver_rows" ADD CONSTRAINT "line_oa_resolver_rows_run_id_line_oa_resolver_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."line_oa_resolver_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "line_oa_resolver_rows" ADD CONSTRAINT "line_oa_resolver_rows_committed_contact_id_line_contacts_id_fk" FOREIGN KEY ("committed_contact_id") REFERENCES "public"."line_contacts"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "line_oa_resolver_rows" ADD CONSTRAINT "line_oa_resolver_rows_committed_link_id_line_contact_student_links_id_fk" FOREIGN KEY ("committed_link_id") REFERENCES "public"."line_contact_student_links"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "line_oa_resolver_runs_token_hash_idx" ON "line_oa_resolver_runs" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX "line_oa_resolver_runs_status_idx" ON "line_oa_resolver_runs" USING btree ("status","created_at");
--> statement-breakpoint
CREATE INDEX "line_oa_resolver_runs_created_by_idx" ON "line_oa_resolver_runs" USING btree ("created_by_email","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "line_oa_resolver_rows_run_student_code_idx" ON "line_oa_resolver_rows" USING btree ("run_id","student_key","search_code");
--> statement-breakpoint
CREATE INDEX "line_oa_resolver_rows_run_status_idx" ON "line_oa_resolver_rows" USING btree ("run_id","status");
--> statement-breakpoint
CREATE INDEX "line_oa_resolver_rows_line_user_idx" ON "line_oa_resolver_rows" USING btree ("line_user_id");
