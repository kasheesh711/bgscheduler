---
phase: quick-260929-rcx
plan: "01"
status: complete
subsystem: data-health
tags: [data-health, post-class-feedback, cron-parity, error-mapping, vitest]

# Dependency graph
requires:
  - phase: quick-260929-nwm
    provides: "Data Health manual Run dispatch for every cron-registry key (fix/data-health-run-dispatch @ bdfd79f, unpushed)"
provides:
  - "Data Health's post_class_feedback Run runs the same three post-sync passes as the cron route (AI review, notification retries, deduction hygiene) in one Promise.allSettled"
  - "Cron-identical error mapping: typed already-running error -> 409 with its message; anything else -> generic 500 without the thrown text"
  - "5 regression cases pinning pass order, per-pass { failed: true } isolation, and the instanceof/generic-500 mapping (run-job 50 -> 55)"
  - "crons.md and api/data-health.md no longer describe the old manual run"
affects: [data-health, post-class-feedback, docs/reference/crons.md, docs/reference/api/data-health.md]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "A manual Data Health branch mirrors its /api/internal/* cron body verbatim, changing only the trigger type and actor"

key-files:
  created: []
  modified:
    - src/lib/data-health/run-job.ts
    - src/lib/data-health/__tests__/run-job.test.ts
    - docs/reference/crons.md
    - docs/reference/api/data-health.md

key-decisions:
  - "The post_class_feedback branch body is the cron route's lines 21-43, re-indented by two spaces; a mechanical diff shows the sync call as the only different line"
  - "Map the 409 by instanceof PostClassFeedbackSyncAlreadyRunningError, not by message text, as the cron and the backfill branch already do"

patterns-established:
  - "Pass-parity test: distinct fixture per pass, invocationCallOrder after the sync, it.each over rejected passes -> { failed: true } in a 200"

requirements-completed: [RCX-CRON-PARITY, RCX-ERROR-MAPPING, RCX-REGRESSION-TEST, RCX-DOCS]

# Metrics
duration: 7min
completed: 2026-09-29
---

# Quick 260929-rcx: Align Data Health post-class sync Run with its cron — Summary

**Data Health's manual `post_class_feedback` Run now calls `runPostClassFeedbackSync({ triggerType: "manual", actorEmail })` and then the cron's `processPostClassAiReviews` / `processDuePostClassNotificationRetries` / `runPostClassDeductionHygiene` passes in one `Promise.allSettled`, returning `{ ok, result, ai, retries, hygiene }` with `{ failed: true }` per rejected pass. It maps errors like the cron: `instanceof` 409, otherwise a generic 500 with no driver text.**

## Performance

- **Duration:** ~7 min
- **Started:** 2026-09-29T13:00:51Z
- **Completed:** 2026-09-29T13:07:36Z
- **Tasks:** 2/2
- **Files modified:** 4

## Task Commits

1. **Task 1: pin cron parity (RED), mirror the cron route (GREEN)** — `bb49b02` `fix(260929-rcx): run the cron's post-sync passes from Data Health's post-class sync` (run-job.ts + run-job.test.ts only)
2. **Task 2: correct the two docs describing the old manual run** — `6dfd675` `docs(260929-rcx): Data Health's post-class sync now mirrors its cron's passes` (crons.md + api/data-health.md only)

`git log --oneline bdfd79f..HEAD` shows exactly these two commits. Nothing was pushed. SUMMARY/PLAN/STATE are not committed.

## RED evidence (Task 1, observed locally, not committed)

`npx vitest run --project unit src/lib/data-health/__tests__/run-job.test.ts` → **Tests 5 failed | 50 passed (55)**. The baseline before the edits was 50/50. Exactly the 5 new cases failed:

| # | Case | Failure on the old code |
|---|------|-------------------------|
| 1 | `runs the cron's AI-review, retry and hygiene passes after the actor's manual post-class sync` | `expected "vi.fn()" to be called 1 times, but got 0 times` (the AI pass was never called) |
| 2 | `reports a rejected ai pass as { failed: true } in a 200, as the cron does` | body had 3 keys `{ ok, result, retries }`; 5 expected (no `ai`/`hygiene`) |
| 3 | `reports a rejected retries pass as { failed: true } in a 200, as the cron does` | `expected 500 to be 200` (a rejected retries pass escaped into the catch) |
| 4 | `reports a rejected hygiene pass as { failed: true } in a 200, as the cron does` | body had 3 keys; 5 expected |
| 5 | `maps post-class sync failures like its cron route, without driver detail or post-sync passes` | the 409 half passed as predicted; the 500 run returned `{ error: 'sensitive driver detail' }` (leaked the driver text) |

