CREATE TABLE "room_utilization_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "wise_session_id" text NOT NULL,
  "start_time" timestamp with time zone NOT NULL,
  "end_time" timestamp with time zone NOT NULL,
  "utilization_date" date NOT NULL,
  "weekday" integer NOT NULL,
  "start_minute" integer NOT NULL,
  "end_minute" integer NOT NULL,
  "wise_status" text NOT NULL,
  "session_type" text,
  "raw_location" text,
  "normalized_room_label" text,
  "student_count" integer,
  "synced_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "rus_wise_session_id_idx" ON "room_utilization_sessions" USING btree ("wise_session_id");
--> statement-breakpoint
CREATE INDEX "rus_date_idx" ON "room_utilization_sessions" USING btree ("utilization_date");
--> statement-breakpoint
CREATE INDEX "rus_room_date_idx" ON "room_utilization_sessions" USING btree ("normalized_room_label","utilization_date");
