# Phase 09: VPOL-03 Density Overview - Research

**Researched:** 2026-05-05 [VERIFIED: environment_context]
**Domain:** Client-side React/Tailwind density overview for the existing compare panel [VERIFIED: `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md`]
**Confidence:** HIGH for integration/data/a11y constraints; MEDIUM for final visual fit until the design-review artifact is completed [VERIFIED: codebase grep + W3C/React/Next docs listed in Sources]

<user_constraints>
## User Constraints (from CONTEXT.md)

The following locked decisions, discretion areas, and deferred ideas are copied from `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md`. [VERIFIED: `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md`]

### Locked Decisions

### Density Shape

- **D-01:** **Choose Shape B: per-tutor stacked density rows.** Render one compact row per selected tutor, with seven day cells across the visible Monday-Sunday week. This is the strongest compare-specific shape because it exposes per-tutor load differences instead of collapsing all selected tutors into one aggregate.
- **D-02:** Each row uses the existing tutor color identity from `TUTOR_COLORS` / `tutorChips`; color identifies the tutor, while fill/length/height and text equivalents communicate density. Do not introduce a new density palette that competes with session-card identity colors.
- **D-03:** Aggregate only the visible week. Compute per tutor/day from `CompareTutor.sessions` already returned by `/api/compare`; use `CompareTutor.weeklyHoursBooked` where useful for row labels. Do not build a 180-day mini-map.
- **D-04:** Create a short design-review artifact during planning/execution that records the A/B/C comparison and states why B was chosen: best fit for 3-tutor comparison, medium complexity accepted, better value than aggregate A or heatmap C.

### Placement

- **D-05:** Place the density overview **between the day tabs and the calendar body** in `ComparePanel`. It should sit immediately above the `WeekOverview` / `CalendarGrid` render area, so it summarizes the calendar without occupying the week-picker or tutor-selector rows.
- **D-06:** Keep it separate from the Phase 8 sticky tutor legend. Do not fold density into the sticky legend strip; Phase 8 intentionally kept the sticky legend as identity-only.
- **D-07:** The density overview should remain visible in both week view and day drill-down view while a compare response is loaded. The selected day state may be visually indicated, but the component should still summarize the full visible week.

### A11y / Readability Contract

- **D-08:** Use **compact visible labels plus text equivalents**. Each tutor row shows the tutor name and booked-hours summary. Each tutor/day segment exposes a short text equivalent such as "Mon: Kevin, 3 hours booked, 2 sessions" through `aria-label`, `title`, or equivalent accessible labeling.
- **D-09:** Density must not be color-only. Segment fill/length/height plus the visible booked-hours label provide the secondary encoding; color is only tutor identity.
- **D-10:** No animated fill, pulse, shimmer, or delayed reveal. Rendering should be static by default; `prefers-reduced-motion` must see no density-specific animation.
- **D-11:** Do not implement a custom arrow-key grid in Phase 9. Clickable segments should remain normal buttons/controls with standard keyboard activation where applicable, but roving focus / arrow navigation is out of scope.

### Interaction Scope

- **D-12:** Clicking a tutor/day density segment switches to the existing day drill-down for that weekday via the existing `setActiveDay` / `onDayClick` path. This is navigation into an existing view, not a new scheduling action.
- **D-13:** Do not implement click-to-jump-to-hour in Phase 9. The click target opens the day; it does not scroll to a segment's time bucket or highlight a tutor's sessions.
- **D-14:** Do not add utilisation percentages, shared-free-slot markers, or richer stats beyond booked hours / session-count text equivalents. Those remain differentiators for v1.2+ if users ask for more density intelligence.

### Data / Performance Contract

- **D-15:** Density data derives client-side from the existing `CompareResponse.tutors[].sessions[]` and `availabilityWindows` using `useMemo`. No new API route, no new DB query, no SearchIndex change, and no schema change.
- **D-16:** Research Pitfall 11's separate density API recommendation is superseded for this phase by DENS-03 and visible-week scope. Mitigate re-render churn with a small memoized component and stable derived inputs, not backend work.
- **D-17:** No `CACHE_VERSION` bump is expected because Phase 9 should not change `CompareTutor`, `CompareSessionBlock`, or `CompareResponse` shape. If planning discovers an unavoidable cached-response shape change, the plan must call that out explicitly and bump `CACHE_VERSION` to `"v3"` with a migration-history comment.

### Claude's Discretion

- Exact component name (`DensityOverview`, `DensityMiniMap`, or similar) and exact DOM/SVG implementation.
- Whether each tutor/day segment is a simple button, an SVG `<rect>` wrapped by a button, or a Tailwind-styled div/button grid.
- Exact density formula, provided it is derived from visible-week sessions and availability windows and handles zero availability without divide-by-zero or misleading "full" states.
- Exact row height and spacing, provided the overview remains compact and does not squeeze the GCal grid.
- Exact visual treatment for the selected day, hover state, and focus ring, provided text does not overflow at 3 tutors on a 13-inch display.

### Deferred Ideas (OUT OF SCOPE)

