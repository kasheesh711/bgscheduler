ALTER TABLE tutor_sit_in_calendar_connections
  ADD COLUMN provider text NOT NULL DEFAULT 'google',
  ADD COLUMN provider_account_id text,
  ADD COLUMN account_email text,
  ALTER COLUMN google_email DROP NOT NULL,
  ALTER COLUMN google_subject DROP NOT NULL,
  ADD CONSTRAINT sit_in_calendar_provider CHECK (provider IN ('google','microsoft'));
--> statement-breakpoint
UPDATE tutor_sit_in_calendar_connections
SET provider_account_id = google_subject, account_email = google_email;
--> statement-breakpoint
ALTER TABLE tutor_sit_in_observations
  ADD COLUMN calendar_provider text NOT NULL DEFAULT 'google',
  ADD COLUMN calendar_account_id text,
  ALTER COLUMN event_id DROP NOT NULL,
  ADD CONSTRAINT sit_in_observation_provider CHECK (calendar_provider IN ('google','microsoft'));
--> statement-breakpoint
UPDATE tutor_sit_in_observations o SET calendar_account_id = c.provider_account_id
FROM tutor_sit_in_calendar_connections c WHERE c.email = o.observer_email;
--> statement-breakpoint
DROP INDEX sit_in_calendar_event;
--> statement-breakpoint
CREATE UNIQUE INDEX sit_in_calendar_event ON tutor_sit_in_observations(observer_email, calendar_provider, calendar_id, event_id);
