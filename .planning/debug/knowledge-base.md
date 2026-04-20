# GSD Debug Knowledge Base

Resolved debug sessions. Used by `gsd-debugger` to surface known-pattern hypotheses at the start of new investigations.

---

## vercel-cron-stale-sync — Vercel cron never fired because route only exported POST
- **Date:** 2026-04-20
- **Error patterns:** vercel cron, cron job, stale sync, 405 method not allowed, GET vs POST, /api/internal/sync-wise, data health stale, snapshot stale, cron not triggering
- **Root cause:** Route handler at `src/app/api/internal/sync-wise/route.ts` only exported a POST handler, but Vercel cron jobs always send GET requests. Next.js returns 405 for the unhandled GET method, so the cron never successfully ran — the only sync on record (April 7) was a manual `curl -X POST`.
- **Fix:** Added GET export to the route handler (Vercel cron sends GET). Kept POST for backward-compatible manual curl. Extracted shared `handleSync()` helper to avoid duplication. Committed in 5f01d0c (2026-04-16).
- **Files changed:** src/app/api/internal/sync-wise/route.ts
---

