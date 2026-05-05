# Phase 9: VPOL-03 Density Overview - Context

**Gathered:** 2026-05-05
**Status:** Ready for planning

<domain>
## Phase Boundary

Add an at-a-glance density overview to the compare panel so admins can see per-tutor booking density across the currently visible week without leaving the calendar. The overview is a client-side presentation layer over the existing compare response.

**In scope:** DENS-01..04 - density overview component, phase-local A/B/C shape decision, `useMemo` aggregation from existing `CompareResponse.tutors[].sessions[]`, and accessible text equivalents / reduced-motion compliance.

**Out of scope:** New API endpoints, SearchIndex changes, schema changes, chart libraries, replacing the GCal-style week grid, full-month density views, click-to-jump-to-hour, utilisation percentages, shared-free-slot density overlays, animation polish, or any scheduling/write-back actions.

</domain>

<decisions>
## Implementation Decisions

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

### the agent's Discretion

- Exact component name (`DensityOverview`, `DensityMiniMap`, or similar) and exact DOM/SVG implementation.
- Whether each tutor/day segment is a simple button, an SVG `<rect>` wrapped by a button, or a Tailwind-styled div/button grid.
- Exact density formula, provided it is derived from visible-week sessions and availability windows and handles zero availability without divide-by-zero or misleading "full" states.
- Exact row height and spacing, provided the overview remains compact and does not squeeze the GCal grid.
- Exact visual treatment for the selected day, hover state, and focus ring, provided text does not overflow at 3 tutors on a 13-inch display.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope & requirements

- `.planning/ROADMAP.md` section"Phase 9: VPOL-03 Density Overview" - goal, dependencies, and four success criteria.
- `.planning/REQUIREMENTS.md` section"Visual Polish - Density Overview (VPOL-03)" - DENS-01..04 canonical requirements.
- `.planning/STATE.md` section"v1.1 Scope Summary" row 9 - Phase 9 gating and advisory flag that shape A/B/C is decided locally.
- `.planning/PROJECT.md` sectionKey Decisions - preserve GCal grid; rejected prior density-view replacement due to readability problems.

### Research intelligence

- `.planning/research/FEATURES.md` section"VPOL-03 - Density Overview / Mini-Map" - A/B/C/D shape comparison, differentiators, and anti-features.
- `.planning/research/ARCHITECTURE.md` section"(5) VPOL-03 - Density overview / mini-map" - recommended placement between day tabs and calendar body; client-side derivation sketch.
- `.planning/research/STACK.md` section"Sticky Tutor Legend (VPOL-02) + Density Overview (VPOL-03)" - zero new dependencies; Tailwind / inline SVG only.
- `.planning/research/PITFALLS.md` section"Pitfall 11 - VPOL-03: Density overview re-render churn" - performance risk to mitigate with small visible-week memoized rendering; do not follow its separate-API recommendation because DENS-03 forbids server work.
- `.planning/research/PITFALLS.md` section"Pitfall 12 - VPOL-03: Density view a11y" - no color-only encoding, text equivalents, reduced-motion, colorblind/manual a11y checks.
- `.planning/research/PITFALLS.md` section"Pitfall 14 - Client-side tutor cache" - bump `CACHE_VERSION` only if response shape changes.

### Prior phase context

- `.planning/phases/05-polish-drain/05-CONTEXT.md` section"Human-QA Execution" - Phase 5 established the VoiceOver/a11y baseline that Phase 9 depends on.
- `.planning/phases/06-mod-01-reliable-modality-detection/06-CONTEXT.md` section"CACHE_VERSION constant" - cache-version rule for client-cached compare-shaped data.
- `.planning/phases/07-past-01-past-day-session-visibility/07-CONTEXT.md` section"CACHE_VERSION bump" - most recent bump to `"v2"` and migration-history pattern.
- `.planning/phases/08-vpol-02-sticky-tutor-legend/08-CONTEXT.md` section"Legend consolidation strategy" and sectionDeferred Ideas - sticky legend remains identity-only; density belongs in Phase 9.

