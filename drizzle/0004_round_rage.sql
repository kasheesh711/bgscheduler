ALTER TYPE "public"."classroom_assignment_row_status" ADD VALUE 'remote';--> statement-breakpoint
CREATE TABLE "classroom_schedule_email_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_run_id" uuid NOT NULL,
	"assignment_run_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"canonical_key" text NOT NULL,
	"tutor_display_name" text NOT NULL,
	"recipient_email" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"resend_email_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "classroom_schedule_email_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assignment_run_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"subject" text NOT NULL,
	"created_by" text,
	"attempted_count" integer DEFAULT 0 NOT NULL,
	"success_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"blocked_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tutor_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canonical_key" text NOT NULL,
	"display_name" text NOT NULL,
	"onsite_email" text,
	"online_email" text,
	"onsite_phone" text,
	"online_phone" text,
	"source_names" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "classroom_assignment_runs" ADD COLUMN "remote_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "classroom_schedule_email_recipients" ADD CONSTRAINT "classroom_schedule_email_recipients_email_run_id_classroom_schedule_email_runs_id_fk" FOREIGN KEY ("email_run_id") REFERENCES "public"."classroom_schedule_email_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classroom_schedule_email_recipients" ADD CONSTRAINT "classroom_schedule_email_recipients_assignment_run_id_classroom_assignment_runs_id_fk" FOREIGN KEY ("assignment_run_id") REFERENCES "public"."classroom_assignment_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classroom_schedule_email_recipients" ADD CONSTRAINT "classroom_schedule_email_recipients_group_id_tutor_identity_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."tutor_identity_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classroom_schedule_email_runs" ADD CONSTRAINT "classroom_schedule_email_runs_assignment_run_id_classroom_assignment_runs_id_fk" FOREIGN KEY ("assignment_run_id") REFERENCES "public"."classroom_assignment_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cser_recipients_email_run_idx" ON "classroom_schedule_email_recipients" USING btree ("email_run_id");--> statement-breakpoint
CREATE INDEX "cser_recipients_assignment_run_idx" ON "classroom_schedule_email_recipients" USING btree ("assignment_run_id");--> statement-breakpoint
CREATE INDEX "cser_recipients_group_idx" ON "classroom_schedule_email_recipients" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "cser_assignment_run_idx" ON "classroom_schedule_email_runs" USING btree ("assignment_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tutor_contacts_canonical_key_idx" ON "tutor_contacts" USING btree ("canonical_key");--> statement-breakpoint
CREATE INDEX "tutor_contacts_active_idx" ON "tutor_contacts" USING btree ("active");