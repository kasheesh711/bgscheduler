# Requirements: BGScheduler v1.1 — Data Fidelity & Depth

**Defined:** 2026-04-20
**Core Value:** Admin staff can find, compare, and schedule tutors instantly and independently — no waiting, no confusion, no handholding.
**Milestone Goal:** Close the data-truth gaps (reliable online/onsite, past-day session visibility), ship v2 visual polish (view transitions, sticky tutor legend, density overview), and drain the v1.0 polish backlog so v1.2 starts clean.

## v1.1 Requirements

Requirements for this milestone. Each maps to exactly one roadmap phase.

### Modality (online/onsite detection)

- [ ] **MOD-01**: Session modality is resolved from `isOnlineVariant` (teacher record) + `sessionType` (session record) as primary signals, not location heuristics
- [ ] **MOD-02**: Ambiguous modality routes to `"unknown"` / Needs Review — no silent `supportedModes[0]` fallback in `resolveSessionModality`
- [ ] **MOD-03**: Modality resolver returns `modalityConfidence: "high" | "medium" | "low"` alongside the resolved value
- [ ] **MOD-04**: Session cards display modality via icon + popover label (never color/border — those are reserved for tutor identity)
- [ ] **MOD-05**: Fail-closed test matrix in `compare.test.ts` asserts `"unknown"` for every contradiction case (teacher online-variant + onsite session type, etc.)

### History (past-day session visibility)

- [ ] **PAST-01**: Admin can navigate to prior weeks in compare view and see actual past-day sessions (not a "representative" fallback)
- [ ] **PAST-02**: Daily sync orchestrator captures sessions that were FUTURE on the prior day but are no longer returned into a `past_session_blocks` table
- [ ] **PAST-03**: Historical queries use a dedicated `cacheTag('past-sessions')` separate from `'snapshot'` — daily sync invalidation does not refetch past data
- [ ] **PAST-04**: Weekday-fallback logic in `buildCompareTutor` is disabled when the requested range is historical (no future sessions masquerading as past)
- [ ] **PAST-05**: `past_session_blocks` schema uses `UNIQUE(wise_session_id)` for idempotent capture + `group_canonical_key` stable across snapshot rotations
- [ ] **PAST-06**: Wise historical-sessions endpoint is spiked (`devs@wiseapp.live`); if available, it's used in addition to snapshot-based capture

### Visual Polish — Sticky Tutor Legend (VPOL-02)

- [ ] **STICKY-01**: Tutor legend (chip strip in compare panel) remains visible during calendar vertical scroll via `position: sticky`
- [ ] **STICKY-02**: Z-index scale constant is introduced (`z-[2]` content, `z-[4]` legend, `z-[5]` lane headers, `z-[6]` sticky day-header, `z-50` popovers) and applied consistently
- [ ] **STICKY-03**: Pre-implementation stacking-context audit artifact committed alongside the change
- [ ] **STICKY-04**: Fullscreen compare mode preserves sticky legend behavior (no regression)

### Visual Polish — Density Overview (VPOL-03)

- [ ] **DENS-01**: Density overview component renders aggregated per-tutor booking density across the visible week
- [ ] **DENS-02**: Shape A (aggregate day-bar) / B (per-tutor stacked) / C (heatmap) chosen via phase-local design review
- [ ] **DENS-03**: Density data derived client-side from existing `CompareResponse.tutors[].sessions[]` via `useMemo` (zero server work)
- [ ] **DENS-04**: Density overview respects `prefers-reduced-motion` and has text-equivalent a11y affordances

### Visual Polish — View Transitions (VPOL-01)

- [ ] **TRANS-01**: Week prev/next/today navigation animates via native `document.startViewTransition()`
- [ ] **TRANS-02**: Day-tab switches in compare view animate via view transition
- [ ] **TRANS-03**: `@media (prefers-reduced-motion: reduce)` CSS skips all view-transition animations
- [ ] **TRANS-04**: Calendar scroll position is preserved across view transitions (manual `scrollTop` capture/restore)
- [ ] **TRANS-05**: View-transition helper lives in `src/lib/ui/view-transitions.ts` and does NOT wrap the RSC streaming boundary

### Backlog Drain — Phase 04 human QA

- [ ] **POLISH-01**: Screen-reader AT QA signed off on VoiceOver + NVDA for search + compare flows
- [ ] **POLISH-02**: DiscoveryPanel error state verified in production browser (real failure + visible message)
- [ ] **POLISH-03**: Semantic color tokens verified rendering correctly in light + dark mode
- [ ] **POLISH-04**: Data-health skeleton proportions match post-load content (no layout shift)
- [ ] **POLISH-05**: `text-[10px]` legibility verified on production displays and sign-off captured

### Backlog Drain — Phase 03 findings

- [ ] **POLISH-06**: URL-sync effect dependencies stabilized / memoized (Phase 03 M1)
- [ ] **POLISH-07**: Today-indicator midnight crossover corrected (Phase 03 M2)
- [ ] **POLISH-08**: `?week=YYYY-MM-DD` URL param validation is regex-strict, not shape-only (Phase 03 M3)
- [ ] **POLISH-09**: Today-indicator uses semantic color token instead of literal `bg-red-500` (Phase 03 L1)
- [ ] **POLISH-10**: Dead-code guard `multiTutorLayout` removed (Phase 03 L2)
- [ ] **POLISH-11**: `addTutor` wrapped in `useCallback` (Phase 03 L3)
- [ ] **POLISH-12**: Mount-effect stale-closure fix applied (Phase 03 L4)

