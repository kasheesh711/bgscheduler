# Requirements: BGScheduler v1.1 — Data Fidelity & Depth

**Defined:** 2026-04-20
**Amended:** 2026-04-29 — Reliability remediation phases 8.5/8.6/8.7 added from codebase audit (REL-01..08, TCOV-01..07, OPS-01..07)
**Core Value:** Admin staff can find, compare, and schedule tutors instantly and independently — no waiting, no confusion, no handholding.
**Milestone Goal:** Close the data-truth gaps (reliable online/onsite, past-day session visibility), ship v2 visual polish (view transitions, sticky tutor legend, density overview), drain the v1.0 polish backlog, and remediate the reliability/test-coverage/operational concerns surfaced by the 2026-04-29 codebase audit so v1.2 starts clean.

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

- [x] **STICKY-01**: Tutor legend (chip strip in compare panel) remains visible during calendar vertical scroll via `position: sticky` — verified 2026-04-29 in 08-VERIFICATION.md §B.1-B.2
- [x] **STICKY-02**: Z-index scale constant is introduced (`z-[2]` content, `z-[4]` legend, `z-[5]` lane headers, `z-[6]` sticky day-header, `z-50` popovers) and applied consistently — verified 2026-04-29 in 08-VERIFICATION.md §A.3, B.3-B.4
  - *Amendment (2026-04-22, Phase 8 CONTEXT D-08..D-10):* Scale simplified at CONTEXT time to a 3-tier scale `Z_CONTENT = 1`, `Z_LEGEND = 6`, `Z_POPOVER = 50` because Phase 8 D-01 consolidates per-day lane headers INTO the single sticky legend — the separate `z-[5]` lane-headers slot is no longer a live surface. CalendarGrid's existing sticky day-header reuses `Z_LEGEND = 6`. Constant ships at `src/lib/ui/z-index.ts` (`export const Z_INDEX = { content: 1, legend: 6, popover: 50 } as const;`). Same class as Phase 5 D-02's NVDA relaxation — no new requirement ID, §Traceability row for STICKY-02 unchanged.
- [x] **STICKY-03**: Pre-implementation stacking-context audit artifact committed alongside the change — verified 2026-04-29 in 08-VERIFICATION.md §A.6, B.7 (audit at `7770166`)
- [x] **STICKY-04**: Fullscreen compare mode preserves sticky legend behavior (no regression) — verified 2026-04-29 in 08-VERIFICATION.md §B.5

### Reliability Hardening (Phase 8.5)

Added 2026-04-29 from codebase audit at `.planning/codebase/CONCERNS.md`. HIGH/MEDIUM severity items only.

- [ ] **REL-01**: Snapshot promotion in `runFullSync` is atomic — single SQL statement (`UPDATE snapshots SET active = (id = $newId)`) replaces the two-UPDATE sequence at `src/lib/sync/orchestrator.ts:471-481`; no window where zero rows match `WHERE active = true`
- [ ] **REL-02**: `ensureIndex` coalesces concurrent rebuilds correctly — atomic check-and-set on the building promise in `src/lib/search/index.ts:281-305`; concurrent first-time callers cannot both kick off rebuilds; reproducer test asserts single rebuild invocation
- [ ] **REL-03**: Identity resolver in `src/lib/normalization/identity.ts:111-150` emits an `identity_collision` `data_issue` when a nickname maps to 3+ teachers without explicit online/offline pair structure (no silent triple-merge)
- [ ] **REL-04**: `hasRecurringLeaveConflict` in `src/lib/search/engine.ts:240-269` computes leave start/end minutes from the day-cursor's date for each iteration, not from `leaveStart` (or always treats multi-day leaves as full-day blocks with documented assumption)
- [ ] **REL-05**: Wise client retry loop at `src/lib/wise/client.ts:67-91` does NOT retry on 4xx (except 429) — only retries on 5xx, network errors, and 429; permanent-error path returns within first response, not after 3 retries
- [ ] **REL-06**: Outer error handler in `src/lib/sync/orchestrator.ts:512-525` logs cleanup failures via `console.error` (no silent `.catch(() => {})`)
- [ ] **REL-07**: `src/app/api/internal/sync-wise/route.ts:11-17` uses `crypto.timingSafeEqual` against equal-length buffers for CRON_SECRET comparison; non-constant-time string equality removed
- [ ] **REL-08**: All "now in Bangkok" derivations use `toZonedTime(new Date(), TIMEZONE)` from `src/lib/normalization/timezone.ts` — the `new Date(new Date().toLocaleString("en-US", { timeZone: ... }))` pattern is removed from `src/app/api/compare/route.ts:28-30`, `src/hooks/use-compare.ts:22-26`, `src/components/compare/week-overview.tsx:235`, `src/components/compare/calendar-grid.tsx:67`, and any other call site

