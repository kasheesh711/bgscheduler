# Phase 9: VPOL-03 Density Overview - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md - this log preserves the alternatives considered.

**Date:** 2026-05-05
**Phase:** 09-vpol-03-density-overview
**Areas discussed:** Density shape, Placement, A11y/readability contract, Interaction scope

---

## Density Shape

| Option | Description | Selected |
|--------|-------------|----------|
| B: Per-tutor stacked rows | Best fit for compare: shows which tutor is busiest across Mon-Sun, uses existing tutor colors, medium complexity. | Yes |
| A: Aggregate day/time bar | Lower effort. Shows when the selected set is busy overall, but hides per-tutor imbalance. | |
| C: Single heatmap strip | Minimal footprint, but probably under-informs because it collapses all tutors into one intensity value. | |

**User's choice:** B: Per-tutor stacked rows
**Notes:** This locks the required A/B/C phase-local design decision. Rationale: compare-specific value is more important than lowest possible footprint.

---

## Placement

| Option | Description | Selected |
|--------|-------------|----------|
| Between day tabs and calendar body | Always visible before the grid, no sticky-stack risk, matches research architecture guidance. | Yes |
| Inside the sticky legend strip | More consolidated, but makes the sticky header taller and mixes identity with density. | |
| Above the week picker | Very visible, but separates density from the calendar it summarizes. | |

**User's choice:** Between day tabs and calendar body
**Notes:** Keeps Phase 8 sticky legend identity-only and avoids new sticky stacking complexity.

---

## A11y / Readability Contract

| Option | Description | Selected |
|--------|-------------|----------|
| Compact labels + aria summary | Each row shows tutor name plus booked hours; each day segment has an aria label/short title like "Mon: Kevin 3h booked, 2 sessions". Uses segment width/height plus color, no animation. | Yes |
| Visual only + region summary | The strip has one screen-reader summary for the whole week, but individual day segments are not keyboard-focusable. | |
| Keyboard grid | Each tutor/day cell is focusable with arrow-key navigation and detailed aria labels. | |

**User's choice:** Compact labels + aria summary
**Notes:** Density must not be color-only. Full roving keyboard-grid behavior is not required for v1.1.

---

## Interaction Scope

| Option | Description | Selected |
|--------|-------------|----------|
| Click row/day to open that day | Clicking a tutor/day density segment switches to the existing day drill-down for that day; no new scheduling actions. | Yes |
| Display-only | Density is purely informational; day tabs remain the only navigation. | |
| Richer stats | Add utilisation percentages and shared-free-slot markers now. More useful, but starts pulling in deferred DENS-06 territory. | |

**User's choice:** Click row/day to open that day
**Notes:** This is only navigation into the existing day view. Click-to-jump-to-hour and utilisation percentages remain deferred.

---

## the agent's Discretion

- Exact component name and DOM/SVG implementation.
- Exact density formula and zero-availability handling.
- Exact compact sizing, selected-day styling, hover/focus treatment, and test split.

## Deferred Ideas

- DENS-05 click-to-jump-to-hour.
- DENS-06 utilisation percentage summary.
- Shared-free-slot density overlay.
- Full-month / 180-day heatmap.
- Density as replacement calendar view.
- Chart libraries.
