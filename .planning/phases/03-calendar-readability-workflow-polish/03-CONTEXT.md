# Phase 3: Calendar Readability & Workflow Polish - Context

**Gathered:** 2026-04-16
**Status:** Ready for planning

<domain>
## Phase Boundary

Make multi-tutor compare view visually clear and the search-to-compare workflow one-click. Adds fullscreen compare mode, tutor lane identity, quick-add from search results, today indicator, and numbered conflict badges. No new data fetching or API changes — all frontend work on existing components.

</domain>

<decisions>
## Implementation Decisions

### Quick-add flow
- **D-01:** Add a small "+" icon button at the right edge of each tutor row in the availability grid (`SearchResults`). Always visible, one click to add tutor to compare panel.
- **D-02:** The "+" button also appears in the "Needs Review" section — all tutors can be quick-added for schedule inspection.
- **D-03:** On click, tutor immediately appears as a chip in compare panel. The "+" button briefly flashes green/checkmark to confirm. No toast notification.
- **D-04:** When 3 tutors are already selected (max), the "+" button grays out/disables. Hover shows tooltip "Remove a tutor first (max 3)".
- **D-05:** Existing "Compare (N)" button and checkbox multi-select remain unchanged — quick-add is additive, not a replacement.

### Fullscreen compare
- **D-06:** Add an expand icon button (arrows-out) in the compare panel header area. Click to enter fullscreen, click again (or press Esc) to return to split view.
- **D-07:** In fullscreen mode, the search panel slides left and hides with a smooth CSS transition. Compare panel expands to full viewport width.
- **D-08:** Fullscreen mode retains full functionality — tutor chips, combobox, week picker, "Advanced search" link all remain usable. User can add/remove tutors without leaving fullscreen.
- **D-09:** Quick-add "+" buttons are not visible in fullscreen (search panel is hidden). User uses the combobox to add tutors while in fullscreen.

### Lane identity
- **D-10:** Each tutor's lane column gets their assigned color (`TUTOR_COLORS`) at 5% opacity as a background tint. Visually distinct but not overwhelming.
- **D-11:** Small header label at the top of each day-lane showing tutor name + color dot. Labels are sticky — pinned at the top while user scrolls vertically through the time grid.
- **D-12:** In fullscreen mode, same layout but lanes expand proportionally. Session cards get wider and show more text. No structural layout change.

### Today indicator
- **D-13:** GCal-style thin red horizontal line spanning the full width of today's column at the current time position. Small red dot/circle at the left edge. Updates position periodically via a client-side timer.
- **D-14:** Only visible when viewing the current week. Not shown for past/future weeks.

### Conflict badges
- **D-15:** Small red badge with conflict count number next to each day tab header (e.g. "Mon 13/4 \u2022 2"). User sees at a glance which days have student conflicts.
- **D-16:** Replaces the existing generic conflict indicator — specific count is more useful than a generic icon.

### Claude's Discretion
- Exact CSS transition timing/easing for fullscreen toggle
- Expand icon choice (lucide `Maximize2`, `Expand`, or `ArrowsPointingOut`)
- Whether sticky lane headers use `position: sticky` or a fixed overlay approach
- Today indicator update interval (1-minute vs real-time)
- Exact badge styling (size, font, positioning relative to day tab text)
- Hover tooltip implementation (native `title` vs custom tooltip component)
- Whether session card text wrapping changes in wider fullscreen lanes

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Existing components (modify)
- `src/components/compare/compare-panel.tsx` — Main compare panel component, receives `UseCompareReturn` props
- `src/components/compare/week-overview.tsx` — Week grid with sub-column layout, overlap detection, free-gap computation
- `src/components/compare/calendar-grid.tsx` — Day drill-down view
- `src/components/search/search-results.tsx` — Search results with availability grid, checkbox selection, Compare button
- `src/components/compare/session-colors.ts` — `TUTOR_COLORS`, RGBA helpers, session color functions

### Hooks and state
- `src/hooks/use-compare.ts` — `useCompare` hook with `addTutor`, `removeTutor`, `compareTutors` state
- `src/components/search/search-workspace.tsx` — Top-level layout wiring SearchResults and ComparePanel

### UI components (reuse)
- `src/components/ui/badge.tsx` — Badge component for conflict count
- `src/components/ui/button.tsx` — Button component for expand/quick-add

### Requirements
- `.planning/REQUIREMENTS.md` — CAL-01 through CAL-04, FLOW-01 through FLOW-04, INFRA-02

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `TUTOR_COLORS = ["#3b82f6", "#e67e22", "#7c3aed"]` in `session-colors.ts` — use for lane tinting at 5% opacity
- `rgba()` helper in `session-colors.ts` — already converts hex to rgba with alpha
- `useCompare` hook already exposes `addTutor(id)` — wire directly to "+" button click
- `lucide-react` icon library already installed — use for expand/collapse icons
- `Badge` component from shadcn/ui — reuse for conflict count badges
- `computeOverlapColumns()` in `week-overview.tsx` — sub-column layout already handles multi-tutor

### Established Patterns
- `"use client"` directive on all interactive components
- Dynamic imports via `next/dynamic` with `CalendarSkeleton` fallback (Phase 2 pattern)
- `HOUR_HEIGHT = 48`, `START_HOUR = 7`, `END_HOUR = 21` constants in `week-overview.tsx`
- Session positioning via `minuteToY()` absolute positioning within relative container
- `DISPLAY_DAYS = [1, 2, 3, 4, 5, 6, 0]` (Mon-Sun order)

### Integration Points
- `SearchResults.onCompareSelected` callback — quick-add needs a parallel `onAddSingle(id)` prop from `SearchWorkspace`
- `ComparePanel` receives `compare: UseCompareReturn` — fullscreen state can live in `ComparePanel` (local) or `SearchWorkspace` (if search panel needs to know)
- Day tab headers in `ComparePanel` render the "Mon 13/4" text — add badge inline
- `SearchWorkspace` controls the side-by-side split layout — fullscreen toggle changes its CSS

</code_context>

<specifics>
## Specific Ideas

- User explicitly said the right panel "looks kinda ugly" with multiple tutors — lane identity and fullscreen are direct responses to this
- GCal is the visual reference for today indicator (thin red line)
- The quick-add "+" should feel instant — no loading states, no confirmation dialogs
- Fullscreen should be a smooth slide transition, not a hard cut

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 03-calendar-readability-workflow-polish*
*Context gathered: 2026-04-16*
