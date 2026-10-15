CREATE TABLE IF NOT EXISTS progress_line_groups (
 canonical_key text PRIMARY KEY REFERENCES tutor_contacts(canonical_key),
 group_id text NOT NULL UNIQUE, group_name text NOT NULL,
 enabled boolean NOT NULL DEFAULT false, registered_by text NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS progress_line_deliveries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), canonical_key text NOT NULL REFERENCES progress_line_groups(canonical_key),
 series_id uuid NOT NULL, cycle integer NOT NULL CHECK(cycle>0), stage text NOT NULL CHECK(stage IN ('week_before','night_before')),
 lesson_id text NOT NULL, scheduled_at timestamptz NOT NULL, reminder_date date NOT NULL, group_id text NOT NULL,
 text text NOT NULL, candidate jsonb NOT NULL, retry_key uuid NOT NULL DEFAULT gen_random_uuid(),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','retry','sent','cancelled','missed','failed','uncertain')),
 attempts integer NOT NULL DEFAULT 0, first_attempt_at timestamptz, lease_until timestamptz, next_attempt_at timestamptz,
 provider_message_id text, provider_receipt jsonb, error text, sent_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS progress_line_delivery_occurrence_idx ON progress_line_deliveries(series_id,cycle,stage,lesson_id,scheduled_at,group_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS progress_line_delivery_work_idx ON progress_line_deliveries(status,reminder_date);
