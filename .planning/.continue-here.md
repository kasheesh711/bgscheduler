---
context: default
milestone: v1.1 (not-yet-defined)
phase: none
task: n/a
total_tasks: n/a
status: shipped
last_updated: 2026-04-20T09:35:56.415Z
---

<current_state>
Shipped a design-deck adaptation to production OUTSIDE the GSD phase workflow. The /gsd-new-milestone v1.1 setup was interrupted mid-flow (before REQUIREMENTS.md / ROADMAP.md were written) when the user pivoted to "implement this design deck."

Production commit: `9e3e4ad` on main. Live at https://bgscheduler.vercel.app. Feature branch `feat/recommended-slots` was merged and deleted locally (never pushed to origin).

**What shipped (single commit, 5 files, +632/-7):**
- `src/lib/search/recommend.ts` (new) — ranks sub-slots by qualified-tutor count, tags top 3 as Best/Strong/Good fit
- `src/components/search/recommended-slots.tsx` (new) — 3-card hero above the availability grid; avatar stack, checkmark reasons, "Copy for parent" button, multi-select → "Bundle & copy"
- `src/components/search/copy-for-parent-drawer.tsx` (new) — slide-in right drawer with Friendly/Terse tone toggle, tutor-names toggle, editable textarea, clipboard copy
- `src/components/search/search-form.tsx` (modified) — defaults shifted from 09:00-17:00/60min to 15:00-20:00/90min (tutor working window); explicit "Any subject/curriculum/level" labels; "N filters active · Clear all" line
- `src/components/search/search-workspace.tsx` (modified) — mounts RecommendedSlots above SearchResults when a response exists; hosts the drawer

**What was explicitly NOT adopted from the design deck (per user):**
- Density view on the calendar (caused student-data overlap issues — user disliked)
- Unified pill-based QueryBar (user prefers dropdowns for idiot-proofing)

**Preview URL (still live, informational):** https://bgscheduler-qksueaj3y-kevins-projects-6ebb4efc.vercel.app
**Production URL:** https://bgscheduler.vercel.app (aliased to `bgscheduler-lbctueew8-...`)
**Inspect:** https://vercel.com/kevins-projects-6ebb4efc/bgscheduler/D5VqP6uN3H7m8hyAoGgtqndKxLra
</current_state>

<completed_work>

- Fetched + read design deck files at `/Users/kevinhsieh/Downloads/BeGifted Scheduling/` (App, QueryBar, Results, Calendar, CopyDrawer, Data, Primitives, Tweaks .jsx)
- Explored current codebase: `src/components/search/`, `src/app/(app)/search/`, `src/lib/search/`
- Built ranking helper `src/lib/search/recommend.ts` with 3-tier confidence bands
- Built `RecommendedSlots` component (3-card hero, bundle-multiple flow)
- Built `CopyForParentDrawer` component (tone toggle, editable preview, clipboard)
- Refined `SearchForm` defaults + added filter-count indicator + Clear-all
- Wired both into `SearchWorkspace`
- Ran typecheck + 246/246 tests (passed)
- Branched `feat/recommended-slots`, committed `9e3e4ad`
- Preview deploy via `npx vercel` (not --prod)
- Re-verified tests, fast-forwarded main, pushed to `github.com/kasheesh711/bgscheduler`
- Deleted local feature branch
- Deployed production via `npx vercel --prod --yes`
- Smoke-tested production endpoint (307 redirect to /login = expected)
</completed_work>

<remaining_work>

1. **Human UAT** — sign in to bgscheduler.vercel.app, run default search, confirm the 3 recommended-slot cards render, open the copy-for-parent drawer, test clipboard, verify calendar grid is unchanged from v1.0
2. **Milestone framing** — decide whether to retroactively treat this ship as a v1.1 micro-milestone (update MILESTONES.md, bump PROJECT.md) or fold it into the larger v1.1 cycle that was being scoped before the pivot
3. **Documentation** — update PROJECT.md "Current State" section (mentions v1.0 only), AGENTS.md "What Is Built" section, and possibly add a memory for the "dropdowns over pills" preference
4. **Working-tree cleanup** — delete the orphan `route 2.ts` duplicates and decide what to do with `.planning/debug/`, `.planning/phases/04-ui-audit-polish/04-CONTEXT.md`, `.planning/phases/FULL-APP-UI-REVIEW.md`, `.planning/ui-reviews/` (all pre-existed and are unrelated to this ship)
</remaining_work>

<decisions_made>

- **Derive recommended slots client-side from existing `RangeSearchResponse`** — avoids any backend or API changes; keeps blast radius small and fully reversible
- **Keep GCal calendar grid unchanged** — user asked to preserve current design principles; the deck's density view (where free time is the figure and busy blocks are muted ground) caused overlap issues
- **Keep dropdown-based search** — user prefers dropdowns to the deck's pill-based unified query bar for idiot-proofing; just changed defaults + added clarity polish
- **Default window 15:00–20:00 / 90min** — matches the tutor working window so admin staff don't need to know it; reflects the deck's `WORKING_START=15, WORKING_END=20` constants
- **Direct push to main (no PR)** — user choice; repo has no CI or branch protection rules
- **Manual `npx vercel --prod` (not preview-promote)** — user choice; matches the documented AGENTS.md flow
</decisions_made>

