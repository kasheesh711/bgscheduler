# Project Research Summary

**Project:** BGScheduler v1.1 — Data Fidelity & Depth
**Domain:** Tutor scheduling / Internal admin tool
**Researched:** 2026-04-20
**Confidence:** HIGH

## Executive Summary

v1.1 closes two data-truth gaps (online/onsite detection, past-day session visibility) and ships three visual-polish upgrades (view transitions, sticky tutor legend, density overview), plus drains the v1.0 polish backlog (POLISH-01..16). All four research tracks converge: **v1.1 is a "tighten what exists" milestone, not a "build something new" one** — no new dependencies, no new framework features, and (with one exception) no new database tables. The existing stack (Next.js 16.2.2, React 19.2.4 stable, Tailwind CSS 4, Drizzle + Neon, shadcn/ui, `document.startViewTransition()` native browser API, inline SVG) covers every target feature.

The dominant technical risk is **fail-closed regression on MOD-01**. The current session-level modality resolver (`src/lib/search/compare.ts:27-70`) has a silent fallback (`return group.supportedModes[0]`) that guesses onsite/online for ambiguous cases — exactly the behavior v1.1's "reliable detection" promise must eliminate. The secondary risk is **stacking-context collisions** on VPOL-02 (existing `z-[5]` lane headers + `z-50` popovers + new sticky legend without a documented z-index scale).

All four research files converge on a **single recommended phase order: POLISH drain → MOD-01 → PAST-01 → VPOL-02 → VPOL-03 → VPOL-01**, with VPOL-01 last because it animates a frozen visual baseline. VPOL-03's visual shape is deferred to phase-local design review (3 candidate shapes: aggregate day-bar, per-tutor stacked bar, GitHub-heatmap). The one open research question — Wise historical-sessions endpoint existence — is flagged as a **parallel spike during PAST-01 phase planning**, not a blocker: DB-snapshot fallback ships unconditionally.

## Key Findings

### Recommended Stack

Zero new dependencies for v1.1. Every target feature ships on the existing stack.

