# Phase 8: VPOL-02 Sticky Tutor Legend - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-22
**Phase:** 08-vpol-02-sticky-tutor-legend
**Areas discussed:** Legend consolidation strategy, Legend content density, Scope (WeekOverview + CalendarGrid), Z-index scale authority, Stacking-context audit artifact

---

## Gray-area selection

| Option | Description | Selected |
|--------|-------------|----------|
| Legend consolidation strategy | Replace/stack/reuse the existing per-day lane header and chip strip | ✓ |
| Legend content density | What appears in the sticky strip per tutor | ✓ |
| Scope: WeekOverview only or also CalendarGrid | Do we normalize CalendarGrid's existing sticky header too? | ✓ |
| Z-index scale authority | REQUIREMENTS literal vs research suggested vs planner's call | ✓ |

**User's choice:** All four areas selected.

---

## Legend consolidation strategy

### Q1 — Target shape after Phase 8

| Option | Description | Selected |
|--------|-------------|----------|
| Replace per-day lane headers with one global sticky legend (Recommended) | Delete the duplicated per-day lane headers; add ONE sticky row at top of the scroll container | ✓ |
| Keep both — add a global legend above existing lane headers | Two sticky layers; vertical chrome risk | |
| Promote the existing chip strip into the sticky container | Move compare-panel chip strip INTO the scroll container | |

**User's choice:** Replace per-day lane headers with one global sticky legend.
**Notes:** Matches research/ARCHITECTURE.md:297 recommendation.

### Q2 — Where does existing compare-panel chip strip end up?

| Option | Description | Selected |
|--------|-------------|----------|
| Stays as-is above the week picker (Recommended) | Chip strip keeps add/remove/combobox/fullscreen controls; new sticky legend is separate | ✓ |
| Collapsed to minimal form when scrolled | Scroll-listener-driven collapse | |
| Merged into the sticky legend | Single row does both | |

**User's choice:** Stays as-is above the week picker.

### Q3 — Tutor name layout in the sticky strip

| Option | Description | Selected |
|--------|-------------|----------|
| Single row, one slot per tutor (Recommended) | Flat left-aligned `[● Kevin] [● Alex] [● Sam]` | ✓ |
| Full-width row with per-column tutor labels | Preserve per-day-column per-tutor layout | |
| Single row aligned above lane positions | Position-matched names | |

**User's choice:** Single row, one slot per tutor.

### Q4 — Render legend when only 1 tutor selected?

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, always render the legend (Recommended) | Visual stability; legend visible with 1, 2, or 3 tutors | ✓ |
| No, hide when 1 tutor | Preserve current `multiTutorLayout` gate behavior | |

**User's choice:** Yes, always render the legend.

---

## Legend content density

### Q1 — Besides color dot + name, what else in each slot?

| Option | Description | Selected |
|--------|-------------|----------|
| Just color dot + tutor name (Recommended) | Minimal | ✓ |
| Color dot + name + weekly hours booked | Richer; pulls VPOL-03 forward | |
| Color dot + name + session count | Count-based alternative | |

**User's choice:** Just color dot + tutor name.
**Notes:** Richer stats are Phase 9 (VPOL-03) territory.

---

## Scope: WeekOverview + CalendarGrid

### Q1 — Include CalendarGrid?

| Option | Description | Selected |
|--------|-------------|----------|
| Include CalendarGrid — normalize to same scale (Recommended) | Update `calendar-grid.tsx:120` to use Z_INDEX.legend; markup unchanged | ✓ |
| WeekOverview only — leave CalendarGrid alone | Smaller blast radius; z-index inconsistency remains | |
| Include CalendarGrid — replace with shared `<TutorLegend>` component | Full refactor | |

**User's choice:** Include CalendarGrid — normalize to same scale.

### Q2 — What happens to CalendarGrid's tutor-profile-popover click?

