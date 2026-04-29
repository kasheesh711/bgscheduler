---
phase: 08-vpol-02-sticky-tutor-legend
plan: 04
subsystem: compare-ui
tags: [sticky-header, z-index, normalization, calendar-grid]
requires:
  - 08-02 (Z_INDEX constant at src/lib/ui/z-index.ts)
provides:
  - "CalendarGrid sticky day-header normalized to Z_INDEX.legend = 6 (was hardcoded `z-10`)"
  - "Consistent z-stacking across both compare-view sticky surfaces (WeekOverview legend + CalendarGrid day-header)"
affects:
  - "Day-view drilldown sticky header now uses the Phase 8 scale; popover-above-sticky behavior preserved by Base UI's `z-50` Portal"
tech-stack:
  added: []
  patterns:
    - "Inline `style={{ zIndex: Z_INDEX.legend }}` (replaces Tailwind utility class) — preferred per z-index.ts JSDoc"
key-files:
  created: []
  modified:
    - path: src/components/compare/calendar-grid.tsx
      purpose: "Normalize sticky day-header z-index to Phase 8 scale via Z_INDEX.legend"
      lines_changed: 5
decisions:
  - "Asymmetric interaction (D-07) preserved verbatim — day-view header keeps TutorProfilePopover click affordance; week-view legend stays display-only (Plan 03)"
  - "Used inline `style={{ zIndex: Z_INDEX.legend }}` (not `z-[6]` Tailwind utility) — keeps the value automatically in sync with the scale and avoids one extra cross-reference comment"
metrics:
  duration: "~3 min"
  completed: 2026-04-29
  commit: d9c729f
  files_changed: 1
  insertions: 5
  deletions: 1
---

# Phase 8 Plan 04: CalendarGrid Z-Index Normalization — Summary

**One-liner:** Replaces `calendar-grid.tsx:120` hardcoded `z-10` Tailwind utility with `style={{ zIndex: Z_INDEX.legend }}` (= 6) imported from `@/lib/ui/z-index` per D-06, while preserving the day-view `TutorProfilePopover` click affordance unchanged per D-07.

## What shipped

One file edited — `src/components/compare/calendar-grid.tsx` (+5/-1 lines):

1. **Added** `import { Z_INDEX } from "@/lib/ui/z-index";` to the imports block.
2. **Changed** the sticky day-header opening tag at line 120 (baseline) from:
   ```tsx
   <div className="flex border-b sticky top-0 bg-background z-10">
   ```
   to:
   ```tsx
   <div
     className="flex border-b sticky top-0 bg-background"
     style={{ zIndex: Z_INDEX.legend }}
   >
   ```

The wrapped `TutorProfilePopover` block at lines 125-135 (baseline) is byte-for-byte unchanged — same `<div className="flex-1 px-3 py-2 text-center border-r last:border-r-0">`, same `<TutorProfilePopover tutor={t} color={chip?.color ?? "#888"}>`, same clickable `<button>` with `font-semibold text-sm hover:underline`.

## Commits

| Hash     | Type | Scope | Message |
|----------|------|-------|---------|
| `d9c729f` | feat | 08-04 | normalize CalendarGrid sticky day-header to Z_INDEX.legend (STICKY-02) |

Single-file atomic commit. `git log -1 --name-only d9c729f` confirms only `src/components/compare/calendar-grid.tsx` in the change set.

## Verification

| Check | Expected | Observed |
|-------|----------|----------|
| `grep -c 'import { Z_INDEX } from "@/lib/ui/z-index"' src/components/compare/calendar-grid.tsx` | 1 | 1 |
| `grep -c 'z-10' src/components/compare/calendar-grid.tsx` | 0 | 0 |
| `grep -c 'zIndex: Z_INDEX.legend' src/components/compare/calendar-grid.tsx` | 1 | 1 |
| `grep -c 'sticky top-0' src/components/compare/calendar-grid.tsx` | 1 | 1 |
| `grep -c 'TutorProfilePopover' src/components/compare/calendar-grid.tsx` | 3 (preserved) | 3 |
| `npx tsc --noEmit` errors scoped to `src/components/compare/calendar-grid.tsx` | 0 | 0 |
| `npm test --run` overall | All passing | 136/136 ✓ |
| Z_INDEX consumers across `src/components/compare/` (grep `import { Z_INDEX }`) | 2 (week-overview + calendar-grid) | 2 |

**Z-stack post-Phase-8 (consistent across both sticky surfaces):**

| Layer | z-index | Element |
|-------|---------|---------|
| Popover (Base UI Portal) | 50 | Per-session and tutor-name popovers — render above the legend |
| Legend / sticky header | 6 (`Z_INDEX.legend`) | WeekOverview consolidated legend + CalendarGrid day-header |
| Content (implicit) | 1 | Session cards, conflict bands, lane tints, today indicator |

## Deviations from Plan

None. The edit landed as the plan's `<implementation>` section described — single import + single inline-style replacement.

## Known Stubs

None.

## Deferred Issues

- Same two pre-existing TS errors in `src/lib/sync/__tests__/past-sessions-diff-hook.test.ts` (Phase 7 territory) are unaffected by this plan and remain for follow-up.

## Self-Check: PASSED

- All 5 must_haves from [08-04-PLAN.md](08-04-PLAN.md) verified via grep counts and visual diff inspection
- Commit `d9c729f` exists in `git log`; `git log -1 --name-only` shows only `src/components/compare/calendar-grid.tsx`
- No STATE.md / ROADMAP.md / REQUIREMENTS.md edits from this plan
- No other component touched (week-overview.tsx unchanged after this plan; tutor-profile-popover.tsx untouched)
- 08-04-SUMMARY.md written at `.planning/phases/08-vpol-02-sticky-tutor-legend/08-04-SUMMARY.md`
- 136/136 tests pass; tsc reports 0 errors scoped to edited file

## Threat Flags

None. The change replaces a hardcoded numeric Tailwind utility with an inline numeric style derived from a compile-time literal constant. No runtime input, no I/O, no security boundary crossed. Matches the 08-04-PLAN.md threat register (all entries LOW / accept).

---

*Phase 8 Plan 04 complete. Wave 3 finished — both Plans 03 and 04 are committed and verified. Ready for Wave 4 — Plan 05 (verification scaffold + human-QA checkpoint + Traceability flip).*
