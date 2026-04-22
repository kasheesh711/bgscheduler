---
phase: 07-past-01-past-day-session-visibility
plan: 06
subsystem: infra
tags: [client-cache, cache-invalidation, use-compare, compare-tutor]

# Dependency graph
requires:
  - phase: 06-mod-01-reliable-modality-detection
    provides: "CACHE_VERSION constant introduced at v1 (D-19 rule — future shape-changing phases MUST bump)"
provides:
  - "CACHE_VERSION = \"v2\" in src/lib/search/cache-version.ts (transparent long-lived-tab invalidation for PAST-01 shape change)"
  - "JSDoc migration history v1 -> v2 recording rationale for future maintainers"
affects: [07-past-01-past-day-session-visibility, vpol-03-density-overview]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Cache-version bump convention: single-line constant change propagates via composite cache keys; no call-site edits needed"

key-files:
  created: []
  modified:
    - "src/lib/search/cache-version.ts (CACHE_VERSION v1 -> v2, JSDoc migration history)"

key-decisions:
  - "Bump only the constant value; leave all three use-compare.ts call sites (140, 145, 170) untouched — they already read the constant via import and auto-propagate"
  - "Document v1 -> v2 migration history in JSDoc so the D-17/Pitfall-14 rule (phases with CompareTutor shape changes MUST bump) is durable"
  - "Do NOT add localStorage persistence or runtime migration — cache is in-memory only (useRef) per PITFALLS.md §Pitfall 14; old v1 keys are ephemeral and cannot leak"

patterns-established:
  - "Migration-history JSDoc: future cache-version bumps should append a new bullet (e.g. v3 for VPOL-03) rather than replace the existing history"

requirements-completed: [PAST-01]

# Metrics
duration: 30min
completed: 2026-04-22
---

# Phase 07 Plan 06: Cache Version Bump Summary

**CACHE_VERSION bumped from "v1" to "v2" to transparently invalidate long-lived browser tabs ahead of the PAST-01 CompareTutor shape change, with JSDoc migration history documenting the v1 -> v2 rationale.**

## Performance

- **Duration:** ~30 min (includes worktree branch repair)
- **Started:** 2026-04-22T04:21:23Z
- **Completed:** 2026-04-22T04:51:00Z
- **Tasks:** 1 completed
- **Files modified:** 1

## Accomplishments

- `src/lib/search/cache-version.ts` — `CACHE_VERSION` constant value changed from `"v1"` to `"v2"`
- JSDoc updated with explicit v1 -> v2 migration history: v1 (Phase 6 MOD-01) introduced modality fields on `CompareSessionBlock`; v2 (Phase 7 PAST-01) merges captured past sessions into `CompareTutor.sessions` for historical ranges
- D-17 / PITFALLS.md Pitfall 14 rule honored: future `v1.1` phases (VPOL-03 next) MUST bump alongside shape changes — migration-history pattern now established so appends are obvious
- Zero call-site edits at `src/hooks/use-compare.ts` (lines 140, 145, 170) — import-based propagation works as designed; the 3 composite cache keys (`${tutorGroupId}:${week}:${CACHE_VERSION}`) now produce v2-keyed entries automatically

## Task Commits

1. **Task 1: Bump CACHE_VERSION to "v2" + update file-level JSDoc** — `d8da9e4` (chore)

## Files Created/Modified

- `src/lib/search/cache-version.ts` — Bumped constant `"v1"` -> `"v2"`; rewrote JSDoc with migration history (14 insertions, 5 deletions)

## Decisions Made

- **Single-file scope honored:** The plan explicitly forbade editing any other file; the three call sites at `use-compare.ts:140,145,170` import the constant and require no edit. Verified post-commit: `grep -c "CACHE_VERSION" src/hooks/use-compare.ts` returns 4 (1 import + 3 call sites unchanged).
- **JSDoc migration history pattern over single-line comment update:** The plan's `<action>` block included a structured "Migration history" bullet list. Adopted verbatim so future bumps (VPOL-03 v3) can append rather than rewrite, preserving the historical audit trail.
- **No localStorage, no runtime migration:** Per PITFALLS.md Pitfall 14, `tutorCache` is `useRef`-backed (in-memory only). Old v1 keys are ephemeral and cannot leak across deploys. Adding persistence would invert the pitfall.

