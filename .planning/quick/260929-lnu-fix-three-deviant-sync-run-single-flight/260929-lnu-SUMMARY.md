---
phase: quick-260929-lnu
plan: "01"
status: complete
subsystem: single-flight guards / *_sync_runs
tags: [single-flight, stale-lease, unique-violation, sqlstate-23505, drizzle-orm, cron, unearned-revenue, competitor-intelligence, sales-dashboard, vitest, tdd]
branch: fix/single-flight-guard-deviations
base: "origin/main 5725829 + quick 260929-jy4 (fix/drizzle-unique-violation-cause, tip 222e2e3)"

requires:
  - phase: quick-260929-jy4
    provides: cause-aware private isUniqueViolation in unearned-revenue/sync.ts and sales-dashboard/import-guard.ts (left byte-identical here)
provides:
  - "unearned revenue: 20-minute stale sweep, running pre-check, race re-read, skipped result that names the blocking run (id, startedAt, message) and reports staleRunningSyncsFailed"
  - "competitor intelligence: a lost run-insert race throws the same 'Competitor intelligence sync is already running' error as the pre-check, so both routes answer 409 and cron audit records skipped"
  - "sales projection import: acquireSalesProjectionImportRun + failStaleSalesDashboardProjectionImports, skipped outcome returned before the source row is touched, skip-aware dashboard message"
  - "lease-vs-maxDuration invariant tests (20 min > 800 s) for every route that starts each run"
affects: [unearned-revenue daily cron, POST /api/unearned-revenue/sync, POST /api/competitor-intelligence/sync, sync-competitor-intelligence cron, sales-dashboard 10,40 cron, POST /api/sales-dashboard/projection-import, data-health job runner, data-health cron audit]

tech-stack:
  added: []
  patterns:
    - "Standard guard shape (credit-control / wise-sync): stale sweep -> running pre-check -> insert with startedAt: now -> cause-aware 23505 catch -> re-read winner (skipped) or rethrow the ORIGINAL error"
    - "Lease invariant asserted by reading each entry route's `export const maxDuration` as TEXT (importing a route pulls in the Next/auth graph)"
    - "Per-module private helpers (no shared helper module, no barrel)"

key-files:
  created:
    - src/app/api/competitor-intelligence/sync/__tests__/route.test.ts
  modified:
    - src/lib/unearned-revenue/sync.ts
    - src/lib/unearned-revenue/__tests__/sync-run-guard.test.ts
    - src/lib/competitor-intelligence/sync.ts
    - src/lib/competitor-intelligence/__tests__/sync-guard.test.ts
    - src/lib/sales-dashboard/import-guard.ts
    - src/lib/sales-dashboard/data.ts
    - src/components/sales-dashboard/sales-dashboard-shell.tsx
    - src/lib/sales-dashboard/__tests__/import-guard.test.ts

key-decisions:
  - "Plan snippets applied verbatim (they were prototype-validated); no typecheck or eslint adjustment was needed in the real worktree"
  - "Commit trailer is `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` on all three commits, exactly as plan G-05 and the task brief require (matches the jy4 commits on this branch)"

requirements-completed: [SFG-UR-STALE-LEASE, SFG-UR-BLOCKING-RUN-ID, SFG-CI-RACE-ALREADY-RUNNING, SFG-SD-PROJECTION-SINGLE-FLIGHT, SFG-SD-SKIPPED-UI]

duration: ~13min
started: "approx. 2026-09-29T09:04Z (start time was not recorded at launch; first RED run 09:07:17Z)"
completed: 2026-09-29
---

# Quick 260929-lnu: Three deviant sync-run single-flight guards Summary

**Unearned revenue, competitor intelligence and the sales projection import now follow the credit-control / wise-sync guard shape (20-minute stale sweep, running pre-check, insert, cause-aware 23505 catch that re-reads the winner or rethrows the original error), so a timeout-killed run can no longer wedge the unearned-revenue daily run or the `10,40 * * * *` sales cron, and a lost competitor insert race answers 409 instead of 500.**

## Performance

- **Duration:** ~13 min
- **Started:** approx. 2026-09-29T09:04Z (not recorded at launch)
- **Completed:** 2026-09-29T09:17Z (implementation and verification; summary written after)
- **Tasks:** 3 of 3
- **Files:** 9 (1 created, 8 modified); 702 insertions, 56 deletions; no migration, schema, env, `vercel.json` or `route.ts` change

## Accomplishments