**Core technologies (existing, no additions):**
- **`document.startViewTransition()`** (browser-native API, Baseline Newly Available Oct 2025) — VPOL-01 — 0 kb, no library needed, runs entirely client-side after React commit. Explicitly NOT `motion`/`framer-motion` (unnecessary) and NOT Next.js `experimental.viewTransition` (unresolved conflict with `cacheComponents: true` per Vercel/next.js #85693)
- **Tailwind CSS 4 `position: sticky` + inline SVG** — VPOL-02, VPOL-03 — prior art at `week-overview.tsx:297` + `calendar-grid.tsx:103`; density mini-map is ≤20-line SVG (no recharts/visx/d3 justified)
- **Existing Drizzle + Neon Postgres** — PAST-01 fallback adds one table (`past_session_blocks`) via one Drizzle migration
- **Existing Zod + Wise type escape hatches (`[key: string]: unknown`)** — MOD-01 type tightening; `WiseTeacher.isOnlineVariant` and `WiseSession.type` already addressable through current types

See [STACK.md](./STACK.md) for full dependency analysis and the rejected alternatives (motion libraries, chart libraries, `experimental.viewTransition`).

### Expected Features

**Must have (table stakes across GCal / Cal.com / Calendly / Cron / Outlook convention):**
- **MOD-01** — icon + popover label for modality (never color/border); Needs Review icon variant for unresolved cases — users expect this in any scheduling tool
- **PAST-01** — either real historical sessions or a clearly-labeled "representative schedule" empty state — users expect past-day visibility
- **VPOL-02** — sticky tutor legend during calendar scroll — fundamental to multi-person compare views

**Should have (differentiators):**
- **VPOL-01** — cross-fade on week/day/fullscreen transitions (directional slide is further differentiator)
- **VPOL-03** — density overview for quick-skim of booked vs free time — research leans toward Shape B (per-tutor stacked bar) for compare value; Shape A (aggregate day-bar) is lowest-effort
- **Optional MOD-01 modality filter** — filter search by online/onsite

**Defer (v1.2+):**
- MOD-01 modality summary in popover
- PAST-01 multi-snapshot diff view + source-of-truth badge
- VPOL-01 shared-element transitions
- VPOL-02 hover preview / jump-to-next-session
- VPOL-03 click-to-jump-to-hour + utilisation %

See [FEATURES.md](./FEATURES.md) for per-feature tables and VPOL-03 shape comparison.

### Architecture Approach

Post-v1.1 system shape is unchanged from v1.0. Five bolt-ons without refactoring the ETL pipeline, SearchIndex singleton, `cacheComponents` streaming, or client-side tutor cache.

**Major components (modifications):**
1. **Modality resolver** — `src/lib/normalization/modality.ts` + `src/lib/search/compare.ts::resolveSessionModality` — upgrade from heuristic cascade to `isOnlineVariant` + `sessionType` primary signals; add `modalityConfidence: "high"|"medium"|"low"` return; remove silent `group.supportedModes[0]` fallback
2. **Past-session storage** — new `past_session_blocks` table (NOT snapshot-scoped; keyed `UNIQUE(wise_session_id)` + `group_canonical_key` stable across snapshots) + new helper `src/lib/data/past-sessions.ts` + orchestrator diff-hook (captures sessions that were FUTURE yesterday and are now gone) + `cacheTag('past-sessions')` separate from `'snapshot'` — past queries stay OUT of warm SearchIndex to preserve cold-start budget
3. **View-transition helper** — new `src/lib/ui/view-transitions.ts` using native `document.startViewTransition()` — hooked into `use-compare.ts` `changeWeek`/`setActiveDay`; explicitly NOT wrapping RSC streaming boundary
4. **Sticky legend** — pure CSS `position: sticky` on `compare-panel.tsx` chip strip + documented z-index scale (`z-[2]` content, `z-[4]` legend, `z-[5]` lane headers, `z-[6]` sticky day-header, `z-50` popovers)
5. **Density mini-map** — new `src/components/compare/density-mini-map.tsx` — client-side `useMemo` over existing `CompareResponse.tutors[].sessions[]`; zero server work

**Totals:** 3–4 new files, ~15 modified files, 1 new DB table, 0 new API routes (extend `/api/compare`).

See [ARCHITECTURE.md](./ARCHITECTURE.md) for per-feature integration maps and line-level references.

### Critical Pitfalls

Top 5 (of 15) pitfalls — 13/15 are code-grounded against the current repo.

1. **MOD-01 fail-closed bypass** — removing `return "unknown"`/`"unresolved"` branches in `resolveSessionModality` and replacing with "idiot-proof defaults" silently weakens fail-closed. Mitigation: `compare.test.ts` test matrix asserting `"unknown"` for every contradiction case; `modalityConfidence` gates any visual distinction restoration
2. **PAST-01 cross-snapshot double-counting + SearchIndex bloat** — naive cross-snapshot UNION double-counts; eager `SearchIndex` loading blows cold-start budget (~34s margin before 300s timeout). Mitigation: dedicated `UNIQUE(wise_session_id)` table, per-request fetch with `cacheTag('past-sessions')`, `isHistoricalRange` flag to disable weekday-fallback for past weeks
3. **VPOL-02 stacking-context collision** — `z-[5]` lane headers + `z-50` popovers + new sticky legend without a documented scale → popover-behind-legend regression. Mitigation: mandatory pre-implementation stacking-context audit + z-index scale constant
4. **VPOL-01 streaming + scroll-restoration breakage** — wrapping RSC boundary in a view transition causes mid-stream flicker with `cacheComponents`; default scroll restoration loses the calendar's `overflow-y-auto` position. Mitigation: native API on client-only state transitions (not RSC boundary); manual `scrollTop` capture/restore; `@media (prefers-reduced-motion: reduce)` CSS
5. **POLISH scatter** — POLISH-01..16 scattered across feature phases silently defers or blocks feature work (VPOL-03 depends on POLISH-01..05 a11y baseline). Mitigation: dedicated POLISH drain phase FIRST, with VPOL-03 explicitly gated on POLISH-01..05 sign-off

See [PITFALLS.md](./PITFALLS.md) for all 15 pitfalls with code references and mitigation strategies.

## Implications for Roadmap

Suggested phase structure (6 phases, converged across all 4 research files):

### Phase 1: POLISH drain (POLISH-01..16)
**Rationale:** Establishes a11y baseline required by VPOL-03; clears v1.0 debt before feature churn; prevents POLISH-scatter anti-pattern
**Delivers:** Phase 04 human-QA sign-off, Phase 03 M1–M3 + L1–L4 findings resolved, Phase 02 retroactive VERIFICATION.md, TutorSelector cleanup, v1.0.1 UAT, `recommend.test.ts`
**Addresses:** 16 polish/tech-debt items from PROJECT.md
**Avoids:** Pitfall 15 (POLISH scatter), Pitfall 12 (VPOL-03 a11y regression chain)

### Phase 2: MOD-01 Reliable online/onsite detection
**Rationale:** First feature — drives visual rules (dashed/solid borders) that VPOL touches later; first shape-changing phase introduces `CACHE_VERSION`
**Delivers:** `isOnlineVariant` + `sessionType` primary signals in modality cascade; `modalityConfidence` return; unresolved → Needs Review (no `supportedModes[0]` fallback); test matrix for fail-closed cases
**Uses:** Existing Zod + Wise type escape hatches (STACK.md)
**Implements:** Modality resolver modifications (ARCHITECTURE.md #1)
**Avoids:** Pitfalls 1, 2, 3 (fail-closed bypass, silent fallback, visual distinction before confidence grading)

### Phase 3: PAST-01 Past-day session visibility
**Rationale:** Data-layer work independent of UI polish; ships unblocked path (DB-snapshot fallback); Wise historical endpoint spike runs in parallel (≤30 min to `devs@wiseapp.live`)
**Delivers:** `past_session_blocks` table + Drizzle migration; orchestrator diff-hook; `/api/compare` historical-range support; dedicated `cacheTag('past-sessions')`; `isHistoricalRange` flag disabling weekday-fallback for past weeks
**Uses:** Existing Drizzle + Neon + `'use cache'` + `cacheTag` APIs (STACK.md)
**Implements:** Past-session storage (ARCHITECTURE.md #2)
**Avoids:** Pitfalls 4, 5, 6, 7 (double-counting, SearchIndex bloat, cache-tag reuse, weekday-fallback on historical ranges)

### Phase 4: VPOL-02 Sticky tutor legend
**Rationale:** Unlocks VPOL-03's layout (sticky real estate for mini-map); low-risk pure CSS; must ship before VPOL-01 so transitions animate known-good sticky positioning
**Delivers:** `position: sticky` chip strip on `compare-panel.tsx`; documented z-index scale constant; stacking-context audit artifact
**Uses:** Tailwind `position: sticky` (STACK.md)
**Implements:** Sticky legend (ARCHITECTURE.md #4)
**Avoids:** Pitfall 9 (stacking-context collision)

### Phase 5: VPOL-03 Density overview / mini-map
**Rationale:** Client-only derivation; blocked on POLISH-01..05 a11y baseline; shape A/B/C choice is a phase-local design decision (per user + research agreement)
**Delivers:** `density-mini-map.tsx` component; client-side `useMemo` aggregation; chosen shape (A aggregate day-bar / B per-tutor stacked / C GitHub-heatmap)
**Uses:** Inline SVG + Tailwind (STACK.md)
**Implements:** Density mini-map (ARCHITECTURE.md #5)
**Avoids:** Pitfalls 11, 12 (performance churn, a11y blind spots)

### Phase 6: VPOL-01 View transitions (LAST)
**Rationale:** Animates a frozen visual baseline; lowest reversibility cost if needs pullback
**Delivers:** `src/lib/ui/view-transitions.ts` helper using native `document.startViewTransition()`; week/day/fullscreen transition hooks in `use-compare.ts`; `prefers-reduced-motion` CSS; manual scroll-position capture/restore
**Uses:** Browser-native View Transition API (STACK.md)
**Implements:** View-transition helper (ARCHITECTURE.md #3)
**Avoids:** Pitfall 8 (streaming + scroll-restoration breakage)

### Phase Ordering Rationale

- **POLISH first** — prerequisite a11y baseline for VPOL-03; prevents scope creep across feature phases; clears v1.0 debt so v1.1 ships clean (converged across Architecture + Pitfalls research)
- **Data fidelity before visual polish** (MOD-01 + PAST-01 before VPOL-*) — fixes user-visible correctness issues first; visual polish on broken data is worse than broken data with no polish
- **MOD-01 before VPOL** — modality confidence grading informs any future visual distinction (dashed vs solid borders) that VPOL-02 or VPOL-03 might touch
- **VPOL-02 before VPOL-01/VPOL-03** — sticky positioning is foundational for both later phases
- **VPOL-01 last** — animations should apply to a frozen visual baseline; highest cross-browser risk so isolate for cleanest rollback

MOD-01 and PAST-01 are logically independent — they could parallelize or swap if execution capacity allows.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 2 (MOD-01):** validate `WiseSession.type` presence rate in production data at phase kickoff — if <50%, MOD-01 reduces to "icon + Needs Review" without confident labels
- **Phase 3 (PAST-01):** ≤30-min Wise docs spike (`devs@wiseapp.live`) for historical endpoint existence — plan unconditionally for DB-snapshot fallback, upgrade to real endpoint if confirmed
- **Phase 5 (VPOL-03):** shape A/B/C decision via phase-local design review + a11y strategy for density visualization
- **Phase 6 (VPOL-01):** re-check Vercel/next.js #85693 resolution at phase start (in case `experimental.viewTransition` becomes viable)

Phases with standard patterns (skip research-phase):
- **Phase 1 (POLISH drain):** checklist-driven, no research needed
- **Phase 4 (VPOL-02):** pure CSS, pattern documented in repo (`week-overview.tsx:297`)

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Verified against in-tree `node_modules/`, MDN Baseline dates, live GitHub issue check. Four of four NEW-capability decisions are "no new dependency." |
| Features | MEDIUM-HIGH | Scheduling conventions well-documented across 5 major tools; VPOL-03 shape required synthesis; shape deferred to phase planning. |
| Architecture | HIGH | Code-grounded against 15+ repo files with line refs. VPOL-01 is MEDIUM due to one open upstream issue (#85693). |
| Pitfalls | HIGH | 13 of 15 pitfalls code-grounded with line refs. VPOL-01 + VPOL-03 nuances depend on implementation shape (MEDIUM). |

**Overall confidence:** HIGH. No research track converged on "we don't know enough to plan this."

### Gaps to Address

- **Wise historical-sessions endpoint existence** — Phase 3 (PAST-01) kickoff spike; unconditional DB-snapshot fallback path ships regardless
- **`WiseSession.type` data-quality rate** — Phase 2 (MOD-01) kickoff validation against current snapshot
- **VPOL-03 visual shape** — Phase 5 design review (A aggregate / B per-tutor / C heatmap)
- **Vercel/next.js #85693 resolution** — Phase 6 (VPOL-01) start; native API avoids the question entirely
- **`modalityConfidence: "low"` UI treatment** — Phase 2 Stage 3 design call

## Sources

### Primary (HIGH confidence)
- In-tree `node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/viewTransition.md` — Next.js bundled warning about `experimental.viewTransition` vs `cacheComponents`
- `src/lib/search/compare.ts:27-70` (current `resolveSessionModality` fallback path)
- `src/lib/normalization/modality.ts` (current cascade)
- `src/components/compare/week-overview.tsx:297` + `src/components/compare/calendar-grid.tsx:103` (existing sticky precedents)
- `src/lib/wise/types.ts` (current Wise response shapes with index signature)
- `src/lib/db/schema.ts:177-201` (snapshot + session schema)
- AGENTS.md (non-negotiable product rules, fail-closed constraints, 300s function ceiling)

### Secondary (HIGH confidence, external authoritative)
- [Next.js 16.2 release notes](https://nextjs.org/blog/next-16-2) — framework version
- [Next.js View Transitions guide](https://nextjs.org/docs/app/guides/view-transitions)
- [Next.js viewTransition config](https://nextjs.org/docs/app/api-reference/config/next-config-js/viewTransition)
- [Vercel/next.js Issue #85693](https://github.com/vercel/next.js/issues/85693) — `experimental.viewTransition` + `cacheComponents` conflict
- [React 19.2 release blog](https://react.dev/blog/2025/10/01/react-19-2)
- [MDN: View Transition API](https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API) — Baseline Newly Available
- [Polypane: All the ways position:sticky can fail](https://polypane.app/blog/getting-stuck-all-the-ways-position-sticky-can-fail/)
- [Smashing Magazine: Unstacking CSS Stacking Contexts](https://www.smashingmagazine.com/2026/01/unstacking-css-stacking-contexts/)
- [CSS-Tricks: Dealing with overflow and position: sticky](https://css-tricks.com/dealing-with-overflow-and-position-sticky/)

### Tertiary (MEDIUM confidence, needs validation)
- [Wise App API docs](https://docs.wise.live/wise-api-integration/api-endpoints) — historical-sessions endpoint NOT documented; confirm via `devs@wiseapp.live`

---
*Research completed: 2026-04-20*
*Ready for roadmap: yes*
