---
phase: quick-260929-smo
plan: "01"
status: complete
subsystem: post-class-feedback
tags: [post-class-feedback, data-health, cron-parity, observability, refactor, vitest]

# Dependency graph
requires:
  - phase: quick-260929-nwm
    provides: "Data Health dispatch for every registry key (fix/data-health-run-dispatch @ 10d68b7, unpushed)"
  - phase: quick-260929-rcx
    provides: "run-job.ts post_class_feedback branch mirroring the cron (fix/data-health-post-class-run-parity @ 871cebc, unpushed)"
provides:
  - "One post-class collection tick (collection-tick.ts): runPostClassCollectionTick + runPostClassCollectionTickRequest"
  - "Cron, Data Health Run and the page's collect mode all call it; no call site keeps its own sync/pass/mapping copy"
  - "The page's collect mode (Sync button + Settings Backfill dialog) now runs deduction hygiene"
  - "Class-only failure logging for rejected passes and for sync failures on the cron/Data Health path"
  - "30s timeout on the post-class OpenAI quality-model call (separate commit)"
affects: [post-class-feedback, data-health, docs/reference/api, docs/reference/crons.md, docs/features/post-class-feedback.md, docs/operations/runbook.md, docs/OPEN-QUESTIONS.md]

tech-stack:
  added: []
  patterns:
    - "Two-layer request helper: a core function returning the body (throws on sync failure) + a *Request wrapper adding the cron's HTTP mapping, like run-sync-request.ts"
    - "Pass-through spy (vi.fn(actual.fn) via importOriginal) so parity cases keep running the real shared code while a case asserts delegation"
    - "Whoever swallows an error logs it: the core logs rejected passes, the Request layer logs the generic-500 sync failure, the page mapper logs its own"

key-files:
  created:
    - src/lib/post-class-feedback/collection-tick.ts
    - src/lib/post-class-feedback/__tests__/collection-tick.test.ts
    - src/app/api/post-class-feedback/sync/__tests__/route.test.ts
    - src/app/api/internal/sync-post-class-feedback/__tests__/route.test.ts
  modified:
    - src/app/api/internal/sync-post-class-feedback/route.ts
    - src/lib/data-health/run-job.ts
    - src/lib/data-health/__tests__/run-job.test.ts
    - src/app/api/post-class-feedback/sync/route.ts
    - src/lib/post-class-feedback/auto-approval.ts
    - src/lib/post-class-feedback/ai.ts
    - src/lib/post-class-feedback/__tests__/ai.test.ts
    - docs/reference/api/post-class-feedback.md
    - docs/reference/api/internal-crons.md
    - docs/reference/api/data-health.md
    - docs/reference/api/index.md
    - docs/reference/crons.md
    - docs/features/post-class-feedback.md
    - docs/operations/runbook.md
    - docs/OPEN-QUESTIONS.md

key-decisions:
  - "Page keeps postClassFeedbackErrorResponse: it calls the core tick inside its own try; only the cron and Data Health return the Request wrapper"
  - "Reassess mode stays unchanged: it never writes eligibility and waives the deduction on any violation it clears itself (reassess.ts:192-200)"
  - "Response contract unchanged (no failedPasses, no outcome: partial): left as a question for the owner"
  - "AI timeout written on the existing method line (repo precedent) so no ai.ts line number moves and no doc citation drifts"

requirements-completed: [SMO-ONE-TICK, SMO-CALL-SITES, SMO-DELEGATION-TESTS, SMO-OBSERVABILITY, SMO-DOCS, SMO-AI-TIMEOUT]

duration: ~75min
completed: 2026-09-29
---

# Quick 260929-smo: One shared post-class collection tick — Summary

