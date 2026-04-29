---
phase: 08-vpol-02-sticky-tutor-legend
reviewed: 2026-04-29T00:00:00Z
depth: standard
files_reviewed: 3
files_reviewed_list:
  - src/lib/ui/z-index.ts
  - src/components/compare/week-overview.tsx
  - src/components/compare/calendar-grid.tsx
findings:
  critical: 0
  warning: 0
  info: 0
  total: 0
status: clean
---

# Phase 8: Code Review Report — VPOL-02 Sticky Tutor Legend

**Reviewed:** 2026-04-29
**Depth:** standard
**Files Reviewed:** 3
**Status:** clean

## Summary

Phase 8 ships a pure-CSS sticky-legend refactor backed by a single typed
constant. The change surface is intentionally tiny — one new 50-line module,
one consolidated sticky element in `week-overview.tsx`, and one one-line
attribute swap on the existing sticky header in `calendar-grid.tsx`. No data
flow, network code, schema, or shape change is introduced; this is markup +
a TS literal-typed constant.

All three files were read end-to-end and cross-checked against the canonical
references in `08-CONTEXT.md`, the `08-STACKING-AUDIT.md` ancestor chains, the
`08-03-SUMMARY.md` / `08-04-SUMMARY.md` adopt-mode commit records, and the
`08-VERIFICATION.md` production walkthrough. Every Phase-8-specific concern
called out in the review prompt was checked explicitly. No issues surfaced at
any severity.

## Files Reviewed

1. **`src/lib/ui/z-index.ts`** (new, 50 lines, ~commit `60d` lineage per Plan 02)
   — Single `export const Z_INDEX = { content: 1, legend: 6, popover: 50 } as const;`
   with extensive JSDoc explaining slot semantics, the simplification from the
   original 5-slot REQUIREMENTS.md scale, the consumer convention (inline
   `style={{ zIndex: Z_INDEX.legend }}` preferred), and the explicit non-relation
   to `CACHE_VERSION`. Named export, kebab-case filename, `as const` literal
   typing, no I/O — fully aligned with project conventions.

2. **`src/components/compare/week-overview.tsx`** (Plan 03, commit `376fa47`,
   +31/-30) — Adds the `Z_INDEX` import (line 21), removes the
   `multiTutorLayout && (...)` per-day sticky lane-header block, and inserts
   one consolidated sticky `<div role="list" aria-label="Tutor legend">` at
   lines 319-345 inside the `flex-1 overflow-y-auto min-h-0` scroll container.
   Each slot uses `tutorChips[i]?.color ?? "#888888"` for both dot fill and
   text color; markup mirrors the retired lane-header dot styling per D-03.

3. **`src/components/compare/calendar-grid.tsx`** (Plan 04, commit `d9c729f`)
   — Adds the `Z_INDEX` import (line 22) and changes the sticky day-header at
   lines 121-124 from `className="flex border-b sticky top-0 bg-background z-10"`
   to the same classes minus `z-10` plus `style={{ zIndex: Z_INDEX.legend }}`.
   `TutorProfilePopover` click affordance at lines 129-136 is preserved
   verbatim, satisfying the asymmetric-interaction decision (D-07).

## Phase-Specific Concerns Verified

The review prompt enumerated specific risks to check. All cleared:

