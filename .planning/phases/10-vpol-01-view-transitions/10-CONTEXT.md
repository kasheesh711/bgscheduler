# Phase 10: VPOL-01 View Transitions - Context

**Gathered:** 2026-05-09
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 10 adds native browser view-transition polish to the existing compare calendar navigation. It covers week prev/next, Today, calendar-popup week selection, and day-tab switches inside the compare panel. The work must preserve the frozen Phase 8 sticky legend and Phase 9 density overview, keep the GCal-style grid, preserve calendar scroll position, respect reduced-motion users, and avoid wrapping the Next.js RSC streaming boundary.

Not in scope: tutor add/remove shared-element transitions, fullscreen morph transitions, new animation libraries, cache-shape changes, schema/API changes, or enabling Next.js `experimental.viewTransition`.

</domain>

<decisions>
## Implementation Decisions

### Motion Feel

- **D-01:** Week prev/next navigation uses a directional slide. Moving to a later week slides in the forward direction; moving to an earlier week slides in the reverse direction. This should reinforce the calendar mental model.
- **D-02:** Today and calendar-popup week jumps also use directional slide by date direction. If the target week is later than the current visible week, use the forward direction; if earlier, use the reverse direction.
- **D-03:** Day-tab switches use a subtle crossfade, not a horizontal slide. Day drill-down changes are a lens switch, not week movement.
- **D-04:** Motion should be fast and utilitarian: target duration is at most 160 ms with light easing. Avoid decorative, long, or highly noticeable animation.

### Transition Timing

- **D-05:** Week changes animate final loaded content only. Fetch new compare data first, then run the view transition when the new compare response is ready. Do not capture loading skeletons or Suspense fallback DOM as the transition target.
- **D-06:** Use the same final-content timing path even when data is cached. A single timing model is preferred over special-casing cached weeks.
- **D-07:** During a week-change fetch, keep the current calendar content visible until replacement content is ready. Do not show the existing full-panel loading state for this path unless planning finds a blocking reason.
- **D-08:** Day-tab switches have no server fetch, so wrap the local `activeDay` state update directly in the view-transition helper.

### Scroll Preservation

- **D-09:** Preserve the current calendar scroll offset across all week changes. If staff are looking around 5pm, the new week should remain around that same time-of-day position.
- **D-10:** Phase 10 must explicitly support both calendar scroll containers: the WeekOverview internal scroll body and the day-drill-down wrapper in ComparePanel / CalendarGrid.
- **D-11:** Week to Day and Day to Week switches carry over the same time-of-day scroll offset.
- **D-12:** Day-to-day tab switches also preserve the same time-of-day offset. Do not reset each day to the top.

### Fallbacks and Fast Navigation

- **D-13:** `prefers-reduced-motion: reduce` is strict instant mode. The helper should bypass view transitions for reduced-motion users, and CSS should also disable any `::view-transition-*` animation.
- **D-14:** Browsers without `document.startViewTransition` use a silent instant fallback. No warning UI and no CSS-transition fallback are required.
- **D-15:** Rapid week navigation skips animation so power users are not slowed down.
- **D-16:** A rapid navigation burst is defined as another week-navigation start within 300 ms of the previous one.

### Technical Guardrails

- **D-17:** The helper lives in `src/lib/ui/view-transitions.ts` and feature-detects the native browser API. It must be safe in SSR by falling back when `document` is unavailable.
- **D-18:** Do not enable `experimental.viewTransition` in `next.config.ts`. Local Next.js 16 docs mark that flag experimental and advise against production use. This phase uses `document.startViewTransition()` directly instead.
- **D-19:** Do not add Framer Motion, Motion One, React canary APIs, or any new animation dependency.
- **D-20:** No `CACHE_VERSION` bump is expected. If planning discovers an unavoidable client-cached response shape change, the plan must call that out explicitly and include the cache-version migration.

### the agent's Discretion

- Exact helper function names and option shape, provided it supports named transition kinds/directions, reduced-motion bypass, unsupported-browser fallback, and rapid-navigation bypass.
- Exact CSS keyframe names and `view-transition-name` values, provided week slide and day crossfade are separately addressable.
- Exact scroll-container ref plumbing. The implementation may centralize scroll capture/restore in `ComparePanel`, `useCompare`, or a small UI helper as long as both week and day containers are covered.
- Exact visual easing curve, provided duration stays at or below 160 ms and the result remains quiet.
- Whether a small non-disruptive pending affordance is useful while week data fetches, provided current calendar content remains visible and no skeleton is captured by the transition.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope and requirements

- `.planning/ROADMAP.md` section "Phase 10: VPOL-01 View Transitions" - phase goal, dependencies, and success criteria.
- `.planning/REQUIREMENTS.md` section "Visual Polish - View Transitions (VPOL-01)" - TRANS-01..05 canonical requirements.
- `.planning/PROJECT.md` sections "Current Milestone", "Constraints", and "Key Decisions" - preserve GCal grid, sky-blue palette, native stack, and admin-workflow speed.
- `.planning/STATE.md` section "Current Position" and Phase 10 advisory flag - Phase 10 is last because it animates the frozen baseline.

### Prior phase context

