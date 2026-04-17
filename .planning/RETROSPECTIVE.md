# Project Retrospective

*A living document updated after each milestone. Lessons feed forward into future planning.*

## Milestone: v1.0 — Performance & UX Improvement

**Shipped:** 2026-04-17
**Phases:** 4 | **Plans:** 11 | **Tasks:** 14 | **Tests:** 82 → 246

### What Was Built

- **Component architecture overhaul** — decomposed an 878-line monolithic `search/page.tsx` into `SearchForm`, `SearchResults`, `ComparePanel`, and a `SearchWorkspace` composition root plus a `useCompare` hook that centralizes all compare state (tutors, cache, abort, snapshot, week)
- **HMR-safe singletons** — DB and SearchIndex anchored on `globalThis` with `declare global` blocks so Next.js dev-mode HMR no longer drops server state
- **Streaming server data** — search page is now an async RSC that awaits cached `getFilterOptions()` / `getTutorList()` behind `'use cache'` + `cacheTag('snapshot')`, with `revalidateTag('snapshot', { expire: 0 })` in the cron sync endpoint; `cacheComponents: true` enabled; route-level `loading.tsx` skeleton renders within 200ms
- **Lazy calendar components** — `WeekOverview` (~471 lines), `CalendarGrid` (~275), `DiscoveryPanel` (~274) all loaded via `next/dynamic` with `CalendarSkeleton` fallbacks
- **Multi-tutor calendar readability** — per-tutor lane tints (5% opacity) + sticky lane headers with color dots, GCal-style red today indicator line with a 60-second live ticker, numbered conflict count badges, native `title=` hover tooltips
- **One-click compare workflow** — `+` quick-add button on every search result / Needs Review row, fullscreen compare toggle, `?week=YYYY-MM-DD` URL parameter sync, ArrowLeft/Right keyboard nav (guarded against input/textarea/contentEditable focus)
- **Accessibility + visual polish** — aria-labels on week picker and chip remove controls, semantic color tokens (`text-blocked`/`text-conflict`/`text-available`/`text-destructive`/`bg-accent`) replacing hardcoded Tailwind colors, DiscoveryPanel user-visible error feedback, `TUTOR_COLORS` consolidated to `session-colors.ts`, no sub-10px typography, `DataHealthSkeleton` with retry guidance

### What Worked

- **Linear dependency chain (1 → 2 → 3 → 4) with coarse phase granularity** — component extraction first unblocked everything downstream; Phase 2 got clean seams for RSC conversion; Phase 3 had stable components to decorate; Phase 4 audited polished surfaces. Zero cross-phase rework.
- **Canonical data functions in `src/lib/data/`** — `getFilterOptions` and `getTutorList` with `'use cache'` + `cacheTag('snapshot')` gave Phase 2 a clean "RSC awaits this, client gets props" streaming model without touching any API routes.
- **`globalThis` singleton pattern** — simple and standard; fixed HMR state loss in dev without changing prod behavior. The `declare global { var ... }` + `__bgscheduler_` prefix convention scaled cleanly to both DB and SearchIndex.
- **Integration checker as verification backstop** — for Phase 02 which shipped without a formal `VERIFICATION.md`, the milestone-level integration check produced file:line evidence for every REQ-ID with no rework needed. Good pattern for audit recovery.
- **Human-verify checkpoints inside plans** — Plan 03-03 Task 3 bundled visual regression into the execution loop (B1–B7 checks) rather than leaving it as post-phase QA, which closed verification faster.
- **Post-phase code review fix pass (WR-01..WR-06)** — catching recursion guard, non-OK fetch surfacing, bounds check, response-status check, etc. right after the phase landed kept fix PRs small and focused.

### What Was Inefficient

- **Phase 02 shipped without `VERIFICATION.md`** — deliverables all worked and were confirmed by integration check, but skipping the formal verifier artifact broke the audit chain. Retroactive verification is more work than running it the first time.
- **REQUIREMENTS.md traceability went stale** — checkboxes for Phases 1, 3, 4 were never flipped from `[ ]` to `[x]` as work landed. The audit caught it and the archive reconciled it, but `/gsd-complete-milestone` should not have to do this cleanup.
- **Some SUMMARY.md files omitted `requirements-completed` frontmatter** (01-01, 01-02, 01-03, 03-01, 04-01, 04-02). The 3-source cross-reference had to fall back to VERIFICATION.md content parsing. Populate the field consistently.
- **Phase 04 ended in `human_needed` status with 5 outstanding manual QA items**, rolled forward as debt. Knowing this up front we could have scoped a same-session human-QA pass (single sitting, ~30 min) to land in the milestone rather than next.
- **Orphaned `TutorSelector` component function** — code kept from an earlier iteration that is never imported. Low-stakes but a tidiness loss.
- **Phase 03 accepted 7 polish findings (M1–M3, L1–L4)** from code review as non-blocking. Several (M3 regex shape-only, M1 effect deps) are small enough to have been fixed in-line rather than deferred.

### Patterns Established

