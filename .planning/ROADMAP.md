# Roadmap: BGScheduler

## Milestones

- ✅ **v1.0 Performance & UX Improvement** — Phases 1–4 (shipped 2026-04-17) — see [MILESTONES.md](MILESTONES.md)
- 🚧 **v1.1 Data Fidelity & Depth** — Phases 5–10 + reliability remediation 8.5–8.7 (planning 2026-04-20; remediation phases inserted 2026-04-29 from codebase audit)

## Phases

<details>
<summary>✅ v1.0 Performance & UX Improvement (Phases 1–4) — SHIPPED 2026-04-17</summary>

- [x] Phase 1: Component Architecture (3/3 plans) — completed 2026-04-10
- [x] Phase 2: Streaming & Lazy Loading (3/3 plans) — completed 2026-04-10
- [x] Phase 3: Calendar Readability & Workflow Polish (3/3 plans) — completed 2026-04-17
- [x] Phase 4: UI Audit Polish (2/2 plans) — completed 2026-04-17

Archive: [milestones/v1.0-ROADMAP.md](milestones/v1.0-ROADMAP.md)

</details>

### v1.1 Data Fidelity & Depth (in progress)

- [ ] **Phase 5: POLISH Drain** — Clear v1.0 backlog (human QA, Phase 03 M1–M3 / L1–L4, retroactive VERIFICATION.md, TutorSelector cleanup, v1.0.1 UAT + recommend.test.ts) to establish a11y baseline before feature churn
- [x] **Phase 6: MOD-01 Reliable Modality Detection** — Upgrade resolver to `isOnlineVariant` + `sessionType` primary signals with `modalityConfidence` grading; eliminate silent `supportedModes[0]` fallback; fail-closed test matrix (completed 2026-04-21, gap closure 06-06 completed 2026-04-22 — MOD-UAT-01 fixed in code; post-deploy re-UAT pending)
- [ ] **Phase 7: PAST-01 Past-Day Session Visibility** — Capture past sessions via orchestrator diff-hook into dedicated `past_session_blocks` table with stable canonical keys; dedicated `cacheTag('past-sessions')`; disable weekday-fallback for historical ranges; Wise historical-endpoint spike in parallel
- [x] **Phase 8: VPOL-02 Sticky Tutor Legend** — Pure-CSS `position: sticky` legend in compare panel with documented z-index scale constant and stacking-context audit artifact; preserved across fullscreen (completed 2026-04-29)
- [x] **Phase 8.5: Reliability Hardening** — Atomic snapshot promotion, race-condition fixes, identity-collision detection, retry-policy correctness, leave-overlap minute-of-day fix, timezone-idiom unification, cron-secret timing-safe compare (completed 2026-04-30)
- [x] **Phase 8.6: Test Coverage Hardening** — Close HIGH-risk gaps: search-index unit tests, sync-orchestrator integration tests, all 7 API route handler tests, past-sessions diff-hook integration, timezone DST/UTC-boundary, auth flow, modality contradiction emission (completed 2026-04-30)
- [x] **Phase 8.7: Operational Maturity** — Snapshot pruning (retention), sync failure visibility, stale-snapshot banner, threshold raise to 26h, manual sync UI, dependency cleanup, version pinning (completed 2026-05-05)
- [x] **Phase 9: VPOL-03 Density Overview** — Client-side density aggregation via `useMemo` over existing `CompareResponse.tutors[].sessions[]`; shape (A aggregate / B per-tutor / C heatmap) chosen via phase-local design review; `prefers-reduced-motion` + a11y text equivalents
- [ ] **Phase 10: VPOL-01 View Transitions** — Native `document.startViewTransition()` helper in `src/lib/ui/view-transitions.ts` wired into week prev/next/today + day-tab switches with manual scroll capture/restore and `prefers-reduced-motion` CSS skip

## Phase Details

