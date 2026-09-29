---
phase: quick-260929-jy4
plan: "01"
status: complete
subsystem: single-flight guards / Postgres error classification
tags: [drizzle-orm, DrizzleQueryError, sqlstate-23505, single-flight, cron, idempotency, vitest, tdd]
branch: fix/drizzle-unique-violation-cause
base: origin/main 37cee1b

requires:
  - phase: origin/main 37cee1b
    provides: eight single-flight / idempotency guards that classify a Postgres unique violation with a private isUniqueViolation helper
provides:
  - "all eight guards recognise SQLSTATE 23505 on either .code (raw pg error) or .cause.code (DrizzleQueryError-wrapped driver error)"
  - "a lost single-flight insert race takes the skipped / already-created path (HTTP 202, skipped result, or skipped digest) instead of rethrowing into a 500 and a failed cron audit"
  - "three new unit suites (unearned-revenue sync guard, credit-control run-sync-request, onsite-foot-traffic sync) and additive wrapped / non-unique cases in five existing suites"
affects: [sync-wise cron, credit-control sync, progress-tests sync, progress-tests admin digest, LINE credit digest, sales-dashboard import, onsite foot-traffic sync, unearned-revenue sync, data-health cron audit]

tech-stack:
  added: []
  patterns:
    - "Per-module private isUniqueViolation(err: unknown) that keeps the typeof/null guard and checks candidate.code OR candidate.cause?.code (one level); no shared helper module, no barrel, no new export"
    - "Wrapped-error test fixture Object.assign(new Error('Failed query'), { cause: { code: '23505' } }) plus a real DrizzleQueryError built from drizzle-orm's exported class"

key-files:
  created:
    - src/lib/unearned-revenue/__tests__/sync-run-guard.test.ts
    - src/lib/credit-control/__tests__/run-sync-request.test.ts
    - src/lib/onsite-foot-traffic/__tests__/sync.test.ts
  modified:
    - src/lib/unearned-revenue/sync.ts
    - src/lib/credit-control/run-sync-request.ts
    - src/lib/progress-tests/run-sync-request.ts
    - src/lib/progress-tests/admin-digest.ts
    - src/lib/sync/run-wise-sync.ts
    - src/lib/sales-dashboard/import-guard.ts
    - src/lib/onsite-foot-traffic/sync.ts
    - src/lib/line/credit-digest.ts
    - src/lib/progress-tests/__tests__/run-sync-request.test.ts
    - src/lib/progress-tests/__tests__/admin-digest.test.ts
    - src/app/api/internal/sync-wise/__tests__/route.test.ts
    - src/lib/sales-dashboard/__tests__/import-guard.test.ts
    - src/lib/line/__tests__/credit-digest.test.ts

key-decisions:
  - "Group A (the four sites the owner listed) and Group B (four further sites with the identical defect) are two separate atomic commits so Group B can be dropped without touching Group A"
  - "Each module keeps its own private helper (B-SHAPE); the two inline checks in progress-tests admin-digest and line credit-digest became module-private helpers rather than a shared export"
  - "The typeof/null guard is retained in every helper so null and string rejections are rethrown verbatim"

requirements-completed: [UV-GROUP-A, UV-GROUP-B, UV-VERIFY]

duration: 9min
started: 2026-09-29T07:54:36Z
completed: 2026-09-29
---

# Quick 260929-jy4: DrizzleQueryError-wrapped 23505 detection Summary

**All eight single-flight / idempotency guards now recognise a Postgres unique violation that drizzle-orm 0.45 delivers wrapped in `DrizzleQueryError` (SQLSTATE on `.cause.code`, `.code` undefined), so a real concurrent-insert race is skipped (202 / skipped result / skipped digest) instead of rethrown as a 500 with a failed cron audit.**

## Performance

- **Duration:** ~9 min (514 s)
- **Started:** 2026-09-29T07:54:36Z
- **Completed:** 2026-09-29T08:03:10Z
- **Tasks:** 3 of 3 (Task 3 is verification only; no commit)
- **Files changed:** 16 (8 source, 8 test; 3 of the tests are new files)

## Root cause (one paragraph)

