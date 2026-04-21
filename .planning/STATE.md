---
gsd_state_version: 1.0
milestone: v1.1
milestone_name: Data Fidelity & Depth
status: planning
stopped_at: Phase 5 context gathered
last_updated: "2026-04-21T01:44:48.272Z"
last_activity: 2026-04-20 — ROADMAP.md v1.1 phases appended (Phases 5–10)
progress:
  total_phases: 6
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-20 — milestone v1.1 Data Fidelity & Depth scoped)

**Core value:** Admin staff can find, compare, and schedule tutors instantly and independently
**Current focus:** v1.1 Data Fidelity & Depth — Phases 5–10 planning

## Current Position

Milestone: v1.1 Data Fidelity & Depth
Phase: Phase 5 POLISH Drain (next)
Plan: —
Status: Planning — ROADMAP.md written, awaiting /gsd-plan-phase 5
Last activity: 2026-04-20 — ROADMAP.md v1.1 phases appended (Phases 5–10)

Progress: [░░░░░░░░░░] 0/6 phases (0%)

## Last Completed Milestone

**v1.0 — Performance & UX Improvement** (shipped 2026-04-17)

- 4 phases, 11 plans, 24/24 requirements satisfied
- Integration check: 7/7 wiring points + 5/5 E2E flows PASS
- Audit status: `tech_debt` (no functional blockers; 13 accepted debt items rolled forward — now tracked as POLISH-01..16 in v1.1)
- Tag: `v1.0`
- Archive: `.planning/milestones/v1.0-*.md`

## Latest Ship

**v1.0.1 (out-of-band, 2026-04-20)** — commit `9e3e4ad`

- Recommended-slots hero + copy-for-parent drawer + idiot-proof search defaults
- 5 files changed, +632/-7; zero backend changes (client-side derivation from existing range response)
- Live at bgscheduler.vercel.app
- Shipped outside GSD phase workflow — acknowledged as a Key Decision in PROJECT.md
- UAT pending (tracked as POLISH-15 in Phase 5)
- `recommend.test.ts` pending (tracked as POLISH-16 in Phase 5)

## v1.1 Scope Summary

**Goal:** Close data-truth gaps, ship v2 visual polish, drain v1.0 polish backlog.

**Phase structure (6 phases, 40 requirements):**

| Phase | Name | Requirements | Blocker / gating |
|-------|------|--------------|------------------|
| 5 | POLISH Drain | POLISH-01..16 (16) | FIRST — a11y baseline for VPOL-03; clears v1.0 debt before feature churn |
| 6 | MOD-01 Reliable Modality Detection | MOD-01..05 (5) | First shape-changing phase; introduces CACHE_VERSION constant; drives visual rules VPOL touches later |
| 7 | PAST-01 Past-Day Session Visibility | PAST-01..06 (6) | Data-layer only; parallel Wise historical endpoint spike (≤30 min, non-blocking) |
| 8 | VPOL-02 Sticky Tutor Legend | STICKY-01..04 (4) | Unlocks VPOL-03 layout; must precede VPOL-01 |
| 9 | VPOL-03 Density Overview | DENS-01..04 (4) | Blocked on Phase 5 POLISH-01..05 a11y baseline; shape decision deferred to phase planning |
| 10 | VPOL-01 View Transitions | TRANS-01..05 (5) | LAST — animates frozen baseline; highest cross-browser risk |

**Coverage:** 40/40 requirements mapped ✓

**Deferred to v1.2:** AWRK-01 inline free-slot actions, AWRK-02 conflict resolution suggestions, AWRK-03 drag-to-select, MOD-06/07, PAST-07/08, TRANS-06/07, STICKY-05/06, DENS-05/06, TELEM-01, RECURDATE-01.

**Phase numbering:** Continues from Phase 4 (v1.0). v1.1 occupies Phases 5–10.

## Performance Metrics

- Tests at v1.1 kickoff: 246 passing (82 pre-v1.0 baseline + 164 v1.0 additions); regression gate remains "all 246 continue passing"
- Sync duration: ~4m26s on current data (~34s margin below 300s Vercel function ceiling) — Phase 7 must not breach this budget
- Cold-start budget: SearchIndex build <2s warm; Phase 7 keeps past sessions OUT of the in-memory singleton to preserve this

