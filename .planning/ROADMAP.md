# Roadmap: BGScheduler Performance & UX Improvement

## Overview

This milestone transforms BGScheduler from a functional but sluggish scheduling tool into a snappy, intuitive workspace. Phase 1 untangles the monolithic search page into clean components that enable server-side rendering. Phase 2 adds streaming and lazy loading for near-instant perceived load times. Phase 3 polishes calendar readability and streamlines the search-to-compare workflow into fewer clicks.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Component Architecture** - Break monolithic search page into focused components and extract shared state
- [ ] **Phase 2: Streaming & Lazy Loading** - Near-instant page load with progressive data streaming and code splitting
- [ ] **Phase 3: Calendar Readability & Workflow Polish** - Tutor visual distinction, calendar indicators, and one-click compare workflow
- [ ] **Phase 4: UI Audit Polish** - Accessibility, semantic color consistency, error feedback, typography standardization from full-app UI review

## Phase Details

### Phase 1: Component Architecture
**Goal**: Clean component boundaries enable RSC conversion
**Depends on**: Nothing (first phase)
**Requirements**: PERF-01, PERF-02, PERF-03
**Success Criteria** (what must be TRUE):
  1. Search page renders identically to current production (no visual regression)
  2. ComparePanel, SearchForm, SearchResults, and SearchWorkspace exist as separate importable components
  3. All compare state (tutors, cache, abort, snapshot, week) lives in a single useCompare hook
  4. SearchIndex and DB singletons survive across server-side module reloads (globalThis anchored)
**Plans:** 3 plans

Plans:
- [x] 01-01-PLAN.md — Anchor DB and SearchIndex singletons on globalThis
- [x] 01-02-PLAN.md — Extract useCompare hook, SearchForm, and SearchResults components
- [x] 01-03-PLAN.md — Extract ComparePanel, create SearchWorkspace, rewrite page.tsx

### Phase 2: Streaming & Lazy Loading
**Goal**: Near-instant page load with progressive data streaming
**Depends on**: Phase 1
**Requirements**: PERF-04, PERF-05, PERF-06, PERF-07, INFRA-01
**Success Criteria** (what must be TRUE):
  1. Search page shows a skeleton shell within 200ms of navigation (no blank white screen)
  2. Filter dropdowns and tutor combobox populate without client-side fetch waterfalls (data streamed from server)
  3. WeekOverview, CalendarGrid, and DiscoveryPanel JS bundles load only when their tab/modal is activated
  4. Filter options and tutor list data are served from cache and invalidated only on snapshot change
**Plans**: TBD
**UI hint**: yes

Plans:
- [x] 02-01: TBD

### Phase 3: Calendar Readability & Workflow Polish
**Goal**: Tutors visually distinguishable, compare workflow is one-click
**Depends on**: Phase 2
**Requirements**: CAL-01, CAL-02, CAL-03, CAL-04, FLOW-01, FLOW-02, FLOW-03, FLOW-04, INFRA-02
**Success Criteria** (what must be TRUE):
  1. In multi-tutor week view, each tutor's lane has a visually distinct tinted background and a labeled header
  2. Today's column shows a horizontal time indicator line at the current time
  3. Conflict indicators show a numbered count badge (not a generic icon)
  4. Admin can add a tutor to compare with one click from search results
  5. All 82+ existing unit tests pass after all changes
**Plans:** 3 plans
**UI hint**: yes

Plans:
- [ ] 03-01-PLAN.md — Lane tint backgrounds, sticky lane headers, today indicator, conflict count badges
- [ ] 03-02-PLAN.md — Quick-add button from search results, session hover tooltips
- [ ] 03-03-PLAN.md — Fullscreen compare mode, URL week sharing, keyboard navigation, test verification

### Phase 4: UI Audit Polish
**Goal**: Fix accessibility gaps, color inconsistencies, silent errors, and typography issues from full-app UI review
**Depends on**: Phase 3
**Requirements**: UIFIX-01, UIFIX-02, UIFIX-03, UIFIX-04, UIFIX-05, UIFIX-06, UIFIX-07
**Success Criteria** (what must be TRUE):
  1. All interactive controls have aria-labels (week picker nav, tutor chip remove buttons)
  2. Zero hardcoded Tailwind color classes in discovery-panel, slot-builder, and results-view — all use semantic tokens
  3. DiscoveryPanel shows user-visible error message on API failure (no silent catch)
  4. No text-[8px] or text-[9px] anywhere; text-[10px] documented as intentional dense-UI tier or replaced with text-xs
  5. Data-health error state includes retry guidance
  6. TUTOR_COLORS defined in exactly one file
  7. All 82+ existing unit tests pass
**Plans:** 2 plans
**UI hint**: yes

Plans:
- [x] 04-01-PLAN.md — Aria-labels, semantic colors, error feedback, TUTOR_COLORS consolidation
- [x] 04-02-PLAN.md — Typography standardization, inline style cleanup, data-health UX

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Component Architecture | 3/3 | Complete | 2026-04-10 |
| 2. Streaming & Lazy Loading | 3/3 | Complete | 2026-04-10 |
| 3. Calendar Readability & Workflow Polish | 0/3 | Not started | - |
| 4. UI Audit Polish | 0/2 | Not started | - |
