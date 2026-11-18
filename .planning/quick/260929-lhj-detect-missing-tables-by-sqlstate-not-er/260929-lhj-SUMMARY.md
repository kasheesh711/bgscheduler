---
phase: quick-260929-lhj
plan: "01"
status: complete
subsystem: data-health / room-capacity / wise availability cache
tags: [drizzle, postgres, sqlstate, error-handling, vitest]

requires:
  - phase: origin/main aa13fb6
    provides: drizzle-orm 0.45.2 (DrizzleQueryError wrapping in pg-core/session.js queryWithCache)
provides:
  - isMissingCronInvocationsTable (dashboard.ts) — SQLSTATE 42P01 only
  - isMissingForecastTableError (forecast route) — SQLSTATE 42P01 only
  - isMissingCacheTable + describeDbFailure (availability-cache.ts) — 42P01-only log classification; logs the driver's SQLSTATE + message instead of SQL + params
affects: [data-health dashboard, cron watchdog sweep, room capacity forecast API, wise-sync far-leave cache logging]

tech-stack:
  added: []
  patterns:
    - "Decide 'table not migrated yet' on (error.code ?? error.cause?.code) === '42P01', never on DrizzleQueryError message text (it is the failed SQL + params and always names the table)"
    - "Log a DB failure as the driver's SQLSTATE + message, not the DrizzleQueryError message"

key-files:
  created:
    - src/lib/data-health/__tests__/dashboard.test.ts
  modified:
    - src/lib/data-health/dashboard.ts
    - src/app/api/room-capacity/forecast/route.ts
    - src/app/api/room-capacity/__tests__/route.test.ts
    - src/lib/wise/availability-cache.ts
    - src/lib/wise/__tests__/availability-cache.test.ts

key-decisions:
  - "42P01 only, not 42703: cron_invocations (0038), room_capacity_* (0007/0008, FK-only ALTERs) and wise_teacher_availability_cache (0069) never gained a column after creation, so a missing column is schema drift that must surface, not a deploy-ahead-of-migration state (reviewer confirmed every selected column is in each CREATE)"
  - "Local per-file helpers (codebase idiom; the parallel 23505 fix on fix/drizzle-unique-violation-cause does the same) rather than a new shared module — consolidation is a follow-up once both branches land"
  - "Forecast route keeps 'any 42P01 in the read → typed missing payload': the forecast table is read first and every later relation predates 0007/0008 except tutor_business_profiles (0018); reviewer: accept as-is"
  - "loadFarLeaveCache still returns an empty map on every read failure (AVAIL-01 read rule); only log level and content changed"

requirements-completed: [SQLSTATE-01-DATA-HEALTH, SQLSTATE-02-FORECAST-ROUTE, SQLSTATE-03-AVAILABILITY-CACHE]

duration: ~1.5h
completed: 2026-09-29
---

# Quick 260929-lhj: Detect missing tables by SQLSTATE, not error.message

Three catch blocks decided "the table is missing" by substring-matching
`error.message`. drizzle-orm 0.45 wraps every driver error in
`DrizzleQueryError` (message `Failed query: <sql>\nparams: ...`, driver error on
`.cause`), so the SQL text always named the table and the checks matched every
failure of the query. Each now decides on SQLSTATE 42P01 via
`code ?? cause?.code`.

## Commits (branch fix/missing-table-sqlstate, rebased onto origin/main aa13fb6)

| Task | Commit | What |
|------|--------|------|
| 1 | afda5b1 | Data Health `fetchCronInvocations`: 42P01 → `[]` + console.info, anything else rethrows (was: any failure → inferred run-table proof, also for the cron watchdog sweep) |
| 2 | 253b461 | Room capacity forecast route: 42P01 → typed missing payload (200), anything else 500 (was: any forecast-read failure → 200 "missing") |
| 3 | 0e86e9b | `loadFarLeaveCache`: 42P01 → console.info, anything else console.error (was: every failure logged as info; the error branch was unreachable) |
| review | d8d0e91 | Cache read/write error logs carry the driver's SQLSTATE + message instead of SQL + every param; tests pin log content, unwrapped 42P01, 42703, non-Error rejection; forecast 500 test no longer asserts SQL in the body; dashboard comment notes 42P01 also covers a missing FROM-clause entry |

## Verification

- Unit: dashboard 4/4 (new file), room-capacity route 14/14, availability-cache 22/22; RED observed first for every new negative case (including the three log-content tests against the pre-review source).
- Full unit suite after rebase: 481 files, 5547 tests passed.
- `npm run typecheck` clean; `npm run lint` 0 errors (18 pre-existing warnings, none in touched files); `git diff --check` clean.
- Real-driver proof (scratch integration test, testcontainers Postgres 16 + drizzle node-postgres, not committed): a lock-induced statement timeout produced `DrizzleQueryError` with message `Failed query: select "id", "job_key", ...` and `cause.code = 57014`. New code: dashboard rethrows, cache logs console.error, forecast returns 500; hidden tables (42P01) degrade as designed. Same test against the origin/main versions of the three files: 3 of 4 cases fail (timeout swallowed, logged as info, forecast 200).
- neon-http (production driver): `@neondatabase/serverless` 1.0.2 builds `NeonDbError(json.message)` on HTTP 400 and copies `code`; HTTP 5xx and fetch failures carry no SQLSTATE, so they surface.
- Independent review (code-reviewer agent): APPROVE, no blocking issues; ran every realistic error shape through the real neon-http client. LOW findings in this change were addressed in d8d0e91 except the shared-helper consolidation (follow-up).

## Sweep of src/ (non-test)

No other "table missing" detector over-matches. Remaining message checks look
for constraint or index names (`proposal_items_no_*_overlap`,
`*_single_running_idx` in leave-requests, payroll, wise-activity, post-class,
admissions). Those names never appear in INSERT SQL text, and all but
`src/app/api/proposals/route.ts` check `code`/`cause.code` first; that route's
copy sits behind `createProposalBundle`, which maps 23P01 via `code ?? cause.code`.

Similar but out of scope (reported, not changed):
- `src/lib/internal/cron-watchdog.ts` isMissingAlertStateTable also accepts any "does not exist" cause message (e.g. 42703); by this task's rule it should be 42P01-only. `cron_alert_state` never gained a column.
- `src/lib/tutor-business-profiles.ts` isMissingTutorProfileTable matches `message.includes("column")` against the full SQL; safe only while no column name contains "column". Its 42703 acceptance is legitimate (0019 added columns after 0018).
- `src/lib/post-class-feedback/sync.ts` isNetworkFailure lowercases the whole error chain (SQL + params included) and matches "dns"/"network error": a DB failure whose params contain such text would be labelled a Wise network failure. Label only; the issue is global and blocks enforcement either way.
- Theoretical param-text matches: `admissions/cohorts.ts:25` (duplicate-key phrase), "already running" in `data-health/cron-audit.ts:111` and `data-health/run-job.ts`.
- 23505 detectors: handled on `fix/drizzle-unique-violation-cause` (quick 260929-jy4).

## Deviations

- Added commit d8d0e91 after review (log content + test tightening); not in the original plan.
- Rebased from 5725829 onto aa13fb6 (PR #92; no overlapping files).
