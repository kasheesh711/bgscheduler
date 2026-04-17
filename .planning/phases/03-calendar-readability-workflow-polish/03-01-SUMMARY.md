---
phase: 03-calendar-readability-workflow-polish
plan: 01
subsystem: compare-view
tags: [calendar, readability, ui, multi-tutor]
requires:
  - src/components/compare/week-overview.tsx (existing)
  - src/components/compare/calendar-grid.tsx (existing)
  - src/components/compare/compare-panel.tsx (existing)
  - src/components/compare/session-colors.ts::rgba
  - src/hooks/use-compare.ts::getCurrentMonday
provides:
  - Per-tutor lane tint backgrounds (5% opacity) in multi-tutor week view
  - Sticky lane header row with color dot + tutor name (multi-tutor only)
  - Red today indicator line + dot on current Asia/Bangkok week
  - Numeric conflict count badge in WeekOverview day tabs
  - Native hover tooltips on session cards (WeekOverview + CalendarGrid)
affects:
  - src/components/compare/week-overview.tsx
  - src/components/compare/calendar-grid.tsx
  - src/components/compare/compare-panel.tsx
tech-stack:
  added: []
  patterns:
    - useEffect + browser interval timer with cleanup for 60s live ticker
    - Asia/Bangkok timezone via `new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" }))` (matches existing use-compare.ts pattern)
key-files:
  created: []
  modified:
    - src/components/compare/week-overview.tsx
    - src/components/compare/calendar-grid.tsx
    - src/components/compare/compare-panel.tsx
decisions:
  - Inline today-indicator hook in each component (no shared helper) to avoid cross-plan file sprawl per plan directive
  - Lane tint at 5% opacity (rgba alpha 0.05) — subtle enough not to compete with session cards
  - Sticky header height 20px with backdrop-blur-sm for readability over content beneath
  - Today indicator uses bg-red-500 literal class (not semantic token) matching GCal convention
metrics:
  duration: ~25m
  completed: 2026-04-17
  tasks: 3
  files: 3
---

# Phase 03 Plan 01: Calendar Readability — Lanes, Today Indicator, Tooltips

One-liner: Adds tinted backgrounds + sticky labels per tutor lane, a GCal-style red today line, numbered conflict badges, and native hover tooltips on session cards in the compare views.

## Summary

Three readability improvements landed on the multi-tutor compare calendar:

1. **Lane identity (CAL-01 + CAL-02):** Each tutor's lane in the multi-tutor week view now has a 5%-opacity tinted background plus a sticky header with a color dot and tutor name. Single-tutor view is untouched.
2. **Today indicator (CAL-03):** When viewing the current Asia/Bangkok week, a 2px red line and 8px dot mark the current time on today's column. The line updates every 60s via a browser interval timer with a proper cleanup return. No indicator on past/future weeks.
3. **Conflict badge + tooltips (CAL-04 partial, FLOW-02):** The `!` conflict marker in WeekOverview day tabs is now a numeric red pill (e.g. `Mon [2]`). Every session card in both WeekOverview and CalendarGrid carries a native `title` attribute — "Student - Subject\nHH:mm-HH:mm" — so admins can inspect sessions by hover without opening the popover.

A new required prop `weekStart: string` was threaded through both `WeekOverview` and `CalendarGrid` from `ComparePanel`.

## Commits

| Task | Name | Commit |
|------|------|--------|
| 1 | Lane tints + sticky lane headers (CAL-01, CAL-02) | `3e45841` |
| 2 | Today indicator in WeekOverview + CalendarGrid (CAL-03) | `fb54510` |
| 3 | Conflict count badge + native title tooltips (CAL-04 partial, FLOW-02) | `ce0aaa9` |

## Verification

- `npx tsc --noEmit` — zero errors on all modified files (exit 0)
- `npm test -- --run` — **82 / 82 passed** (INFRA-02 intact)
- Acceptance criteria greps all pass:
  - `Lane tint backgrounds` appears once; `sticky top-0` once; `rgba(chip?.color` appears 2× (tint + overflow badge); `backdrop-blur-sm` once
  - `bg-red-500` appears 2× in both files (line + dot)
  - Browser interval + clear-interval calls appear once in each of week-overview and calendar-grid
  - `getCurrentMonday` imported and used
  - `weekStart={weekStart}` appears 3× in compare-panel (WeekOverview + CalendarGrid + pre-existing WeekCalendar)
  - Old `ml-1 text-conflict">!` indicator fully removed (0 matches)
  - `title={tooltipTitle}` present in both WeekOverview and CalendarGrid

## Deviations from Plan

None — plan executed exactly as written.

## Deferred Issues

**Pre-existing build warning in `src/app/(app)/compare/page.tsx`** (logged in `deferred-items.md`):
- `npm run build` triggers a Next.js build-worker type error on `import from "next/navigation"` — "Could not find a declaration file".
- `npx tsc --noEmit` reports zero errors (exit 0).
- Out of scope: file not modified in this plan; issue pre-exists on base commit b0576e02.

## Known Stubs

None — all changes wire real data (tutor chips, conflicts, weekStart) through existing props.

## Threat Flags

None — Plan 03-01 adds no new network endpoints, data sources, or user-input surfaces. The native `title` attribute exposes no information not already visible in the popover.

## Self-Check: PASSED

**Files modified (verified exist):**
- FOUND: src/components/compare/week-overview.tsx
- FOUND: src/components/compare/calendar-grid.tsx
- FOUND: src/components/compare/compare-panel.tsx

**Commits (verified in git log):**
- FOUND: 3e45841 — feat(03-01): add lane tints and sticky lane headers to WeekOverview
- FOUND: fb54510 — feat(03-01): add today indicator line to WeekOverview and CalendarGrid
- FOUND: ce0aaa9 — feat(03-01): replace conflict indicator with count badge and add native hover tooltips
