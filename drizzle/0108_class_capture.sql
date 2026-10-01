CREATE TABLE "class_captures" (
  "id" uuid PRIMARY KEY,
  "created_by_email" text NOT NULL,
  "teacher_key" text NOT NULL,
  "session" jsonb NOT NULL,
  "consent" jsonb NOT NULL,
  "consent_version" text NOT NULL DEFAULT '2026-10-01-v1',
  "topic" text NOT NULL,
  "tutor_notes" text NOT NULL DEFAULT '',
  "draft" jsonb,
  "reviewed" boolean NOT NULL DEFAULT false,
  "version" integer NOT NULL DEFAULT 0,
  "draft_lease_until" timestamptz,
  "draft_attempts" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  "deleted_at" timestamptz,
  "cleanup_attempted_at" timestamptz
);
--> statement-breakpoint
CREATE INDEX "class_captures_expiry_idx" ON "class_captures" ("expires_at");
CREATE INDEX "class_captures_owner_idx" ON "class_captures" ("created_by_email");
--> statement-breakpoint
CREATE TABLE "class_capture_assets" (
  "id" uuid PRIMARY KEY,
  "capture_id" uuid NOT NULL REFERENCES "class_captures" ("id") ON DELETE CASCADE,
  "kind" text NOT NULL CHECK ("kind" IN ('recording','debrief','worksheet')),
  "worksheet_permission" boolean NOT NULL DEFAULT false,
  "mime" text NOT NULL,
  "size" integer NOT NULL CHECK ("size" > 0 AND "size" <= 104857600),
  "pathname" text NOT NULL UNIQUE,
  "status" text NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending','ready','transcribing','transcribed','failed')),
  "transcript" text,
  "error" text,
  "provider_file_id" text,
  "provider_job_id" text,
  "processing_started_at" timestamptz,
  "provider_uncertain" boolean NOT NULL DEFAULT false,
  "discarded_at" timestamptz,
  "cleanup_attempted_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "class_capture_assets_capture_idx" ON "class_capture_assets" ("capture_id");
