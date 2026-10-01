CREATE TABLE "workforce_booking_classifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "wise_session_id" text NOT NULL,
  "revision" integer NOT NULL CHECK ("revision" > 0),
  "content_hash" text NOT NULL,
  "observed_at" timestamp with time zone NOT NULL,
  "is_current" boolean NOT NULL,
  "payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workforce_booking_classification_revision_idx" ON "workforce_booking_classifications" ("wise_session_id", "revision");
--> statement-breakpoint
CREATE UNIQUE INDEX "workforce_booking_classification_current_idx" ON "workforce_booking_classifications" ("wise_session_id") WHERE "is_current";
--> statement-breakpoint
CREATE TABLE "workforce_course_lifecycle_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "event_key" text NOT NULL,
  "revision" integer NOT NULL CHECK ("revision" > 0),
  "student_id" text NOT NULL,
  "subject" text NOT NULL,
  "effective_month" text NOT NULL,
  "content_hash" text NOT NULL,
  "recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
  "is_current" boolean NOT NULL,
  "payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workforce_lifecycle_revision_idx" ON "workforce_course_lifecycle_events" ("event_key", "revision");
--> statement-breakpoint
CREATE UNIQUE INDEX "workforce_lifecycle_current_idx" ON "workforce_course_lifecycle_events" ("event_key") WHERE "is_current";
--> statement-breakpoint
CREATE INDEX "workforce_lifecycle_student_subject_idx" ON "workforce_course_lifecycle_events" ("student_id", "subject", "effective_month");
