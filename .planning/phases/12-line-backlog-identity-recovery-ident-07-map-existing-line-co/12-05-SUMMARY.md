---
phase: "12"
plan: "05"
subsystem: line-identity
tags: [line, backlog-recovery, ident-07, cron, schema, hardening]
dependency_graph:
  requires: ["12-04"]
  provides: ["lineBacklogRecoverySyncRuns table", "line_backlog_recovery cron-registry entry", "C2 route /api/internal/line-backlog-recovery"]
  affects: ["src/lib/db/schema.ts", "src/lib/data-health/cron-registry.ts", "src/app/api/internal/line-backlog-recovery/route.ts"]
tech_stack:
  added: []
  patterns: ["wiseActivitySyncRuns single-flight analog", "manual-only cron registry entry", "rejectInvalidCronSecret + withCronInvocationAudit route shell"]
key_files:
  created:
    - "src/app/api/internal/line-backlog-recovery/route.ts"
    - "drizzle/0042_special_titania.sql"
  modified:
    - "src/lib/db/schema.ts"
    - "src/lib/data-health/cron-registry.ts"
decisions:
  - "MIGRATION RENUMBERED: plan said 0041, but 0041_simple_lila_cheney was taken by the credit-control merge (applied to prod 2026-06-07, merged to main 2026-06-10) — drizzle generated 0042_special_titania.sql; drift check returned zero non-line_backlog_recovery statements, no trim needed"
  - "No vercel.json entry — manual-only job per plan; route exists for admin/data-health triggering"
metrics:
  duration: "12m"
  completed_date: "2026-06-10"
  tasks: 3
  files: 5
requirements: [IDENT-07]
---

# 12-05: C2 hardening — sync-runs table + manual-only recovery route

- `lineBacklogRecoverySyncRuns` added to schema (single-flight partial unique index on
  `status='running'`, follower/targets/matched/inserted counters, dryRun flag).
- Migration `0042_special_titania.sql` generated clean (zero catch-up drift), applied to
  production Neon — `to_regclass('line_backlog_recovery_sync_runs')` confirms; applied
  migration count 44→45.
- `line_backlog_recovery` registered in cron-registry (manualOnly, GET, 300s) — surfaces on
  /data-health with a manual trigger.
- C2 route mirrors `sync-wise-activity/route.ts`: `rejectInvalidCronSecret` first statement,
  `withCronInvocationAudit` wrapper, 500 catch with message extraction.
- Verification: `npx tsc --noEmit` clean; `npm test` 1174/1174 green (includes cron
  registration tests).

Phase 12 (IDENT-07) is now fully shipped: matcher → client → DB wiring → C1 route →
prod gate + live write (446 suggestions) → C2 hardening.
