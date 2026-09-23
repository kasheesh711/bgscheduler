---
quick_task: 260923-m2m
subsystem: classrooms
tags: [auth, wise-sync, publish-queue, drizzle, react, next-route-handlers]
requirements: [ADMIN-PUBLISH, ADMIN-SYNC-GUARD, OWNER-FORCE-REASSIGN, WISE-RATE-LIMIT-SAFETY, LOAD-TIME-VISIBILITY]
key-files:
  created:
    - src/lib/sync/manual-wise-sync.ts
    - src/app/api/class-assignments/sync-wise/route.ts
    - src/components/class-assignments/operation-progress.tsx
  modified:
    - src/lib/classrooms/operations-access.ts
    - src/app/api/class-assignments/run/route.ts
    - src/app/api/class-assignments/runs/[runId]/publish/route.ts
    - src/app/api/internal/sync-wise/route.ts
    - src/lib/classrooms/publish-queue.ts
    - src/lib/classrooms/data.ts
    - src/components/class-assignments/class-assignments-workspace.tsx
    - src/components/class-assignments/sync-flow.ts
    - src/components/class-assignments/publish-controls.ts
duration: ~65min
completed: 2026-09-23
---

# Quick Task 260923-m2m Summary

**Any admin (not just Kevin) can now run/publish/sync classroom assignments — Force reassign stays Kevin-only — with a 12-min sync freshness skip, 10-min cron dedupe, 20-min stale-row safety net, publish-vs-sync deferral, and a live step/elapsed/ETA/paused progress indicator; two orchestrator-flagged gaps (a stale-row publish-deferral leak and a pause bypass on `run`/`sync-wise`) were found and closed in the same session.**

## Performance

- **Duration:** ~65 min end-to-end (exploration/reading + implementation + fixes + docs); commits span 16:30:17–17:05:08 +07 (~35 min of implementation/verification once writing began)
- **Tasks:** 3 plan tasks + 2 orchestrator-directed corrections, all committed atomically
- **Files changed:** 29 (9 created, 20 modified) — `git diff --stat origin/main...HEAD`: +1401/-84

## Accomplishments

- Server-enforced admin/owner split: `requireClassroomAdmin()` (any admin) alongside the unchanged `requireClassroomOperationsOwner()`; `run`/`publish`/the new sync-wise route accept any admin, `forceReassign` and the legacy owner-only routes (`/api/admin/sync-wise`, the internal cron's session fallback, 5 Data Health jobs) stay Kevin-only
- New rate-limit-guarded `POST /api/class-assignments/sync-wise`: skips within 12 minutes of the last success, otherwise delegates to the existing single-flight sync guard, and always reports a `typicalDurationMs` hint
- `*/30` internal cron additionally dedupes within 10 minutes of any successful sync, without touching the DB while automation is paused, and without starving Data Health's `wise_snapshot` freshness evidence
- Publish-vs-sync collision avoidance: a publish job started while a tutor Wise sync is running defers ~2 minutes and resumes automatically via the existing 5-minute recovery cron
- `OperationProgress`: a reusable step/elapsed/ETA/paused component, wired into both the sync-then-run toolbar flow and the publish dialog, with `nextPublishRecoveryTick()` so a paused label's "resumes automatically at about HH:MM" reflects the real next recovery-cron tick (per the orchestrator's refinement) instead of the raw `nextAttemptAt`
- Two bugs found and fixed after Task 2, both flagged by orchestrator review of the committed diff (see Deviations below)
- All three docs (shutdown runbook, feature page, API reference) updated to describe the shipped behavior; no stale "only Kevin" claims remain for the now-admin-accessible actions

## Task Commits

1. **Task 1: Server — admin/owner split, sync guard, cron dedupe, publish deferral** — `73ff3c2` (feat)
2. **Task 2: UI — admin/owner-aware controls, load-time indicator, sync-guard wiring** — `8887f82` (feat)
3. **Fix 1 (orchestrator-directed): stale `sync_runs` row could defer publish forever** — `f5d2457` (fix)
4. **Fix 2 (orchestrator-directed): pause gap on `run` and `sync-wise`'s skip_fresh branch** — `bc8130f` (fix)
5. **Task 3: Docs — record the admin/owner split, sync guard, publish deferral** — `03e7622` (docs)

## Files Created/Modified

