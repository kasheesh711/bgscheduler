---
quick_id: 260730-fwu
plan: 1
subsystem: post-class-feedback
tags: [drizzle, postgres, google-sheets, payout, vitest, cron]

# Dependency graph
requires:
  - phase: feat/payout-runs-publish (#47, merged)
    provides: durable payout run lifecycle (leases, source fingerprint, CSV,
      exceptions, close/roll gates) that this plan builds on
provides:
  - durable per-row source-anchor fingerprint replacing the O(written-lines)
    re-match search, with per-tutor quarantine instead of a whole-pass abort
  - auto-approval and reopen sweep (runPostClassAutoApprovalSweep)
  - accrual mode (mode: "accrual") on publishPayoutRun + skipCsv on
    finalizePayoutRunPass
  - runPayoutAccrualPass / runPayoutFinalizePass and their parked route +
    cron-registry entry
affects: [payroll, post-class-feedback rollout gates, credit-control (shares
  the finance-lock/withPostClassTransaction pattern conceptually, no code
  overlap)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "System actor object literal ({ email: 'system:...', name: '...' })
      passed to existing reviewer/finance action functions instead of a new
      auth path"
    - "mode?: 'operator' | 'accrual' parameter widening an existing function
      with a fully backward-compatible default, gated entirely behind one
      new branch per call site"
    - "Conditional object spread for a DB .set() (...(condition ? {} : {
      fields })) to leave columns completely untouched rather than
      rewriting them to a neutral value"

key-files:
  created:
    - src/lib/post-class-feedback/auto-approval.ts
    - src/lib/post-class-feedback/payout-accrual.ts
    - src/app/api/internal/post-class-feedback/payout-accrual/route.ts
    - drizzle/0061_payout_line_source_anchor.sql
    - src/lib/post-class-feedback/__tests__/auto-approval.integration.test.ts
    - src/lib/post-class-feedback/__tests__/payout-accrual.integration.test.ts
  modified:
    - src/lib/db/schema.ts
    - src/lib/post-class-feedback/payout-master.ts
    - src/lib/post-class-feedback/payout-repository.ts
    - src/lib/post-class-feedback/payout-run.ts
    - src/lib/data-health/cron-registry.ts
    - src/lib/post-class-feedback/__tests__/payout-run.integration.test.ts
    - src/lib/post-class-feedback/__tests__/migration.test.ts
    - docs/features/post-class-feedback.md
    - docs/reference/crons.md
    - drizzle/meta/_journal.json

key-decisions:
  - "Fixed a tautological window guard in runPayoutFinalizePass discovered
    while writing its own test: it must resolve now's own Bangkok calendar
    month directly (payoutRunWindow(bangkokDate.slice(0,7))), not the
    roll-forward 'window containing now' (payoutRunWindowForBangkokDate),
    which by construction always satisfies now <= windowEnd and would have
    made finalize permanently unreachable"
  - "runPayoutAccrualPass/runPayoutFinalizePass default dependencies.now
    from their own now parameter when the caller doesn't supply one, so the
    pass's simulated clock and publishPayoutRun's internal clock can't
    silently disagree -- zero effect in production (both already resolve to
    real Date.now() a few ms apart), matters only for deterministic tests"
  - "recordPayoutAnchorMissingException accepts canonicalTutorKey for a
    self-documenting call site even though postClassPayoutExceptions has no
    tutor column to persist it to -- matches the plan's literal wrapper
    signature over upsertPayoutExceptionRecord"

patterns-established:
  - "Quarantine-not-abort: a per-tutor Map<canonicalTutorKey, reason> built
    once per pass, checked per pending line, replacing a single run-wide
    boolean error flag that used to fail every pending line in the run"

requirements-completed:
  - P0-source-anchor-fingerprint
  - P1-auto-approval
  - P2-accrual-pass
  - P3-auto-finalize
  - P4-route-and-registry
  - P5-tests
  - P6-docs

duration: ~45min
completed: 2026-07-30
---

# Quick Task 260730-fwu: Continuous payout accrual — write deductions at the deadline, not at publish

**Deductions now auto-approve at their feedback deadline and accrue into the master ledger continuously via a parked `mode: "accrual"` publish path that can never mint `published`; the window still closes itself automatically via a separate finalize pass — the existing manual operator-publish route and UI are untouched, and nothing runs on a schedule yet.**

