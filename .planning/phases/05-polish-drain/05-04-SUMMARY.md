---
phase: 05-polish-drain
plan: 04
subsystem: compare-hook

tags: [polish, usecallback, dead-code, hook-stability, cleanup]

# Dependency graph
requires:
  - phase: 05-polish-drain/05-01
    provides: clean working tree (prep commit landed)
provides:
  - Stable addTutor reference identity across renders (enables downstream memoization)
  - Types-and-constants-only tutor-selector.tsx module (component body removed)
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns: [usecallback-on-hook-actions, dead-code-removal-preserving-types]

key-files:
  created:
    - .planning/phases/05-polish-drain/05-04-SUMMARY.md
  modified:
    - src/hooks/use-compare.ts
    - src/components/compare/tutor-selector.tsx
  deleted: []

key-decisions:
  - "addTutor useCallback deps set to [compareTutors, weekStart, fetchCompare] per CONTEXT.md Claude's Discretion. setCompareTutors/setDiscoveryOpen are stable React setters (safe to omit). TUTOR_COLORS is a module-level constant (safe to omit)."
  - "Kept 'use client' directive in tutor-selector.tsx despite module now being types-and-constants-only — preserves the cross-module client boundary hoisting behavior and avoids an unrelated boundary change."
  - "Preserved TUTOR_COLORS re-export even though all external consumers import directly from session-colors — the re-export is cheap and documented as part of the contract in 05-CONTEXT.md D-08."
  - "removeTutor and changeWeek intentionally left un-wrapped (out of POLISH-11 scope; re-wrapping would expand the diff beyond the stated requirement)."

patterns-established:
  - "useCallback on hook actions: wrap hook-returned action functions in useCallback with explicit deps so consumers can safely memoize handlers that depend on them."
  - "Dead-code removal preserving type re-exports: when deleting an orphan component, keep the file if its co-located type interfaces or constant re-exports still have external consumers — shrinks the file to a types-and-constants module rather than deleting it outright."

requirements-completed: [POLISH-11, POLISH-14]

# Metrics
duration: ~2 min
completed: 2026-04-21
---

# Phase 5 Plan 4: useCompare.addTutor useCallback + TutorSelector Dead-Code Removal Summary

**Wrapped `useCompare.addTutor` in `useCallback` for stable reference identity (POLISH-11) and shrunk `tutor-selector.tsx` from a 52-line file with an orphan component body to a 12-line types-and-constants-only module (POLISH-14) — both shipped as atomic single-file commits on top of Wave 1.**

## Performance

- **Duration:** ~2 min (execution only; verification included)
- **Started:** 2026-04-21T02:57:05Z (agent spawn + plan load)
- **Committed:** 2026-04-21T02:58:56Z (after Task 2 tests)
- **Tasks:** 2
- **Files modified:** 2
- **Files deleted:** 0
- **Tests:** 738 passing post-Task-1, 738 passing post-Task-2 (exceeds 246 baseline recorded in STATE.md; local worktree has extra test layers from concurrent Wave 1/2 work, all green)

## Accomplishments

### POLISH-11 — addTutor useCallback wrap
- Wrapped the `addTutor` function body at `src/hooks/use-compare.ts:178-192` in `useCallback` with explicit deps `[compareTutors, weekStart, fetchCompare]`
- Stabilizes reference identity across renders as long as those three deps do not change
- Downstream memoized consumers (e.g. `SearchResults`, discovery handlers) can now trust that `compare.addTutor` is referentially stable
- No behavioral change: the closure still reads the same state, passes the same args to `fetchCompare`, and clears `discoveryOpen` the same way

### POLISH-14 — Orphan TutorSelector component body removed
- Deleted the unused `TutorSelector` function component (was lines 19-49 of the original file)
- Deleted the `TutorSelectorProps` interface (used only by the removed component)
- Removed now-unused imports: `Button` (from `@/components/ui/button`) and `X` (from `lucide-react`)
- Preserved `interface TutorChip`, `export { TUTOR_COLORS }` re-export from `./session-colors`, and `export type { TutorChip }` — these are still consumed externally (notably `src/hooks/use-compare.ts:5` imports the type)
- File shrank from **52 lines to 12 lines**: `"use client"` directive + one import + the `TutorChip` interface + two exports

## Task Commits

1. **Task 1: POLISH-11 — Wrap addTutor in useCallback** — `02e035a` (fix)
   - Files: `src/hooks/use-compare.ts`
   - Subject: `fix(05): wrap addTutor in useCallback for stable identity (POLISH-11)`
2. **Task 2: POLISH-14 — Remove orphan TutorSelector component body** — `1cefea0` (chore)
   - Files: `src/components/compare/tutor-selector.tsx`
   - Subject: `chore(05): remove orphan TutorSelector component body (POLISH-14)`

## Verification Evidence