## Accumulated Context

### Decisions (recent)

Full log in PROJECT.md Key Decisions table. Roadmap-scoping decisions from v1.1:

- **Phase 5 first (POLISH drain)** — prevents POLISH-scatter anti-pattern (pitfall 15); establishes a11y baseline required by Phase 9 VPOL-03
- **Phase 10 last (VPOL-01)** — animates a frozen visual baseline; lowest reversibility cost if pullback needed; highest cross-browser risk
- **Phase 8 before Phase 10** — sticky positioning is foundational; transitions animate a known-good sticky setup rather than a moving target
- **Phase 6 before Phase 8+** — modality confidence grading informs any future visual distinction (dashed vs solid borders) that VPOL phases might touch
- **Phase 7 data-layer only** — past-session storage doesn't enter the warm SearchIndex; queried per-request with dedicated `cacheTag('past-sessions')` to avoid daily-sync invalidation churn
- **VPOL-03 shape (A/B/C) deferred to Phase 9 planning** — user explicitly requested shape decision happen at phase-local design review, not roadmap time
- **MOD-01 and PAST-01 can swap order** (logically independent) — kept suggested 6→7 per research convergence; swappable if execution capacity demands
- **v1.0 polish bundled into v1.1 Phase 5** rather than scattered across feature phases — prevents tech-debt re-scatter across future milestones

### Pending Todos

- Orphan working-tree noise still untouched: duplicate `route 2.ts` files, `.planning/debug/`, `04-CONTEXT.md`, `FULL-APP-UI-REVIEW.md`, `.planning/ui-reviews/` (candidate for Phase 5 cleanup)
- Human UAT on production for v1.0.1 (tracked as POLISH-15 in Phase 5)
- `recommend.test.ts` authoring for v1.0.1 ranking logic (tracked as POLISH-16 in Phase 5)
- Wise historical-sessions endpoint spike to `devs@wiseapp.live` (tracked as PAST-06 in Phase 7, ≤30 min parallel task)

### Blockers/Concerns

None blocking roadmap execution.

**Advisory flags for phase planning:**

- Phase 6 (MOD-01): validate `WiseSession.type` presence rate in production data at phase kickoff — if <50%, MOD-01 reduces to "icon + Needs Review" without confident labels
- Phase 7 (PAST-01): Wise historical endpoint existence is unknown; DB-snapshot fallback ships unconditionally regardless of spike outcome
- Phase 9 (VPOL-03): shape A/B/C decision via phase-local design review + a11y strategy for density visualization; Phase 5 POLISH-01..05 sign-off is a prerequisite
- Phase 10 (VPOL-01): re-check Vercel/next.js #85693 resolution at phase start (in case `experimental.viewTransition` becomes viable); native API avoids the question either way

### Anti-patterns (advisory, preserved from v1.0.1 session)

- `git checkout main -- .` inside a feature branch silently reverts working-tree files that exist on main — use `git worktree add` or a second clone when comparing across branches
- `tsc --noEmit | tail -N && echo OK` hides tsc's exit code (tail always exits 0) — run tsc without piping, or check exit code separately
- Pre-existing TS2306/TS7016 type-decl errors on `vitest`, `tailwind-merge`, `next/navigation` — environmental, don't block Vercel build; tests + Vercel build are the authoritative gates

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 260416-jrb | Add tutor name search to left search panel | 2026-04-16 | 5816d55 | [260416-jrb-add-tutor-name-search-to-left-search-pan](./quick/260416-jrb-add-tutor-name-search-to-left-search-pan/) |
| 260416-klm | Polish tutor dropdown UX - idiot proof | 2026-04-16 | 5816d55 | [260416-klm-polish-tutor-dropdown-ux-make-it-idiot-p](./quick/260416-klm-polish-tutor-dropdown-ux-make-it-idiot-p/) |

## Session Continuity

Last session: 2026-04-21T01:44:48.268Z
Stopped at: Phase 5 context gathered
Resume: `/gsd-plan-phase 5` to begin Phase 5 POLISH Drain planning
