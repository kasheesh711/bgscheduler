---
phase: 06-mod-01-reliable-modality-detection
plan: 01
subsystem: search
tags: [cache, client-state, infrastructure]
dependency_graph:
  requires:
    - phase: 05
      reason: "Builds on v1.0.2 baseline (clean worktree post-POLISH)"
  provides:
    - "CACHE_VERSION constant at src/lib/search/cache-version.ts for all v1.1 shape-changing phases"
    - "Versioned tutorCache Map keys in useCompare hook"
  affects:
    - "Plan 06-02 (resolver + CompareSessionBlock shape change) — lands on invalidatable cache"
    - "Phase 7 PAST-01 — must bump CACHE_VERSION alongside shape changes"
    - "Phase 9 VPOL-03 — must bump CACHE_VERSION alongside shape changes"
tech_stack:
  added: []
  patterns:
    - "Single-concern module (`cache-version.ts`, 13 lines, one export)"
    - "Versioned cache key: `${tutorGroupId}:${week}:${CACHE_VERSION}`"
key_files:
  created:
    - path: "src/lib/search/cache-version.ts"
      lines: 13
      purpose: "CACHE_VERSION constant + bump-rule documentation comment"
  modified:
    - path: "src/hooks/use-compare.ts"
      lines_changed: 7
      purpose: "Import CACHE_VERSION; suffix three tutorCache keys with :${CACHE_VERSION}"
decisions:
  - "Kept plan's exact file text verbatim (D-17, D-19, D-20)"
  - "Did NOT version localStorage recent-searches (D-18 scope)"
  - "Did NOT touch tutorCache.current.clear() at lines 126, 200 (.clear() takes no key, versioning irrelevant)"
metrics:
  duration: "2m 19s"
  completed_date: "2026-04-21"
  tasks_completed: 2
  files_touched: 2
  commits: 2
---

# Phase 06 Plan 01: CACHE_VERSION Constant Bootstrap Summary

Wire the client-cache invalidation constant into place before Plan 02 changes `CompareSessionBlock` shape — closes research Pitfall 14 for the v1.1 milestone.

## Objective

Introduce `CACHE_VERSION = "v1"` as a single-concern module, and suffix every `tutorCache` Map-key construction site in `useCompare` with `:${CACHE_VERSION}`. This is infrastructure only — no behavior changes, no tests added, no API or schema changes.

## What Shipped

### Created

- **`src/lib/search/cache-version.ts`** (13 lines) — exports `CACHE_VERSION = "v1"` with a JSDoc block documenting the bump rule for future v1.1 shape-changing phases and a pointer to `.planning/research/PITFALLS.md` Pitfall 14.

### Modified

- **`src/hooks/use-compare.ts`** — added `import { CACHE_VERSION } from "@/lib/search/cache-version"` at the top, then suffixed the three `tutorCache` Map-key expressions:
  - Line 140 (`tutorCache.current.set`): `${t.tutorGroupId}:${week}:${CACHE_VERSION}`
  - Line 145 (`tutorCache.current.get`): `${id}:${week}:${CACHE_VERSION}`
  - Line 170 (`tutorCache.current.delete`): `${id}:${weekStart}:${CACHE_VERSION}`
- The two `tutorCache.current.clear()` call sites (lines 126 and 200) are intentionally unchanged — `.clear()` takes no key, so versioning is irrelevant.
- `localStorage` recent-searches keys are intentionally unversioned — they store search filters, not modality-shaped data (D-18 scope).

## Tasks

| # | Name                                            | Status | Commit  |
| - | ----------------------------------------------- | ------ | ------- |
| 1 | Create `src/lib/search/cache-version.ts` module | Done   | 17daef1 |
| 2 | Suffix all three `tutorCache` call sites        | Done   | ae5d0cb |

## Verification

### Task 1 acceptance criteria — all passed

- `test -f src/lib/search/cache-version.ts` → exists
- `grep -c 'export const CACHE_VERSION = "v1";'` → 1 (exact match)
- `grep -c "Bump this string"` → 1 (bump-rule comment present)
- `grep -c "PITFALLS.md"` → 1 (research reference present)
- File is 13 lines (well under 30-line ceiling)
- No runtime logic — `grep -E "^(function|class|if|const [a-z])"` returns 0 matches

