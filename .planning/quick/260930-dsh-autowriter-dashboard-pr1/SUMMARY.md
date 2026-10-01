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

## Final review fixes

The final independent review of dd0cd41f was CLEAR with three MEDIUM findings and five LOW ones; all but L6 are fixed.

- **M1 — the review drawer and the 5-minute poll** (e0f3cb6b). A post to review is pinned when its drawer opens
  (`nextReviewPin` in `item-drawer.tsx`): the detail and the verdict request (`fieldsSha256`, `currentVerdictId`,
  `seenFlagIds`) come from the pinned version, so a flag raised meanwhile gets the server's 409 again, as on main.
  When the page holds a newer version (`newerReview`: anything the drawer shows, flags and saves compared by id), the
  drawer says "This class changed since you opened it — reload it before recording a verdict" in a notice that stays
  in view, and Reload pins that version with a fresh form. Nothing is swapped under the form. Besides the unit tests,
  a throwaway browser page (not committed) mounted the real drawer, swapped the payload, and clicked Reload.
- **M2 — gate sentence** (1ccb9ba3). A date only when critical verdicts alone block the gate; otherwise the blockers
  that need a person lead: "Gate blocked: 1 unacknowledged API save and a critical verdict (29 Sep)."
- **M3 — "Nothing needs you" without the review data** (2af4bdb2, 2ee32341). With the review data unavailable or
  failed, the headline is "Some of what needs you could not load.", an empty list says "Posts to review and incidents
  could not load — Refresh to try again." (before migration 0101: not available yet), and the header no longer says
  "Nothing urgent is hidden below." Held classes and failed posts still show.
- **L1 — old critical incidents** (4097a4e5). Every unacknowledged critical incident loads, whatever its age or
  delivery, first and never capped; then the 100 latest others of 30 days.
- **L2 — hold cap order** (bd4f9071). Holds that may still wait (no deadline, or one ahead or passed under 24 h) come
  first under the 500 cap; `holdsLimit` lets the Postgres test use a cap of three.
- **L3 — "Verdict recorded."** (e0f3cb6b). The drawer hands "Verdict recorded." / "Incident acknowledged." to the page's
  status lines.
- **L4 — trends route on missing tables** (ed0b898b). SQLSTATE 42P01 (`code ?? cause.code`) answers HTTP 200
  `{ available: false, reason: "review_tables_missing" }`; the page shows the existing "quality data not available".
- **L5 — "N open"** (2af4bdb2). Counts classes (`openCount`), an item about no class once.
- **L6** (mini chart vs headline lag) left as is: the tooltip explains it.

Docs and the visual check (32d36a04): feature page and API reference updated; the preview script has a fourth view,
`?view=review-failed` (`.feedback-autowriter/preview/dashboard-review-failed.png`).

Verified on 32d36a04: typecheck clean; lint 0 errors (18 warnings, none in the files of this round); unit 512 files /
6,223 tests (run beside the Postgres suite, a classrooms fixture test hit its 30 s limit at 33.8 s; alone it passes);
autowriter Postgres 200/201 (the one failure is main's fixed-deadline test in job.integration.test.ts, fixed in
PR #119); diff-check clean; the new Postgres tests fail against the old queries; preview re-rendered.