- DENS-05 click-to-jump-to-hour - defer. Phase 9 click only opens the day drill-down.
- DENS-06 utilisation percentage summary - defer. Booked hours are allowed; utilisation % is not.
- Shared-free-slot density overlay - defer; it is useful but not required by DENS-01..04.
- Full-month / 180-day density heatmap - defer/reject for v1.1; Phase 9 is visible-week scope.
- Density as a replacement calendar view - explicitly rejected; keep the GCal grid.
- Chart libraries (`recharts`, `visx`, `d3`) - explicitly rejected for this bounded overview.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| DENS-01 | Density overview component renders aggregated per-tutor booking density across the visible week | Add `src/components/compare/density-overview.tsx` as a `ComparePanel` sibling between day tabs and the calendar body; compute 1-3 tutor rows x 7 day cells from `CompareTutor.sessions`. [VERIFIED: `.planning/REQUIREMENTS.md`; `src/components/compare/compare-panel.tsx:209-272`; `src/lib/search/types.ts:131-141`] |
| DENS-02 | Shape A/B/C chosen via phase-local design review | Create `.planning/phases/09-vpol-03-density-overview/09-DENSITY-DESIGN-REVIEW.md` documenting A/B/C and locking Shape B per CONTEXT D-01/D-04. [VERIFIED: `.planning/REQUIREMENTS.md`; `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md`] |
| DENS-03 | Density data derived client-side from existing `CompareResponse.tutors[].sessions[]` via `useMemo` with zero server work | Use the existing `/api/compare` response shape; do not touch API routes, `SearchIndex`, DB schema, or `CACHE_VERSION` unless a response-shape change is discovered. [VERIFIED: `src/app/api/compare/route.ts:138-182`; `src/lib/search/types.ts:113-166`; `src/lib/search/cache-version.ts:1-22`] |
| DENS-04 | Density overview respects reduced motion and has text-equivalent a11y affordances | Render static buttons with visible row labels, `aria-label`/`title` per segment, no density-specific animation classes, and standard button keyboard activation. [CITED: W3C WCAG 2.2 Use of Color; W3C APG Button Pattern; MDN prefers-reduced-motion] |
</phase_requirements>

## Summary

Phase 9 should be planned as a small client-only compare-panel enhancement: one new density overview component, one pure aggregation helper, one design-review artifact, and one focused test file. [VERIFIED: `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md`; `src/components/compare/compare-panel.tsx:209-272`]

The data already exists in `CompareResponse.tutors[].sessions[]`, `CompareTutor.availabilityWindows`, and `CompareTutor.weeklyHoursBooked`; the API route already returns those fields for the visible week. [VERIFIED: `src/lib/search/types.ts:113-166`; `src/app/api/compare/route.ts:138-182`; `src/lib/search/compare.ts:225-325`] Therefore the planner should explicitly reject the older Pitfall 11 backend-density recommendation, because that recommendation targeted a 180-day density horizon while this phase is locked to the visible week and zero server work. [VERIFIED: `.planning/research/PITFALLS.md`; `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md`]

**Primary recommendation:** Implement `DensityOverview` as a normal client component imported by `ComparePanel`, render per-tutor stacked rows above both `WeekOverview` and `CalendarGrid`, compute visible-week density in `useMemo`, and verify with pure Vitest unit tests plus a small server-rendered accessibility markup test. [VERIFIED: codebase grep; CITED: React useMemo docs]

## Project Constraints (from AGENTS.md)