### Test Coverage Hardening (Phase 8.6)

Added 2026-04-29 from codebase audit. Closes HIGH-risk gaps where silent regression would surface only under production load.

- [ ] **TCOV-01**: `src/lib/search/__tests__/index.test.ts` exists and covers `buildIndex` (parallel table loads, denormalization), `ensureIndex` (lazy init, stale detection, concurrent rebuild coalescing), and the snapshot-active race (cached fallback when zero rows match)
- [ ] **TCOV-02**: `src/lib/sync/__tests__/orchestrator.integration.test.ts` exists and exercises `runFullSync` end-to-end against a real Postgres (Neon test branch or local Docker) — fetch → normalize → persist → promote — with at least one happy-path and one fail-mid-promotion case
- [ ] **TCOV-03**: All 7+1 API route handlers have route-level tests: `compare`, `compare/discover`, `filters`, `tutors`, `search`, `search/range`, `data-health`, `internal/sync-wise` — covering auth (200/401), validation (400 with Zod errors), success (200 with shape), and 500 error path
- [ ] **TCOV-04**: `src/lib/sync/__tests__/past-sessions-diff-hook.integration.test.ts` covers the prior-snapshot diff hook against a real DB — prior snapshot has session X, new sync drops X, X dated in past → captured into `past_session_blocks` with idempotent UNIQUE
- [ ] **TCOV-05**: Timezone tests cover UTC/Bangkok day-boundary (sync at 17:00 UTC = 00:00 next-day Bangkok) — assert weekday derivation, `getDay()`, and slot-time arithmetic remain consistent across the boundary
- [ ] **TCOV-06**: Auth tests cover `signIn` callback's allowlist read (`src/lib/auth.ts:18-30`) and middleware bypass paths (`src/middleware.ts:7-14`) — assert that non-admin email is rejected and that internal routes self-check
- [ ] **TCOV-07**: Modality contradiction emission test verifies orchestrator persists `conflict_model` rows to `data_issues` table when `detectSessionModalityConflict` fires (`src/lib/sync/orchestrator.ts:356-387`); not just the in-isolation unit test

### Operational Maturity (Phase 8.7)

Added 2026-04-29 from codebase audit. Operational features and dependency hygiene required to run BGScheduler reliably for 12+ months.

- [x] **OPS-01**: Sync orchestrator prunes snapshots — keeps the last 30 by `createdAt`, cascades delete across all snapshot-scoped tables; `past_session_blocks` (cross-snapshot) unaffected; pruning runs after successful promote
- [x] **OPS-02**: Failed sync runs are surfaced through in-app operational visibility only — `/data-health`, stale-snapshot banner, and manual sync feedback; external notification providers are out of scope and no notification env var is added
- [x] **OPS-03**: Stale-snapshot banner displays on `/search` and `/compare` (not just `/data-health`) when `staleAgeMs > 48h` — banner is dismissible per session and links to `/data-health`
- [x] **OPS-04**: `staleThresholdMs` raised to 26h to match daily Hobby cron cadence in `src/lib/search/engine.ts:24`, `src/app/api/compare/route.ts:85`, `src/app/api/compare/discover/route.ts:60` — comment notes 26h matches Hobby cron + 2h grace
- [x] **OPS-05**: Manual "Sync now" button in `/data-health` UI calls `/api/internal/sync-wise` via authenticated session (Auth.js session cookie) — alternate auth path documented; 401 fallback if session missing
- [x] **OPS-06**: `@auth/drizzle-adapter` removed from `package.json` (unused — auth uses custom callback against `admin_users`); `shadcn` moved to `devDependencies` (CLI-only, not shipped at runtime); bundle size delta documented in PR
- [x] **OPS-07**: `next-auth`, `@base-ui/react`, and `drizzle-orm` are pinned to exact versions (no caret) until each library reaches stable v1.x or v5 GA; `detectConflicts` unused `indexedGroups` parameter removed (`src/lib/search/compare.ts:321`); modality medium-tier TODO at `src/components/compare/modality-display.ts:9-11` is either implemented or documented as intentionally unimplemented

