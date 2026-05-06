# Phase 09 Density Design Review

## Options Compared

- Shape A - aggregate day-bar: Rejected because it hides which tutor is busy, which makes it a poor fit for the compare panel's 1-3 selected tutor workflow.
- Shape B - per-tutor stacked density rows: Chosen per D-01 and D-04 because it is the best fit for 1-3 tutor comparison, exposes per-tutor load differences, and accepts medium complexity for higher compare value.
- Shape C - heatmap: Rejected because it is overbuilt for a seven-day, max-three-tutor compare panel and would compete with the existing GCal-style calendar.

## Chosen Shape

Chosen shape: B - per-tutor stacked density rows.

Shape B keeps the density overview compare-specific: every selected tutor gets one compact row, Monday-Sunday stays visible, and admins can see load differences without decoding an aggregate. This follows D-01 and records the D-04 A/B/C rationale locally for Phase 09.

## Locked Boundaries

- Zero server work: no API endpoint, DB query, schema change, SearchIndex change, localStorage mechanism, chart dependency, or CACHE_VERSION bump.
- Visible-week only: Monday-Sunday from the loaded CompareResponse.
- No utilization percentage, shared-free-slot overlay, click-to-hour jump, or replacement calendar view.

These boundaries preserve D-15's client-side derivation rule, D-16's rejection of a separate density API for this phase, and D-17's no-cache-shape-change constraint.

## Decision Coverage

- D-01: Locked Shape B as per-tutor stacked density rows so compare users can inspect each selected tutor's load.
- D-04: Captured the A/B/C design review and documented why Shape A and Shape C are not used.
- D-15: Kept the overview as a client-side layer over existing compare data with no server, schema, SearchIndex, or API change.
- D-16: Superseded the earlier separate-density-API pitfall with visible-week memoized rendering.
- D-17: Confirmed no `CompareResponse`, `CompareTutor`, or cache-shape change is required, so no `CACHE_VERSION` bump belongs in this plan.
