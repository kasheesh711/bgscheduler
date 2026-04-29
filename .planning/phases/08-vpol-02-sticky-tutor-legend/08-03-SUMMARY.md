---
phase: 08-vpol-02-sticky-tutor-legend
plan: 03
subsystem: compare-ui
tags: [sticky-legend, z-index, ui-refactor, week-overview]
requires:
  - 08-02 (Z_INDEX constant at src/lib/ui/z-index.ts)
provides:
  - "Consolidated global sticky tutor legend at the top of WeekOverview's scroll container"
  - "Always-on rendering regardless of tutor count (1, 2, or 3)"
  - "Display-only legend (no popover, no onClick) per D-07"
affects:
  - "WeekOverview now imports Z_INDEX from @/lib/ui/z-index — first downstream consumer of Plan 02's constant"
  - "Per-day sticky lane header (lines 311-344, baseline) is RETIRED — layout no longer renders that sub-row"
tech-stack:
  added: []
  patterns:
    - "Inline `style={{ zIndex: Z_INDEX.legend }}` on the sticky element (preferred form per z-index.ts JSDoc)"
    - "Solid `bg-background` (no backdrop-blur) — creates no backdrop-filter stacking context per 08-STACKING-AUDIT.md Chain A"
    - "Flat single-row layout `[● displayName]` slots driven by `tutors.map(...)` with `tutorChips[i].color` for color dots"
key-files:
  created: []
  modified:
    - path: src/components/compare/week-overview.tsx
      purpose: "Consolidate per-day sticky lane headers into single global sticky tutor legend"
      lines_changed: 61
decisions:
  - "Adopted the in-flight uncommitted diff verbatim — verified all must_haves before committing (no re-implementation)"
  - "Background treatment: solid `bg-background` (Claude's-Discretion recommendation; simpler than `bg-background/90 backdrop-blur-sm`)"
  - "Legend height: 24px (single-row dot + name); slightly taller than the retired 20px lane-header height for legibility"
  - "Used `role=\"list\"` / `aria-label=\"Tutor legend\"` + per-slot `role=\"listitem\"` for screen-reader semantics"
metrics:
  duration: "~5 min (adopt-mode verification)"
  completed: 2026-04-29
  commit: 376fa47
  files_changed: 1
  insertions: 31
  deletions: 30
---

# Phase 8 Plan 03: WeekOverview Consolidated Sticky Tutor Legend — Summary

**One-liner:** Replaces per-day sticky lane headers (`week-overview.tsx:311-344` baseline) with a single consolidated `[● displayName] [● displayName] ...` sticky legend pinned to the top of the WeekOverview scroll container — always-on regardless of tutor count, display-only per D-05/D-07, and using `Z_INDEX.legend = 6` from Plan 02.

## What shipped

One file edited — `src/components/compare/week-overview.tsx` (+31/-30 lines). The change:

1. **Added** `import { Z_INDEX } from "@/lib/ui/z-index";` to the imports block.
2. **Removed** the `multiTutorLayout && (...)` per-day sticky lane header at the baseline lines 311-344. That block iterated `DISPLAY_DAYS.map(...)` and rendered N copies of the lane-header sub-row, one per day-column.
3. **Added** a single sticky `<div role="list" aria-label="Tutor legend">` at the top of the `flex-1 overflow-y-auto min-h-0` scroll container that maps directly over `tutors` (not days) to render `[● displayName]` slots in a flat row.

```tsx
<div
  className="sticky top-0 flex items-center gap-3 bg-background border-b border-border/30 px-2"
  style={{ height: 24, zIndex: Z_INDEX.legend }}
  role="list"
  aria-label="Tutor legend"
>
  <div className="flex-shrink-0 w-10" /> {/* time-axis spacer */}
  <div className="flex-1 flex items-center gap-3 min-w-0">
    {tutors.map((t, tutorIdx) => {
      const chip = tutorChips[tutorIdx];
      return (
        <div
          key={`legend-${t.tutorGroupId}`}
          role="listitem"
          className="flex items-center gap-1.5 min-w-0 text-[11px] font-medium truncate"
          style={{ color: chip?.color ?? "#888888" }}
        >
          <div
            className="h-1.5 w-1.5 rounded-full flex-shrink-0"
            style={{ background: chip?.color ?? "#888888" }}
          />
          <span className="truncate">{t.displayName}</span>
        </div>
      );
    })}
  </div>
</div>
```