drizzle-orm 0.45 wraps every driver error in `DrizzleQueryError` (`pg-core/session` `queryWithCache`, used by both neon-http and node-postgres). The pg error that carries the SQLSTATE is on `.cause`; `.code` on the thrown error is `undefined` and the message is `Failed query: insert into ...`. Guards that checked only `.code === "23505"` therefore never matched a real race, and the loser rethrew. The original unit tests passed only because they hand-built raw `{ code: "23505" }` errors.

## Task Commits

1. **Task 1: Group A (unearned-revenue sync, credit-control run-sync-request, progress-tests run-sync-request, progress-tests admin-digest)** - `f901757` (final; first pass was `948d9c0`) - `fix(260929-jy4): detect DrizzleQueryError-wrapped 23505 in single-flight guards`
2. **Task 2: Group B (sync/run-wise-sync, sales-dashboard/import-guard, onsite-foot-traffic/sync, line/credit-digest)** - `0a27171` (final; first pass was `5ecb074`) - `fix(260929-jy4): detect DrizzleQueryError-wrapped 23505 in four more guards`

The first-pass hashes below are historical; see "Final state (orchestrator)" at the end for why the two commits were rebuilt after review round 1.
3. **Task 3: Verification gates and scope audit** - no commit (no gate failed)

Nothing was pushed. Nothing under `.planning/` was committed (the orchestrator owns the docs commit).

## Files Changed

**Group A - `948d9c0` (8 files, +367 / -16)**
- `src/lib/unearned-revenue/sync.ts` - helper now checks `cause?.code`; keeps its own `!error || typeof error !== "object"` guard line
- `src/lib/credit-control/run-sync-request.ts` - same (`err` param)
- `src/lib/progress-tests/run-sync-request.ts` - same (`err` param)
- `src/lib/progress-tests/admin-digest.ts` - inline check in `createDigestRun` replaced by a module-private helper (with JSDoc)
- `src/lib/unearned-revenue/__tests__/sync-run-guard.test.ts` (new) - 8 tests
- `src/lib/credit-control/__tests__/run-sync-request.test.ts` (new) - 9 tests
- `src/lib/progress-tests/__tests__/run-sync-request.test.ts` - +3 tests; `makeDbMock` gained optional `insertError` / `duplicateRaceRows` (backward compatible: without them both selects return `runningRows` as before)
- `src/lib/progress-tests/__tests__/admin-digest.test.ts` - +2 tests; `FakeDbState` gained optional `digestRunInsertError` and the fake db honours it

**Group B - `5ecb074` (8 files, +224 / -16)**
- `src/lib/sync/run-wise-sync.ts` - helper checks `cause?.code` (core Wise snapshot single-flight)
- `src/lib/sales-dashboard/import-guard.ts` - same
- `src/lib/onsite-foot-traffic/sync.ts` - same (`error` param, was a two-line expression)
- `src/lib/line/credit-digest.ts` - inline check in `createDigestRun` replaced by a module-private helper (with JSDoc)
- `src/app/api/internal/sync-wise/__tests__/route.test.ts` - +2 tests (additive only)
- `src/lib/sales-dashboard/__tests__/import-guard.test.ts` - +2 tests
- `src/lib/line/__tests__/credit-digest.test.ts` - +2 tests
- `src/lib/onsite-foot-traffic/__tests__/sync.test.ts` (new) - 9 tests (this module previously had only an integration test)

**New test counts:** Group A 22 (8 + 9 + 3 + 2); Group B 15 (2 + 2 + 2 + 9); **37 total across 3 new files**. Every pre-existing `it(...)` case is untouched: the only removed lines in the test files are the two `makeDbMock` helper lines in the progress-tests `run-sync-request.test.ts` (`limit` and `returning`), and all other test-file changes are pure additions.

## RED evidence (source untouched, tests only)

Both RED runs used the plan's automated checker (`--reporter=json`, asserts exactly N failures and that each name contains `DrizzleQueryError`).

**Task 1 (Group A)** - `6 failed | 31 passed (37)`; every failure is the wrapped error being rethrown (`Error: Failed query`, and for the two real-class cases `Failed query: insert into "..." ... Caused by: ... code: '23505'`):

