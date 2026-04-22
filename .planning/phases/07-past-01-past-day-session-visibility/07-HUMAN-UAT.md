---
status: partial
phase: 07-past-01-past-day-session-visibility
source: [07-VERIFICATION.md]
started: 2026-04-22T15:25:00Z
updated: 2026-04-22T15:25:00Z
---

## Current Test

[awaiting human testing]

## Tests

### 1. Apply Drizzle migration 0002_past_session_blocks to Neon Postgres [BLOCKING]
expected: `DATABASE_URL=<neon-url> npm run db:migrate` runs cleanly; information_schema query returns 20 columns and 3 named indexes; `SELECT count(*) FROM past_session_blocks` returns 0 on creation
result: [pending]

### 2. End-to-end historical compare smoke test after migration applied
expected: `/compare` with `weekStart=<prior-Monday>` shows at least one real captured past session for a tutor with known past bookings (once a daily sync has run post-migration); honest-empty cells render for past weekdays with no captured data
result: [pending]

### 3. Observability check: sync_runs.metadata contains diffHookDurationMs + pastSessionsCapturedCount after first post-migration sync
expected: `SELECT metadata FROM sync_runs WHERE status='success' ORDER BY finished_at DESC LIMIT 1` shows non-null JSONB object containing both keys
result: [pending]

### 4. Cache-tag isolation smoke test: past-sessions cache survives a sync
expected: Historical compare request pre-sync and post-sync shows identical past data (no cache refetch); network tab or server logs show no DB hit on second historical request within `cacheLife('days')` window
result: [pending]

### 5. CACHE_VERSION=v2 invalidates long-lived client tabs transparently
expected: Admin with tab open pre-deploy sees one cold fetch on next compare interaction post-deploy; no hard reload required; no stale v1 CompareTutor shape visible
result: [pending]

### 6. PAST-06 email send follow-through
expected: User sends the email draft from `07-WISE-SPIKE.md` §1 via `kevhsh7@gmail.com`; Section 2 (Sent-On Metadata) populated with actual timestamp; Section 3 either captures Wise reply or marks "Unreachable (D-16)" at phase close
result: [pending]

## Summary

total: 6
passed: 0
issues: 0
pending: 6
skipped: 0
blocked: 0

## Gaps
