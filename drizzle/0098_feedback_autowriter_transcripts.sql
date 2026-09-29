-- Feedback autowriter second pass: when the AI summary cannot carry the feedback
-- (draft held, no usable summary, or a mostly-Thai summary), wait for Wise's
-- recording, transcribe it with Soniox and write from the transcript.
ALTER TABLE feedback_autowriter_sessions DROP CONSTRAINT feedback_autowriter_sessions_state_check;
--> statement-breakpoint
ALTER TABLE feedback_autowriter_sessions ADD CONSTRAINT feedback_autowriter_sessions_state_check CHECK (state IN ('pending','generating','would_submit','posting','awaiting_event','verified','held','skipped_human','skipped_scope','expired','rejected','unknown_outcome','verify_failed','awaiting_recording','transcribing'));
--> statement-breakpoint
ALTER TABLE feedback_autowriter_sessions ADD COLUMN evidence text NOT NULL DEFAULT 'summary' CHECK (evidence IN ('summary','transcript'));
--> statement-breakpoint
ALTER TABLE feedback_autowriter_sessions ADD COLUMN soniox_transcription_id text;
--> statement-breakpoint
ALTER TABLE feedback_autowriter_calls DROP CONSTRAINT feedback_autowriter_calls_role_check;
--> statement-breakpoint
ALTER TABLE feedback_autowriter_calls ADD CONSTRAINT feedback_autowriter_calls_role_check CHECK (role IN ('writer','judge','transcriber'));
--> statement-breakpoint
ALTER TABLE feedback_autowriter_calls DROP CONSTRAINT feedback_autowriter_calls_arm_check;
--> statement-breakpoint
ALTER TABLE feedback_autowriter_calls ADD CONSTRAINT feedback_autowriter_calls_arm_check CHECK (arm IN ('glm','luna','soniox'));
