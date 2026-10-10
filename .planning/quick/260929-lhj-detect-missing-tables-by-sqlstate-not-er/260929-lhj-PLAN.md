---
phase: quick-260929-lhj
plan: "01"
type: execute
wave: 1
depends_on: []
files_modified:
  - src/lib/data-health/dashboard.ts
  - src/lib/data-health/__tests__/dashboard.test.ts
  - src/app/api/room-capacity/forecast/route.ts
  - src/app/api/room-capacity/__tests__/route.test.ts
  - src/lib/wise/availability-cache.ts
  - src/lib/wise/__tests__/availability-cache.test.ts
autonomous: true
requirements:
  - SQLSTATE-01-DATA-HEALTH
  - SQLSTATE-02-FORECAST-ROUTE
  - SQLSTATE-03-AVAILABILITY-CACHE
quick_id: 260929-lhj
branch: fix/missing-table-sqlstate
base: origin/main 5725829
worktree: /Users/kevinhsieh/Developer/Scheduling-missing-table-sqlstate

must_haves:
  truths:
    - "A DrizzleQueryError-shaped error whose message is `Failed query: ... cron_invocations ...` with cause.code 57014 (timeout) makes getCronJobsHealth reject with that error; with cause.code 42P01 it resolves on inferred run-table proof and logs the existing console.info line"
    - "GET /api/room-capacity/forecast returns the typed missing payload (200) only for SQLSTATE 42P01 (on the error or its cause); a wrapped timeout/connection/permission error whose SQL names a room_capacity_* table returns 500"
    - "loadFarLeaveCache still returns an empty map on every read failure (AVAIL-01 read rule), but logs console.info only for SQLSTATE 42P01 and console.error for everything else"
    - "No src/ non-test detector decides 'table missing' from DrizzleQueryError message text any more"
  artifacts:
    - path: "src/lib/data-health/dashboard.ts"
      contains: "isMissingCronInvocationsTable"
    - path: "src/app/api/room-capacity/forecast/route.ts"
      contains: "42P01"
    - path: "src/lib/wise/availability-cache.ts"
      contains: "42P01"
    - path: "src/lib/data-health/__tests__/dashboard.test.ts"
      provides: "getCronJobsHealth wrapped-error coverage (new file)"
  key_links:
    - "node_modules/drizzle-orm/errors.js — DrizzleQueryError message = `Failed query: ${query}\\nparams: ${params}`, driver error on .cause"
    - "node_modules/drizzle-orm/pg-core/session.js queryWithCache — wraps every neon-http and node-postgres query (db.batch is not wrapped: raw NeonDbError keeps .code)"
    - "src/lib/internal/cron-watchdog.ts isMissingAlertStateTable and src/lib/tutor-business-profiles.ts isMissingTutorProfileTable — existing cause-aware detectors"
---

<objective>
Stop three catch blocks from classifying "table missing" by substring-matching
`error.message`. Under drizzle-orm 0.45 every query error is a DrizzleQueryError
whose message embeds the SQL text, so it always names the table and the check
matches ANY failure (timeout, dropped connection, permission). Decide on the
Postgres SQLSTATE instead — `code ?? cause?.code` — so real outages surface.
</objective>