- **Unearned revenue (Task 1):** `runUnearnedRevenueSync` now fails any `running` row older than 20 minutes (`STALE_RUNNING_UNEARNED_REVENUE_SYNC_MS`, exported) before the pre-check, then proceeds under a fresh run id. Previously nothing ever cleaned that table, so one timeout-killed run made every later daily run skip forever with `syncRunId: null`. A skipped result now carries `syncRunId` = the blocking run, `runningStartedAt`, `message`, `alreadyRunning: true` and `staleRunningSyncsFailed` (still HTTP 202 through both routes, routes untouched). A lost insert race re-reads the winner, or rethrows the ORIGINAL error if the winner already finished. Success and failure results also report `staleRunningSyncsFailed`.
- **Competitor intelligence (Task 2):** only the `competitor_sync_runs` insert is wrapped. A cause-aware 23505 (raw, `DrizzleQueryError`-wrapped, or a real `DrizzleQueryError`) throws the exact pre-check error (`COMPETITOR_SYNC_ALREADY_RUNNING_ERROR`, shared constant), so `POST /api/competitor-intelligence/sync` answers 409 and cron audit records `skipped`. Every other insert failure is rethrown unchanged (still 500). New route-level test drives the REAL `runCompetitorIntelligenceSync` through the real route.
- **Sales projection import (Task 3):** `import-guard.ts` gains `failStaleSalesDashboardProjectionImports` (per-source, shares the 20-minute `STALE_RUNNING_SALES_IMPORT_MS`, no source-status restore) and `acquireSalesProjectionImportRun`. `importSalesDashboardProjectionSource` acquires through it and returns the skipped outcome BEFORE the `lastImportError: null` source update (verified by reading L651-653 vs L657-660 of the edited function). A skipped request no longer touches the source row; a stuck run stops making every later import (and the sales cron) fail on `sdpir_source_single_running_idx`. The dashboard shows "Sales dashboard projection import is already running." instead of "0 monthly scenario rows imported".
- **Lease safety:** tests read the `maxDuration` of every route that starts each run (2 unearned-revenue routes; 3 sales routes) and assert each 20-minute lease exceeds it, so a route raising its ceiling past the lease fails the suite.

## Task Commits

Each task was committed atomically (code + tests only; nothing under `.planning/`):

1. **Task 1: Unearned-revenue sync guard** - `9c71b81` (fix) - `fix(260929-lnu): reclaim stale unearned-revenue sync runs and name the blocking run`
2. **Task 2: Competitor lost-insert-race mapping** - `dc69c8e` (fix) - `fix(260929-lnu): map a lost competitor sync insert race to already running`
3. **Task 3: Sales projection import guard** - `ad9eaed` (fix) - `fix(260929-lnu): single-flight guard for sales dashboard projection imports`

**Plan metadata (SUMMARY/STATE docs commit):** left to the orchestrator, as instructed.

Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (checked with `git log`). Post-commit deletion check on each: no deleted files.

## TDD evidence (tests first, RED against the untouched source, then GREEN)

| Task | Suite(s) | RED (untouched source) | GREEN |
|------|----------|------------------------|-------|
| 1 | `src/lib/unearned-revenue/__tests__/sync-run-guard.test.ts` (13 cases, rewritten in place) | 11 failed / 2 passed (13); the two passing are the null and string rejection cases | 13 passed |
| 2 | `src/lib/competitor-intelligence/__tests__/sync-guard.test.ts` (9 = 2 existing + 7 new) + new `src/app/api/competitor-intelligence/sync/__tests__/route.test.ts` (2 new) | 4 failed / 7 passed (11): the three lib lost-race cases and the route 409 case; non-unique, pre-check and route-500 cases pin behavior that must not change and pass on both sides | 11 passed |
| 3 | `src/lib/sales-dashboard/__tests__/import-guard.test.ts` (17 = 6 existing + 8 new projection + 3 lease) | 8 failed / 9 passed (17): every new projection guard case (`acquireSalesProjectionImportRun` / `failStaleSalesDashboardProjectionImports` "is not a function"); the six existing cases and the three lease cases pass on both sides | 17 passed |

New / changed test counts: unearned-revenue suite 13 cases; competitor 7 new lib cases + 2 route cases; sales 8 new projection cases + 3 lease cases. These are the plan's stated counts (11 of 13, 4 of 11, 8 of 17), observed exactly. The existing six monthly-import cases and the two stale-sweep competitor cases stay byte-identical; the only pre-existing test lines removed in those two files are the inline insert mock (hoisted into `insertValues` in `import-guard.test.ts`) and the single-line `sync-guard.test.ts` import (expanded to a multi-line import). The jy4 `sync-run-guard.test.ts` was overwritten in place as the plan directs.

