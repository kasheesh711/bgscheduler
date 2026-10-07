CREATE TABLE "email_delivery_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "svix_id" text NOT NULL,
  "provider" text NOT NULL DEFAULT 'resend',
  "provider_message_id" text,
  "event_type" text NOT NULL,
  "bounce_type" text,
  "occurred_at" timestamptz,
  "received_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "email_delivery_events_svix_idx" ON "email_delivery_events" ("svix_id");
--> statement-breakpoint
CREATE INDEX "email_delivery_events_message_idx" ON "email_delivery_events" ("provider_message_id");
--> statement-breakpoint
CREATE INDEX "email_delivery_events_type_idx" ON "email_delivery_events" ("event_type", "received_at");
