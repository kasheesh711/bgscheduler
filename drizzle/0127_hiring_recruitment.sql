CREATE TABLE "hiring_recruitment_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "key" text NOT NULL UNIQUE,
  "booking_id" uuid REFERENCES "hiring_bookings"("id"),
  "group_id" text NOT NULL,
  "notice" text NOT NULL,
  "message" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "attempts" integer NOT NULL DEFAULT 0,
  "first_attempt_at" timestamptz,
  "lease_until" timestamptz,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "receipt" jsonb,
  "error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "sent_at" timestamptz
);
--> statement-breakpoint
CREATE INDEX "hiring_recruitment_work" ON "hiring_recruitment_deliveries" ("status", "next_attempt_at");