### Task 1 acceptance grep results
- `grep -cE "const addTutor = useCallback" src/hooks/use-compare.ts` → **1** (was 0 pre-change)
- `grep -c "compareTutors, weekStart, fetchCompare" src/hooks/use-compare.ts` → **1** (dep array present)
- `grep -c "const addTutor = (id: string, name: string) =>" src/hooks/use-compare.ts` → **0** (old unwrapped form gone)
- `git log -1 --format="%s"` immediately after Task 1 → `fix(05): wrap addTutor in useCallback for stable identity (POLISH-11)`
- Files in Task 1 commit: `src/hooks/use-compare.ts` only (single-file commit)

### Task 2 acceptance grep results
- `grep -c "export function TutorSelector" src/components/compare/tutor-selector.tsx` → **0** (removed)
- `grep -c "interface TutorSelectorProps" src/components/compare/tutor-selector.tsx` → **0** (removed)
- `grep -c "interface TutorChip" src/components/compare/tutor-selector.tsx` → **1** (preserved)
- `grep -c "TUTOR_COLORS" src/components/compare/tutor-selector.tsx` → **2** (1 import + 1 re-export)
- `grep -c "export { TUTOR_COLORS }" src/components/compare/tutor-selector.tsx` → **1** (preserved)
- `grep -c "export type { TutorChip }" src/components/compare/tutor-selector.tsx` → **1** (preserved)
- `grep -c "from \"lucide-react\"" src/components/compare/tutor-selector.tsx` → **0** (unused X import removed)
- `grep -c "from \"@/components/ui/button\"" src/components/compare/tutor-selector.tsx` → **0** (unused Button import removed)
- `wc -l src/components/compare/tutor-selector.tsx` → **12** (down from 52, ≤ 15)
- `grep -rn "TutorSelector\b" src/ --include="*.tsx" --include="*.ts"` → **0 matches total** (the only remaining use was the function declaration inside the file; it's now gone and no external consumer ever imported the component)
- Files in Task 2 commit: `src/components/compare/tutor-selector.tsx` only (single-file commit)

### Plan-level verification (from the `<verification>` block)
1. `npm test` → **738 passed (738)** — exits 0 ✓
2. `grep -rn "TutorSelector\b" src/ --include="*.tsx" --include="*.ts"` → **0 matches** outside the file (0 matches anywhere) ✓
3. `grep -cE "const addTutor = useCallback" src/hooks/use-compare.ts` → **1** ✓
4. `git log --oneline` shows both commits (02e035a POLISH-11, 1cefea0 POLISH-14) ✓

## Decisions Made

- **Deps `[compareTutors, weekStart, fetchCompare]`** — React setters (`setCompareTutors`, `setDiscoveryOpen`) are stable by contract, and `TUTOR_COLORS` is a module-level constant, so all three are safe to omit. This matches the existing `useCallback` pattern at `use-compare.ts:88` for `fetchCompare` (which uses `[]`).
- **Kept `"use client"` directive** in the shrunken `tutor-selector.tsx` even though it is now a types-and-constants-only module — the directive is harmless on a module with no runtime code and preserves the file's existing client-boundary posture. Removing it would be a cross-module boundary change not scoped to POLISH-14.
- **Preserved TUTOR_COLORS re-export** — per 05-CONTEXT.md D-08, even though the only remaining external consumers (`use-compare.ts`, `recommended-slots.tsx`) import `TUTOR_COLORS` directly from `@/components/compare/session-colors`. The re-export is zero-cost and the plan's `<interfaces>` block explicitly kept it.
- **Did NOT wrap `removeTutor` or `changeWeek`** in `useCallback` — out of POLISH-11 scope; the milestone audit's L3 finding specifically cites `addTutor`. Touching the other two would expand the diff beyond the stated requirement and confuse future traceability.

## Scope Discipline

- **No changes outside the 2 listed files.** `src/hooks/use-compare.ts` and `src/components/compare/tutor-selector.tsx` only.
- No test files added (POLISH-16 ships `recommend.test.ts` under a different plan).
- No touches to `search-workspace.tsx`, `ComparePanel`, or any calendar grid file.
- Test baseline increased from 246 → 738 between Wave 1 landing and this agent's spawn; no test regressions introduced by either commit.

## Deviations from Plan

None — plan executed exactly as written. Both tasks landed with the exact commit subjects specified in the plan's `<action>` blocks. No Rule 1/2/3 auto-fixes were needed; no Rule 4 escalations surfaced.

## Known Stubs

None — neither modified file contains placeholder/TODO/FIXME/"coming soon" patterns.

## Self-Check: PASSED

- File `src/hooks/use-compare.ts` modified and committed as `02e035a` ✓
- File `src/components/compare/tutor-selector.tsx` modified and committed as `1cefea0` ✓
- Commit `02e035a` exists in `git log` ✓
- Commit `1cefea0` exists in `git log` ✓
- File `.planning/phases/05-polish-drain/05-04-SUMMARY.md` written ✓
- `npm test` exits 0 with 738 tests passing ✓
- Grep acceptance criteria all satisfied per Verification Evidence section above ✓