### Visual Polish — Density Overview (VPOL-03)

- [x] **DENS-01**: Density overview component renders aggregated per-tutor booking density across the visible week
- [x] **DENS-02**: Shape A (aggregate day-bar) / B (per-tutor stacked) / C (heatmap) chosen via phase-local design review
- [x] **DENS-03**: Density data derived client-side from existing `CompareResponse.tutors[].sessions[]` via `useMemo` (zero server work)
- [x] **DENS-04**: Density overview respects `prefers-reduced-motion` and has text-equivalent a11y affordances

### Visual Polish — View Transitions (VPOL-01)

- [x] **TRANS-01**: Week prev/next/today navigation animates via native `document.startViewTransition()`
- [x] **TRANS-02**: Day-tab switches in compare view animate via view transition
- [x] **TRANS-03**: `@media (prefers-reduced-motion: reduce)` CSS skips all view-transition animations
- [x] **TRANS-04**: Calendar scroll position is preserved across view transitions (manual `scrollTop` capture/restore)
- [x] **TRANS-05**: View-transition helper lives in `src/lib/ui/view-transitions.ts` and does NOT wrap the RSC streaming boundary

### Backlog Drain — Phase 04 human QA

- [x] **POLISH-01**: Screen-reader AT QA signed off on VoiceOver for search + compare flows (NVDA deferred to v1.2 as NVDA-v12 per Phase 5 CONTEXT.md D-02, 2026-04-21)
- [x] **POLISH-02**: DiscoveryPanel error state verified in production browser (real failure + visible message)
- [x] **POLISH-03**: Semantic color tokens verified rendering correctly in light + dark mode
- [x] **POLISH-04**: Data-health skeleton proportions match post-load content (no layout shift)
- [x] **POLISH-05**: `text-[10px]` legibility verified on production displays and sign-off captured

### Backlog Drain — Phase 03 findings

- [x] **POLISH-06**: URL-sync effect dependencies stabilized / memoized (Phase 03 M1)
- [x] **POLISH-07**: Today-indicator midnight crossover corrected (Phase 03 M2)
- [x] **POLISH-08**: `?week=YYYY-MM-DD` URL param validation is regex-strict, not shape-only (Phase 03 M3)
- [x] **POLISH-09**: Today-indicator uses semantic color token instead of literal `bg-red-500` (Phase 03 L1)
- [x] **POLISH-10**: Dead-code guard `multiTutorLayout` removed (Phase 03 L2)
- [x] **POLISH-11**: `addTutor` wrapped in `useCallback` (Phase 03 L3)
- [x] **POLISH-12**: Mount-effect stale-closure fix applied (Phase 03 L4)

### Backlog Drain — Cross-phase tech debt

- [x] **POLISH-13**: Retroactive `.planning/phases/02-*/02-VERIFICATION.md` attestation
- [x] **POLISH-14**: Unused `TutorSelector` component body removed (`src/components/compare/tutor-selector.tsx:19`)
- [x] **POLISH-15**: v1.0.1 production UAT signed off (recommended-slots hero, copy-for-parent drawer, idiot-proof defaults)
- [x] **POLISH-16**: `recommend.test.ts` unit tests added for v1.0.1 ranking logic (`src/lib/search/recommend.ts`)

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

### Accessibility (deferred)

