-- Calendar delivery may be bound after Wise confirmation. Existing events retain their bindings.
ALTER TABLE tutor_sit_in_observations
  ALTER COLUMN calendar_id DROP NOT NULL,
  ALTER COLUMN calendar_provider DROP NOT NULL,
  ALTER COLUMN calendar_provider DROP DEFAULT,
  ADD COLUMN calendar_attempted_at timestamp with time zone,
  ADD COLUMN calendar_synced_at timestamp with time zone;
--> statement-breakpoint
UPDATE tutor_sit_in_observations
SET calendar_attempted_at = created_at
WHERE calendar_provider IS NOT NULL AND calendar_id IS NOT NULL;
--> statement-breakpoint
UPDATE tutor_sit_in_observations
SET calendar_synced_at = created_at
WHERE calendar_status = 'synced' OR event_etag IS NOT NULL OR event_url IS NOT NULL;
--> statement-breakpoint
-- Recompute the shortlist under Wise-only rules; never reinterpret a legacy Calendar result.
UPDATE tutor_sit_in_assignments
SET suggestions = '[]'::jsonb, checked_at = NULL
WHERE status IN ('pending', 'needs_rescheduling');
