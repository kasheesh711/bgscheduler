---
quick_id: 261002-rwm
status: complete
commit: f3c9fd2c
---

# Quick 261002-rwm: Autowriter dashboard density — summary

- Layout: top grid `items-start lg:grid-rows-[auto_1fr]`; inbox (2/3) keeps its own height, trends moved into the
  grid under it (`lg:col-span-2`), health rail spans both rows and is sticky (`lg:sticky lg:top-4`). Skeleton matches.
- Tutors table: single-line rows, search, views All / Needs attention / No posts yet / Off with counts, sortable
  headers with `aria-sort`, `IntervalBar` (Wilson LB → accuracy, 70/80 ticks), Review column replaced by a
  "Sampled" tag, quiet tutors (no post, no hold, no missed eligible class, nothing needing attention) as chips.
- Deviation from plan: kept a separate sortable "Lower bound" column instead of an inline "LB x%" text.
- Review (code-reviewer): no blockers; fixed the medium finding (a 0%-coverage tutor was folded into the quiet chips)
  plus row-sizing, toggle aria-labels, name truncation and the 7-day label without review data.
- Verified: unit suite 604 files / 7345 tests pass on Node 22 (local Node 20 lacks `Map.groupBy`, unrelated
  tutor-offboarding suites fail there); typecheck, eslint, `git diff --check` clean; preview renders checked for
  owner, empty, review-failed, dark and 390px views.
