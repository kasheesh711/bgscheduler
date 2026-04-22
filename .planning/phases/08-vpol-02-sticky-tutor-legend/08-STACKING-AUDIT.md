# Phase 8 Stacking-Context Audit (STICKY-03)

**Committed:** 2026-04-22
**Purpose:** Pre-implementation stacking-context audit required by STICKY-03. Proves that every ancestor from `<html>` to the two Phase 8 sticky targets has been reviewed for `overflow`, `transform`, `filter`, `backdrop-blur`, and `z-index` — so the sticky legend cannot be silently confined by a parent stacking context after we ship.

**Sticky targets covered:**
1. **WeekOverview global sticky legend** (to be added in Plan 03 inside the `flex-1 overflow-y-auto min-h-0` scroll container at `week-overview.tsx:310`).
2. **CalendarGrid sticky day-header** (existing; normalized in Plan 04 at `calendar-grid.tsx:120`).

**Z-index scale (authoritative per 08-CONTEXT.md D-08..D-09):**

| Slot | Constant | Value | Where Used |
|------|----------|-------|------------|
| Content | `Z_INDEX.content` | `1` | Session cards, conflict bands, free-gap tints, today indicator dots, lane tints |
| Legend | `Z_INDEX.legend` | `6` | WeekOverview sticky legend (new) + CalendarGrid sticky day-header (normalized) |
| Popover | `Z_INDEX.popover` | `50` | Base UI `PopoverPrimitive.Portal` default |

Popovers render via React Portal (src/components/ui/popover.tsx:29 `<PopoverPrimitive.Portal>`) with `z-50` on both the Positioner and the Popup, so they render OUTSIDE the compare-panel DOM subtree and above every in-flow element. Confirmed: `50 > 6 > 1`, success criterion #2 satisfied by construction.

***

## Ancestor Chain A — WeekOverview global sticky legend

Target DOM path: `<html> → <body> → <main> (app layout) → <div class="flex-1 flex gap-3 overflow-hidden min-h-0"> (workspace) → <div class="flex flex-col overflow-hidden min-w-0 ..."> (compare column, toggles w-1/2 ↔ w-full on fullscreen) → ComparePanel fragment → <div class="flex-1 min-h-0 mt-1"> (calendar-view wrapper, NO overflow-y-auto in week view) → WeekOverview <div class="flex flex-col h-full overflow-hidden"> → <div class="flex-1 overflow-y-auto min-h-0"> ← **THIS is the scroll-parent; sticky attaches here** → <div class="sticky top-0 ..."> ← target`.

