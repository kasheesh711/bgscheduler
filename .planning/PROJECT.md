# BGScheduler

## What This Is

A tutor scheduling tool for BG Education admin staff that searches tutor availability from Wise API snapshots and surfaces side-by-side compare views for up to 3 tutors at once. After v1.0, BGScheduler is a snappy GCal-style workspace with server-streamed data, lazy-loaded calendar components, one-click compare workflow, and an accessibility-audited UI. Primary users are 8 allowlisted non-technical admin staff who self-serve tutor comparisons without engineering support.

## Core Value

Admin staff can find, compare, and schedule tutors instantly and independently — no waiting, no confusion, no handholding.

## Current State

**Shipped version:** v1.0 (2026-04-17) + v1.0.1 hotfeature (2026-04-20, commit `9e3e4ad`)
**Production URL:** https://bgscheduler.vercel.app
**Status:** Live, daily Wise sync active, 246 tests passing

### What's live after v1.0.1 (2026-04-20)
- **Recommended slots hero** — top of search results shows up to 3 auto-ranked time slots (sub-slot with most qualified tutors free), each with avatar stack, checkmark reasons, "Copy for parent" action, and a "Show in calendar" quick-add; select multiple slots to bundle into one message
- **Copy-for-parent drawer** — slide-in right drawer with Friendly/Terse tone toggle, tutor-name inclusion toggle, editable message preview, and clipboard copy
- **Idiot-proof search defaults** — default time window is 15:00–20:00 / 90 min (tutor working window) so staff get sensible results on first click; explicit "Any subject / curriculum / level" dropdown labels; inline "N filters active · Clear all" summary
- Calendar grid and compare panel unchanged from v1.0 (explicit user decision to preserve GCal principles and avoid the design deck's density-view overlap issues)

### What's live in v1.0
- Google OAuth login with admin email allowlisting (8 users)
- Daily Wise API sync with atomic snapshot promotion (first successful sync 2026-04-07)
- In-memory search index singleton with stale detection, anchored on `globalThis` (HMR-safe)
- Range search with recurring / one-time modes, qualification and modality filtering
- Side-by-side search (left) + compare (right) workspace on `/search`
- Compare up to 3 tutors with week-scoped schedules, same-student conflict detection, shared free slot computation
- Async Server Component streaming with `cacheComponents: true` + `cacheTag('snapshot')` invalidation
- Lazy-loaded WeekOverview, CalendarGrid, DiscoveryPanel via `next/dynamic`
- Client-side tutor cache with incremental fetch (AbortController race safety)
- GCal-style weekly calendar grid with per-tutor lane tints, sticky lane headers, today indicator line, numbered conflict count badges, hover tooltips
- Quick-add "+" button on search results (3 clicks → 1)
- Fullscreen compare toggle, `?week=YYYY-MM-DD` URL sync, ArrowLeft/Right keyboard nav
- aria-labels on all interactive controls, semantic color tokens, visible DiscoveryPanel error feedback
- Discovery modal for finding candidate tutors
- Data health dashboard with skeleton loading + retry guidance
- Fail-closed safety (unresolved identity/modality/qualification → Needs Review, never Available)

## Requirements

### Validated

**v1.0 milestone (shipped 2026-04-17):**
- ✓ PERF-01..03 — Component decomposition + `useCompare` hook + `globalThis` singletons — v1.0
- ✓ PERF-04..07 — Async RSC streaming + `cacheComponents` + lazy loading + snapshot-tagged cache — v1.0
- ✓ CAL-01..04 — Per-tutor lane tints, headers, today indicator, numeric conflict badges — v1.0
- ✓ FLOW-01..04 — Quick-add "+" button, hover tooltips, `?week=` URL sync, keyboard nav — v1.0
- ✓ UIFIX-01..07 — aria-labels, semantic tokens, error feedback, typography, TUTOR_COLORS consolidation, data-health UX — v1.0 (5 items pending human QA)
- ✓ INFRA-01..02 — `loading.tsx` skeleton + 82+ tests passing — v1.0 (246 tests now passing)

**v1.0.1 out-of-band ship (2026-04-20, commit `9e3e4ad`):**
- ✓ RECS-01 — Recommended-slots hero (auto-rank sub-slots by qualified-tutor count, 3 tiers) — `src/lib/search/recommend.ts` + `recommended-slots.tsx`
- ✓ RECS-02 — Copy-for-parent drawer (Friendly/Terse tone, tutor-name toggle, editable preview, clipboard) — `copy-for-parent-drawer.tsx`
- ✓ RECS-03 — Idiot-proof search defaults (15:00–20:00 / 90min window, "Any X" labels, active filter count + Clear all) — `search-form.tsx`

**Pre-v1 (existing):**
- ✓ Google OAuth + admin allowlist
- ✓ Daily Wise sync + atomic snapshot promotion
- ✓ Range search (recurring / one-time)
- ✓ Qualification + modality filtering
- ✓ Compare up to 3 tutors, conflict detection, shared free slots
- ✓ GCal-style weekly grid
- ✓ Discovery modal
- ✓ Data health dashboard
- ✓ Fail-closed safety

### Active

Next milestone goals — to be scoped via `/gsd-new-milestone`. Candidates rolling forward:

- **Human UAT of v1.0.1 ship** (recommended-slots cards, copy-for-parent drawer, defaults — production browser check still pending at time of ship)
- Complete 5 outstanding Phase 04 human-QA items (screen-reader AT, discovery error state in browser, light/dark semantic colors, skeleton proportions, text-[10px] legibility)
- Address Phase 03 polish findings: M1 (URL-sync dep stability), M2 (midnight crossover), M3 (`?week=` regex strictness), L1–L4 (semantic today indicator, dead-code cleanup, `useCallback` on `addTutor`, mount-effect closure)
- Retroactive Phase 02 VERIFICATION.md attestation (or accept integration-check as verification of record)
- Remove unused `TutorSelector` component body at `src/components/compare/tutor-selector.tsx:19`
- Reliable online/onsite detection (current heuristic under-matches — most sessions appear as onsite)
- Past-day session visibility (Wise FUTURE API does not return past sessions)
- Optional v1.0.1 follow-ups: recommended-slots tests (`recommend.test.ts`), recommended-slots telemetry (which tier gets copied most), day/date label for recurring-mode cards (currently shows "every week" without calendar date)

### Out of Scope

| Feature | Reason | Still Valid? |
|---------|--------|--------------|
| Mobile/tablet responsive redesign | Admin staff desktop-only | ✓ |
| Color palette changes | Sky blue palette stays (user preference) | ✓ |
| Calendar grid layout overhaul | GCal-style stays (user preference) | ✓ |
| Wise API / sync pipeline changes | Data layer is stable, not a bottleneck | ✓ |
| React Query / SWR integration | Existing client cache works for 3 fetch patterns | ✓ |
| Drag-and-drop rescheduling | Read-only tool; write-back creates integrity risk | ✓ |
| Real-time collaborative viewing | Only 8 users; WebSocket overkill | ✓ |
| FullCalendar library | Custom grid lighter and fits exact use case | ✓ |
| Dark mode polish | Low ROI for office-hours admin tool | ✓ |

## Context

- **Live production app** at bgscheduler.vercel.app (8 allowlisted admin users)
- **Stack:** Next.js 16 App Router, TypeScript, Tailwind, shadcn/ui, Drizzle ORM, Neon Postgres (ap-southeast-1), Vercel hosting
- **Architecture:** In-memory search index singleton (globalThis-anchored), all search/compare queries run against it. Async RSC with `'use cache'` + `cacheTag('snapshot')` for filter/tutor data. Client-side tutor cache with incremental fetch.
- **Codebase state after v1.0:** `/search` page is a 16-line Suspense wrapper delegating to `SearchWorkspace` composition root (was 878 lines pre-v1.0). `useCompare` hook centralizes compare state. Skeleton convention: `src/components/skeletons/{feature}-skeleton.tsx`. Canonical data functions in `src/lib/data/` with `'use cache'`.
- **Tests:** 246 passing (82 pre-v1.0 baseline preserved; v1.0 added 164)
- **Known limits:** Online/onsite detection heuristic under-matches (visual distinction removed from cards; modality info still shown in popover). Past-day sessions unavailable from Wise FUTURE API — compare view falls back to nearest future occurrence.

## Constraints

- **Stack:** No stack changes — Next.js 16, Tailwind, shadcn/ui, Drizzle, Neon Postgres
- **Deployment:** Vercel Hobby plan (daily cron, 300s function timeout). Upgrade to Pro for 30-min sync cadence.
- **Data integrity:** Fail-closed safety rules are non-negotiable — unresolved identity/modality/qualification → Needs Review, never Available
- **Visual:** Keep GCal-style calendar grid and sky blue color palette
- **Regression:** All 246 existing tests must continue to pass

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Keep GCal-style grid | User preference, familiar to staff | ✓ Good — shipped in v1.0, lane tints added |
| Keep sky blue palette | User preference, already polished | ✓ Good — preserved through v1.0 |
| Target near-instant feel | Admin staff self-service requires zero friction | ✓ Good — async RSC + cacheComponents + lazy loading shipped |
| Component extraction before streaming | Phase 1 blocker for Phase 2 RSC conversion | ✓ Good — clean boundaries enabled Phase 2 |
| Linear dependency chain (1 → 2 → 3 → 4) | Each phase builds on prior's clean boundaries | ✓ Good — zero cross-phase rework |
| Canonical types in `src/lib/data/` | Server-boundary reuse of `FilterOptions`, tutor list | ✓ Good — clean RSC → client prop streaming |
| `revalidateTag('snapshot', { expire: 0 })` over `'max'` | Immediate invalidation without serving stale | ✓ Good — sync endpoint works as intended |
| Skeleton convention: Server Components | Zero JS overhead on loading states | ✓ Good — matches Phase 2 streaming model |
| next/dynamic at module scope with `.then(mod => mod.Name)` | Named-export pattern for lazy loading | ✓ Good — DiscoveryPanel, WeekOverview, CalendarGrid all split cleanly |
| TUTOR_COLORS canonical in `session-colors.ts` | Alongside other color utilities | ✓ Good — single source of truth achieved |
| Today indicator literal `bg-red-500` (not token) | GCal convention | ⚠️ Revisit — accepted as L1 tech debt, candidate for semantic token |
| URL sync via `replaceState` (omit current week) | Avoid URL noise for default state | ⚠️ Revisit — effect deps include unmemoized `compare` (M1) |
| Keyboard nav guarded against input/contentEditable | T-03-11 mitigation | ✓ Good — no hijack |
| Discovery error message generic | No server detail leakage | ✓ Good |
| Accept Phase 02 verification via integration check | Integration-checker covers same ground, formal artifact skipped | ⚠️ Revisit — consider retroactive VERIFICATION.md |
| **v1.0.1 shipped out-of-band** (no /gsd-new-milestone, no PLAN.md) | User provided a high-fidelity design deck and asked to implement immediately; work was small (5 files, +632/-7) and fully client-side | ✓ Good — preview + prod deployed cleanly; handoff file recorded the decisions for next session |
| **Derive recommended slots client-side** from existing `RangeSearchResponse` | Avoids any backend/API/index change; keeps blast radius minimal; feature is a pure re-presentation of data already on the wire | ✓ Good — no Wise/DB changes, zero risk to sync pipeline |
| **Keep GCal grid, reject design deck's density view** | Density view (free=figure, busy=ground) caused student-data overlap that the user disliked | ✓ Good — preserved v1.0 calendar principles |
| **Keep dropdown-based search, reject pill/unified query bar** | Admin staff are non-technical; dropdowns are more idiot-proof than a pill input that assumes users know subject/curriculum/level vocabulary | ✓ Good — just tightened defaults and added filter count |
| **Search defaults 15:00–20:00 / 90min** (was 09:00–17:00 / 60min) | Matches tutor working window so staff don't need to know it; sensible first-search results without any tweaking | ✓ Good — ships as v1.0.1 |
| **Direct push to main, no PR** | Repo has no CI / no branch protection / solo contributor; PR adds ceremony without benefit | ✓ Good — fast-forward `51c05c1 → 9e3e4ad` |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" drift? → Update

**After each milestone** (via `/gsd-complete-milestone`):
1. Full section review
2. Core Value check
3. Out of Scope audit
4. Context update

---
*Last updated: 2026-04-20 after v1.0.1 out-of-band ship (`9e3e4ad`)*
