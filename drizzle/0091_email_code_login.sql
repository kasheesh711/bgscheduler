CREATE TABLE "auth_email_challenges" (
  "email" text PRIMARY KEY NOT NULL,
  "id" uuid NOT NULL UNIQUE,
  "code_hash" text NOT NULL,
  "binding_hash" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "attempts" integer DEFAULT 0 NOT NULL,
  "ready" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX "auth_email_challenge_expiry" ON "auth_email_challenges" ("expires_at");
--> statement-breakpoint
CREATE TABLE "auth_email_rate_limits" (
  "key" text PRIMARY KEY NOT NULL,
  "count" integer NOT NULL,
  "expires_at" timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX "auth_email_rate_expiry" ON "auth_email_rate_limits" ("expires_at");