### Phase 5: POLISH Drain
**Goal**: Clear the v1.0 polish & tech-debt backlog so v1.1 features ship on a verified-clean baseline, and establish the a11y attestation required by downstream VPOL-03 work
**Depends on**: v1.0 shipped (Phase 4)
**Requirements**: POLISH-01, POLISH-02, POLISH-03, POLISH-04, POLISH-05, POLISH-06, POLISH-07, POLISH-08, POLISH-09, POLISH-10, POLISH-11, POLISH-12, POLISH-13, POLISH-14, POLISH-15, POLISH-16
**Success Criteria** (what must be TRUE):
  1. Admin running VoiceOver and NVDA can navigate the search + compare flows end-to-end with signed-off AT QA on production
  2. Discovery error state, semantic color tokens (light + dark), data-health skeleton proportions, and text-[10px] legibility are all visually verified in production with captured sign-off
  3. `/search` no longer re-runs its URL-sync effect with unstable deps, survives a midnight tick without the today indicator jumping to the wrong day, and rejects malformed `?week=` query params
  4. v1.0.1 recommended-slots hero ranking logic has automated unit-test coverage and the `TutorSelector` dead-code body + M2/M3/L1–L4 findings are removed/corrected in `src/`
  5. Retroactive `.planning/phases/02-*/02-VERIFICATION.md` attestation is committed, closing the v1.0 audit chain
**Plans**: 7 plans
  - [x] 05-01-PLAN.md — Prep commit: clean working tree + commit phase archival deletions (D-09/D-10)
  - [x] 05-02-PLAN.md — search-workspace.tsx fixes: POLISH-06 URL-sync deps / POLISH-08 week validator / POLISH-12 stale closure
  - [x] 05-03-PLAN.md — Calendar/week-overview: POLISH-09 today-indicator token / POLISH-07 midnight tick / POLISH-10 dead-code removal
  - [x] 05-04-PLAN.md — Compare hooks + cleanup: POLISH-11 addTutor useCallback / POLISH-14 TutorSelector body removal
  - [x] 05-05-PLAN.md — Test authoring: POLISH-16 recommend.test.ts for v1.0.1 ranking logic
  - [x] 05-06-PLAN.md — POLISH-13 retroactive Phase 02 verification attestation
  - [x] 05-07-PLAN.md — D-02 REQUIREMENTS.md amendment + human-QA walkthrough: POLISH-01/02/03/04/05/15
**UI hint**: yes

### Phase 6: MOD-01 Reliable Modality Detection
**Goal**: Admin sees a trustworthy online/onsite label on every session card with fail-closed Needs Review for ambiguity, and no more silent fallback that guesses a mode
**Depends on**: Phase 5 (CACHE_VERSION constant introduced here — lands in first shape-changing v1.1 phase)
**Requirements**: MOD-01, MOD-02, MOD-03, MOD-04, MOD-05
**Success Criteria** (what must be TRUE):
  1. Admin viewing any session card sees a modality icon (video / map-pin / question-mark) plus popover label; neither border style nor fill color is used for modality
  2. Sessions whose `isOnlineVariant` and `sessionType` signals contradict each other render as Needs Review (`"unknown"`) — never silently labeled online or onsite
  3. Admin can see modality confidence (high / medium / low) surfaced on the session popover, with low-confidence cases visually indistinguishable from unresolved
  4. `compare.test.ts` test matrix asserts `"unknown"` for every contradiction case across `{isOnlineVariant, sessionType, supportedModes}` combinations and blocks merges on regression
  5. `/data-health` dashboard modality-issue counts reflect the tightened detection (higher numbers post-deploy are surface-of-reality, not regression)
**Plans**: 6 plans (all complete; 06-06 gap closure completed 2026-04-22 — post-deploy re-UAT still pending for items 1–3)
  - [x] 06-01-PLAN.md — CACHE_VERSION constant + tutorCache namespace bump (D-17/18/19)
  - [x] 06-02-PLAN.md — Session modality resolver refactor returning {modality, confidence}; eliminate supportedModes[0] fallback; emit conflict_model data_issue through sync orchestrator (MOD-01, MOD-02)
  - [x] 06-03-PLAN.md — /data-health modality counter widened to include conflict_model + expected-rise note (MOD-03)
  - [x] 06-04-PLAN.md — Icon + popover UX on session cards (Video/MapPin/HelpCircle; D-12..D-16); shared modality-display.ts (MOD-04)
  - [x] 06-05-PLAN.md — MOD-05 test matrix + regression lock (D-21/D-22)
  - [x] 06-06-PLAN.md — Gap closure: widen ONLINE_SESSION_TYPES to include "scheduled" for tenant MOD-UAT-01 (~28% of sessions) + tenant-vocab regression matrix cases + STATE.md NULL-rate doc append (commits c9d9aee, 3975394; test count 118 → 120)
