---
phase: quick-260929-nwm
plan: "01"
status: complete
subsystem: data-health
tags: [data-health, cron-registry, run-job, vitest, satisfies, fail-closed, def-3]
branch: fix/data-health-run-dispatch
base: origin/main 7788eaf (rebased from 29aa114)

# Dependency graph
requires:
  - phase: none
    provides: "existing Data Health runner (run-job.ts), cron registry, audit wrapper at 29aa114"
provides:
  - "CronJobDefinition.manualRunDisabledReason (set only on student_promotions_july_1) + exported isManuallyRunnable predicate"
  - "Dashboard canRunManually / manualActions derived from isManuallyRunnable"
  - "runDataHealthJob 409 refusal before the owner gate and the audit wrapper"
  - "Nine new runDataHealthJob branches mirroring their /api/internal cron routes"
  - "run-job.test.ts dispatch-parity regression guard (compile-time satisfies + runtime set equality)"
  - "Docs corrected; DEF-3 recorded FIXED in OPEN-QUESTIONS §0"
affects: [data-health, student-promotions, line-integration, line-credit-bot, progress-tests, post-class-feedback, admissions, tutor-sit-ins, unearned-revenue]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Registry-level opt-out field (manualRunDisabledReason) + shared predicate consumed by both the payload and the dispatcher"
    - "Dispatch-parity table typed `satisfies Record<ManualRunKey, unknown>` where ManualRunKey is derived from the as-const registry"

key-files:
  created:
    - src/lib/data-health/__tests__/run-job.test.ts
  modified:
    - src/lib/data-health/cron-registry.ts
    - src/lib/data-health/dashboard.ts
    - src/lib/data-health/run-job.ts
    - src/lib/data-health/__tests__/cron-registry.test.ts
    - docs/features/data-health.md
    - docs/reference/api/data-health.md
    - docs/reference/crons.md
    - docs/reference/api/internal-crons.md
    - docs/OPEN-QUESTIONS.md
    - docs/features/line-credit-bot.md
    - docs/features/progress-tests-legacy.md
    - docs/features/student-promotions.md
    - docs/reference/api/student-promotions.md
    - docs/operations/runbook.md
    - docs/features/post-class-feedback.md

key-decisions:
  - "student_promotions_july_1 is excluded from Data Health one-click runs via registry field manualRunDisabledReason; a direct call gets 409 { error: reason } before the audit wrapper (no cron_invocations row)"
  - "Nine missing runDataHealthJob branches mirror their cron routes' composition and status mapping, passing triggerType manual + actorEmail where the library accepts them; terminal Unknown job 404 kept as a defensive default"
  - "Dispatch parity is enforced by run-job.test.ts at compile time (satisfies) and at runtime (set equality + it.each dispatch)"

patterns-established:
  - "Opt a registry job out of Data Health manual runs with manualRunDisabledReason, never by omitting a runner branch"

requirements-completed: [DEF3-EXCLUDE-PROMOTIONS, DEF3-FAIL-CLOSED-GUARD, DEF3-DISPATCH-PARITY, DEF3-REGRESSION-TEST, DEF3-DOCS]

# Metrics
duration: 22min
completed: 2026-09-29
---

# Quick 260929-nwm Plan 01: Data Health manual-run dispatch parity (DEF-3) Summary

**Every Run button Data Health renders now dispatches its job. The nine missing `runDataHealthJob` branches mirror their cron routes, and `student_promotions_july_1` is refused fail-closed (hidden button, `409` before the audit wrapper) through a new registry field. A `satisfies`-typed regression test fails both typecheck and the unit suite if a registry key ever lacks a branch.**

## Performance

- **Duration:** ~22 min
- **Started:** 2026-09-29T10:48:34Z
- **Completed:** 2026-09-29T11:10:44Z
- **Tasks:** 3/3
- **Files modified:** 16 (5 source/test + 11 docs)

## Accomplishments