**The post-class collection tick now lives in one place, `src/lib/post-class-feedback/collection-tick.ts`.
The cron (`{ triggerType: "cron" }`), Data Health's `post_class_feedback` Run (`{ triggerType: "manual",
actorEmail }`) and the Post-Class Feedback page's collect mode all call it. The page's collect mode (the Sync
button and the Settings Backfill dialog) therefore gains the deduction-hygiene pass it had been skipping.
Rejected passes and generic sync failures now leave a class-only log line. The OpenAI quality-model call has
a 30s timeout.**

Branch `fix/post-class-collection-tick` in worktree `/Users/kevinhsieh/Developer/Scheduling-collection-tick`,
stacked on `fix/data-health-post-class-run-parity` (871cebc) → `fix/data-health-run-dispatch` (10d68b7) →
origin/main 7788eaf. Neither base branch has reached origin/main. Nothing pushed.

## Task Commits

1. `ede804c` feat — `collection-tick.ts` + `collection-tick.test.ts` (14 cases)
2. `cee6e76` refactor — cron route, `run-job.ts`, page route wired; run-job delegation case + pass-through spy;
   new page-route test (10 cases) and cron-route test (2 cases); `auto-approval.ts` JSDoc (same line)
3. `a5f81aa` docs — 8 docs files (the 3 named + crons.md, data-health.md, index.md, runbook.md, OPEN-QUESTIONS OPS-13)
4. `253f809` fix (optional, separate) — `ai.ts` 30s `AbortSignal.timeout` + test + 3 doc sentences

## RED evidence (observed locally, not committed)

| Task | RED | GREEN |
|---|---|---|
| 1 | `collection-tick.test.ts`: file fails to import the missing module (no tests run) | 14/14 |
| 2 | run-job `dispatches post_class_feedback`: `expected "vi.fn()" to be called at least once`; new delegation case fails; page route: 3 cases fail (tick never called); cron route test: `Cannot find package 'server-only' imported from …/ai.ts` (old route imported the passes directly) — 5 failed / 62 passed + 1 load failure | affected dirs 49 files / 690 tests; run-job 57/57 |
| 4 | `expected "timeout" to be called with arguments: [ 30000 ]` (1 failed / 3 passed) | 4/4 |

**Mutation checks** (each applied, run, reverted, `cmp`-verified): helper — no pass log (5 fail), message logged
instead of class (5), passes started before the sync resolves (8), 409 branch removed (2), sync log removed (4),
500 echoes the message (3), hygiene dropped (7). Wiring — tick drops hygiene ⇒ 5 **existing** run-job parity
cases fail (proves they run the real tick), run-job wrong trigger (2), page drops `actorEmail` (3), cron wrong
trigger (1).

## Verification (final HEAD 253f809)

- `npm run typecheck`: exit 0
- `npm run lint`: exit 0, 0 errors, 18 warnings — all pre-existing, in 16 unrelated files (same count as base)
- `npm test`: **487 files / 5653 tests passed**
- `npm run test:integration` (Docker, testcontainers): **37 files / 507 tests passed**
- `git diff --check 871cebc..HEAD`: clean; every new/edited doc citation checked against the code line it names
- No `.only`, `.skip`, TODO, FIXME or placeholder in changed files

## Decisions

- **Two layers.** `runPostClassCollectionTick(options)` returns `{ ok, result, ai, retries, hygiene }` and lets a
  sync error propagate; `runPostClassCollectionTickRequest(options)` adds the cron's mapping (typed 409 with its
  message, otherwise fixed 500). The page calls the first inside its own try, so `postClassFeedbackErrorResponse`
  still maps its errors (an already-running sync is still a generic 500 there — documented, unchanged).
- **Options** = required `triggerType` + `actorEmail`/`detailCap`/`startDate`/`endDate` picked from
  `SyncPostClassFeedbackOptions`; reminder-checkpoint fields excluded. Passed to the sync unchanged, so the
  cron/Data Health sync calls are identical to before.
- **Logging** `console.error("[post-class-collection-tick]", { pass, errorName })`, `errorName` = `error.name` or
  `"UnknownError"` (the api.ts idiom). Core logs each rejected pass; the Request layer logs the generic-500 sync
  failure (covers failures before the run row exists); the typed 409 is not logged; the page's sync failures are
  logged once, by its own mapper.
- **Reassess needs no hygiene.** Hygiene waives `pending_review` deductions on `eligible = false` sessions and
  reopens approved, unwritten deductions whose evidence no longer supports a charge. Reassess never writes
  eligibility and, when it clears a violation, waives that session's pending or approved unwritten deduction
  itself (`waiveClearedDeduction`; `actions.ts` allows waive from approved). A waive that throws is counted in
  `failed`; the next cron tick (≤30 min) or the accrual sweep before any payout preview reopens it before money moves.
- **AI timeout on one line** (`method: "POST", signal: AbortSignal.timeout(30_000),`), as in
  `leave-requests/normalization.ts` and `progress-tests/workspace/ai.ts`, so ~15 accurate `ai.ts:NN` citations stay valid.

## Deviations from Plan

1. **Also updated `docs/operations/runbook.md`** (not in the plan's list): it cited the old cron `route.ts:13`,
   `:39-42` and `:42`, and it is where ops look for the post-class error trail, so it now describes the
   `[post-class-collection-tick]` lines.
2. **Corrected my own first draft of the timeout docs.** The limit of 10 counts only *successful* reviews
   (`ai.ts:204`) and a batch loads `limit * 4` = 40 rows (`ai.ts:146`). The first draft claimed a ~300s cap. The
   committed docs say a sustained stall can still try every suspect version among the 40, 30s each.
3. Numbered `run-job.ts:NN` citations elsewhere in docs were already stale on the base branch (run-job grew from
   ~210 to 388 lines in 260929-nwm) and are left for the docs regeneration.

## Observations / follow-ups (not changed)

- **Owner decision (2026-09-29): keep log-only.** The tick body stays `200` with `{ failed: true }` per rejected
  pass, and the audit stays `success`. There is no `failedPasses` and no `outcome: "partial"`, which the audit
  would map to `failed`, turning Data Health red. Rationale: an OpenAI outage does not reject the AI pass
  (model errors are caught per review), and a failed hygiene pass cannot move money. The payout sweeps re-run
  hygiene before every preview, and publishing refuses unproven approvals.
- **AI pass bound:** failed model calls don't count toward the batch limit, so a sustained stall can still spend
  up to 40 × 30s in one tick, and a failed AI run is never retried (the candidate query excludes any version with
  a run row). A pass-level deadline or an attempts cap would close it.
- **Timeout trade-off:** a slow (>30s) but successful model call now fails that version's advisory review for
  good (same permanence as any model error today). AI review never affects compliance or deductions.
- **Page quirk kept:** an already-running sync is a 500 "Could not sync post-class feedback." on the page (its
  mapper lacks the typed error), a 409 on the cron and Data Health.
- **Backfill cron** (`post-class-feedback-backfill`) runs no post-sync passes; the next collection tick (≤30 min)
  does. The page's Backfill dialog now runs them.
- Hygiene's per-candidate catches (`[post-class-auto-reopen]`, `[post-class-ineligible-waive]`) log the whole
  error object — pre-existing, outside this change.

## Owner Notes

- **Merge order:** `fix/data-health-run-dispatch` → `fix/data-health-post-class-run-parity` → this branch.
- `src/app/api/internal/` is CODEOWNERS-protected (cron route + its new test): Kevin reviews. Money-adjacent:
  open any PR as **draft** until review is done.
- No migrations, no env changes, no schema changes, no new routes.
- After deploy: the page's Sync/Backfill buttons also run hygiene (release-only: reopen/waive, never approve,
  under the finance lock), the same code the cron runs every 30 minutes.

## Review and follow-ups (orchestrator, after execution)

- **Independent code review** (code-reviewer, opus, read-only on the worktree): **APPROVE WITH NITS**. There
  were 0 CRITICAL/HIGH/MEDIUM findings, 5 LOW and 6 NIT, and one low-confidence question (is 30s the right
  timeout?). Its own checks: full unit 487/5653, tsc 0, mutations (passes started early → 11 fail, raw error
  logged → 4, signal detached → 1), and Node 22 confirmation that `AbortSignal.timeout` also aborts a stalled
  body read.
  - It confirmed that the cron and Data Health match 871cebc byte for byte: statuses, body key order, pass
    sequencing, sync options, audit outcomes, and `HANGING_PROMISE_REJECTION` handling.
  - It confirmed that adding hygiene to the page is safe, that there is no double logging, and that reassess
    needs no hygiene.
- **Applied:**
  - `6d68cb4`: the run-job console spy is scoped to the two post-class cases that log, which now assert the
    class-only lines; `vi.restoreAllMocks()` runs in afterEach. The tick's comments no longer say "only
    record/trace" (same line counts, so every citation still holds).
  - `aaccbe7`: route-test counts updated (post-class 3/13, internal 5/14). Stale citations on the rewritten
    doc lines fixed: auto-approval 279-302/34-37/:99/:237, repository 377-382, sync 1089-1104 and 99-118,
    notifications 1108-1114. The AI worst case is stated (40 × 30s, past 800s; failed reviews never retried),
    the `pass: "sync"` wording is softened (the class is often a plain `Error`), and the reassess note names
    the real backstop: the accrual/finalize hygiene sweeps (`payout-accrual.ts:149`, `:286`) and the
    unproven-approval publish gate (`payout-plan.ts:104`).
- **Not applied (follow-ups):**
  - AI pass budget: a pass-level deadline or a consecutive-failure breaker, plus a retry for failed runs.
  - The older raw-error `console.error(tag, error)` calls in `auto-approval.ts:110,172,244` and
    `reassess.ts:216`, which the page's collect mode now also reaches.
  - A NIT that any escaped error is labelled `pass: "sync"`. Kept for exact cron parity: the old cron
    serialized inside the same try.
  - `{ failed: true }` vs a numeric `failed`: the shape is unchanged; the owner chose to keep it (log-only).
  - Hygiene actions started from the page run under system actors. The sync run row records the human actor.
- **Final:** HEAD `aaccbe7`. typecheck 0, lint 0 errors / 18 pre-existing warnings, `npm test` 487 files /
  5653 tests, affected suites 49 files / 691 tests, integration 37 files / 507 tests (run at `253f809`; the
  commits after it only touch a test file, comments and docs).

## Self-Check: PASSED

- FOUND: all created/modified files above in `git diff --name-only 871cebc..HEAD`
- FOUND: commits ede804c, cee6e76, a5f81aa, 253f809, 6d68cb4, aaccbe7