**UI hint**: yes

### Phase 7: PAST-01 Past-Day Session Visibility
**Goal**: Admin navigating to a prior week in compare view sees actual past-day sessions captured from snapshot history (with Wise historical endpoint layered on if available), not a weekday-fallback substitute
**Depends on**: Phase 6 (shares CACHE_VERSION convention)
**Requirements**: PAST-01, PAST-02, PAST-03, PAST-04, PAST-05, PAST-06
**Success Criteria** (what must be TRUE):
  1. Admin navigating to a week before the current Monday in compare view sees real captured past sessions per tutor (not the nearest-future occurrence masquerading as past)
  2. Historical ranges render honest empty gaps on days with no captured past sessions — weekday-fallback is silent for future weeks and disabled for historical ones
  3. Daily Wise sync populates the `past_session_blocks` table idempotently via `UNIQUE(wise_session_id)` and a stable `group_canonical_key` that survives snapshot rotation
  4. Queries for historical weeks hit a dedicated `cacheTag('past-sessions')` so the daily snapshot promotion does not refetch immutable past data
  5. Wise historical-sessions endpoint discovery spike to `devs@wiseapp.live` is completed and its result is either wired into the capture path or documented as unavailable; DB-snapshot fallback ships unconditionally
**Plans**: 7 plans
  - [x] 07-01-PLAN.md — Schema + migration: add `past_session_blocks` table with `UNIQUE(wise_session_id)` + `group_canonical_key` (D-04, PAST-05); apply to Neon [BLOCKING]
  - [x] 07-02-PLAN.md — Orchestrator diff-hook: capture dropped-from-FUTURE sessions via prior-snapshot diff before atomic promotion (D-01, PAST-02)
  - [x] 07-03-PLAN.md — Cached past-sessions fetcher at `src/lib/data/past-sessions.ts` with `cacheTag("past-sessions")` + `cacheLife("days")` (D-08, PAST-03)
  - [x] 07-04-PLAN.md — `buildCompareTutor` per-weekday historical flag + past/future merge; expose `canonicalKey` on `IndexedTutorGroup` (D-05, D-06, PAST-01, PAST-04)
  - [x] 07-05-PLAN.md — `/api/compare` server-side historical-range trigger; pre-merge past blocks into `findSharedFreeSlots` (D-07, PAST-01, PAST-04)
  - [x] 07-06-PLAN.md — `CACHE_VERSION` bump v1→v2 (D-17)
  - [x] 07-07-PLAN.md — Wise historical-endpoint spike email draft at `07-WISE-SPIKE.md`; user sends from kevhsh7@gmail.com (D-13, PAST-06)
**UI hint**: yes