### Source code surfaces

- `src/components/compare/compare-panel.tsx` - insert the overview between the day tabs and the calendar view wrapper; reuse `setActiveDay` / `onDayClick` behavior.
- `src/components/compare/week-overview.tsx` - week-view calendar body that receives `tutors`, `tutorChips`, `conflicts`, `sharedFreeSlots`, `weekStart`, and `onDayClick`.
- `src/components/compare/calendar-grid.tsx` - day drill-down body; density overview should remain above it when `activeDay !== null`.
- `src/lib/search/types.ts` - `CompareTutor.sessions`, `availabilityWindows`, and `weeklyHoursBooked`; `CompareResponse.conflicts` if the planner chooses a small conflict-count hint.
- `src/hooks/use-compare.ts` - compare state, cache version key, and `setActiveDay` path.
- `src/components/compare/session-colors.ts` - `TUTOR_COLORS` and existing tutor color identity utilities.
- `src/lib/search/cache-version.ts` - stays `"v2"` unless a cached response shape change becomes unavoidable.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- `CompareResponse.tutors[].sessions[]` already carries weekday, date, start/end minutes, subject, student, and modality; enough to compute booked minutes and session counts per tutor/day.
- `CompareTutor.availabilityWindows` already carries weekday + start/end minutes; enough to compute a density denominator without a server call.
- `CompareTutor.weeklyHoursBooked` already exists and can provide the row-level booked-hours label.
- `tutorChips` and `TUTOR_COLORS` already define stable per-tutor colors for 1-3 selected tutors.
- Existing `onDayClick` in `WeekOverview` and `setActiveDay` in `ComparePanel` already switch to the day drill-down.

### Established Patterns

- Compare UI composition is `Tutor chips -> Week picker -> Day tabs -> Calendar body -> Conflict summary`; Phase 9 adds one compact strip between tabs and body.
- The codebase uses `next/dynamic` for heavy compare calendar components. A small density component can be a normal sibling import unless planning finds bundle reasons to lazy-load it.
- Styling should use Tailwind and existing semantic tokens; no chart dependency is justified for 1-3 tutors x 7 days.
- Phase 8 introduced `src/lib/ui/` and `Z_INDEX` for sticky layers; Phase 9's chosen placement is not sticky and should avoid new stacking complexity.

### Integration Points

- `ComparePanel` owns both `activeDay` and the render switch between `WeekOverview` and `CalendarGrid`; this is the clean integration point for density placement and click navigation.
- `WeekOverview` and `CalendarGrid` should remain focused on the calendar body. Do not embed density logic inside either unless the planner has a strong local reason.
- Client memoization should key off the visible-week `compareResponse.tutors`, `compareResponse.conflicts`, and `weekStart`. Avoid deriving density from the whole `compare` object, which would rerender on unrelated state such as discovery modal toggles.

</code_context>

<specifics>
## Specific Ideas

- "Per-tutor stacked rows" means the density view should answer "which selected tutor is busiest this week?" faster than scanning the main grid.
- The visual should remain compact enough that the calendar still feels like the primary workspace.
- Labels should be practical admin-facing data, not explanatory UI text: tutor name, booked hours, short per-day text equivalents.
- Clicking a segment should feel like a shortcut to the existing day tab, not like a new scheduling feature.

</specifics>

<deferred>
## Deferred Ideas

- DENS-05 click-to-jump-to-hour - defer. Phase 9 click only opens the day drill-down.
- DENS-06 utilisation percentage summary - defer. Booked hours are allowed; utilisation % is not.
- Shared-free-slot density overlay - defer; it is useful but not required by DENS-01..04.
- Full-month / 180-day density heatmap - defer/reject for v1.1; Phase 9 is visible-week scope.
- Density as a replacement calendar view - explicitly rejected; keep the GCal grid.
- Chart libraries (`recharts`, `visx`, `d3`) - explicitly rejected for this bounded overview.

</deferred>

---

*Phase: 09-vpol-03-density-overview*
*Context gathered: 2026-05-05*