| Option | Description | Selected |
|--------|-------------|----------|
| Preserve popover click in CalendarGrid header only (Recommended) | Asymmetric by design: week-view display-only, day-view clickable | ✓ |
| Add popover to WeekOverview's sticky legend too | Full parity | |
| Remove popover from CalendarGrid for parity | Loses affordance | |

**User's choice:** Preserve popover click in CalendarGrid header only.

---

## Z-index scale authority

### Q1 — Which scale ships?

| Option | Description | Selected |
|--------|-------------|----------|
| Simplified scale reflecting consolidation (Recommended) | `Z_CONTENT=1, Z_LEGEND=6, Z_POPOVER=50`; lane-headers slot retired | ✓ |
| REQUIREMENTS.md literal (all 5 slots defined) | `content=2, legend=4, lane=5, day-header=6, popover=50` | |
| Research-suggested scale | Equivalent simplified with slightly different numbers | |

**User's choice:** Simplified scale reflecting consolidation.
**Notes:** Amendment to REQUIREMENTS.md §STICKY-02 — planner must record the rationale (same class as Phase 5 D-02's NVDA relaxation).

### Q2 — How is the scale expressed in code?

| Option | Description | Selected |
|--------|-------------|----------|
| TypeScript constant at `src/lib/ui/z-index.ts` (Recommended) | `export const Z_INDEX = { … } as const;` | ✓ |
| Tailwind classes only, doc in audit | Less greppable | |
| CSS custom properties in globals.css | Matches `--today-indicator` pattern | |

**User's choice:** TypeScript constant at `src/lib/ui/z-index.ts`.

---

## Stacking-context audit artifact (STICKY-03)

### Q1 — Artifact format

| Option | Description | Selected |
|--------|-------------|----------|
| Markdown file `08-STACKING-AUDIT.md` in phase dir (Recommended) | Columns: file:line, element, overflow, transform, filter, backdrop-blur, z-index, creates-stacking-context, notes | ✓ |
| Inline code comments at each stacking-context-creating line | Distributed; harder to audit holistically | |
| Both — markdown + strategic inline comments | Most thorough; small redundancy | |

**User's choice:** Markdown file `08-STACKING-AUDIT.md` in phase dir.

### Q2 — Timing

| Option | Description | Selected |
|--------|-------------|----------|
| Produce audit during planning, commit before code (Recommended) | First commit of the phase | ✓ |
| Iteratively during execution | Less rigorous | |
| Post-implementation verification only | Weakest interpretation | |

**User's choice:** Produce audit during planning, commit before code changes.

---

## Done check

**User's choice:** I'm ready for context.
**Notes:** STICKY-04 (fullscreen preservation) is implicit — sticky lives inside WeekOverview scroll container; fullscreen only resizes the outer column.

---

## Claude's Discretion

- Exact legend DOM shape (`<div>` vs `<ul>` vs `<nav role="list">`)
- Legend height (~20-28px)
- Bg + backdrop-blur treatment (solid `bg-background` recommended for simplicity)
- Whether to extract a shared `<TutorLegend>` component
- Where `Z_INDEX` is imported (per-call-site explicit vs Tailwind plugin)
- Test coverage depth (Vitest on DOM vs visual-only)
- Commit cadence (atomic per concern recommended)
- Responsive narrow-panel behavior (compact-legend fallback only if verification shows truncation)

## Deferred Ideas

- STICKY-05 hover preview on legend chip (v1.2)
- STICKY-06 jump-to-next-session from legend chip (v1.2)
- Clickable legend chip in WeekOverview with popover (later)
- Scroll-triggered legend styling (rejected)
- Two sticky layers (rejected by consolidation)
- Drag-to-reorder chips (rejected)
- `view-transition-name` (Phase 10 concern)
- Mini-map consolidation (Phase 9 concern)
- Compact-legend responsive fallback (conditional, per verification)
- Extracting shared `<TutorLegend>` component (planner's discretion)
- CACHE_VERSION bump (explicitly NOT done in Phase 8)
