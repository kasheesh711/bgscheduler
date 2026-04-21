# Roadmap: BGScheduler

## Milestones

- ✅ **v1.0 Performance & UX Improvement** — Phases 1–4 (shipped 2026-04-17) — see [MILESTONES.md](MILESTONES.md)
- 🚧 **v1.1 Data Fidelity & Depth** — Phases 5–10 (planning 2026-04-20)

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
- [ ] **Phase 6: MOD-01 Reliable Modality Detection** — Upgrade resolver to `isOnlineVariant` + `sessionType` primary signals with `modalityConfidence` grading; eliminate silent `supportedModes[0]` fallback; fail-closed test matrix
- [ ] **Phase 7: PAST-01 Past-Day Session Visibility** — Capture past sessions via orchestrator diff-hook into dedicated `past_session_blocks` table with stable canonical keys; dedicated `cacheTag('past-sessions')`; disable weekday-fallback for historical ranges; Wise historical-endpoint spike in parallel
- [ ] **Phase 8: VPOL-02 Sticky Tutor Legend** — Pure-CSS `position: sticky` legend in compare panel with documented z-index scale constant and stacking-context audit artifact; preserved across fullscreen
- [ ] **Phase 9: VPOL-03 Density Overview** — Client-side density aggregation via `useMemo` over existing `CompareResponse.tutors[].sessions[]`; shape (A aggregate / B per-tutor / C heatmap) chosen via phase-local design review; `prefers-reduced-motion` + a11y text equivalents
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
  - [ ] 05-01-PLAN.md — Prep commit: clean working tree + commit phase archival deletions (D-09/D-10)
  - [ ] 05-02-PLAN.md — search-workspace.tsx fixes: POLISH-06 URL-sync deps / POLISH-08 week validator / POLISH-12 stale closure
  - [ ] 05-03-PLAN.md — Calendar/week-overview: POLISH-09 today-indicator token / POLISH-07 midnight tick / POLISH-10 dead-code removal
  - [ ] 05-04-PLAN.md — Compare hooks + cleanup: POLISH-11 addTutor useCallback / POLISH-14 TutorSelector body removal
  - [ ] 05-05-PLAN.md — Test authoring: POLISH-16 recommend.test.ts for v1.0.1 ranking logic
  - [ ] 05-06-PLAN.md — POLISH-13 retroactive Phase 02 verification attestation
  - [ ] 05-07-PLAN.md — D-02 REQUIREMENTS.md amendment + human-QA walkthrough: POLISH-01/02/03/04/05/15
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
**Plans**: TBD
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
**Plans**: TBD
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
**Plans**: TBD
**UI hint**: yes

### Phase 9: VPOL-03 Density Overview
**Goal**: Admin can see at-a-glance per-tutor booking density across the visible week without leaving the calendar, with a11y-compliant affordances and zero new server work
**Depends on**: Phase 5 (POLISH-01..05 a11y baseline verified) and Phase 8 (sticky layout established)
**Requirements**: DENS-01, DENS-02, DENS-03, DENS-04
**Success Criteria** (what must be TRUE):
  1. Admin viewing the compare panel sees a density overview component that renders aggregated per-tutor booking density across the visible week without an additional network request
  2. Shape (A aggregate day-bar / B per-tutor stacked / C GitHub-heatmap) is chosen and documented via a phase-local design review with a captured rationale
  3. Density data derives entirely from existing `CompareResponse.tutors[].sessions[]` via `useMemo` — no new API endpoint, no SearchIndex change, no schema change
  4. Admin with `prefers-reduced-motion: reduce` sees no animated transitions in the density view, and screen-reader users receive text-equivalent affordances (aria-label, aria-describedby, or equivalent per cell / region)
**Plans**: TBD
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
**Plans**: TBD
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
| 6. MOD-01 Reliable Modality Detection | v1.1 | 0/? | Not started | - |
| 7. PAST-01 Past-Day Session Visibility | v1.1 | 0/? | Not started | - |
| 8. VPOL-02 Sticky Tutor Legend | v1.1 | 0/? | Not started | - |
| 9. VPOL-03 Density Overview | v1.1 | 0/? | Not started | - |
| 10. VPOL-01 View Transitions | v1.1 | 0/? | Not started | - |