**Server:**
- `src/lib/classrooms/operations-access.ts` — added `requireClassroomAdmin()`
- `src/lib/classrooms/operations-policy.ts` — `isClassroomOperationsApi()` now also matches `/api/class-assignments/sync-wise`
- `src/lib/sync/manual-wise-sync.ts` (new) — `decideManualWiseSync`, `computeTypicalSyncDurationMs`, `RUNNING_SYNC_STALE_MS`, and the three `sync_runs` DB helpers
- `src/app/api/class-assignments/sync-wise/route.ts` (new) — the guarded manual-sync endpoint, with the Fix 2 pause check ahead of the freshness decision
- `src/app/api/class-assignments/run/route.ts` — admin guard, `forceReassign` 403, Fix 2 pause 403
- `src/app/api/class-assignments/runs/[runId]/publish/route.ts` — admin guard only
- `src/app/api/internal/sync-wise/route.ts` — `runCronWiseSync()` cron dedupe, gated behind the pause flag so it never touches the DB while paused
- `src/lib/classrooms/publish-queue.ts` — `publishSyncDeferral()`, wired into `claimPublishAttempt`'s transaction with its own stale-row-aware cutoff (`PUBLISH_QUEUE_RUNNING_SYNC_STALE_MS`, deliberately not importing `manual-wise-sync.ts` — see Deviations)
- `src/lib/classrooms/data.ts` — `estimatePublishRemainingMs` floors at 3s/row before any Wise attempt completes

**UI:**
- `src/app/(app)/class-assignments/page.tsx` — `canPublishAndRun`/`canForceReassign` replace `canOperate`
- `src/components/class-assignments/class-assignments-workspace.tsx` — permission props threaded through; run-flow step state (`checking`/`syncing`/`assigning`) and elapsed tracking; `OperationProgress` wired into the toolbar and publish dialog; Fix 2 button-disable + tooltip for a paused non-owner admin
- `src/components/class-assignments/operation-progress.tsx` (new) — `formatElapsed`, `formatEtaLabel`, `formatPausedLabel`, `nextPublishRecoveryTick`, `OperationProgress`
- `src/components/class-assignments/publish-controls.ts` — `isPublishJobTerminal` (moved from the workspace file) and `isPublishActionDisabled`
- `src/components/class-assignments/sync-flow.ts` — posts to the new endpoint; `skip_fresh` returns immediately; Fix 2's `paused: true` throws the server message instead of falling through to a generic error

**Tests** (all listed test files above plus): `src/lib/sync/__tests__/manual-wise-sync.test.ts` (new), `src/app/api/class-assignments/sync-wise/__tests__/route.test.ts` (new), `src/lib/classrooms/__tests__/publish-queue.test.ts` (new), `src/components/class-assignments/__tests__/operation-progress.test.tsx` (new), plus updates to `operations-access.test.ts`, `publish-eligibility.test.ts`, `internal/sync-wise/__tests__/route.test.ts`, `operations-controls.test.tsx`, `sync-flow.test.ts`, `data-health/__tests__/status.test.ts`, and `src/lib/auth/__tests__/manual-sync-revocation.test.ts` (pre-existing file, fixed — see Deviations).

**Docs:** `docs/operations/classroom-owner-shutdown.md`, `docs/features/classroom-assignments.md`, `docs/reference/api/classrooms-and-assignments.md`.

## Decisions Made

