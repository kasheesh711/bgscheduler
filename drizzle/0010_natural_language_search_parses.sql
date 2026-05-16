CREATE TABLE "natural_language_search_parses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "created_by_email" text,
  "status" text NOT NULL,
  "input_preview_redacted" text NOT NULL,
  "model" text,
  "latency_ms" integer,
  "parsed_payload" jsonb,
  "warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "error_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "nlsp_created_at_idx" ON "natural_language_search_parses" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX "nlsp_status_idx" ON "natural_language_search_parses" USING btree ("status");