The `multiTutorLayout` flag's other consumers (lane tints at line 373 baseline, lane dividers, per-session layout at 425-426/452-453/477/479/502) are unchanged — only its sticky-header gate was retired.

## Commits

| Hash     | Type | Scope | Message |
|----------|------|-------|---------|
| `376fa47` | feat | 08-03 | consolidate per-day sticky lane headers into single sticky tutor legend (STICKY-01, STICKY-02, STICKY-04) |

Single-file atomic commit. `git log -1 --name-only 376fa47` confirms only `src/components/compare/week-overview.tsx` in the change set.

## Verification

| Check | Expected | Observed |
|-------|----------|----------|
| `grep -c 'import { Z_INDEX } from "@/lib/ui/z-index"' src/components/compare/week-overview.tsx` | 1 | 1 |
| `grep -c 'multiTutorLayout' src/components/compare/week-overview.tsx` | 13 (baseline 14 minus one removed gate) | 13 |
| `grep -c 'sticky top-0' src/components/compare/week-overview.tsx` | 1 | 1 |
| `grep -c 'lane-hdr-' src/components/compare/week-overview.tsx` | 0 (per-day header markers removed) | 0 |
| `grep -c 'zIndex: Z_INDEX.legend' src/components/compare/week-overview.tsx` | 1 | 1 |
| `grep -c 'aria-label="Tutor legend"' src/components/compare/week-overview.tsx` | 1 | 1 |
| `grep -c 'role="list"' src/components/compare/week-overview.tsx` | 1 | 1 |
| `npx tsc --noEmit` errors scoped to `src/components/compare/week-overview.tsx` | 0 | 0 |
| `npm test --run` overall | All passing | 136/136 ✓ |
| Backdrop-blur class on the new sticky element | Absent | Absent (only mentioned in a code comment explaining its absence) |

**tsc note:** Two pre-existing TS2339 errors remain in `src/lib/sync/__tests__/past-sessions-diff-hook.test.ts` from prior phases (Phase 7 territory). Zero errors are scoped to Phase 8 files.

**Test suite note:** Vitest started cleanly after a fresh `npm install` — the previous `ERR_INVALID_PACKAGE_CONFIG` issue mentioned in [08-02-SUMMARY.md](08-02-SUMMARY.md) was resolved by reinstalling node_modules. 136/136 tests passing (5-test delta vs the historical 141-test baseline is the unrelated working-tree deletion of `src/app/api/data-health/__tests__/modality-counter.test.ts`, out of Phase 8 scope per project-level decision).

## Deviations from Plan

None. The dirty diff in the working tree at execution start matched all 11 must_haves verbatim. Adopted as-is and committed.

## Known Stubs

None. The legend is fully styled, reachable, and reads from real `tutors` / `tutorChips` props.

## Deferred Issues

- The two pre-existing TS errors in `past-sessions-diff-hook.test.ts` are unrelated to Phase 8 — flagged for Phase 7 follow-up or Phase 8.5 reliability hardening pickup.
- Working-tree noise (`D modality-counter.test.ts`, `M config.json` whitespace, `??` iCloud duplicates, `??` `.claude/`, `??` `v1.1-MILESTONE-AUDIT.md`) was intentionally left untouched per pre-execution scope decision.

## Self-Check: PASSED

- All 11 must_haves from [08-03-PLAN.md](08-03-PLAN.md) verified via grep counts and visual diff inspection
- Commit `376fa47` exists in `git log`; `git log -1 --name-only` shows only `src/components/compare/week-overview.tsx`
- No STATE.md / ROADMAP.md edits from this plan (orchestrator owns those)
- No other component touched (`calendar-grid.tsx`, `compare-panel.tsx`, etc. unchanged)
- 08-03-SUMMARY.md written at `.planning/phases/08-vpol-02-sticky-tutor-legend/08-03-SUMMARY.md`
- 136/136 tests pass; tsc reports 0 errors scoped to edited file

## Threat Flags

None. The sticky legend is pure CSS positioning + display markup with no user input, no I/O, no server interaction. Matches the 08-03-PLAN.md threat register (all entries LOW / accept).

---

*Phase 8 Plan 03 complete. Ready for Plan 04 (CalendarGrid z-index normalization) — the day-view sticky header at calendar-grid.tsx:120 will adopt the same `Z_INDEX.legend = 6` while preserving its TutorProfilePopover click affordance per D-07 asymmetric interaction.*