### Phase 8: VPOL-02 Sticky Tutor Legend
**Goal**: Admin scrolling the compare calendar vertically never loses the tutor → color mapping because the tutor legend sticks to the top of the scroll container without fighting lane headers or popovers
**Depends on**: Phase 7 (no data dependency; ships after data-fidelity work so sticky animates on verified content). Must precede Phase 10.
**Requirements**: STICKY-01, STICKY-02, STICKY-03, STICKY-04
**Success Criteria** (what must be TRUE):
  1. Admin scrolling the week view down sees the tutor legend remain pinned at the top of the scrollable container at all times
  2. Admin clicking a session near the top of the visible calendar area sees the popover render ABOVE the sticky legend (z-index scale constant is applied consistently across content, legend, lane headers, day-header, popovers)
  3. Stacking-context audit document is committed alongside the code change (proving every ancestor's `overflow`, `transform`, `filter`, `backdrop-blur`, and `z-index` were reviewed)
  4. Admin toggling fullscreen compare mode sees the sticky legend preserved at full width with no regression in behavior
**Plans**: 5 plans
  - [x] 08-01-PLAN.md — Pre-implementation stacking-context audit (08-STACKING-AUDIT.md) + REQUIREMENTS.md §STICKY-02 amendment recording the simplified 3-tier scale (D-11..D-13, D-10; STICKY-02, STICKY-03) — completed 2026-04-22 (`6bf9b5f`)
  - [x] 08-02-PLAN.md — Create `src/lib/ui/z-index.ts` exporting `Z_INDEX = { content: 1, legend: 6, popover: 50 } as const` (D-08..D-09; STICKY-02) — completed 2026-04-22 (`d8494a1`)
  - [x] 08-03-PLAN.md — WeekOverview refactor: replace per-day sticky lane headers (lines 311-344) with single global sticky legend using `Z_INDEX.legend`; remove `multiTutorLayout &&` gate from sticky path; display-only per D-07 (D-01..D-05; STICKY-01, STICKY-02, STICKY-04) — completed 2026-04-29 (`376fa47`)
  - [x] 08-04-PLAN.md — CalendarGrid z-index normalization: replace `z-10` at line 120 with `zIndex: Z_INDEX.legend` while preserving TutorProfilePopover click affordance (D-06..D-07; STICKY-02) — completed 2026-04-29 (`d9c729f`)
  - [x] 08-05-PLAN.md — Verification walkthrough scaffold (08-VERIFICATION.md) + human-QA checkpoint covering all 4 ROADMAP success criteria; REQUIREMENTS.md §Traceability flip to Complete (D-14; STICKY-01..04)
**UI hint**: yes

### Phase 8.5: Reliability Hardening
**Goal**: Eliminate data-integrity, race-condition, and error-path defects surfaced by the 2026-04-29 codebase audit so v1.1 features ship on a verified-reliable backend baseline
**Depends on**: Phase 8 (sticky legend completed; remediation runs after Phase 8 finishes 03/04/05)
**Requirements**: REL-01, REL-02, REL-03, REL-04, REL-05, REL-06, REL-07, REL-08
**Source**: `.planning/codebase/CONCERNS.md` (2026-04-29) — HIGH/MEDIUM severity items only
**Success Criteria** (what must be TRUE):
  1. Snapshot promotion in `runFullSync` is atomic — a single SQL statement (`UPDATE snapshots SET active = (id = $newId)`) replaces the two-UPDATE sequence at `src/lib/sync/orchestrator.ts:471-481`; no window where zero rows match `WHERE active = true`
  2. `ensureIndex` in `src/lib/search/index.ts:281-305` coalesces concurrent rebuilds correctly — atomic check-and-set on the building promise; concurrent first-time callers cannot both kick off rebuilds; reproducer test asserts single rebuild invocation
  3. Identity resolver in `src/lib/normalization/identity.ts:111-150` emits an `identity_collision` `data_issue` when a nickname maps to 3+ teachers without explicit online/offline pair structure (no silent triple-merge)
  4. `hasRecurringLeaveConflict` in `src/lib/search/engine.ts:240-269` computes leave start/end minutes from the day-cursor's date for each iteration, not from `leaveStart` (or always treats multi-day leaves as full-day blocks with documented assumption)
  5. Wise client retry loop at `src/lib/wise/client.ts:67-91` does NOT retry on 4xx (except 429) — only retries on 5xx, network errors, and 429; permanent-error path returns within first response, not after 3 retries
  6. Outer error handler in `src/lib/sync/orchestrator.ts:512-525` logs cleanup failures via `console.error` (no silent `.catch(() => {})`)
  7. `src/app/api/internal/sync-wise/route.ts:11-17` uses `crypto.timingSafeEqual` against equal-length buffers for CRON_SECRET comparison; non-constant-time string equality removed
  8. All "now in Bangkok" derivations use `toZonedTime(new Date(), TIMEZONE)` from `src/lib/normalization/timezone.ts` — the `new Date(new Date().toLocaleString("en-US", { timeZone: ... }))` pattern is removed from `src/app/api/compare/route.ts:28-30`, `src/hooks/use-compare.ts:22-26`, `src/components/compare/week-overview.tsx:235`, `src/components/compare/calendar-grid.tsx:67`, and any other call site
**Plans**: 8 plans
  - [x] 08.5-01-PLAN.md — REL-01 atomic snapshot promotion (single-statement UPDATE with bounded WHERE)
  - [x] 08.5-02-PLAN.md — REL-02 ensureIndex race-free coalescing (synchronous singleton-promise) + reproducer test
  - [x] 08.5-03-PLAN.md — REL-03 identity_collision data_issue emission for triple-merges + 5 unit tests
  - [x] 08.5-04-PLAN.md — REL-04 hasRecurringLeaveConflict refactor (multi-day full-day-block, documented assumption) + 2 lock-in tests
  - [x] 08.5-05-PLAN.md — REL-05 status-code-aware retry policy in WiseClient + 5 retry tests
  - [x] 08.5-06-PLAN.md — REL-06 cleanup-error console.error logging (depends on 08.5-01: same file)
  - [x] 08.5-07-PLAN.md — REL-07 crypto.timingSafeEqual for CRON_SECRET with length guard
  - [x] 08.5-08-PLAN.md — REL-08 timezone idiom unification at 4 call sites + 3 round-trip tests
**UI hint**: no

### Phase 8.6: Test Coverage Hardening
**Goal**: Close HIGH-risk test gaps for modules whose silent regression would surface only under production load, so reliability fixes from Phase 8.5 stay locked-in and future changes are merge-gated
**Depends on**: Phase 8.5 (asserts the fixed behavior; tests authored against post-fix code)
**Requirements**: TCOV-01, TCOV-02, TCOV-03, TCOV-04, TCOV-05, TCOV-06, TCOV-07
**Source**: `.planning/codebase/CONCERNS.md` §Test Coverage Gaps + §Fragile Areas (2026-04-29)
**Success Criteria** (what must be TRUE):
  1. `src/lib/search/__tests__/index.test.ts` exists and covers `buildIndex` (parallel table loads, denormalization), `ensureIndex` (lazy init, stale detection, concurrent rebuild coalescing), and the snapshot-active race (cached fallback when zero rows match)
  2. `src/lib/sync/__tests__/orchestrator.integration.test.ts` exists and exercises `runFullSync` end-to-end against a real Postgres (Neon test branch or local Docker) — fetch → normalize → persist → promote — with at least one happy-path and one fail-mid-promotion case
  3. All 7 API route handlers have route-level tests: `compare`, `compare/discover`, `filters`, `tutors`, `search`, `search/range`, `data-health`, `internal/sync-wise` — covering auth (200/401), validation (400 with Zod errors), success (200 with shape), and 500 error path
  4. `src/lib/sync/__tests__/past-sessions-diff-hook.integration.test.ts` covers the prior-snapshot diff hook against a real DB — prior snapshot has session X, new sync drops X, X dated in past → captured into `past_session_blocks` with idempotent UNIQUE
  5. Timezone tests cover UTC/Bangkok day-boundary (sync at 17:00 UTC = 00:00 next-day Bangkok) — assert weekday derivation, `getDay()`, and slot-time arithmetic remain consistent across the boundary
  6. Auth tests cover `signIn` callback's allowlist read (`src/lib/auth.ts:18-30`) and middleware bypass paths (`src/middleware.ts:7-14`) — assert that non-admin email is rejected and that internal routes self-check
  7. Modality contradiction emission test verifies orchestrator persists `conflict_model` rows to `data_issues` table when `detectSessionModalityConflict` fires (`src/lib/sync/orchestrator.ts:356-387`); not just the in-isolation unit test
**Plans**: 8 plans
  - [x] 08.6-01-PLAN.md — Test infrastructure setup: testcontainers + node-postgres + db-helper.ts + vitest.config.ts projects pattern + npm scripts
  - [x] 08.6-02-PLAN.md — TCOV-01: Search-index tests (buildIndex denormalization, byWeekday map, snapshot-active race fallback)
  - [x] 08.6-03-PLAN.md — TCOV-02: Orchestrator runFullSync integration test against real Postgres (depends on 08.6-01)
  - [x] 08.6-04-PLAN.md — TCOV-03: All 8 API route handler tests (compare, compare/discover, search, search/range, data-health, filters, tutors, internal/sync-wise)
  - [x] 08.6-05-PLAN.md — TCOV-04: Past-sessions diff-hook integration test + delete broken unit test (depends on 08.6-01)
  - [x] 08.6-06-PLAN.md — TCOV-05: Timezone day-boundary tests (UTC 17:00 = BKK 00:00 next day)
  - [x] 08.6-07-PLAN.md — TCOV-06: Auth signIn callback + middleware bypass tests (with tiny additive auth.ts refactor)
  - [x] 08.6-08-PLAN.md — TCOV-07: Orchestrator modality-conflict persistence test (db.insert stub, no DB)
**UI hint**: no

### Phase 8.7: Operational Maturity
**Goal**: Add the operational features and lower-priority cleanups required to run BGScheduler reliably in production for the next 12+ months — retention, in-app failure visibility, observability, and dependency hygiene
**Depends on**: Phase 8.6 (ops changes ride on top of fixed + tested baseline)
**Requirements**: OPS-01, OPS-02, OPS-03, OPS-04, OPS-05, OPS-06, OPS-07
**Source**: `.planning/codebase/CONCERNS.md` §Missing Critical Features + §Dependencies at Risk + low-severity §Tech Debt items (2026-04-29)
**Success Criteria** (what must be TRUE):
  1. Sync orchestrator prunes snapshots — keeps the last 30 by `createdAt`, cascades delete across all snapshot-scoped tables; `past_session_blocks` (cross-snapshot) unaffected; pruning runs after successful promote
  2. Failed sync runs are surfaced through in-app operational visibility only — `/data-health`, stale-snapshot banner, and manual sync feedback; external notification providers are out of scope and no notification env var is added
  3. Stale-snapshot banner displays on `/search` and `/compare` (not just `/data-health`) when `staleAgeMs > 48h` — banner is dismissible per session and links to `/data-health`
  4. `staleThresholdMs` raised to 26h to match daily Hobby cron cadence in `src/lib/search/engine.ts:24`, `src/app/api/compare/route.ts:85`, `src/app/api/compare/discover/route.ts:60` — comment notes 26h matches Hobby cron + 2h grace
  5. Manual "Sync now" button in `/data-health` UI calls `/api/internal/sync-wise` via authenticated session (Auth.js session cookie) — alternate auth path documented; 401 fallback if session missing
  6. `@auth/drizzle-adapter` removed from `package.json` (unused — auth uses custom callback against `admin_users`); `shadcn` moved to `devDependencies` (CLI-only, not shipped at runtime); bundle size delta documented in PR
  7. `next-auth`, `@base-ui/react`, and `drizzle-orm` are pinned to exact versions (no caret) until each library reaches stable v1.x or v5 GA; `detectConflicts` unused `indexedGroups` parameter removed (`src/lib/search/compare.ts:321`); modality medium-tier TODO at `src/components/compare/modality-display.ts:9-11` is either implemented or documented as intentionally unimplemented
**Plans**:
  - [x] 08.7-01-PLAN.md — OPS-01: Snapshot pruning helper + orchestrator integration
  - [x] 08.7-02-PLAN.md — OPS-02/03/04: In-app sync visibility, 26h stale threshold, app-level stale banner
  - [x] 08.7-03-PLAN.md — OPS-05: Manual Sync now via authenticated admin-session POST
  - [x] 08.7-04-PLAN.md — OPS-06/07: Dependency cleanup, exact version pinning, package and bundle impact note
  - [x] 08.7-05-PLAN.md — OPS-07: `detectConflicts` and modality medium-tier TODO hygiene
**UI hint**: yes

### Phase 9: VPOL-03 Density Overview
**Goal**: Admin can see at-a-glance per-tutor booking density across the visible week without leaving the calendar, with a11y-compliant affordances and zero new server work
**Depends on**: Phase 5 (POLISH-01..05 a11y baseline verified), Phase 8 (sticky layout established), Phase 8.7 (reliability remediation cleared)
**Requirements**: DENS-01, DENS-02, DENS-03, DENS-04
**Success Criteria** (what must be TRUE):
  1. Admin viewing the compare panel sees a density overview component that renders aggregated per-tutor booking density across the visible week without an additional network request
  2. Shape (A aggregate day-bar / B per-tutor stacked / C GitHub-heatmap) is chosen and documented via a phase-local design review with a captured rationale
  3. Density data derives entirely from existing `CompareResponse.tutors[].sessions[]` via `useMemo` — no new API endpoint, no SearchIndex change, no schema change
  4. Admin with `prefers-reduced-motion: reduce` sees no animated transitions in the density view, and screen-reader users receive text-equivalent affordances (aria-label, aria-describedby, or equivalent per cell / region)
**Plans**: 3 plans
  - [x] 09-01-PLAN.md - Density design artifact plus tested DensityOverview component
  - [x] 09-02-PLAN.md - ComparePanel integration plus frontend-only guardrail verification
  - [x] 09-03-PLAN.md - Automated evidence plus human visual/a11y verification checkpoint
**UI hint**: yes

### Phase 10: VPOL-01 View Transitions
**Goal**: Admin navigating weeks, days, and the compare panel experiences smooth animated transitions on a frozen visual baseline — with zero regression in streaming RSC, scroll restoration, or accessibility
**Depends on**: Phase 8 (sticky legend frozen) and Phase 9 (density frozen). Ships LAST in v1.1 because it animates the baseline.
**Requirements**: TRANS-01, TRANS-02, TRANS-03, TRANS-04, TRANS-05
**Success Criteria** (what must be TRUE):
  1. Admin clicking week prev/next/today (arrows, button, calendar popup) sees the compare panel animate via `document.startViewTransition()` with ≤200ms duration
  2. Admin switching between day tabs in compare view sees the animated transition between day views without flicker or Suspense fallback capture
  3. Admin with `prefers-reduced-motion: reduce` gets instant navigation with zero animation (CSS media query skips all view-transition keyframes)
  4. Admin returning to a previously-scrolled time-of-day position in the calendar after a week change finds the scroll position preserved (manual `scrollTop` capture/restore honoring the internal calendar container, not the document)
  5. View-transition helper lives in `src/lib/ui/view-transitions.ts`, is called from client-state handlers (week change, day switch), and explicitly does NOT wrap the RSC streaming boundary or `cacheComponents`-tagged server data
**Plans**: 4 plans
  - [x] 10-01-PLAN.md - Typed native view-transition helper plus unit tests
  - [ ] 10-02-PLAN.md - Fetch-first week timing path in `useCompare`
  - [ ] 10-03-PLAN.md - ComparePanel week/day wiring, scroll preservation, and CSS
  - [ ] 10-04-PLAN.md - Automated evidence plus browser QA checkpoint
**UI hint**: yes

## Next Milestone

v1.1 Data Fidelity & Depth is the current active milestone. Next after v1.1 is a candidate v1.2 Advanced Workflow milestone (AWRK-01..03 + carried-forward differentiators from MOD/PAST/VPOL backlogs).

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Component Architecture | v1.0 | 3/3 | Complete | 2026-04-10 |
| 2. Streaming & Lazy Loading | v1.0 | 3/3 | Complete | 2026-04-10 |
| 3. Calendar Readability & Workflow Polish | v1.0 | 3/3 | Complete | 2026-04-17 |
| 4. UI Audit Polish | v1.0 | 2/2 | Complete | 2026-04-17 |
| 5. POLISH Drain | v1.1 | 0/7 | Planned | - |
| 6. MOD-01 Reliable Modality Detection | v1.1 | 5/6 | Gap closure | 2026-04-21 |
| 7. PAST-01 Past-Day Session Visibility | v1.1 | 0/? | Not started | - |
| 8. VPOL-02 Sticky Tutor Legend | v1.1 | 5/5 | Complete    | 2026-04-29 |
| 8.5. Reliability Hardening | v1.1 | 8/8 | Complete | 2026-04-30 |
| 8.6. Test Coverage Hardening | v1.1 | 8/8 | Complete | 2026-04-30 |
| 8.7. Operational Maturity | v1.1 | 5/5 | Complete | 2026-05-05 |
| 9. VPOL-03 Density Overview | v1.1 | 3/3 | Complete | 2026-05-08 |
| 10. VPOL-01 View Transitions | v1.1 | 1/4 | In Progress|  |
