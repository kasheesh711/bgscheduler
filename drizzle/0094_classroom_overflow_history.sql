ALTER TABLE "classroom_assignment_rows" ADD COLUMN "student_ids" jsonb;
--> statement-breakpoint
ALTER TABLE "classroom_assignment_rows" ADD COLUMN "overflow_release_room" text;
--> statement-breakpoint
CREATE TABLE "classroom_mode_history" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "evidence_key" text NOT NULL,
  "wise_session_id" text NOT NULL,
  "student_id" text NOT NULL,
  "roster_key" text NOT NULL,
  "mode" text NOT NULL CHECK ("mode" IN ('onsite', 'online', 'unknown')),
  "scheduled_start_at" timestamptz NOT NULL,
  "scheduled_end_at" timestamptz NOT NULL,
  "observed_at" timestamptz NOT NULL,
  "attended" boolean NOT NULL,
  "cancelled" boolean NOT NULL,
  "source" text NOT NULL,
  "state_hash" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "classroom_mode_evidence_key_idx" ON "classroom_mode_history" ("evidence_key");
--> statement-breakpoint
CREATE INDEX "classroom_mode_student_start_idx" ON "classroom_mode_history" ("student_id", "scheduled_start_at");
--> statement-breakpoint
CREATE INDEX "classroom_mode_session_observed_idx" ON "classroom_mode_history" ("wise_session_id", "student_id", "observed_at");