<blockers>
None. Feature is shipped and live.
</blockers>

## Required Reading (in order)

1. `/Users/kevinhsieh/Downloads/BeGifted Scheduling/` — source design deck (app.jsx, query-bar.jsx, results.jsx, calendar.jsx, copy-drawer.jsx, data.jsx, primitives.jsx, tweaks.jsx)
2. `.planning/PROJECT.md` — current project state (still reflects v1.0; needs update)
3. `src/lib/search/recommend.ts` — new ranking helper (understand before extending)
4. `src/components/search/recommended-slots.tsx` — hero component
5. `src/components/search/copy-for-parent-drawer.tsx` — drawer component

## Critical Anti-Patterns (do NOT repeat these)

| Pattern | Description | Severity | Prevention Mechanism |
|---------|-------------|----------|---------------------|
| `git checkout main -- .` inside a feature branch | Overwrites working tree with main's content, silently discarding uncommitted edits. Discovered when trying to compare typecheck output between branches — it reverted `search-form.tsx` and `search-workspace.tsx` to main's version. Commit history was untouched; restored via `git checkout HEAD -- <files>` + `git stash pop`. | advisory | To compare typecheck across branches, use `git worktree add` or check out a second clone — never `checkout main -- .` from inside another branch. |
| `tsc --noEmit \| tail -N && echo OK` | Hides the real tsc exit code since `tail` always exits 0. The `&&` reaches `echo OK` even on tsc failure. Initial run falsely reported clean typecheck. | advisory | Always run `tsc --noEmit` directly (or redirect stderr separately) and check `$?`. If piping, capture the error file and check it explicitly. |
| Pre-existing TS2306/TS7016 type-declaration errors | `vitest/dist/index.d.ts`, `tailwind-merge/dist/types.d.ts`, `next/navigation` etc. report "not a module". These are environmental/node_modules resolution quirks that pre-exist on main and do not block the Vercel production build. Tests still pass. | advisory | When typecheck reports these, verify they exist on main too (via `git checkout main -- .` in a worktree or a second clone) before assuming the feature branch introduced them. Don't let them block a deploy — rely on tests + the Vercel build as the authoritative gate. |

## Infrastructure State

- **Production**: https://bgscheduler.vercel.app live, serving `9e3e4ad`, aliased to `bgscheduler-lbctueew8-kevins-projects-6ebb4efc.vercel.app`
- **Preview** (superseded but not deleted): `bgscheduler-qksueaj3y-kevins-projects-6ebb4efc.vercel.app`
- **Rollback**: `npx vercel rollback` selects the pre-ship v1.0 deployment; near-instant, no code change required
- **Dev server**: stopped (was running at localhost:3000 earlier for verification)
- **Git**: on `main`; `feat/recommended-slots` deleted locally, was never pushed to origin
- **Daily Wise cron**: unchanged, still scheduled for 00:00 UTC
- **Env vars on Vercel**: no changes; all 9 production vars intact

<context>
This session began as `/gsd-new-milestone` for v1.1. User had just started discussing what to build next when they pivoted to "implement this design deck from ~/Downloads." Plan mode was entered for the production push and then exited after approval.

The deck was clearly high-fidelity (actual React/JSX files, not just screenshots) — I read the full deck, mapped its features to the existing codebase, and cherry-picked only what the user approved (recommended slots yes; density calendar no; pill query no).

Ranking heuristic for recommended slots: count fully-available qualified tutors per sub-slot, sort descending, tiebreak on earlier start, cap at 3. Confidence tiers are Best / Strong / Good by rank. Reasons built from: tutor count, mode coverage (online+onsite / online only / onsite only), variety bonus at 3+ tutors.

Copy-for-parent drawer builds the message from `searchContext` (subject + curriculum + level) + the slot's day label + formatted time range + optional tutor names. Friendly tone adds greeting/closing; terse just lists. Textarea is editable so admin can tweak before copying; a "Reset to generated" link restores the auto-text.

No backend changes were needed — everything runs off the existing `/api/search/range` response. The `fetchOnly`/cache behavior in `useCompare` and the `weekStart` handling in the compare panel were untouched.

Pre-existing working-tree clutter (`?? route 2.ts`, `.planning/debug/`, `.planning/ui-reviews/`, `M AGENTS.md`) was all observed at session start — not caused by this work. Chose not to address it here to keep the commit diff clean and focused on the feature.
</context>

<next_action>
**First thing on resume:** Sign in to https://bgscheduler.vercel.app and manually verify:
- 3 "Recommended slot" cards render after hitting Search with default filters
- Clicking "Copy for parent" opens a slide-in drawer on the right
- The drawer's Friendly/Terse tone toggle changes the message preview
- Clipboard copy works (paste into a message app)
- The calendar grid on the right looks identical to pre-v1.1 v1.0

If all green, choose between:
- `/gsd-new-milestone v1.1` to formally capture this + any further v1.1 work in a new roadmap (recommended — keeps planning hygiene)
- Just updating `PROJECT.md` + `AGENTS.md` inline if no more v1.1 work is planned

If any UAT item is broken, run `npx vercel rollback` and diagnose before attempting a fix-forward.
</next_action>
