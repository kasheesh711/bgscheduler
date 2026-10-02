CREATE TABLE "post_class_email_connection" (
  "id" text PRIMARY KEY DEFAULT 'gmail',
  "client_id" text NOT NULL,
  "mailbox" text NOT NULL,
  "google_subject" text NOT NULL,
  "revision" integer NOT NULL DEFAULT 1,
  "access_token_ciphertext" text NOT NULL,
  "refresh_token_ciphertext" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "scope" text NOT NULL,
  "connected_by" text NOT NULL,
  "connected_at" timestamptz NOT NULL DEFAULT now(),
  "refreshed_at" timestamptz,
  "checked_at" timestamptz,
  "last_error" text,
  "test_evidence" jsonb,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "post_class_reminder_line_channel" (
  "id" text PRIMARY KEY DEFAULT 'private',
  "recipient_id" text NOT NULL,
  "binding" text NOT NULL,
  "test_evidence" jsonb,
  "health" text NOT NULL DEFAULT 'unknown',
  "episode_id" uuid,
  "checked_at" timestamptz,
  "detail" text,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "post_class_reminder_alerts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "episode_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "recipient_id" text NOT NULL,
  "binding" text NOT NULL,
  "message" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "attempts" integer NOT NULL DEFAULT 0,
  "first_attempt_at" timestamptz,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "lease_token" uuid,
  "lease_until" timestamptz,
  "last_error" text,
  "receipt" text,
  "accepted_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "pc_reminder_alert_episode_idx" ON "post_class_reminder_alerts" ("episode_id", "kind");
