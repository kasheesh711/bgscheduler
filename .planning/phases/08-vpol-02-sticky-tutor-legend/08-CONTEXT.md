# Phase 8: VPOL-02 Sticky Tutor Legend - Context

**Gathered:** 2026-04-22
**Status:** Ready for planning

<domain>
## Phase Boundary

Replace the per-day sticky lane headers in `src/components/compare/week-overview.tsx` with a single consolidated global sticky tutor legend at the top of the week-view scroll container, using a codified z-index scale constant and a committed pre-implementation stacking-context audit. Normalize `src/components/compare/calendar-grid.tsx`'s existing sticky day-header to the same z-index scale (while preserving its tutor-profile-popover click behavior). Preserve the legend through the fullscreen compare toggle by construction (sticky lives inside the WeekOverview scroll container which is unaffected by the outer column width transition).

**In scope:** STICKY-01..04 (4 requirements) — (a) sticky tutor legend strip inside WeekOverview scroll container, (b) TypeScript z-index scale constant in a new `src/lib/ui/z-index.ts` module, (c) `08-STACKING-AUDIT.md` committed as the first commit of the phase before any code change, (d) CalendarGrid z-index normalization to the same scale, (e) fullscreen-preservation by construction.

**Out of scope (explicit):** STICKY-05 hover preview on legend chip (v1.2 deferred). STICKY-06 jump-to-next-session action on legend chip (v1.2 deferred). New legend affordances beyond color dot + tutor name (content density locked minimal per D-04). Dragging chips to reorder (research FEATURES.md:237 rejected). Scroll-triggered style changes like shadow/elevation on sticky legend (research FEATURES.md:235 rejected). Adding `view-transition-name` to sticky legend — that is Phase 10 (VPOL-01) territory per research FEATURES.md:187,244,362. Mini-map / density-bar consolidation into the sticky strip (deferred to Phase 9 VPOL-03). Any changes to CACHE_VERSION — sticky is pure CSS, no client-cached shapes change (research Pitfall 14 does not apply).

</domain>

<decisions>
## Implementation Decisions

### Legend consolidation strategy (Area 1)

- **D-01:** **Replace** the existing per-day sticky lane header at `src/components/compare/week-overview.tsx:311-344` with ONE global sticky legend strip at the top of the same scroll container (`week-overview.tsx:310` `flex-1 overflow-y-auto min-h-0`). Matches research/ARCHITECTURE.md:297 recommendation. Eliminates the per-day-column tutor-name duplication and the 80+px stacked-sticky-chrome risk called out in research FEATURES.md:236. The `multiTutorLayout && (…)` gate at line 312 is removed entirely.
- **D-02:** **Chip strip stays as-is** above the week picker at `compare-panel.tsx:88-135`. It continues to own add/remove/Advanced-search/fullscreen-toggle UI. Two strips serve two purposes: chip strip = identity + controls (outside scroll); sticky legend = scroll-visible identity (inside scroll). No scroll-triggered style changes (no collapse-on-scroll, no merge).
- **D-03:** **Single-row, one-slot-per-tutor layout** for the sticky legend. Flat, left-aligned, fixed slots: `[● Kevin] [● Alex] [● Sam]`. Each slot = small colored dot (1.5×1.5, matching the existing per-day lane-header dot styling at `week-overview.tsx:332-335`) + tutor display name. Lane tint backgrounds per day column (at `week-overview.tsx:372-386`) still communicate WHICH sub-column belongs to which tutor — no positional alignment needed in the legend header.
- **D-04:** **Legend renders ALWAYS**, regardless of tutor count (1, 2, or 3). Even with 1 tutor, the single-slot legend is visible. Consistency over micro-optimization: switching between 1 and 2 tutors does NOT reflow the calendar vertically. The existing `multiTutorLayout` (defined at `week-overview.tsx:276`) gate is removed from the sticky-header rendering path.
- **D-05:** **Content density: minimal**. Each legend slot shows color dot + tutor name only. NO hours booked, NO session count, NO stats, NO popover click. Rationale: research FEATURES.md:219 recommends minimal; richer stats belong in VPOL-03 (Phase 9) or tutor profile popover; adding them here would pre-empt Phase 9 design decisions.

