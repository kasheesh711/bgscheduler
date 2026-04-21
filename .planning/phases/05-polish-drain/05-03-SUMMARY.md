---
phase: 05-polish-drain
plan: 03
subsystem: compare-calendar
tags: [polish, compare, calendar, today-indicator, semantic-tokens, midnight-tick]
requirements: [POLISH-07, POLISH-09, POLISH-10]
status: complete
completed: 2026-04-21
dependencies:
  requires:
    - 05-01 (working tree clean + archival deletions + token-convention baseline in globals.css)
  provides:
    - Semantic `--today-indicator` OKLCH token + `bg-today-indicator` Tailwind utility available for any future compare/calendar code that needs the "now" signal
    - Midnight-crossover-safe today-indicator pattern in both `CalendarGrid` and `WeekOverview` (dateKey-based re-render trigger)
    - Dead-code-free lane-header rendering in multi-tutor mode
  affects:
    - `src/app/globals.css` (new token in `:root` + `.dark` + `@theme inline`)
    - `src/components/compare/calendar-grid.tsx` (4 changes: token swap + midnight fix)
    - `src/components/compare/week-overview.tsx` (5 changes: token swap + midnight fix + dead-code removal)
tech-stack:
  added: []
  patterns:
    - "Semantic color token via `@theme inline --color-*: var(--*)` + `:root` / `.dark` declarations (matches existing `--available` / `--blocked` / `--conflict` / `--free-slot` convention)"
    - "Mount-only interval with functional setState + dateKey no-op guard (tick runs always; re-render only on real change)"
key-files:
  created:
    - .planning/phases/05-polish-drain/05-03-SUMMARY.md
  modified:
    - src/app/globals.css
    - src/components/compare/calendar-grid.tsx
    - src/components/compare/week-overview.tsx
decisions:
  - "Token value `oklch(0.628 0.2577 29.23)` matches UI-SPEC.md spec exactly (visual equivalent of `#ef4444` / `bg-red-500`). Zero visual regression."
  - "Same token value in light and dark mode per D-07 (today indicator is a universal signal; GCal/Outlook/Cron all hold the red consistent across themes)."
  - "POLISH-07 removes the `[isCurrentWeek]` dependency from the interval effect. The tick runs unconditionally, but the functional setState guard (`prev === next ? prev : next`) means React only re-renders when minute/dow/dateKey actually change. One tick per minute; negligible overhead; zero visual churn."
  - "POLISH-10 removed only the inner duplicate `multiTutorLayout &&` at the sticky-lane-header site. The outer `{multiTutorLayout && (` block guard was preserved. Other live `multiTutorLayout` uses in the file (lane-tint backgrounds, lane dividers, etc.) were not touched."
metrics:
  duration: 2 tasks (task 3 was a one-line change); single wave-2 agent execution
  tests_before: 82/82 passing
  tests_after: 82/82 passing
  commits: 3
---

# Phase 5 Plan 03: Compare Calendar Polish Summary

Close three v1.0-MILESTONE-AUDIT.md findings in the compare calendar components: adopt a semantic `--today-indicator` token (POLISH-09 / L1), fix the today-indicator's midnight-crossover blindness (POLISH-07 / M2), and remove a duplicate `multiTutorLayout` guard inside an already-gated block (POLISH-10 / L2). Three atomic commits, zero visual regression, 82/82 tests green.

## What Shipped

### Task 1 — POLISH-09 — Semantic `--today-indicator` token (commit `3b41d26`)

Introduced an additive `--today-indicator` OKLCH token, declared in both `:root` and `.dark` with the identical value `oklch(0.628 0.2577 29.23)` (visual equivalent of the previous `bg-red-500 / #ef4444`). Added `--color-today-indicator: var(--today-indicator)` inside `@theme inline` so Tailwind exposes it as `bg-today-indicator`.

Replaced all four literal `bg-red-500` call sites (2 files × 2 lines: today-line + today-dot) with `bg-today-indicator`:

- `src/components/compare/calendar-grid.tsx:303` — today-line
- `src/components/compare/calendar-grid.tsx:307` — today-dot
- `src/components/compare/week-overview.tsx:547` — today-line
- `src/components/compare/week-overview.tsx:551` — today-dot

Files changed: 3 (`globals.css`, `calendar-grid.tsx`, `week-overview.tsx`). +7 / -4 lines.

