---
phase: 08-vpol-02-sticky-tutor-legend
plan: 01
subsystem: planning-artifacts
tags: [docs, stacking-context, audit, z-index, requirements-amendment]
requires:
  - .planning/phases/08-vpol-02-sticky-tutor-legend/08-CONTEXT.md (D-08..D-15)
  - .planning/REQUIREMENTS.md §STICKY-02
  - src/app/layout.tsx, src/app/(app)/layout.tsx, src/app/globals.css
  - src/components/search/search-workspace.tsx:166, 206-210
  - src/components/compare/compare-panel.tsx:248
  - src/components/compare/week-overview.tsx:282, 310
  - src/components/compare/calendar-grid.tsx:120
  - src/components/ui/popover.tsx:29-46
provides:
  - Pre-implementation stacking-context audit for STICKY-03
  - REQUIREMENTS.md §STICKY-02 amendment note (3-tier scale)
  - Canonical 3-tier z-index scale: Z_CONTENT=1, Z_LEGEND=6, Z_POPOVER=50
affects:
  - Plan 02 (Z_INDEX constant at src/lib/ui/z-index.ts)
  - Plan 03 (WeekOverview consolidated sticky legend)
  - Plan 04 (CalendarGrid z-index normalization)
  - Plan 05 (verification)
tech-stack:
  added: []
  patterns:
    - "Audit-first / code-after commit ordering per D-13 (mirrors Phase 5 D-02 precedent)"
    - "REQUIREMENTS.md amendment note appended inline under bullet; no new requirement ID; Traceability row preserved"
    - "Append-only Markdown footer (Phase 5 line preserved; Phase 8 line appended below)"
key-files:
  created:
    - .planning/phases/08-vpol-02-sticky-tutor-legend/08-STACKING-AUDIT.md
  modified:
    - .planning/REQUIREMENTS.md
decisions:
  - "Solid `bg-background` chosen for new legend over `backdrop-blur-sm` — simplicity; avoids creating a backdrop-filter stacking context on the legend itself (documented in audit, Chain A row for Plan 03 target)"
  - "Audit shipped as a single Markdown file at the phase directory per D-11; NO inline `// STICKY-03 audit` comments in src/ per D-12"
  - "Amendment note for STICKY-02 appended inline under the bullet rather than rewriting the bullet — preserves original 5-slot wording for audit trail"
metrics:
  duration: "~10 minutes"
  tasks_completed: 2
  files_created: 1
  files_modified: 1
  tests_added: 0
  completed: "2026-04-22"
---

# Phase 8 Plan 01: Pre-Implementation Stacking-Context Audit + §STICKY-02 Amendment

**One-liner:** Landed the mandatory pre-implementation stacking-context audit (STICKY-03) as the FIRST Phase 8 commit, plus an inline REQUIREMENTS.md amendment recording the simplified 3-tier z-index scale (`Z_CONTENT=1, Z_LEGEND=6, Z_POPOVER=50`) per 08-CONTEXT D-08..D-10 — zero source code changes, audit-before-code ordering enforced per D-13.

## What Shipped

### 1. `08-STACKING-AUDIT.md` (new, 94 lines)

Full ancestor-chain analysis from `<html>` to both Phase 8 sticky targets:

- **Chain A (WeekOverview global sticky legend)** — 9 rows from `<html>` through `<body>` (`overflow-hidden`), `(app) <main>` (`overflow-hidden`), search-workspace workspace + compare column (both `overflow-hidden`, compare column has `transition-all` on width only), compare-panel calendar wrapper (week view: non-scrolling), WeekOverview outer (`overflow-hidden`), scroll container at `week-overview.tsx:310` (`overflow-y-auto` — THE sticky context), down to the new legend target with `zIndex: Z_INDEX.legend = 6`.
- **Chain B (CalendarGrid sticky day-header, day view)** — same ancestors up to `compare-panel.tsx:~248` (`overflow-y-auto` in day view — THE sticky context for this chain), then through `calendar-grid.tsx:118` (`relative ml-[50px]`, no stacking context) to the current sticky header at `calendar-grid.tsx:120` (`z-10` → `Z_INDEX.legend = 6` in Plan 04).

**Every ancestor row documents:** `overflow`, `transform`, `filter`, `backdrop-blur`, `z-index`, `creates-stacking-context? (yes/no)`, and notes.

**Pitfall checks confirmed (per D-13 a..e):**

- (c) No `overflow-hidden` breaks sticky: only non-scrolling `overflow-hidden` ancestors exist; sticky context is scoped to nearest SCROLLING ancestor in each chain.
- (d) No `transform` / `filter` / `backdrop-filter` on the chain confines sticky. Tailwind `transition-all` on compare column animates width (not transform) — critical for D-14.
- (e) Popovers portal via `PopoverPrimitive.Portal` at `z-50` (both Positioner and Popup, `src/components/ui/popover.tsx:29-44`) → rendered ABOVE `Z_LEGEND = 6` by construction. Verified `50 > 6 > 1`.