GREEN after the implementation: **Tests 55 passed (55)**.

## Verification (actual counts)

The Task 1 verify command was run on the Task 1 tree before commit `bb49b02` and again at final HEAD `6dfd675`, with identical results:

- `npm run typecheck`: exit 0
- `npm run lint`: exit 0, **0 errors, 18 warnings**. All 18 are pre-existing, in 16 unrelated files; `npx eslint` on the two changed files exits 0 with no output.
- `npx vitest run --project unit src/lib/data-health src/app/api/data-health src/lib/classrooms/__tests__/operations-pause.test.ts src/lib/classrooms/__tests__/operations-access.test.ts src/app/api/internal/sync-post-class-feedback src/app/api/post-class-feedback`: **14 files passed, 200 tests passed**
- run-job alone: **55/55** (the 50 existing cases are unchanged)
- Task 2 verify: `grep -c "Two behavioural differences"` → 1, `grep -c "result, ai, retries, hygiene"` → 1, the stale-phrase grep over `docs/` → no hits, `git diff --check HEAD~1` clean
- `git diff --check bdfd79f..HEAD` clean; `git status --short` shows only `.planning/quick/260929-rcx-*` untracked
- Scan of the changed files for `.only(`, `.skip(`, TODO, FIXME, HACK and placeholders: **none**
- No logging added (no `console.*` in the diff); no files touched under `src/app/api/internal/**` or `src/app/api/post-class-feedback/sync/route.ts`

## Files Modified

- `src/lib/data-health/run-job.ts`: two imports (after `runCronWatchdog`). The `post_class_feedback` body is now the cron route's lines 21-43, including the three-line hygiene comment; only the sync call differs. The JSDoc, `DISPATCH_TARGETS` and every other branch are untouched.
- `src/lib/data-health/__tests__/run-job.test.ts`: `ai` and `auto-approval` mocks and imports (in path order), `PC_*` fixtures with distinct values, four `applyDefaults()` defaults, and the 5 cases above.
- `docs/reference/crons.md:670`: "Three…" becomes "Two behavioural differences…". The post-class clause is removed and the rest of the line is byte-identical (checked mechanically).
- `docs/reference/api/data-health.md:135`: the fifth cell now gives `{ok:true, result, ai, retries, hygiene}`, the per-pass `{failed:true}`, the 409 and the generic 500, with a file-level link that replaces the stale `:104-119`. The first four cells are byte-identical.

## Decisions Made

Followed the plan's locked decisions. The claim behind "Two behavioural differences" was checked in the code first: a dateless manual sync is not a backfill (`sync.ts:594-597`), so it keeps the cron's window and the 50-detail cap, and `triggerType` is otherwise only recorded (`sync.ts:609`).

## Deviations from Plan

No change to any planned behaviour, assertion or locked text. Two small test-only additions were made; both strengthen the test:

1. **Case (3)** also asserts `expect(runPostClassFeedbackSync).toHaveBeenCalledTimes(3)`. This stops the "none of the three passes is called" assertions from passing vacuously if the sync were never reached.
2. **Two one-line comments** in the test file: one on why the `PC_*` values are distinct, and one on the `"advisory lock already running"` row, which carries the phrase but is not the typed error.

**Total deviations:** 0 auto-fixes (Rules 1-3); the additive test details above. **Impact:** none on scope.

## TDD Gate

Task 1 was `tdd="true"` inside a `type: execute` plan. As the orchestrator and plan instruct, RED was observed locally (evidence above) and never committed. Tests and implementation land together in the single fix commit `bb49b02`, so there is no separate `test(...)` commit by design.

## Observations

- **Payout-lease deferral is now a 409, as in the cron.** `repository.ts:903-905` throws the typed `PostClassFeedbackSyncAlreadyRunningError` with the message "Post-class feedback sync is deferred while a payout operation holds a live lease.". The old `message.includes("already running")` check turned that into a **500** carrying the lease text. The `instanceof` mapping now returns **409** with that message, exactly as the cron route does.
- The unique-index race also maps to the typed 409: `isUniqueViolation` in `repository.ts` already checks `cause?.code === "23505"` and `pc_sync_single_running_idx`.

## Known Gaps (parity-only, not fixed)