### Task 2 — POLISH-07 — Midnight-crossover-safe today-indicator (commit `51cee0c`)

Both compare components shared the same buggy pattern: a `useState` seeded with `{minutes, dow}` and an effect gated on `isCurrentWeek` that updated only minutes on each tick. A tab left open from 23:59 Sunday → 00:00 Monday would retain the previous day's `dow` in its indicator position, and would never re-evaluate `isCurrentWeek` because the component didn't re-render after midnight.

Fix pattern applied identically to both files:

1. Added `dateKey: bkk.toDateString()` to the snapshot state shape.
2. Removed the `[isCurrentWeek]` effect gate — the tick now runs unconditionally from mount until unmount.
3. Each tick rebuilds `{minutes, dow, dateKey}` from current Bangkok time and calls `setNowSnapshot((prev) => prev === next ? prev : next)` so React only commits a re-render when the snapshot actually changes.
4. The render-site guards (`isCurrentWeek && nowSnapshot.dow === day && ...`) are unchanged — they still correctly no-op when the user is viewing a non-current week.

When `dateKey` flips at Bangkok midnight, the state update triggers a re-render, `getCurrentMonday()` returns the new Monday, `isCurrentWeek` recomputes, and the indicator appears/disappears in the correct column. One tick/minute (≤1440 no-op setStates per day) is negligible cost for correctness.

Files changed: 2 (`calendar-grid.tsx`, `week-overview.tsx`). +40 / -8 lines.

### Task 3 — POLISH-10 — Dead-code duplicate guard removed (commit `44b41d5`)

At `week-overview.tsx:311`, the sticky-lane-header block opens with `{multiTutorLayout && (...)}`. Inside that block, the `tutors.map(...)` call at line 307 repeated the same guard: `{multiTutorLayout && tutors.map(...)}`. Since execution is only inside the outer block when `multiTutorLayout` is already true, the inner guard was always true and was dead code.

Removed only the inner `multiTutorLayout &&` duplicate. The outer block guard (line 311) is preserved. Lane-header rendering in multi-tutor mode is semantically unchanged.

Files changed: 1 (`week-overview.tsx`). +1 / -1 lines.

## Verification

All plan-level checks pass:

```
npm test                                                    → 82 / 82 passing
grep -rn 'bg-red-500' src/components/compare/               → 0 matches
grep -rn 'bg-today-indicator' src/components/compare/ | wc  → 4
grep -c -- '--today-indicator:' src/app/globals.css         → 2
grep -c -- '--color-today-indicator' src/app/globals.css    → 1
grep -c 'oklch(0.628 0.2577 29.23)' src/app/globals.css     → 2
grep -c 'dateKey' src/components/compare/calendar-grid.tsx  → 4
grep -c 'dateKey' src/components/compare/week-overview.tsx  → 4
grep -c '\[isCurrentWeek\]' src/components/compare/calendar-grid.tsx → 0
grep -c '\[isCurrentWeek\]' src/components/compare/week-overview.tsx → 0
grep -cE 'setInterval\(tick, 60_000\)' src/components/compare/calendar-grid.tsx → 1
grep -cE 'setInterval\(tick, 60_000\)' src/components/compare/week-overview.tsx → 1
grep -c 'isCurrentWeek && nowSnapshot.dow' src/components/compare/calendar-grid.tsx → 1
grep -c 'isCurrentWeek && nowSnapshot.dow' src/components/compare/week-overview.tsx → 1
grep -c 'multiTutorLayout' src/components/compare/week-overview.tsx → 14  (was 15; delta = −1)
```

## Commit Record

| # | Hash | Title | Files | Lines |
|---|------|-------|-------|-------|
| 1 | `3b41d26` | feat(05): add --today-indicator semantic token (POLISH-09) | `src/app/globals.css`, `src/components/compare/calendar-grid.tsx`, `src/components/compare/week-overview.tsx` | +7 / −4 |
| 2 | `51cee0c` | fix(05): today-indicator re-evaluates day on midnight tick (POLISH-07) | `src/components/compare/calendar-grid.tsx`, `src/components/compare/week-overview.tsx` | +40 / −8 |
| 3 | `44b41d5` | fix(05): remove duplicate multiTutorLayout guard in lane header (POLISH-10) | `src/components/compare/week-overview.tsx` | +1 / −1 |