### Scope — CalendarGrid coverage (Area 3)

- **D-06:** **Include CalendarGrid in Phase 8** — normalize its existing sticky day-header at `src/components/compare/calendar-grid.tsx:120` to the Phase 8 z-index scale. Current class `sticky top-0 bg-background z-10` becomes `sticky top-0 bg-background` with `zIndex: Z_INDEX.legend` (or its Tailwind-class equivalent). Markup and clickable-tutor-name + `TutorProfilePopover` behavior at lines 125-135 is PRESERVED unchanged. Goal: consistent z-stacking across both views of the compare calendar; no cross-file drift in the codebase.
- **D-07:** **Asymmetric interaction is accepted.** WeekOverview's sticky legend is display-only (dot + name only per D-05). CalendarGrid's sticky header stays clickable-with-popover. Rationale: day drilldown has 1-3 tutors per full-width column with real estate to spare; week view has 1-3 tutors compressed into 7 side-by-side day columns where the existing popover access already lives on per-session cards. This asymmetry is intentional, not tech debt.

### Z-index scale authority (Area 4)

- **D-08:** **Simplified z-index scale** replacing REQUIREMENTS.md STICKY-02's 5-slot prescription. New scale: `Z_CONTENT = 1`, `Z_LEGEND = 6`, `Z_POPOVER = 50`. The "lane headers z-[5]" slot in REQUIREMENTS.md STICKY-02 is RETIRED because Area 1's D-01 consolidates lane headers OUT of the codebase. The "sticky day-header z-[6]" slot from REQUIREMENTS.md refers to CalendarGrid's existing sticky header which now uses `Z_LEGEND = 6` per D-06 — so slot-wise we have a 3-tier scale that covers all actual sticky elements post-consolidation.
- **D-09:** **Scale lives at `src/lib/ui/z-index.ts`** as a single-line TypeScript constant: `export const Z_INDEX = { content: 1, legend: 6, popover: 50 } as const;`. Typed (`as const` for literal types), greppable, importable. Call sites use `style={{ zIndex: Z_INDEX.legend }}` for JSX. Tailwind utility classes (`z-[6]`, `z-50`, `z-[1]`) may be used at call sites provided a same-line code comment references `Z_INDEX.<slot>` so future changes stay in sync. Single source of truth.
- **D-10:** **This is a minor REQUIREMENTS.md amendment, same class as Phase 5 D-02's NVDA relaxation.** The planner must (a) commit the simplified scale as authoritative, (b) add a note to `.planning/REQUIREMENTS.md` §STICKY-02 explaining the scale was simplified at CONTEXT time because Area 1's consolidation retired the separate lane-headers slot, and (c) update the §Traceability table if the ID changes (it doesn't — still STICKY-02). No new requirement ID needed. Mirrors the Phase 5 D-02 pattern of recording a scope relaxation in REQUIREMENTS.md.

### Stacking-context audit artifact (STICKY-03)

- **D-11:** **Markdown file `.planning/phases/08-vpol-02-sticky-tutor-legend/08-STACKING-AUDIT.md`**. One file listing every ancestor element from `<html>` → target sticky legend, with columns: `file:line | element | overflow | transform | filter | backdrop-blur | z-index | creates-stacking-context? (yes/no) | notes`. Covers both target sticky elements (WeekOverview legend AND CalendarGrid day-header). Committed as the FIRST commit of Phase 8, BEFORE any code change, matching STICKY-03's "pre-implementation" requirement literally. Permanent artifact; greppable; easy to re-verify against regressions.
- **D-12:** **No inline code comments beyond the z-index scale cross-reference (D-09).** The audit is the authoritative document; we do NOT sprinkle `// STICKY-03 audit: stacking context via …` comments across the codebase. Keeps `src/` uncluttered and the audit single-sourced. If a future reader is surprised by a stacking choice, they read the audit.
- **D-13:** **Audit format rigor:** Include at minimum (a) ancestor chain from `<html>` to the sticky legend inside WeekOverview, (b) ancestor chain from `<html>` to the sticky header inside CalendarGrid, (c) explicit "does any ancestor have `overflow-hidden` that breaks sticky?" finding (research STACK.md:91 flags this as the one common sticky pitfall — we already avoid it per current code, but the audit must prove it), (d) explicit "does any ancestor have `transform`/`filter`/`backdrop-blur` creating a stacking context that confines sticky?" finding, (e) confirmation that `z-index: 50` popovers (Base UI default) render ABOVE the legend. Planner's discretion on exact row format; above is the minimum content.

### Fullscreen preservation (STICKY-04)

- **D-14:** **Sticky legend preservation through fullscreen is satisfied by construction, not by additional code.** The sticky legend lives INSIDE `week-overview.tsx` scroll container (or `calendar-grid.tsx` for day view). Fullscreen toggle at `search-workspace.tsx:206-217` only transitions the OUTER column width from `w-1/2` to `w-full` — it does not remount or restyle the WeekOverview / CalendarGrid scroll container. The legend therefore stays sticky at full width with zero additional plumbing. Planner adds a verification test (visual or Vitest-on-DOM) but no code gymnastics.

### CACHE_VERSION (Phase 6 D-17..D-20 / Phase 7 D-17)

- **D-15:** **NO CACHE_VERSION bump in Phase 8.** Sticky is pure CSS + a z-index TypeScript constant + UI markup refactor. No shape change to `CompareTutor`, `CompareSessionBlock`, `CompareResponse`, or any client-cached server response. The `src/lib/search/cache-version.ts` constant stays at `"v2"` (post-Phase 7). Matches the bump rule documented at `cache-version.ts` and Phase 6 D-19: bump ONLY when client-cached shape changes.

### Claude's Discretion

The following are explicitly left to the planner / executor — no user decision needed:

- **Exact legend DOM shape** — whether the sticky legend is a `<div>` with flex children, a `<ul>` with semantic `<li>` slots, or a `<nav role="list">` for a11y. Planner picks per accessibility convention already in use (e.g., `compare-panel.tsx` uses `<div>` with ARIA on the remove button only). Recommended: mirror existing styling (border + small color dot + truncate).
- **Legend height** — research suggested 20-28px; current per-day lane header is `style={{ height: 20 }}` at `week-overview.tsx:315`. Planner picks based on the legend's content (single row of dot + name ≈ 20-24px feels right); consistency with the retired per-day lane-header height is a reasonable default.
- **Bg + backdrop-blur treatment** — the current lane header uses `bg-background/90 backdrop-blur-sm` (creates stacking context; audit D-11 must document). Planner chooses whether to keep this (visual consistency with current sticky pattern) or switch to solid `bg-background` (simpler, no stacking context created by `backdrop-blur`). Recommended: solid `bg-background` for simplicity; backdrop-blur was chosen originally for aesthetic under conflicts, which is now minimally present in the consolidated legend. Either choice must be documented in the stacking-context audit.
- **Extracting a shared `<TutorLegend>` component** vs. inlining the sticky legend directly in `week-overview.tsx`. Asymmetric interaction (D-07: week-view display-only, day-view clickable with popover) means a shared component would need a `clickable?: boolean` prop + optional popover. Planner may prefer two inlined implementations over a shared component with branching. Either is acceptable.
- **Where `Z_INDEX` is consumed** — planner decides whether to import the constant at each call site (most explicit) or define a small Tailwind plugin extension. Explicit import at call sites is the simpler default.
- **Test coverage** — Vitest/jsdom test that asserts `position: sticky` class is present on the legend element, OR skip and rely on visual verification since sticky is CSS (Vitest has limited jsdom support for sticky positioning anyway). Planner's call; minimum bar is "669 tests continue to pass + visual verification on production".
- **Commit cadence** — one commit per concern is fine: (1) `08-STACKING-AUDIT.md` + REQUIREMENTS.md §STICKY-02 amendment (pre-implementation per D-13), (2) `src/lib/ui/z-index.ts` constant, (3) WeekOverview lane-header → sticky-legend refactor, (4) CalendarGrid z-index normalization, (5) verification / QA walkthrough notes. Matches Phase 5/6/7 atomic-per-concern cadence.
- **Responsive narrow-panel behavior** — research FEATURES.md:221 noted a potential compact-legend fallback if the 50%-width compare panel is cramped with 3 tutors. Planner verifies at implementation time whether truncation is needed; if the single-row layout is already readable at 50% width with 3 tutors on a 13" MacBook (matches POLISH-05 baseline), no compact mode needed.

### Folded Todos

No GSD todos surfaced for Phase 8 (`todo match-phase 8` returned 0). STATE.md pending todos are all data/plumbing-related and do not overlap sticky-legend UI work.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope & requirements

- `.planning/REQUIREMENTS.md` §"Visual Polish — Sticky Tutor Legend (VPOL-02)" — STICKY-01..04 canonical specifications
- `.planning/REQUIREMENTS.md` §Traceability — STICKY-01..04 all mapped to Phase 8
- `.planning/ROADMAP.md` §"Phase 8: VPOL-02 Sticky Tutor Legend" — 4 success-criteria truths that must become true
- `.planning/STATE.md` §"v1.1 Scope Summary" row 8 — Phase 8 gating ("Unlocks VPOL-03 layout; must precede VPOL-01")

### Project constraints

- `.planning/PROJECT.md` §Constraints — no stack changes, fail-closed non-negotiable, 669 tests must continue passing, sky blue + GCal-style preserved
- `.planning/PROJECT.md` §"Current State" (v1.1 Phase 7 row) — established v1.1 baseline (PAST-01 code-complete)
- `AGENTS.md` §"Non-Negotiable Product Rules" — fail-closed (not directly relevant to sticky but enforced)
- `CLAUDE.md` §"Running Commands" — deploy/test commands for verification

### Research intelligence (HIGH confidence, code-grounded)

- `.planning/research/FEATURES.md:193-247` §"VPOL-02 — Sticky Tutor Legend During Calendar Scroll" — table-stakes vs differentiators vs anti-patterns; LOW complexity rating; dependencies on existing chip strip + lane headers
- `.planning/research/FEATURES.md:187,244,362` — VPOL-02 ↔ VPOL-01 (view transitions) coordination: sticky elements need `view-transition-name` in Phase 10, NOT Phase 8
- `.planning/research/FEATURES.md:219` — minimal legend content recommendation (color dot + name)
- `.planning/research/FEATURES.md:235-237` — anti-patterns: no scroll-triggered style changes, no two-sticky-layers, no drag-to-reorder
- `.planning/research/ARCHITECTURE.md:278-304` §"(4) VPOL-02 — Sticky tutor legend" — pure CSS `position: sticky` is correct choice; consolidation recommendation (line 297); HIGH confidence rating
- `.planning/research/STACK.md:83-94` §"(b) Sticky Tutor Legend (VPOL-02)" — zero new dependencies; `sticky` + Tailwind; common pitfall: `overflow-hidden` ancestor breaks sticky (line 91 — our layout already avoids this, audit D-13 confirms)
- `.planning/research/STACK.md:27,149,160,181,199` — additional sticky-positioning references and "prior art in repo" callouts

### Prior phase context (pattern carry-forward)

- `.planning/phases/05-polish-drain/05-CONTEXT.md` §"POLISH-09 Today-Indicator Semantic Token" (D-06..D-08) — semantic OKLCH token pattern for adding new tokens to `globals.css` (reference only; Phase 8 does NOT add color tokens)
- `.planning/phases/05-polish-drain/05-CONTEXT.md` §"D-02" — NVDA relaxation pattern as reference for D-10's REQUIREMENTS.md amendment mechanics
- `.planning/phases/06-mod-01-reliable-modality-detection/06-CONTEXT.md` §"CACHE_VERSION constant (D-17..D-20)" — bump rule; Phase 8 does NOT bump (D-15 confirms)
- `.planning/phases/07-past-01-past-day-session-visibility/07-CONTEXT.md` §"CACHE_VERSION bump" (D-17) — most recent bump was v1→v2 in Phase 7; Phase 8 stays at v2

### Source code — UI components (THE refactor surfaces)

- `src/components/compare/compare-panel.tsx:88-135` — existing chip strip (D-02 unchanged)
- `src/components/compare/week-overview.tsx:282` — outer `flex flex-col h-full overflow-hidden` (ancestor for sticky audit)
- `src/components/compare/week-overview.tsx:284-307` — Mon-Tue-Wed day-label row (outside scroll, not sticky, not changed)
- `src/components/compare/week-overview.tsx:310` — scroll container `flex-1 overflow-y-auto min-h-0` (THIS is the scroll context sticky attaches to)
- `src/components/compare/week-overview.tsx:311-344` — existing per-day sticky lane header — **THE REFACTOR TARGET for D-01** (replace with consolidated legend)
- `src/components/compare/week-overview.tsx:332-335` — color-dot styling reference (`h-1.5 w-1.5 rounded-full`); D-03 reuses this
- `src/components/compare/week-overview.tsx:372-386` — lane tint backgrounds (PRESERVED; how users still map color→column after D-01's consolidation)
- `src/components/compare/week-overview.tsx:276` — `multiTutorLayout` flag (D-04 removes the gate from sticky-header rendering only; flag still used for lane tints and per-session layout)
- `src/components/compare/calendar-grid.tsx:120` — existing `sticky top-0 bg-background z-10` header — **THE NORMALIZATION TARGET for D-06** (replace `z-10` with `Z_INDEX.legend`)
- `src/components/compare/calendar-grid.tsx:125-135` — `TutorProfilePopover` click affordance (D-07 PRESERVED)
- `src/components/compare/tutor-profile-popover.tsx` — popover component (unchanged, referenced by D-07 for CalendarGrid)
- `src/components/compare/tutor-selector.tsx` — exports `TUTOR_COLORS` + `TutorChip` type (consumed by D-03 markup for color dots)
- `src/components/compare/session-colors.ts` — color helpers (unchanged; referenced by D-03 indirectly via `TUTOR_COLORS` re-export)
- `src/components/search/search-workspace.tsx:206-217` — fullscreen toggle implementation; D-14 verifies sticky preservation by construction (no change needed)

### Source code — target for Z_INDEX constant

- New file: `src/lib/ui/z-index.ts` — D-09 creates this (`export const Z_INDEX = { content: 1, legend: 6, popover: 50 } as const;`)
- `src/components/ui/popover.tsx` — Base UI popover primitive (Base UI default `z-50` for popover content; D-08 Z_INDEX.popover aligns with this)

### Stacking-context audit artifact target

- New file: `.planning/phases/08-vpol-02-sticky-tutor-legend/08-STACKING-AUDIT.md` — D-11 commits this FIRST per D-13; pre-implementation

### Testing surfaces

- `src/components/compare/__tests__/` — if exists, extend for the new legend (planner greps to confirm)
- `src/lib/ui/__tests__/z-index.test.ts` — optional Vitest for the Z_INDEX shape (planner's discretion per Claude Discretion §Test coverage)

### Operations / verification

- `CLAUDE.md` §"Running Commands" — `npm test` (regression), `npx vercel --prod` (preview + production deploy for visual verification)
- Human QA on production — sticky-scroll behavior in week view + day view + fullscreen toggle ON/OFF; planner drafts a ~5-item walkthrough matching Phase 5's "one prod-site sitting" style

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- **Existing sticky pattern** at `week-overview.tsx:314` (`sticky top-0 z-[5] flex bg-background/90 backdrop-blur-sm`) and `calendar-grid.tsx:120` (`sticky top-0 bg-background z-10`) — direct blueprint; D-01 consolidates one into a legend, D-06 normalizes the other
- **Color dot styling** at `week-overview.tsx:332-335` (`h-1.5 w-1.5 rounded-full flex-shrink-0` + inline background) — D-03 reuses verbatim in the new legend slots
- **`TUTOR_COLORS`** re-exported from `src/components/compare/tutor-selector.tsx` — color source for legend dots (consumed indirectly via `tutorChips[i].color`)
- **`TutorProfilePopover`** at `src/components/compare/tutor-profile-popover.tsx` — preserved unchanged for CalendarGrid day-header (D-07)
- **Tailwind `sticky` + arbitrary z-index utilities** (`sticky top-0 z-[1]`, `z-[6]`, `z-50`) — already in use; D-09 adds a TS constant reference layer above them
- **Atomic per-concern commit convention** from Phases 5/6/7 — Phase 8 follows: audit first, then constant, then WeekOverview, then CalendarGrid, then verification

### Established Patterns

- **"Sticky lives inside its own scroll container"** (`week-overview.tsx` line 310 → sticky at 314 = contained-to-WeekOverview scroll; `calendar-grid.tsx` scroll handled one level up by `compare-panel.tsx:248`) — Phase 8 preserves this invariant; sticky legend stays inside WeekOverview's scroll container
- **"Outside-scroll always-visible UI"** — chip strip at `compare-panel.tsx:88`, week picker at `compare-panel.tsx:152`, day tabs at `compare-panel.tsx:210` all live OUTSIDE the `overflow-y-auto` scroll container and therefore need no z-index or sticky treatment. D-02 preserves this architecture
- **TypeScript `as const` for literal-typed constants** — already used for `DISPLAY_DAYS`, `DAY_NAMES`, `TUTOR_COLORS`. `Z_INDEX` follows the same pattern at D-09
- **New `src/lib/ui/` subdirectory** — does not currently exist; Phase 8 introduces it. Consistent with other `src/lib/{domain}/` directories. Planner creates the directory with `z-index.ts` as its first file. Future VPOL-01 phase 10's `view-transitions.ts` (per REQUIREMENTS.md TRANS-05) will co-locate here

### Integration Points

- **`src/app/globals.css`** — body has `overflow-hidden` per the layout specs; this is ABOVE the `.flex-1 overflow-y-auto` inside WeekOverview, which means sticky inside WeekOverview works correctly (no ancestor `overflow-hidden` breaks sticky BECAUSE the scroll container itself defines the sticky context)
- **`src/app/(app)/layout.tsx`** — uses `overflow-hidden px-4 lg:px-6 py-3` on the app container; also an ancestor of WeekOverview. Does NOT break sticky (sticky context is scoped to nearest `overflow-y-auto` ancestor)
- **`src/components/search/search-workspace.tsx:166`** — `flex-1 flex gap-3 overflow-hidden min-h-0` on the workspace container; again ancestor, again does not break sticky for the same reason
- **`compare-panel.tsx:247-272`** — calendar-view wrapper has `flex-1 min-h-0 mt-1 ${activeDay !== null ? "overflow-y-auto" : ""}` — in DAY view (`activeDay !== null`), the wrapper adds `overflow-y-auto`, so CalendarGrid's sticky day-header sticks to THIS container, NOT its own (since CalendarGrid itself has no scroll container). D-06's z-index normalization applies correctly because the sticky context is still well-defined
- **No new dependencies** — D-08/D-09 add a TS module; no npm packages added; matches `.planning/research/STACK.md:18` (zero new deps)

</code_context>

<specifics>
## Specific Ideas

- **"Replace, don't add"** — user chose consolidation (D-01) over stacking two sticky layers. This is the single highest-leverage decision: it eliminates both the 80+px chrome risk AND the per-day duplication AND the z-index conflict between REQUIREMENTS.md's literal scale and research's suggested scale. Planner should treat this as the spine of the phase.
- **"Chip strip as controls, sticky legend as identity"** (D-02) — two separate UI surfaces serving two separate purposes. Don't let the planner "clean up" by merging them; the separation is intentional.
- **"Minimal content now; stats arrive in Phase 9"** (D-05) — resist the temptation to add hours-booked / session-count to the sticky legend. VPOL-03 (Phase 9 density overview) owns that real estate per ROADMAP.md line 104-114. A premature addition in Phase 8 pre-empts that design work.
- **"Asymmetric CalendarGrid popover is intentional"** (D-07) — do NOT try to unify week-view and day-view legend interactions. Different views, different affordances. Documented in CONTEXT.md so the planner doesn't "correct" the asymmetry.
- **"Audit as first commit"** (D-13 timing) — not a nice-to-have. STICKY-03 literal reading + Phase 5 prep-commit pattern converge on "committed BEFORE code changes". Planner's plan 01 must be the audit, even if its only concrete output is `08-STACKING-AUDIT.md`.
- **"Scale simplification is a REQUIREMENTS amendment, record it"** (D-10) — same class as Phase 5 D-02. The planner updates REQUIREMENTS.md §STICKY-02 with a one-line amendment note citing this CONTEXT.md. No new requirement ID.
- **"Fullscreen preservation is free"** (D-14) — one of the cleanest outcomes in v1.1. Don't accept a plan that invents new machinery for fullscreen; sticky is already inside the scroll container, which fullscreen doesn't touch. A verification test is the deliverable, not new plumbing.
- **"No CACHE_VERSION bump"** (D-15) — explicitly note this so the planner doesn't reflexively add a bump based on Phase 6 D-19's "future v1.1 phases MUST bump" guidance. That guidance applies to SHAPE-changing phases; Phase 8 is not one.

</specifics>

<deferred>
## Deferred Ideas

- **STICKY-05 hover preview on legend chip** — v1.2 per REQUIREMENTS.md §v1.2+. Phase 8 sets up the sticky container that STICKY-05 would extend; not implemented here.
- **STICKY-06 jump-to-next-session from legend chip** — v1.2 per REQUIREMENTS.md §v1.2+. Differentiator; not table-stakes for v1.1.
- **Hover preview / mini-stats in legend** (research FEATURES.md:229) — deferred; belongs in STICKY-05 territory.
- **Clickable legend chip in WeekOverview with popover** (asymmetry D-07) — could be added later if users request it; no requirement ID reserved.
- **Scroll-triggered legend styling** (shadow/elevation on scroll) — explicitly rejected (research FEATURES.md:235; FEATURES.md:236).
- **Two sticky layers (chip strip + legend BOTH sticky)** — explicitly rejected by D-01 consolidation + research FEATURES.md:236. Chip strip stays outside scroll; legend stays inside scroll; they never compete.
- **Drag-to-reorder chips in sticky strip** — explicitly rejected (research FEATURES.md:237).
- **`view-transition-name` on the sticky legend** — Phase 10 (VPOL-01) concern per research FEATURES.md:187,244,362. Phase 8 does NOT assign `view-transition-name`; that is VPOL-01's job. Phase 10 will add it to prevent legend jumping during week transitions.
- **Mini-map consolidation into the sticky strip** — Phase 9 (VPOL-03) concern per research ARCHITECTURE.md:321. Phase 8 stays pure "identity legend"; Phase 9 decides whether to extend the sticky strip or place density elsewhere.
- **Compact-legend responsive fallback** (research FEATURES.md:221 optional differentiator) — not required unless visual verification at 50% panel width + 3 tutors on 13" MacBook shows truncation. Planner's discretion to add if needed during visual verification.
- **Extracting a shared `<TutorLegend>` component** — Claude's Discretion left to planner. If future phases (VPOL-03 adds stats to legend, STICKY-05/06 adds interactions) would consume it, planner may extract now as a small future-proofing move. Otherwise two inlined implementations are fine.
- **Vitest test for sticky positioning** — Claude's Discretion. jsdom limited support for sticky. Visual verification + regression on 669 existing tests is the minimum bar.
- **CACHE_VERSION v2 → v3 bump** — explicitly NOT done per D-15. Phase 9 (VPOL-03) or Phase 10 (VPOL-01) may need a bump if they change client-cached shapes; Phase 8 does not.

### Reviewed Todos (not folded)

None — `todo match-phase 8` returned 0 results.

</deferred>

---

*Phase: 08-vpol-02-sticky-tutor-legend*
*Context gathered: 2026-04-22*
