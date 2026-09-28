ALTER TYPE post_class_notification_kind ADD VALUE IF NOT EXISTS 'tutor_nightly';
--> statement-breakpoint
ALTER TYPE post_class_notification_status ADD VALUE IF NOT EXISTS 'unknown';
--> statement-breakpoint
ALTER TABLE post_class_settings
  ADD COLUMN reminder_mode text NOT NULL DEFAULT 'off' CHECK (reminder_mode IN ('off','shadow','live')),
  ADD COLUMN reminder_started_at timestamptz,
  ADD COLUMN reminder_activated_at timestamptz,
  ADD COLUMN legacy_reminder_disabled_at timestamptz;
--> statement-breakpoint
ALTER TABLE post_class_notification_deliveries ADD COLUMN frozen_content jsonb;
--> statement-breakpoint
CREATE TABLE post_class_reminder_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES post_class_notification_runs(id),
  reminder_date date NOT NULL,
  mode text NOT NULL CHECK (mode IN ('shadow','live')),
  wise_session_id text NOT NULL,
  wise_class_id text NOT NULL,
  session_id uuid REFERENCES post_class_sessions(id),
  canonical_tutor_key text,
  scheduled_end_at timestamptz NOT NULL,
  deadline_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','queued','blocked_source','blocked_recipient','sent','expired','excluded','superseded','unknown','failed')),
  reason text,
  delivery_id uuid REFERENCES post_class_notification_deliveries(id),
  last_checked_at timestamptz,
  source_observed_at timestamptz,
  inventory_changed_at timestamptz,
  raw_session jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX pc_reminder_ledger_night_session_idx ON post_class_reminder_ledger(mode, reminder_date, wise_session_id);
CREATE INDEX pc_reminder_ledger_run_status_idx ON post_class_reminder_ledger(run_id, status);
CREATE INDEX pc_reminder_ledger_session_idx ON post_class_reminder_ledger(session_id, reminder_date);
--> statement-breakpoint
CREATE TABLE post_class_reminder_worker (
  id text PRIMARY KEY DEFAULT 'nightly',
  lease_token uuid NOT NULL,
  lease_until timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint
ALTER TABLE cron_alert_state ALTER COLUMN last_alerted_at DROP NOT NULL;
