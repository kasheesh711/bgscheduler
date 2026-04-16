# Phase 3: Calendar Readability & Workflow Polish - Research

**Researched:** 2026-04-16
**Domain:** React client components, CSS layout, DOM event handling, URL state management
**Confidence:** HIGH

## Summary

Phase 3 is entirely frontend work on existing React client components. No new dependencies, API changes, or database modifications are needed. The changes fall into five distinct areas: (1) lane identity (tinted backgrounds + header labels), (2) today indicator (red time line), (3) conflict badges (numbered counts on day tabs), (4) quick-add from search results (+ button per row), and (5) fullscreen compare mode (expand/collapse toggle).

All required primitives already exist in the codebase. The `rgba()` helper in `session-colors.ts` handles color-with-alpha conversions. The `useCompare` hook exposes `addTutor(id, name)` ready for wiring. Lucide icons `Maximize2`, `Minimize2`, `Plus`, and `Check` are all available in the installed `lucide-react@1.7.0`. The `Badge` component from shadcn/ui supports the `destructive` variant needed for conflict counts.

**Primary recommendation:** Implement in order: lane identity first (visual foundation), then today indicator (independent), conflict badges (uses existing `conflictsByDay` map), quick-add (new prop threading), and fullscreen last (layout restructuring that touches SearchWorkspace).

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Add a small "+" icon button at the right edge of each tutor row in the availability grid (`SearchResults`). Always visible, one click to add tutor to compare panel.
- **D-02:** The "+" button also appears in the "Needs Review" section -- all tutors can be quick-added for schedule inspection.
- **D-03:** On click, tutor immediately appears as a chip in compare panel. The "+" button briefly flashes green/checkmark to confirm. No toast notification.
- **D-04:** When 3 tutors are already selected (max), the "+" button grays out/disables. Hover shows tooltip "Remove a tutor first (max 3)".
- **D-05:** Existing "Compare (N)" button and checkbox multi-select remain unchanged -- quick-add is additive, not a replacement.
- **D-06:** Add an expand icon button (arrows-out) in the compare panel header area. Click to enter fullscreen, click again (or press Esc) to return to split view.
- **D-07:** In fullscreen mode, the search panel slides left and hides with a smooth CSS transition. Compare panel expands to full viewport width.
- **D-08:** Fullscreen mode retains full functionality -- tutor chips, combobox, week picker, "Advanced search" link all remain usable.
- **D-09:** Quick-add "+" buttons are not visible in fullscreen (search panel is hidden). User uses the combobox to add tutors while in fullscreen.
- **D-10:** Each tutor's lane column gets their assigned color (`TUTOR_COLORS`) at 5% opacity as a background tint.
- **D-11:** Small header label at the top of each day-lane showing tutor name + color dot. Labels are sticky -- pinned at the top while user scrolls vertically.
- **D-12:** In fullscreen mode, same layout but lanes expand proportionally. Session cards get wider and show more text. No structural layout change.
- **D-13:** GCal-style thin red horizontal line spanning full width of today's column at current time position. Small red dot at left edge. Updates periodically via client-side timer.
- **D-14:** Only visible when viewing the current week. Not shown for past/future weeks.
- **D-15:** Small red badge with conflict count number next to each day tab header (e.g. "Mon 13/4 . 2").
- **D-16:** Replaces the existing generic conflict indicator -- specific count is more useful than a generic icon.