- **NVDA-v12**: Screen-reader AT QA signed off on NVDA for search + compare flows (Windows-only; deferred from v1.1 POLISH-01 per Phase 5 CONTEXT.md D-02 — user has macOS-only access)

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
| MOD-01 | Phase 6 | Pending |
| MOD-02 | Phase 6 | Pending |
| MOD-03 | Phase 6 | Pending |
| MOD-04 | Phase 6 | Pending |
| MOD-05 | Phase 6 | Pending |
| PAST-01 | Phase 7 | Pending |
| PAST-02 | Phase 7 | Pending |
| PAST-03 | Phase 7 | Pending |
| PAST-04 | Phase 7 | Pending |
| PAST-05 | Phase 7 | Pending |
| PAST-06 | Phase 7 | Pending |
| STICKY-01 | Phase 8 | Complete |
| STICKY-02 | Phase 8 | Complete |
| STICKY-03 | Phase 8 | Complete |
| STICKY-04 | Phase 8 | Complete |
| REL-01 | Phase 8.5 | Pending |
| REL-02 | Phase 8.5 | Pending |
| REL-03 | Phase 8.5 | Pending |
| REL-04 | Phase 8.5 | Pending |
| REL-05 | Phase 8.5 | Pending |
| REL-06 | Phase 8.5 | Pending |
| REL-07 | Phase 8.5 | Pending |
| REL-08 | Phase 8.5 | Pending |
| TCOV-01 | Phase 8.6 | Pending |
| TCOV-02 | Phase 8.6 | Pending |
| TCOV-03 | Phase 8.6 | Pending |
| TCOV-04 | Phase 8.6 | Pending |
| TCOV-05 | Phase 8.6 | Pending |
| TCOV-06 | Phase 8.6 | Pending |
| TCOV-07 | Phase 8.6 | Pending |
| OPS-01 | Phase 8.7 | Complete |
| OPS-02 | Phase 8.7 | Complete |
| OPS-03 | Phase 8.7 | Complete |
| OPS-04 | Phase 8.7 | Complete |
| OPS-05 | Phase 8.7 | Complete |
| OPS-06 | Phase 8.7 | Complete |
| OPS-07 | Phase 8.7 | Complete |
| DENS-01 | Phase 9 | Complete |
| DENS-02 | Phase 9 | Complete |
| DENS-03 | Phase 9 | Complete |
| DENS-04 | Phase 9 | Complete |
| TRANS-01 | Phase 10 | Complete |
| TRANS-02 | Phase 10 | Complete |
| TRANS-03 | Phase 10 | Complete |
| TRANS-04 | Phase 10 | Complete |
| TRANS-05 | Phase 10 | Complete |
| POLISH-01 | Phase 5 | Complete |
| POLISH-02 | Phase 5 | Complete |
| POLISH-03 | Phase 5 | Complete |
| POLISH-04 | Phase 5 | Complete |
| POLISH-05 | Phase 5 | Complete |
| POLISH-06 | Phase 5 | Complete |
| POLISH-07 | Phase 5 | Complete |
| POLISH-08 | Phase 5 | Complete |
| POLISH-09 | Phase 5 | Complete |
| POLISH-10 | Phase 5 | Complete |
| POLISH-11 | Phase 5 | Complete |
| POLISH-12 | Phase 5 | Complete |
| POLISH-13 | Phase 5 | Complete |
| POLISH-14 | Phase 5 | Complete |
| POLISH-15 | Phase 5 | Complete |
| POLISH-16 | Phase 5 | Complete |
| NVDA-v12 | v1.2+ (deferred) | Pending |

**Coverage:**
- v1.1 requirements: 62 total (40 original + 22 reliability remediation)
- Mapped to phases: 62 ✓
- Unmapped: 0

**Phase distribution:**
- Phase 5 POLISH Drain: 16 requirements (POLISH-01..16)
- Phase 6 MOD-01: 5 requirements (MOD-01..05)
- Phase 7 PAST-01: 6 requirements (PAST-01..06)
- Phase 8 VPOL-02: 4 requirements (STICKY-01..04)
- Phase 8.5 Reliability Hardening: 8 requirements (REL-01..08)
- Phase 8.6 Test Coverage Hardening: 7 requirements (TCOV-01..07)
- Phase 8.7 Operational Maturity: 7 requirements (OPS-01..07)
- Phase 9 VPOL-03: 4 requirements (DENS-01..04)
- Phase 10 VPOL-01: 5 requirements (TRANS-01..05)

---
*Requirements defined: 2026-04-20*
*Last updated: 2026-05-09 — Phase 10 VPOL-01 View Transitions verified PASS; TRANS-01..05 complete.*
*Phase 8 D-10 amendment: 2026-04-22 — STICKY-02 scale simplified from 5-slot to 3-tier post-consolidation (see 08-CONTEXT.md D-08..D-10).*
*Reliability remediation amendment: 2026-04-29 — Phases 8.5/8.6/8.7 inserted from `.planning/codebase/CONCERNS.md` (REL-01..08, TCOV-01..07, OPS-01..07).*
