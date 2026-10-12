-- A critical (pushed) incident kind for OpenRouter credit: the key's spending limit or the account balance is about to
-- run out, or a model call was refused for lack of it (11 Oct 2026: the key's monthly limit stopped every writer and
-- judge for 14 hours and four classes were held).
ALTER TABLE feedback_autowriter_incidents DROP CONSTRAINT feedback_autowriter_incidents_kind_check;
--> statement-breakpoint
ALTER TABLE feedback_autowriter_incidents ADD CONSTRAINT feedback_autowriter_incidents_kind_check CHECK (kind IN (
  'halt','correction_failed','critical_verdict','critical_flag','credit_entries_changed','api_actor_unmatched',
  'first_shot_unverified','scan_failed',
  'atom_collection_failed','style_review_flagged','style_review_unavailable','style_review_source_missing',
  'atom_record_skipped','style_problem_recurring',
  'model_credit'
));
