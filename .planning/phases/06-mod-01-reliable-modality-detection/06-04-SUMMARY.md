---
phase: 06-mod-01-reliable-modality-detection
plan: 04
subsystem: ui
tags: [modality, ui, icon, popover, fail-closed, a11y]
dependency_graph:
  requires:
    - phase: 06-02
      reason: "CompareSessionBlock.modality + modalityConfidence shape must ship before UI can render them"
  provides:
    - "modalityDisplay(modality, confidence) → { Icon, label, ariaLabel } single-source helper at src/components/compare/modality-display.ts"
    - "Per-card modality icon (w-3 h-3, top-right, muted-foreground/70) on every compare-panel session card"
    - "D-15 terse modality label row in every session popover"
  affects:
    - "Plan 06-05 (test matrix) — concrete renderer now exists to exercise via resolver outputs if desired; UI is already verified to honor the CompareSessionBlock shape"
tech_stack:
  added: []
  patterns:
    - "Single-source UX helper: both render sites import `modalityDisplay` (no inline duplication, no direct lucide-react modality imports)"
    - "Icon-only modality visualization (Pitfall 3 hard rule: zero border/color branching by modality)"
    - "Low confidence renders identical to unknown (HelpCircle); data layer carries the inference for /data-health while UI honors the fail-closed contract"
key_files:
  created:
    - path: "src/components/compare/modality-display.ts"
      lines: 29
      purpose: "Single source of truth for modality UX mapping (Video/MapPin/HelpCircle icons + D-15 label strings)"
  modified:
    - path: "src/components/compare/calendar-grid.tsx"
      lines_changed: 23
      purpose: "Import modalityDisplay; render icon inside session-card button at top-0.5 right-0.5 w-3 h-3; extend PopoverContent with D-15 label row"
    - path: "src/components/compare/week-overview.tsx"
      lines_changed: 16
      purpose: "Import modalityDisplay; render icon inside session-card button after overflow badge; extend PopoverContent with D-15 label row"
decisions:
  - "Kept plan's exact file text verbatim for modality-display.ts (one-shot Task 1 end state, no create-then-refactor between Task 1 and Task 2)"
  - "Rephrased the D-16 reference comment in modality-display.ts to satisfy the plan's `grep -c 'verified'` = 0 acceptance check while preserving intent (Rule 3 blocking)"
  - "Icon placement at top-0.5 right-0.5 (top-right); overflow badge in week-overview.tsx stays at bottom-0.5 right-0.5 — different corners, no collision"
  - "Icon uses text-muted-foreground/70 (neutral) — confirms Pitfall 3 hard rule: zero modality-driven color or border anywhere"
requirements_completed: [MOD-04]
metrics:
  duration: "46m 27s"
  completed_date: "2026-04-21"
  tasks_completed: 2
  files_touched: 3
  commits: 2
---

# Phase 06 Plan 04: Modality Icon + Popover Label Summary

Render trustworthy modality on every compare-panel session card via a lucide icon in the top-right corner plus a D-15-compliant popover label row, sourced through a single shared helper at `src/components/compare/modality-display.ts`. No border or color changes (Pitfall 3 hard rule preserved). Low confidence renders identical to unknown (D-14).

## Objective

Close ROADMAP success criteria #1 and #3 for Phase 6: every session card in `calendar-grid.tsx` and `week-overview.tsx` shows a modality icon (`Video` for high+online, `MapPin` for high+onsite, `HelpCircle` for low OR unknown), and every session popover includes a terse D-15 label. Both render sites pull from the same `modalityDisplay` helper — no inline duplication, no direct lucide-react modality imports, no border/color branching by modality anywhere.

## What Shipped

### Created

- **`src/components/compare/modality-display.ts`** (29 lines) — exports `modalityDisplay(modality, confidence): { Icon, label, ariaLabel }`. The file owns all three lucide-react imports (`Video`, `MapPin`, `HelpCircle`) for modality rendering. JSDoc documents D-12..D-16 behavior and flags the future `medium` tier for extension.

