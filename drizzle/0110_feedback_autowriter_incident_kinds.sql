-- Incident kinds of their own for the Atom collector and the guided-post style review, which recorded under
-- 'scan_failed' (shown as "The forward scan failed") before any forward scan existed. 'scan_failed' stays for it.
ALTER TABLE feedback_autowriter_incidents DROP CONSTRAINT feedback_autowriter_incidents_kind_check;
--> statement-breakpoint
ALTER TABLE feedback_autowriter_incidents ADD CONSTRAINT feedback_autowriter_incidents_kind_check CHECK (kind IN (
  'halt','correction_failed','critical_verdict','critical_flag','credit_entries_changed','api_actor_unmatched',
  'first_shot_unverified','scan_failed',
  'atom_collection_failed','style_review_flagged','style_review_unavailable','style_review_source_missing'
));
--> statement-breakpoint
UPDATE feedback_autowriter_incidents SET kind = 'atom_collection_failed'
  WHERE kind = 'scan_failed' AND dedupe_key LIKE 'atom-collection:%';
--> statement-breakpoint
UPDATE feedback_autowriter_incidents SET kind = 'style_review_source_missing'
  WHERE kind = 'scan_failed' AND dedupe_key LIKE 'iseb-review-source:%';
--> statement-breakpoint
-- A style result is dashboard-only (owner, 2 Oct 2026): info severity, never pushed. The table check ties info to
-- push_status 'not_required'; pushed_at and pushed_channels keep the history of anything already delivered.
UPDATE feedback_autowriter_incidents
  SET kind = CASE WHEN dedupe_key LIKE '%:flagged' THEN 'style_review_flagged' ELSE 'style_review_unavailable' END,
    severity = 'info', push_status = 'not_required', next_push_at = NULL
  WHERE kind = 'scan_failed' AND dedupe_key LIKE 'iseb-style:%';