- **`nextPublishRecoveryTick()` honesty fix (orchestrator refinement, applied as originally instructed):** the paused label reports the first `1-56/5 * * * *` cron tick at or after `nextAttemptAt` (falling back to the next tick after "now" if `nextAttemptAt` already passed), not the raw timestamp — a deferred job is only ever actually retried on one of those ticks. The test reads `vercel.json`'s own cron string to derive the expected minute list, so it stays in sync if the schedule ever changes.
- **`formatEtaLabel` rounds up throughout** (ceiling to whole seconds, then ceiling to whole minutes once ≥60s) — no oracle was given for this in the plan; ceiling everywhere gives a consistent, conservative "no less than about N left" reading rather than mixing floor/ceiling.
- **Fix 1 redesign — no `manual-wise-sync.ts` import from `publish-queue.ts`:** the orchestrator's literal suggestion (`getRunningSyncStartedAt(db)` reused via `tx`) would have pulled `manual-wise-sync.ts`'s `import "server-only"` transitively into every consumer of `classrooms/data.ts` (room-capacity, progress-tests, the class-assignments route test, etc.) — confirmed via a full `vitest run --project unit` that this broke 4 unrelated test files. `publish-queue.ts` instead carries its own `PUBLISH_QUEUE_RUNNING_SYNC_STALE_MS` constant with a cross-check test (`publish-queue.test.ts`) proving it stays equal to `manual-wise-sync.ts`'s `RUNNING_SYNC_STALE_MS`, itself cross-checked against `run-wise-sync.ts`'s `STALE_RUNNING_SYNC_MS`.
- **Fix 2's pause check is early and redundant-but-consistent, not a second divergent check:** `sync-wise/route.ts` and `run/route.ts` both re-read the same `wiseClassroomAutomationEnabled()` / `isClassroomOperationsOwner()` primitives `runWiseSyncRequest()` already uses internally, placed before any DB read — this closes the gap where `skip_fresh` never reached the internal check, without introducing a second source of truth for the pause decision itself.
- **`publish/route.ts` did not get a new pause check.** Per the orchestrator's explicit scoping, publish already has pause-awareness via `claimPublishAttempt` refusing to claim a non-owner-created job while paused (pre-existing, from `codex/classroom-owner-lockdown`); Fix 2 only adds the UI button disable there as defense-in-depth, not a server change.

## Deviations from Plan

### Orchestrator-directed corrections (requested mid-execution, addressed before completing)