- **Skeletons:** Server Components at `src/components/skeletons/{feature}-skeleton.tsx`, named exports, no `"use client"`, `bg-muted animate-pulse` blocks matching real component proportions. Consumed by both `loading.tsx` (route-level) and `next/dynamic` (component-level) fallbacks.
- **Canonical cached data:** `src/lib/data/{entity}.ts` exports a `'use cache'` async function that calls `getDb()` + `ensureIndex(db)`, tagged with `cacheTag('snapshot')`; invalidated by `revalidateTag('snapshot')` in the sync endpoint.
- **next/dynamic for named exports:** `dynamic(() => import(...).then(mod => mod.Name), { loading: () => <Skeleton /> })` at module scope.
- **`globalThis` singleton anchor:** `declare global { var __bgscheduler_X: T | undefined }` with `__bgscheduler_` prefix; accessor functions for encapsulation when the value has a build promise or similar.
- **`FilterOptions` canonical type in `src/lib/data/filters.ts`**, re-exported from the form component that consumes it as props. Avoids circular client/server type imports.
- **Semantic color tokens first:** `text-blocked` / `text-conflict` / `text-available` / `text-destructive` / `bg-accent` / `bg-destructive/10` are the vocabulary; raw `text-red-`/`text-green-`/`text-yellow-` classes are banned in business components.
- **TUTOR_COLORS single source:** `src/components/compare/session-colors.ts` exports the array; other files import it (or re-export for backwards compat).
- **Typography floor at text-[10px]:** no `text-[8px]` or `text-[9px]`. `text-[10px]` reserved for dense-UI dropdown badges / calendar labels; everywhere else uses the standard Tailwind scale.
- **URL sync via `replaceState` with omit-on-default:** current week is never encoded in the URL; only deviations from the default appear in `?week=`.
- **Keyboard nav focus guard:** any global `keydown` listener must skip events where `target` is `HTMLInputElement`, `HTMLTextAreaElement`, or `isContentEditable`.

### Key Lessons

1. **Update traceability as work lands, not at milestone close.** `/gsd-complete-milestone` had to reconcile 19/24 stale checkboxes. A plan-complete hook that flips `[ ]` → `[x]` based on SUMMARY frontmatter would remove this drift.
2. **Don't skip `gsd-verifier` even when "it obviously works".** Phase 02's missing `VERIFICATION.md` forced retroactive integration-check verification. The formal artifact is cheaper to produce during the phase than to reconstruct after.
3. **Populate `requirements-completed` frontmatter on every SUMMARY.md.** The 3-source audit cross-reference relies on it; without it we fall back to content parsing, which is slower and more error-prone.
4. **Scope human-QA as a plan task, not a post-phase blocker.** Phase 04's 5 manual QA items ended up as milestone tech debt because they weren't included in an execution wave. A dedicated "browser QA" plan with a `checkpoint:human-verify` task would have landed them in the milestone.
5. **`cacheComponents: true` + `'use cache'` integrates cleanly with module-scoped singletons** as long as the singleton is anchored on `globalThis` — which is why Phase 1 had to happen before Phase 2. Linear dependency chains are worth the wait when they're load-bearing.
6. **Fix small code-review findings inline, defer only true polish.** Of Phase 03's 7 deferred findings, at least M3 (regex strictness) and L3 (`useCallback`) could have been 2-line fixes during the review pass rather than debt.
7. **Integration checker is the right safety net for retroactive audit.** When a phase lacks formal verification, a milestone-level integration check with explicit REQ-ID mapping and file:line evidence produces better audit output than nothing and catches things a per-phase verifier might miss (cross-phase wiring).

### Cost Observations

- Model profile: `quality` (per `.planning/config.json`)
- Sessions: not instrumented this milestone — adopt session-report for v1.1
- Notable efficiency win: `gsd-integration-checker` with explicit REQ-IDs + E2E-flow prompt produced file:line-precise evidence in a single pass; a second iteration was not needed.

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Phases | Plans | Key Change |
|-----------|--------|-------|------------|
| v1.0 | 4 | 11 | Established linear-dependency-chain phase planning; adopted `next/dynamic` + `'use cache'` + `cacheTag('snapshot')` as standard streaming pattern |

### Cumulative Quality

| Milestone | Tests | Tests Added | Unit-Test Baseline |
|-----------|-------|-------------|--------------------|
| v1.0 | 246 | 164 | 82 (INFRA-02 preserved floor) |

### Top Lessons (to validate against v1.1)

1. _(v1.0 — validate in v1.1)_ Update REQUIREMENTS.md traceability checkboxes as plans complete, not at milestone close.
2. _(v1.0 — validate in v1.1)_ `VERIFICATION.md` is cheaper to produce in-phase than to reconstruct; never skip it.
3. _(v1.0 — validate in v1.1)_ Populate `requirements-completed` frontmatter on every SUMMARY.md.
4. _(v1.0 — validate in v1.1)_ Schedule human-QA as a plan task with a `checkpoint:human-verify` gate, not post-phase follow-up.