| Concern | Result | Evidence |
|---------|--------|----------|
| Any leftover `multiTutorLayout` reference on the sticky path | None | The new sticky element at `week-overview.tsx:319-345` has no conditional gate — it renders unconditionally for 1/2/3 tutors per D-04. The `multiTutorLayout` flag is still consumed at lines 374, 399, 426-427, 454-455, 478-480, 503, 510 — all in the in-flow calendar content (lane tints, lane dividers, per-session layout, font sizing), which is correct and outside the sticky path. |
| Any leftover `z-10` in `calendar-grid.tsx` | None | The class string at line 122 is `"flex border-b sticky top-0 bg-background"`. No `z-10`, no `z-[10]`. Z-index is now sourced from `style={{ zIndex: Z_INDEX.legend }}` at line 123. The `08-VERIFICATION.md` §A.4 grep confirmed `grep -c "z-10" src/components/compare/calendar-grid.tsx` returns 0. |
| Any leftover `lane-hdr-` markers | None | No `lane-hdr-` substrings remain in `week-overview.tsx` (the per-day lane-header keys/comments documented in plan 03). Replaced by `legend-${t.tutorGroupId}` keys at line 331 and `lane-bg-${day}-${tutorIdx}` / `lane-${tutorIdx}` keys for the in-flow lane tints and dividers — those are different concerns and correctly retained. |
| Consolidated legend renders for 1, 2, AND 3 tutors | Yes | `tutors.map(...)` at line 327 has no length gate. With 1 tutor the legend renders one slot; with 3 tutors three slots. The outer wrapper is rendered unconditionally (no `tutors.length > 0` guard). Empty-array case is benign — just the time-axis spacer + an empty `flex-1` wrapper, which is the correct degenerate behavior. |
| `role="list"` + `role="listitem"` ARIA correctness | Correct | `aria-label="Tutor legend"` provides an accessible name on the implicit list. Each child has `role="listitem"`. Children are visual-only (color dot + name) and convey identity-only semantics — no actionable elements were dropped (per D-05/D-07, the legend is intentionally display-only, with click affordances kept on per-session cards in week view). Screen readers will announce "list, Tutor legend, 3 items" or similar — a net upgrade vs the retired per-day lane-header sub-rows, which had no list semantics. |
| Inline `style={{ zIndex: Z_INDEX.legend }}` produces intended layering vs popover (z-50) | Correct | `Z_INDEX.legend = 6` < `Z_INDEX.popover = 50`. `src/components/ui/popover.tsx:29` uses `<PopoverPrimitive.Portal>`, which appends popovers to `<body>`, so they escape any compare-panel subtree stacking context regardless of ancestor `transform` / `filter` / `backdrop-filter`. Both Positioner and Popup carry `z-50` (lines 35, 40 of popover.tsx). The `08-STACKING-AUDIT.md` ancestor chains A and B confirmed no ancestor creates a confining stacking context via `transform`, `filter`, or `backdrop-blur`. Production walkthrough §B.2 in `08-VERIFICATION.md` confirmed click-popover-above-legend behavior visually. |
| Color fallback for empty / undefined `tutorChips` | Safe | All four legend-slot color reads use optional-chain + null-coalesce: `chip?.color ?? "#888888"` at lines 334 (text), 338 (dot fill); CalendarGrid line 129 uses `chip?.color ?? "#888"`. If `tutorChips.length < tutors.length` (off-by-one indexing), the slot still renders with the gray fallback — no `undefined` propagates to inline-style values, no React warnings. |
| Pure-CSS sticky correctness | Correct | The new sticky is a direct child of `flex-1 overflow-y-auto min-h-0` at line 311 — that's the scroll context. No ancestor adds `overflow-hidden` to a SCROLLING ancestor; non-scrolling `overflow-hidden` (body, main, workspace, compare column, WeekOverview outer) does not break sticky. `bg-background` is solid (no `backdrop-blur`), so no backdrop-filter stacking context is created. Audited in detail in `08-STACKING-AUDIT.md` Chain A. |
| No double-truncate or other markup smell | None | The slot wrapper at line 333 has `truncate` (single-line ellipsis), and the inner `<span>` at line 340 also has `truncate`. The inner span is a sensible defense for nested ellipsis when the slot is constrained by `min-w-0`; it does not produce a "double-truncate" visual artifact because both target the same single-line overflow. This pattern is in use elsewhere in the codebase (e.g. compare-panel chip strip). Acceptable. |
| Project-convention adherence | All clean | No default exports added. Named export only on the new file (`Z_INDEX`). No emojis in source. Kebab-case filename (`z-index.ts`). Imports use the `@/*` path alias. JSDoc on the constant. No semicolon-style drift. The `as const` pattern matches `DISPLAY_DAYS`, `DAY_NAMES`, `TUTOR_COLORS`. |
| Cross-file consistency | Consistent | Both consumers use the inline `style={{ zIndex: Z_INDEX.legend }}` form (the documented preferred form in z-index.ts JSDoc lines 31-33). Neither consumer mixes Tailwind `z-[6]` with the constant — no drift. |
| `WeekOverviewProps` / caller alignment | Aligned | `WeekOverviewProps` at lines 223-230 is unchanged by Phase 8. The new legend reads only from existing props (`tutors`, `tutorChips`) — no new prop introduced or required. Caller in `compare-panel.tsx` is unaffected by Phase 8 per the audit. |

## Out-of-Scope Items Acknowledged

Per the review prompt, the following pre-existing or unrelated items were
NOT flagged:

- Pre-existing TS2339 errors in `src/lib/sync/__tests__/past-sessions-diff-hook.test.ts` (Phase 7 territory).
- Working-tree noise files: `.planning/STATE 2.md`, `.planning/ROADMAP 2.md`, `.planning/v1.1-MILESTONE-AUDIT.md`, `.claude/`, `.planning/config.json` whitespace edit, deleted `src/app/api/data-health/__tests__/modality-counter.test.ts`.
- Pre-existing `sharedFreeSlots` optionality skew between `CalendarGridProps` (required) and `WeekOverviewProps` (optional) — present before Phase 8.
- Pre-existing `#888888` vs `#888` shorthand drift in fallback colors — not Phase 8.

## Production Verification Cross-Check

`08-VERIFICATION.md` records a clean production walkthrough on
`dpl_McpSbJW6Mudtbvfy3uQkL3tqvypz` (alias https://bgscheduler.vercel.app)
covering all 4 success criteria (B.1-B.7). 136/136 tests passing. Zero
type errors scoped to Phase 8 files. Z_INDEX consumer inventory matches
expected 2/2/0/0. No regression observed in fullscreen toggle, no
regression in popover stacking, no regression in CalendarGrid day-view.

## Why Status is `clean`

This is a textbook minimal refactor: a typed constant + a markup
consolidation + a one-attribute normalization. The plan-driven adopt-mode
commits (`376fa47`, `d9c729f`) match the planning artifacts verbatim. The
ARIA semantics are a net upgrade. The z-index scale is documented to a
degree that exceeds typical industry practice for a 50-line constant. The
stacking-context audit was committed as the FIRST commit of the phase per
STICKY-03's literal requirement and proves popover layering by
construction. Production behavior was verified by the executor.

There are no bugs, no security concerns (none possible — pure CSS markup
with no user input, no I/O, no server interaction), and no code-quality
issues against the project's conventions. The asymmetry between week-view
(display-only) and day-view (clickable + popover) legends is documented as
intentional in 08-CONTEXT.md D-07 and is therefore not a finding.

---

_Reviewed: 2026-04-29_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
