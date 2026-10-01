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
