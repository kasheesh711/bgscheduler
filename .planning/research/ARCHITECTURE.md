# Architecture Research — v1.1 Integration Plan

**Domain:** BGScheduler (internal tutor-availability tool; Wise API ETL + in-memory index + GCal-style compare UI)
**Researched:** 2026-04-20
**Confidence:** HIGH on MOD-01, PAST-01, VPOL-02, VPOL-03 (verified against codebase). MEDIUM on VPOL-01 (Next.js 16 docs explicitly warn against production use of experimental viewTransition flag, and React 19.2.4 stable does not export `<ViewTransition>`).

This document answers: **"Where does each v1.1 feature hook into the existing pipeline?"** It supersedes the v1.0 ARCHITECTURE.md (which addressed the monolith-to-RSC refactor) and focuses exclusively on the five v1.1 targets: MOD-01, PAST-01, VPOL-01, VPOL-02, VPOL-03.

---

## System Overview (post-v1.1, target shape)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                         CRON / SYNC (server)                                 │
│  POST /api/internal/sync-wise  →  runFullSync() in orchestrator.ts           │
│    1. fetchAllTeachers                                                       │
│    2. resolveIdentities  → isOnlineVariant  (name-regex — unchanged)         │
│    3. fetchTeacherFullAvailability  (working hours + leaves)                 │
│    4. fetchAllFutureSessions           ◄── MODIFIED for MOD-01 (pass type)   │
│    4b. [NEW]  fetchPastSessionsWindow (PAST-01, optional Wise history)       │
│    5. normalizeSessions  →  sessionType, location preserved                  │
│    6. deriveModality    ◄── REWRITTEN for MOD-01 (sessionType-primary)       │
│    7. write snapshot tables                                                  │
│    7b.[NEW]  write past_session_blocks table  (PAST-01 fallback path)        │
│    8. atomic promote                                                         │
└────────────────────┬─────────────────────────────────────────────────────────┘
                     │ snapshot promotion → revalidateTag('snapshot')
                     ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                    IN-MEMORY SEARCH INDEX  (globalThis-anchored)             │
│  src/lib/search/index.ts :: ensureIndex(db) → SearchIndex                    │
│   ├─ IndexedTutorGroup[]                                                     │
│   ├─ byWeekday: Map<number, IndexedTutorGroup[]>                             │
│   └─ (past sessions stay OUT — queried per-request, see PAST-01)             │
└────────────────────┬─────────────────────────────────────────────────────────┘
                     │
      ┌──────────────┴───────────────┬──────────────────┐
      ▼                              ▼                  ▼
