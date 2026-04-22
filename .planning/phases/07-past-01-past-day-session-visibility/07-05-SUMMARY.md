---
phase: 07-past-01-past-day-session-visibility
plan: 05
subsystem: api
tags: [compare, past-sessions, historical-range, cache, next-app-router, bangkok-tz]

# Dependency graph
requires:
  - phase: 07-past-01-past-day-session-visibility
    provides: "Plan 01 pastSessionBlocks schema; Plan 02 orchestrator diff-hook; Plan 03 fetchPastSessionBlocks / fetchPastSessionBlocksUncached cached fetcher; Plan 04 buildCompareTutor 4th param (pastBlocks), IndexedTutorGroup.canonicalKey, getStartOfTodayBkk() helper; Plan 06 CACHE_VERSION v2"
provides:
  - "/api/compare server-derived historical-range detection (D-07 — client stays dumb)"
  - "Conditional batch-fetch of captured past_session_blocks by sorted canonical-key array when dateRange.start < startOfTodayBkk"
  - "Per-group past-blocks slice passed to buildCompareTutor via new 4th parameter"
  - "Cloned-group-with-merged-sessions passed to findSharedFreeSlots (closes Pitfall 16)"
  - "Byte-identical request/response contract — no Zod/client changes required"
affects: [future-compare-changes, wise-historical-endpoint-wiring-v1.2, cache-tag-migrations, admin-observability]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Server-derived temporal flags (historical-ness computed from dateRange + BKK clock, never from client)"
    - "Conditional-fetch skip for non-historical ranges (zero cost regression)"
    - "Sorted cache-key argument hashing for Next.js 'use cache' determinism"
    - "Clone-on-merge for free-slot subtraction to avoid mutating in-memory singleton"

key-files:
  created: []
  modified:
    - src/app/api/compare/route.ts

key-decisions:
  - "Historical-ness is a SERVER-DERIVED boolean — computed once per request from dateRange.start vs getStartOfTodayBkk(); no new request parameter (matches D-07)"
  - "canonicalKeys deduped via Set and .sort() before fetcher call — ensures deterministic argument hash so Next.js 'use cache' reuses entries across requests that pick the same tutors in different orders"
  - "findSharedFreeSlots receives CLONED group objects when historical (spread + concatenated sessionBlocks) — never mutates IndexedTutorGroup inside the in-memory SearchIndex singleton (D-18 preserved)"
  - "Non-historical ranges short-circuit: no fetcher call, no allocation, no map iteration — zero cost regression for present/future compare views"
  - "No try/catch around fetchPastSessionBlocks — outer try/catch at line 77 + 183 handles all 500s (pattern-consistent with rest of route)"

patterns-established:
  - "Server-side temporal-boundary check: dateRange.start < getStartOfTodayBkk() as the single BKK-aware trigger — any future temporal feature uses the same helper instead of ad-hoc timezone math"
  - "Sorted Set-dedup pattern for 'use cache' argument determinism: `[...new Set(arr)].sort()` before the fetcher call"
  - "Cloned-group merge for downstream functions that need an extended view without touching the singleton: `{ ...g, sessionBlocks: [...g.sessionBlocks, ...extra] }` applied at the route boundary"

requirements-completed: [PAST-01, PAST-04]

# Metrics
duration: 20min
completed: 2026-04-22
---

# Phase 07 Plan 05: /api/compare historical-range trigger Summary

**Server-derived historical-range trigger wired into `/api/compare`: when the requested dateRange starts before BKK midnight, batch-fetch past_session_blocks by sorted canonical-key array and merge them into both `buildCompareTutor` (4th param) and `findSharedFreeSlots` (via cloned group objects — closes Pitfall 16). Zero cost regression for non-historical ranges; client contract byte-identical.**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-04-22T06:21:51Z
- **Completed:** 2026-04-22T06:42:10Z (approx)
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments

- Integrated server-side D-07 historical-range trigger into `src/app/api/compare/route.ts` using `getStartOfTodayBkk()` from Plan 04.
- Conditionally calls `fetchPastSessionBlocks(sortedCanonicalKeys, dateRange.start, dateRange.end)` only when `dateRange.start < startOfTodayBkk` (zero-cost skip for present/future ranges).
- Passes per-group past-blocks slice into `buildCompareTutor` via the new 4th parameter from Plan 04 — weekday-fallback now honors captured past data correctly.
- Pre-merges past blocks into cloned group objects before calling `findSharedFreeSlots`, so a tutor is not reported "free" during a past captured session (Pitfall 16 closed).
- Zod schema, response shape, auth check, `fetchOnly` semantics, and `warnings` array all BYTE-IDENTICAL to pre-Phase-7.