- At 29aa114, 10 of the 32 registry keys had no branch; every click on them returned `404 Unknown job` and wrote a `failed` `triggerSource:"admin"` audit row. Now 31/32 dispatch, and the machine parity check prints exactly `student_promotions_july_1`.
- `post_class_feedback_backfill` and `line_backlog_recovery`, the only manual recovery levers their features have, now work from Data Health.
- The student-promotions exclusion is fail-closed at two layers. The payload never offers the button, and the dispatcher refuses the job before the owner gate and before `withCronInvocationAudit`.
- The regression guard was proven by probe. A temporary registry key `zz_probe` produced `TS1360` on the `DISPATCH_TARGETS satisfies` table and 2 unit failures ("covers exactly the registry keys…" and "dispatches zz_probe"). The registry was then restored byte-identical to HEAD.

## Task Commits

1. **Task 1: registry field + `isManuallyRunnable` + dashboard wiring** — `b4bb880` `feat(260929-nwm): exclude student promotions from Data Health one-click runs`
   - `src/lib/data-health/cron-registry.ts`, `src/lib/data-health/dashboard.ts` (hunks only at lines 6 / 498 / 1052), `src/lib/data-health/__tests__/cron-registry.test.ts`
2. **Task 2: fail-closed refusal + nine branches + dispatch-parity test** — `490301d` `fix(260929-nwm): dispatch every runnable Data Health job (DEF-3)`
   - `src/lib/data-health/run-job.ts` (105 insertions, 0 deletions), `src/lib/data-health/__tests__/run-job.test.ts` (new)
3. **Task 3: docs** — `a912650` `docs(260929-nwm): record Data Health dispatch parity; DEF-3 fixed`
   - The 10 planned docs, plus `docs/features/post-class-feedback.md` (see Deviations)

All three commits carry `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Paths were staged explicitly, and no commit deletes a file. Nothing was pushed.

## TDD evidence (RED observed locally, never committed, per plan/orchestrator)

**Task 1 RED** (`cron-registry.test.ts`, before implementation): `Tests 2 failed | 5 passed (7)`
- FAIL "excludes only the annual student promotions job…": `expected [] to deeply equal [ 'student_promotions_july_1' ]`
- FAIL "offers a manual run only for live, dispatchable jobs": `TypeError: isManuallyRunnable is not a function`

**Task 2 RED** (`run-job.test.ts`, before implementation): `Tests 23 failed | 23 passed (46)`, which matches the plan's prediction exactly.
- PASS: case (a) "covers exactly the registry keys Data Health can run", plus "dispatches" for all 22 existing keys.
- FAIL: "dispatches" for the 9 new keys (`expected 404 to be less than 400`).
- FAIL: "refuses student_promotions_july_1 before the audit wrapper" (`expected 404 to be 409`).
- FAIL: all 13 cron-mirror cases (entry point not called, or 404 status).
- Every failure was an AssertionError from the 404 fallthrough. There were no import or mock errors.

**GREEN:** `cron-registry.test.ts` 7/7 and `run-job.test.ts` 46/46.

## Final verification (at HEAD a912650)

| Check | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run lint` | 0 errors; 18 pre-existing warnings in other files; changed files lint clean (0 warnings) |
| Listed suites (`src/lib/data-health src/app/api/data-health operations-pause operations-access admissions-notifications post-class-feedback-backfill src/components/data-health`) | **15 files, 183 tests passed** (baseline before changes: 14 files, 135 tests) |
| `run-job.test.ts` | **46 passed**: (a) 1 + (b) 31 dispatch + (c) 1 refusal + 13 cron-mirror cases |
| `cron-registry.test.ts` | **5 → 7 passed** |
| `npm test` (full unit project) | **482 files, 5585 tests passed** |
| Registry parity (`comm -23` registry keys vs `jobKey ===` branches) | prints exactly `student_promotions_july_1` |
| Distinct dispatched keys in run-job.ts | 31 |
| `git diff -U0 origin/main -- dashboard.ts` hunks | `@@ -6`, `@@ -498`, `@@ -1052` only |
| OPEN-QUESTIONS hunks | `-50,0`, `-83`, `-230,2`, `-799`, `-1380,2`; none in the sibling ranges 55-79 / 784-798 |
| `git diff --check 29aa114..HEAD` | clean |
| Task 3 stale-claim grep, DEF-3 §0 count = 1, both test tables list run-job.test.ts | pass |
| Links added on changed doc lines | all resolve |
| `src/lib/data-health/__tests__/dashboard.test.ts` | not created |
| Out-of-bounds paths (`src/app/api/internal/**`, run route, `vercel.json`, `drizzle/`, `src/lib/db/**`, package files, CLAUDE.md, AGENTS.md) | untouched |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Doc accuracy] Three now-false doc statements missing from the plan's anchor list**
- **Found during:** Task 3. The plan's verify grep passed, but a broader sweep of `docs/` for other wordings of "cannot run from Data Health", "no branch" and "404" found them.
- **Issue:**
  - `docs/features/line-credit-bot.md` open question 3 said the LINE credit digest "cannot be run from Data Health at all", with its dangerous flag guarding "a button that returns 404". That directly contradicts the plan's must-have truth, and the file was already in scope.
  - `docs/features/post-class-feedback.md` open question 10 said "The Data Health job runner has no branch for `post_class_feedback_backfill` … `run-job.ts` cannot invoke it".
  - The same file's open question 11 referred to "the seven that return `404 {"error":"Unknown job"}`".
