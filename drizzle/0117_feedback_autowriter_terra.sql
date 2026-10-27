-- Allow the new writer arm while preserving every existing arm.
ALTER TABLE feedback_autowriter_sessions DROP CONSTRAINT feedback_autowriter_sessions_arm_check;
--> statement-breakpoint
ALTER TABLE feedback_autowriter_sessions ADD CONSTRAINT feedback_autowriter_sessions_arm_check CHECK (arm IS NULL OR arm IN ('glm','luna','sol','terra'));
--> statement-breakpoint
ALTER TABLE feedback_autowriter_calls DROP CONSTRAINT feedback_autowriter_calls_arm_check;
--> statement-breakpoint
ALTER TABLE feedback_autowriter_calls ADD CONSTRAINT feedback_autowriter_calls_arm_check CHECK (arm IN ('glm','luna','soniox','sol','terra'));
