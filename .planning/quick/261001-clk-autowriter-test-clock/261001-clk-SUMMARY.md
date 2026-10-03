---
phase: quick-261001-clk
plan: "01"
status: complete (draft PR against main; tests only, nothing deployed, no switch changed)
subsystem: feedback-autowriter (integration tests)
tags: [feedback-autowriter, soniox, vitest, testcontainers, clock]
---

# Summary — autowriter integration tests: independent of the wall clock

**Branch:** `claude/cool-edison-93dn65`, from `main` (`3769da0`). **Commits:** `cbe5d59` plan · `ef3e363` the seeds ·
this summary.

## The failure
`job.integration.test.ts` › "second pass: Soniox transcript (Postgres + fakes)" › "never starts the review window of
a class still being worked on" failed from 1 Oct 00:00 Bangkok, with the same code that passed at 30 Sep 23:51:
`expected { Object (sonioxRetainUntil) } to not have property "sonioxRetainUntil"`.

## Why
The tests read three clocks, not one:
- **the pinned clock** — `deps()` gives `runSweep` / `processSession` `now: () => NOW` (29 Sep 11:00 Bangkok): the
  gates, the expiry cutoff, the sweep's order, the no-recording alert;
- **the wall clock** — `Date.now()` in the code (function budget, Soniox submit and poll times);
- **the database clock** — Postgres `now()`: due rows, leases, and the Soniox review window. `doneWithSonioxJob`
  (store.ts) counts a row with `deadline_at < now()` as done with its Soniox job whatever its state (unless it is
  mid-POST or being worked on); `stampSonioxRetention` then starts its 72 h window.

`seedRow()` seeded `deadlineAt: 2026-09-30T16:59:59.999Z`, the fixture class's real deadline
(`calculateFeedbackDeadline`: 23:59:59.999 Bangkok on the second day after the class). Ahead of `NOW`, so the sweep's
own logic saw a class with time left; but once the calendar passed it, the database saw a class past its deadline,
and the sweep's clean-up started the review window of a class still transcribing. The sweep's injectable `now` is already pinned and cannot
reach this: the window is on the database clock by design (store.ts: "on the database clock").

## What changed (tests only)
1. `DEADLINE` — `max(NOW, Date.now()) + 48 h`: ahead of both clocks a seeded deadline meets, on any date the suite
   runs. `seedRow()` uses it, and so do three other seeds that used the fixed date — the posting row of the two
   in-flight tests and the second class of the halted sweep — each with the first class's deadline, as before.
2. The second class of "stops processing the moment a halt lands mid-sweep" keeps its 30 minutes after the first
   class's deadline (`DEADLINE + 30 min`), so the sweep still starts it second.
3. `seedClass()` stays on `NOW`: the order the sweep starts rows in is decided on the pinned clock, which is what
   those tests check. Its deadlines are therefore past on the database clock (permanently, since 30 Sep 13:00
   Bangkok); none of its tests looks at the review window, and its comment now says it is no class to do that with.
No assertion changed.

## The other integration files (task 2)
- `store.integration.test.ts`: seeds are `Date.now()`-relative already. Its fixed `sonioxRetainUntil:
  "2026-10-01T00:00:00.000Z"` values are markers: the tests assert whether a requeue or retry keeps or clears them,
  never compare them with a clock (`listSonioxCleanup` there only sees values stamped by the database itself).
  `alertsSent`, `judgeFailingSince` and `triagedAt` dates are carried through or checked for presence.
- `review.integration.test.ts`: `now` is passed everywhere it matters (`deps()` → `now: () => NOW`, `assignReviews`,
  `refreshDailyMetrics`, `runReviewJob`, `drainIncidentOutbox`); incident `next_push_at` is set and compared on the
  same passed clock.
- `replay.integration.test.ts`: `loadReplaySample(..., now: NOW)`.
Nothing to change; the runs below agree.

Also noted, unchanged: a row `processSession` creates itself takes its deadline from the fixture's class end
(`calculateFeedbackDeadline`, 30 Sep 23:59 Bangkok) — past on the database clock from now on, permanently. No test
that relies on it looks at the review window, so no outcome changes with the date.

## Verification
| Check | Before the fix | After |
|---|---|---|
| Integration project on Testcontainers (`postgres:16-alpine`), 1 Oct 00:40–00:53 Bangkok | 1 failed / 189 passed: the reported test | 190 / 190 |
| Node and Postgres clocks moved forward together: +0 d, +1 d, +7 d, +30 d | job: the same single failure; review, store, replay: pass (also at +365 d) | 190 / 190 |
| The same at +365 d and +3650 d (27 Sep 2036) | — | 190 / 190 |
| Mutation of `doneWithSonioxJob`: the deadline always counts as past | — | the fixed test fails, with the reported assertion |
| Mutation of `doneWithSonioxJob`: the deadline never counts | — | its neighbour ("… left unfinished past its deadline") fails |
| `npm run typecheck`, `npm run lint`, `git diff --check` | — | clean (lint: 0 errors; 18 warnings, all pre-existing in other files) |

How the clocks were moved: libfaketime (`FAKETIME=+Nd`, `FAKETIME_DONT_FAKE_MONOTONIC=1`) preloaded into the Vitest
process and into a local Postgres 16 started with `pg_ctl`, reached through `TEST_DATABASE_URL` (the escape hatch in
`src/tests/integration/db-helper.ts`), with a fresh database per file as Testcontainers gives. One database shared by
all four files is not the same thing: review's "logs every change of the mode or the tutor switches" then fails,
because the job suite leaves the control row `live` — a property of that escape hatch, not of the clock.

CI does not run the integration project (lint, typecheck, unit-tests, build, release-guards), so the runs above are
the evidence.

## Hard rules kept
No product code, schema or migration changed. No Wise call, no production database access, no deploy. Worktree
`.claude/worktrees/slot-a`. GSD commands are not installed in the cloud session this ran in: this plan and summary
follow the quick-task format by hand.
