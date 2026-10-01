---
quick_id: 260930-dsh
status: approved
source_plan: docs/superpowers/specs/2026-09-30-autowriter-dashboard-redesign-design.md (sections 3, 4.1, 8, 10) — approved by the owner (Kevin), 2026-09-30
base: main
branch: feat/autowriter-dashboard-redesign
---

# Feedback Autowriter dashboard redesign — PR 1, phase 2: the page

The owner chose mockup A (`docs/superpowers/specs/assets/2026-09-30-autowriter-dashboard-mockup-a.png`, source
`…-mockup-a.html`): a to-do list on the left, a health rail on the right, four trend charts, one tutor table, and the
detail in a side drawer. The live page still opens on nine number cards and three tabs. Phase 1 (the data layer:
`trends.ts`, `inbox.ts`, `gate-sentence.ts`, `hold-reasons.ts`, `system-status.ts`, the trends route and the payload
additions) is on this branch already. This phase builds the page.

Where the spec and the mockup differ, the spec decides content and behaviour and the mockup decides the look.
PRs 2–4 are out of scope: no "tutor told" times, no Decisions group, no dry runs, no "Next in line", no Retry button.

## Hard rules

- Work only in `.claude/worktrees/slot-b` on `feat/autowriter-dashboard-redesign`; Node 22; no new worktree.
- No new table, migration, cron or environment variable. No write to Wise or to the production database, no live
  model or Soniox call. The visual check renders made-up fixtures only; no dev server against production data.
- Made-up names in fixtures, tests, docs and screenshots (tutors Anna, Ben, Chai, Dao, Emma; no student names).
- One commit per component, pushed as it goes (fast-forward only). Draft PR against `main`; never ready, merged or
  auto-merged.

## Decisions on the gaps Phase 1 found

1. **System line** shows the mode (and Halted), the writer, fallback writer and judge with their efforts, "Transcript
   first" and "Second pass" on/off, the prompt and judge versions, the last review run (time and status) and the last
   Wise webhook. No "last sweep": no payload carries it.
2. **Range selector** (14 / 30 / 90 days) drives the four charts and their totals only. The tutor table and the chart
   footers that come from the review payload (fix rounds, misses and exclusions, per-tutor accuracy and coverage)
   cover the gate's 14 days and say so.
3. **Held group**: `dashboard.holds[].resolvedBy` is `"tutor_wrote"` when our own tables show a person has written
   the class since; the to-do list shows a hold only while it is unresolved and its deadline is ahead or passed less
   than 24 hours ago. Every hold stays in the All classes log.
4. **Admins who are not the owner** see everything read-only: no verdict form, no Acknowledge, no controls, and the
   note "Only the owner records verdicts."

## Tasks (one commit each)

1. `format.ts`: one home for `when`, `usd`, `minutes` and the field labels.
2. Split `feedback-autowriter-review-queue.tsx` into `review-helpers.ts`, `verdict-form.tsx` and
   `review-detail.tsx`; behaviour, request body, 409 handling and downgrade rules unchanged; tests moved.
3. `item-drawer.tsx`: a right-hand sheet on `Dialog` with the review, hold and incident / failed-post bodies.
4. `inbox.tsx`: "What needs you" from `buildInbox`, grouped, with urgency colours and the empty state.
5. `system-line.tsx`: the status row, the owner's Controls popover and the halt banner.
6. `health-rail.tsx`: the gate card, the accuracy and coverage mini charts, the Today line.
7. `trend-charts.tsx`: the four charts on `ChartCanvas`, pure config builders with unit tests, DOM legends, footers,
   the "since" note and the range selector.
8. `tutor-table.tsx`: one merged table; a row click sets the page's tutor filter.
9. `classes-log.tsx` and `system-details.tsx`: the collapsed detail sections.
10. The shell `feedback-autowriter-dashboard.tsx` (layout A, polling, graceful states) and `page.tsx` (trends loaded
    in parallel, a skeleton that mirrors the layout). The nine cards, the tabs, the quality panel and the review queue
    file are deleted.
11. Tests rewritten against the new structure, keeping every behaviour the old suites pin.
12. `scripts/dev/render-autowriter-dashboard.mjs`: bundle the page with fixtures, compile the CSS, screenshot it with
    headless Chrome (owner, admin and empty views) and compare with the mockup.
13. Docs (feature page, API reference), this quick task's `SUMMARY.md`, the draft PR.

## Verify

`npm run typecheck`, `npm run lint`, `npx vitest run --project unit`, the autowriter integration project
(`npx vitest run --project integration src/lib/feedback-autowriter`), `git diff --check`,
`npm run guard:production-route-surface`; no `.only` / `.skip` / TODO; and
`git grep -n "xl:grid-cols-9\|TabsTrigger" src/components/feedback-autowriter` returns nothing.