<context>
## Worktree rules
- Work only in /Users/kevinhsieh/Developer/Scheduling-missing-table-sqlstate (branch fix/missing-table-sqlstate off origin/main 5725829). Never touch /Users/kevinhsieh/Developer/Scheduling (someone else's uncommitted work).
- Node 22: `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`.
- No push, no PR.

## Verified findings (origin/main 5725829)
1. `src/lib/data-health/dashboard.ts` fetchCronInvocations catch: `message.includes("cron_invocations") || "relation" || "does not exist"` → every DB failure returns [] + console.info. getCronJobsHealth (cron watchdog sweep) and the /data-health payload then judge health from inferred run-table proof only.
2. `src/app/api/room-capacity/forecast/route.ts` isMissingForecastTableError: message.includes(any of 4 room_capacity_* names) → any failure of a forecast-table query returns the 200 "missing" payload.
3. `src/lib/wise/availability-cache.ts` loadFarLeaveCache catch: `message.includes("wise_teacher_availability_cache") || "does not exist"` → every read failure logs console.info (the console.error branch is unreachable for wrapped errors). Return value (empty map) is correct and stays.
4. Sweep of src/ non-test: no other detector has this over-match. Constraint/index-name checks (proposals `*_overlap`, `*_single_running_idx` in leave-requests/payroll/wise-activity/post-class/admissions) cannot over-match because those names never appear in INSERT SQL text, and all but proposals/route.ts already check `code`/`cause.code` first. The 23505 detectors are being fixed separately on fix/drizzle-unique-violation-cause (quick 260929-jy4, unmerged) — do not touch them.

## SQLSTATE choice
42P01 (undefined_table) only. None of these tables has gained a column since its create migration (cron_invocations 0038, room_capacity_* 0007/0008 with FK-only ALTERs, wise_teacher_availability_cache 0069), so 42703 is not an expected deploy-ahead-of-migration state here — it is schema drift and must surface.

## Pattern
Local per-file helper (codebase idiom; no shared pg-error module exists):
`typeof error === "object" && error !== null` then `(candidate.code ?? candidate.cause?.code) === "42P01"`.
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Data Health — rethrow real cron_invocations read failures</name>
  <files>src/lib/data-health/dashboard.ts, src/lib/data-health/__tests__/dashboard.test.ts (new)</files>
  <action>Add `isMissingCronInvocationsTable(error)` (SQLSTATE 42P01 via code ?? cause?.code, JSDoc explaining the DrizzleQueryError trap) and use it in fetchCronInvocations' catch; keep the console.info line and `return []` for that case, rethrow everything else. New test file exercises getCronJobsHealth with a mocked getDb (thenable query-chain fake: the ranked cron_invocations read rejects, every run-table read resolves []) and mocked applyNightlyReminderHealth: wrapped 57014 rejects with the same error and no console.info; wrapped 42P01 and raw-driver 42P01 resolve with console.info; wrapped 42703 rejects.</action>
  <verify>npx vitest run --project unit src/lib/data-health/__tests__/dashboard.test.ts</verify>
  <done>Tests pass; commit `fix(260929-lhj): detect missing cron_invocations by SQLSTATE`.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Room capacity forecast — 500 on real failures</name>
  <files>src/app/api/room-capacity/forecast/route.ts, src/app/api/room-capacity/__tests__/route.test.ts</files>
  <action>Replace isMissingForecastTableError's message substring checks with SQLSTATE 42P01 via code ?? cause?.code. Update the existing "missing forecast" test to a realistic DrizzleQueryError-shaped 42P01 error (the old bare-message Error has no code); add a raw-driver 42P01 case and a wrapped 57014 case whose SQL names room_capacity_model_runs → 500.</action>
  <verify>npx vitest run --project unit src/app/api/room-capacity/__tests__/route.test.ts</verify>
  <done>Tests pass; commit `fix(260929-lhj): return 500 for real room capacity forecast failures`.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: Far-leave cache — log real read failures as errors</name>
  <files>src/lib/wise/availability-cache.ts, src/lib/wise/__tests__/availability-cache.test.ts</files>
  <action>Classify loadFarLeaveCache read failures with a local 42P01 SQLSTATE helper: console.info only for a missing table, console.error (existing line) otherwise; both paths still return an empty map (AVAIL-01 read rule — never assume no leaves). Update the "table does not exist" test to a wrapped 42P01 error asserting info-not-error; add a wrapped 57014 case asserting error-not-info and an empty map.</action>
  <verify>npx vitest run --project unit src/lib/wise/__tests__/availability-cache.test.ts; npm run typecheck; npm run lint; git diff --check</verify>
  <done>Tests, typecheck, lint pass; commit `fix(260929-lhj): log real far-leave cache read failures as errors`.</done>
</task>

</tasks>

<verification>
- `npx vitest run --project unit src/lib/data-health/__tests__/dashboard.test.ts src/app/api/room-capacity/__tests__/route.test.ts src/lib/wise/__tests__/availability-cache.test.ts src/lib/internal/__tests__/cron-watchdog.test.ts src/app/api/data-health/__tests__/route.test.ts`
- `npm run typecheck`, `npm run lint`, `git diff --check origin/main`
- Re-run the src/ grep for message-substring DB checks; only the documented non-over-matching constraint/index-name checks remain.
</verification>
