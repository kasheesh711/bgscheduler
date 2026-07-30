---
id: 260730-j0c
status: complete
completed: 2026-07-30
commits:
  - 03974ac fix(post-class-feedback): finalize the oldest un-finalized payout window
  - cf21ed9 feat(post-class-feedback): alert on a payout window left un-finalized
  - ef80eda test(post-class-feedback): regression for a two-month-stranded window
  - 9efe2c1 docs(post-class-feedback): finalize selector and stale-window alert
---

# Quick Task 260730-j0c — Summary

## What changed

**Finalize target (`src/lib/post-class-feedback/payout-accrual.ts`).**
`runPayoutFinalizePass` now resolves its window through `resolveFinalizeWindow`:

1. `findOldestUnfinalizedPayoutRun(db, { bangkokDate })` — earliest
   `post_class_payout_runs` row with `window_end < today` and
   `status NOT IN ('published', 'closed')`, ordered by `anchor_month`.
2. Otherwise the window anchored to today's own calendar month, still behind the
   original `today <= windowEnd → skip` guard.
3. Otherwise `{ skipped: "window-not-ended" }`.

Branch 2 is deliberately unchanged: it is the only path that can target a window with
no run row (publish creates the row), so the day-26 first-finalize keeps working while
the pass still cannot mint an empty `published` run for an older window the system never
observed. A run another actor is mid-publish on is still selected — the existing lease
guard rejects the collision, which surfaces as a skip and retries next tick.

**Alert (`src/lib/post-class-feedback/payout-window-health.ts`, `src/lib/internal/cron-watchdog.ts`).**
`classifyPayoutWindowStaleness` (pure) flags a window once its *anchor month* has passed
— finalize owns the 26th-to-month-end stretch, so only an un-finalized M seen from M+1
is a signal. Two stale shapes: a run short of `published`/`closed`, or no run row at all
for the window that most recently ended. `loadPayoutWindowStaleness` returns `null` while
the accrual cron is parked (`schedule: null` in the registry), so the check is inert
today and arms itself when the schedule is added. The watchdog projects a stale verdict
onto a synthetic `post_class_payout_window` `CronJobHealth` and appends it to the swept
jobs, reusing episode dedup, the digest email, and the recovery notice; the call is
wrapped so a payout-side failure degrades to "no payout entry this sweep" instead of
failing a live cron.

## Verification

- `npx tsc --noEmit` — clean.
- `npx eslint` on all nine changed/added files — clean.
- `npx vitest run --project unit` — **345 files, 3842 tests, all passing** (was 3842 with
  the 11 new unit tests included; no pre-existing test changed behaviour).
- `TEST_DATABASE_URL=postgresql://localhost:5432/bgscheduler_j0c_20260730 npx vitest run
  --project integration src/lib/post-class-feedback/__tests__/` — **7 files, 107 tests,
  all passing** (Docker unavailable; scratch-database path per
  `src/tests/integration/db-helper.ts:24`).
- Regression proven: with `payout-accrual.ts` stashed back to the old derivation, the new
  test fails with `Expected a run view, got a skip: window-not-ended` — the exact
  production symptom — and passes with the fix.

## Notes / follow-ups

- `src/lib/internal/__tests__/cron-watchdog.test.ts` needed `vi.mock("server-only")`
  because the watchdog now transitively imports a `server-only` module.
- `payout-window-health.test.ts` asserts the accrual registry entry's `schedule` is still
  `null`. That assertion is an intentional tripwire: whoever schedules the cron must
  update the test and re-read the alerting behaviour before it goes live.
- Still parked and write-disabled in production
  (`POST_CLASS_PAYOUT_WRITES_ENABLED` unset), so nothing is live yet.