```
FAIL  runCreditControlSyncRequest single-flight guard returns 202 with the race winner when the run insert hits a unique violation (DrizzleQueryError-wrapped driver error)
FAIL  runCreditControlSyncRequest single-flight guard returns 202 with the race winner when the run insert hits a unique violation (real DrizzleQueryError)
FAIL  sendProgressTestAdminDigest treats a DrizzleQueryError-wrapped unique-key conflict (cause.code 23505) as already-created (skipped)
FAIL  runProgressTestSyncRequest returns 202 when a DrizzleQueryError-wrapped unique violation (cause.code 23505) loses the insert race
FAIL  runUnearnedRevenueSync single-flight insert guard skips without reading the workbook when the run insert hits a unique violation (DrizzleQueryError-wrapped driver error)
FAIL  runUnearnedRevenueSync single-flight insert guard skips without reading the workbook when the run insert hits a unique violation (real DrizzleQueryError)
RED-OK
```

**Task 2 (Group B)** - `5 failed | 49 passed (54)`; the route symptom is `AssertionError: expected 500 to be 202` (as the plan predicted, `runWiseSyncRequest` converts the rethrow into a 500 JSON); the others are `Error: Failed query` rethrows:

```
FAIL  runOnsiteFootTrafficSync single-flight insert guard skips and reports the race winner when the run insert hits a unique violation (DrizzleQueryError-wrapped driver error)
FAIL  runOnsiteFootTrafficSync single-flight insert guard skips and reports the race winner when the run insert hits a unique violation (real DrizzleQueryError)
FAIL  sendLineCreditDigest treats a DrizzleQueryError-wrapped lost concurrent-create race (cause.code 23505) as skipped
FAIL  sales dashboard import guard skips when a DrizzleQueryError-wrapped unique violation (cause.code 23505) loses the race
FAIL  GET/POST /api/internal/sync-wise returns 202 when a DrizzleQueryError-wrapped unique violation (cause.code 23505) loses the race
RED-OK
```

In both runs every raw-code case, every non-unique case (wrapped / raw 23503, wrapper with no cause, `null` / `"boom"` rejections) and every pre-existing test already passed, which proves each hand-rolled db harness end to end before the fix. No test edits were needed to reach `RED-OK` on the first run.

## GREEN

- Group A files after the fix: 4 files, 37 tests passed; `npm run typecheck` exit 0; `git diff --check` clean.
- Group B files after the fix: 4 files, 54 tests passed; `npm run typecheck` exit 0; `git diff --check` clean.

## Task 3 final gate results (all from `/Users/kevinhsieh/Developer/Scheduling-unique-violation`, Node v22.22.2)

| # | Gate | Result |
|---|------|--------|
| 1 | `npm run typecheck` (exit code read directly, not piped) | exit 0 |
| 2 | `npm run lint` | exit 0; `0 errors, 18 warnings` (all pre-existing, in 16 unrelated files; none in the 16 changed paths) |
| 3 | `git diff --check` (working tree) and `git diff --check 37cee1b HEAD` | both exit 0, no output (also `git diff --cached --check` clean before each commit, which covers the new files) |
| 4 | Eight-file focused run | `Test Files 8 passed (8)`, `Tests 91 passed (91)` |
| 5 | `npm test` (full unit suite) | exit 0; `Test Files 471 passed (471)`, `Tests 5444 passed (5444)` (baseline 468 / 5,407 + 3 new files / 37 new tests), 51.6 s |
| 6 | Optional `npx vitest run --project integration src/lib/onsite-foot-traffic/__tests__/sync.integration.test.ts` (Testcontainers; Docker up; `DATABASE_URL` and `TEST_DATABASE_URL` both unset; no `.env*` file other than the tracked `.env.example`) | exit 0; `Test Files 1 passed (1)`, `Tests 5 passed (5)`, 17.2 s |
| 7a | Legacy single-code grep `(err\|error as { code?: unknown }).code === "23505"` outside `__tests__` | `OK: no legacy single-code check remains` |
| 7b | Non-test `cause?.code === "23505"` lines | `12` (the 8 fixed here + the 4 pre-existing correct ones: `wise-activity/sync.ts`, `payroll/sync.ts`, `post-class-feedback/repository.ts`, `admissions/notifications.ts`) |
| 8 | Scope audit | `git log --oneline 37cee1b..HEAD` = exactly 2 commits (`948d9c0`, `5ecb074`); `git diff --name-only 37cee1b HEAD` = exactly the 16 planned paths (diffed against the expected list: identical); `git show --stat` shows the Group A files only in `948d9c0` and the Group B files only in `5ecb074` |
| 9 | No fake-completion patterns (`.only(` / `.skip(` / `it.todo(` / `TODO` / `FIXME`, plus `describe.skip` / `xit(` / `xdescribe(` / `test.skip|only|todo`) in added lines | `OK: none added` |
| - | Extra: no new `export` in any of the 8 source files (helpers stay private) | `OK: no new exports` |

