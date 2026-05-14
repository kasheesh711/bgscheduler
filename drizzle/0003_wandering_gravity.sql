CREATE TYPE "public"."classroom_assignment_row_status" AS ENUM('assigned', 'needs_review', 'no_room');--> statement-breakpoint
CREATE TYPE "public"."classroom_assignment_run_status" AS ENUM('completed', 'published', 'partial', 'failed');--> statement-breakpoint
CREATE TYPE "public"."classroom_publish_status" AS ENUM('not_published', 'skipped', 'success', 'failed');--> statement-breakpoint
CREATE TYPE "public"."classroom_room_category" AS ENUM('standard', 'overflow_only', 'online_only');--> statement-breakpoint
CREATE TABLE "classroom_assignment_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"tutor_display_name" text NOT NULL,
	"wise_teacher_id" text NOT NULL,
	"wise_teacher_user_id" text,
	"wise_session_id" text NOT NULL,
	"wise_class_id" text,
	"start_time" timestamp with time zone NOT NULL,
	"end_time" timestamp with time zone NOT NULL,
	"weekday" integer NOT NULL,
	"start_minute" integer NOT NULL,
	"end_minute" integer NOT NULL,
	"wise_status" text NOT NULL,
	"session_type" text,
	"current_wise_location" text,
	"student_name" text,
	"student_count" integer,
	"subject" text,
	"class_type" text,
	"title" text,
	"min_capacity" integer NOT NULL,
	"needs_tv" boolean DEFAULT false NOT NULL,
	"preferred_room" text,
	"override_room" text,
	"assigned_room" text NOT NULL,
	"status" "classroom_assignment_row_status" DEFAULT 'assigned' NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rule_trace" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"publish_status" "classroom_publish_status" DEFAULT 'not_published' NOT NULL,
	"publish_error" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "classroom_assignment_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assignment_date" date NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"status" "classroom_assignment_run_status" DEFAULT 'completed' NOT NULL,
	"force_reassign" boolean DEFAULT false NOT NULL,
	"total_sessions" integer DEFAULT 0 NOT NULL,
	"assigned_count" integer DEFAULT 0 NOT NULL,
	"needs_review_count" integer DEFAULT 0 NOT NULL,
	"no_room_count" integer DEFAULT 0 NOT NULL,
	"published_count" integer DEFAULT 0 NOT NULL,
	"failed_publish_count" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "classroom_rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"has_tv" boolean DEFAULT false NOT NULL,
	"capacity" integer NOT NULL,
	"category" "classroom_room_category" DEFAULT 'standard' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "future_session_blocks" ADD COLUMN "wise_teacher_user_id" text;--> statement-breakpoint
ALTER TABLE "future_session_blocks" ADD COLUMN "wise_class_id" text;--> statement-breakpoint
ALTER TABLE "future_session_blocks" ADD COLUMN "student_count" integer;--> statement-breakpoint
ALTER TABLE "classroom_assignment_rows" ADD CONSTRAINT "classroom_assignment_rows_run_id_classroom_assignment_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."classroom_assignment_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classroom_assignment_rows" ADD CONSTRAINT "classroom_assignment_rows_snapshot_id_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classroom_assignment_rows" ADD CONSTRAINT "classroom_assignment_rows_group_id_tutor_identity_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."tutor_identity_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classroom_assignment_runs" ADD CONSTRAINT "classroom_assignment_runs_snapshot_id_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "car_rows_run_idx" ON "classroom_assignment_rows" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "car_rows_snapshot_idx" ON "classroom_assignment_rows" USING btree ("snapshot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "car_rows_run_session_idx" ON "classroom_assignment_rows" USING btree ("run_id","wise_session_id");--> statement-breakpoint
CREATE INDEX "car_date_idx" ON "classroom_assignment_runs" USING btree ("assignment_date");--> statement-breakpoint
CREATE INDEX "car_snapshot_idx" ON "classroom_assignment_runs" USING btree ("snapshot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "classroom_rooms_name_idx" ON "classroom_rooms" USING btree ("name");--> statement-breakpoint
CREATE INDEX "classroom_rooms_active_idx" ON "classroom_rooms" USING btree ("active");--> statement-breakpoint
INSERT INTO "classroom_rooms" ("name", "has_tv", "capacity", "category", "active", "sort_order") VALUES
('Cool', false, 3, 'standard', true, 1),
('Do It', false, 3, 'standard', true, 2),
('Dream. Plan. Do.', false, 3, 'overflow_only', true, 3),
('Focus', false, 2, 'standard', true, 4),
('Hakuna Matata', false, 3, 'standard', true, 5),
('Iconic', true, 2, 'standard', true, 6),
('Isaac Newton', false, 3, 'standard', true, 7),
('Joy', true, 3, 'standard', true, 8),
('Keep Going', true, 3, 'standard', true, 9),
('Nerd', false, 3, 'standard', true, 10),
('Never Ever', true, 3, 'standard', true, 11),
('OMG', false, 3, 'standard', true, 12),
('Relax', true, 8, 'standard', true, 13),
('Take Action', false, 3, 'standard', true, 14),
('Tesla', false, 3, 'standard', true, 15),
('Think Outside the Box', false, 2, 'standard', true, 16),
('Turn The Page', true, 2, 'standard', true, 17),
('Remember', true, 2, 'standard', true, 18),
('Here There', true, 2, 'standard', true, 19),
('Go All In', true, 2, 'standard', true, 20),
('Doubt', true, 2, 'standard', true, 21),
('Big Memories', true, 2, 'standard', true, 22),
('I learned (online)', false, 1, 'online_only', true, 23),
('Hope (online)', false, 1, 'online_only', true, 24)
ON CONFLICT ("name") DO NOTHING;