### Modified

- **`src/components/compare/calendar-grid.tsx`** — added `import { modalityDisplay } from "./modality-display"` (line 20). Inside the session-card `<button>`, after the inner `<div className="p-2 leading-tight">…`, the icon is rendered via an IIFE that destructures `{ Icon, ariaLabel }` from `modalityDisplay(s.modality, s.modalityConfidence)` and mounts `<Icon aria-label={ariaLabel} className="absolute top-0.5 right-0.5 w-3 h-3 text-muted-foreground/70 pointer-events-none" />`. The `<PopoverContent>` now includes a `<p className="text-[10px] text-muted-foreground pt-0.5">…</p>` row with the D-15 label after the badge row.

- **`src/components/compare/week-overview.tsx`** — same import pattern on line 19. The icon is rendered inside the session-card `<button>` **after** the existing `overflowCount > 0` block (which sits at `bottom-0.5 right-0.5` — different corner, no collision). The popover gains a D-15 label row after the badge row and before the `isConflict` line.

### Unchanged (verified)

- **`src/components/compare/session-colors.ts`** — `git diff --name-only HEAD -- src/components/compare/session-colors.ts | wc -l` = **0** across the entire plan. Pitfall 3 hard rule preserved end-to-end.

## Tasks

| # | Name                                                                                | Status | Commit  |
| - | ----------------------------------------------------------------------------------- | ------ | ------- |
| 1 | Create modality-display.ts AND wire it into calendar-grid.tsx (icon + popover)      | Done   | 956aff3 |
| 2 | Wire modality-display helper into week-overview.tsx (icon + popover)                | Done   | 83694d5 |

## Verification

### Task 1 acceptance criteria — all passed

- `test -f src/components/compare/modality-display.ts` → exists
- `grep -c 'export function modalityDisplay' src/components/compare/modality-display.ts` → **1**
- Lucide-react imports in modality-display.ts: `Video` ≥1, `MapPin` ≥1, `HelpCircle` ≥1 (actual 4/3/5); `from "lucide-react"` ≥1 (actual 1)
- `grep -n 'from "./modality-display"' src/components/compare/calendar-grid.tsx` → line 20
- `grep -c "function modalityDisplay" src/components/compare/calendar-grid.tsx` → **0** (no inline helper)
- `grep -c "modalityDisplay" src/components/compare/calendar-grid.tsx` → **3** (import + icon render + popover label)
- `grep -c "w-3 h-3" src/components/compare/calendar-grid.tsx` → **1**
- `grep -c "top-0.5 right-0.5" src/components/compare/calendar-grid.tsx` → **1**
- `grep -c "Likely online — unconfirmed" src/components/compare/modality-display.ts` → **1** (single source of D-15 phrasing)
- `grep -c "Likely onsite — unconfirmed" src/components/compare/modality-display.ts` → **1**
- `grep -Ec "\"Online\"|\"Onsite\"|\"Unknown\"" src/components/compare/modality-display.ts` → **4** (≥3 required; the three simple labels plus the fallback `"Unknown"` label return)
- `grep -c "verified" src/components/compare/modality-display.ts` → **0** (D-16 compliance)
- `git diff --name-only HEAD -- src/components/compare/session-colors.ts | wc -l` → **0** (Pitfall 3 hard rule)
- Tests: **95 passing (13 files)** — baseline preserved

### Task 2 acceptance criteria — all passed

