CREATE TABLE IF NOT EXISTS "student_schedule_live_cache" (
  "cache_key" text PRIMARY KEY,
  "sessions" jsonb,
  "fetched_at" timestamptz,
  "published_at" timestamptz,
  "lease_token" uuid,
  "lease_expires_at" timestamptz,
  "retry_after" timestamptz
);