## Performance

- **Duration:** ~45 min (commits span 2026-07-30T12:00:46+07:00 to 12:26:10+07:00; additional upfront time spent reading the codebase before the first commit)
- **Completed:** 2026-07-30
- **Tasks:** 6/6 completed
- **Files:** 10 modified, 6 created (16 total touched across the 6 commits)

## Accomplishments

- Durable source-anchor fingerprint (`drizzle/0061`) replaces an O(written-lines) re-match search with an O(1) map lookup, and narrows a drifted-anchor failure from "abort the whole pending pass" to "quarantine one tutor's pending lines, open one exception, everyone else keeps appending."
- New `auto-approval.ts`: a deduction auto-approves once its feedback deadline is `POST_CLASS_AUTO_APPROVE_GRACE_HOURS` (default 24h) past, on a `live`-enforced, source-`ready` session — and an approved-but-unwritten deduction that loses that proof auto-reopens, keeping `assertPayoutRunPublishable`'s hard `unprovenApprovedDeductions` gate at 0 on every pass.
- `publishPayoutRun` gained `mode?: "operator" | "accrual"` (default preserves today's behavior byte-for-byte); accrual mode skips the window-ended guard, forces `partial` whenever the window hasn't ended, and skips the whole CSV/Drive leg. `finalizePayoutRunPass` gained `skipCsv` to actually implement that skip without touching the csv* columns at all.
- New `payout-accrual.ts` (`runPayoutAccrualPass` / `runPayoutFinalizePass`) and a parked, cron-secret-guarded route + `cron-registry.ts` entry — reachable only manually from Data Health, no `vercel.json` entry.
- 2 new + 2 extended integration test files; full unit suite (344 files / 3827 tests) and full integration suite (10 files / 118 tests) both green; `npx tsc --noEmit` clean.

## Task Commits

Each task was committed atomically on `feat/payout-accrual`:

1. **Task 1: Piece 0 — durable source-anchor fingerprint + per-tutor quarantine** — `1278e52` (feat)
2. **Task 2: Piece 1 — auto-approval and reopen sweep** — `32774a5` (feat)
3. **Task 3: Pieces 2+3 — accrual mode, skipCsv, and the accrual/finalize passes** — `9be534b` (feat)
4. **Task 4: Piece 4 — parked route and cron registry entry** — `3b03f1d` (feat)
5. **Task 5: Tests — auto-approval, accrual, anchor fingerprint, finalize** — `1e0c413` (test; also carries a bug fix in `payout-accrual.ts`, see Deviations)
6. **Task 6: Docs — post-class-feedback.md and crons.md** — `33ec5f2` (docs)

No separate plan-metadata commit was made — per this execution's explicit constraints, SUMMARY.md/STATE.md/ROADMAP.md are committed by the orchestrator, not by this executor.

## Files Created/Modified

| File | Change |
|---|---|
| `drizzle/0061_payout_line_source_anchor.sql` | New — single `ALTER TABLE ... ADD COLUMN "source_anchor_fingerprint" text;`, hand-written per the migration_note (Drizzle snapshot drift) |
| `drizzle/meta/_journal.json` | Registered migration 61 |
| `src/lib/db/schema.ts` | `sourceAnchorFingerprint` column on `postClassPayoutRunLines` |
| `src/lib/post-class-feedback/payout-master.ts` | `MasterPayoutRow.rawDuration`/`rawCredits`; `computeSourceAnchorFingerprint`; `buildAnchorFingerprintIndex` |
| `src/lib/post-class-feedback/payout-repository.ts` | `PayoutLineMatchPatch.sourceAnchorFingerprint`; `recordPayoutAnchorMissingException`; `finalizePayoutRunPass`'s `skipCsv` |
| `src/lib/post-class-feedback/payout-run.ts` | `planDedicatedAppends` rewritten to fingerprint-claim + per-tutor quarantine; `publishPayoutRun`'s `mode` param, window-guard skip, `forcePartial`, CSV-leg skip |
| `src/lib/post-class-feedback/auto-approval.ts` | New — `runPostClassAutoApprovals`, `runPostClassAutoReopens`, `runPostClassAutoApprovalSweep` |
| `src/lib/post-class-feedback/payout-accrual.ts` | New — `runPayoutAccrualPass`, `runPayoutFinalizePass` |
| `src/app/api/internal/post-class-feedback/payout-accrual/route.ts` | New — parked `GET` route |
| `src/lib/data-health/cron-registry.ts` | `post_class_feedback_payout_accrual` key + parked registry entry |
| `src/lib/post-class-feedback/__tests__/auto-approval.integration.test.ts` | New — 8 tests |
| `src/lib/post-class-feedback/__tests__/payout-accrual.integration.test.ts` | New — 7 tests |
| `src/lib/post-class-feedback/__tests__/payout-run.integration.test.ts` | Extended — 2 new anchor-fingerprint tests (20 → 22) |
| `src/lib/post-class-feedback/__tests__/migration.test.ts` | Extended — 3 new 0061 tests |
| `docs/features/post-class-feedback.md` | New "Continuous accrual" paragraph; run-state table updated |
| `docs/reference/crons.md` | New parked-route subsection; GET/POST table row |

## Decisions Made

- **Window resolution bug fix in `runPayoutFinalizePass` (found and fixed during Task 5).** As transcribed from the plan, finalize resolved its window via `payoutRunWindowForBangkokDate(payoutBangkokDate(now))` — "the window containing `now`." That function is defined so its result *always* satisfies `now <= windowEnd` (once day > 25 it rolls the anchor forward to next month specifically so the new window still contains `now`), so the guard `if (payoutBangkokDate(now) <= window.windowEnd) return skip` was a tautology: finalize could never proceed, for any `now`, ever. Fixed to resolve the window as `payoutRunWindow(payoutBangkokDate(now).slice(0, 7))` — `now`'s own Bangkok calendar month, not the roll-forward window — so once the 26th arrives, that anchor's own just-ended window is correctly targeted, and stays targeted through the rest of the calendar month for retries. `runPayoutAccrualPass`'s use of the roll-forward function is unaffected and correct as-is (accrual *should* always target "whichever window is currently open," which is exactly what that function computes).
- **`dependenciesWithClock` helper added to `payout-accrual.ts`.** Both pass functions take their own `now: Date` parameter but call `publishPayoutRun` with a `dependencies` object whose own `now: () => number` clock is independent. Per the plan's literal call shape, these could silently disagree (production is fine, since both default to `Date.now()` a few ms apart; but a test — or an unusual caller — supplying `now` without also supplying `dependencies.now` would get an inconsistent clock). Added a small wrapper that defaults `dependencies.now` from the pass's own `now` *only if the caller didn't already supply one*, closing this gap with no observable effect where it isn't needed.
- **Test dates anchored ~13 months in the future, forced to a fixed day-of-month.** `markPayoutLine`'s CAS guard compares `leaseExpiresAt` against Postgres's own `now()`, not the test's simulated JS clock. A simulated `now` anywhere in the past relative to the real database clock makes every lease look pre-expired immediately. Test dates are computed from `Date.now() + 400 days` (safely future regardless of when the suite runs) and then forced to day 10 / day 11 / day 26 of that computed month, so which 26th→25th window is under test stays deterministic independent of the real calendar date.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `runPayoutFinalizePass`'s window-ended guard was a tautology and could never let finalize proceed**
- **Found during:** Task 5, writing `payout-accrual.integration.test.ts`'s "reaches published once the window has ended" test — the finalize pass returned `{ skipped: "window-not-ended" }` unconditionally regardless of `now`.
- **Issue:** `payoutRunWindowForBangkokDate(payoutBangkokDate(now))` resolves "the window containing `now`," which by construction always satisfies `now <= windowEnd`. The guard built on top of it could never be false.
- **Fix:** Resolve the window as `payoutRunWindow(payoutBangkokDate(now).slice(0, 7))` — `now`'s own calendar month as the anchor, not the roll-forward window — so the guard correctly flips false once the 26th arrives.
- **Files modified:** `src/lib/post-class-feedback/payout-accrual.ts`
- **Verification:** `payout-accrual.integration.test.ts`'s finalize tests (no-op before window end; reaches `published` after) both pass.
- **Committed in:** `1e0c413` (Task 5 commit — the fix and the test that caught it landed together)

**2. [Rule 1 - Bug] Pass-level `now` could silently diverge from `publishPayoutRun`'s internal clock**
- **Found during:** Task 5, while designing deterministic tests for the accrual/finalize passes.
- **Issue:** `runPayoutAccrualPass`/`runPayoutFinalizePass` accept their own `now: Date` for window resolution but forwarded `dependencies` to `publishPayoutRun` unmodified; `publishPayoutRun`'s own clock (`dependencies.now`) would default to real `Date.now()` if not separately supplied, which is fine in production (same instant, few ms apart) but is a latent inconsistency for any caller that supplies one clock and not the other.
- **Fix:** Added `dependenciesWithClock()`, which defaults `dependencies.now` from the pass's own `now` only when the caller didn't already supply a `dependencies.now`.
- **Files modified:** `src/lib/post-class-feedback/payout-accrual.ts`
- **Verification:** All `payout-accrual.integration.test.ts` tests (which rely on a simulated `now` reaching every clock-sensitive check inside `publishPayoutRun`) pass.
- **Committed in:** `9be534b` (Task 3 commit)

---

**Total deviations:** 2 auto-fixed (both Rule 1 — bugs found and fixed during implementation/test-writing, both confined to the new `payout-accrual.ts` module).
**Impact on plan:** Both fixes were necessary for the plan's own stated positive-path behavior ("finalize reaches published once the window has ended") to be reachable at all. No scope creep — no architectural change, no new tables, no new exported surface beyond what the plan specified.

## Known Stubs

None. No hardcoded empty values, placeholder text, or unwired data sources were introduced.

## Threat Flags

None. The new route/registry entry match exactly the disposition already covered by the plan's own `<threat_model>` (T-260730-01 through T-260730-06) — no new endpoints, auth paths, or schema surface beyond what that register already accounts for.

## Issues Encountered

- **Docker unavailable in this environment** (OrbStack daemon not running; attempted to start it and polled for readiness, but it never came up). Per the plan's own verification note, this was anticipated. Used the test harness's built-in `TEST_DATABASE_URL` escape hatch instead, pointing at a scratch Postgres database (`bgscheduler_payout_test_0061`) on the same local Postgres server that already held prior scratch databases from earlier payout-feature verification sessions (`bgscheduler_payout_test_0060`, `bgscheduler_payout_verify_20260729_*`) — confirming this is an established, sanctioned pattern for this exact codebase/task family, not an improvised workaround. All integration tests genuinely ran against real Postgres; nothing was skipped or faked.
- **Real-Postgres-clock vs. simulated-test-clock mismatch** in `markPayoutLine`'s CAS guard (`leaseExpiresAt > now()`, evaluated by Postgres itself). Root-caused and resolved by anchoring test dates safely in the future relative to the real system clock (see Decisions above) rather than hardcoding calendar dates that happened to be in the past relative to today (2026-07-30).

## User Setup Required

None — no external service configuration required. The feature ships parked: `POST_CLASS_PAYOUT_WRITES_ENABLED` remains off in every environment until the existing rollout gates (documented in `docs/features/post-class-feedback.md`) clear, exactly as before this plan.

## Next Phase Readiness

- All 6 tasks complete; `npx tsc --noEmit` clean; `npm test` (unit, 344 files / 3827 tests) and `npm run test:integration` (10 files / 118 tests) both green.
- The manual-only rollout gates from the plan's own `<verification>` section were **not** performed by this execution (they require a live scratch Google Sheets target, real `CRON_SECRET`/OAuth credentials, and `POST_CLASS_PAYOUT_WRITES_ENABLED=true` locally only) — these remain a post-merge rollout step:
  - Apply `0061` to a scratch database and run the new suites against it there (done here, against `bgscheduler_payout_test_0061`).
  - Against `POST_CLASS_PAYOUT_TARGET=scratch`, invoke the route with `CRON_SECRET` and inspect the scratch workbook.
  - Invoke the same route a second time with no data change — zero new rows (marker-idempotency proof).
  - Confirm production stays unchanged while parked (no cron entry — confirmed via `git diff` against `vercel.json`, which shows no changes).
- No blockers for merging this branch once the above manual gates are run by a human with the necessary credentials.

## Self-Check: PASSED

All 16 created/modified files confirmed present on disk; all 6 task commit hashes (`1278e52`, `32774a5`, `9be534b`, `3b03f1d`, `1e0c413`, `33ec5f2`) confirmed present in `git log`.

---
*Quick task: 260730-fwu*
*Completed: 2026-07-30*
