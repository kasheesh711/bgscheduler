# Milestones

Historical record of shipped BGScheduler versions.

---

## v1.0 — Performance & UX Improvement

**Shipped:** 2026-04-17
**Archive:** [milestones/v1.0-ROADMAP.md](milestones/v1.0-ROADMAP.md)
**Requirements:** [milestones/v1.0-REQUIREMENTS.md](milestones/v1.0-REQUIREMENTS.md)
**Audit:** [milestones/v1.0-MILESTONE-AUDIT.md](milestones/v1.0-MILESTONE-AUDIT.md)

**Delivered:** Transforms a sluggish monolithic scheduling tool into a snappy, GCal-style workspace with server-streamed data, lazy-loaded calendar components, one-click compare workflow, and accessibility-audited UI.

### Stats
- **Phases:** 4
- **Plans:** 11
- **Requirements:** 24/24 satisfied
- **Tests:** 82 → 246 passing
- **Files changed:** 178 (+42,592 / −4,233, including `.planning/` artifacts)
- **Commits:** ~111
- **Timeline:** 2026-04-10 → 2026-04-17 (~7 days)

### Key Accomplishments
1. **Phase 1 — Component Architecture:** Decomposed 878-line monolithic search page into SearchForm, SearchResults, ComparePanel, SearchWorkspace components + `useCompare` hook; DB/SearchIndex singletons anchored on `globalThis` for HMR safety
2. **Phase 2 — Streaming & Lazy Loading:** Async Server Component with `cacheComponents: true`, `'use cache'` + `cacheTag('snapshot')` for filter/tutor data; route-level `loading.tsx` skeleton; lazy-loaded WeekOverview, CalendarGrid, DiscoveryPanel via `next/dynamic`
3. **Phase 3 — Calendar Readability:** Per-tutor lane tints (5% opacity), sticky lane headers, red today indicator line, numeric conflict count badges, native hover tooltips on session cards
4. **Phase 3 — Workflow Polish:** One-click quick-add "+" button on every result row (3 clicks → 1), fullscreen compare toggle, `?week=YYYY-MM-DD` URL sync, ArrowLeft/Right week keyboard nav (guarded against input/textarea/contentEditable focus), 246 tests passing
5. **Phase 4 — UI Audit Polish:** aria-labels on week picker + chip remove, semantic color tokens replacing hardcoded `text-yellow-500`/`text-red-400`/`text-green-400`/`bg-yellow-50`/`text-red-600`, visible DiscoveryPanel error feedback (no silent catch), TUTOR_COLORS consolidation, typography standardization (no text-[8px]/[9px]), data-health skeleton + retry guidance
6. **Post-phase code review:** Six findings remediated (WR-01 through WR-06): fetchCompare recursion guard, non-OK fetch surfacing, slot-label bounds check, data-health response status, effect-driven recent-search trigger

### Known Gaps / Tech Debt Carried Forward
- **Phase 02 doc gap:** No formal `02-VERIFICATION.md`; deliverables independently confirmed by integration checker against live source
- **Phase 04 human QA (5 items):** screen-reader announcement QA (VoiceOver/NVDA), discovery error state in real browser, semantic colors in light/dark rendering, data-health skeleton proportions, text-[10px] legibility on production displays
- **Phase 03 accepted polish findings:** M1 (URL-sync effect deps unmemoized), M2 (midnight crossover edge), M3 (`?week=` regex shape-only), L1 (bg-red-500 literal vs semantic token), L2 (dead-code guard), L3 (missing `useCallback` on `addTutor`), L4 (mount-effect closure fragility)
- **Cross-cutting:** Unused `TutorSelector` component body at `src/components/compare/tutor-selector.tsx:19`

---

_Latest milestone first. Full phase-by-phase detail in each archive._