- `.planning/phases/08-vpol-02-sticky-tutor-legend/08-CONTEXT.md` section "Legend consolidation strategy" - sticky legend remains identity-only and must not regress.
- `.planning/phases/09-vpol-03-density-overview/09-CONTEXT.md` sections "Placement" and "Data / Performance Contract" - density remains between day tabs and calendar body, derived client-side, with no cache-shape change.
- `.planning/phases/06-mod-01-reliable-modality-detection/06-CONTEXT.md` section "CACHE_VERSION constant" - cache-version bump rules.
- `.planning/phases/07-past-01-past-day-session-visibility/07-CONTEXT.md` section "CACHE_VERSION bump" - current compare cache migration pattern.

### Research intelligence

- `.planning/research/ARCHITECTURE.md` section "VPOL-01 - View Transitions" - native helper recommendation, cacheComponents interaction, and integration surfaces.
- `.planning/research/FEATURES.md` section "VPOL-01 - View Transitions" - calendar motion conventions, rapid-navigation guidance, and anti-features.
- `.planning/research/STACK.md` references to VPOL - no new animation dependency; use platform primitives.
- `.planning/research/PITFALLS.md` references to VPOL/client cache - avoid response-shape churn and Suspense fallback capture.

### Next.js 16 local docs

- `node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/viewTransition.md` - `experimental.viewTransition` status and production caution.
- `node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/cacheComponents.md` - `cacheComponents` behavior and Activity-based state preservation.
- `node_modules/next/dist/docs/01-app/02-guides/upgrading/version-16.md` section "React 19.2" - View Transitions are present in the Next.js 16 React stack, but this phase still uses native browser API directly.

### Source code surfaces

- `src/components/compare/compare-panel.tsx` - week prev/next/Today/calendar-pick handlers, day tabs, density placement, and day-view scroll wrapper.
- `src/hooks/use-compare.ts` - `changeWeek`, `fetchCompare`, `activeDay`, client tutor cache, and week state.
- `src/components/compare/week-overview.tsx` - week-view internal scroll container, sticky tutor legend, calendar body, and day-click entry points.
- `src/components/compare/calendar-grid.tsx` - day drill-down body and sticky column header.
- `src/components/compare/week-calendar.tsx` - calendar-popup week selection path.
- `src/app/globals.css` - global view-transition keyframes and reduced-motion media query.
- `src/lib/ui/z-index.ts` - existing sticky/popover z-index scale that transitions must not disturb.
- `src/lib/search/cache-version.ts` - should remain unchanged unless compare response shape changes.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- `src/hooks/use-compare.ts` already centralizes compare state and week navigation. `changeWeek(newWeek)` clears the tutor cache and calls `fetchCompare` for selected tutors.
- `src/components/compare/compare-panel.tsx` already owns all week navigation buttons, calendar-popup selection, day-tab clicks, density overview placement, and day-view wrapper.
- `src/components/compare/week-overview.tsx` has the WeekOverview scroll container (`flex-1 overflow-y-auto min-h-0`) and the Phase 8 sticky tutor legend inside it.
- `src/components/compare/calendar-grid.tsx` renders the day drill-down. It is wrapped by `ComparePanel` in an `overflow-y-auto` container when `activeDay !== null`.
- `src/app/globals.css` is the right location for global `::view-transition-*` selectors and reduced-motion media rules.

### Established Patterns

- Client UI components use `"use client"`, `useCallback`, `useMemo`, and small feature-local helpers rather than global state libraries.
- The compare panel uses client-side cache entries keyed by `tutorGroupId:weekStart:CACHE_VERSION`. Avoid changing the response shape unless necessary.
- Dynamic calendar components use `next/dynamic` with `CalendarSkeleton` loading. Phase 10 must avoid capturing that fallback during a view transition.
- Phase 8 introduced `src/lib/ui/z-index.ts` for sticky/popover layering. View-transition styling must not interfere with the legend or popovers.

### Integration Points

- Add `src/lib/ui/view-transitions.ts` for feature detection, reduced-motion bypass, transition type/direction, and rapid navigation bypass.
- Modify `src/hooks/use-compare.ts` or expose a new async week-change path so week changes can fetch first and transition final content second.
- Modify `src/components/compare/compare-panel.tsx` to route week buttons, Today, `WeekCalendar.onWeekSelect`, day tabs, and density day clicks through the transition-aware handlers.
- Add stable refs or data attributes for the active calendar scroll container so scroll capture/restore works for both WeekOverview and CalendarGrid.
- Add CSS for named week slide and day crossfade transitions plus strict reduced-motion disable rules.

</code_context>

<specifics>
## Specific Ideas

- Motion should feel like calendar navigation, not a decorative app animation.
- Week direction is determined by comparing target week date to current visible week date.
- Day tabs are a view/lens change and should crossfade quietly.
- Current calendar content should stay visible during week fetches; the final loaded calendar replaces it inside the transition.
- The scroll position represents time-of-day context and should survive all supported compare navigation paths.

</specifics>

<deferred>
## Deferred Ideas

- Tutor add/remove shared-element or lane enter/exit transitions remain deferred to v1.2+ (`TRANS-06`).
- Fullscreen morph transition remains deferred to v1.2+ (`TRANS-07`).
- CSS fallback animation for browsers without native view transitions is not needed in Phase 10.
- Per-week remembered scroll positions are not needed in Phase 10.

</deferred>

---

*Phase: 10-vpol-01-view-transitions*
*Context gathered: 2026-05-09*
