CREATE TABLE "thea_weekend_jobs" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "weekend_date" date NOT NULL, "group_id" text NOT NULL,
 "status" text NOT NULL DEFAULT 'pending', "stage" integer NOT NULL DEFAULT 0,
 "run_ids" jsonb NOT NULL DEFAULT '[]', "warnings" jsonb NOT NULL DEFAULT '[]', "attempts" integer NOT NULL DEFAULT 0,
 "claim_token" uuid, "lease_expires_at" timestamptz, "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
 "last_error" text, "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "thea_weekend_date_idx" ON "thea_weekend_jobs" ("weekend_date");
--> statement-breakpoint
CREATE TABLE "thea_weekend_requests" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "event_id" text NOT NULL,
 "job_id" uuid NOT NULL REFERENCES "thea_weekend_jobs" ("id"), "group_id" text NOT NULL, "line_user_id" text NOT NULL,
 "token_hash" text NOT NULL, "expires_at" timestamptz NOT NULL, "run_ids" jsonb NOT NULL DEFAULT '[]',
 "delivered_at" timestamptz, "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "thea_event_idx" ON "thea_weekend_requests" ("event_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "thea_token_idx" ON "thea_weekend_requests" ("token_hash");
--> statement-breakpoint
CREATE INDEX "thea_request_job_idx" ON "thea_weekend_requests" ("job_id");
