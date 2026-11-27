---
phase: quick-260929-rta
plan: "01"
status: complete
subsystem: data-health / cron watchdog
tags: [data-health, cron-registry, cron-watchdog, paused-jobs, fail-closed, vitest, tdd]

requires:
  - phase: origin/main 19e6c26
    provides: effectiveCronJob pause labels (cron-registry.ts:515-519), the paused arm of evaluateCronJobStatus, the watchdog's two synthetic health rows
provides:
  - private pausedHealthDetail(job) in src/lib/data-health/status.ts, used by the paused arm of evaluateCronJobStatus
  - unconditional canRunManually false on payoutWindowJobHealth and deadlineCoverageJobHealth (src/lib/internal/cron-watchdog.ts)
affects: [data-health dashboard (job.healthDetail column), cron watchdog synthetic rows, DEF-3 branch (edits cron-registry.ts; untouched here)]

tech-stack:
  added: []
  patterns:
    - "A paused job's health detail comes from the effective job's cadenceLabel, so effectiveCronJob stays the single source of truth for why a job is paused"
    - "Synthetic (non-registry) health rows hard-code canRunManually false (fail-closed) instead of inheriting it from a source definition"

key-files:
  created: []
  modified:
    - src/lib/data-health/status.ts
    - src/lib/data-health/__tests__/status.test.ts
    - src/lib/internal/cron-watchdog.ts
    - src/lib/internal/__tests__/cron-watchdog.test.ts

key-decisions:
  - "The paused-job detail reads `${effective cadenceLabel}; no run is expected until it is re-enabled.`; the LINE credit digest keeps its original sentence because pausing it retains saved preferences (locked in the plan)"
  - "pausedHealthDetail receives the effective job (status.ts effectiveCronJob result), never input.job, whose cadenceLabel is schedule text"
  - "cron-registry.ts is not edited (CODEOWNERS plus the unpushed DEF-3 branch); the fix lives entirely in status.ts and cron-watchdog.ts"

patterns-established:
  - "Tests that need a registry definition to be missing or manual-only use a vi.hoisted mode switch plus a partial vi.mock of @/lib/data-health/cron-registry (mirrors deadline-coverage.test.ts)"

requirements-completed: [RTA-PAUSED-DETAIL, RTA-SYNTHETIC-NO-RUN]

duration: 11min
completed: 2026-09-29
---

# Quick 260929-rta: Paused jobs state their own reason on Data Health Summary

**Each paused Data Health job now shows its own `effectiveCronJob` reason (for example "Paused by owner; no run is expected until it is re-enabled."). Only the LINE Credit Digest still shows the credit-alert sentence. Both of the watchdog's synthetic rows now hard-code `canRunManually: false`.**

## Performance

