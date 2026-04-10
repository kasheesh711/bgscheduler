# Requirements: BGScheduler Performance & UX Improvement

**Defined:** 2026-04-10
**Core Value:** Admin staff can find, compare, and schedule tutors instantly and independently

## v1 Requirements

Requirements for this milestone. Each maps to roadmap phases.

### Performance

- [ ] **PERF-01**: Break 878-line search page into focused client components (SearchForm, SearchResults, ComparePanel, SearchWorkspace)
- [ ] **PERF-02**: Extract `useCompare` custom hook owning all compare state (compareTutors, tutorCache, abortRef, lastSnapshotId, weekStart, fetchCompare)
- [ ] **PERF-03**: Anchor SearchIndex and DB singletons on `globalThis` instead of module-level variables
- [ ] **PERF-04**: Convert search page to async Server Component that streams filter/tutor data via Suspense (eliminate client fetch waterfalls for `/api/filters` and `/api/tutors`)
- [ ] **PERF-05**: Add skeleton loading states matching real component dimensions for search form, calendar grid, and tutor combobox
- [ ] **PERF-06**: Lazy-load WeekOverview (~471 lines), CalendarGrid (~275 lines), DiscoveryPanel (~274 lines) via React.lazy()
- [ ] **PERF-07**: Enable `cacheComponents: true` in next.config.ts and use `'use cache'` directive with `cacheTag('snapshot')` for filter options and tutor list data

### Calendar Readability

- [ ] **CAL-01**: Add alternating lane backgrounds per tutor using tutor's assigned color at 5% opacity
- [ ] **CAL-02**: Add lane header labels on week grid showing tutor name + color dot at top of each day-lane
- [ ] **CAL-03**: Add today indicator line (horizontal line at current time position on today's column)
- [ ] **CAL-04**: Replace generic "!" conflict indicator with numbered conflict count badge per day

### Workflow

- [ ] **FLOW-01**: Add "+" button on each search result row to directly add tutor to compare panel (reduce 3 clicks to 1)
- [ ] **FLOW-02**: Add hover tooltips on session blocks showing student name, subject, and time range (keep existing popover on click)
- [ ] **FLOW-03**: Add `&week=YYYY-MM-DD` URL parameter to make compare view week state shareable
- [ ] **FLOW-04**: Add keyboard navigation for week picker (left/right arrow keys for prev/next week)

### Infrastructure

- [ ] **INFRA-01**: Add `loading.tsx` skeleton file for search route (instant feedback on navigation)
- [ ] **INFRA-02**: All 82 existing unit tests continue to pass after all changes

## v2 Requirements

Deferred to future milestone. Tracked but not in current roadmap.

### Visual Polish

- **VPOL-01**: Animated transitions between week/day views (fade/slide)
- **VPOL-02**: Sticky tutor legend on vertical scroll
- **VPOL-03**: Mini-map density overview bar per tutor per day

### Advanced Workflow

- **AWRK-01**: Inline free-slot actions (click free gap to copy time details)
- **AWRK-02**: Conflict resolution suggestions (suggest alternative slots)
- **AWRK-03**: Drag-to-select time range on calendar grid

## Out of Scope

| Feature | Reason |
|---------|--------|
| Mobile/tablet responsive design | Admin staff use desktop exclusively; out of scope per project constraints |
| Color palette changes | Sky blue palette stays per user preference |
| Calendar grid layout overhaul | GCal-style weekly grid stays per user preference |
| React Query or SWR integration | Existing client cache is well-designed; library adds complexity for 3 fetch patterns |
| Drag-and-drop rescheduling | Read-only tool; write-back to Wise creates data integrity risk |
| Real-time collaborative viewing | Only 8 users; WebSocket infrastructure is overkill |
| FullCalendar library integration | Heavy dependency; custom grid is lighter and fits exact use case |
| Dark mode polish | Low ROI for office-hours admin tool |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| PERF-01 | Phase 1 | Pending |
| PERF-02 | Phase 1 | Pending |
| PERF-03 | Phase 1 | Pending |
| PERF-04 | Phase 2 | Pending |
| PERF-05 | Phase 2 | Pending |
| PERF-06 | Phase 2 | Pending |
| PERF-07 | Phase 2 | Pending |
| INFRA-01 | Phase 2 | Pending |
| CAL-01 | Phase 3 | Pending |
| CAL-02 | Phase 3 | Pending |
| CAL-03 | Phase 3 | Pending |
| CAL-04 | Phase 3 | Pending |
| FLOW-01 | Phase 3 | Pending |
| FLOW-02 | Phase 3 | Pending |
| FLOW-03 | Phase 3 | Pending |
| FLOW-04 | Phase 3 | Pending |
| INFRA-02 | Phase 3 | Pending |

**Coverage:**
- v1 requirements: 17 total
- Mapped to phases: 17
- Unmapped: 0

---
*Requirements defined: 2026-04-10*
*Last updated: 2026-04-10 after initial definition*