## Verification (plan `<verification>` section, all run in the worktree)

| # | Check | Result |
|---|-------|--------|
| 1 | `npm run typecheck` | exit 0 |
| 2 | `npm run lint` | exit 0: 0 errors, 18 warnings, all pre-existing in 16 unrelated files (1599 files linted); all 9 changed files linted with 0 findings |
| 3 | Affected unit suites (plan's list, incl. cron-registry and data-health job-runner route) | 37 files, 238 tests passed |
| 4 | `npm test` (full unit project) | exit 0: 484 files, 5592 tests passed, 0 failed (~33 s) |
| 5 | `git diff --check` (working tree and `222e2e3..HEAD`) | clean |
| 6 | Grep checks | `staleRunningSyncsFailed,` on exactly 3 lines (598, 648, 666); `COMPETITOR_SYNC_ALREADY_RUNNING_ERROR` on exactly 3 lines (44, 517, 530); `acquireSalesProjectionImportRun(db` on 1 line (643); jy4 `isUniqueViolation` bodies untouched (no `candidate.code` / `cause?.code` diff lines) |
| 7 | Blockers: `.only(` / `.skip(` / TODO / FIXME in changed `src` files | none found; every changed test asserts concrete values and was seen failing RED |
| 8 | `git log 222e2e3..HEAD` / `--stat` / `status` | exactly the three planned commits; the changed-file set equals the plan's nine files exactly; nothing under `.planning/` committed; no non-test `route.ts` changed; `git status` shows only the untracked `.planning/quick/260929-lnu-*` |

## Decisions Made

- Followed the plan's locked decisions G-01..G-06 and UR/CI/SD specs unchanged: per-module private helpers (no shared module), one 20-minute lease everywhere (longer than the 800 s `maxDuration` of every entry route, asserted by tests), `startedAt: now` set explicitly on inserted `running` rows, fail-closed (an unrecognised database error is rethrown, never reported as "already running").
- jy4's cause-aware `isUniqueViolation` bodies in `unearned-revenue/sync.ts` and `sales-dashboard/import-guard.ts` were not touched; the competitor module gets its own private copy of the same body, as CI-02 specifies.

## Deviations from Plan

None - plan executed exactly as written. All source and test snippets were applied verbatim, RED and GREEN counts equal the plan's, and no typecheck or eslint adjustment was needed in the real worktree.

Cosmetic placement notes (not deviations): the competitor constant and its comment sit directly under `STALE_RUNNING_COMPETITOR_SYNC_ERROR` with no blank line, per "directly after"; commit messages were supplied to `git commit -F` from files in the session scratchpad so the text is byte-exact (nothing from the scratchpad was committed).

## Issues Encountered

- While attributing the lint warnings I first used ESLint's `--format unix`, which no longer exists in ESLint 9 and returned empty output (a false "no findings"). I caught it and re-ran with `--format json`, which is the source of the lint numbers above. No code impact.
- Out-of-scope observation, not fixed and not logged as a separate file: the 18 pre-existing lint warnings (16 files, e.g. `src/lib/db/index.ts`, `src/components/compare/*`, `src/lib/sync/__tests__/*integration*`, `.claude/workflows/document-bgscheduler.js`) predate this branch and none is in a file this plan touches.

## Known Stubs

None. No hardcoded empty values, placeholders or unwired data were added; the shell's `"Projection import is already running."` is only a fallback when a skipped response carries no `message`.

## Threat Flags

None. No new endpoint, auth path, file-access pattern or schema at a trust boundary. Threat register coverage: T-lnu-01 (stale sweeps; stale-reclaim tests in Tasks 1 and 3), T-lnu-02 (lease vs `maxDuration` text-read tests, 2 + 3 routes), T-lnu-03 (pre-check + insert, index still the arbiter), T-lnu-04 (only SQLSTATE 23505 is the race; wrapped 23503, raw 23503, no-cause, null and string are rethrown verbatim and asserted), T-lnu-05 (stale runs are UPDATEd to `failed` with `finishedAt` and the "still running after 20 minutes" errorSummary, never deleted), T-lnu-06 (skipped early return precedes the source update, confirmed by reading the function), T-lnu-07 accepted as planned.

## Deploy notes for the owner

1. **No migration, env or `vercel.json` change.** The existing partial unique indexes (`ur_sync_single_running_idx`, `competitor_sync_runs_single_running_idx`, `sdpir_source_single_running_idx`) are untouched, and they remain the arbiter of "one run at a time".
2. **Behavior changes.**
   - Unearned-revenue skipped responses (still HTTP 202 through both routes) now carry the blocking run's `syncRunId`, `runningStartedAt` and `message`, so the cron audit's `linkedRunIds.syncRunId` is populated for skips instead of null. The unearned-revenue dashboard reads only `ok` / `errorSummary`, so the added optional fields are safe.
   - A competitor sync whose run insert loses the race now answers 409 (and cron audit `skipped`) instead of a 500 / `failed` audit.
   - The sales cron's projection step now returns HTTP 200 with a nested skipped `projectionResult` on a race or a running import instead of 500. The projection success result also gains an additive `staleRunningImportsFailed` field.
3. **One-time cleanup on first invocation after deploy.** Any `running` row older than 20 minutes in `unearned_revenue_sync_runs` or `sales_dashboard_projection_import_runs` is failed by the next invocation with the "still running after 20 minutes" errorSummary (kept, not deleted, for the audit trail); expect one such `failed` row per table if a stuck row exists today. Read-only check beforehand: `select id, started_at from unearned_revenue_sync_runs where status = 'running'`, and the same query on `sales_dashboard_projection_import_runs`.

## Coordination

This branch contains jy4's two code commits (`f901757`, `0a27171`) and its docs commit (`222e2e3`); **jy4 must merge first**. If jy4 is rewritten, re-stack with `git rebase --onto <new jy4 tip> 222e2e3`. Nothing was pushed, no PR opened, nothing deployed; no other worktree was touched.

## Next Phase Readiness

Ready for review. Suggested review focus: the money-adjacent sales projection path (`data.ts` early return before the source update) and the unearned-revenue skipped-result contract change. Docs commit (SUMMARY.md, STATE.md) is the orchestrator's.

## Review round

**Independent reviewer verdict: APPROVE** on the three task commits. The follow-ups below were applied as two more atomic commits on the same branch (tests, then docs); no source file changed in either.

### Applied

**Commit 4 - `7e01523` `test(260929-lnu): pin projection import wiring and stale-sweep filters`** (3 files, +316/-4; tests only)

1. **[MEDIUM] Wiring test for the real projection import.** New `src/lib/sales-dashboard/__tests__/projection-import.test.ts` (5 tests) drives the REAL `importSalesDashboardProjectionSource` and `importActiveSalesDashboardProjectionSource` in `data.ts`. Only `next/cache`, `@/lib/sales-dashboard/sheets` and the workbook parser are mocked (`@/lib/sales-dashboard/projection` via `importOriginal`, keeping its `DEFAULT_*` constants). The db mock routes every call by the table object it receives (identity against the imported `schema.*` tables), serving the active-source read, the guard's sweep/pre-check/insert chains and the plain awaited updates. Cases: (a) a fresh running run is skipped with the full outcome, no insert, no workbook read, no `revalidateTag`, and no write outside the runs table (the source row is untouched); (b) one stale run and no live run: the sweep is the first write, the new run is inserted with `startedAt` the same Date as `options.now`, the first source update comes after the insert (`mock.invocationCallOrder`), and the result equals `{ sourceId, runId: "new-run", projectionMonths: 0, targetMonthlyRevenue: 750000, staleRunningImportsFailed: 1 }`; (c) a lost `23505` insert race names the winner and still leaves the source row untouched; (d) the active-source wrapper returns `null` with zero writes when no source is active, and passes a skipped outcome straight through.
   - **RED evidence (pre-fix `data.ts`).** With `git show 222e2e3:src/lib/sales-dashboard/data.ts` swapped into place: **4 failed / 1 passed (5)**. The one passer is "returns null when no projection source is active" (behavior that must not change). `git checkout HEAD -- src/lib/sales-dashboard/data.ts` restored the file; `git status` and `git diff HEAD -- data.ts` confirmed it clean.
   - **Mutation evidence (the reviewer's exact scenario).** Moving the `lastImportError: null` source update above the guard in `data.ts` fails **3 of 5** (both skip cases and the ordering case); file restored and verified clean. Before this commit that mutation, and reverting to the raw insert, passed every test in the repo.
2. **[LOW] Stale-sweep WHERE filters pinned.** In `sync-run-guard.test.ts` (stale test) and `import-guard.test.ts` (projection stale test, `updateWhere` now exposed from `makeDbMock`) the captured `.where(arg)` is rendered with `new PgDialect().sqlToQuery(arg)` and asserted exactly. The Date parameter is encoded by the timestamp column as an ISO string (determined empirically, not assumed), and the cutoff is derived from the exported lease constants (`STALE_RUNNING_UNEARNED_REVENUE_SYNC_MS`, `STALE_RUNNING_SALES_IMPORT_MS`), never a literal: unearned revenue `("unearned_revenue_sync_runs"."status" = $1 and "unearned_revenue_sync_runs"."started_at" < $2)` with `["running", now - lease]` (where `now` is the sweep's own `finishedAt`); projection `("sales_dashboard_projection_import_runs"."source_id" = $1 and ... "status" = $2 and ... "started_at" < $3)` with `["projection-1", "running", now - lease]`.
   - **Mutation evidence.** Dropping `lt(startedAt, cutoff)` from the unearned-revenue sweep: 1 failed / 12 passed (13). Dropping it from the projection sweep: 1 failed / 17 passed (18). Dropping the `sourceId` scope from the projection sweep: 1 failed / 17 passed (18). Each source file was restored with an explicit single-path `git checkout HEAD --` and verified clean.
3. **[NIT] Projection race case.** The `it.each` gained a real `new DrizzleQueryError(query, params, cause)` case (three shapes now) and asserts the full skipped shape with `toEqual` (including `message` and `staleRunningImportsFailed: 0`) instead of `toMatchObject`.

Test counts for commit 4: `projection-import.test.ts` 5 (new), `import-guard.test.ts` 18 (was 17, +1 real-`DrizzleQueryError` race case), `sync-run-guard.test.ts` 13 (count unchanged; the stale test gained the SQL assertions) = 36 tests across the three files, all GREEN; typecheck exit 0; eslint silent on all three; `git diff --check` clean.

**Commit 5 - `ef4d4c2` `docs(260929-lnu): record the projection, unearned-revenue and competitor single-flight fixes`** (9 docs files, +36/-28; docs only)

Fixes only statements this branch makes false; every NEW citation uses this branch's line numbers (`grep -n`), and unrelated line-number drift was left to the doc regeneration.

- (a) `docs/features/sales-dashboard.md`: heading renamed to "Single-flight import guard"; the "only the database half" paragraph replaced with an accurate description of the projection guard; the resolved "no stale-run recovery" open-question bullet deleted (it was the only link to the old anchor, confirmed by grep, so no dangling link).
- (b) `docs/OPEN-QUESTIONS.md`: new "Resolved since the previous revision" bullet for DATA-7 (projection-import bullet) and OPS-3 (projection lineage), noting that the DATA-7 bullet was also wrong that the table lacks a single-flight index (`sdpir_source_single_running_idx`, `schema.ts:804-806`); the projection sub-bullet removed from DATA-7 and the projection clause and sentence removed from OPS-3; every ID kept.
- (c) `docs/features/competitor-intelligence.md`: "Eight files" -> "Nine files" (verified against `find`), extended `sync-guard.test.ts` row, new row for `sync/__tests__/route.test.ts`, corrected "Not covered" sentence.
- (d) `docs/reference/api/competitor-intelligence.md` step 1: the pre-check is now described as backed by `competitor_sync_runs_single_running_idx`; a lost insert race gets the same "already running" error (23505 read from the error or its `cause`) and any other insert failure is rethrown; "global, one at a time" kept.
- (e) `docs/reference/api/internal-crons.md`: competitor "Side effects" line notes the lost-insert-race error and refreshes the citations inside that sentence.
- (f) `docs/operations/runbook.md` section 5.4: new rows for Sales dashboard projection and Unearned revenue; the Competitor row notes the insert-race mapping (its pre-existing stale citations deliberately left as they were).
- (g) `docs/reference/crons.md` section 18: one single-flight sentence for unearned revenue. `docs/features/unearned-revenue.md` has no statement about concurrent or stuck syncs, so it was left unchanged.
- **Additional statements found false by a docs-wide sweep and fixed in the same commit** (beyond the enumerated list, all under the same "only what this branch makes false" rule): `docs/reference/database/erd-sales-dashboard.md` (the "projection lineage has no stale-run recovery" open question removed; one sentence added to the write-path note that single-flight is now symmetric across lineages); `docs/reference/api/sales-dashboard.md` (the projection-import side effects said "There is **no** single-flight guard on this table", and its 200 response, the cron `projectionResult` shape and the 200 status-code row ignored the skipped outcome); and the Tests section of `docs/features/sales-dashboard.md` (24 -> 25 test files, 13 -> 14 library files, the `import-guard.test.ts` row, a new `projection-import.test.ts` row, and "`data.ts` is not exercised at all", which commit 4 makes false).

### Deviation from the fix-pass brief (recorded)

- **Parser stub shape.** The brief suggested stubbing `parseSalesProjectionWorkbook` to return `{ months: [], targetMonthlyRevenue: null, metadata: {} }` while asking to "check the real return type and satisfy it". The real `ParsedSalesProjectionWorkbook` requires `targetMonthlyRevenue: number` and `scenarioSummaries`, so the test uses a fixture typed against it (`targetMonthlyRevenue: 750_000`, `scenarioSummaries: []`, `months: []`, `metadata: {}`). Consequently case (b) asserts `targetMonthlyRevenue: 750000` (flowing from the parser into the result and the run and source updates) rather than `null`; the brief's other expectations (`projectionMonths: 0`, `staleRunningImportsFailed: 1`, the ordering and the `startedAt` identity) are asserted as written.
- Cases (c) and (d) are additions beyond the brief's "at minimum" (a) and (b).

### Consciously not applied

- **Competitor `{ cause }` on the rethrown already-running error.** A grep finds no `new Error(..., { cause })` usage anywhere in non-test `src`, and neither competitor sync route nor the data-health runner references `cause`, so it would be dead metadata; the original error is still rethrown verbatim for every non-unique failure.
- **Unearned-revenue success-path `staleRunningSyncsFailed` assertion.** It needs a full workbook fixture through `readUnearnedRevenueWorkbook` and the import transaction; the failure path already pins that `staleRunningSyncsFailed` is carried on a result returned after a sweep, and the success path adds the same one-line field.
- **Unearned-revenue lease test covering the data-health route.** `src/lib/data-health/run-job.ts` has no unearned-revenue reference (verified by grep), so the data-health runner starts no unearned-revenue run and there is no third route whose `maxDuration` a lease test could read; the missing Data Health dispatch is a separate chipped task.
- **Unearned-revenue dashboard skip notice.** The dashboard's sync call reads only `{ ok, errorSummary }` from the response (`src/components/unearned-revenue/unearned-revenue-dashboard.tsx:506`), so a skipped run (`ok: true`) never surfaced a message before this change either; that is not a regression, and the added optional fields (`syncRunId`, `runningStartedAt`, `message`, `staleRunningSyncsFailed`) are simply ignored there.
- **Low-confidence "frozen transaction / advisory-lock" concern.** Pre-existing and unverified; nothing in this branch changes transaction or locking behavior, so it is left for its own investigation.

### Review-round verification

`npm run typecheck` exit 0. `npm run lint` exit 0: 0 errors, 18 warnings, all pre-existing in 16 unrelated files (1600 files linted; all 10 files this task changed have 0 findings). `npm test` (full unit project) exit 0: **485 files, 5598 tests passed** (previously 484 and 5592: +1 file, +6 tests = the five new wiring tests plus the extra race case). `git diff --check` clean across all five commits; no `.only` / `.skip` / TODO / FIXME in any changed `src` file; all five commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; nothing under `.planning/` committed.

Process note: this pass began with several read-only inspection commands (grep, sed, awk, ls) that carried the `cd` to the worktree but omitted the `export PATH` half of the mandatory prefix, and one `node -e` probe consequently ran under the system Node 20 and failed harmlessly on an unexported `package.json` subpath. No file, git state or npm/npx command was affected; every later command carried the full prefix.

## Self-Check: PASSED

- All 9 plan files, the new `src/lib/sales-dashboard/__tests__/projection-import.test.ts` and this SUMMARY.md exist on disk.
- All 5 commits exist: `9c71b81`, `dc69c8e`, `ad9eaed` (tasks 1-3), `7e01523` (tests), `ef4d4c2` (docs).
- Final `git status --short --branch`: `## fix/single-flight-guard-deviations`, only the untracked `.planning/quick/260929-lnu-*` directory (SUMMARY.md and PLAN.md intentionally uncommitted; STATE.md and ROADMAP.md not touched).

---
*Quick task: 260929-lnu*
*Completed: 2026-09-29*
