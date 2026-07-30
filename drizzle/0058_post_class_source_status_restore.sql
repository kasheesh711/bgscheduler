-- REC-01: make the run-wide fail-closed demotion recoverable.
--
-- A global source issue demotes every eligible session to 'unavailable' in one
-- statement, but restoration only ever happened one row per successful Wise
-- detail fetch (capped at 50 per cron run). With ~11k sessions the table could
-- never catch up, and any transient Wise error reset the progress.
--
-- `source_status_before` records what a row carried before a blanket demotion,
-- so a later healthy sync restores every demoted row in one statement. The
-- fail-closed behaviour is unchanged: rows still demote the instant source
-- health becomes unprovable.

ALTER TABLE "post_class_sessions"
	ADD COLUMN IF NOT EXISTS "source_status_before" "post_class_source_status";--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "pc_sessions_source_restore_idx"
	ON "post_class_sessions" USING btree ("source_status_before")
	WHERE "source_status_before" IS NOT NULL;
