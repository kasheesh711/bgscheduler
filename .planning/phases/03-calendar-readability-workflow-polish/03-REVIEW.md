---
phase: 03-calendar-readability-workflow-polish
depth: standard
status: issues-found
files_reviewed: 6
findings_count: 7
reviewed: 2026-04-17
reviewer: gsd-code-reviewer (standard depth)
---

## Summary

Reviewed the six source files changed during phase 03. The phase-declared threats (T-03-07 URL-param validation, T-03-11 keyboard-nav input guard) are both mitigated in `search-workspace.tsx`. The `setInterval` cleanups, AbortController-style race handling, and native `title` tooltips look sound, and the new "+" quick-add button has good a11y (aria-label + disabled + stopPropagation). **No blocking bugs, no security issues, and no regression risk** for the existing unit tests (all changes are client-render-only). Findings below are a mix of medium-severity React correctness concerns (effect-dep churn, stale-closure in `setInterval`, shape-only URL validation) and low-severity polish items.

## Findings

### Medium

**M1. URL-sync effect re-runs on every render due to full `compare` in deps — floods `history.replaceState`.**
File: `src/components/search/search-workspace.tsx:50-62`

The URL-sync `useEffect` lists `compare.compareTutors, compare.weekStart, compare` as dependencies. `useCompare()` returns a fresh object literal every render (not memoized — see `src/hooks/use-compare.ts:197-214`), so `compare` is a new reference every render. `window.history.replaceState` fires on every render, not only when the relevant slices change. T-03-09 accepts `replaceState` as cheap and the arguments are idempotent, so this is not a bug — but it defeats the deps check.

Fix: drop `compare` from the dep array (only `compare.compareTutors` and `compare.weekStart` are read). Same structural issue in the keyboard-nav effect (lines 65-81, deps `[compare]`): listener is removed and re-added every render. Functionally correct because each fresh closure captures the latest `weekStart`, but wasteful. Prefer `[compare.weekStart, compare.changeWeek]`.

**M2. Stale-closure risk in today-indicator `setInterval` across midnight.**
Files: `src/components/compare/week-overview.tsx:239-247`, `src/components/compare/calendar-grid.tsx:72-80`

`useEffect` only starts `setInterval` when `isCurrentWeek` is true. `isCurrentWeek = weekStart === getCurrentMonday()` is computed during render. If the user leaves the tab open from Sunday into Monday without external state change, the effect does not re-evaluate `isCurrentWeek` and the indicator freezes on the old day's column. Low impact (admins unlikely to leave the view open over midnight) but worth logging.

Fix: have the tick call `getCurrentMonday()` itself and bail inside the handler, or derive day-of-week inside the tick.

**M3. `?week=` URL param is regex-validated but not semantically validated — accepts impossible dates.**
File: `src/components/search/search-workspace.tsx:41`

Regex `/^\d{4}-\d{2}-\d{2}$/` matches `2026-13-45` or `2026-02-31`. `changeWeek(weekParam)` does not re-validate; `shiftWeek()` parses via `new Date(y, m-1, d)` which silently normalizes (`2026-02-31` → `2026-03-03`). T-03-07 declares the threat *mitigated*; in practice the regex is shape-only. Not a security concern (server validates snapshotIds) but fail-open — a malicious bookmark could land the admin on an unexpected week.

Fix: after the regex check, confirm `new Date(weekParam).toISOString().slice(0,10) === weekParam` AND that the date is a Monday; else fall through to default current-Monday.

### Low

**L1. Today indicator uses raw `bg-red-500` instead of a semantic token.**
Files: `src/components/compare/week-overview.tsx:547,551`, `src/components/compare/calendar-grid.tsx:303,307`

Project conventions (CLAUDE.md) prescribe semantic color tokens (`bg-conflict`, `bg-available`). Today-indicator line uses `bg-red-500`. Plan 01 decided to use a literal class "matching GCal convention" — decision-consistent, but introduces a second meaning for red alongside `bg-conflict`. If the dark-mode palette or conflict color ever shifts, the today line won't follow.

Fix: add a `--today` token in globals.css and use `bg-today` for future-proofing, or comment the decision inline.

**L2. Duplicate `multiTutorLayout &&` guard inside already-guarded sticky header.**
File: `src/components/compare/week-overview.tsx:295-327`

Sticky lane header block is wrapped in `{multiTutorLayout && (…)}` at line 295. Line 307 re-checks `{multiTutorLayout && tutors.map(…)}`. Inner check is always true inside outer guard.

Fix: drop the inner `multiTutorLayout &&`.

**L3. `onAddSingle={compare.addTutor}` passes a non-stable function reference.**
Files: `src/components/search/search-workspace.tsx:136`, `src/hooks/use-compare.ts:173`

`addTutor` is defined inside `useCompare` without `useCallback`, so it is a new reference every render. `AvailabilityGrid` accepts it without memoization; no bug today because `AvailabilityGrid` is not `React.memo`'d. Flagging for consistency with `fetchCompare` which *is* `useCallback`-wrapped.

Fix: wrap `addTutor`, `removeTutor`, `changeWeek` in `useCallback` for symmetry.

**L4. Mount-effect passes `weekParam ?? compare.weekStart` — fragile if stale value is stale.**
File: `src/components/search/search-workspace.tsx:38-47`

On mount, when both `?week=` and `?tutors=` are present, code calls `changeWeek(weekParam)` first, then `fetchCompare(tutorIds, weekParam ?? compare.weekStart)`. `compare.weekStart` here is the stale initial value from `useState(getCurrentMonday)`, not the value set by the preceding `changeWeek`. Safe today because `weekParam` is used on both sides of `??`, but fragile.

Fix: compute `const targetWeek = (weekParam && valid) ? weekParam : compare.weekStart;` once and reuse.

## Threat Verification

- **T-03-07** (regex-validate `?week=`): Present at `search-workspace.tsx:41`. Mitigation is real but shape-only — see M3.
- **T-03-11** (ArrowLeft/Right input guard): Present at `search-workspace.tsx:68-70` — checks `HTMLInputElement`, `HTMLTextAreaElement`, `target.isContentEditable`. Matches declared mitigation exactly.

## Clean Areas

- All 6 files correctly declare `"use client"`.
- `setInterval` cleanups (`clearInterval` in effect return) present in both `week-overview.tsx` and `calendar-grid.tsx`.
- AbortController / fetch lifecycle and the 800ms flash timer use `window.setTimeout` with functional-updater pattern — no stale-state clobber.
- No `innerHTML`, `dangerouslySetInnerHTML`, `eval`, or hardcoded secrets in any changed file.
- Icon-only buttons (fullscreen toggle, `+`, `X` remove) all carry `aria-label` + `title`.
- No `key` prop issues.
- Conflict badge styling uses `bg-conflict text-white` — semantic token applied consistently across WeekOverview header and ComparePanel day tabs.

## Files Reviewed

- src/components/compare/week-overview.tsx
- src/components/compare/calendar-grid.tsx
- src/components/compare/compare-panel.tsx
- src/components/search/availability-grid.tsx
- src/components/search/search-results.tsx
- src/components/search/search-workspace.tsx