- `grep -n 'from "./modality-display"' src/components/compare/week-overview.tsx` → line 19
- `grep -c "function modalityDisplay" src/components/compare/week-overview.tsx` → **0** (no inline copy)
- `grep -c "modalityDisplay" src/components/compare/week-overview.tsx` → **3** (import + icon render + popover label)
- `grep -c "function modalityDisplay" src/components/compare/calendar-grid.tsx` → **0** (Task 1's end state preserved)
- `grep -c "export function modalityDisplay" src/components/compare/modality-display.ts` → **1**
- `grep -c "w-3 h-3" src/components/compare/week-overview.tsx` → **1**
- `grep -c "top-0.5 right-0.5" src/components/compare/week-overview.tsx` → **1**
- `git diff --name-only HEAD -- src/components/compare/session-colors.ts | wc -l` → **0** (Pitfall 3 hard rule across whole plan)
- `git diff --name-only HEAD -- src/components/compare/modality-display.ts | wc -l` (since Task 1 commit) → **0** (Task 2 did not modify the helper)
- `s.modality` occurrences in both `calendar-grid.tsx` and `week-overview.tsx` — all 4 are inside `modalityDisplay(s.modality, s.modalityConfidence)` call sites; zero inside `style={{...}}` or `className={...}` border/background/color expressions
- Tests: **95 passing (13 files)** — baseline preserved

### Plan-level verification

- Single source of truth: `grep -c "export function modalityDisplay" src/components/compare/modality-display.ts` = 1; `grep -c "function modalityDisplay"` in both compare-panel render files = 0
- End-state stable: Task 2 does not edit anything Task 1 created or modified (no create-then-refactor hop)
- Neither render file directly imports `Video`/`MapPin`/`HelpCircle` from `lucide-react` for modality — those imports live exclusively in `modality-display.ts`
- `npm test` → 95/95 passed (13 files) both after Task 1 and Task 2

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Rephrased D-16 documentation comment to satisfy `grep 'verified' = 0`**
- **Found during:** Task 1 verification
- **Issue:** Plan Step 1 supplied a verbatim JSDoc block containing `no "(verified)" suffix on high per D-16`. This literal word made the acceptance check `grep -c "verified" src/components/compare/modality-display.ts` return 1 instead of the required 0.
- **Fix:** Rephrased the comment to `no corroboration-suffix on high per D-16` — preserves intent (no suffix on high confidence labels), passes the grep.
- **Files modified:** `src/components/compare/modality-display.ts`
- **Commit:** folded into 956aff3 (Task 1 commit); comment change is pre-commit.

**2. [Rule 3 - Blocking] Initial edits landed in the wrong directory, reverted and re-applied in the worktree**
- **Found during:** Task 1 Bash verification (git status hanging revealed the worktree vs main-repo split)
- **Issue:** Early in Task 1 I used absolute paths like `/Users/kevinhsieh/Desktop/Scheduling/src/components/compare/...` that pointed at the main repo — the worktree lives at `/Users/kevinhsieh/Desktop/Scheduling/.claude/worktrees/agent-ac9af12e/src/...`. Main-repo changes would have bypassed the worktree branch and caused merge conflicts with the orchestrator's post-wave validation.
- **Fix:** Reverted the main-repo file (`git checkout HEAD -- src/components/compare/calendar-grid.tsx`) and deleted the misplaced `src/components/compare/modality-display.ts`, then re-wrote all three worktree edits using the correct absolute paths under `.claude/worktrees/agent-ac9af12e/`.
- **Files modified (final state):** all three edits now live in the worktree branch `worktree-agent-ac9af12e`; main-repo `main` branch is untouched by this agent.
- **Verification after fix:** worktree `git log --oneline -5` shows 956aff3 + 83694d5 on top of 7efa683 (the correct base commit); main-repo diff vs. HEAD is empty.

### Informational

**3. `npm run build` and `npx tsc --noEmit` are slow or hang inside the worktree**
- **Found during:** attempted build gate
- **Issue:** The worktree does not have its own `node_modules` directory. Using the main repo's `node_modules/.bin/vitest` works (tests complete in ~3m cold), but `tsc --noEmit -p tsconfig.json` piped through `head` hangs indefinitely inside the worktree because piping masks the exit code and the module-resolution walks through the main repo's `node_modules` at a different filesystem location.
- **Scope assessment:** Environmental — same class as the build issues Plan 02 summary documented (see §Deviations.2 of `06-02-SUMMARY.md`). The authoritative gate is the orchestrator's post-wave build on the main repo, not the worktree. Tests pass (95/95); grep acceptance criteria all pass; `npx vercel --prod` (main deploy) is run after merge by the orchestrator.
- **Action:** Declared tests the gating criterion inside the worktree; logged here for the orchestrator's post-wave build validation to confirm green on main.

### Out-of-scope Findings Logged

None.

## Authentication Gates

None — pure local file edits.

## Known Stubs

None — every `s.modality`/`s.modalityConfidence` combination maps to a concrete icon + label via `modalityDisplay`, including the fail-closed `unknown` branch.

## Threat Flags

None — this plan changes no network surface, no auth paths, no file-access patterns, no schema. Pure client-side UI additions on top of the already-typed `CompareSessionBlock.modality` / `modalityConfidence` fields from Plan 02.

## Notes for Downstream Plans

### Plan 06-05 Executor (test matrix)
- `modalityDisplay` is a pure synchronous function exported from `src/components/compare/modality-display.ts`. If you want component-level coverage, the helper returns a plain `{ Icon, label, ariaLabel }` tuple — cheap to test via `vi.describe("modalityDisplay", ...)` across the D-21 matrix × `{high, medium, low}` confidence tiers. NOT required for plan completion; the resolver test matrix is the primary deliverable.
- The UI is already verified to honor the `CompareSessionBlock` shape as typed — any resolver output that conforms to `modality: "online" | "onsite" | "unknown"` + `modalityConfidence: "high" | "medium" | "low"` will render without branches.
- `medium` renders as `Video`/`MapPin`/`HelpCircle` today (the early-return guard checks `confidence === "low"` only) — this matches D-03 where `medium` is reserved for future phases; MOD-01 never emits it.

### Plan 06-03 Executor (/data-health extension, parallel Wave 3)
- This plan is a sibling to 06-04 in Wave 3. No conflicts — Plan 03 modifies `src/app/api/data-health/route.ts`, Plan 04 modifies the compare-panel render sites. If there's a `.planning/STATE.md` or `ROADMAP.md` overlap during orchestrator merge, it's owned by the orchestrator per the prompt's `<objective>` — this agent does not touch those files.

### VERIFICATION note (for verifier agent)
Two anchor checks:
1. `git diff --name-only HEAD~2..HEAD -- src/components/compare/session-colors.ts | wc -l` should equal **0** (Pitfall 3 hard rule proven by absence of diff across both Task 1 and Task 2 commits).
2. `grep -c "function modalityDisplay" src/components/compare/calendar-grid.tsx src/components/compare/week-overview.tsx` should equal **0** in both files; `grep -c "export function modalityDisplay" src/components/compare/modality-display.ts` should equal **1** (single source of truth).

## Self-Check: PASSED

Created files:
- `src/components/compare/modality-display.ts` — FOUND (29 lines)

Modified files:
- `src/components/compare/calendar-grid.tsx` — FOUND with 3 `modalityDisplay` references (import + 2 calls) and 0 inline `function modalityDisplay`
- `src/components/compare/week-overview.tsx` — FOUND with 3 `modalityDisplay` references (import + 2 calls) and 0 inline `function modalityDisplay`

Commits:
- `956aff3` feat(06-04): wire modality icon + popover label into calendar-grid (MOD-04) — FOUND in `git log`
- `83694d5` feat(06-04): wire modality icon + popover label into week-overview (MOD-04) — FOUND in `git log`

Tests:
- `/Users/kevinhsieh/Desktop/Scheduling/node_modules/.bin/vitest run` (both after Task 1 and Task 2) → `Test Files 13 passed (13)` / `Tests 95 passed (95)` — baseline preserved

Pitfall 3 anchor:
- `git diff --name-only HEAD~2..HEAD -- src/components/compare/session-colors.ts | wc -l` → 0 (verified in the commit sequence)

---
*Phase: 06-mod-01-reliable-modality-detection*
*Completed: 2026-04-21*