### Claude's Discretion
- Exact CSS transition timing/easing for fullscreen toggle
- Expand icon choice (lucide `Maximize2`, `Expand`, or `ArrowsPointingOut`)
- Whether sticky lane headers use `position: sticky` or a fixed overlay approach
- Today indicator update interval (1-minute vs real-time)
- Exact badge styling (size, font, positioning relative to day tab text)
- Hover tooltip implementation (native `title` vs custom tooltip component)
- Whether session card text wrapping changes in wider fullscreen lanes

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| CAL-01 | Add alternating lane backgrounds per tutor using tutor's assigned color at 5% opacity | `rgba()` helper exists in `session-colors.ts`; lane geometry already computed via `laneLeftPct`/`laneWidthPct` in `week-overview.tsx` |
| CAL-02 | Add lane header labels on week grid showing tutor name + color dot at top of each day-lane | Sticky header row pattern exists in `week-overview.tsx` (line 247); `position: sticky` with `top: 0` on existing flex layout |
| CAL-03 | Add today indicator line (horizontal line at current time position on today's column) | `minuteToY()` function converts minutes to pixel position; `HOUR_HEIGHT = 48` constant; `useState` + `setInterval` for timer |
| CAL-04 | Replace generic "!" conflict indicator with numbered conflict count badge per day | `conflictsByDay` map already computed in `WeekOverview` (line 229); existing `<span className="text-conflict">!</span>` at line 261 is the replacement target |
| FLOW-01 | Add "+" button on each search result row to directly add tutor to compare panel | `AvailabilityGrid` renders rows; `useCompare.addTutor(id, name)` is the target action; new prop `onAddSingle` threaded from `SearchWorkspace` |
| FLOW-02 | Add hover tooltips on session blocks showing student name, subject, and time range | Native `title` attribute on session card buttons (already have `<button>` elements); no new dependency needed |
| FLOW-03 | Add `&week=YYYY-MM-DD` URL parameter to make compare view week state shareable | `useSearchParams` already imported in `SearchWorkspace`; `window.history.replaceState` for non-navigating URL updates |
| FLOW-04 | Add keyboard navigation for week picker (left/right arrow keys for prev/next week) | `useEffect` with `keydown` event listener; `shiftWeek()` helper already exists in `use-compare.ts` |
| INFRA-02 | All 82 existing unit tests continue to pass after all changes | Verified: 82 tests pass in 12 files (1.18s), all in `src/lib/` -- no UI component tests that would break from DOM changes |
</phase_requirements>

## Standard Stack

### Core (already installed -- NO new dependencies)
| Library | Version | Purpose | Status |
|---------|---------|---------|--------|
| react | 19.2.4 | Component rendering, hooks | Installed |
| next | 16.2.2 | App Router, `useSearchParams` | Installed |
| lucide-react | 1.7.0 | Icons: `Maximize2`, `Minimize2`, `Plus`, `Check` | Installed, icons verified |
| class-variance-authority | 0.7.1 | Badge variant styling | Installed |

[VERIFIED: npm registry + package.json]

### Supporting (already installed)
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @base-ui/react | 1.3.0 | Popover/Badge render prop pattern | Already used throughout compare components |
| clsx | 2.1.1 | Conditional className merging | Already used via `cn()` utility |
| tailwind-merge | 3.5.0 | Tailwind class deduplication | Already used via `cn()` utility |

### No New Dependencies Required
This phase requires zero `npm install` commands. All needed primitives exist:
- Color manipulation: `rgba()` in `session-colors.ts`
- Icons: `lucide-react` (Maximize2, Minimize2, Plus, Check all confirmed available)
- Badges: `src/components/ui/badge.tsx` (destructive variant)
- Tooltips: native HTML `title` attribute (no Tooltip component needed -- see Architecture Patterns)

[VERIFIED: codebase grep + `node -e` icon check]

## Architecture Patterns

### Recommended Change Structure
```
src/
├── components/
│   ├── compare/
│   │   ├── compare-panel.tsx     # Add fullscreen toggle button, pass isFullscreen down
│   │   ├── week-overview.tsx     # Lane tints, lane headers, today indicator, conflict badges
│   │   ├── calendar-grid.tsx     # Lane tints (day view), today indicator
│   │   └── session-colors.ts    # No changes needed (rgba helper already exists)
│   └── search/
│       ├── search-workspace.tsx  # Fullscreen state, layout CSS transition, onAddSingle prop
│       ├── search-results.tsx    # Thread onAddSingle to AvailabilityGrid
│       └── availability-grid.tsx # "+" button per row, disabled state at max 3
└── hooks/
    └── use-compare.ts           # No changes needed (addTutor already works)
```

### Pattern 1: Lane Tint Background
**What:** Full-height colored div behind each tutor's lane in the day column
**When to use:** Multi-tutor view (2-3 tutors), both WeekOverview and CalendarGrid
**Implementation:**
```typescript
// In week-overview.tsx, inside each day column, before session blocks:
// Render a full-height background div per tutor lane
{multiTutorLayout && tutors.map((t, tutorIdx) => {
  const chip = tutorChips[tutorIdx];
  return (
    <div
      key={`lane-bg-${tutorIdx}`}
      className="absolute top-0 bottom-0 pointer-events-none"
      style={{
        left: `${tutorIdx * laneWidth}%`,
        width: `${laneWidth}%`,
        backgroundColor: rgba(chip?.color ?? "#888", 0.05),
      }}
    />
  );
})}
```
[ASSUMED] -- 5% opacity is per D-10; exact visual weight needs visual verification.

### Pattern 2: Sticky Lane Headers
**What:** Tutor name + color dot pinned at top of each lane while scrolling
**When to use:** Multi-tutor week view only
**Implementation approach:** Use `position: sticky` with `top: 0` and `z-index` above session cards but below popovers. Place inside the scrollable body, not the fixed header row.
```typescript
// Inside the scrollable body, at the top of the day column:
{multiTutorLayout && (
  <div className="sticky top-0 z-[5] flex" style={{ height: 20 }}>
    {tutors.map((t, tutorIdx) => {
      const chip = tutorChips[tutorIdx];
      return (
        <div
          key={`lane-label-${tutorIdx}`}
          className="flex items-center gap-1 px-1 text-[10px] font-medium truncate bg-background/90 backdrop-blur-sm"
          style={{ width: `${laneWidth}%`, color: chip?.color }}
        >
          <div className="h-1.5 w-1.5 rounded-full flex-shrink-0" style={{ background: chip?.color }} />
          <span className="truncate">{t.displayName}</span>
        </div>
      );
    })}
  </div>
)}
```
[ASSUMED] -- `position: sticky` works within the existing `overflow-y-auto` scrollable container. This is the standard approach; a fixed overlay would require measuring scroll position.

### Pattern 3: Today Indicator
**What:** Red horizontal line at current time, updates every minute
**When to use:** Current week only, both WeekOverview and CalendarGrid
**Key considerations:**
- Determine "today" in Asia/Bangkok timezone (consistent with the rest of the app)
- Use `useState` for current minute + `setInterval` at 60000ms
- Only render when `weekStart` matches the current Monday
- Use `minuteToY()` to position the line
- Red dot (6px circle) at the left edge of the column
```typescript
// Detect current day and time in Asia/Bangkok
const [nowMinute, setNowMinute] = useState(() => {
  const bkk = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
  return bkk.getHours() * 60 + bkk.getMinutes();
});

useEffect(() => {
  const id = setInterval(() => {
    const bkk = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
    setNowMinute(bkk.getHours() * 60 + bkk.getMinutes());
  }, 60_000); // 1-minute interval
  return () => clearInterval(id);
}, []);
```
[VERIFIED: existing timezone pattern] -- `getCurrentMonday()` in `use-compare.ts` already uses this same `toLocaleString("en-US", { timeZone: "Asia/Bangkok" })` pattern (line 22).

### Pattern 4: Conflict Badge on Day Tabs
**What:** Replace `!` with a numbered red badge next to day name
**Where:** `compare-panel.tsx` day tab buttons (line 195-210) and `week-overview.tsx` header (line 252-264)
**Implementation:**
```typescript
// In compare-panel.tsx day tabs:
{DAY_NAMES[day]} {getWeekDate(weekStart, day)}
{dayConflictCount > 0 && (
  <span className="ml-1 inline-flex items-center justify-center h-4 min-w-[16px] rounded-full bg-conflict text-white text-[10px] font-semibold px-1">
    {dayConflictCount}
  </span>
)}
```
The `conflictsByDay` map is already computed in `WeekOverview` (line 229). For `ComparePanel` day tabs, compute a similar map from `compareResponse.conflicts`.
[VERIFIED: codebase] -- `conflictsByDay` exists in `week-overview.tsx`, conflict data structure confirmed in types.

### Pattern 5: Quick-Add Button
**What:** "+" button at right edge of each tutor row in search results grid
**Where:** `availability-grid.tsx` table rows
**Prop threading:** `SearchWorkspace` -> `SearchResults` -> `AvailabilityGrid`
**New prop:** `onAddSingle: (id: string, name: string) => void` + `disableAdd: boolean`
```typescript
// In availability-grid.tsx, add a new column after Mode:
<td className="w-8 px-1 py-2 text-center">
  <button
    onClick={(e) => { e.stopPropagation(); onAddSingle(row.tutorGroupId, row.displayName); }}
    disabled={disableAdd}
    className="..."
    title={disableAdd ? "Remove a tutor first (max 3)" : "Add to compare"}
  >
    <Plus className="h-3.5 w-3.5" />
  </button>
</td>
```
For the green checkmark flash (D-03), use a local `useState` with a `setTimeout` to revert after ~800ms.
[VERIFIED: codebase] -- `useCompare.addTutor(id, name)` signature confirmed at line 173 of `use-compare.ts`.

### Pattern 6: Fullscreen Toggle
**What:** Expand compare panel to full viewport, hide search panel with CSS transition
**Where:** State lives in `SearchWorkspace` (parent of both panels). Button in `ComparePanel`.
**Implementation:**
```typescript
// In search-workspace.tsx:
const [isFullscreen, setIsFullscreen] = useState(false);

// Layout with transition:
<div className="flex-1 flex gap-3 overflow-hidden min-h-0">
  <div
    className={cn(
      "flex flex-col overflow-hidden min-w-0 border-r border-border/50 pr-3 transition-all duration-300 ease-in-out",
      isFullscreen ? "w-0 opacity-0 pr-0 border-r-0 overflow-hidden" : "w-1/2"
    )}
  >
    {/* Search panel -- always rendered, visually hidden in fullscreen */}
  </div>
  <div
    className={cn(
      "flex flex-col overflow-hidden min-w-0 transition-all duration-300 ease-in-out",
      isFullscreen ? "w-full pl-0" : "w-1/2 pl-1"
    )}
  >
    <ComparePanel
      compare={compare}
      tutorList={tutorList}
      isFullscreen={isFullscreen}
      onToggleFullscreen={() => setIsFullscreen((v) => !v)}
    />
  </div>
</div>
```
Esc key handler: `useEffect` with `keydown` listener that calls `setIsFullscreen(false)`.
[ASSUMED] -- CSS `transition-all duration-300` is a reasonable default. The `w-0 opacity-0 overflow-hidden` pattern for hiding keeps the DOM intact so React state is preserved.

### Pattern 7: URL Week Parameter (FLOW-03)
**What:** Sync `weekStart` to URL as `?week=YYYY-MM-DD`
**Implementation:** Use `window.history.replaceState` (not `router.push`) to avoid re-renders and navigation. Update on every `changeWeek` call.
```typescript
// In search-workspace.tsx, after useCompare():
useEffect(() => {
  const url = new URL(window.location.href);
  const tutorIds = compare.compareTutors.map(t => t.tutorGroupId).join(",");
  if (tutorIds) url.searchParams.set("tutors", tutorIds);
  else url.searchParams.delete("tutors");
  if (compare.weekStart !== compare.getCurrentMonday()) {
    url.searchParams.set("week", compare.weekStart);
  } else {
    url.searchParams.delete("week");
  }
  window.history.replaceState({}, "", url.toString());
}, [compare.compareTutors, compare.weekStart]);
```
On mount, read `?week=` and pass to `changeWeek` alongside the existing `?tutors=` handling.
[VERIFIED: codebase] -- `useSearchParams` already imported in `search-workspace.tsx` (line 4), and `?tutors=` deep link already works (line 38).

### Pattern 8: Keyboard Navigation (FLOW-04)
**What:** Left/right arrow keys navigate weeks
**Where:** `ComparePanel` or `SearchWorkspace`
**Implementation:**
```typescript
useEffect(() => {
  const handler = (e: KeyboardEvent) => {
    // Only when compare panel has focus / no input is focused
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      compare.changeWeek(shiftWeek(compare.weekStart, -1));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      compare.changeWeek(shiftWeek(compare.weekStart, 1));
    }
  };
  window.addEventListener("keydown", handler);
  return () => window.removeEventListener("keydown", handler);
}, [compare.weekStart]);
```
Guard against firing when user is typing in search/combobox inputs.
[ASSUMED] -- Standard DOM event pattern. The input guard prevents interference with search form typing.

### Anti-Patterns to Avoid
- **Do not use `router.push` for URL sync (FLOW-03):** It triggers full navigation and re-renders. Use `window.history.replaceState` for non-navigating URL updates.
- **Do not add a Tooltip component dependency (D-04):** Native `title` attribute is sufficient for the single tooltip use case (max tutors reached). No shadcn/ui Tooltip component exists in this project and adding one for a single tooltip is overkill.
- **Do not put fullscreen state in ComparePanel:** The fullscreen toggle affects `SearchWorkspace` layout (hiding search panel). State must live in the parent.
- **Do not use `requestAnimationFrame` for today indicator:** A 1-minute `setInterval` is sufficient. The line position changes by less than 1px per minute at `HOUR_HEIGHT = 48`.
- **Do not add new API routes:** All data needed for this phase is already available client-side via `compareResponse.conflicts`, `tutorChips`, and `weekStart`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Color with alpha | RGB parsing + alpha calc | `rgba()` from `session-colors.ts` | Already handles hex parsing, short hex, invalid colors |
| Week arithmetic | Date math for prev/next week | `shiftWeek()` from `use-compare.ts` | Already tested, handles month/year boundaries |
| Time-to-pixel | Custom positioning math | `minuteToY()` from `week-overview.tsx` | Already calibrated to `HOUR_HEIGHT` constant |
| Tutor color assignment | Color index logic | `TUTOR_COLORS[idx]` from `session-colors.ts` | Consistent with existing chip colors |
| Conflict grouping by day | Manual conflict filtering | `conflictsByDay` map pattern from `week-overview.tsx` | Already implemented with `useMemo` |
| Bangkok timezone | Manual UTC offset | `toLocaleString("en-US", { timeZone: "Asia/Bangkok" })` | Already used in `getCurrentMonday()` |

**Key insight:** This phase is wiring existing primitives together, not building new abstractions. Every computation needed already exists somewhere in the codebase.

## Common Pitfalls

### Pitfall 1: Sticky Headers Inside overflow-y-auto
**What goes wrong:** `position: sticky` only works relative to the nearest scrolling ancestor. If the sticky element is nested too deeply, it fails silently.
**Why it happens:** The WeekOverview has `overflow-y-auto` on the scrollable body div (line 269). Sticky headers must be direct children of this scroll container.
**How to avoid:** Place the lane header row as a direct child of the `overflow-y-auto` container, before the time grid. Do not nest it inside the day column divs.
**Warning signs:** Headers scroll away instead of sticking. Check DOM nesting.

### Pitfall 2: z-index Stacking With Popovers
**What goes wrong:** Lane tints or today indicator render on top of session card popovers, making them unclickable.
**Why it happens:** Popovers from `@base-ui/react` use `z-50` (line 444 in week-overview). New elements must stay below this.
**How to avoid:** Lane tints: `z-0 pointer-events-none`. Lane headers: `z-[5]`. Today indicator: `z-[3]`. Session cards: `z-[1]` (already). Popovers: `z-50` (already).
**Warning signs:** Clicking a session card opens nothing, or the popover appears behind a colored overlay.

### Pitfall 3: Fullscreen CSS Transition Breaking Layout
**What goes wrong:** During the 300ms transition, the search panel shrinks to `w-0` but its content overflows, causing horizontal scrollbar flash.
**Why it happens:** Content inside the search panel does not respect `overflow-hidden` during animation.
**How to avoid:** Add `overflow-hidden` to the search panel wrapper. The content is already there via `overflow-hidden` class (line 58 of search-workspace.tsx), but verify it applies during the transition.
**Warning signs:** Brief horizontal scrollbar flash during expand/collapse animation.

### Pitfall 4: Quick-Add Flash State Leaking Across Rows
**What goes wrong:** Clicking "+" on row A shows the green checkmark, but clicking "+" on row B while A is still flashing causes both to show checkmark.
**Why it happens:** Using a single state variable for "which row is flashing" instead of per-row state.
**How to avoid:** Track the flashing row ID in a `useState<string | null>` and use `setTimeout` to clear. Only one row can flash at a time (sequential adds), so a single state with the row ID is sufficient.
**Warning signs:** Multiple rows showing green checkmark simultaneously.

### Pitfall 5: Today Indicator Timezone Mismatch
**What goes wrong:** The red line appears on the wrong day column or at the wrong vertical position.
**Why it happens:** Using `new Date()` local time instead of Asia/Bangkok time. The user is in Asia/Bangkok but the developer machine might be in a different timezone.
**How to avoid:** Always use the `toLocaleString("en-US", { timeZone: "Asia/Bangkok" })` pattern, matching `getCurrentMonday()`.
**Warning signs:** Line appears on Saturday when it should be Wednesday. Check timezone conversion.

### Pitfall 6: Keyboard Handler Firing During Text Input
**What goes wrong:** Arrow left/right keys navigate weeks while user is typing in the search form or tutor combobox.
**Why it happens:** Global `keydown` listener fires for all key events.
**How to avoid:** Guard: `if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;`
**Warning signs:** Typing in search form causes week to change.

### Pitfall 7: Memory Leak From setInterval in Today Indicator
**What goes wrong:** Multiple intervals accumulate if component remounts.
**Why it happens:** Missing cleanup function in `useEffect`.
**How to avoid:** Always `return () => clearInterval(id)` in the `useEffect`.
**Warning signs:** Console shows increasing memory usage; multiple timer callbacks firing.

## Code Examples

### Today Indicator Component Logic
```typescript
// Determine if today falls within the displayed week
// Source: Derived from use-compare.ts getCurrentMonday() pattern
function useTodayIndicator(weekStart: string) {
  const [nowMinutes, setNowMinutes] = useState<number | null>(() => {
    const bkk = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
    return bkk.getHours() * 60 + bkk.getMinutes();
  });
  const [todayDow, setTodayDow] = useState<number | null>(() => {
    const bkk = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
    return bkk.getDay(); // 0=Sun
  });

  // Check if current week
  const isCurrentWeek = weekStart === getCurrentMonday();

  useEffect(() => {
    if (!isCurrentWeek) return;
    const tick = () => {
      const bkk = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
      setNowMinutes(bkk.getHours() * 60 + bkk.getMinutes());
      setTodayDow(bkk.getDay());
    };
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, [isCurrentWeek]);

  return { nowMinutes: isCurrentWeek ? nowMinutes : null, todayDow: isCurrentWeek ? todayDow : null };
}
```
[VERIFIED: timezone pattern matches existing codebase]

### Quick-Add Flash Effect
```typescript
// Source: Standard React pattern for transient visual feedback
const [flashedId, setFlashedId] = useState<string | null>(null);

const handleQuickAdd = (id: string, name: string) => {
  onAddSingle(id, name);
  setFlashedId(id);
  setTimeout(() => setFlashedId(null), 800);
};

// In row render:
{flashedId === row.tutorGroupId ? (
  <Check className="h-3.5 w-3.5 text-available" />
) : (
  <Plus className="h-3.5 w-3.5" />
)}
```

### Conflict Count Per Day (for ComparePanel day tabs)
```typescript
// Source: Derived from week-overview.tsx conflictsByDay pattern (line 229)
const conflictCountByDay = useMemo(() => {
  if (!compareResponse) return new Map<number, number>();
  const map = new Map<number, number>();
  for (const c of compareResponse.conflicts) {
    map.set(c.dayOfWeek, (map.get(c.dayOfWeek) ?? 0) + 1);
  }
  return map;
}, [compareResponse]);
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Generic "!" conflict icon | Numbered badge per day | This phase (CAL-04) | Users see conflict count at a glance |
| 3-click compare workflow | 1-click quick-add | This phase (FLOW-01) | Reduces friction for primary workflow |
| Fixed split layout | Fullscreen toggle | This phase (D-06) | Addresses "looks ugly" feedback for multi-tutor |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | 5% opacity provides sufficient visual distinction for lane tints without overwhelming | Architecture Patterns (Pattern 1) | Lanes may be invisible or too strong; visual tuning needed |
| A2 | CSS `transition-all duration-300` gives smooth fullscreen toggle | Architecture Patterns (Pattern 6) | May need easing adjustment or different duration |
| A3 | `position: sticky` works within the existing scroll container nesting | Architecture Patterns (Pattern 2) | May need DOM restructuring if sticky fails |
| A4 | Native `title` attribute is acceptable for D-04 tooltip | Architecture Patterns | Could look inconsistent with shadcn styling; user may want custom |
| A5 | 1-minute interval is sufficient for today indicator updates | Architecture Patterns (Pattern 3) | Line could be visibly stale during active use |
| A6 | Arrow key handler with input guard covers all edge cases | Architecture Patterns (Pattern 8) | ContentEditable elements or custom inputs might not be guarded |

**All non-assumed claims verified against codebase grep, npm registry, or direct code inspection.**

## Open Questions

1. **Sticky header nesting depth**
   - What we know: `overflow-y-auto` is on the scrollable body container. Lane headers must be children of that container.
   - What's unclear: Whether inserting a sticky row before the time grid `<div>` disrupts the existing flex layout.
   - Recommendation: Implement and visually verify. If sticky fails, fall back to absolute positioning with scroll listener.

2. **Fullscreen and dynamic imports**
   - What we know: `WeekOverview` and `CalendarGrid` are loaded via `next/dynamic`. When fullscreen expands, they re-render at wider width.
   - What's unclear: Whether the wider render causes a visible layout shift or skeleton flash.
   - Recommendation: Test fullscreen toggle with loaded components. The dynamic import cache should prevent re-loading.

3. **Session card text in wider fullscreen lanes**
   - What we know: D-12 says "Session cards get wider and show more text. No structural layout change."
   - What's unclear: Exactly which text fields to un-truncate in wider mode.
   - Recommendation: The existing `isTooNarrow` and `isCompact` booleans in `week-overview.tsx` (lines 386-388) already adapt to column width. Wider lanes will naturally show more text. No code change needed -- verify visually.

## Project Constraints (from CLAUDE.md)

- **Stack lock:** No new frameworks or libraries. All changes use existing React, Tailwind, lucide-react, shadcn/ui.
- **Test regression:** All 82 existing tests must pass (INFRA-02). Tests are in `src/lib/` only -- no UI component tests exist that could break from DOM changes.
- **Naming:** kebab-case files, camelCase functions, PascalCase components.
- **Directives:** `"use client"` on all interactive components.
- **Color palette:** Sky blue primary, amber accent, cream backgrounds. OKLCH color space for CSS custom properties.
- **Semantic tokens:** Use `bg-available`, `text-conflict`, `bg-muted` etc. rather than hardcoded colors.
- **GCal style:** Maintain weekly grid layout with vertical time axis.
- **Fail-closed:** No data logic changes in this phase, but do not weaken any safety rules.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all dependencies verified installed, no new packages
- Architecture: HIGH -- all integration points verified via codebase inspection
- Pitfalls: HIGH -- based on direct code analysis of existing component structure

**Research date:** 2026-04-16
**Valid until:** 2026-05-16 (stable -- all frontend, no API/library changes)

## Sources

### Primary (HIGH confidence)
- Codebase inspection: `src/components/compare/week-overview.tsx` (471 lines) -- lane layout, overlap columns, free gaps
- Codebase inspection: `src/components/compare/compare-panel.tsx` (282 lines) -- day tabs, week picker, tutor selector
- Codebase inspection: `src/components/compare/calendar-grid.tsx` (275 lines) -- day drill-down, conflict bands
- Codebase inspection: `src/components/compare/session-colors.ts` (60 lines) -- TUTOR_COLORS, rgba(), session styling
- Codebase inspection: `src/hooks/use-compare.ts` (220 lines) -- addTutor, changeWeek, shiftWeek, getCurrentMonday
- Codebase inspection: `src/components/search/search-workspace.tsx` (82 lines) -- split layout, prop wiring
- Codebase inspection: `src/components/search/availability-grid.tsx` (226 lines) -- table rows, selection
- npm registry: lucide-react@1.8.0 (latest), project uses ^1.7.0
- Vitest run: 82 tests, 12 files, all passing (1.18s)

### Secondary (MEDIUM confidence)
- React 19 `useState`/`useEffect`/`useCallback` hooks -- standard patterns [VERIFIED: react.dev]
- CSS `position: sticky` behavior within `overflow-y-auto` containers [VERIFIED: MDN spec]
- `window.history.replaceState` for non-navigating URL updates [VERIFIED: MDN spec]