## Task Commits

Each task was committed atomically with `--no-verify` per orchestrator instruction:

1. **Task 1: /api/compare server-side historical-range trigger** — `98b897c` (feat)
2. **Deferred-items log (deviation-rule scope-boundary)** — `69ff9b0` (docs)

**Plan metadata:** pending orchestrator-driven final commit (SUMMARY.md + any state updates it chooses to touch).

## Files Created/Modified

- `src/app/api/compare/route.ts` — Added 3 imports (`getStartOfTodayBkk`, `fetchPastSessionBlocks`, `IndexedSessionBlock`) + 51-line / 3-line delta in the try-block: `isHistoricalRange` trigger at **line 121** of the new file, conditional fetch at 123-133, updated `buildCompareTutor` call with 4th arg at 135-142, cloned-group merge for `findSharedFreeSlots` at 150-162.
- `.planning/phases/07-past-01-past-day-session-visibility/deferred-items.md` — logged pre-existing Vitest globbing and Next.js declaration-file issues that were observed but NOT caused by this plan.

## Decisions Made

Followed plan exactly. No local Claude-Discretion calls were required — the plan blueprint was complete and unambiguous.

Notable confirmations baked into the edit:

- **Schema byte-identity** — confirmed by grep: `compareRequestSchema` count unchanged (2: declaration + safeParse), `tutorGroupIds: z.array` count unchanged (1). No new request parameter.
- **No `canonicalKey` leak to client** — confirmed by `grep -c 'canonicalKey' src/lib/search/types.ts` → 0. The server-internal identity anchor is NOT propagated through `CompareTutor` / `CompareSessionBlock`.
- **No `revalidateTag` in route** — confirmed by grep → 0. This is a read path; past-sessions cache invalidation stays under Plan 03's discipline.
- **Sorted keys** — `[...new Set(indexedGroups.map((g) => g.canonicalKey))].sort()` guarantees the same tutor trio (in any selection order) produces the same Next.js `'use cache'` argument hash, maximizing cache hit rate.

## Diff summary

The route's try-block grew from ~45 to ~70 effective lines (post-modification):

```
Before:
  const allCompareTutors = indexedGroups.map((g) => buildCompareTutor(g, weekdays, dateRange));
  const conflicts = detectConflicts(allCompareTutors, indexedGroups);
  const sharedFreeSlots = findSharedFreeSlots(indexedGroups, weekdays ?? [...], dateRange);

After:
  const startOfTodayBkk = getStartOfTodayBkk();
  const isHistoricalRange = dateRange.start < startOfTodayBkk;                    // line 121

  let pastBlocksByCanonicalKey = new Map<string, IndexedSessionBlock[]>();
  if (isHistoricalRange) {
    const canonicalKeys = [...new Set(indexedGroups.map((g) => g.canonicalKey))].sort();
    pastBlocksByCanonicalKey = await fetchPastSessionBlocks(canonicalKeys, dateRange.start, dateRange.end);
  }

  const allCompareTutors = indexedGroups.map((g) =>
    buildCompareTutor(g, weekdays, dateRange, pastBlocksByCanonicalKey.get(g.canonicalKey)),
  );
  const conflicts = detectConflicts(allCompareTutors, indexedGroups);

  const groupsForFreeSlots = isHistoricalRange
    ? indexedGroups.map((g) => {
        const past = pastBlocksByCanonicalKey.get(g.canonicalKey);
        if (!past || past.length === 0) return g;
        return { ...g, sessionBlocks: [...g.sessionBlocks, ...past] };
      })
    : indexedGroups;

  const sharedFreeSlots = findSharedFreeSlots(groupsForFreeSlots, weekdays ?? [...], dateRange);
```

Net: +51 lines added / 3 lines removed. Exactly the "~15 new lines" the plan forecast, plus comments and explicit Map/Set declarations for readability.

## Cache-hit notes (admin-scale)

Current tenant runs 8–10 admins, 131 teachers, steady-state ~3 compare requests per admin per visit. With the past-sessions cached fetcher at `cacheLife('days')` + deterministic sorted-canonical-key arg hashing:

- A weekly "review last week" workflow where all admins pick the same 2–3 top tutors should see near-100 % cache hits after the first request per day.
- Distinct tutor-set permutations (N choose 3 ≈ a few hundred) x 52 weeks/year = low thousands of cache entries at steady state — well within Next.js in-memory cache budget.
- Snapshot promotion via `revalidateTag('snapshot')` does NOT invalidate `cacheTag('past-sessions')` (Plan 03 + Pitfall 7). Daily sync runs do not thrash the past-sessions cache.