## Deviations from Plan

None — plan executed exactly as written. The file was rewritten with the exact content specified in the plan's `<action>` block.

## Issues Encountered

- **Environmental: vitest package config error when invoking `npm test --run`.** The parent repo's `node_modules/vitest/package.json` raises `ERR_INVALID_PACKAGE_CONFIG` — pre-existing environmental issue flagged in STATE.md anti-patterns ("pre-existing TS2306/TS7016 type-decl errors on vitest, tailwind-merge, next/navigation — environmental, don't block Vercel build; tests + Vercel build are the authoritative gates"). Out of scope per deviation-rules scope boundary: not caused by this plan's 1-line change.
- **Environmental: multiple orphaned `tsc --noEmit` background processes from earlier sessions.** Workaround: ran a targeted `npx tsc --noEmit src/lib/search/cache-version.ts` (background task id `b2r5icfvc`) which completed with exit code 0 and zero output, confirming the edited file typechecks cleanly. Pre-existing environmental noise; not caused by this plan.
- **Worktree branch rebase noise:** Initial `git merge-base` showed the worktree was off `5ed3d2f` rather than the required `ad6997e`. Resolved with `git reset --soft ad6997e` followed by `git checkout ad6997e -- .` to realign both HEAD and working tree to the correct base. Clean post-repair status; only `src/lib/search/cache-version.ts` staged for commit.

## Verification Evidence

- `grep -c "export const CACHE_VERSION = \"v2\"" src/lib/search/cache-version.ts` = **1** ✓
- `grep -c "export const CACHE_VERSION = \"v1\"" src/lib/search/cache-version.ts` = **0** ✓
- `grep -c "= \"v1\"" src/lib/search/cache-version.ts` = **0** ✓ (no live v1 assignment)
- `grep -c "Phase 7, PAST-01" src/lib/search/cache-version.ts` = **1** ✓ (JSDoc documents the bump)
- `grep -c "CACHE_VERSION" src/hooks/use-compare.ts` = **4** ✓ (1 import + 3 unchanged call sites)
- `npx tsc --noEmit src/lib/search/cache-version.ts` → exit 0, no output ✓
- `git status --short` after commit → clean ✓

## Client-Side Impact Note

Long-lived admin tabs (8 allowlisted users, typical ≤3 idle tabs per user per D-17 T-07-06-01 analysis) will experience one cold-fetch on next compare interaction after this ships. Cache keys change from `{id}:{week}:v1` to `{id}:{week}:v2`; old entries are effectively orphaned in the in-memory `tutorCache` Map (no GC pressure — cleared on tab close or navigation) and new fetches populate the v2 keyspace. Plan 03's `'use cache'` + `cacheTag('snapshot')` on the server absorbs the one-shot cold-fetch load within the <2s warm budget.

## Next Phase Readiness

- Phase 7 wave-1 data-layer plans (07-01, 07-02, 07-03) and wave-2 consumers (07-04, 07-05) can now assume any client merging their new shape will invalidate stale v1-keyed cache on long-lived tabs.
- VPOL-03 phase 9 execution should repeat this pattern: bump to `"v3"` and append a v3 bullet to the migration history in the JSDoc.

## Self-Check: PASSED

- **Files created/modified verified:**
  - FOUND: src/lib/search/cache-version.ts (grep -c v2 = 1)
  - FOUND: .planning/phases/07-past-01-past-day-session-visibility/07-06-SUMMARY.md (this file)
- **Commits verified:**
  - FOUND: d8da9e4 — chore(07-06): bump CACHE_VERSION to v2 for PAST-01 shape change

---
*Phase: 07-past-01-past-day-session-visibility*
*Completed: 2026-04-22*
