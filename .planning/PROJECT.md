# BGScheduler

## What This Is

A tutor scheduling tool for BG Education admin staff that searches tutor availability from Wise API snapshots and surfaces side-by-side compare views for up to 3 tutors at once. After v1.0, BGScheduler is a snappy GCal-style workspace with server-streamed data, lazy-loaded calendar components, one-click compare workflow, and an accessibility-audited UI. Primary users are 8 allowlisted non-technical admin staff who self-serve tutor comparisons without engineering support.

## Core Value

Admin staff can find, compare, and schedule tutors instantly and independently — no waiting, no confusion, no handholding.

## Current State

**Shipped version:** v1.0 (2026-04-17) + v1.0.1 hotfeature (2026-04-20, commit `9e3e4ad`) + v1.1 Phase 5 POLISH Drain (2026-04-21, commit `303dcf6`) + v1.1 Phase 7 PAST-01 code-complete (2026-04-22, commit `bcc2268`, pending operator migration to Neon)
**Production URL:** https://bgscheduler.vercel.app
**Status:** Live, daily Wise sync active, 141 tests passing across 16 test files (prior phase suites excluded from this count — see Phase 5 milestone note)

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

## Current Milestone: v1.1 Data Fidelity & Depth

**Goal:** Close the data-truth gaps (reliable online/onsite, past-day session visibility), deliver v2 visual polish (view transitions, sticky tutor legend, density overview), and drain the v1.0 polish backlog so v1.2 starts clean.

**Target features:**
- Reliable online/onsite detection via `isOnlineVariant` + sessionType; fail-closed Needs Review when ambiguous
- Past-day session visibility — try Wise historical endpoint; fallback to DB-snapshot storage of past FUTURE sessions
- View transitions (VPOL-01) across calendar / week / tutor navigation
- Sticky tutor legend (VPOL-02) during calendar scroll
- Density overview / mini-map (VPOL-03) — shape TBD in phase planning
- v1.0 polish & tech-debt drain: Phase 04 human QA (5 items), Phase 03 M1–M3 + L1–L4 findings, retroactive Phase 02 VERIFICATION.md, TutorSelector cleanup, v1.0.1 UAT + `recommend.test.ts`

**Deferred to v1.2:** AWRK-01 inline free-slot actions, AWRK-02 conflict resolution suggestions, AWRK-03 drag-to-select.

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

**v1.1 Phase 5 POLISH Drain (2026-04-21, commit `303dcf6`):**
- ✓ POLISH-01 — Screen-reader AT QA signed off on VoiceOver for search + compare flows (NVDA deferred to v1.2 as `NVDA-v12` per Phase 5 CONTEXT.md D-02)
- ✓ POLISH-02 — Discovery modal error state verified on production (force-fail via DevTools Block URL)
- ✓ POLISH-03 — Semantic color tokens verified in light + dark mode (7/7 tokens distinct)
- ✓ POLISH-04 — `/data-health` skeleton proportions verified under Slow-3G throttle (no layout shift)
- ✓ POLISH-05 — `text-[10px]` legibility verified on 13" MacBook at 100% + 110% zoom with 3 tutors
- ✓ POLISH-06 — URL-sync effect deps stabilized via `tutorIdsKey` primitive — `search-workspace.tsx`
- ✓ POLISH-07 — Today-indicator midnight tick via always-running interval + `dateKey` comparison — `calendar-grid.tsx` + `week-overview.tsx`
- ✓ POLISH-08 — `?week=YYYY-MM-DD` regex tightened via `Date.UTC` round-trip (rejects `2026-02-31`, `0000-01-01`, etc.) — `search-workspace.tsx`
- ✓ POLISH-09 — `--today-indicator` semantic OKLCH token replaces literal `bg-red-500` — `globals.css` + calendar components
- ✓ POLISH-10 — Duplicate `multiTutorLayout` guard removed from sticky-lane-header — `week-overview.tsx`
- ✓ POLISH-11 — `addTutor` wrapped in `useCallback` — `use-compare.ts`
- ✓ POLISH-12 — Mount-effect stale-closure fixed via `compareRef` latest-value pattern — `search-workspace.tsx`
- ✓ POLISH-13 — Retroactive Phase 02 attestation at `.planning/milestones/v1.0-PHASE-02-VERIFICATION.md`
- ✓ POLISH-14 — Dead `TutorSelector` component body removed; `TutorChip` type + `TUTOR_COLORS` re-export preserved
- ✓ POLISH-15 — v1.0.1 production UAT signed off (recommended-slots hero, copy-for-parent, idiot-proof defaults)
- ✓ POLISH-16 — `recommend.test.ts` 13-case regression suite pinning v1.0.1 ranking behavior

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

**v1.1 Phase 7 PAST-01 Past-Day Session Visibility (code-complete 2026-04-22, commit `bcc2268`; operator migration to Neon pending):**
- ✓ PAST-01..06 — Cross-snapshot `past_session_blocks` table + daily-sync diff-hook (`ON CONFLICT DO NOTHING` on `wise_session_id`) + cached `fetchPastSessionBlocks` (separate `cacheTag('past-sessions')` from `'snapshot'`) + `buildCompareTutor` past+future merge with per-weekday historical flag + `/api/compare` server-side historical trigger + `CACHE_VERSION` v1→v2 bump + Wise historical-endpoint email spike draft (`07-WISE-SPIKE.md`). Blocking checkpoint: operator applies `drizzle/0002_past_session_blocks.sql` to Neon via `DATABASE_URL=... npm run db:migrate`. 6 human UAT items tracked in `07-HUMAN-UAT.md`.