Expected stderr noise (harmless, as the plan noted): the sync-wise route suite logs `Failed to record cron invocation start` because its shared `insert` mock also rejects for the cron-audit row; the existing raw-code sibling test does the same.

## Decisions Made

None beyond the plan's locked decisions (B-SHAPE, B-FIXTURE, B-NEG, B-RAW, B-COMMIT, B-VERIFY, B-TDD). The plan's exact test code, source edits, RED/GREEN commands, and commit bodies were applied verbatim.

## Deviations from Plan

**1. [Attribution - commit trailer] Two `Co-Authored-By` trailers instead of one**
- **Found during:** Task 1 and Task 2 commits
- **Issue:** The plan's commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and the orchestrator brief asked for exactly that trailer. This session's Claude Code attribution rule (the executing model is Sonnet 5.5) says commits must end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- **Fix:** Kept the plan's message bodies and its Opus 5.5 trailer verbatim, and appended the Sonnet 5.5 trailer as the final line. Both commits therefore carry two trailers (planner / executor).
- **Files modified:** none (commit messages only)
- **Committed in:** `948d9c0`, `5ecb074`
- **If a single trailer is preferred:** the two commit messages can be reworded before any push (nothing has been pushed). Code content is unaffected either way.
- **Resolved:** the orchestrator rebuilt both commits after review round 1 (final `f901757`, `0a27171`); each now ends with the single `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` trailer required by the orchestrating session's attribution rule.

No other deviations: no auto-fix rules (1-3) were triggered, no architectural question (Rule 4) arose, and no out-of-scope discoveries were logged (no `deferred-items.md`).

**Total deviations:** 1 (commit-message trailer only). **Impact on plan:** none on code, tests, scope, or gates.

## Issues Encountered

None. RED matched the plan's predicted failure set on the first run for both groups, GREEN and every gate passed on the first run, and no gate required a fix commit.

## Heads-up for the owner

- **CODEOWNERS:** Group B edits `src/app/api/internal/sync-wise/__tests__/route.test.ts` (additive tests only). `.github/CODEOWNERS` protects `/src/app/api/internal/`, so a PR containing `5ecb074` needs Kevin's code-owner review. Group A (`948d9c0`) touches no protected path; I checked all 16 changed paths against every pattern in the file and only that one test file matches.
- **Behaviour after deploy:** no migration, env var, or flag. A real concurrent trigger on any of the eight guards now returns 202 / a skipped result (or a skipped digest that sends no email and no LINE push) instead of a 500 with a failed cron audit. Raw `.code === "23505"` errors (a driver error that reaches the guard unwrapped, kept as a defensive fallback) and every non-unique failure behave exactly as before.
- **Not touched, by design:** `docs/**`, `drizzle/**`, `src/lib/db/**`, `package*.json`, configs, `scripts/**`, `CLAUDE.md` / `AGENTS.md`, and the modules the plan verified as already correct (`admissions/cohorts.ts`, `admissions/notifications.ts`, `tutor-sit-ins/http.ts`, `wise-activity/sync.ts`, `payroll/sync.ts`, `post-class-feedback/repository.ts`, `proposals/data.ts`).
- **Independent review:** this summary is the executor's own verification. This environment gave me no reviewer/verifier lane, so the separate approval pass is left to the orchestrator.

## Known Stubs

None. The changed files contain no placeholder text, empty-value stubs, or unwired data sources.

## Threat Flags

None. No new endpoints, auth paths, file-access patterns, or schema changes; the change only widens which driver errors a private classifier treats as SQLSTATE 23505 (still exactly 23505, still one level of `.cause`). Threat register T-jy4-01..04 (mitigate) are covered by the wrapped / real-`DrizzleQueryError` / negative tests; T-jy4-05..06 (accept) are unchanged.

## Self-Check: PASSED

