---
gsd_state_version: 1.0
milestone: v1.1
milestone_name: Data Fidelity & Depth
status: defining_requirements
stopped_at: v1.1 scoped — awaiting requirements + roadmap
last_updated: "2026-04-20T10:00:00.000Z"
last_activity: 2026-04-20
progress:
  total_phases: 0
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-20 — milestone v1.1 Data Fidelity & Depth scoped)

**Core value:** Admin staff can find, compare, and schedule tutors instantly and independently
**Current focus:** v1.1 Data Fidelity & Depth — close data-truth gaps, ship visual polish, drain v1.0 polish backlog

## Current Position

Milestone: v1.1 Data Fidelity & Depth
Phase: Not started (defining requirements)
Plan: —
Status: Defining requirements
Last activity: 2026-04-20 — Milestone v1.1 started

## Last Completed Milestone

**v1.0 — Performance & UX Improvement** (shipped 2026-04-17)

- 4 phases, 11 plans, 24/24 requirements satisfied
- Integration check: 7/7 wiring points + 5/5 E2E flows PASS
- Audit status: `tech_debt` (no functional blockers; 13 accepted debt items rolled forward)
- Tag: `v1.0`
- Archive: `.planning/milestones/v1.0-*.md`

## Latest Ship

**v1.0.1 (out-of-band, 2026-04-20)** — commit `9e3e4ad`

- Recommended-slots hero + copy-for-parent drawer + idiot-proof search defaults
- 5 files changed, +632/-7; zero backend changes (client-side derivation from existing range response)
- Live at bgscheduler.vercel.app
- Shipped outside GSD phase workflow — acknowledged as a Key Decision in PROJECT.md
- UAT pending (will be covered by POLISH-15 in v1.1)

## v1.1 Scope Summary

**Goal:** Close data-truth gaps, ship v2 visual polish, drain v1.0 polish backlog.

**Features:**
- MOD-01 Reliable online/onsite detection (`isOnlineVariant` + sessionType, fail-closed)
- PAST-01 Past-day session visibility (Wise historical endpoint; fallback = snapshot-based DB storage)
- VPOL-01 View transitions
- VPOL-02 Sticky tutor legend
- VPOL-03 Density overview / mini-map (shape TBD)
- POLISH-01..16 (v1.0 polish backlog drain — QA, M/L findings, VERIFICATION.md, TutorSelector cleanup, UAT, recommend.test.ts)

**Deferred to v1.2:** AWRK-01 inline free-slot actions, AWRK-02 conflict resolution suggestions, AWRK-03 drag-to-select, recommended-slots telemetry, recurring-mode calendar date labels.

**Phase numbering:** Continues from Phase 4 (v1.0). v1.1 starts at Phase 5.

## Accumulated Context

### Decisions (recent)

Full log in PROJECT.md Key Decisions table. Milestone-scoping decisions from v1.1:

- Modality detection stays fail-closed (no admin override UI) — matches existing safety rules
- Past-day REQ has a fallback plan baked in (DB-snapshot storage) so Wise endpoint absence doesn't block the milestone
- VPOL-03 density-overview shape deferred to phase planning (3 candidate shapes: sidebar strip / month strip / floating widget)
- v1.1 bundles v1.0 polish/tech-debt so v1.2 starts with a clean backlog
- Advanced workflow (AWRK-*) deferred to v1.2 to keep v1.1 tight

### Pending Todos

- Orphan working-tree noise still untouched: duplicate `route 2.ts` files, `.planning/debug/`, `04-CONTEXT.md`, `FULL-APP-UI-REVIEW.md`, `.planning/ui-reviews/`
- Human UAT on production for v1.0.1 (now tracked as POLISH-15)

### Blockers/Concerns

None blocking. PAST-01 has dependency on Wise API surface (historical endpoint existence) — research phase or phase planning will confirm; fallback path already agreed.

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

Last session: 2026-04-20 — /gsd-new-milestone scoping v1.1 Data Fidelity & Depth
Stopped at: PROJECT.md + STATE.md updated; awaiting research decision + requirements + roadmap
Resume: Continue /gsd-new-milestone workflow (research decision → REQUIREMENTS.md → ROADMAP.md)
