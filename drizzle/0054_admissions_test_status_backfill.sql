-- 0053 introduced a typed sitting status with a safe default of "planned".
-- Restore the state implied by pre-0053 records before parity code ships:
-- any persisted score is received; an unscored sitting already in the past
-- is treated as taken. Future unscored sittings remain planned.
UPDATE "admissions_test_sittings"
SET
  "status" = 'score_received',
  "updated_at" = now()
WHERE "deleted_at" IS NULL
  AND (
    "score_details" IS NOT NULL
    OR NULLIF(BTRIM("actual_score"), '') IS NOT NULL
  )
  AND "status" = 'planned';

UPDATE "admissions_test_sittings"
SET
  "status" = 'taken',
  "updated_at" = now()
WHERE "deleted_at" IS NULL
  AND "status" = 'planned'
  AND "test_date" < (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date;
