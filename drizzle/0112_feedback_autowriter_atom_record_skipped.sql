-- An Atom record whose list entry and transcript disagree is now left out on its own (the student's other Atom work is
-- kept), and noted once on the dashboard under its own kind, at info severity (never pushed).
ALTER TABLE feedback_autowriter_incidents DROP CONSTRAINT feedback_autowriter_incidents_kind_check;
--> statement-breakpoint
ALTER TABLE feedback_autowriter_incidents ADD CONSTRAINT feedback_autowriter_incidents_kind_check CHECK (kind IN (
  'halt','correction_failed','critical_verdict','critical_flag','credit_entries_changed','api_actor_unmatched',
  'first_shot_unverified','scan_failed',
  'atom_collection_failed','style_review_flagged','style_review_unavailable','style_review_source_missing',
  'atom_record_skipped'
));