**v1.1 Phase 8 VPOL-02 Sticky Tutor Legend (shipped 2026-04-29, production deploy `dpl_McpSbJW6Mudtbvfy3uQkL3tqvypz`):**
- ✓ STICKY-01..04 — Pre-implementation `08-STACKING-AUDIT.md` (94 lines, both ancestor chains documented) + REQUIREMENTS.md §STICKY-02 simplified to 3-tier scale (`Z_INDEX = { content: 1, legend: 6, popover: 50 } as const`) at `src/lib/ui/z-index.ts` + WeekOverview consolidated `[● displayName]` sticky legend (always-on, display-only, `aria-label="Tutor legend"`) replacing per-day lane headers + CalendarGrid sticky day-header normalized from `z-10` to `Z_INDEX.legend` (D-07 asymmetric click affordance preserved) + completed walkthrough on production (B.1–B.7 all PASS, signed off `kevhsh7@gmail.com / 2026-04-29`). 5 plans / 4 waves / 11 commits / 0 code-review findings / 4/4 success criteria PASS / 136/136 tests passing.

### Active

v1.1 scope remaining after Phase 8 VPOL-02:

- **REL-01..08** Reliability hardening — atomic snapshot promotion, race-condition fixes, identity collision detection, retry policy, leave-overlap fix, timezone idiom unification, cron-secret timing-safe compare — **Phase 8.5** (already planned, 8 plans / 2 waves, plan-checker PASS)
- **TCOV-01..07** Test coverage hardening — search-index, sync orchestrator, API routes, past-sessions diff-hook, timezone DST, auth flow, modality contradictions — **Phase 8.6**
- **OPS-01..07** Operational maturity — snapshot pruning, sync alerts, stale-snapshot banner, threshold raise, manual sync UI, dependency cleanup, version pinning — **Phase 8.7**
- **DENS-01..04** Density overview (VPOL-03) — client-side `useMemo` aggregation, shape A/B/C chosen via design review, `prefers-reduced-motion` + a11y text equivalents — **Phase 9**
- **TRANS-01..05** View transitions (VPOL-01) — native `document.startViewTransition()` on week prev/next/today + day-tab switches; scroll capture/restore; reduced-motion CSS skip — **Phase 10**

Deferred to v1.2:
- **NVDA-v12** — NVDA screen-reader sign-off (Windows-only; deferred from POLISH-01 per Phase 5 D-02 — user has macOS-only access)
- AWRK-01 inline free-slot actions, AWRK-02 conflict resolution suggestions, AWRK-03 drag-to-select
- Recommended-slots telemetry (TELEM-01), recurring-mode calendar date labels (RECURDATE-01)
- Non-blocking code-review carry-forward: WR-01 keyboard-effect churn in `search-workspace.tsx:111-127` + IN-01 `removeTutor`/`changeWeek` memoization (same class as POLISH-06/11/12)

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
- **Tests:** 669 passing across 97 files (82 pre-v1.0 baseline preserved; v1.0 added 164; v1.0.1 added ~243; v1.1 Phase 5 added 13 for `recommend.ts`; rest accumulated through other v1.0.1 hotfixes)
- **Known limits:** Online/onsite detection heuristic under-matches (visual distinction removed from cards; modality info still shown in popover). Past-day sessions unavailable from Wise FUTURE API — compare view falls back to nearest future occurrence.

## Constraints

- **Stack:** No stack changes — Next.js 16, Tailwind, shadcn/ui, Drizzle, Neon Postgres
- **Deployment:** Vercel Hobby plan (daily cron, 300s function timeout). Upgrade to Pro for 30-min sync cadence.
- **Data integrity:** Fail-closed safety rules are non-negotiable — unresolved identity/modality/qualification → Needs Review, never Available
- **Visual:** Keep GCal-style calendar grid and sky blue color palette
- **Regression:** All 669 existing tests must continue to pass

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
| Today indicator literal `bg-red-500` (not token) | GCal convention | ✓ Resolved — POLISH-09 (Phase 5) swapped to `--today-indicator` OKLCH token; GCal red preserved in light + dark |
| URL sync via `replaceState` (omit current week) | Avoid URL noise for default state | ✓ Resolved — POLISH-06/08 (Phase 5) narrowed deps to primitives (`tutorIdsKey` + `compare.weekStart`) and tightened `?week=` regex via `Date.UTC` round-trip |
| Keyboard nav guarded against input/contentEditable | T-03-11 mitigation | ✓ Good — no hijack |
| Discovery error message generic | No server detail leakage | ✓ Good |
| Accept Phase 02 verification via integration check | Integration-checker covers same ground, formal artifact skipped | ✓ Resolved — POLISH-13 (Phase 5) produced retroactive attestation at `.planning/milestones/v1.0-PHASE-02-VERIFICATION.md` citing audit file:line evidence |
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
*Last updated: 2026-04-29 — Phase 8 VPOL-02 Sticky Tutor Legend shipped to production (5/5 plans, 4/4 STICKY-* requirements verified PASS, 136/136 tests passing, 0 code-review findings, deploy `dpl_McpSbJW6Mudtbvfy3uQkL3tqvypz` aliased to bgscheduler.vercel.app); ready for Phase 8.5 Reliability Hardening (already planned, 8 plans / 2 waves)*