┌───────────┐                ┌──────────────┐    ┌─────────────────┐
│ /api/     │                │ /api/compare │    │ /api/tutors,    │
│ search,   │                │ + /discover  │    │ /filters        │
│ /range    │                │ (extended    │    │ (RSC 'use       │
│           │                │  past weeks) │    │  cache'+tag)    │
└─────┬─────┘                └──────┬───────┘    └────────┬────────┘
      │                             │                     │
      ▼                             ▼                     ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                        CLIENT  (SearchWorkspace)                             │
│                                                                              │
│  ┌────────────────────┐            ┌─────────────────────────────────────┐   │
│  │ SearchForm         │   1/2 vw   │ ComparePanel                        │   │
│  │ RecommendedSlots   │            │  ├─ Tutor chips + Combobox          │   │
│  │ SearchResults      │            │  ├─ Week picker (calendar popover)  │   │
│  │ CopyForParentDrawer│            │  ├─ Day tabs                        │   │
│  │                    │            │  ├─ [NEW]  StickyTutorLegend  VPOL-2│   │
│  │                    │            │  ├─ [NEW]  DensityMiniMap     VPOL-3│   │
│  │                    │            │  ├─ WeekOverview (calendar grid)    │   │
│  │                    │            │  │   ├─ MOD-01 modality-aware cards │   │
│  │                    │            │  │   └─ PAST-01 past-data badge     │   │
│  │                    │            │  └─ CalendarGrid (day drill-down)   │   │
│  │                    │            │     └─ optional startViewTransition │   │
│  │                    │            │        wrapper for VPOL-01          │   │
│  └────────────────────┘            └─────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Feature-by-Feature Integration

### (1) MOD-01 — Reliable online/onsite detection

#### What the code actually has today

**Critical clarification:** "`isOnlineVariant`" in this codebase is not a Wise API field. It is a **name-regex derivation** in `src/lib/normalization/identity.ts:52`:

```ts
export function isOnlineVariant(displayName: string): boolean {
  return /\bOnline\s*$/i.test(displayName.trim());
}
```

It is set on each `IdentityGroupMember` during `resolveIdentities()` and then consumed as the **primary signal** by `deriveModality()` in `modality.ts:28-36`. So MOD-01 is not about wiring a new field — both `isOnlineVariant` and `sessionType` are already available. MOD-01 is about **changing the confidence policy** of `deriveModality` and `resolveSessionModality` so ambiguous cases route to `unresolved` / Needs Review instead of being guessed.

The current derivation has two known failure modes (documented in CLAUDE.md Known Issues):

- `modality.ts:46-63` location heuristic matches `http/online/zoom/meet.google/virtual` strings. Most real sessions have venue names like "Think Outside the Box", "Tesla", "Nerd" — these fall through to Step 4 unresolved. That behavior is actually correct at group level.
- `compare.ts:64-68` — in `resolveSessionModality` per-session, there's a **silent fallback**: if the group only supports one modality, return that single mode. That's the bug. Sessions with a single-mode group get marked confidently even when no direct evidence exists.

#### Integration points (per file)

| File | Status | Change |
|------|--------|--------|
| `src/lib/normalization/identity.ts` | UNCHANGED | `isOnlineVariant` regex still the structural primary |
| `src/lib/normalization/modality.ts` | MODIFIED | Tighten precedence: (1) structural pair, (2) `sessionType` exact match only (`"online"`, `"onsite"`, `"in-person"`, `"offline"`); drop loose location-string heuristic; single-variant member with no session evidence → `unresolved` |
| `src/lib/search/compare.ts` | MODIFIED | `resolveSessionModality` (lines 27-70): remove the silent `group.supportedModes[0]` fallback at lines 65-68; return `"unknown"` when no confident signal. Keep existing order (teacher record isOnline → supported modes → sessionType exact → location exact → unknown), but make each step strict |
| `src/lib/search/types.ts` | MODIFIED | Add `"unresolved"` as a valid `CompareSessionBlock["modality"]` union value (distinct from `"unknown"` if UI wants different treatment) |
| `src/components/compare/week-overview.tsx` | MODIFIED | Per-card visual distinction: dashed left border for `online`, solid for `onsite`, neutral gray for `unknown/unresolved`. Currently ALL cards use solid styling because detection was unreliable (CLAUDE.md decision). With fail-closed detection, dashed/solid becomes safe to re-introduce |
| `src/components/compare/calendar-grid.tsx` | MODIFIED | Same visual rule as week-overview |
| `src/components/compare/session-colors.ts` | MODIFIED | Add `sessionBorderStyleForModality(color, modality)` helper — returns `dashed 3px` for online, `solid 3px` for onsite, `dotted 3px` for unknown |
| `src/components/compare/tutor-profile-popover.tsx` | OPTIONAL MODIFIED | Surface "modality source" for transparency ("Detected via: session type" / "Needs review") |
| `src/lib/sync/orchestrator.ts` | UNCHANGED | Pipeline already calls `deriveModality` at line 304; no new tables |

#### Downstream consumers — what else moves

1. **Search engine** (`src/lib/search/engine.ts`): already filters on `modality: "online" | "onsite" | "either"`. With stricter derivation more tutors appear in `supportedModes = []` (unresolved). Search must continue to route these to Needs Review rather than filter them out (existing fail-closed behavior). No code change, but test coverage must assert the new boundary.
2. **`supportedModes` derivation in `index.ts:195-200`:** currently maps group `"unresolved"` → `[]`. Behavior is correct; no change. The consequence is `compare.ts:64-68`'s silent single-mode fallback will hit more cases after we tighten `modality.ts` — which is exactly the reason we're removing that fallback.
3. **Recommended-slots hero** (`src/components/search/recommended-slots.tsx` + `src/lib/search/recommend.ts`): ranks by qualified-tutor count. Tutors with `supportedModes: []` should still rank when the mode filter is "either" — they're ambiguous, not ineligible. Verify `recommend.ts` treats empty `supportedModes` as "matches any mode filter" or explicitly as a low-confidence flag.
4. **`/api/data-health`:** modality-issue counts from `data_issues` table will go UP after MOD-01. This is correct (surfacing reality). UX copy on the data-health page should lead with "MOD-01 tightened detection; higher issue counts reflect reality, not regression."

#### New vs modified summary

- **NEW:** 0 new files. MOD-01 is a tightening pass, not an addition.
- **MODIFIED:** 6 files (modality.ts, compare.ts, types.ts, week-overview.tsx, calendar-grid.tsx, session-colors.ts). Optional: tutor-profile-popover.tsx.

---

### (2) PAST-01 — Past-day session visibility

#### The constraint

From CLAUDE.md and AGENTS.md: **Wise's FUTURE-status session query omits past sessions.** `buildCompareTutor` in `compare.ts:89-117` already has a workaround (pull nearest future occurrence for weekdays with no data), but one-time past sessions are lost. Two paths:

1. **Preferred — Wise historical endpoint.** Must verify it exists. `fetchAllFutureSessions` at `fetchers.ts:96-123` passes `status: "FUTURE"`; the API contract is pagination-based. If Wise also accepts `status: "PAST"` or `status: "COMPLETED"`, it's a one-line change. No evidence of this in the current codebase.
2. **Fallback — DB-snapshot storage.** Each daily sync saves today's future-sessions set. Tomorrow that set includes yesterday's former-future, now past. Over 7 days of syncs you can reconstruct the past 7 days. Safe, local, no new Wise API dependency.

Because option 1's availability is uncertain, the architecture must support BOTH with option 2 as the durable baseline.

#### Schema addition (PAST-01 fallback storage)

```sql
-- NEW table, NOT snapshot-scoped (these outlive snapshots)
CREATE TABLE past_session_blocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wise_session_id TEXT NOT NULL,
  wise_teacher_id TEXT NOT NULL,
  group_canonical_key TEXT NOT NULL,   -- NOT groupId — groups are per-snapshot
  start_time TIMESTAMPTZ NOT NULL,
  end_time   TIMESTAMPTZ NOT NULL,
  weekday    INT NOT NULL,
  start_minute INT NOT NULL,
  end_minute   INT NOT NULL,
  wise_status TEXT NOT NULL,
  is_blocking BOOLEAN NOT NULL DEFAULT true,
  title TEXT,
  session_type TEXT,
  location TEXT,
  student_name TEXT,
  subject TEXT,
  class_type TEXT,
  recurrence_id TEXT,
  first_seen_snapshot_id UUID REFERENCES snapshots(id),  -- provenance
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (wise_session_id)
);

CREATE INDEX psb_group_key_idx ON past_session_blocks (group_canonical_key);
CREATE INDEX psb_start_time_idx ON past_session_blocks (start_time);
CREATE INDEX psb_weekday_idx ON past_session_blocks (weekday);
```

Why **canonical_key not groupId:** group UUIDs rotate every snapshot (each `tutor_identity_groups` row has its own `snapshotId`). Past sessions need a stable key across snapshots. The `canonicalKey` text value is stable for a given tutor identity across syncs. Fall back to `wise_teacher_id` for correlation if canonical_key drift proves an issue.

#### Integration points

| File | Status | Change |
|------|--------|--------|
| `src/lib/db/schema.ts` | MODIFIED | Add `pastSessionBlocks` table definition; no required relation to snapshots aside from the nullable `first_seen_snapshot_id` provenance column |
| `drizzle/000X_*.sql` | NEW | One new migration (generate via `npm run db:generate`) |
| `src/lib/sync/orchestrator.ts` | MODIFIED | After step 8 future-session normalization, before the insert block, add a diff-from-previous-snapshot pass: any session present in the previous active snapshot's `futureSessionBlocks` whose `startTime < NOW()` and is NOT present in the current fetch → INSERT ON CONFLICT DO NOTHING into `past_session_blocks`. Also: optionally insert current-fetch sessions whose `startTime < NOW()` as a safety net. Idempotent via `UNIQUE(wise_session_id)` |
| `src/lib/wise/fetchers.ts` | CONDITIONALLY MODIFIED | IF Wise history endpoint exists: add `fetchPastSessionsWindow(client, instituteId, startDate, endDate)` with `status: "PAST"` or `status: "COMPLETED"`. Phase 01 research must verify the Wise contract first. If endpoint doesn't exist, skip this change entirely |
| `src/lib/data/past-sessions.ts` | NEW | `getPastSessionsForGroupCanonicals(db, canonicalKeys, dateRange): Promise<IndexedPastBlock[]>` — parameterized query, returns rows mapped to a shape compatible with `IndexedSessionBlock` for easy merging in `buildCompareTutor` |
| `src/lib/search/index.ts` | UNCHANGED | Keep the warm `SearchIndex` lean. Do NOT add past sessions to the singleton |
| `src/lib/search/compare.ts` | MODIFIED | `buildCompareTutor` signature grows a new optional `pastSessions?: IndexedPastBlock[]` param. When `dateRange.start < today` and `pastSessions` is non-empty, merge pastSessions into the `filtered` array BEFORE the weekday-fallback block (compare.ts:91-117). The existing fallback remains as a last-resort |
| `src/app/api/compare/route.ts` | MODIFIED | When `weekStart` parses to a date before current Monday, load past-session rows via new helper, map to `IndexedPastBlock[]`, pass to `buildCompareTutor`. Add response field `pastDataSource: "wise" \| "snapshot-history" \| "fallback"` so UI can show provenance badge |
| `src/app/api/compare/past-weeks/route.ts` | NOT RECOMMENDED | Don't add a separate route — let `/api/compare` handle past weeks with the same shape. Fewer surfaces to version |
| `src/components/compare/week-overview.tsx` | MODIFIED | Small provenance badge on past-week header ("From snapshot history" / "Live from Wise" / "Fallback: nearest future occurrence") |
| `src/components/compare/compare-panel.tsx` | MODIFIED (minor) | Pass `pastDataSource` through to WeekOverview |

#### Data flow — past-week compare query

```
Client: user picks week W where W < currentMonday
   │
   ▼
POST /api/compare  { weekStart: "2026-03-23", tutorGroupIds: [...] }
   │
   ▼
route.ts: detect weekStart < today → branch on past-week path
   │
   ├─► ensureIndex(db)             (warm index = current snapshot: availability, leaves, tutor metadata)
   │
   └─► NEW: getPastSessionsForGroupCanonicals(db, canonicalKeys, {start: W, end: W+7d})
           SELECT * FROM past_session_blocks
           WHERE group_canonical_key IN (...) AND start_time >= $1 AND start_time < $2
   │
   ▼
buildCompareTutor(group, weekdays, dateRange, pastSessions)
   │
   ▼
CompareResponse { pastDataSource: "snapshot-history", ... }
```

Why past sessions stay OUT of the warm `SearchIndex`:

1. **Index bloat.** 131 teachers × ~5 sessions/week × 52 weeks/year ≈ 34k rows/year. Acceptable in Postgres, excessive in memory relative to the current ~10k future-sessions footprint.
2. **Purpose mismatch.** SearchIndex exists for fast **availability calculation** — past sessions never block future slots.
3. **Cache invalidation asymmetry.** SearchIndex invalidates on snapshot promotion. Past sessions are append-only; they should NOT invalidate per-snapshot.
4. **Rebuild cost.** Every snapshot promotion would reload all past sessions. Cheap once, expensive as history grows.

Past sessions live in Postgres only, read on-demand per compare request. At ~8 admin users and maybe dozens of compare calls/day, that's negligible load on Neon.

#### New vs modified summary

- **NEW:** 1 schema table (`past_session_blocks`), 1 Drizzle migration, 1 helper module (`src/lib/data/past-sessions.ts`), optionally 1 Wise fetcher if history endpoint exists.
- **MODIFIED:** schema.ts, orchestrator.ts, compare.ts (signature), compare/route.ts, week-overview.tsx, compare-panel.tsx.

---

### (3) VPOL-01 — View Transitions

#### Current Next.js / React status (verified 2026-04-20)

- `next.config.ts` (verified): `cacheComponents: true` is set; no `viewTransition` flag.
- `node_modules/next/dist/docs/01-app/.../viewTransition.md` (verified): `experimental.viewTransition: true` enables React's `<ViewTransition>` component from the Canary channel. Docs say verbatim: *"for now, we strongly advise against using this feature in production."*
- `node_modules/react/package.json` (verified): React 19.2.4 — **stable**, not canary. The `<ViewTransition>` primitive is not exported from this build (confirmed via `react/index.js` → `react.production.js` — no ViewTransition symbol).

**Implication:** The recommended architectural path is NOT React's `<ViewTransition>`. Use the browser-native `document.startViewTransition()` API wrapped in a small helper, targeted at specific DOM subtrees. This works in React 19.2 stable without upgrading to canary and without enabling the experimental Next.js flag.

#### Where transitions hook in

Three distinct transition surfaces in BGScheduler, each with different cost:

| Surface | Trigger | Animation | Integration point |
|---------|---------|-----------|-------------------|
| Week change (prev/next/today/calendar pick) | `compare.changeWeek()` in `use-compare.ts:194` | Horizontal slide or crossfade of WeekOverview body | Tag WeekOverview's scrollable `<div>` (week-overview.tsx:293) with `view-transition-name: week-body` (inline style), and call `document.startViewTransition(() => changeWeek(...))` in `compare-panel.tsx` prev/next handlers |
| Day tab switch | `setActiveDay(day)` in compare-panel.tsx:217-232 | Crossfade between CalendarGrid and WeekOverview, or between two days | Same pattern — name the body region and wrap the `setActiveDay` call |
| Tutor add/remove | `compare.addTutor/removeTutor` in use-compare.ts:166-192 | Lane slides in/out | Higher risk — lane layout is recomputed by `computeOverlapColumns` at render time; transition must tolerate reflow. Start with fade-only on first pass |

**Recommended approach:** one NEW helper `src/lib/ui/view-transitions.ts` that wraps `document.startViewTransition` with a feature check, falls back to direct state updates on browsers without support. NO `viewTransition` flag in next.config, NO React canary upgrade.

```ts
// src/lib/ui/view-transitions.ts (NEW)
export function startTransition(update: () => void): void {
  if (typeof document === "undefined") { update(); return; }
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (typeof doc.startViewTransition !== "function") { update(); return; }
  doc.startViewTransition(update);
}
```

#### Does streaming + `cacheComponents: true` conflict?

**No direct conflict, but two subtleties worth naming:**

1. **Suspense boundaries and View Transitions interact.** If a `<Suspense>` fallback renders during a transition, the browser may capture the fallback DOM as the "after" state, producing jitter. Mitigation: call `startViewTransition` **after** data is loaded, not on the navigation that triggers the fetch. In BGScheduler this is natural — `compare.fetchCompare` is async; wrap `setCompareResponse` inside the transition, not the fetch itself.
2. **`cacheComponents` + Activity (route navigations).** `cacheComponents` uses React's `<Activity>` to preserve hidden route state (documented in `node_modules/next/dist/docs/.../cacheComponents.md`). View transitions on route changes could double-animate. BGScheduler doesn't have real route navigation in the hot path (everything is client-state within `/search`), so this is a non-issue today. Flag to revisit IF future milestones add routes.

#### Integration points

| File | Status | Change |
|------|--------|--------|
| `next.config.ts` | UNCHANGED | Do NOT enable `experimental.viewTransition` |
| `src/lib/ui/view-transitions.ts` | NEW | Feature-detecting `startTransition` helper |
| `src/hooks/use-compare.ts` | MODIFIED | Wrap `changeWeek` state updates and `setActiveDay` updates through the helper |
| `src/components/compare/week-overview.tsx` | MODIFIED | Add `style={{ viewTransitionName: "week-body" }}` to the scrollable body `<div>` at line 293 |
| `src/components/compare/calendar-grid.tsx` | MODIFIED | Same (`viewTransitionName: "day-body"`) |
| `src/components/compare/compare-panel.tsx` | MODIFIED | Wire the helper on prev/next/today buttons (lines 155-197) and day tab clicks (lines 224-244) |
| `src/app/globals.css` | MODIFIED | `::view-transition-old(week-body)` / `::view-transition-new(week-body)` keyframes for slide/crossfade |

#### Risk profile

**MEDIUM confidence.** Browser support (Chrome 111+, Firefox not yet, Safari 18+) covers the admin-user target. Falls back silently. But the tight coupling to `computeOverlapColumns` recomputation (lane-layout changes on tutor add/remove) may produce janky transitions on that specific surface. Recommend scoping v1.1 to week-change and day-tab only; defer tutor add/remove to v1.2.

---

### (4) VPOL-02 — Sticky tutor legend

#### Current state

`week-overview.tsx:295-327` already has a `sticky top-0 z-[5]` lane-header row that renders **only** in multi-tutor mode. It shows each tutor's color dot + truncated name above each day column's per-tutor sub-lane. That is *not quite* what VPOL-02 describes — the design deck (referenced in CLAUDE.md) wants a **single consolidated legend** ("Kevin blue · Paoju amber · Sam purple") that stays visible while the calendar body scrolls, so the user doesn't lose track of which color is which when they scroll into the 7-9pm rows.

#### CSS-only vs Intersection Observer — verdict

**CSS-only (`position: sticky`) is correct for this use case.** Intersection Observer is overkill when the sticky element lives in the same scroll container it needs to stick within. IO is warranted when:
- The element reacts to scrolling in a *different* container (parent).
- You need side effects on visibility (analytics, lazy loading, prefetching).
- The element must toggle a class based on intersection state.

None of those apply here. The scroll container is the WeekOverview body (`overflow-y-auto` at week-overview.tsx:293). A `sticky top-0` element inside that container sticks relative to that container. Zero JS, zero layout thrash. The existing lane-header at line 297 proves the pattern already works in this layout.

#### Integration points

| File | Status | Change |
|------|--------|--------|
| `src/components/compare/week-overview.tsx` | MODIFIED | Add/refactor a consolidated `<div>` legend above or inside the scrollable body with `position: sticky; top: 0; z-index: 6` (one higher than the existing per-day lane header at z-[5]). Content: color dot + tutor name per chip, rendered once not per day. Recommended: consolidate with the existing per-day lane-header row by replacing it — the per-day version becomes redundant once a global legend exists |
| `src/components/compare/compare-panel.tsx` | UNCHANGED | Legend lives inside WeekOverview's scroll region |
| `src/components/compare/calendar-grid.tsx` | MODIFIED (minor) | Mirror the same legend pattern in day-drill-down view for consistency |

#### Risk profile

**HIGH confidence.** Pure CSS, no runtime cost, already-proven pattern in the codebase. Biggest risk is visual spacing regression if the new sticky row competes with the existing one — mitigation is to consolidate.

---

### (5) VPOL-03 — Density overview / mini-map

#### Where it lives

Per user query: *"sidebar of week grid? header of week picker?"* — the right answer is **neither exactly**. Current compose in `compare-panel.tsx`:

```
[Tutor chips row]          — top, ~32px
[Week picker row]          — ~28px
[Day tabs row]             — ~32px  ← week/mon/tue/wed/...
[WeekOverview body]        — flex-1, scrollable
[Conflict summary]         — bottom, conditional
```

A mini-map should live **between day-tabs and WeekOverview body** as a thin horizontal strip (~24-32px tall) — 7 cells, one per weekday, each showing a density-fill bar and a conflict-count badge. Alternative: fold it into the **sticky tutor legend** from VPOL-02 so both live in one sticky top strip. The user's design-deck phrasing ("density overview / mini-map") suggests this consolidated direction.

#### Data source

The mini-map displays **density per day across selected tutors**. All data is already on the wire in `CompareResponse.tutors[].sessions[]` and `CompareResponse.conflicts`. No new aggregation endpoint needed; compute client-side:

```ts
// For each weekday ∈ {0..6}:
//   bookedMinutes     = Σ over tutors of session.endMinute - session.startMinute on that weekday
//   availableMinutes  = Σ over tutors of availabilityWindow.endMinute - availabilityWindow.startMinute on that weekday
//   density           = bookedMinutes / availableMinutes   (0..1; clamp)
//   conflictCount     = conflicts.filter(c => c.dayOfWeek === day).length
```

This is a ~20-line `useMemo` derivation in a new sibling component that receives the same `tutors` + `conflicts` props WeekOverview already gets. Zero server change.

#### Integration points

| File | Status | Change |
|------|--------|--------|
| `src/components/compare/density-mini-map.tsx` | NEW | Pure client component, takes `tutors: CompareTutor[]` + `conflicts: Conflict[]` + `onDayClick: (day) => void`. Renders 7 cells horizontally, each with a fill bar for density and a conflict-count badge |
| `src/components/compare/compare-panel.tsx` | MODIFIED | Import and place between day-tabs and WeekOverview (or between tutor-chips and week-picker — test in UI) |
| `src/components/compare/week-overview.tsx` | UNCHANGED (if mini-map lives above, not inside) | Alternative: merge into VPOL-02's sticky header |
| `src/lib/search/types.ts` | UNCHANGED | No new types; consumes existing `CompareTutor` and `Conflict` |

Zero server-side work. Zero API changes. Zero schema changes. Pure client rendering.

#### Risk profile

**HIGH confidence** on the data path (all data present in `CompareResponse`). **MEDIUM** on visual design — exact look (bars vs dots vs heat strip) is design-deck territory and will bikeshed. Defer the visual spec to the phase that builds it.

---

## Build Order (respects dependencies)

| Order | Phase | Rationale |
|-------|-------|-----------|
| 1 | **MOD-01** first | Modality drives the **visual distinction** (dashed vs solid borders) that VPOL work will want to restore. Shipping VPOL polish on top of still-broken modality means re-touching the same components twice |
| 2 | **PAST-01** (DB-snapshot fallback path) | Schema + orchestrator hook. Do this before any VPOL work so past-week compare queries are safe to exercise during manual VPOL testing. Wise-history endpoint discovery can be a parallel spike but is not blocking |
| 3 | **VPOL-02** (sticky legend) | Small, low-risk, unlocks VPOL-03 composition |
| 4 | **VPOL-03** (mini-map) | Depends on VPOL-02's sticky container real estate (or its own strip, if separate) |
| 5 | **VPOL-01** (view transitions) | Riskiest — touches animation layer, requires cross-browser manual QA. Ship last so regressions are isolated |

Rationale for "VPOL-01 last" (contra intuition that transitions are a polish item): view-transition glitches usually manifest as visual artifacts during state changes. Any later change (adding the mini-map, touching the sticky legend, tightening modality) could re-break them. Shipping transitions last = shipping on top of a frozen visual baseline = fewer iterations.

---

## Architectural Patterns (reused, not new)

### Pattern 1: Warm singleton + `globalThis` anchor

**What:** Single in-memory `SearchIndex` instance, HMR-safe via `globalThis.__bgscheduler_searchIndex` (defined in `index.ts:76-81`), rebuilt lazily when active snapshot changes.

**When to use in v1.1:** The pattern is correct for warm/current data but wrong for append-only history. PAST-01's past-session helper must NOT extend the singleton — it queries Postgres directly per request.

**Trade-off:** Keeping past data out of the singleton trades memory (small win) for per-request DB hits (small cost). Acceptable at 8-admin scale.

### Pattern 2: Fail-closed normalization

**What:** Unresolved identity/modality/qualification → Needs Review, never Available (enforced across engine + compare paths per AGENTS.md).

**When to use in v1.1:** MOD-01 is a textbook application — tighten `resolveSessionModality` to return `"unknown"` / `"unresolved"` instead of guessing a single mode.

**Trade-off:** More Needs Review noise initially. Mitigation: data-health dashboard surfaces the count; admin fixes underlying aliases/modality data in Wise.

### Pattern 3: Client-side tutor cache with incremental fetch

**What:** `tutorCache: Map<tutorGroupId:weekStart, CompareTutor>` in `use-compare.ts:84`, with `fetchOnly` server param to serialize only new data.

**When to use in v1.1:** PAST-01 extends this cache key naturally — `weekStart` already encodes the week, so past-week entries live alongside current ones in the same map. No refactor needed.

**Trade-off:** Cache is unbounded (no LRU). At 8-admin traffic, no problem. Flag for v1.2 if traffic grows.

### Pattern 4: Async RSC with `'use cache'` + `cacheTag('snapshot')`

**What:** `/api/filters`, `/api/tutors`, `src/app/(app)/search/page.tsx` server components cache against the snapshot tag; promoted sync → `revalidateTag('snapshot', { expire: 0 })` invalidates.

**When to use in v1.1:** UNCHANGED. None of MOD-01 / PAST-01 / VPOL-01-03 require touching this layer. If PAST-01 later adds an RSC that reads past-session totals for data-health, tag it with `cacheTag('past-sessions')` or leave uncached (reads are small and rare).

---

## Data Flow — MOD-01 concretized

```
Wise API → fetchAllTeachers (unchanged)
         → resolveIdentities  (unchanged — regex on displayName)
                 │
                 ▼
         IdentityGroup { members: [{ isOnlineVariant: boolean, ... }] }
                 │
                 ▼
Wise API → fetchAllFutureSessions (unchanged)
         → normalizeSessions (unchanged — carries session.type → sessionType)
                 │
                 ▼
         NormalizedSessionBlock { sessionType, location, ... }
                 │
                 ▼
  ┌───────────────────────────────────────────────┐
  │  deriveModality  (REWRITTEN)                  │
  │    Step 1: pair structure                     │
  │    Step 2: sessionType EXACT match            │
  │    Step 3: ✂ loose location heuristic REMOVED │
  │    Step 4: unresolved                         │
  └──────────────┬────────────────────────────────┘
                 │
                 ▼
         tutor_identity_groups.supportedModality ∈ {online, onsite, both, unresolved}
                 │
                 ▼
  ┌──────────────────────────────────────────────────────────┐
  │  buildCompareTutor → resolveSessionModality (MODIFIED)   │
  │    Step 1: member.isOnline → online                      │
  │    Step 2: group single-mode & member known → that mode  │
  │    Step 3: session.sessionType EXACT match               │
  │    Step 4: ✂ silent single-mode fallback REMOVED         │
  │    Step 5: unknown                                       │
  └──────────────┬───────────────────────────────────────────┘
                 │
                 ▼
      CompareSessionBlock.modality passed to WeekOverview → dashed vs solid border
```

---

## Data Flow — PAST-01 concretized

```
Day N (sync 00:00 UTC)
  fetchAllFutureSessions → future_N = [A, B, C, D]
  normalize → futureSessionBlocks in snapshot_N
  ╔════════════════ NEW HOOK after step 8 ════════════════╗
  ║ Compare future_N with future_(N-1) from previous       ║
  ║ active snapshot's futureSessionBlocks table.           ║
  ║ Any session S in future_(N-1) but not in future_N      ║
  ║   AND S.startTime < NOW():                             ║
  ║     INSERT INTO past_session_blocks                    ║
  ║       VALUES (...S..., first_seen_snapshot_id=N-1)     ║
  ║     ON CONFLICT (wise_session_id) DO NOTHING           ║
  ╚════════════════════════════════════════════════════════╝
  promote snapshot_N

Day N+1 (sync 00:00 UTC)
  fetchAllFutureSessions → future_(N+1) = [C, D, E]
        (A, B are gone — either happened or cancelled)
  [NEW HOOK]
    Compare with future_N from previous active snapshot.
    A and B were in future_N but not in future_(N+1); A.start < NOW(), B.start < NOW()
      → INSERT into past_session_blocks
  promote snapshot_(N+1)

--------------------------------------------------------------------

User at any time: compare for week W where W < currentMonday
  route.ts:
    indexedGroups = warm SearchIndex    (current data only)
    pastSessions  = SELECT ... FROM past_session_blocks
                    WHERE group_canonical_key IN (canonical_keys(indexedGroups))
                    AND start_time >= W AND start_time < W+7days
    buildCompareTutor(group, weekdays, dateRange, pastSessions)
    return { pastDataSource: "snapshot-history", ... }
```

**Key insight:** Past-session capture is driven by the **diff between consecutive snapshots**, not by reading the current snapshot in isolation. The orchestrator needs access to the previous active snapshot's future-session list during step 8 — query `futureSessionBlocks WHERE snapshotId = previousActiveSnapshotId` before promotion. This is straightforward given `snapshots.active` flag semantics (there is at most one active snapshot at any time; the previous one can be found with a `WHERE active = true` select before the promotion runs).

---

## Integration Points — summary matrix

| v1.1 Feature | NEW files | MODIFIED files | New DB table | New API route |
|--------------|-----------|----------------|--------------|---------------|
| MOD-01 | 0 | 6-7 | 0 | 0 |
| PAST-01 | 1-2 | 7 | 1 (`past_session_blocks`) | 0 (extend `/api/compare`) |
| VPOL-01 | 1 (view-transitions helper) | 3-4 | 0 | 0 |
| VPOL-02 | 0 | 1-2 | 0 | 0 |
| VPOL-03 | 1 (density-mini-map) | 1 | 0 | 0 |

**Total NEW:** 3-4 files, 1 schema table, 1 migration.
**Total MODIFIED:** ~15 files (mostly `src/components/compare/*` and `src/lib/search/*`).

No file in `src/lib/wise/*` changes except optionally `fetchers.ts` if a Wise history endpoint is confirmed during PAST-01 phase research.

---

## Anti-Patterns to Avoid

### Anti-Pattern 1: Extending SearchIndex with past sessions

**What people do:** Treat past sessions as "just more session blocks" and load them into the warm index alongside `sessionBlocks`.

**Why it's wrong:** SearchIndex is rebuilt on every snapshot change. Past data should persist across snapshots. Loading past data into the index couples unrelated invalidation lifecycles and blows up index build time as history grows.

**Do this instead:** Past sessions live in Postgres, queried per-request for the specific date range the user is viewing. Separate concern, separate data structure.

### Anti-Pattern 2: Flipping `experimental.viewTransition` on React 19 stable

**What people do:** See the flag in docs, enable it, import `<ViewTransition>` from `react`, discover it doesn't exist.

**Why it's wrong:** React 19.2.4 stable does not export `<ViewTransition>` — only canary does. The Next.js flag only enables deeper Next/React integration; it doesn't ship the primitive itself.

**Do this instead:** Use `document.startViewTransition()` directly, wrapped in a feature-detect helper (`src/lib/ui/view-transitions.ts`). Works today on Chrome/Safari, zero React upgrade.

### Anti-Pattern 3: Two sources of truth for modality without documented roles

**What people do:** The codebase already has `deriveModality` (group-level, in sync) and `resolveSessionModality` (per-session, at compare time) with subtly different rules. MOD-01 is a chance to consolidate OR to deliberately keep both with documented roles.

**Why it's wrong if undocumented:** Two silent sources of truth for the same concept drift over time. Test coverage becomes harder. Bug fixes in one miss the other.

**Do this instead — Option B (recommended):** Group-level modality is *baseline capability*; per-session modality is *actual delivery mode*. Keep both, but extract the exact-match rule table into a shared helper in `src/lib/normalization/modality.ts` that both call. Single source for the rules; two consumers.

### Anti-Pattern 4: Over-engineering VPOL-03 with a backend endpoint

**What people do:** Design a backend "density aggregation" endpoint, thinking the mini-map needs its own query.

**Why it's wrong:** All the data is already in `CompareResponse.tutors[].sessions[]` and `CompareResponse.conflicts`. A ~20-line client-side `useMemo` computes everything. A server endpoint bloats surface area and couples UI rendering to an extra network round-trip.

**Do this instead:** Compute density client-side. Zero server change.

---

## Integration Points — external boundaries

### Wise API

| Integration | Pattern | v1.1 notes |
|-------------|---------|-----------|
| `GET /institutes/:id/teachers` | `fetchAllTeachers` | UNCHANGED |
| `GET /institutes/:id/teachers/:uid/availability` | `fetchTeacherAvailability` — 26 seven-day windows | UNCHANGED |
| `GET /institutes/:id/sessions?status=FUTURE` | `fetchAllFutureSessions` — pagination via `paginateBy=COUNT` | UNCHANGED |
| `GET /institutes/:id/sessions?status=PAST` (hypothetical) | NEW IF available | Phase 01 research must verify Wise contract via their docs or a live probe before committing to option-1 path of PAST-01 |

### Postgres (Neon, ap-southeast-1)

| Integration | Pattern | v1.1 notes |
|-------------|---------|-----------|
| `@neondatabase/serverless` HTTP driver | Existing `getDb()` in `src/lib/db/index.ts` | UNCHANGED |
| Drizzle ORM queries | Existing pattern (`db.select().from(...).where(eq(...))`) | PAST-01 adds one new table + one new helper query |
| Migration generation | `npm run db:generate` | One new migration for PAST-01 |

### Browser APIs

| Integration | Pattern | v1.1 notes |
|-------------|---------|-----------|
| `document.startViewTransition` | NEW wrapper in `src/lib/ui/view-transitions.ts` | VPOL-01 feature-detect + fallback |
| `position: sticky` | Existing, proven in `week-overview.tsx:297` | VPOL-02 reuses |
| `IntersectionObserver` | NOT NEEDED | Explicit recommendation against IO for VPOL-02 |

---

## Sources

- `/Users/kevinhsieh/Desktop/Scheduling/AGENTS.md` — complete existing architecture (normalization, sync, index, engines, routes, frontend)
- `/Users/kevinhsieh/Desktop/Scheduling/CLAUDE.md` — live status, known issues (modality heuristic, past-day fallback)
- `/Users/kevinhsieh/Desktop/Scheduling/.planning/PROJECT.md` — v1.1 scope and v1.0 shipped baseline
- `/Users/kevinhsieh/Desktop/Scheduling/src/lib/normalization/identity.ts:52` — `isOnlineVariant` definition (name-regex, NOT a Wise field)
- `/Users/kevinhsieh/Desktop/Scheduling/src/lib/normalization/modality.ts` — current 4-step derivation with loose location heuristic to be tightened
- `/Users/kevinhsieh/Desktop/Scheduling/src/lib/normalization/sessions.ts` — fail-closed blocking-status classifier
- `/Users/kevinhsieh/Desktop/Scheduling/src/lib/sync/orchestrator.ts` — full ETL pipeline with snapshot promotion (line 304 calls `deriveModality`)
- `/Users/kevinhsieh/Desktop/Scheduling/src/lib/db/schema.ts` — 14 existing tables, schema conventions; `futureSessionBlocks` shape to mirror
- `/Users/kevinhsieh/Desktop/Scheduling/src/lib/search/index.ts:76-81` — `globalThis`-anchored singleton pattern for warm index
- `/Users/kevinhsieh/Desktop/Scheduling/src/lib/search/compare.ts:27-70` — `resolveSessionModality` with the silent fallback to tighten
- `/Users/kevinhsieh/Desktop/Scheduling/src/lib/search/compare.ts:89-117` — existing weekday-fallback pattern PAST-01 extends
- `/Users/kevinhsieh/Desktop/Scheduling/src/app/api/compare/route.ts` — compare endpoint, `fetchOnly` and `weekStart` contract
- `/Users/kevinhsieh/Desktop/Scheduling/src/hooks/use-compare.ts:84,194` — client-side cache pattern (`Map<tutorGroupId:weekStart>`) and `changeWeek` action
- `/Users/kevinhsieh/Desktop/Scheduling/src/components/compare/compare-panel.tsx` — composition root for VPOL-02/03 integration
- `/Users/kevinhsieh/Desktop/Scheduling/src/components/compare/week-overview.tsx:293,297` — scroll container and existing sticky lane-header pattern
- `/Users/kevinhsieh/Desktop/Scheduling/src/components/compare/calendar-grid.tsx` — day drill-down, parallel modality rendering to week-overview
- `/Users/kevinhsieh/Desktop/Scheduling/next.config.ts` — current config: `cacheComponents: true`, no viewTransition flag
- `/Users/kevinhsieh/Desktop/Scheduling/node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/viewTransition.md` — Next.js experimental flag doc; explicit production warning
- `/Users/kevinhsieh/Desktop/Scheduling/node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/cacheComponents.md` — v16.0.0 cacheComponents behavior + Activity mode
- `/Users/kevinhsieh/Desktop/Scheduling/node_modules/react/package.json` — React 19.2.4 (stable; `<ViewTransition>` not in stable exports)

---

*Architecture research for: BGScheduler v1.1 Data Fidelity & Depth*
*Researched: 2026-04-20*