- **Duration:** ~11 min
- **Started:** 2026-09-29T13:15:55Z
- **Completed:** 2026-09-29T13:27Z
- **Tasks:** 2/2
- **Files modified:** 4 (exactly the plan's `files_modified`)
- **Worktree / branch:** `/Users/kevinhsieh/Developer/Scheduling-paused-detail`, `fix/data-health-paused-detail`, based on `19e6c26`
- **Toolchain:** Node v22.22.2 (the orchestrator's PATH). CI uses Node 24.

## Task Commits

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Paused jobs state their own reason (status.ts) | `4087a00` fix(260929-rta): say why each paused job is paused on Data Health | `src/lib/data-health/status.ts`, `src/lib/data-health/__tests__/status.test.ts` |
| 2 | Synthetic watchdog rows never offer a Run action (fail-closed) | `52cc174` fix(260929-rta): synthetic watchdog rows never offer a Run action | `src/lib/internal/cron-watchdog.ts`, `src/lib/internal/__tests__/cron-watchdog.test.ts` |

Both messages are the subject, a blank line, then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Each commit stages explicit paths only and contains no deletions. Nothing is pushed, no PR is open, and nothing is deployed.

## RED Evidence (observed locally, never committed)

**Task 1:** `npx vitest run --project unit src/lib/data-health/__tests__/status.test.ts` gave **4 failed | 9 passed (13)**. The failing tests are exactly the 4 new `it.each` rows:
- `wise_snapshot` and `classroom_morning`: Expected "Paused by owner; no run is expected until it is re-enabled.". Received "Automatic credit alerts are paused; saved preferences are retained." (Vitest grouped these two identical failures under one diff.)
- `feedback_autowriter`: Expected "Feedback autowriter disabled; no run is expected until it is re-enabled.". Received the credit sentence.
- `tutor_sit_ins`: Expected "Tutor Sit-ins disabled; no run is expected until it is re-enabled.". Received the credit sentence.
- The extended `line_credit_digest` assertion passed in RED, as intended: it guards the sentence that must be kept.

**Task 2:** `npx vitest run --project unit src/lib/internal/__tests__/cron-watchdog.test.ts` gave **2 failed | 32 passed (34)**:
- `never offer a Run action when the source definition is missing`: `expected true to be false` at the `payoutWindowJobHealth(...)` assertion.
- `... is manual-only`: `expected true to be false` at the same assertion.
- The `actual` row and all 31 pre-existing tests passed.
- The RED test stops at the payout assertion, so a transient probe (created and deleted in one command) asserted only `deadlineCoverageJobHealth` under the same mock. `actual` passed, while `missing` and `manual-only` failed with `expected true to be false`. Both builders were fail-open before the fix.

## GREEN / Final Verify Counts

| Gate | Result |
|------|--------|
| Baseline at 19e6c26 (before any edit) | typecheck exit 0; lint exit 0 (0 errors, 18 warnings); Task 2 Vitest scope 11 files / 79 tests passed |
| Task 1 verify (`npm run typecheck && npm run lint && npx vitest run --project unit src/lib/data-health/__tests__/status.test.ts`) | typecheck exit 0; lint exit 0 (0 errors, 18 warnings, output byte-identical to baseline); **13/13 passed** (9 existing + 4 new) |
| Task 2 verify (`npm run typecheck && npm run lint && npx vitest run --project unit src/lib/data-health src/lib/internal src/components/data-health src/app/api/data-health`) | typecheck exit 0; lint exit 0 (0 errors, same 18 warnings, identical to baseline); **11 files / 86 tests passed** (79 baseline + 4 + 3) |
| cron-watchdog.test.ts alone | **34/34 passed** (31 existing + 3 new) |
| Full unit suite (`npm test`) | **483 files / 5,568 tests passed**, exit 0 |

The 18 lint warnings are pre-existing and none of them is in the 4 files this plan touches.

### Plan `<verification>` block

- `git log --oneline 19e6c26..HEAD` lists exactly `52cc174` and `4087a00`, both `fix(260929-rta)`.
- `git show --stat --format= HEAD~1` lists only the 2 status files. `HEAD` lists only the 2 watchdog files.
- `grep -c "manualOnly ?? true" src/lib/internal/cron-watchdog.ts` returns **0**. `grep -c "canRunManually: false"` returns **2**.
- `git diff 19e6c26 --stat -- src/lib/data-health/cron-registry.ts` is **empty**.
- `git status --short` shows only `?? .planning/quick/260929-rta-fix-misleading-paused-job-text-on-data-h/`, which holds the PLAN and this SUMMARY.

### Must-have truths

1. **Every paused job except the LINE Credit Digest shows `<effective cadenceLabel>; no run is expected until it is re-enabled.`** This holds. The 4 committed rows cover it, and a transient registry-wide sweep probe (created, run and deleted in one command) checked all of `CRON_JOBS` with every pause switch off. Exactly 9 jobs are paused:
   - `wise_snapshot`, `classroom_morning`, `classroom_publish_recovery`, `classroom_admin_email` and `classroom_weekend_check` show "Paused by owner; …".
   - `feedback_autowriter` shows "Feedback autowriter disabled; …".
   - `tutor_sit_ins` and `tutor_sit_ins_digest` show "Tutor Sit-ins disabled; …".
   - `line_credit_digest` shows the credit sentence.
   - None of the 8 non-credit details contains "credit".
2. **The credit digest's sentence and the manual-only / not-yet-activated texts are unchanged.** This holds. The extended committed assertion pins the credit sentence. The sweep probe confirmed `room_utilization` still shows "Not listed in vercel.json; runs only from manual controls.", and `classroom_weekend_check` (automation enabled, `CLASSROOM_WEEKEND_ALERTS_ENABLED_AT` unset) still shows "Weekend alerts have not been activated.".
3. **Both synthetic rows return `canRunManually: false` whether the source definition is actual, missing or manual-only.** This holds; the 3 committed `it.each` rows cover it.
4. **Key link:** status.ts contains `pausedHealthDetail(job)` and passes it the effective `job` from `effectiveCronJob(input.job)`. The dashboard renders it as `job.healthDetail` at `data-health-dashboard.tsx:219` (no change needed there).

## Deviations from Plan

None. The plan was executed as written, and every planned code line and assertion matched the real code at 19e6c26. The plan left two details to me: the wording of the one-line mock comment and the `it.each` test titles.

**Workflow notes (not plan deviations):**
- **TDD gate:** the plan and orchestrator say RED is observed locally and never committed. So each task is one `fix(...)` commit containing both test and implementation, and there is no separate `test(...)` commit by design. The RED evidence is recorded above.
- **Transient probes:** three probe test files were created, run and deleted, each within a single shell command: a baseline stderr check, the deadline-builder RED check, and the registry-wide sweep. None remains in the tree or in git.
- **Executor state updates skipped:** the orchestrator said not to update or commit STATE.md or ROADMAP.md, so no `gsd-sdk` state, roadmap or requirements calls were made. `requirements-completed` above lists both IDs for the orchestrator.

## Threat Model Disposition

| Threat | Disposition | Outcome |
|--------|-------------|---------|
| T-rta-01 (I), status.ts pausedHealthDetail | accept | The detail echoes only static `cadenceLabel` constants from `effectiveCronJob`, never env values. Paused jobs are not alertable (`paused` is not in `ALERTABLE_STATUSES`), so this text never reaches the watchdog email. |
| T-rta-02 (E), cron-watchdog.ts synthetic rows | mitigate, **applied** | `canRunManually: false` is unconditional on both rows, with the plan's fail-closed comment. The Task 2 tests pin it for all three source-definition states. |

No new security surface beyond the threat model.

## Known Stubs / Scan

- The scan of all 4 changed files, both added lines and whole files, found no `.only(`, `.skip(`, `xit(`, `xdescribe(`, TODO, FIXME, HACK, "placeholder", "coming soon" or "not implemented". `git diff --check 19e6c26..HEAD` is clean.
- No stubs.

## Out-of-scope Observations (not fixed)

- **Pre-existing stderr noise in cron-watchdog.test.ts.** Tests that do not inject `loadPayoutWindow` / `loadDeadlineCoverage` let the real loaders hit the fake db. With `--reporter=verbose` that prints 10 "could not evaluate payout window staleness" and 15 "could not evaluate feedback deadline coverage" `console.error` lines. The pristine 19e6c26 file produces exactly the same output (31/31 passing), so this change did not introduce it. It is harmless but noisy. A follow-up could inject `loadPayoutWindow(null)` / `loadDeadlineCoverage(null)` in those tests or spy on `console.error`.
- The 18 repo-wide lint warnings are pre-existing and none is in this plan's files.

## Owner Notes (Kevin)

- **Review:** `src/lib/internal/` is CODEOWNERS-protected, so commit `52cc174` needs Kevin's review when a PR is opened. `status.ts` is not protected.
- **Runtime effect:**
  - Task 1 changes what Data Health says for every paused job. Which rows are paused in production depends on the live values of `WISE_CLASSROOM_AUTOMATION_ENABLED`, `FEEDBACK_AUTOWRITER_ENABLED`, `TUTOR_SIT_INS_ENABLED` and `CREDIT_CONTROL_MODE`; I did not check production.
  - Task 2 does not change behavior today. Both source jobs are registered with `manualOnly: false`, so both rows already returned `false`. The change removes the fail-open path, where a missing definition returned `true`, and the wrong-field path, where a manual-only definition returned `true`. No non-test code reads `canRunManually` from these rows.
- **The pause labels are now user-facing detail text.** The strings "Paused by owner", "Feedback autowriter disabled" and "Tutor Sit-ins disabled" in `effectiveCronJob` now also drive Data Health's detail column, and the Task 1 test pins all three. If the DEF-3 branch or a later change renames one, that test fails on purpose, and the new label is shown automatically once the test is updated.
- **DEF-3 compatibility:** this branch does not touch `cron-registry.ts`, so no textual conflict with DEF-3 is expected.
- **Before opening a PR:** origin/main was `19e6c26` when this was planned. Fetch and diff against `origin/main` rather than local `main`, and rebase if it has moved.

## Self-Check: PASSED

- The 4 modified files exist and contain the changes: `pausedHealthDetail(job)` appears in status.ts, and `canRunManually: false` appears ×2 in cron-watchdog.ts.
- Commits `4087a00` and `52cc174` are on `fix/data-health-paused-detail`, in `19e6c26..HEAD`.
- `cron-registry.ts` is unchanged against 19e6c26. The working tree is clean apart from the untracked quick-task directory.

## Review and follow-ups (orchestrator, after execution)

- **Independent re-verification:** typecheck, eslint and the targeted suites were re-run (11 files / 86 tests). The full `npm test` passed with 483 files / 5568 tests. Restoring the old credit sentence for every paused job turns 4 status tests red.
- **Independent code review** (code-reviewer): APPROVE WITH NITS. The reviewer's probe confirmed that exactly 9 jobs pause today and each renders the right sentence. It also confirmed that `effectiveCronJob` is idempotent (the dashboard applies it twice), that `canRunManually: false` is the only truthful value for the non-dispatchable synthetic keys, and that the registry mock is transparent by default. Follow-ups applied:
  - **M1:** a new registry-wide test walks every job `effectiveCronJob` pauses and asserts each pause sets its own reason label rather than falling back to the schedule text. A pause branch without a label is now caught (probe: the autowriter pause without its label fails 2 tests).
  - **N1:** the wording is now `"<reason>; scheduled runs are skipped until it is enabled."`. Paused crons still fire and are audited as `skipped`, and Tutor Sit-ins may never have been enabled, so "no run is expected until it is re-enabled" was imprecise.
  - **N2:** the helper comment names the credit digest as the exception to the registry-supplied reason.
  - **N3:** the watchdog registry switch now resets after every test in the file; each synthetic row has its own cases; the switch comment is accurate.
- **Follow-up commits:** `43cfb3c` (status wording + registry-wide test), `dbac494` (watchdog test hygiene).
- **Final:** 11 files / 90 tests in the targeted suites; typecheck 0; eslint clean.
- **Not changed (noted):** the `paused` status itself is undocumented in docs/reference/api/data-health.md and docs/features/data-health.md (pre-existing gap; those files are heavily edited on the unpushed `fix/data-health-run-dispatch` branch, so a row added here would conflict). A dedicated `pauseReason` registry field would be cleaner than reusing `cadenceLabel`, but `cron-registry.ts` is CODEOWNERS-protected and edited by that branch.
- **Merge:** independent of the other two Data Health branches (different files). origin/main has since moved to `c62e81c` (autowriter-only, no overlap).
