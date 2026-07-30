---
id: 260730-n7z
status: complete
completed: 2026-07-30
commits:
  - aacce46 fix(post-class-feedback): stop retrying sessions Wise deleted
  - d6ee4f3 fix(post-class-feedback): gate activation on pipeline health, not tidy data
  - 33e691e fix(post-class-feedback): scope source health and drop deleted sessions from payout
  - d65f9b4 docs(post-class-feedback): deleted-session retirement and the activation gate
---

# Quick Task 260730-n7z — Summary

Unblocks post-class-feedback activation, stuck in shadow mode since 25 July 2026. Two
independent defects; fixing either alone would have left it blocked.

## Defect 1 — deleted Wise sessions retried forever

The collector re-proposed sessions Wise had deleted on every run, indefinitely: resolution
requires a successful observation, and a feedback event only stops being a candidate once a
successful observation links it. 230 open issues from 121 deleted sessions, ~30 of each
run's 50 Wise calls.

`SessionDeletedEvent` was already mirrored into `wise_activity_events` with an indexed
`session_id` and read by nothing in the feature. Every candidate lane now anti-joins on it;
a sweep at the top of each run resolves the open session-scoped issues and marks held rows
`wise_deleted_at` + `eligible = false` + `eligibility_reason = 'deleted_in_wise'`.

Migration **0062**, additive nullable column plus partial index. `db:generate` emitted the
usual catch-up bloat (recreating everything from 0057–0061); trimmed to the two real
statements, journal tag and `when` normalised to the repo sequence.

## Defect 2 — the gate measured the wrong thing

`selectFreshPostClassShadowSync` required `metadata.outcome === "success"` — no source issue
of any kind — while `sourceIssueCount` increments for per-row facts. Replaced with
`classifyPostClassShadowReviewEvidence`: absolute conditions on `globalSourceHealthy`,
`mappingObservedHealthy` (previously dead metadata) and a **live** open-blocking-global-issue
count; acknowledgeable readability/resolvability rates cleared only by echoing the exact
server-computed count with a reason, audited. A run is `partial` only when a global issue,
form drift, or widespread contract breach makes it untrustworthy.

## The bug the tests caught

The first version of the anti-join had no table alias. The highest-priority candidate lane
selects `FROM wise_activity_events` itself, so `wise_activity_events.session_id` inside the
subquery bound to the *inner* instance on both sides — the predicate degraded to
`inner.session_id = inner.session_id`, true the moment any deletion event existed, and the
lane returned **nothing at all**. It would have silently stopped the collector in production.

The production spot-check missed it because that query was hand-written with explicit
aliases. What caught it was the integration case asserting a live session queued *behind* a
deleted one is still returned — the one the plan called load-bearing. Both helpers are now
aliased, with a comment explaining why.

## Verification

- `npm run verify:release` — typecheck, **346 files / 3868 unit tests**, `next build`,
  second typecheck, `git diff --check`, route-surface guard (202 routes). All pass.
- Full integration project against a local scratch Postgres (Docker unavailable):
  **11 files / 128 tests**, all pass.
- Production spot-check (read-only): the new lane-0 filter takes the candidate pool from
  **229 → 108**, removing exactly the 121 deleted sessions.

New tests: `deleted-session-retirement.integration.test.ts` (9 cases), the first-ever route
test for the shadow-review handler (11 cases), migration 0062 assertions.

Deliberately rewritten, each with a comment saying why so nobody reverts them:
`shadow-review.test.ts` (the `partial` rejection inverts), and three `sync.test.ts`
assertions where session-scoped issues no longer make a run `partial`.
`recheck-queue.integration.test.ts:121` kept as-is — retirement is gated on deletion
*evidence*, grace expiry still leaves the issue `open`.

## Deploy notes

**Ship the whole stack together.** Migration 0062 alone is inert and safe. The lane filters
without the narrowed `outcome` rule would make the symptom look worse first: once the 121
deleted sessions stop occupying lane 0, the collector starts reaching the 108 evidence-free
sessions and the Data Health issue count spikes before it falls.

- One session, `6a25254705d397959631f664` (ends 2026-07-27), is deleted in Wise but sits
  inside the live payout window as `eligible = true, source_status = 'ready'`. Retiring it
  moves that window's denominator by one — worth telling finance before deploy.
- `6a584f90055db8535fb7d97c` carries 17 assessments; `eligible = false` shifts the historical
  compliance denominator by one.
- Legacy runs lack the new metadata and fail closed, so the gate needs one fresh shadow sync
  after deploy before it can pass.
- Not verified: that the 108 evidence-free sessions are genuinely deleted. All predate the
  event mirror's floor and none ever obtained a session row, but that is circumstantial —
  they get the 7-day grace window rather than retirement.
- Noticed, out of scope: 1,934 of 2,281 July sessions are `source_status <> 'ready'` (84%),
  only 3 deleted. `assertPayoutRunPublishable`'s unreconciled-ratio gate is firing on
  something unrelated to this work.
