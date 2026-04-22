---
phase: 08-vpol-02-sticky-tutor-legend
plan: 02
subsystem: ui-z-index-scale
tags: [sticky-legend, z-index, constants, typescript]
requires:
  - 08-01 (stacking audit + REQUIREMENTS.md amendment)
provides:
  - "Z_INDEX constant exported from src/lib/ui/z-index.ts (3-tier scale: content=1, legend=6, popover=50)"
  - "New src/lib/ui/ directory (first file in it)"
affects:
  - "None in this plan. Plans 03 (WeekOverview) and 04 (CalendarGrid) will consume Z_INDEX at wave 3."
tech-stack:
  added: []
  patterns:
    - "Typed single-export constant module mirroring src/lib/search/cache-version.ts (as const, JSDoc-heavy, zero helpers)"
key-files:
  created:
    - path: src/lib/ui/z-index.ts
      purpose: "Authoritative z-index scale for Phase 8 sticky-legend system"
      lines: 50
  modified: []
decisions:
  - "Solid (`bg-background`) vs `backdrop-blur-sm` decision deferred to Plan 03 markup; audit covers both paths (Chain A note at 08-STACKING-AUDIT.md)"
  - "No CACHE_VERSION bump per D-15 (verified: src/lib/search/cache-version.ts still `v2`)"
  - "No consumer edits in this commit (intentional — enables Plans 03 and 04 to run in parallel at wave 3)"
metrics:
  duration: "~10 min"
  completed: 2026-04-22
  commit: d8494a1
  files_changed: 1
  insertions: 50
  deletions: 0
---

# Phase 8 Plan 02: Z_INDEX Scale Constant — Summary

**One-liner:** Single-file, single-export z-index scale constant at `src/lib/ui/z-index.ts` per D-08..D-09, enabling Plans 03 + 04 to consume `Z_INDEX.legend` at wave 3.

## What shipped

One new file — `src/lib/ui/z-index.ts` (50 lines including JSDoc) — exporting:

```ts
export const Z_INDEX = { content: 1, legend: 6, popover: 50 } as const;
```

JSDoc documents:
- Three-tier scale rationale (content / legend / popover) and what lives at each slot
- Scale history (5-slot → 3-tier simplification per D-08..D-10, amended in Plan 01)
- Consumer convention (`style={{ zIndex: Z_INDEX.legend }}` preferred; Tailwind utilities acceptable with inline reference comment)
- Explicit non-bump of `CACHE_VERSION` per D-15 (different module, different lifecycle)
- Cross-references to `.planning/phases/08-vpol-02-sticky-tutor-legend/08-CONTEXT.md` §D-08..D-09 and `08-STACKING-AUDIT.md`
- Cross-reference to `.planning/REQUIREMENTS.md` §STICKY-02 (amended 2026-04-22)
- Alignment with `src/components/ui/popover.tsx` Base UI `z-50` default

No other files touched. No consumer edits. No `src/components/**` or `src/hooks/**` changes in this commit.

## Commits

| Hash     | Type | Scope | Message |
|----------|------|-------|---------|
| `d8494a1` | feat | 08    | add Z_INDEX scale constant at src/lib/ui/z-index.ts (STICKY-02) |

Single-file atomic commit. `git log -1 --name-only` confirms only `src/lib/ui/z-index.ts` in the change set; zero deletions; zero consumer edits.

## Verification

| Check | Expected | Observed |
|-------|----------|----------|
| `test -f src/lib/ui/z-index.ts` | exits 0 | ✓ |
| `test -d src/lib/ui` | exits 0 | ✓ |
| `ls src/lib/ui/` contents | only `z-index.ts` | ✓ (single file) |
| Line count | ≥ 20 | 50 |
| Exact export line present | 1 | 1 |
| Total `export` lines | 1 | 1 |
| `grep -c 08-CONTEXT.md` | ≥ 1 | 2 |
| `grep -c 08-STACKING-AUDIT.md` | ≥ 1 | 1 |
| `grep -c STICKY-02` | ≥ 1 | 4 |
| `grep -cE 'D-15\|CACHE_VERSION\|cache-version'` | ≥ 1 | 3 |
| `grep -cE 'PopoverPrimitive.Portal\|popover.tsx\|portal'` | ≥ 1 | 4 |
| `grep -c 'content: 1'` | ≥ 1 | 1 |
| `grep -c 'legend: 6'` | ≥ 1 | 1 |
| `grep -c 'popover: 50'` | ≥ 1 | 1 |
| `npx tsc --noEmit` errors scoped to new file | 0 | 0 |
| `CACHE_VERSION` in `src/lib/search/cache-version.ts` | `"v2"` unchanged | ✓ |
| `grep -rn "Z_INDEX" src/components/` | 0 hits (no premature consumer edits) | 0 |

**tsc note:** The project has pre-existing environmental TS errors (TS2306/TS7016 on `vitest`, `tailwind-merge`, `next/navigation` — per STATE.md anti-patterns) that cause `tsc --noEmit` to exit non-zero. The scoped check `tsc --noEmit 2>&1 | grep -c 'src/lib/ui/z-index.ts'` returns `0`, proving the new file introduces no new type errors. This matches the plan's acceptance-criteria guidance.

**Test suite note:** `npm test -- --run` currently fails to start on this machine due to a transient Node.js ERR_INVALID_PACKAGE_CONFIG / ETIMEDOUT reading `node_modules/@vitest/utils/package.json`. This is an environmental issue (the package.json on disk is well-formed and loads fine via direct `require()`); it pre-dates and is unaffected by this plan's change. The new file has zero test consumers and zero imports, so baseline test results are structurally unchanged by definition — any test run on a clean environment will show the same 141-test count as pre-plan. The environmental test-runner glitch is being tracked separately and will be re-verified at Plan 03 / 04 / 05 time when test runs actually exercise downstream changes.

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None. `Z_INDEX` is a concrete exported constant with literal values; nothing placeholder-shaped.

## Deferred Issues

None attributable to this plan. The test-runner environmental glitch is a machine-local node_modules / filesystem issue (ETIMEDOUT on local read; ERR_INVALID_PACKAGE_CONFIG on a file that loads fine via direct `require`) that is orthogonal to adding a single-export TypeScript constant. Logged here for visibility; to be re-checked in Plan 03.

## Self-Check: PASSED

- `src/lib/ui/z-index.ts` exists and has the exact required export line
- Commit `d8494a1` exists in `git log` (`git rev-parse --short d8494a1` → `d8494a1`)
- No STATE.md / ROADMAP.md edits from this agent (orchestrator owns those)
- No `src/components/` or `src/hooks/` files touched
- No `src/lib/search/cache-version.ts` edit (CACHE_VERSION preserved at `"v2"`)
- `08-02-SUMMARY.md` written at `.planning/phases/08-vpol-02-sticky-tutor-legend/08-02-SUMMARY.md`

## Threat Flags

None. `Z_INDEX` is a compile-time numeric literal constant with no runtime input, no user-controlled values, no I/O. Matches the 08-02-PLAN.md threat register (all entries LOW / accept / N/A).

---

*Phase 8 Plan 02 complete. Ready for wave 3 — Plan 03 (WeekOverview consolidation) and Plan 04 (CalendarGrid normalization) can now import `Z_INDEX` from `@/lib/ui/z-index` in parallel.*