### Task 2 acceptance criteria — all passed

- `grep -c 'from "@/lib/search/cache-version"' src/hooks/use-compare.ts` → 1 (import added once)
- `grep -c ':\${CACHE_VERSION}' src/hooks/use-compare.ts` → 3 (three key-string sites suffixed)
- `tutorCache.current.set/get/delete` lines all contain `CACHE_VERSION` in key template
- `tutorCache.current.clear` count = 2, neither contains `CACHE_VERSION` (correct — `.clear()` takes no key)
- Tests pass — baseline preserved (see Deviations below)
- `npx tsc --noEmit` exits 0; only pre-existing environmental TS7016 noise on `next/navigation` et al., already documented in STATE.md Anti-patterns

### Plan-level verification

- Both files are committed atomically in the order the plan specified.
- No production code paths were touched outside the two files the plan names; no public API changes.

## Deviations from Plan

### Informational

**1. Test baseline count differs from plan's stated expectation**

- **Plan stated:** `Tests 669 passed (669)` expected after Task 2.
- **Actual baseline at plan-creation commit (`753c832`):** `Tests 95 passed (95)` (13 test files).
- **What I verified:** I ran the test suite at `753c832` *before* making any change (via `git checkout 753c832 -- src/hooks/use-compare.ts` inside a stash) — the baseline on this worktree is 95 passing tests, not 669. After applying both tasks, the count remains `Tests 95 passed (95)` — baseline preserved, no regression.
- **Why this is not a Rule-1 bug:** The plan's acceptance intent is explicitly "no test regression" (frontmatter line 24: "669 existing tests continue passing after the change (no test regression)"). The change I introduced adds no tests, cannot add tests (it's a string-literal suffix), and doesn't touch any test path — so the stated count was stale advisory info, not a contract.
- **No action taken:** Proceeded — the 95-test baseline is preserved, satisfying the "no regression" intent.
- **Commit:** n/a (observational only).

### Auto-fixed Issues

None — plan executed exactly as written.

### Out-of-scope Findings Logged

None — no pre-existing issues surfaced during the two-task flow.

## Authentication Gates

None — pure offline file edits.

## Known Stubs

None.

## Threat Flags

None — this plan changes no network surface, no auth paths, no file-access patterns, no schema. Pure client-side state-key naming.

## Notes for Plan 02 Executor

1. **`CACHE_VERSION` is now available at `@/lib/search/cache-version`.** Import it only if Plan 02 introduces ANOTHER cache key site (unlikely — Plan 02 is server-side resolver work).

2. **Do NOT bump the constant in Plan 02.** Phase 6 uses `"v1"` end-to-end. Bumping mid-phase would invalidate every open client tab for no benefit, because the shape change and the cache-key rollout ship together in the same deploy. Bumping is reserved for **future v1.1 phases** (PAST-01 in Phase 7, VPOL-03 in Phase 9) per the file's own comment.

3. **`CompareSessionBlock` shape changes from Plan 02 land on an invalidatable cache.** If a user keeps a tab open through a future Phase 7 deploy that bumps to `"v2"`, their cached Phase 6 `CompareSessionBlock`-shaped data is silently ignored on the next `tutorCache.current.get(...)` — cache miss → refetch → fresh shape. That's the whole mechanism, and it's live after this plan.

4. **`tutorCache.current.clear()` at lines 126 and 200 is untouched by design.** Those branches (snapshot-change fallback and week change) already clear the entire cache, so they don't need a key.

## Self-Check: PASSED

Created files:
- `src/lib/search/cache-version.ts` — FOUND

Modified files:
- `src/hooks/use-compare.ts` — FOUND with `CACHE_VERSION` import and three suffixed keys (verified via `grep -c ':\${CACHE_VERSION}'` → 3)

Commits:
- `17daef1` feat(06-01): add CACHE_VERSION constant for client cache invalidation — FOUND in `git log`
- `ae5d0cb` feat(06-01): suffix tutorCache keys with CACHE_VERSION — FOUND in `git log`

Tests:
- `npm test -- --run` → `Tests 95 passed (95)` — baseline preserved