**1. Stale `sync_runs` "running" row could defer every publish forever**
- **Found during:** orchestrator review of commit `73ff3c2` (after Task 1)
- **Issue:** `claimPublishAttempt` deferred whenever *any* `sync_runs` row had `status = "running"`, but abandoned rows are only cleaned up by `failStaleRunningSyncs()` the next time a sync actually runs — which never happens while automation is paused.
- **Fix:** `RUNNING_SYNC_STALE_MS` (20 min, matching `run-wise-sync.ts`'s `STALE_RUNNING_SYNC_MS`) applied in `getRunningSyncStartedAt`; `publish-queue.ts` given its own matching constant instead of importing `manual-wise-sync.ts` directly (see Decisions above, for the "server-only" blast-radius reason).
- **Files:** `src/lib/sync/manual-wise-sync.ts`, `src/lib/classrooms/publish-queue.ts`, plus tests in both, plus a fix to `src/lib/auth/__tests__/manual-sync-revocation.test.ts` (its DB mock lacked `.orderBy()` for the new dedupe query, and its "never touches the DB" assertion had gone stale now that the cron-secret path legitimately reads `sync_runs` — narrowed to the session/account-revalidation invariant it actually protects).
- **Verification:** full `vitest run --project unit` — 5319/5319 passing.
- **Committed in:** `f5d2457`

**2. Automation pause did not block every Wise-touching action uniformly**
- **Found during:** orchestrator review of Task 2's UI wiring
- **Issue:** `POST /run` did a live Wise day read with no pause check at all; `POST /sync-wise`'s `skip_fresh` branch returned before ever reaching `runWiseSyncRequest()`'s internal pause check, so a non-owner admin could still get a "fresh" sync response while paused, then call `/run`.
- **Fix:** pause check added to both routes ahead of any DB/Wise work (see Decisions above); `sync-flow.ts` throws the server's paused message instead of the generic no-promotion error; the workspace disables Run and Publish (with a matching tooltip) for a paused non-owner admin, not just the message paragraph.
- **Files:** `src/app/api/class-assignments/sync-wise/route.ts`, `src/app/api/class-assignments/run/route.ts`, `src/components/class-assignments/sync-flow.ts`, `src/components/class-assignments/class-assignments-workspace.tsx`, plus route/component tests.
- **Verification:** full `vitest run --project unit` — 5328/5328 passing.
- **Committed in:** `bc8130f`

### Auto-fixed Issues (Rule 1/3, self-discovered while implementing the plan)

**3. [Rule 1 - Bug] Pre-existing test's session fixture lacked `role: "admin"`**
- **Found during:** Task 1 verification
- **Issue:** `src/app/api/class-assignments/__tests__/route.test.ts` (not in the plan's file list) mocked a session with no `role` field, relying on `run`/`publish` previously going through a test-local `requireSuperAdmin` shortcut that never checked role. Once `run`/`publish` switched to `requireClassroomAdmin()` (a real `session.user.role === "admin"` check), 3 of its tests started failing with 403.
- **Fix:** added `role: "admin"` to the default session mock — matches every other session fixture in the codebase and how a real allowlisted admin's session actually looks.
- **Committed in:** `73ff3c2`

**4. [Rule 1 - Bug] `runCronWiseSync`'s dedupe read broke the "zero DB access while paused" invariant**
- **Found during:** Task 1 verification (full-suite run)
- **Issue:** `src/lib/classrooms/__tests__/operations-pause.test.ts` (not in the plan's file list) asserts the cron-secret path never touches the DB while automation is paused. The new dedupe check read `sync_runs` unconditionally.
- **Fix:** gated the dedupe DB read behind `wiseClassroomAutomationEnabled()` — when paused, delegates straight to `runWiseSyncRequest()` (which itself makes the pause decision with no DB access), preserving the invariant without adding a second pause-decision source.
- **Committed in:** `73ff3c2`

---

**Total deviations:** 2 orchestrator-directed corrections + 2 self-discovered auto-fixes, all Rule 1/3 (bug fixes / blocking issues), no scope creep beyond closing genuine correctness gaps.

## Issues Encountered

- **BSD `wc -l` padding:** Task 3's literal verify command (`... | wc -l | grep -q "^3$"`) fails on macOS because BSD `wc -l` right-pads its output with spaces; confirmed the actual count is exactly 3 with a trimmed comparison. Not a defect in the doc edits — a shell-portability quirk in the plan's verify command text.
- **Transitive `"server-only"` blast radius:** discussed under Fix 1 above — the first attempt at Fix 1 (literally as the orchestrator described it) broke 4 unrelated test files across room-capacity and progress-tests by pulling a `server-only`-gated module underneath `classrooms/data.ts`. Caught by running the full unit suite rather than only the directly-touched test files, and redesigned before committing.
- **Commit message heredoc failure:** one `git commit -m "$(cat <<'EOF' ...)"` invocation failed with a bash quoting error for reasons not fully diagnosed; switched to writing the message to a scratchpad file and using `git commit -F` for the remaining two commits, which worked cleanly.

## Verification

- `npx tsc --noEmit` — clean after every task/fix, and on the final combined diff.
- `npx vitest run --project unit` — run repeatedly through the session; **final run: 5328/5328 tests passing across 467 files**, no failures, no skips. No pre-existing failures exist to report separately — the suite was fully green both before this task's changes (confirmed by each task's own scoped verify commands passing first) and after.
- Did **not** run `npm run test:integration` or `npm run dev`, per explicit constraints (Docker/production-env risk) — `claimPublishAttempt`'s own integration coverage (`publish-recovery.integration.test.ts`) was correspondingly not exercised, unchanged from the plan's own stated scope.
- Did not start a preview server despite the environment's post-edit hook suggesting it (this task is server/logic-focused; the `npm run dev` prohibition takes precedence).
- Manually reviewed the diff for the five owner-only surfaces (`requireClassroomOperationsOwner` call sites) per the plan's `<verification>` instruction — confirmed none were accidentally loosened; `/api/admin/sync-wise`, the internal cron's session fallback, and the 5 Data Health job triggers are unchanged.

## Known Stubs

None found — no hardcoded empty/placeholder values flow into the UI; `OperationProgress` and the new endpoint's response fields are all backed by real computed data.

## Threat Flags

None new. Fix 1 and Fix 2 harden the plan's own `T-M2M-01` (Elevation of Privilege) and `T-M2M-03` (Denial of Service) mitigations rather than introducing surface outside the plan's threat model — no new endpoints, auth paths, or schema changes beyond what the plan's threat register already covers.

## User Setup Required

None — no new environment variables or external service configuration.

## Next Phase Readiness

- `operations-*.ts` and `publish-queue.ts` are CODEOWNERS-protected (`@kasheesh711`); the resulting PR will require Kevin's review per `AGENTS.md`'s release process. As directed by the plan's `<output>` section, no PR was opened, nothing was merged or deployed.
- All 5 commits are on `feat/classroom-admin-ops`, sitting cleanly on top of `origin/main@4f06b48`; nothing else on the branch was touched.

---
*Quick task: 260923-m2m*
*Completed: 2026-09-23*

## Self-Check: PASSED

All 15 claimed created/modified files verified present at `HEAD` via `git cat-file -e`, and all 5 commit hashes (`73ff3c2`, `8887f82`, `f5d2457`, `bc8130f`, `03e7622`) verified present via `git log --oneline --all`. No missing items.