- The project uses Next.js 16 App Router, TypeScript, Tailwind, shadcn/ui, Auth.js, Drizzle, Neon Postgres, Vercel, and Vitest; this phase must not replace that stack. [VERIFIED: `AGENTS.md`; `package.json`; `npm ls`]
- The project instructions state that Next.js 16 has breaking changes and relevant docs under `node_modules/next/dist/docs/` must be read before writing code. [VERIFIED: `AGENTS.md`; `node_modules/next/dist/docs/01-app/03-api-reference/01-directives/use-client.md`]
- Production truth comes from Wise API snapshots, and the app must never weaken the strict-fidelity/fail-closed rules without explicit approval. [VERIFIED: `AGENTS.md`]
- The compare UI must preserve the GCal-style calendar grid and sky-blue product palette. [VERIFIED: `AGENTS.md`; `.planning/PROJECT.md`] 
- `CLAUDE.md` is not present in the repo; `AGENTS.md` and GSD planning docs are the active project-instruction sources for this research. [VERIFIED: `cat CLAUDE.md` exited 1; `cat AGENTS.md` succeeded]
- No project-local `.claude/skills/` or `.agents/skills/` `SKILL.md` index was found before research synthesis. [VERIFIED: `find .claude/skills .agents/skills -maxdepth 2 -name SKILL.md`]

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Next.js | 16.2.2 installed; registry latest 16.2.4; 16.2.2 published 2026-04-01 | Existing App Router runtime and client/server boundary | Locked project stack; `ComparePanel` is already a client component and can import a small sibling component directly. [VERIFIED: `npm ls`; VERIFIED: npm registry; VERIFIED: Next local docs] |
| React | 19.2.4 installed; registry latest 19.2.5; 19.2.4 published 2026-01-26 | Component rendering and hooks | Use `useMemo` for pure derived density data and optional `memo` for parent re-render churn. [VERIFIED: `npm ls`; VERIFIED: npm registry; CITED: https://react.dev/reference/react/useMemo; CITED: https://react.dev/reference/react/memo] |
| React DOM | 19.2.4 installed; registry latest 19.2.5; 19.2.4 published 2026-01-26 | Browser rendering and optional server-rendered markup tests | Existing dependency supports `react-dom/server` tests without adding a DOM testing library. [VERIFIED: `npm ls`; VERIFIED: npm registry; VERIFIED: `package.json`] |
| Tailwind CSS | 4.2.2 installed; registry latest 4.2.4; 4.2.2 published 2026-03-18 | Styling compact rows, focus rings, fixed dimensions, semantic tokens | Existing components already use Tailwind utility classes and CSS custom color tokens. [VERIFIED: `npm ls`; VERIFIED: npm registry; VERIFIED: `src/app/globals.css:7-17`] |
| Vitest | 4.1.5 installed; registry latest 4.1.5; 4.1.5 published 2026-04-21 | Unit tests for aggregation and component markup | Existing test runner is node-environment Vitest with `.test.ts`/`.test.tsx` support. [VERIFIED: `npm ls`; VERIFIED: npm registry; VERIFIED: `vitest.config.ts`] |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| lucide-react | 1.7.0 installed; registry latest 1.14.0; 1.7.0 published 2026-03-25 | Existing icon library | Only use if the density review needs a small label/icon; no icon is required for the core density rows. [VERIFIED: `npm ls`; VERIFIED: npm registry; VERIFIED: `AGENTS.md`] |
| clsx / tailwind-merge via `cn()` | clsx 2.1.1, tailwind-merge 3.5.0 installed; both latest at registry check time | Conditional class assembly | Use project `cn()` if classes become conditional; inline template classes are also established locally. [VERIFIED: `npm ls`; VERIFIED: npm registry; VERIFIED: `AGENTS.md`] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Tailwind-styled buttons/divs or tiny inline SVG | `recharts`, `visx`, `d3`, `@tanstack/react-charts` | Rejected: this phase renders at most 21 tutor/day cells, so chart libraries add bundle and API surface without solving a real problem. [VERIFIED: `.planning/research/STACK.md`; `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md`] |
| Client-side `useMemo` helper | `POST /api/compare/density` | Rejected: DENS-03 and CONTEXT D-15 forbid server work, and the route already returns visible-week sessions. [VERIFIED: `.planning/REQUIREMENTS.md`; `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md`; `src/app/api/compare/route.ts:138-182`] |
| Normal `button` controls | Custom ARIA grid with roving focus | Rejected for Phase 9: CONTEXT D-11 explicitly keeps custom arrow-key grid navigation out of scope. [VERIFIED: `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md`; CITED: W3C APG Button Pattern] |
| Existing React state | Zustand/Jotai/Valtio | Rejected: density is a derivation of existing compare data and needs no independent state store. [VERIFIED: `.planning/research/STACK.md`; `src/hooks/use-compare.ts:76-230`] |

**Installation:** No package installation is required for Phase 9. [VERIFIED: `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md`; `package.json`; `npm ls`]

**Version verification:** Package versions were checked with `npm ls` and npm registry metadata. The default npm cache had an EPERM issue under `~/.npm`; registry checks succeeded with `npm --cache /private/tmp/npm-cache view ...`. [VERIFIED: terminal commands in research session]

## Architecture Patterns

### Recommended Project Structure

```text
src/
├── components/
│   └── compare/
│       ├── compare-panel.tsx           # import and place density overview between day tabs and calendar body
│       ├── density-overview.tsx        # new small client component + exported pure aggregation helper
│       └── __tests__/
│           └── density-overview.test.tsx # helper tests + renderToStaticMarkup a11y checks
└── lib/
    └── search/
        ├── types.ts                    # unchanged: existing CompareTutor/CompareResponse are enough
        └── cache-version.ts            # unchanged at "v2" unless response shape changes
```

This structure matches existing compare component/test placement and avoids API/schema/SearchIndex changes. [VERIFIED: `find src/components -maxdepth 3 -type f`; `src/lib/search/types.ts:113-166`; `src/lib/search/cache-version.ts:1-22`]

### Pattern 1: Component Placement In ComparePanel

**What:** Import `DensityOverview` normally and render it after the day tabs and before the `Calendar view` wrapper. [VERIFIED: `src/components/compare/compare-panel.tsx:209-272`]

**When to use:** Use this exact placement because it keeps the overview visible for both `activeDay === null` week view and `activeDay !== null` day drill-down. [VERIFIED: `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md`; `src/components/compare/compare-panel.tsx:247-272`]

**Example:**

```tsx
// Source: src/components/compare/compare-panel.tsx:209-272 + 09-CONTEXT D-05/D-07
<DensityOverview
  tutors={compareResponse.tutors}
  tutorChips={compareTutors}
  activeDay={activeDay}
  onDayClick={handleDensityDayClick}
/>

<div className={`flex-1 min-h-0 mt-1 ${activeDay !== null ? "overflow-y-auto" : ""}`}>
  {activeDay !== null ? (
    <CalendarGrid ... />
  ) : (
    <WeekOverview ... />
  )}
</div>
```

### Pattern 2: Visible-Week Density Derivation

**What:** Export a pure helper that groups each tutor's visible-week `sessions` by weekday and returns booked minutes, session count, weekly hours, and a display fill value. [VERIFIED: `src/lib/search/types.ts:113-141`; `src/lib/search/compare.ts:293-316`]

**When to use:** Use inside `useMemo(() => buildDensityRows(tutors, tutorChips), [tutors, tutorChips])`; do not depend on the whole `compare` object or unrelated UI state. [CITED: React useMemo docs; VERIFIED: `src/hooks/use-compare.ts:207-230`]

**Example:**

```tsx
// Source: src/lib/search/types.ts:131-141; 09-CONTEXT D-03/D-15
const DISPLAY_DAYS = [1, 2, 3, 4, 5, 6, 0] as const;

export function buildDensityRows(tutors: CompareTutor[], tutorChips: TutorChip[]) {
  const cells = tutors.flatMap((tutor) =>
    DISPLAY_DAYS.map((weekday) => {
      const sessions = tutor.sessions.filter((s) => s.weekday === weekday);
      const bookedMinutes = sessions.reduce(
        (sum, s) => sum + Math.max(0, s.endMinute - s.startMinute),
        0,
      );
      const availableMinutes = tutor.availabilityWindows
        .filter((w) => w.weekday === weekday)
        .reduce((sum, w) => sum + Math.max(0, w.endMinute - w.startMinute), 0);

      return { tutor, weekday, sessions, bookedMinutes, availableMinutes };
    }),
  );

  const maxBookedMinutes = Math.max(60, ...cells.map((cell) => cell.bookedMinutes));

  return tutors.map((tutor, tutorIndex) => ({
    tutorGroupId: tutor.tutorGroupId,
    displayName: tutor.displayName,
    color: tutorChips[tutorIndex]?.color ?? "#888888",
    weeklyHoursBooked: tutor.weeklyHoursBooked,
    days: DISPLAY_DAYS.map((weekday) => {
      const cell = cells.find(
        (candidate) =>
          candidate.tutor.tutorGroupId === tutor.tutorGroupId &&
          candidate.weekday === weekday,
      )!;
      return {
        weekday,
        bookedMinutes: cell.bookedMinutes,
        sessionCount: cell.sessions.length,
        availableMinutes: cell.availableMinutes,
        fillRatio: cell.bookedMinutes / maxBookedMinutes,
      };
    }),
  }));
}
```

This helper intentionally does not calculate or display a utilization percentage, which keeps DENS-06 out of scope. [VERIFIED: `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md`]

### Pattern 3: Accessible Compact Segments

**What:** Each tutor/day segment should be a native `<button type="button">` with a concise `aria-label`, a matching `title`, visible fill geometry, and focus-visible ring styling. [CITED: W3C APG Button Pattern; CITED: W3C WCAG 2.2 Keyboard]

**When to use:** Use for the Phase 9 click target because button activation via Enter/Space is standard and no custom arrow-key grid is in scope. [VERIFIED: `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md`; CITED: W3C APG Button Pattern]

**Example:**

```tsx
// Source: W3C APG Button Pattern + 09-CONTEXT D-08/D-11/D-12
<button
  type="button"
  aria-label={`${dayName}: ${row.displayName}, ${formatHours(day.bookedMinutes)} booked, ${day.sessionCount} sessions`}
  title={`${dayName}: ${row.displayName}, ${formatHours(day.bookedMinutes)} booked, ${day.sessionCount} sessions`}
  aria-current={activeDay === day.weekday ? "date" : undefined}
  onClick={() => onDayClick(day.weekday)}
  className="group relative h-7 min-w-0 rounded-sm border border-border/60 bg-muted/30 p-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
>
  <span
    className="block h-full rounded-[2px]"
    style={{
      width: `${Math.max(day.fillRatio * 100, day.bookedMinutes > 0 ? 12 : 0)}%`,
      backgroundColor: rgba(row.color, 0.24),
      borderLeft: day.bookedMinutes > 0 ? `3px solid ${row.color}` : undefined,
    }}
  />
  <span className="sr-only">{formatHours(day.bookedMinutes)} booked</span>
</button>
```

### Pattern 4: Memoization Boundary

**What:** Wrap the visual component in `memo` and keep `onDayClick` stable with `useCallback` or by passing the stable state setter. [CITED: React memo docs; VERIFIED: `src/components/compare/compare-panel.tsx:57-83`; `src/hooks/use-compare.ts:207-230`]

**When to use:** Use to avoid re-rendering the density component when `ComparePanel` changes unrelated local state such as the week-calendar popover. [VERIFIED: `src/components/compare/compare-panel.tsx:57-83`; CITED: React memo docs]

**Example:**

```tsx
// Source: React memo/useMemo docs; src/components/compare/compare-panel.tsx
const handleDensityDayClick = useCallback((day: number) => {
  setActiveDay(day);
}, [setActiveDay]);

export const DensityOverview = memo(function DensityOverview(props: DensityOverviewProps) {
  const rows = useMemo(
    () => buildDensityRows(props.tutors, props.tutorChips),
    [props.tutors, props.tutorChips],
  );
  // render rows...
});
```

### Anti-Patterns To Avoid

- **Adding a density endpoint:** The visible-week compare response already contains the required fields, and DENS-03 forbids server work. [VERIFIED: `.planning/REQUIREMENTS.md`; `src/app/api/compare/route.ts:138-182`]
- **Embedding density logic inside `WeekOverview` or `CalendarGrid`:** The overview must remain visible in both render branches, so `ComparePanel` is the clean ownership boundary. [VERIFIED: `src/components/compare/compare-panel.tsx:247-272`; `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md`]
- **Folding density into the sticky legend:** Phase 8 intentionally left the sticky legend identity-only, and Phase 9 placement is separate. [VERIFIED: `.planning/phases/08-vpol-02-sticky-tutor-legend/08-CONTEXT.md`; `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md`]
- **Using color intensity as the only encoding:** WCAG 2.2 SC 1.4.1 requires another visual means such as text, shape, or pattern when color conveys information. [CITED: https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html]
- **Adding animation classes:** Phase 9 is static by default and must not add density-specific animation, shimmer, pulse, or delayed fill. [VERIFIED: `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md`; CITED: MDN prefers-reduced-motion]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Charting 1-3 tutors x 7 days | `recharts`, `d3`, `visx`, canvas renderer | Native buttons/divs or tiny inline SVG with Tailwind | The bounded visible-week shape is too small to justify a visualization dependency. [VERIFIED: `.planning/research/STACK.md`; `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md`] |
| Density data service | `/api/compare/density`, DB query, SearchIndex field | `useMemo` over `compareResponse.tutors` | The API already returns visible-week sessions and DENS-03 requires zero server work. [VERIFIED: `src/app/api/compare/route.ts:138-182`; `.planning/REQUIREMENTS.md`] |
| Custom ARIA grid navigation | Roving focus / arrow-key controller | Native button tab order and Enter/Space activation | Phase 9 explicitly excludes custom arrow-key grid behavior. [VERIFIED: `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md`; CITED: W3C APG Button Pattern] |
| Client state store | Density-specific Zustand/Jotai atom/cache | Derived rows from props | Density is a presentation layer over compare state, not independent state. [VERIFIED: `src/hooks/use-compare.ts:76-230`; `.planning/research/STACK.md`] |
| Cache migration | `CACHE_VERSION` bump or new cache key | Leave `CACHE_VERSION = "v2"` unchanged | No response-shape change is expected in Phase 9. [VERIFIED: `src/lib/search/cache-version.ts:1-22`; `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md`] |

**Key insight:** For this phase, custom infrastructure is worse than simple derivation because every server/cache/schema addition contradicts DENS-03 and increases the risk surface without adding data fidelity. [VERIFIED: `.planning/REQUIREMENTS.md`; `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md`; `.planning/research/ARCHITECTURE.md`]

## Common Pitfalls

### Pitfall 1: Following Old Pitfall 11 Literally

**What goes wrong:** Prior research Pitfall 11 recommends a separate density API and cache for a 180-day mini-map. [VERIFIED: `.planning/research/PITFALLS.md`]  
**Why it happens:** That older recommendation assumed 22k+ density cells, while Phase 9 is now locked to at most 21 tutor/day cells. [VERIFIED: `.planning/research/PITFALLS.md`; `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md`]  
**How to avoid:** Document in the plan that Pitfall 11 is superseded by CONTEXT D-16 and DENS-03, then use `memo` + `useMemo` over stable `tutors` inputs. [VERIFIED: `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md`; CITED: React memo/useMemo docs]  
**Warning signs:** Any plan task mentioning `/api/compare/density`, DB migration, SearchIndex density fields, `densityCache`, or 180-day rendering is off-scope. [VERIFIED: `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md`]

### Pitfall 2: Color-Only Density

**What goes wrong:** A heatmap-like row communicates density only through color intensity, which fails sighted color-vision users and provides no screen-reader equivalent. [CITED: W3C WCAG 2.2 Use of Color; VERIFIED: `.planning/research/PITFALLS.md`]  
**Why it happens:** Existing tutor colors are identity colors, not density-level colors, and the phase forbids a competing density palette. [VERIFIED: `src/components/compare/session-colors.ts:50-51`; `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md`]  
**How to avoid:** Use tutor color only for identity; use bar width/height plus visible weekly booked-hours text and segment `aria-label`/`title` for density meaning. [VERIFIED: `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md`; CITED: W3C WCAG 2.2 Use of Color]  
**Warning signs:** Segment labels disappear in colorblind simulation, `aria-label` is missing, or the only visible difference between 0h and 4h is color shade. [CITED: W3C WCAG 2.2 Use of Color]

### Pitfall 3: Making A Day-Only Summary

**What goes wrong:** The overview disappears or changes meaning when the user switches to day drill-down. [VERIFIED: `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md`]  
**Why it happens:** Implementing inside `WeekOverview` naturally omits `CalendarGrid`, because `ComparePanel` switches between those bodies. [VERIFIED: `src/components/compare/compare-panel.tsx:247-272`]  
**How to avoid:** Render density in `ComparePanel` before the branch and pass `activeDay` only for selected-day styling. [VERIFIED: `src/components/compare/compare-panel.tsx:247-272`; `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md`]  
**Warning signs:** `density-overview.tsx` is imported by `week-overview.tsx`, or density is absent when `activeDay !== null`. [VERIFIED: `src/components/compare/week-overview.tsx:225-234`; `src/components/compare/calendar-grid.tsx:49-67`]

### Pitfall 4: Accidentally Displaying Utilization Percentages

**What goes wrong:** A ratio like booked/available becomes visible as `62% booked`, which is DENS-06 and is deferred. [VERIFIED: `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md`]  
**Why it happens:** Availability windows are present and make percentage math tempting. [VERIFIED: `src/lib/search/types.ts:131-141`]  
**How to avoid:** Compute booked minutes and session counts as the user-facing values; use availability only for denominator guards or future-proof internal context, not visible percentage copy. [VERIFIED: `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md`; `src/lib/search/types.ts:131-141`]  
**Warning signs:** UI copy contains `%`, `utilization`, `capacity`, `available / booked`, or "full". [VERIFIED: `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md`]

### Pitfall 5: Unstable Props Defeating Memoization

**What goes wrong:** `DensityOverview` is memoized but still re-renders on unrelated parent state because it receives a new inline callback each render. [CITED: React memo docs; VERIFIED: `src/components/compare/compare-panel.tsx:57-83`]  
**Why it happens:** `onDayClick={(day) => setActiveDay(day)}` creates a new function in the render body, as seen in the current WeekOverview call. [VERIFIED: `src/components/compare/compare-panel.tsx:263-270`]  
**How to avoid:** Use a stable callback for density and keep helper dependencies to `tutors`/`tutorChips`, not the full `compare` object. [CITED: React memo/useMemo docs; VERIFIED: `src/hooks/use-compare.ts:207-230`]  
**Warning signs:** React Profiler shows density re-rendering when only `calendarOpen`, `discoveryOpen`, or fullscreen state changes. [CITED: React memo docs; VERIFIED: `src/components/compare/compare-panel.tsx:57-83`]

## Code Examples

### Recommended Component Skeleton

```tsx
// Source: src/components/compare/compare-panel.tsx + src/lib/search/types.ts + WAI button guidance
"use client";

import { memo, useMemo } from "react";
import type { CompareTutor } from "@/lib/search/types";
import type { TutorChip } from "./tutor-selector";
import { rgba } from "./session-colors";

const DISPLAY_DAYS = [1, 2, 3, 4, 5, 6, 0] as const;
const DAY_LABELS: Record<number, string> = {
  0: "Sun",
  1: "Mon",
  2: "Tue",
  3: "Wed",
  4: "Thu",
  5: "Fri",
  6: "Sat",
};

export interface DensityOverviewProps {
  tutors: CompareTutor[];
  tutorChips: TutorChip[];
  activeDay: number | null;
  onDayClick: (day: number) => void;
}

function formatHours(minutes: number): string {
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `${hours}h`;
}

export const DensityOverview = memo(function DensityOverview({
  tutors,
  tutorChips,
  activeDay,
  onDayClick,
}: DensityOverviewProps) {
  const rows = useMemo(
    () => buildDensityRows(tutors, tutorChips),
    [tutors, tutorChips],
  );

  if (rows.length === 0) return null;

  return (
    <section
      className="flex-shrink-0 border-b border-border/60 py-1"
      aria-label="Visible week booking density"
    >
      {rows.map((row) => (
        <div key={row.tutorGroupId} className="grid grid-cols-[92px_1fr] items-center gap-2">
          <div className="min-w-0 text-[11px] leading-tight">
            <div className="truncate font-medium" style={{ color: row.color }}>
              {row.displayName}
            </div>
            <div className="text-[10px] text-muted-foreground">
              {row.weeklyHoursBooked}h booked
            </div>
          </div>
          <div className="grid grid-cols-7 gap-1">
            {row.days.map((day) => (
              <button
                key={day.weekday}
                type="button"
                aria-current={activeDay === day.weekday ? "date" : undefined}
                aria-label={`${DAY_LABELS[day.weekday]}: ${row.displayName}, ${formatHours(day.bookedMinutes)} booked, ${day.sessionCount} sessions`}
                title={`${DAY_LABELS[day.weekday]}: ${row.displayName}, ${formatHours(day.bookedMinutes)} booked, ${day.sessionCount} sessions`}
                onClick={() => onDayClick(day.weekday)}
                className="relative h-7 overflow-hidden rounded-sm border border-border/60 bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span
                  aria-hidden="true"
                  className="absolute inset-y-0 left-0 rounded-[2px]"
                  style={{
                    width: `${Math.max(day.fillRatio * 100, day.bookedMinutes > 0 ? 12 : 0)}%`,
                    backgroundColor: rgba(row.color, 0.24),
                    borderLeft: day.bookedMinutes > 0 ? `3px solid ${row.color}` : undefined,
                  }}
                />
                <span className="relative z-[1] text-[10px] font-medium text-foreground/75">
                  {day.bookedMinutes > 0 ? formatHours(day.bookedMinutes) : ""}
                </span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
});
```

### Focused Test Pattern

```tsx
// Source: vitest.config.ts + existing src/components/compare/__tests__/modality-display.test.ts
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DensityOverview, buildDensityRows } from "../density-overview";

describe("buildDensityRows", () => {
  it("aggregates booked minutes and sessions per tutor/day", () => {
    const rows = buildDensityRows([makeTutorWithSessions()], [makeChip()]);

    expect(rows[0].days.find((day) => day.weekday === 1)).toMatchObject({
      bookedMinutes: 150,
      sessionCount: 2,
    });
  });
});

describe("DensityOverview accessibility", () => {
  it("renders text-equivalent labels for segment buttons", () => {
    const html = renderToStaticMarkup(
      <DensityOverview
        tutors={[makeTutorWithSessions()]}
        tutorChips={[makeChip()]}
        activeDay={1}
        onDayClick={vi.fn()}
      />,
    );

    expect(html).toContain("Visible week booking density");
    expect(html).toContain("aria-label=\"Mon:");
    expect(html).toContain("aria-current=\"date\"");
    expect(html).toContain("type=\"button\"");
  });
});
```

This test pattern works with the existing node Vitest environment and does not require `@testing-library/react` or jsdom. [VERIFIED: `vitest.config.ts`; `package.json`; `src/components/compare/__tests__/modality-display.test.ts`]

## State Of The Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Density as a replacement calendar view | Additive overview above the existing GCal grid | Rejected in project decisions before Phase 9 | Planner must not replace or shrink the calendar body. [VERIFIED: `.planning/PROJECT.md`; `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md`] |
| Aggregate day bar or heatmap only | Shape B per-tutor stacked rows | Phase 9 CONTEXT gathered 2026-05-05 | Planner should not re-open A/B/C except to document the locked rationale in the design review artifact. [VERIFIED: `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md`] |
| 180-day density API/cache/canvas recommendation | Visible-week client-side `useMemo` component | Phase 9 CONTEXT D-16 supersedes prior Pitfall 11 | Planner must reconcile prior research by explicitly rejecting server work. [VERIFIED: `.planning/research/PITFALLS.md`; `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md`] |
| Cache bump for every visual feature | Keep `CACHE_VERSION = "v2"` unless response shape changes | Phase 9 CONTEXT D-17 | Planner should verify no `CompareTutor`/`CompareSessionBlock`/`CompareResponse` shape changes before leaving cache untouched. [VERIFIED: `src/lib/search/cache-version.ts:1-22`; `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md`] |

**Deprecated/outdated for this phase:**

- Separate density API, density cache, and 180-day canvas rendering are outdated for Phase 9 because the locked scope is visible-week and client-side only. [VERIFIED: `.planning/research/PITFALLS.md`; `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md`]
- Chart-library dependency recommendations are outdated for this bounded 21-cell overview. [VERIFIED: `.planning/research/STACK.md`; `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md`]

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|

All claims in this research were verified or cited; no `[ASSUMED]` claims are used. [VERIFIED: this research session source log]

## Open Questions (RESOLVED)

1. **Exact visual row height and per-cell text density**
   - What we know: The overview must be compact, per-tutor stacked, visible in week/day views, and readable at 3 tutors on a 13-inch display. [VERIFIED: `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md`; `.planning/phases/05-polish-drain/05-PHASE-VERIFICATION.md`]
   - RESOLVED: Use the approved UI contract's compact Shape B geometry: a 96px tutor-label column, 32px day segments, seven equal day columns, 4px segment gaps, and max three tutor rows with total density strip height at or below 120px. The existing Plan 03 manual/browser verification checkpoint remains the final visual-fit gate for one-, two-, and three-tutor states at 50% compare-panel width. [VERIFIED: `.planning/phases/09-vpol-03-density-overview/09-UI-SPEC.md`; `.planning/phases/09-vpol-03-density-overview/09-01-PLAN.md`; `.planning/phases/09-vpol-03-density-overview/09-03-PLAN.md`]
   - Implementation marker: Plan 01 Task 2 requires `grid grid-cols-[96px_1fr]`, `h-8` 32px segments, and compact row styling; Plan 03 verifies the max-three-row <=120px visual requirement before phase sign-off. [VERIFIED: `.planning/phases/09-vpol-03-density-overview/09-01-PLAN.md`; `.planning/phases/09-vpol-03-density-overview/09-03-PLAN.md`]

2. **Whether to include availability in the visible fill formula**
   - What we know: The user-facing values must stay booked hours and session count, and utilization percentage is deferred. [VERIFIED: `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md`]
   - RESOLVED: Use raw booked-minutes fill normalized against the maximum booked tutor/day cell in the visible week, with a 60-minute minimum denominator and a 12% minimum visible fill only for nonzero booked time. Availability windows remain available to the helper as guard/context data, but they are not part of the visible utilization/capacity formula and must not produce percentage, capacity, free-slot, or availability claims. [VERIFIED: `.planning/phases/09-vpol-03-density-overview/09-UI-SPEC.md`; `.planning/phases/09-vpol-03-density-overview/09-01-PLAN.md`]
   - Implementation marker: Plan 01 Task 2 locks `Math.max(60, ...allCells.map((cell) => cell.bookedMinutes))`, `fillRatio`, and `Math.max(fillRatio * 100, 12)` while preserving `availableMinutes` as returned data only; Plan 02/03 guardrails keep server/cache/schema surfaces and misleading availability copy out of scope. [VERIFIED: `.planning/phases/09-vpol-03-density-overview/09-01-PLAN.md`; `.planning/phases/09-vpol-03-density-overview/09-02-PLAN.md`; `.planning/phases/09-vpol-03-density-overview/09-03-PLAN.md`]

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| Node.js | Next/Vitest execution | Yes | v20.20.2 | None needed. [VERIFIED: `node --version`] |
| npm | scripts and registry checks | Yes | 10.8.2 | Use `npm --cache /private/tmp/npm-cache` for registry checks because default cache is EPERM. [VERIFIED: `npm --version`; npm registry command output] |
| Next CLI | Build/dev verification | Yes | Next.js v16.2.2 | None needed. [VERIFIED: `./node_modules/.bin/next --version`] |
| Vitest CLI | Unit verification | Yes | vitest/4.1.5 darwin-arm64 node-v20.20.2 | None needed. [VERIFIED: `./node_modules/.bin/vitest --version`] |
| ESLint CLI | Lint verification | Yes | v9.39.4 | None needed. [VERIFIED: `./node_modules/.bin/eslint --version`] |

**Missing dependencies with no fallback:** None for the recommended implementation path. [VERIFIED: environment audit commands]

**Missing dependencies with fallback:** npm registry queries need the temporary cache path noted above; implementation and test scripts do not require registry access. [VERIFIED: npm command outputs]

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.5 with node environment for unit tests. [VERIFIED: `vitest.config.ts`; `./node_modules/.bin/vitest --version`] |
| Config file | `vitest.config.ts` with unit project including `src/**/*.test.ts` and `src/**/*.test.tsx`. [VERIFIED: `vitest.config.ts`] |
| Quick run command | `./node_modules/.bin/vitest run --project unit src/components/compare/__tests__/density-overview.test.tsx` [VERIFIED: `vitest.config.ts`] |
| Full suite command | `npm test` [VERIFIED: `package.json`] |

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| DENS-01 | Per-tutor/per-day visible-week booked minutes and session counts aggregate correctly | unit | `./node_modules/.bin/vitest run --project unit src/components/compare/__tests__/density-overview.test.tsx` | No - Wave 0. [VERIFIED: `rg --files src | rg 'density-overview'` returned no file] |
| DENS-02 | Design-review artifact records A/B/C and locks Shape B | doc check | `test -f .planning/phases/09-vpol-03-density-overview/09-DENSITY-DESIGN-REVIEW.md` | No - Wave 0. [VERIFIED: phase directory listing via init; no research/design file exists yet] |
| DENS-03 | No API/schema/SearchIndex/cache-version changes are needed | grep/static review | `git diff -- src/app/api src/lib/search/index.ts src/lib/db/schema.ts src/lib/search/cache-version.ts` | Existing files yes; should remain unchanged. [VERIFIED: codebase paths] |
| DENS-04 | Segment buttons expose text equivalents and static rendering | unit + manual a11y | `./node_modules/.bin/vitest run --project unit src/components/compare/__tests__/density-overview.test.tsx` | No - Wave 0. [VERIFIED: `vitest.config.ts`; W3C/MDN docs] |

### Sampling Rate

- **Per task commit:** Run the density test file plus `npm test` when code is changed. [VERIFIED: `package.json`; `vitest.config.ts`]
- **Per wave merge:** Run `npm test` and `./node_modules/.bin/eslint`. [VERIFIED: `package.json`; environment audit]
- **Phase gate:** Full suite green, lint green, design-review artifact present, no server/cache/schema diff, and manual light/dark/reduced-motion/VoiceOver spot-check recorded. [VERIFIED: `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md`; `.planning/phases/05-polish-drain/05-PHASE-VERIFICATION.md`; W3C/MDN docs]

### Wave 0 Gaps

- [ ] `src/components/compare/density-overview.tsx` - component and exported pure helper. [VERIFIED: `find src/components/compare -maxdepth 2 -type f`]
- [ ] `src/components/compare/__tests__/density-overview.test.tsx` - aggregation and server-rendered markup checks. [VERIFIED: `rg --files src | rg 'density-overview'`]
- [ ] `.planning/phases/09-vpol-03-density-overview/09-DENSITY-DESIGN-REVIEW.md` - required DENS-02 rationale artifact. [VERIFIED: `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md`]
- [ ] Manual verification notes for 1/2/3 tutors, week view, day view, light/dark, reduced motion, keyboard tab/Enter/Space, and VoiceOver segment labels. [VERIFIED: `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md`; W3C/MDN docs]

## Security Domain

Security enforcement is enabled because `.planning/config.json` does not set `security_enforcement` to `false`. [VERIFIED: `.planning/config.json`]

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|------------------|
| V2 Authentication | No new behavior | Keep existing authenticated `/search`/compare surface; Phase 9 adds no route or auth decision. [VERIFIED: `src/components/compare/compare-panel.tsx`; OWASP ASVS categories source] |
| V3 Session Management | No new behavior | No cookies/session handling changes. [VERIFIED: phase scope; OWASP ASVS categories source] |
| V4 Access Control | No new behavior | No new API or authorization boundary; do not add server endpoint. [VERIFIED: `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md`; OWASP ASVS categories source] |
| V5 Validation, Sanitization and Encoding | Yes, client-rendered text from existing response | Use React text rendering only; do not use `dangerouslySetInnerHTML`, `innerHTML`, or string HTML. [VERIFIED: `rg 'dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML' src/components/compare`; OWASP ASVS categories source] |
| V6 Cryptography | No | No secrets, crypto, token, or storage changes. [VERIFIED: phase scope; OWASP ASVS categories source] |

### Known Threat Patterns For This Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| DOM XSS through tutor/student/subject strings | Tampering | Render strings as React text nodes and never as HTML; grep found no existing compare `dangerouslySetInnerHTML`/`innerHTML` usage. [VERIFIED: code grep; OWASP ASVS categories source] |
| Client-side trust boundary drift | Elevation of privilege | Keep density as read-only presentation; no write-back action, no endpoint, no local persisted cache. [VERIFIED: `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md`] |
| Misleading availability signal | Information integrity | Label as booked-hours/session density only; do not claim a tutor is available or add scheduling actions. [VERIFIED: `AGENTS.md`; `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md`] |
| Style injection through color | Tampering | Use `tutorChips` colors sourced from fixed `TUTOR_COLORS`; do not accept color strings from API data. [VERIFIED: `src/hooks/use-compare.ts:153-158`; `src/components/compare/session-colors.ts:50-51`] |

## Sources

### Primary (HIGH confidence)

- `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md` - locked decisions D-01..D-17, discretion, and deferred ideas. [VERIFIED: file read]
- `.planning/REQUIREMENTS.md` - DENS-01..04 canonical requirements. [VERIFIED: file read]
- `.planning/ROADMAP.md` - Phase 9 goal and success criteria. [VERIFIED: file read]
- `.planning/STATE.md` - Phase 9 readiness and v1.1 phase gating. [VERIFIED: file read]
- `AGENTS.md` - stack, production status, non-negotiable product rules, Next.js docs rule. [VERIFIED: file read]
- `src/components/compare/compare-panel.tsx` - integration location and active day branch. [VERIFIED: code read]
- `src/components/compare/week-overview.tsx` and `src/components/compare/calendar-grid.tsx` - calendar-body ownership and existing compare rendering. [VERIFIED: code read]
- `src/hooks/use-compare.ts` - compare state, cache key, color assignment, `setActiveDay`. [VERIFIED: code read]
- `src/lib/search/types.ts` and `src/lib/search/compare.ts` - `CompareResponse`, `CompareTutor`, and `weeklyHoursBooked` derivation. [VERIFIED: code read]
- `src/lib/search/cache-version.ts` - cache-version rule and current `"v2"`. [VERIFIED: code read]
- `node_modules/next/dist/docs/01-app/03-api-reference/01-directives/use-client.md` - Next.js 16 client-component boundary guidance. [VERIFIED: local official docs]
- npm registry metadata for Next, React, React DOM, Tailwind, Vitest, lucide-react, clsx, and tailwind-merge. [VERIFIED: npm registry]

### Secondary (MEDIUM/HIGH confidence)

- W3C WCAG 2.2 Understanding SC 1.4.1 Use of Color - no color-only encoding. [CITED: https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html]
- W3C WCAG 2.2 Understanding SC 2.1.1 Keyboard - pointer actions need keyboard equivalents. [CITED: https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html]
- W3C WAI-ARIA Authoring Practices Button Pattern - native button labels and Enter/Space activation. [CITED: https://www.w3.org/WAI/ARIA/apg/patterns/button/]
- MDN `prefers-reduced-motion` - reduced-motion media feature semantics and platform support. [CITED: https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion]
- React `useMemo` and `memo` docs - derivation cache and prop-stable memoization behavior. [CITED: https://react.dev/reference/react/useMemo; https://react.dev/reference/react/memo]
- OWASP ASVS project/developer-guide pages - ASVS security category taxonomy and current stable ASVS 5.0.0 note. [CITED: https://owasp.org/www-project-application-security-verification-standard/; https://devguide.owasp.org/en/06-verification/01-guides/03-asvs/]

### Tertiary (LOW confidence)

- None used. [VERIFIED: source log]

## Metadata

**Confidence breakdown:**

- Standard stack: HIGH - package versions were verified locally and via registry; locked-stack constraints are explicit. [VERIFIED: `npm ls`; npm registry; `AGENTS.md`]
- Architecture: HIGH - exact component boundary, data fields, and cache rule were verified in source. [VERIFIED: `compare-panel.tsx`; `types.ts`; `cache-version.ts`]
- A11y: HIGH - requirements were cross-checked against W3C/WAI/MDN guidance. [CITED: W3C/WAI/MDN sources]
- Pitfalls: HIGH - prior research contradiction was located and reconciled against locked Phase 9 CONTEXT. [VERIFIED: `.planning/research/PITFALLS.md`; `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md`]
- Visual fit: MEDIUM - row height and per-cell text density still require local design review and screenshot verification. [VERIFIED: `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md`]

**Research date:** 2026-05-05 [VERIFIED: environment_context]
**Valid until:** 2026-06-04 for stack/codebase facts, or until `CompareResponse`/compare UI shape changes. [VERIFIED: current source scan; ASSUMED validity window not used as implementation fact]
