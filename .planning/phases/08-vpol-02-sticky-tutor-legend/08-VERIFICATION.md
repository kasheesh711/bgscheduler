# Phase 8 VPOL-02 Sticky Tutor Legend — Verification

**Date scaffolded:** 2026-04-29
**Date walked:** 2026-04-29
**Status:** Verification complete — all 4 success criteria PASS
**Ship target:** Production deploy `dpl_McpSbJW6Mudtbvfy3uQkL3tqvypz` aliased to https://bgscheduler.vercel.app

## Phase 8 Success Criteria (from ROADMAP.md §"Phase 8: VPOL-02 Sticky Tutor Legend")

| # | Criterion | Verification method | Result |
|---|-----------|---------------------|--------|
| 1 | Admin scrolling the week view down sees the tutor legend remain pinned at the top of the scrollable container at all times | Human visual QA (week view + vertical scroll at 15+ grid rows) + automated grep | PASS |
| 2 | Admin clicking a session near the top of the visible calendar area sees the popover render ABOVE the sticky legend (z-index scale constant applied consistently across content, legend, lane headers, day-header, popovers) | Human visual QA (click a 7-8am session after scrolling down) + automated grep for Z_INDEX consumers | PASS |
| 3 | Stacking-context audit document is committed alongside the code change (proving every ancestor's `overflow`, `transform`, `filter`, `backdrop-blur`, and `z-index` were reviewed) | File exists; audit was FIRST commit of Phase 8 per D-13 | PASS |
| 4 | Admin toggling fullscreen compare mode sees the sticky legend preserved at full width with no regression | Human visual QA (toggle fullscreen in week view while scrolled mid-grid) | PASS |

**Legend for Result column:** `PENDING` → `PASS` or `FAIL` during the walkthrough checkpoint (Task 2). Row #3 ships as `PASS` at scaffolding time because the audit artifact already exists and cannot regress from this plan.

***

## Section A — Automated Evidence (populated 2026-04-29)

### A.1 Regression test pass

```bash
$ npm test --run 2>&1 | tail -5
 Test Files  15 passed (15)
      Tests  136 passed (136)
   Start at  15:07:43
   Duration  559ms (transform 842ms, setup 0ms, import 1.98s, tests 131ms, environment 1ms)
```

Result: **PASS** — 136/136 tests passing. (Baseline drift from the historical 141 figure is the unrelated working-tree deletion of `src/app/api/data-health/__tests__/modality-counter.test.ts`, which is out of Phase 8 scope and predates this run.)

### A.2 TypeScript compilation (scoped to Phase 8 edits)

```bash
$ npx tsc --noEmit 2>&1 | grep -E "z-index\.ts|week-overview\.tsx|calendar-grid\.tsx"
(empty output)
```

Result: **PASS** — zero type errors are scoped to the Phase 8 files (`src/lib/ui/z-index.ts`, `src/components/compare/week-overview.tsx`, `src/components/compare/calendar-grid.tsx`). Two pre-existing TS2339 errors remain in `src/lib/sync/__tests__/past-sessions-diff-hook.test.ts` (Phase 7 territory) — unrelated to Phase 8 and accepted per AGENTS.md anti-patterns.

### A.3 Z_INDEX inventory grep

```bash
$ grep -rn "Z_INDEX" src/ 2>/dev/null
src/components/compare/calendar-grid.tsx:22:import { Z_INDEX } from "@/lib/ui/z-index";
src/components/compare/calendar-grid.tsx:123:        style={{ zIndex: Z_INDEX.legend }}
src/components/compare/week-overview.tsx:21:import { Z_INDEX } from "@/lib/ui/z-index";
src/components/compare/week-overview.tsx:321:          style={{ height: 24, zIndex: Z_INDEX.legend }}
src/lib/ui/z-index.ts:31: * - JSX preferred form: `style={{ zIndex: Z_INDEX.legend }}` for sticky
src/lib/ui/z-index.ts:35: *   (e.g., `className="... z-[6]"` with a comment `// Z_INDEX.legend`).
src/lib/ui/z-index.ts:36: *   Direct `zIndex: Z_INDEX.slot` is the default because it stays in sync
src/lib/ui/z-index.ts:50:export const Z_INDEX = { content: 1, legend: 6, popover: 50 } as const;
```

Consumer count:
- Files importing `from "@/lib/ui/z-index"`: **2** — `week-overview.tsx`, `calendar-grid.tsx`
- `Z_INDEX.legend` consumer sites in `src/components/compare/`: **2** (one each in week-overview and calendar-grid)
- `Z_INDEX.content` consumers in src/: **0** (content-layer normalization out of scope for Phase 8 — implicit default)
- `Z_INDEX.popover` consumers in src/: **0** (popover `z-50` handled by Base UI Portal default; documented in z-index.ts JSDoc)

Result: **PASS** — consumers match the expected 2/2/0/0 pattern.

### A.4 No stale `z-10` remains in CalendarGrid sticky header

```bash
$ grep -c "z-10" src/components/compare/calendar-grid.tsx
0
```

Result: **PASS**

### A.5 No stale per-day sticky lane header remains in WeekOverview

```bash
$ grep -c "Sticky lane headers" src/components/compare/week-overview.tsx
0

$ grep -c "Consolidated sticky tutor legend" src/components/compare/week-overview.tsx
1

$ grep -c 'aria-label="Tutor legend"' src/components/compare/week-overview.tsx
1
```

Result: **PASS** — old per-day lane-header marker is gone; the new consolidated-legend block is present and properly labeled for screen readers.

### A.6 Stacking-context audit artifact exists

```bash
$ test -f .planning/phases/08-vpol-02-sticky-tutor-legend/08-STACKING-AUDIT.md && echo EXISTS
EXISTS

$ wc -l .planning/phases/08-vpol-02-sticky-tutor-legend/08-STACKING-AUDIT.md
94

$ grep -cE "Ancestor Chain A|Ancestor Chain B" .planning/phases/08-vpol-02-sticky-tutor-legend/08-STACKING-AUDIT.md
2
```

Result: **PASS** (Plan 01 artifact — 94 lines including both Ancestor Chain A (WeekOverview) and Ancestor Chain B (CalendarGrid); unchanged by Plans 02-04).

### A.7 REQUIREMENTS.md §STICKY-02 amendment

```bash
$ grep -c "Amendment.*Phase 8 CONTEXT D-08" .planning/REQUIREMENTS.md
1
```

Result: **PASS** (Plan 01 amendment landed at REQUIREMENTS.md:33 — unchanged by Plans 02-04).

### A.8 Commit inventory (Phase 8 commit graph)

```bash
$ git log --oneline -- .planning/phases/08-vpol-02-sticky-tutor-legend/ \
    .planning/REQUIREMENTS.md src/lib/ui/z-index.ts \
    src/components/compare/week-overview.tsx \
    src/components/compare/calendar-grid.tsx | head -20
ccc877e docs(08-04): plan summary
d9c729f feat(08-04): normalize CalendarGrid sticky day-header to Z_INDEX.legend (STICKY-02)
12b46ca docs(08-03): plan summary
376fa47 feat(08-03): consolidate per-day sticky lane headers into single sticky tutor legend (STICKY-01, STICKY-02, STICKY-04)
82dd5cc docs(roadmap): insert reliability remediation phases 8.5/8.6/8.7
0811b96 docs(08-02): plan summary
d8494a1 feat(08): add Z_INDEX scale constant at src/lib/ui/z-index.ts (STICKY-02)
6bf9b5f docs(08-01): plan summary
dd1ced4 docs(08): amend STICKY-02 with simplified 3-tier z-index scale
7770166 docs(08): pre-implementation stacking-context audit (STICKY-03)
```

Expected ordering, oldest → newest (D-13 audit-first verification):
1. `7770166 docs(08): pre-implementation stacking-context audit (STICKY-03)` — Plan 01 commit 1 (audit FIRST)
2. `dd1ced4 docs(08): amend STICKY-02 with simplified 3-tier z-index scale` — Plan 01 commit 2
3. `6bf9b5f docs(08-01): plan summary` — Plan 01 summary
4. `d8494a1 feat(08): add Z_INDEX scale constant at src/lib/ui/z-index.ts (STICKY-02)` — Plan 02
5. `0811b96 docs(08-02): plan summary` — Plan 02 summary
6. `376fa47 feat(08-03): consolidate per-day sticky lane headers into single sticky tutor legend (STICKY-01, STICKY-02, STICKY-04)` — Plan 03
7. `12b46ca docs(08-03): plan summary` — Plan 03 summary
8. `d9c729f feat(08-04): normalize CalendarGrid sticky day-header to Z_INDEX.legend (STICKY-02)` — Plan 04
9. `ccc877e docs(08-04): plan summary` — Plan 04 summary
10. (this commit) `docs(08): scaffold Phase 8 verification checklist` — Plan 05 Task 1
11. (Task 2 will add the completed walkthrough commit; Task 3 will add the Traceability flip)

D-13 audit-first ordering confirmed: commit 1 is the audit (`7770166`); all code commits land afterward.

Result: **PASS**

***

## Section B — Human Visual QA Walkthrough (checkpoint)

**Environment:** Production deploy `dpl_McpSbJW6Mudtbvfy3uQkL3tqvypz` aliased to https://bgscheduler.vercel.app — promoted directly to production at the user's request after a non-shareable preview deploy. The compare view requires Google OAuth so the walkthrough was performed by the project owner on production.

**Prerequisites (completed):**

- [x] Signed in at https://bgscheduler.vercel.app with admin Google account
- [x] Tutors selected via chip strip (single-tutor for B.1; 2–3 tutors for B.2-B.6)
- [x] Week view active

### B.1 STICKY-01 — Legend stays pinned during vertical scroll (1 tutor)

- [x] Selected ONE tutor
- [x] Sticky legend rendered `[● {tutor name}]` at the top of the scroll container (D-04 always-on confirmed)
- [x] Scrolled the week view through 5+ hours of grid
- [x] **Expected:** Legend stays pinned at top of scroll container; never disappears, never goes under the day-name row above.
- [x] **Record:** **PASS** — single-slot legend pinned correctly throughout vertical scroll on the production deploy.

### B.2 STICKY-01 — Legend stays pinned during vertical scroll (2-3 tutors)

- [x] Selected 3 tutors via chip strip
- [x] Sticky legend rendered `[● name1] [● name2] [● name3]` in a single left-aligned row
- [x] Scrolled the week view to the bottom of the grid
- [x] **Expected:** All three slots remain visible and color-coded; dot colors match per-session card border colors.
- [x] **Record:** **PASS** — three-slot legend remained pinned with correct colors mapping to session cards.

### B.3 STICKY-02 — Popover renders above the legend

- [x] With 3 tutors selected, located a session near 7-8am
- [x] Scrolled grid so the legend overlapped the session row
- [x] Clicked the 7-8am session card
- [x] **Expected:** Popover at `z-50` overlays the sticky legend; no part of the legend appears on top of the popover.
- [x] **Record:** **PASS** — popover rendered cleanly above the sticky legend (Z_INDEX.popover = 50 > Z_INDEX.legend = 6).

### B.4 STICKY-02 — CalendarGrid day view popover still works (D-07 asymmetric)

- [x] Clicked a day tab (e.g., "Mon") to enter day view
- [x] **Expected:** Sticky day-header renders with `zIndex: Z_INDEX.legend = 6` (functionally identical to prior `z-10` — no visible change).
- [x] Clicked the tutor name in the sticky day-header
- [x] **Expected:** TutorProfilePopover opens ABOVE the sticky header (Portal-hoisted, `z-50`).
- [x] **Record:** **PASS** — D-07 asymmetric interaction preserved; CalendarGrid sticky header behaves identically to pre-Phase-8 (visible change is zero, intended).

### B.5 STICKY-04 — Fullscreen toggle preserves sticky legend

- [x] Returned to week view; with 3 tutors selected, clicked the maximize icon
- [x] **Expected:** Column animates to full width over ~300ms; sticky legend stays pinned at full width.
- [x] Scrolled the fullscreen week view down
- [x] **Expected:** Legend stays pinned; grid scrolls underneath.
- [x] Clicked the minimize icon
- [x] **Expected:** Column animates back to 50% width; legend still pinned.
- [x] **Record:** **PASS** — D-14 fullscreen-by-construction confirmed; legend remained pinned at both 50% and 100% widths and during the transition.

### B.6 Responsive narrow-panel sanity (Claude's Discretion)

- [x] 50% compare panel on user's primary display, with 3 tutors selected
- [x] **Expected:** All three legend slots readable; truncation acceptable on very long names; dots never clipped.
- [x] **Record:** **PASS** — narrow-panel layout readable; no compact-fallback needed for v1.1.

### B.7 STICKY-03 — Audit artifact cross-check

- [x] Reviewed `.planning/phases/08-vpol-02-sticky-tutor-legend/08-STACKING-AUDIT.md`
- [x] Verified: (a) Ancestor Chain A (WeekOverview) documented, (b) Ancestor Chain B (CalendarGrid) documented, (c) four pitfall checks (overflow / transform / filter / backdrop-blur / popover hoisting) all satisfied, (d) fullscreen preservation documented
- [x] **Record:** **PASS** — audit landed in Plan 01 commit `7770166` and Plans 02-04 did not invalidate any findings; post-implementation reality matches the audit's predictions verbatim.

***

## Section C — Sign-off

- [x] All automated checks in Section A: **PASS**
- [x] All human-QA checks in Section B: **PASS**
- [x] All 4 ROADMAP.md Phase 8 success criteria: **satisfied** (rows #1-4 all PASS, zero PENDING)
- [x] Phase 8 requirements STICKY-01..04 in REQUIREMENTS.md: ready for Task 3 (auto) Pending → Complete flip

**Signed:** kevhsh7@gmail.com / 2026-04-29

**Known issues carried forward to v1.2 (if any):** None.

***

*Verification scaffolded and walked 2026-04-29. References [08-CONTEXT.md](08-CONTEXT.md), [08-STACKING-AUDIT.md](08-STACKING-AUDIT.md), and [ROADMAP.md](../../ROADMAP.md) §"Phase 8: VPOL-02 Sticky Tutor Legend".*
