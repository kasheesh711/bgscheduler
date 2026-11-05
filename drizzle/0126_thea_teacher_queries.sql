CREATE TABLE "thea_teacher_queries" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "event_id" text NOT NULL UNIQUE,
 "group_id" text NOT NULL, "user_id" text NOT NULL, "question" text NOT NULL,
 "status" text NOT NULL DEFAULT 'pending', "criteria" jsonb, "answer" text,
 "reserved_usd" double precision NOT NULL DEFAULT 0, "cost_usd" double precision,
 "claim_token" uuid, "lease_expires_at" timestamptz, "delivered_at" timestamptz,
 "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "thea_teacher_single_worker_idx" ON "thea_teacher_queries" ("status") WHERE "status" = 'running';
--> statement-breakpoint
CREATE INDEX "thea_teacher_created_idx" ON "thea_teacher_queries" ("created_at");
--> statement-breakpoint
CREATE TABLE "thea_query_cache" (
 "key" text PRIMARY KEY, "payload" jsonb NOT NULL, "fetched_at" timestamptz NOT NULL, "expires_at" timestamptz NOT NULL
);