### Backlog Drain — Cross-phase tech debt

- [ ] **POLISH-13**: Retroactive `.planning/phases/02-*/02-VERIFICATION.md` attestation
- [ ] **POLISH-14**: Unused `TutorSelector` component body removed (`src/components/compare/tutor-selector.tsx:19`)
- [ ] **POLISH-15**: v1.0.1 production UAT signed off (recommended-slots hero, copy-for-parent drawer, idiot-proof defaults)
- [ ] **POLISH-16**: `recommend.test.ts` unit tests added for v1.0.1 ranking logic (`src/lib/search/recommend.ts`)

## v1.2+ Requirements

Deferred to future release. Tracked but not in current roadmap.

### Advanced Workflow

- **AWRK-01**: Admin can trigger inline actions on free-slot indicators (copy for parent, quick-schedule)
- **AWRK-02**: Compare view surfaces suggested conflict resolutions (swap tutors, alternative times)
- **AWRK-03**: Admin can drag-to-select time ranges in the week grid

### Modality (deferred)

- **MOD-06**: Modality filter dropdown in search (`online`/`onsite`/`either`) with confidence-grading honoured
- **MOD-07**: Tutor profile popover surfaces a modality summary per-session

### History (deferred)

- **PAST-07**: Multi-snapshot diff view showing session changes over time
- **PAST-08**: Source-of-truth badge on past-day cards (snapshot vs live-endpoint origin)

### View Transitions (deferred)

- **TRANS-06**: Shared-element transitions for tutor cards when adding/removing from compare
- **TRANS-07**: Fullscreen toggle animates with a morph transition

### Sticky / Legend (deferred)

- **STICKY-05**: Hover preview on legend chip shows the tutor's week-at-a-glance
- **STICKY-06**: Jump-to-next-session action on legend chip

### Density (deferred)

- **DENS-05**: Click-to-jump-to-hour on density indicator
- **DENS-06**: Utilisation % summary per tutor/week

### Recommended Slots (deferred)

- **TELEM-01**: Telemetry on which recommended-slot tier gets copied most (logged to existing infra)
- **RECURDATE-01**: Recurring-mode recommended-slot cards show explicit calendar date alongside "every week"

## Out of Scope

Explicitly excluded for v1.1. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Motion/animation library (framer-motion, motion, react-spring) | Native `document.startViewTransition()` covers VPOL-01; library is unjustified bundle weight |
| Chart library (recharts, visx, d3) | VPOL-03 density is ≤20 lines of inline SVG; library is unjustified |
| Next.js `experimental.viewTransition` | Known conflict with required `cacheComponents: true` (Vercel/next.js #85693) |
| Admin override UI for modality | v1.1 keeps modality fail-closed with confidence grading; user override is v1.2+ territory if needed |
| Mobile/tablet responsive redesign | Admin staff desktop-only (unchanged from v1.0) |
| Color palette changes | Sky blue palette stays (user preference, unchanged from v1.0) |
| Calendar grid layout overhaul | GCal-style stays (user preference, unchanged from v1.0) |
| Wise API / sync pipeline overhaul | Data layer is stable; PAST-01 adds one capture hook, does not refactor sync |
| Drag-and-drop rescheduling | Read-only tool; write-back creates integrity risk (unchanged from v1.0) |
| Real-time collaborative viewing | Only 8 users; WebSocket overkill (unchanged from v1.0) |
| Stack framework changes | Next.js 16 / Tailwind 4 / Drizzle / Neon locked (unchanged from v1.0) |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| MOD-01 | TBD | Pending |
| MOD-02 | TBD | Pending |
| MOD-03 | TBD | Pending |
| MOD-04 | TBD | Pending |
| MOD-05 | TBD | Pending |
| PAST-01 | TBD | Pending |
| PAST-02 | TBD | Pending |
| PAST-03 | TBD | Pending |
| PAST-04 | TBD | Pending |
| PAST-05 | TBD | Pending |
| PAST-06 | TBD | Pending |
| STICKY-01 | TBD | Pending |
| STICKY-02 | TBD | Pending |
| STICKY-03 | TBD | Pending |
| STICKY-04 | TBD | Pending |
| DENS-01 | TBD | Pending |
| DENS-02 | TBD | Pending |
| DENS-03 | TBD | Pending |
| DENS-04 | TBD | Pending |
| TRANS-01 | TBD | Pending |
| TRANS-02 | TBD | Pending |
| TRANS-03 | TBD | Pending |
| TRANS-04 | TBD | Pending |
| TRANS-05 | TBD | Pending |
| POLISH-01 | TBD | Pending |
| POLISH-02 | TBD | Pending |
| POLISH-03 | TBD | Pending |
| POLISH-04 | TBD | Pending |
| POLISH-05 | TBD | Pending |
| POLISH-06 | TBD | Pending |
| POLISH-07 | TBD | Pending |
| POLISH-08 | TBD | Pending |
| POLISH-09 | TBD | Pending |
| POLISH-10 | TBD | Pending |
| POLISH-11 | TBD | Pending |
| POLISH-12 | TBD | Pending |
| POLISH-13 | TBD | Pending |
| POLISH-14 | TBD | Pending |
| POLISH-15 | TBD | Pending |
| POLISH-16 | TBD | Pending |

**Coverage:**
- v1.1 requirements: 40 total
- Mapped to phases: 0 (roadmap pending)
- Unmapped: 40 ⚠️ (populated during roadmap creation)

---
*Requirements defined: 2026-04-20*
*Last updated: 2026-04-20 after /gsd-new-milestone scoping*
