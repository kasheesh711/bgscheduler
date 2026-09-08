CREATE TABLE "leave_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"teacher_key" text NOT NULL,
	"teacher_name" text NOT NULL,
	"class_date" date NOT NULL,
	"due_date" date NOT NULL,
	"owner_email" text,
	"owner_name" text,
	"assigned_date" date,
	"source_request_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"issue" text,
	"done" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leave_class_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assignment_id" uuid NOT NULL,
	"wise_session_id" text NOT NULL,
	"wise_class_id" text NOT NULL,
	"start_time" timestamp with time zone NOT NULL,
	"end_time" timestamp with time zone NOT NULL,
	"subject" text NOT NULL,
	"title" text NOT NULL,
	"students" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"revision" text NOT NULL,
	"source_request_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"wise_status" text NOT NULL,
	"issue" text,
	"active" boolean DEFAULT true NOT NULL,
	"cancelled" jsonb,
	"imported_normalization_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leave_family_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assignment_id" uuid NOT NULL,
	"family_key" text NOT NULL,
	"label" text NOT NULL,
	"students" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"coverage" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"informed_coverage" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"informed" jsonb,
	"imported_normalization_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leave_normalizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"input_key" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"input" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"evidence_applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "leave_roster_people" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leave_roster_shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_key" text NOT NULL,
	"date" date NOT NULL,
	"status" text NOT NULL,
	"shift" text,
	"start_minute" integer,
	"end_minute" integer,
	"source_tab" text NOT NULL,
	"source_cell" text NOT NULL,
	"color" text,
	"note" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leave_work_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assignment_id" uuid NOT NULL,
	"mutation_key" text NOT NULL,
	"actor_email" text,
	"actor_name" text,
	"action" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leave_work_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "leave_requests" ADD COLUMN "current_normalization_key" text;--> statement-breakpoint
ALTER TABLE "leave_class_tasks" ADD CONSTRAINT "leave_class_tasks_assignment_id_leave_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."leave_assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_family_tasks" ADD CONSTRAINT "leave_family_tasks_assignment_id_leave_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."leave_assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_normalizations" ADD CONSTRAINT "leave_normalizations_request_id_leave_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."leave_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_roster_shifts" ADD CONSTRAINT "leave_roster_shifts_person_key_leave_roster_people_key_fk" FOREIGN KEY ("person_key") REFERENCES "public"."leave_roster_people"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_work_events" ADD CONSTRAINT "leave_work_events_assignment_id_leave_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."leave_assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "leave_assignments_teacher_date_idx" ON "leave_assignments" USING btree ("teacher_key","class_date");--> statement-breakpoint
CREATE INDEX "leave_assignments_due_idx" ON "leave_assignments" USING btree ("done","due_date","class_date");--> statement-breakpoint
CREATE UNIQUE INDEX "leave_class_tasks_session_idx" ON "leave_class_tasks" USING btree ("wise_session_id");--> statement-breakpoint
CREATE INDEX "leave_class_tasks_assignment_idx" ON "leave_class_tasks" USING btree ("assignment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "leave_family_tasks_bundle_family_idx" ON "leave_family_tasks" USING btree ("assignment_id","family_key");--> statement-breakpoint
CREATE UNIQUE INDEX "leave_normalizations_request_key_idx" ON "leave_normalizations" USING btree ("request_id","input_key");--> statement-breakpoint
CREATE INDEX "leave_normalizations_retry_idx" ON "leave_normalizations" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "leave_roster_people_email_idx" ON "leave_roster_people" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "leave_roster_shifts_person_date_idx" ON "leave_roster_shifts" USING btree ("person_key","date");--> statement-breakpoint
CREATE INDEX "leave_roster_shifts_date_idx" ON "leave_roster_shifts" USING btree ("date");--> statement-breakpoint
CREATE UNIQUE INDEX "leave_work_events_mutation_idx" ON "leave_work_events" USING btree ("mutation_key");--> statement-breakpoint
CREATE INDEX "leave_work_events_assignment_idx" ON "leave_work_events" USING btree ("assignment_id","created_at");