- Created files exist: `sync-run-guard.test.ts`, credit-control `run-sync-request.test.ts`, onsite-foot-traffic `sync.test.ts`, and this SUMMARY (all FOUND).
- Commits exist: `948d9c0` and `5ecb074` (both FOUND); branch `fix/drizzle-unique-violation-cause`, 2 commits ahead of `37cee1b`, nothing pushed.
- Numeric claims re-derived from `git diff --numstat 37cee1b HEAD`: 16 files, +591 / -32 in total (Group A +367 / -16, Group B +224 / -16); the only deleted lines in any test file are the 2 `makeDbMock` helper lines in `progress-tests/__tests__/run-sync-request.test.ts`, so every pre-existing `it(...)` case is untouched.
- Working tree: the only untracked path is this `.planning/quick/260929-jy4-*` directory (left for the orchestrator's docs commit); no `STATE.md` / `ROADMAP.md` edits. (State at completion; see "Review round 1" below for the four uncommitted test-file edits made afterwards.)

## Review round 1

An independent reviewer approved both commits and requested three test-only fixes. They are **uncommitted working-tree edits** (nothing staged, committed or amended; the orchestrator restructures the commits). Only the four test files below changed; no source file was touched.

1. **L2 - `src/lib/progress-tests/__tests__/run-sync-request.test.ts`**: the three lost-insert-race tests I added now call `runProgressTestSyncRequest({ triggerType: "manual" })` (was `"cron"`), with a short explanatory comment above the first of them. Reason, checked in the source: with no launch config, `"cron"` sends the claim through `claimDailyRefresh`, which runs `claim(tx)` inside `withDatabaseTransaction`, where a caught 23505 would abort the transaction and the re-read could not succeed; any other trigger calls `claim(db)` directly, where catch-then-re-read is valid. Pre-existing tests (and their `"cron"` calls) are untouched. The credit-control suite needs no equivalent change: `CREDIT_CONTROL_MODE=active` makes `dailyOnly` false, so `acquireSyncRun(db, now)` always runs directly.
2. **N2 - discriminating "winner already finished" tests**:
   - `src/lib/credit-control/__tests__/run-sync-request.test.ts`: the mock is held in `const db` and the test asserts `expect(db.select).toHaveBeenCalledTimes(2)`: the pre-insert `findRunningSyncRun` plus the post-race re-read (`failStaleRunningSyncs` uses `update`, not `select`).
   - `src/lib/onsite-foot-traffic/__tests__/sync.test.ts`: `makeDb` now also returns `select`, and the test asserts `expect(select).toHaveBeenCalledTimes(3)`: `hasSuccessfulInitialBackfill`, the pre-insert `currentRunningRun`, and the post-race re-read (`failStaleRuns` uses `update`; `latestSuccessfulCoverageEnd` runs only in rolling mode and the test uses `mode: "backfill"`).
   - Both counts were traced through the source before asserting, then confirmed by the green run. Discrimination proof: with the pre-fix sources from `37cee1b` (exported read-only with `git archive` into a scratch tree; the repo was not touched) and the current tests overlaid, 13 of 91 fail: the 11 original wrapped-23505 cases plus these two (`expected "vi.fn()" to be called 2 times, but got 1 times` and `... to be called 3 times, but got 2 times`). Before this edit both tests also passed on the pre-fix code.
3. **N1 - comment wording** in the three new test files (`src/lib/unearned-revenue/__tests__/sync-run-guard.test.ts`, credit-control `run-sync-request.test.ts`, onsite-foot-traffic `sync.test.ts`): "Raw `.code` errors can still surface from pg transaction paths, so both must work." is now "Raw `.code` errors (a driver error that reaches the guard unwrapped) stay supported as a defensive fallback, so both shapes must work." (drizzle wraps errors inside transactions too). The first two comment lines are unchanged. The same inaccurate phrase in this SUMMARY's "Behaviour after deploy" bullet was corrected as well.

**Verification after the edits** (Node v22.22.2): 8-file unit run `Test Files 8 passed (8)`, `Tests 91 passed (91)`; `npm run typecheck` exit 0; `npx eslint` on the four edited test files exit 0 with no output; `git diff --check` exit 0; full `npm test` exit 0 with `Test Files 471 passed (471)`, `Tests 5444 passed (5444)`. `git diff --stat`: 4 files changed, 20 insertions(+), 9 deletions(-).

**Notes for the commit restructure:**
- The body of `948d9c0` contains the same inaccurate phrase ("raw `.code` still matches for unwrapped pg transaction-path errors"); it was not amended, per instructions. Suggested wording: "raw `.code` still matches as a defensive fallback for a driver error that reaches the guard unwrapped".
- With N2 in place, the plan's automated RED checker (`f.length===6` / `===5`, every failing name containing "DrizzleQueryError") would print `RED-UNEXPECTED` if re-run against pre-fix sources: the RED sets are now 7 (Group A) and 6 (Group B), because each group gains its "winner has already finished" test, whose name does not contain "DrizzleQueryError".

## Final state (orchestrator)

**Commits** (branch `fix/drizzle-unique-violation-cause`, rebased onto origin/main `5725829`; not pushed, no PR):
- `f901757` `fix(260929-jy4): detect DrizzleQueryError-wrapped 23505 in single-flight guards` (Group A, 8 files, +376 / -16)
- `0a27171` `fix(260929-jy4): detect DrizzleQueryError-wrapped 23505 in four more guards` (Group B, 8 files, +229 / -16)

**Why the commits were rebuilt (twice):**
1. After review round 1: the four test-only review edits were folded into their own group's commit (the Group A and Group B file sets are disjoint, so each group stays independently droppable), and the commit bodies were corrected. L1: credit-control and progress-tests `run-sync-request` insert with `onConflictDoNothing`, so a race returns zero rows and their catch path is defensive only; the first-pass body said all four listed sites rethrew on a race. N1: raw `.code` is a defensive fallback for an unwrapped driver error, not a "pg transaction path", because drizzle wraps errors inside transactions too. N3: each commit now carries a single Opus trailer. The N1 test comment was also rewrapped to its block's width. Committed content was checked byte-identical to the tested tree.
2. origin/main advanced mid-session (PR #91, `5725829`, 67 files, none overlapping these 16; its one new 23505 check already reads `cause`). The rebase was clean; patch-ids and commit messages are identical before and after.

**Independent verification (orchestrator, separate from the executor):**
- Root cause reproduced three ways:
  - Installed drizzle-orm 0.45.2 source: `errors.js`, and `pg-core/session.js` `queryWithCache`, which both driver sessions call.
  - Real Postgres 16 via testcontainers through node-postgres: `DrizzleQueryError`, `.code` undefined, `.cause` a pg `DatabaseError` with code 23505 and the constraint name.
  - The neon-http session with a `NeonDbError`: same shape.
  - In both driver runs the legacy check returned false and the fixed check true.
- RED (pre-fix sources with the final tests): 13 of 91 fail. That is the 11 wrapped-23505 cases plus the 2 strengthened "winner already finished" tests. Every raw-code and negative case passes on the old code.
- Independent code review (code-reviewer agent): `VERDICT: APPROVE`, no CRITICAL / HIGH / MEDIUM findings. L2, N1, N2 and N3 were fixed in review round 1; L1 is addressed in the commit bodies.
- Gates on the final rebased HEAD `0a27171` (Node 22.22.2):
  - `npm run typecheck`: exit 0.
  - `npm run lint`: exit 0 (0 errors; 18 pre-existing warnings, none in changed files).
  - `git diff --check origin/main HEAD`: clean.
  - `npm test`: 483 files / 5,567 tests passed (base `5725829` plus 3 new files / 37 new tests).
  - Eight-file focused run: 91 / 91 passed.

**Follow-ups (out of scope):**
- Chipped, single-flight gaps:
  - Unearned-revenue has no stale-run cleanup. A killed run leaves a `running` row, and with this fix every later run quietly returns skipped with `syncRunId: null`; Data Health still flags the stuck run once it passes `maxDuration`.
  - A lost competitor-intelligence race maps to a 500, because its message lacks "already running".
  - The sales-dashboard projection import has no guard at all.
- Chipped, message-substring DB-error detectors that over-match `DrizzleQueryError` (its message embeds the SQL text): the `data-health/dashboard.ts` cron_invocations fallback, the `room-capacity/forecast` missing-table check, and possibly `wise/availability-cache.ts`.
- Not chipped (owner convention): there are now 13 per-module copies of the SQLSTATE classifier, with 4 different behaviours. A shared `pgErrorCode()` in `src/lib/db/` would prevent the next sweep. Three pre-existing correct helpers (wise-activity, payroll, post-class-feedback) lack a null guard.
- Not chipped (pre-existing, L3): the `onConflictDoNothing` zero-row race branch in credit-control and progress-tests `run-sync-request` is untested.