| File:line | Element / classes | overflow | transform | filter | backdrop-blur | z-index | Creates stacking context? | Notes |
|-----------|-------------------|----------|-----------|--------|---------------|---------|---------------------------|-------|
| `src/app/layout.tsx:27` | `<html class="h-full antialiased">` | (visible) | none | none | none | auto | no | No global html-level transforms/filters per globals.css:135-145 base layer. |
| `src/app/layout.tsx:30` | `<body class="h-full flex flex-col overflow-hidden">` | **hidden** | none | none | none | auto | no | `overflow: hidden` on body. Does NOT break sticky inside WeekOverview because the sticky context is scoped to the nearest SCROLLING ancestor (`overflow-y-auto`), which is `week-overview.tsx:310`. Body's hidden only prevents page-level scroll. |
| `src/app/(app)/layout.tsx:7` | `<main class="flex-1 flex flex-col overflow-hidden px-4 lg:px-6 py-3">` | **hidden** | none | none | none | auto | no | Same analysis: non-scrolling `overflow-hidden`; sticky context still scoped to the inner scroll container. |
| `src/components/search/search-workspace.tsx:166` | `<div class="flex-1 flex gap-3 overflow-hidden min-h-0">` | **hidden** | none | none | none | auto | no | `min-h-0` enables the inner scroll container to claim vertical space correctly under flex layout. |
| `src/components/search/search-workspace.tsx:206-210` | `<div class="flex flex-col overflow-hidden min-w-0 transition-all duration-300 ease-in-out {w-1/2 \| w-full}">` | **hidden** | **`transition-all`** (animates width, not transform) | none | none | auto | **no** | **Critical for D-14 (fullscreen preservation):** `transition-all` covers `width` and `padding` but Tailwind's `transition-all` does NOT include `transform`. Zero stacking-context creation. The fullscreen toggle only changes `w-1/2 ↔ w-full` + `pl-1 ↔ pl-0`; the inner ComparePanel DOM is NOT remounted, so the sticky legend survives the toggle. |
| `src/components/compare/compare-panel.tsx:~248` | `<div class="flex-1 min-h-0 mt-1 {overflow-y-auto \| ""}">` | **auto (day view only)** / visible (week view) | none | none | none | auto | no | In **week view** (`activeDay === null`) this is NOT a scroll container, so WeekOverview's own scroll container at `week-overview.tsx:310` owns the sticky context. In **day view** (`activeDay !== null`) this becomes the scroll container for CalendarGrid (see Chain B). |
| `src/components/compare/week-overview.tsx:282` | `<div class="flex flex-col h-full overflow-hidden">` | **hidden** | none | none | none | auto | no | Outer WeekOverview wrapper. Non-scrolling; inner `overflow-y-auto` is the sticky context. |
| `src/components/compare/week-overview.tsx:310` | `<div class="flex-1 overflow-y-auto min-h-0">` | **auto (scroll)** | none | none | none | auto | **yes (scroll container)** | **This is the sticky context for Chain A.** Sticky children compute `top: 0` relative to THIS element. |
| `src/components/compare/week-overview.tsx:{new}` (Plan 03) | `<div class="sticky top-0 bg-background flex items-center gap-3 px-2 border-b border-border/30" style={{ zIndex: Z_INDEX.legend /* 6 */, height: 24 }}>` — the new consolidated legend | visible | none | none | **none (solid bg, per 08-CONTEXT.md Claude's Discretion: prefer solid `bg-background` over `backdrop-blur-sm` for simplicity)** | **6** | **yes** (sticky + z-index creates one) | THE TARGET. Z_INDEX.legend = 6 is above content (1) and below popover (50). |

**Pitfall checks (per D-13):**

- **(c) `overflow-hidden` breaking sticky?** No. The only `overflow-hidden` ancestors are non-scrolling (`<body>`, `<main>`, workspace, compare column, WeekOverview outer). The sticky context is scoped to the nearest SCROLLING ancestor, which is `week-overview.tsx:310` (`overflow-y-auto`). STACK.md:91 pitfall avoided.
- **(d) `transform`/`filter`/`backdrop-blur` creating confining stacking contexts?** No `transform`, `filter`, or `backdrop-filter` on any ancestor from `<html>` to the legend target. Tailwind `transition-all` on the compare column animates width (not transform). The new legend itself uses solid `bg-background` (no `backdrop-blur-sm`) to avoid creating a backdrop-filter stacking context. (Alternative: if `backdrop-blur-sm` is chosen for visual consistency with the retired per-day lane header, the legend ITSELF becomes a stacking context, which is harmless because its `z-index: 6` sits below popover `z-index: 50` on the parent stacking context — popovers render via Portal outside this subtree so portal hoisting applies either way.)
- **(e) Popovers above legend?** Yes. `src/components/ui/popover.tsx:29` uses `<PopoverPrimitive.Portal>` which appends the popover content outside the compare-panel DOM subtree. Both Positioner and Popup carry `z-50` (>`6`). Confirmed rendered ABOVE the sticky legend.

***

## Ancestor Chain B — CalendarGrid sticky day-header (day view)

Target DOM path: same as Chain A up to `compare-panel.tsx:~248`, then `<div class="flex-1 min-h-0 mt-1 overflow-y-auto">` (day view only — `activeDay !== null`) → `<CalendarGrid>` → `<div class="relative ml-[50px]">` → **`<div class="flex border-b sticky top-0 bg-background z-10">` ← target (Plan 04 normalizes `z-10` → `zIndex: Z_INDEX.legend`)**.

| File:line | Element / classes | overflow | transform | filter | backdrop-blur | z-index | Creates stacking context? | Notes |
|-----------|-------------------|----------|-----------|--------|---------------|---------|---------------------------|-------|
| `src/app/layout.tsx:27` | `<html class="h-full antialiased">` | visible | none | none | none | auto | no | Same as Chain A. |
| `src/app/layout.tsx:30` | `<body class="h-full flex flex-col overflow-hidden">` | hidden | none | none | none | auto | no | Same as Chain A. |
| `src/app/(app)/layout.tsx:7` | `<main class="flex-1 flex flex-col overflow-hidden px-4 lg:px-6 py-3">` | hidden | none | none | none | auto | no | Same as Chain A. |
| `src/components/search/search-workspace.tsx:166` | `<div class="flex-1 flex gap-3 overflow-hidden min-h-0">` | hidden | none | none | none | auto | no | Same as Chain A. |
| `src/components/search/search-workspace.tsx:206-210` | compare column (`w-1/2 \| w-full`) | hidden | `transition-all` (width only) | none | none | auto | no | Same as Chain A — fullscreen preservation confirmed. |
| `src/components/compare/compare-panel.tsx:~248` | `<div class="flex-1 min-h-0 mt-1 overflow-y-auto">` (day view) | **auto (scroll)** | none | none | none | auto | **yes (scroll container)** | **This is the sticky context for Chain B** (note: different from Chain A — in day view, the scroll container lives one level higher than in week view). |
| `src/components/compare/calendar-grid.tsx:118` | `<div class="relative ml-[50px]">` | visible | none | none | none | auto | no (but `position: relative` creates a containing block for `absolute` children; does NOT create a stacking context without a z-index) | Fine. |
| `src/components/compare/calendar-grid.tsx:120` (current state — BEFORE Plan 04) | `<div class="flex border-b sticky top-0 bg-background z-10">` | visible | none | none | none | **10** | **yes** (sticky + z-index) | CURRENT value `z-10` will be normalized to `zIndex: Z_INDEX.legend` (6) in Plan 04. The `TutorProfilePopover` click-trigger + popover content rendered via Portal at `z-50` remains ABOVE this sticky header. |
| `src/components/compare/calendar-grid.tsx:120` (AFTER Plan 04) | `<div class="flex border-b sticky top-0 bg-background" style={{ zIndex: Z_INDEX.legend /* 6 */ }}>` | visible | none | none | none | **6** | yes | Post-normalization. Identical stacking behavior vs `z-10` in practice because popovers portal to body at `z-50` (not constrained by this subtree). |

**Pitfall checks for Chain B:**

- **(c) `overflow-hidden` breaking sticky?** No. Sticky context = `compare-panel.tsx:~248` (`overflow-y-auto` in day view). Non-scrolling `overflow-hidden` ancestors above it do not interfere.
- **(d) `transform`/`filter`/`backdrop-blur` creating confining stacking contexts?** None on the chain. `calendar-grid.tsx:120` uses solid `bg-background`, no `backdrop-blur`.
- **(e) Popovers above header?** Yes. `TutorProfilePopover` (inside `calendar-grid.tsx:125-135`) uses the same Base UI Popover primitive with `Portal + z-50`. Renders above the sticky header.

***

## Fullscreen preservation (STICKY-04 / D-14)

The fullscreen toggle at `search-workspace.tsx:206-217` transitions only the **outer compare column's** `width` (and `padding`) from `w-1/2 pl-1` to `w-full pl-0`. Tailwind `transition-all duration-300 ease-in-out` applies to `width` and `padding` but DOES NOT add a `transform` to this element. No React remount occurs (ComparePanel is not key-swapped; the `isFullscreen` prop flows in but the component tree is stable). Therefore:

- The WeekOverview scroll container at `week-overview.tsx:310` is unchanged (same DOM node, same `overflow-y-auto`).
- The sticky legend inside it is unchanged (same DOM node, same `sticky top-0`).
- The column simply becomes wider; the sticky legend widens with it (it's `display: flex` + full-width by default).

D-14 is satisfied BY CONSTRUCTION. No additional plumbing. Plan 05 records a visual verification check.

***

## Summary of findings

- No ancestor breaks sticky via `overflow-hidden` on a scrolling context.
- No ancestor creates a confining stacking context via `transform`, `filter`, or `backdrop-filter`.
- Popovers portal to `<body>` at `z-50`, above the sticky legend's `z-6`.
- Fullscreen toggle preserves sticky by construction — no remount, no transform.
- Two sticky contexts exist (one per view): WeekOverview's internal scroll container in week view; compare-panel's calendar-view wrapper in day view. Both normalized to `Z_INDEX.legend = 6` in Plans 03 + 04.

**Decision:** Proceed with Plan 02 (Z_INDEX constant) → Plan 03 (WeekOverview consolidation) → Plan 04 (CalendarGrid normalization) → Plan 05 (verification). No stacking-context defensive plumbing needed beyond the constant + markup refactor.

***

*Audit completed: 2026-04-22. Referenced by 08-CONTEXT.md D-11..D-13.*
