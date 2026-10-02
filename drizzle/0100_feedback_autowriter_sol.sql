-- Feedback autowriter: GPT-6.1 Sol becomes the writer for everyone (owner decision, 2026-09-30).
-- Widens both arm checks to allow 'sol'. Backward compatible: every existing row still passes.
-- Keep it after a code rollback: older code (GLM writer) can still post a stored Sol draft, and the
-- row keeps arm 'sol', which the old checks would reject.
ALTER TABLE feedback_autowriter_sessions DROP CONSTRAINT feedback_autowriter_sessions_arm_check;
--> statement-breakpoint
ALTER TABLE feedback_autowriter_sessions ADD CONSTRAINT feedback_autowriter_sessions_arm_check CHECK (arm IS NULL OR arm IN ('glm','luna','sol'));
--> statement-breakpoint
ALTER TABLE feedback_autowriter_calls DROP CONSTRAINT feedback_autowriter_calls_arm_check;
--> statement-breakpoint
ALTER TABLE feedback_autowriter_calls ADD CONSTRAINT feedback_autowriter_calls_arm_check CHECK (arm IN ('glm','luna','soniox','sol'));
