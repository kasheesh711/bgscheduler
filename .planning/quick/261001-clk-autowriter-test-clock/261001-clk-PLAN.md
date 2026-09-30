---
quick_id: 261001-clk
status: approved
source_plan: "make the time-dependent autowriter integration tests independent of the wall clock" — task brief, 2026-10-01 00:25 Bangkok
base: main (`3769da0`)
branch: claude/cool-edison-93dn65
---

# Autowriter integration tests: independent of the wall clock

`job.integration.test.ts` › "second pass: Soniox transcript (Postgres + fakes)" › "never starts the review window of
a class still being worked on" fails since 1 Oct 00:00 Bangkok: `expected { Object (sonioxRetainUntil) } to not have
property "sonioxRetainUntil"`. `seedRow()` seeds the fixed deadline 30 Sep 23:59:59.999 Bangkok. `runSweep` reads the
clock `deps()` pins (the fixtures' `NOW`), but whether a class is done with its Soniox job is decided on the database
clock: `doneWithSonioxJob` (store.ts) counts a row with `deadline_at < now()` as done, whatever its state (unless it
is mid-POST or being worked on). Once the calendar passed the fixed date, the sweep started the review window of a
class that is still transcribing.

## Hard rules
- Tests only: no product code change (the review window stays on the database clock). Every assertion kept.
- No writes to Wise or to the production database. Worktree `.claude/worktrees/slot-a`. Draft PR only.

## Tasks
1. `job.integration.test.ts`: one `DEADLINE`, two days ahead of both clocks a seeded deadline meets (the pinned `NOW`
   and Postgres `now()`), for `seedRow()` and the other seeds that used the fixed date. The second class of the
   mid-sweep halt test keeps its +30 min, so the sweep still starts it second. `seedClass()` stays on `NOW` (the
   sweep order it tests); its comment says it is no class to test the review window with.
2. Grep the review, store and replay integration tests for fixed dates the code compares with a real clock.
3. Verify: the integration project on Testcontainers, typecheck, lint; the four files with both clocks moved forward
   (libfaketime on Node and on a local Postgres, +0 d to +10 years); a mutation check that the fixed test still
   catches a review window started too early.