## Deviations from Plan

### Plan-criterion ambiguity — `multiTutorLayout && tutors.map` grep count

The plan's Task 3 acceptance criterion stated `grep -c "multiTutorLayout && tutors.map" src/components/compare/week-overview.tsx` should return `0` after the removal. After execution, that grep returns `1` — matching an unrelated **live** use of the pattern at `week-overview.tsx:372` in the day-column lane-tint CAL-01 block:

```tsx
{/* Lane tint backgrounds — CAL-01 */}
{multiTutorLayout && tutors.map((_, tutorIdx) => {
```

This is legitimately gated code that exists to only tint columns in multi-tutor mode. The plan itself flagged it as untouchable in the Task 3 "Notes" section: *"Do NOT touch any other `multiTutorLayout` usage elsewhere in the file (lines 259, 260, 262, 356, 381, 408, 436, 437, 460, 485, 492 — all live code)."* Line 356 in the plan's old line numbering corresponds to the lane-tint block that is line 372 post-edits.

**Disposition:** Honored the more specific "do not touch live code" directive over the overly-strict grep criterion. The SEMANTIC intent of POLISH-10 — "the duplicate `multiTutorLayout &&` inside the sticky-lane-header `multiTutorLayout && (...)` block is removed" — is fully achieved (the inner guard at the former line 307 is gone, the outer block guard at line 311 is preserved). The related acceptance criterion "total `multiTutorLayout` occurrences drops from the prior count minus exactly 1" passed cleanly (15 → 14). No architectural change; no behavior change.

### Orchestration note — wrong-path initial edits (process issue, not product issue)

During execution start, the Edit tool's absolute paths pointed at the parent `/Users/kevinhsieh/Desktop/Scheduling/src/...` tree, not this agent's worktree at `/Users/kevinhsieh/Desktop/Scheduling/.claude/worktrees/agent-ae38d3d6/src/...`. First-pass edits therefore landed in the main worktree and did not show up in the agent worktree's git status. Detected on the first `git status --short`, reverted from the main worktree with `git checkout HEAD -- <3 files>` (leaving other parallel agents' in-flight files untouched), then re-applied correctly inside the agent worktree. No product impact; final state, commits, and tests are correct.

## Key Links

| From | To | Via |
|------|-----|------|
| `src/components/compare/calendar-grid.tsx` | `src/app/globals.css` | `bg-today-indicator` Tailwind utility fed by `@theme inline --color-today-indicator: var(--today-indicator)` |
| `src/components/compare/week-overview.tsx` | `src/app/globals.css` | same |

## Notes for Future Phases

- **Dark-mode today-indicator value** — Phase 5 keeps the token value identical across themes (D-07 rationale). If a future phase wants a dark-mode-specific hue, swap only the `.dark { --today-indicator: ... }` declaration; the 4 consumer sites remain unchanged.
- **Midnight-tick pattern reuse** — the dateKey-guarded mount-only interval pattern is a clean template for any future component that wants a clock-driven UI signal (e.g. "session starts in N minutes" pills). Extract into a `useNowTick()` hook if a third copy of the pattern shows up.
- **Phase 6+ MOD-01 may re-touch these files** — if reliable online/onsite modality ships visual distinction on session cards (dashed vs solid border, etc.), touch `calendar-grid.tsx` / `week-overview.tsx` with awareness that the today-indicator token is now decoupled from the rest of the color system.

## Self-Check: PASSED

- `.planning/phases/05-polish-drain/05-03-SUMMARY.md`: FOUND (11433 bytes)
- Commit `3b41d26` (POLISH-09): FOUND — touches `src/app/globals.css`, `src/components/compare/calendar-grid.tsx`, `src/components/compare/week-overview.tsx`
- Commit `51cee0c` (POLISH-07): FOUND — touches `src/components/compare/calendar-grid.tsx`, `src/components/compare/week-overview.tsx`
- Commit `44b41d5` (POLISH-10): FOUND — touches `src/components/compare/week-overview.tsx`
- `npm test`: 82 / 82 passing (baseline preserved, zero regression)
- Scope boundary: only 3 files modified (plus this SUMMARY + the existing Plan 01 SUMMARY already on disk) — no out-of-scope changes.