- **Fix:** Minimal rewrites, in the same "Resolved —" style the plan uses elsewhere.
  - credit-bot item 3: the dangerous flag now guards a real run, dispatched while Credit Control is active.
  - post-class item 10: the Data Health branch mirrors the cron (oldest window, one 50-detail batch, behind `access_manager`), and a targeted drain with explicit dates/caps stays `CRON_SECRET`-only (considered non-parity #3).
  - post-class item 11: "the seven that return 404" became "no longer lists the key among jobs Data Health cannot run".
- **Conflict with done criteria:** Task 3's done list says both "no doc claims one of the nine keys cannot run from Data Health" and "only the 10 listed docs changed". These cannot both hold, so correctness won (Decision E: "edit the statements this change makes false"; success criterion: "Docs no longer contradict the code"). `docs/features/post-class-feedback.md` is therefore an 11th doc.
  - Conflict risk check: none of the 7 unmerged branches that touch post-class-feedback.md or line-credit-bot.md has a hunk within 3 lines of these passages. Those branches are `fix/payout-deadline-recheck`, `codex/payout-*` and `codex/nightly-feedback-reminders`.
  - The docs commit can still be dropped independently.
- **Files modified:** `docs/features/line-credit-bot.md`, `docs/features/post-class-feedback.md`
- **Commit:** `a912650`

### Minor execution notes (no behavior change)

- **Test structure:** the plan's 8 cron-mirror behavior bullets are covered by 13 focused `it`s. Backfill and admissions are split by scenario, and the two digests get one `it` each. That is why the file has 46 cases.
- **Stronger assertions (the regression test's intent is not weakened):**
  - (b) also asserts the audit wrapper is called exactly once per dispatch.
  - The sit-in worker case asserts `Cache-Control: private, no-store`, which comes from `sitInJson`.
  - The sit-in digest case asserts `deadlineAt ∈ [now+270s]` and that `queueDailyDigests()` gets no arguments.
  - The admissions Sunday case asserts both passes received the same `Date` object.
  - The digest and backfill entry points are asserted to be called with no arguments.
- **Wrapping:** the plan gave the credit-bot "Manual re-run" paragraph as one line. It was wrapped to the file's existing ~100-column width, as Decision E requires, and its text is identical.
- **Stale test-file comment:** the plan's "widened view — see the TS2339 note in Task 1" comment was rewritten as a self-contained code comment, because the plan reference means nothing inside the test file.

## Considered non-parity (recorded decisions; copied from the plan, not "fixed")

1. **No progress-tests scope check.** The Data Health path has no progress-tests `scopeForEmail` check, although the internal route's session path has one. Data Health is the ops console; its only extra gates are the Kevin owner gate and the post-class `access_manager` gate. The run route's `job.key.startsWith("post_class_feedback")` check already covers `post_class_feedback_backfill`.
2. **`progress_tests` trigger type.** It runs with `triggerType: "manual"`, while the internal session path uses `"admin"`. The column is free text and `"manual"` is the library default. Before the tutor-workspace launch, a non-cron trigger skips the cron's daily-window claim (`claimDailyRefresh`) but still waits for today's shared snapshot.
3. **Backfill window.** `post_class_feedback_backfill` always takes the automatic oldest-unreconciled window with one 50-detail batch, exactly like the cron. Explicit `startDate`/`endDate`/`detailCap`/`maxBatches` remain a `CRON_SECRET`-only re-drain. Data Health does pass `actorEmail`; the cron passes none.
4. **Admissions cadence.** `admissions_notifications` has no `runType` override. It runs the cron's default cadence: the daily scan, plus the weekly digest on Bangkok Sundays.
5. **Env-paused jobs.** These are sit-ins while `TUTOR_SIT_INS_ENABLED` is not `"true"`, and the LINE credit digest while Credit Control is retired. `isManuallyRunnable` hides them. A direct POST still dispatches and the library self-skips, which matches existing `feedback_autowriter` behaviour.
6. **Manual run = one extra cron tick.** Every new branch's library self-gates and/or is single-flight or idempotent:
   - `runSitInWorker` returns `{ok:true, skipped:true, reason:"disabled"}` when disabled and holds a worker lease.
   - `queueDailyDigests` is a no-op when disabled or before 08:00 Bangkok, and queues jobs keyed per day.
   - `sendLineCreditDigest` self-skips when Credit Control is retired or the LINE scheduler is off, and once any run row exists for the date.
   - `sendProgressTestAdminDigest` waits for today's progress refresh and keeps a per-date terminal row.
   - Admissions daily and weekly runs are single-flight, with dedupe-keyed exactly-once sends.
   - `runLineBacklogRecovery` only inserts `status:"suggested"` links, with `onConflictDoNothing`.
   - The backfill, progress and unearned-revenue syncs are single-flight.

Branches that omit their own try/catch rely on `withCronInvocationAudit` turning a throw into `500 {error: message}` (Decision C). The only observable difference from the cron route is the fallback text for a non-`Error` throw ("Cron invocation failed").

## Owner notes (for the eventual PR and deploy)

1. `src/lib/data-health/cron-registry.ts` is CODEOWNERS-protected, so the PR needs Kevin's review.
2. After deploy, the Student Promotions "Run" button disappears from Data Health, and nine buttons that used to 404 now run for real:
   - LINE Backlog Recovery runs **live** (`dryRun: false`) and inserts only `suggested` links.
   - Admissions Notifications also sends the **weekly digest** when clicked on a Bangkok Sunday.
   - The sit-in, admissions and LINE-digest buttons keep their dangerous-job confirmation.
3. There are no migrations and no env changes.
4. Merge notes:
   - `dashboard.ts` hunks (lines 6/498/1052) do not overlap `fix/missing-table-sqlstate` (~882-930, plus its new `dashboard.test.ts`, which this branch did not create).
   - The OPEN-QUESTIONS §0 bullet sits after DEF-1, so it does not collide with the bullet `fix/single-flight-guard-deviations` appends at the end of §0.
   - The OPS-4 edit touches only line ~799, 4 unchanged lines below that branch's edit at 791-794.
   - The crons.md hunks start at 589 (the sibling inserts after 567). The internal-crons.md hunks are at 59 and 445 (the sibling is at 357). The runbook.md hunks are at 459 and ~901 (the sibling is at 592).
5. `origin/main` advanced during execution, from 29aa114 to `7788eaf` (PR #94, Soniox second pass, 6 commits).
   - Those commits change none of this branch's 16 files.
   - The only run-job dependency they touch is `feedback-autowriter/dispatch.ts`, and it keeps `runAutowriterJob()`'s exact signature. A rebase or merge should be clean.
   - The branch was not rebased (out of scope, and nothing was pushed).

## Threat model coverage

- **T-nwm-01:** hidden button plus 409 before the owner gate and audit, pinned by run-job case (c) and cron-registry.test.
- **T-nwm-02:** the branches call the same idempotent libraries as the crons, and the dangerous flags are unchanged.
- **T-nwm-03:** backfill is capped at 50/1.
- **T-nwm-04:** `triggerSource:"admin"` plus `actorEmail` is asserted for every key in case (b).
- **T-nwm-05:** the backfill generic 500 is asserted not to echo the thrown text, and sit-in errors go through `sitInError`.
- **T-nwm-06:** accepted as planned.
- **T-nwm-07:** the existing `access_manager` gate is unchanged.

No new endpoints, schema or trust boundaries were introduced beyond the plan's threat model, so there are no threat flags.

## Known Stubs

None. The hygiene scan of all 16 changed files found no `.only(`/`.skip(`, and no TODO/FIXME/HACK or placeholder stubs in added lines. The only "stub" matches are Vitest's `vi.stubEnv`/`vi.unstubAllEnvs` API.

## Issues Encountered

- There was no browser preview. `/data-health` needs an authenticated Google session and the Neon database, which this worktree does not have. The visible effect (one fewer button) is payload-driven. The client renders buttons only from `manualActions` and `runJob` returns early for a key absent from it (`data-health-dashboard.tsx:470-471`). The client never reads `canRunManually`.

## Self-Check: PASSED

- FOUND: src/lib/data-health/__tests__/run-job.test.ts
- FOUND: src/lib/data-health/cron-registry.ts, dashboard.ts, run-job.ts, __tests__/cron-registry.test.ts
- FOUND: all 11 changed docs
- FOUND commits: b4bb880, 490301d, a912650 (on `fix/data-health-run-dispatch`, `origin/main..HEAD`)
- `git status --short`: only the untracked `.planning/quick/260929-nwm-*` directory

## Review and follow-ups (orchestrator, after execution)

- **Independent re-verification:** typecheck, lint and the targeted suites re-run by the orchestrator, plus three mutation probes that each turned the new tests red (delete a dispatch branch → 2 failures; add an unrouted registry key → TS1360 on the `satisfies` table + 2 failures; delete the refusal guard → 1 failure).
- **Rebased** onto origin/main `7788eaf` (6 upstream commits, no overlapping files); the task commit SHAs above are post-rebase.
- **Independent code review** (code-reviewer): REQUEST CHANGES on one major finding, then APPROVE WITH NITS after the follow-ups below.
  - **M1 (major):** the Data Health `unearned_revenue` run bypassed that feature's DB-backed `access_manager` grant, which its own `POST /api/unearned-revenue/sync` retry requires. Fixed in the run route (403 "Unearned Revenue access manager capability required"), mirroring the post-class gate, with two route tests.
  - **m1:** `line_backlog_recovery` (a bulk write that used to be curl-only) is now `dangerous: true` with a confirmation label.
  - **m2:** `manuallyRunnableCronJobs()` now builds the dashboard's Run buttons; it is tested with every feature on and off, and run-job.test checks every offered key dispatches.
  - **m3:** a cron-audit test pins that a thrown handler becomes a `500` `{error}` with a `failed` invocation, which six branches rely on.
  - **Nits:** the route refuses an excluded job before the confirmation prompt; `manualRunDisabledReason !== undefined` semantics with a non-empty-reason test; `progress_tests_digest` is now `dangerous: true`; each reminder key is tested with its own checkpoint; stale line citations in edited sentences became file-level links; status-code rows completed; label wording made exact.
- **Follow-up commits:** `d614b53` (code + tests), `a6cb16f` (docs), `07a2b99` (label/message wording, stale citations), plus a later docs commit correcting two remaining "no Data Health backfill branch" claims (`docs/features/post-class-feedback.md`, `docs/reference/api/post-class-feedback.md`) found while planning quick 260929-rcx.
- **Final verification:** typecheck exit 0; lint 0 errors (the same 18 pre-existing warnings, none in changed files); full `npm test` 484 files / 5619 tests on the rebased tree; run-job.test 50, run route 10, cron-registry 9, cron-audit 9.
- **Owner-note deltas:** the Unearned Revenue Run button needs that feature's `access_manager` grant; LINE Backlog Recovery and Progress Tests Digest now ask for confirmation; Student Promotions is refused before any confirmation prompt.
- **Threat T-nwm-08 (Data Health bypassing a feature capability grant):** mitigated for `unearned_revenue`; post-class was already gated. The other newly runnable jobs belong to features with page-level access only (progress-tests scope, LINE, admissions roles) or no in-app trigger (sit-ins, whose worker returns counts only) — accepted.
- **Filed separately, not in this branch:** the pre-existing `post_class_feedback` Data Health branch skips the AI-review and deduction-hygiene passes its cron runs; every paused job's health detail says "Automatic credit alerts are paused"; the watchdog's synthetic rows invert `canRunManually`.
