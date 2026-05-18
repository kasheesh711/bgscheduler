UPDATE "sync_runs"
SET
  "status" = 'failed',
  "finished_at" = COALESCE("finished_at", now()),
  "error_summary" = COALESCE(
    "error_summary",
    'Sync marked failed because it was still running after 20 minutes; likely timed out or the request was aborted.'
  )
WHERE "status" = 'running'
  AND "started_at" < now() - interval '20 minutes';
--> statement-breakpoint
WITH ranked_running AS (
  SELECT
    "id",
    row_number() OVER (ORDER BY "started_at" DESC, "id" DESC) AS rn
  FROM "sync_runs"
  WHERE "status" = 'running'
)
UPDATE "sync_runs"
SET
  "status" = 'failed',
  "finished_at" = COALESCE("finished_at", now()),
  "error_summary" = COALESCE(
    "error_summary",
    'Sync marked failed because another Wise sync was already running during single-flight migration.'
  )
WHERE "id" IN (
  SELECT "id"
  FROM ranked_running
  WHERE rn > 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sync_runs_single_running_idx"
ON "sync_runs" ("status")
WHERE "status" = 'running';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sync_runs_status_started_idx"
ON "sync_runs" ("status", "started_at");
