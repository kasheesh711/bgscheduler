-- Two dashboard-only (info, never pushed) incident kinds: an Atom record left out because its list entry and transcript
-- disagree (the student's other Atom work is kept), and a style problem the reviewer flagged on several posts in a week.
ALTER TABLE feedback_autowriter_incidents DROP CONSTRAINT feedback_autowriter_incidents_kind_check;
--> statement-breakpoint
ALTER TABLE feedback_autowriter_incidents ADD CONSTRAINT feedback_autowriter_incidents_kind_check CHECK (kind IN (
  'halt','correction_failed','critical_verdict','critical_flag','credit_entries_changed','api_actor_unmatched',
  'first_shot_unverified','scan_failed',
  'atom_collection_failed','style_review_flagged','style_review_unavailable','style_review_source_missing',
  'atom_record_skipped','style_problem_recurring'
));