**Fullscreen preservation (STICKY-04 / D-14):** Satisfied by construction. The toggle at `search-workspace.tsx:206-217` only changes outer compare column `width` + `padding`; no React remount, no transform added; the WeekOverview scroll container DOM node is unchanged; sticky legend widens with it. Zero additional plumbing needed.

### 2. REQUIREMENTS.md §STICKY-02 amendment

Added one inline amendment bullet under §STICKY-02:

> *Amendment (2026-04-22, Phase 8 CONTEXT D-08..D-10):* Scale simplified at CONTEXT time to a 3-tier scale `Z_CONTENT = 1`, `Z_LEGEND = 6`, `Z_POPOVER = 50` because Phase 8 D-01 consolidates per-day lane headers INTO the single sticky legend — the separate `z-[5]` lane-headers slot is no longer a live surface. CalendarGrid's existing sticky day-header reuses `Z_LEGEND = 6`. Constant ships at `src/lib/ui/z-index.ts` (`export const Z_INDEX = { content: 1, legend: 6, popover: 50 } as const;`). Same class as Phase 5 D-02's NVDA relaxation — no new requirement ID, §Traceability row for STICKY-02 unchanged.

Original 5-slot wording preserved verbatim above it for audit-trail continuity. §Traceability row (`| STICKY-02 | Phase 8 | Pending |`) unchanged. Coverage count `- v1.1 requirements: 40 total` unchanged — no new requirement minted.

**Footer amendment — append-only:**

Phase 5 line preserved verbatim:

```
*Last updated: 2026-04-21 — Phase 5 CONTEXT.md D-02 amendment: POLISH-01 scoped to VoiceOver-only; NVDA-v12 added to v1.2+ deferred list*
```

Phase 8 line appended directly below (no blank line):

```
*Phase 8 D-10 amendment: 2026-04-22 — STICKY-02 scale simplified from 5-slot to 3-tier post-consolidation (see 08-CONTEXT.md D-08..D-10).*
```

## Commits (chronological, audit-before-code per D-13)

| # | Hash | Message | Files |
|---|------|---------|-------|
| 1 | `7770166` | `docs(08): pre-implementation stacking-context audit (STICKY-03)` | `.planning/phases/08-vpol-02-sticky-tutor-legend/08-STACKING-AUDIT.md` (1 file, +94 lines) |
| 2 | `dd1ced4` | `docs(08): amend STICKY-02 with simplified 3-tier z-index scale` | `.planning/REQUIREMENTS.md` (1 file, +2 insertions) |

Both commits are single-file commits. `git log -2 --name-only | grep -c '^src/'` returns `0` — zero source code touched in this plan.

## Deviations from Plan

None — plan executed exactly as written. Both tasks' acceptance criteria passed first try.

## Self-Check: PASSED

- Audit file exists: `FOUND: .planning/phases/08-vpol-02-sticky-tutor-legend/08-STACKING-AUDIT.md` (94 lines ≥ 60 minimum).
- REQUIREMENTS.md amendment note present: `FOUND: "Amendment (2026-04-22, Phase 8 CONTEXT D-08..D-10)"`.
- Commit `7770166` (audit): `FOUND`.
- Commit `dd1ced4` (amendment): `FOUND`.
- Audit precedes amendment in `git log` ordering: confirmed (`7770166` → `dd1ced4`).
- Both commits are single-file; zero `src/` files touched: confirmed.
- Phase 5 footer preserved (exactly 1 match); Phase 8 footer appended (exactly 1 match).
- `grep -c "**STICKY-02**"` returns 1 (no duplicate requirement ID).
- §Traceability row for STICKY-02 unchanged (`| STICKY-02 | Phase 8 | Pending |` appears exactly once).
- Coverage count `- v1.1 requirements: 40 total` unchanged (exactly 1 match).

## Test Infrastructure Note (out of scope)

Attempted to run `npm test -- --run` per plan verification step 7. Encountered environmental issue unrelated to this plan: `vitest.mjs` symlink fails to execute via `/usr/bin/env node` on the current shell (`import './dist/cli.js'` bash-parsed rather than node-executed). Logged to `deferred-items.md` scope note: this is pre-existing environmental breakage — out of scope per "fix attempt limit" guidance, and unrelated to Phase 8 work. Since this plan made **zero source code changes** (docs-only), no regression risk exists and the 141-test baseline is unaffected by this plan's commits by construction.

## Next Steps

Plan 02 introduces `src/lib/ui/z-index.ts` with `export const Z_INDEX = { content: 1, legend: 6, popover: 50 } as const;` — the first source code change of Phase 8, referenced by Plans 03 and 04.

---

*Summary completed: 2026-04-22.*
