-- One committed allocation per Wednesday checkpoint and teaching date. Legacy
-- automation batches and manually generated runs retain their existing behavior.
CREATE UNIQUE INDEX IF NOT EXISTS "car_weekend_checkpoint_date_idx"
ON "classroom_assignment_runs" ("automation_batch_id", "assignment_date")
WHERE "created_by" = 'cron@classroom-weekend';