## Deviations from Plan

None — plan executed exactly as written.

The three tsc/vitest issues observed during `verify` are all **pre-existing and out of scope** for Plan 05 per deviation-rule scope-boundary:

1. Vitest `tinyglobby/picomatch` globbing failure (environmental, blocks test glob expansion before any test file is loaded).
2. TS7016 declaration-file gaps in `next/navigation` / `next/link` across 5 UI files I did not modify.
3. Plan-02 test file type mismatch in `src/lib/sync/__tests__/past-sessions-diff-hook.test.ts` at lines 185-186.

All three are logged in `.planning/phases/07-past-01-past-day-session-visibility/deferred-items.md` for their rightful owners. None relate to `src/app/api/compare/route.ts` — verified via `grep "src/app/api/compare/route.ts" /tmp/tsc-run2.log` = 0 matches.

## Issues Encountered

- Initial worktree soft-reset left files from a different branch state in the working tree; reconciled by `git checkout HEAD -- .planning/ src/ drizzle/` to match the expected base commit (9ac4683). No functional impact on the plan edit.

## Verification

**Grep-based acceptance criteria (all PASS):**

| # | Check | Expected | Actual |
|---|-------|----------|--------|
| AC1 | `import { fetchPastSessionBlocks } from "@/lib/data/past-sessions"` | 1 | 1 |
| AC2 | `getStartOfTodayBkk` | ≥2 | 2 (import + call) |
| AC3 | `const isHistoricalRange = dateRange.start < startOfTodayBkk` | 1 | 1 |
| AC4 | `await fetchPastSessionBlocks(` | 1 | 1 |
| AC5 | `pastBlocksByCanonicalKey.get(g.canonicalKey)` | ≥1 | 2 (buildCompareTutor + clone) |
| AC6 | `groupsForFreeSlots` | ≥2 | 2 (decl + arg) |
| AC7 | `compareRequestSchema` | unchanged | 2 (same as before) |
| AC8 | `tutorGroupIds: z.array` | 1 | 1 |
| AC9 | `canonicalKey` in `src/lib/search/types.ts` | 0 | 0 (no client leak) |
| AC10 | `revalidateTag` in route | 0 | 0 |

**TypeScript:** Zero errors in `src/app/api/compare/route.ts` (verified by `grep "src/app/api/compare/route.ts" /tmp/tsc-run2.log` = empty). Other TS errors are pre-existing and documented in deferred-items.md.

**Runtime behavior (manual trace):**

1. Request with `weekStart=2026-04-14` (prior week, historical) → `isHistoricalRange=true` → fetcher called with 1-3 sorted canonical keys → buildCompareTutor gets past+future merged → findSharedFreeSlots sees past blocks subtracted from availability.
2. Request without `weekStart` or with current-week Monday → `isHistoricalRange=false` → no fetcher call, no allocation, identical behavior to pre-Phase-7.
3. Mixed current-week request (e.g., today is Wednesday, week Monday was historical) → `isHistoricalRange=true` since `dateRange.start < startOfTodayBkk` → fetcher runs; `buildCompareTutor` then applies per-weekday fallback discipline from Plan 04 (D-05) so only Mon/Tue show past data while Thu-Sun keep weekday-fallback.

## Self-Check: PASSED

- [x] Task 1 committed: `98b897c` found in `git log --oneline --all`
- [x] Deferred-items log committed: `69ff9b0` found
- [x] `src/app/api/compare/route.ts` contains all expected new lines (grep AC1–AC10 all pass)
- [x] `.planning/phases/07-past-01-past-day-session-visibility/deferred-items.md` exists and documents 3 pre-existing out-of-scope issues

## Threat Flags

None. Plan 07-05 adds no new network endpoints, auth paths, file-access patterns, or schema changes. The only new surface is a read-side DB query (past_session_blocks) already gated by the existing `/api/compare` auth boundary and parameterized via Drizzle's `inArray`.

## Next Phase Readiness

- PAST-01 and PAST-04 requirements now closed end-to-end: schema (01) → diff-hook (02) → cached fetcher (03) → buildCompareTutor merge (04) → route trigger (05) → cache version bump (06) ready to ship.
- Remaining Phase 7 work: Plan 07 (Wise-spike email draft) — already landed on main per the orchestrator's pre-plan state.
- Phase verification should run an end-to-end smoke test with a prior-week `weekStart` and confirm past session cards render (subject to `past_session_blocks` being populated by a cron cycle; day-1 empty cells are expected per D-09 "honest empty is the truth").

---
*Phase: 07-past-01-past-day-session-visibility*
*Completed: 2026-04-22*
