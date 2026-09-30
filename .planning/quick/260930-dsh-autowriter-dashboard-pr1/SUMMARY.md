---
quick_id: 260930-dsh
status: complete (draft PR #118; not merged, not deployed)
branch: feat/autowriter-dashboard-redesign
---

# Summary — Feedback Autowriter dashboard page (redesign PR 1)

Built: layout A (system line with the owner's Controls menu and the halt banner; "What needs you"; Pilot health; four
trend charts on 14/30/90 days; one tutor table that filters the page; collapsed Details; a right-hand drawer for a
review, hold, failed post, incident or class). The nine cards, the tabs, the quality panel and the review-queue file
are deleted; everything they showed is in Details. No table, migration, cron or env var; nothing writes to Wise.

Data: trends (`trends.ts`, pooled 7-day averages, rolling 14-day Wilson bound, gaps never zero-filled) behind
`GET /api/feedback-autowriter/trends`; `inbox.ts`, `gate-sentence.ts`, `hold-reasons.ts`, `system-status.ts`;
`holds[].resolvedBy` = "tutor_wrote" while `post_class_sessions.latest_feedback_version_id` points at a teacher
version (the text Wise holds now); `isOpenHold` keeps a hold listed while unresolved and not more than 24 h past its
deadline; `review.tutors[].critical`; `review.lookback` (six earlier days for the 7-day averages); `RATE_POOL_DAYS`.

Two independent reviews during the build: all findings fixed (sticky review and control errors, reload when the page is
shown again, close-then-reload, drawer focus off Approve, state-filter and latest-60 honesty, rail look-back, marker
floor, the held-class signal read through the collection's pointer, dev-script robustness).

Verified on 6f641b28: typecheck clean; lint 0 errors; unit 512 files / 6,209 tests; autowriter Postgres 198/199 (the
one failure is main's fixed-deadline test in job.integration.test.ts, failing since 1 Oct 00:00 Bangkok); diff-check
clean; route guard 290; CI green (build, lint, typecheck, unit-tests, release-guards, Vercel preview).

Not done: next-class time in the empty state (no data); click-through tests (no DOM in the unit project).
Follow-ups: review drawer "current text" via the same pointer; fixed-deadline job test.