- A rejected pass shows up only as `{ failed: true }`. The `cron_invocations` audit outcome stays `success` and neither the cron nor the manual path logs it. (No logging was added, by constraint.)
- `POST /api/post-class-feedback/sync` (the page's collect route) runs AI and retries but **not** hygiene. The orchestrator is filing this separately; that route was out of bounds here.
- Doc nuance (drift this change did not cause): the new `data-health.md:135` cell, the backfill row at `:136` and the rest of `docs/` describe the 409 only as "already running". None mention that a payout-lease deferral also returns 409 through the same typed error. The locked text was left unchanged.

## Owner Notes

- **Merge order:** merge `fix/data-health-run-dispatch` (bdfd79f) first; this branch is stacked on it. Per the plan, origin/main is now 19e6c26 (#95, autowriter-only, no overlap). That was not re-fetched here.
- No migrations and no env changes.
- The Data Health toast for a failed post-class sync now shows "Post-class feedback sync failed" instead of the driver text. A payout-lease deferral now shows as a 409 with the lease message instead of a 500.
- One click can call OpenAI for up to 10 AI reviews (`processPostClassAiReviews` default `limit` 10, idempotent per `requestHash`). It is gated only by `OPENAI_API_KEY` (`ai.ts:59-60`) and has no `ENABLE_*` flag.
- Hygiene runs on click: it only reopens and waives, never approves. It is the same code the cron runs every 30 minutes, and the run route's `access_manager` gate is unchanged.

## Threat Flags

None beyond the plan's threat model. T-rcx-01 is mitigated and asserted by case (3). T-rcx-02 to T-rcx-04 are accepted as planned. No new endpoints, auth paths or schema changes.

## Known Stubs

None.

## Self-Check: PASSED

- FOUND: src/lib/data-health/run-job.ts, src/lib/data-health/__tests__/run-job.test.ts, docs/reference/crons.md, docs/reference/api/data-health.md (each modified in `bdfd79f..HEAD`)
- FOUND: commit `bb49b02` (fix), commit `6dfd675` (docs)

## Review and follow-ups (orchestrator, after execution)

- **SHAs are post-rebase.** The base branch gained two docs commits (`bdfd79f`, `10d68b7`), and this branch was rebased onto `10d68b7`. The only conflict was the adjacent `post_class_feedback` / `post_class_feedback_backfill` rows in `docs/reference/api/data-health.md`; both edits were kept.
- **Independent re-verification:** typecheck, eslint and the targeted suites were re-run (14 files / 200 tests before the follow-ups). The full `npm test` passed with 484 files / 5624 tests. Dropping the hygiene pass from run-job.ts turns 5 tests red.
- **Independent code review** (code-reviewer): APPROVE WITH NITS. It confirmed that the parity diff with the cron is exactly one line (the manual trigger type and actor), and that the new passes are safe from a one-click trigger. AI review inserts its unique-keyed run row before calling the model; hygiene only reopens or waives, under the finance lock. Follow-ups applied:
  - **F6:** the lease-deferral 409 was untested, and a fixed "already running" message passed every test. New test `025bb16`; the mutation is now caught.
  - **F7:** the sequencing test only proved call order. It now holds the sync open and asserts that no pass starts before the sync resolves (`025bb16`); a concurrent-start mutation is now caught.
  - **F5:** docs now name the 409 for a sync deferred by a live payout lease, which the audit records as `failed`, not `skipped` (`6dfd675` conflict resolution and `7b06197`).
  - **F4:** a chosen backfill date range runs one batch at a time in-app, from the Post-Class Feedback Settings Backfill dialog. Only a multi-batch re-drain needs `CRON_SECRET`. This was corrected on the base branch in `10d68b7`, because that branch owned the wording.
- **Follow-up commits:** `025bb16` (tests), `7b06197` (docs).
- **Final:** run-job.test 56/56; typecheck 0; eslint clean.
- **Filed separately:** one shared post-class collection tick for the cron, the page sync and Data Health. The page's collect mode still skips hygiene, and there are now three hand-copied versions of the tick. The same task covers logging for rejected passes and for failures before the run row exists, which today reach neither the audit nor a log, and optionally a timeout on the OpenAI quality call.
- **Not changed (pre-existing, noted):** stale route counts and line citations near the edited text in `docs/features/post-class-feedback.md` (a docs regen will refresh them); a live-lease deferral on the cron path audits as `failed` (a policy question).
