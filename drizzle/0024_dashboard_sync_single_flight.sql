UPDATE "credit_control_sync_runs"
SET
  "status" = 'failed',
  "finished_at" = COALESCE("finished_at", now()),
  "error_summary" = COALESCE(
    "error_summary",
    'Credit control sync marked failed because it was still running after 20 minutes; likely timed out or the request was aborted.'
  )
WHERE "status" = 'running'
  AND "started_at" < now() - interval '20 minutes';
--> statement-breakpoint
WITH ranked_running AS (
  SELECT
    "id",
    row_number() OVER (ORDER BY "started_at" DESC, "id" DESC) AS rn
  FROM "credit_control_sync_runs"
  WHERE "status" = 'running'
)
UPDATE "credit_control_sync_runs"
SET
  "status" = 'failed',
  "finished_at" = COALESCE("finished_at", now()),
  "error_summary" = COALESCE(
    "error_summary",
    'Credit control sync marked failed because another run was already active during single-flight migration.'
  )
WHERE "id" IN (
  SELECT "id"
  FROM ranked_running
  WHERE rn > 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ccsr_single_running_idx"
ON "credit_control_sync_runs" ("status")
WHERE "status" = 'running';
--> statement-breakpoint
UPDATE "sales_dashboard_import_runs"
SET
  "status" = 'failed',
  "finished_at" = COALESCE("finished_at", now()),
  "error_summary" = COALESCE(
    "error_summary",
    'Sales dashboard import marked failed because it was still running after 20 minutes; likely timed out or the request was aborted.'
  )
WHERE "status" = 'running'
  AND "source_id" IS NOT NULL
  AND "started_at" < now() - interval '20 minutes';
--> statement-breakpoint
WITH ranked_running AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "source_id"
      ORDER BY "started_at" DESC, "id" DESC
    ) AS rn
  FROM "sales_dashboard_import_runs"
  WHERE "status" = 'running'
    AND "source_id" IS NOT NULL
)
UPDATE "sales_dashboard_import_runs"
SET
  "status" = 'failed',
  "finished_at" = COALESCE("finished_at", now()),
  "error_summary" = COALESCE(
    "error_summary",
    'Sales dashboard import marked failed because another import for this source was already active during single-flight migration.'
  )
WHERE "id" IN (
  SELECT "id"
  FROM ranked_running
  WHERE rn > 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sdir_source_single_running_idx"
ON "sales_dashboard_import_runs" ("source_id")
WHERE "status" = 'running'
  AND "source_id" IS NOT NULL;
