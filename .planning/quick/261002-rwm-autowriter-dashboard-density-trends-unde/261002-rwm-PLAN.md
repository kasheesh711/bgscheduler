---
quick_id: 261002-rwm
type: quick
files_modified:
  - src/components/feedback-autowriter/feedback-autowriter-dashboard.tsx
  - src/components/feedback-autowriter/health-rail.tsx
  - src/components/feedback-autowriter/trend-charts.tsx
  - src/components/feedback-autowriter/tutor-table.tsx
  - src/app/(app)/feedback-autowriter/page.tsx
---

# Quick 261002-rwm: Autowriter dashboard: tighten first screen + scalable tutors table

## Context
Feedback Autowriter page (`/feedback-autowriter`, origin/main `61088e98`) wastes space and won't scale:
1. **Dead space under "What needs you".** Shell grid `grid items-stretch gap-5 lg:grid-cols-3` (`feedback-autowriter-dashboard.tsx:279`) stretches the inbox to the tall Pilot-health rail; inbox list wrapper is `flex-1` (`inbox.tsx:186`), so 3 incident rows leave ~700px blank before the footer.
2. **Tutors table doesn't scale.** 18 roster tutors (13 added 2 Oct), 12 with zero posts, each a ~88px two-line row of dashes. No search, no filter, fixed sort, 8 columns incl. a "Review" column that reads the same for everyone.

Owner chose: **stack trend charts under the inbox** (left 2/3 column) and a **dense table + groups** for tutors.

Code lives only on origin/main (not the current `codex/outlook-calendar` checkout, which has unrelated uncommitted work — don't touch it).

## Setup
- Worktree per policy: reuse `.claude/worktrees/slot-a` (or slot-b), new branch `feat/autowriter-dashboard-density` off `origin/main`; node_modules via `scripts/dev/worktrees.sh` clone.
- Run through `/gsd-quick` (repo GSD rule). Open PR as **draft** until review + checks pass.

## Change 1 — layout (shell + trends)
`src/components/feedback-autowriter/feedback-autowriter-dashboard.tsx` ~L279-286:
- Grid becomes `grid items-start gap-5 lg:grid-cols-3`; DOM order inbox → rail → trends (mobile stack = inbox, health, trends).
  - `<Inbox className="lg:col-span-2" …>`
  - `<HealthRail className="lg:col-start-3 lg:row-span-2 lg:row-start-1" …>` (add `className` passthrough on `HealthRail`, `health-rail.tsx:195`)
  - `<TrendCharts className="lg:col-span-2" …>` moved inside the grid.
- `trend-charts.tsx:329-330`: accept `className`; header margin `mt-7` → `mt-2` when inside grid (pass via prop or make the header margin part of the section className default `mt-7`, overridden in shell). Charts grid stays `lg:grid-cols-2` (fits 2/3 width).
- `health-rail.tsx`: Today block uses `mt-auto` — harmless at natural height; keep.
- Inbox: `flex-1` wrappers fine at natural height; remove nothing else. Empty states keep `py-14`.
- Page skeleton `src/app/(app)/feedback-autowriter/page.tsx:59-61`: replace twin `h-[520px]` boxes with left (inbox ~h-[260px] + trends ~h-[460px]) / right rail (~h-[620px]) to match new shape.

## Change 2 — dense tutors table
All in `src/components/feedback-autowriter/tutor-table.tsx` (keep `buildTutorRows`, `TutorFilterChip`, `TutorTableRow`).

**Pure helpers (exported, unit-tested):**
- `hasNoPosts(row)`: `quality ? quality.textsInWise === 0 : row.posted === 0`.
- `needsAttention(row)`: accuracy below `GATE_THRESHOLDS.passLowerBound` (same `belowBar` rule as today), `critical > 0`, coverage < `minCoverage`, `openHolds > 0`, `requiredPending > 0`, or `partlyEnabled`.
- `type TutorView = "all" | "attention" | "no_posts" | "off"`; `filterTutorRows(rows, { view, query })` — query = case-insensitive substring on `displayName`.
- `type TutorSortKey = "name" | "accuracy" | "lowerBound" | "coverage" | "holds" | "realFixes"`; `sortTutorRows(rows, key, dir)` — nulls last regardless of dir, ties by name. Default `accuracy desc` (= current order).

**Toolbar** (in the section header row, replaces the "Click a tutor…" hint line which moves to the footer):
- Search `Input` (`src/components/ui/input.tsx`, `h-7 text-[11px]`, `aria-label="Find a tutor"`).
- Segmented buttons like the trends range group (`trend-charts.tsx:345-353` pattern, `aria-pressed`): All N · Needs attention N · No posts yet N · Off N.
- Local `useState` only; no persistence.

**Table (tutors with posts):**
- Rows single-line: `CELL` `py-3.5` → `py-2`; avatar `size-7` → `size-6`; name + inline muted "5 posts · 0 to review" on same line (truncate).
- Columns: Tutor · Accuracy · Coverage · Holds · Real fixes · Status (6, was 8).
  - **Accuracy** cell = `100% 5/5` + new `IntervalBar` + `LB 56%` small text. `IntervalBar`: pure divs, ~120px track 0–100%, band from `wilsonLower` to `accuracy`, dot at accuracy, hairline ticks at `headStartLowerBound` (70%) and `passLowerBound` (80%); tone amber/green via existing `TONE_TEXT`/belowBar rule; `title`/`aria-label` "Accuracy 100%, lower bound 56.5%, pass 80%". Reuse the mark positions logic idea from `LowerBoundBar` (`health-rail.tsx:68`) — extract shared tick constants if trivial, else keep local.
  - **Review** column dropped: show `Tag` "Sampled" next to name only when `phase === "sampled"`; footer note says "New tutors: every post reviewed."
  - **Status**: unchanged Tag + owner Turn on/off button (`h-6`), same `onControl` confirm text.
- Sortable headers: `<button>` inside `TableHead`, `aria-sort` on the th, arrow shows active key/dir.
- Click-to-filter + selected highlight unchanged.

**"No posts yet" group** (rows where `hasNoPosts`), rendered below the table inside the same `Panel`, header strip `No posts in these 14 days · 12`:
- Flex-wrap of compact chips: avatar initial + name + status dot (On/Partly/Off); chip is a `button aria-pressed` that calls `onSelect` (same filter behavior). Owner: small "Turn off/on" text button inside chip, same confirm path.
- If view = `no_posts`, table hidden and only this group shows; if view filters out all posting tutors, show group only; empty result → one-line "No tutor matches".
- A selected tutor hidden by search/view stays filtered (chip at top still clears it).

Footer keeps window dates + review-unavailable sentence; gains "Click a tutor to filter the to-do list and the charts."

## Tests
- `src/components/feedback-autowriter/__tests__/tutor-table.test.tsx`: update existing (lower bound now "LB x%"; Review column gone → "Sampled" tag test); add `hasNoPosts`, `needsAttention`, `filterTutorRows`, `sortTutorRows` (nulls last both dirs), no-posts group renders chips not rows, owner-only toggles in chips.
- `__tests__/fixtures.ts`: add zero-post tutors so fixtures exercise the group (check other tests' tutor-count assertions).
- `__tests__/feedback-autowriter-dashboard.test.tsx:43`: keep order assertion (Pilot health still before trends in DOM); add check that trends section sits inside the grid (`lg:col-span-2` on `#autowriter-trends`) and rail has `lg:row-span-2`. Update text "Click a tutor to filter" location if it moves (still present).
- `__tests__/trend-charts.test.tsx`, `health-rail.test.tsx`: adjust only if className defaults break snapshots.

## Docs
- `docs/superpowers/specs/2026-09-30-autowriter-dashboard-redesign-design.md` §3.2/§3.4/§3.6: note inbox natural height + trends in left column; tutor table density/filters/no-posts group. Re-fetch origin/main before editing docs (doc-regen rule).

## Verification
1. `npx vitest run src/components/feedback-autowriter src/lib/feedback-autowriter` then `npm test`, `npm run typecheck`, `npx eslint src/components/feedback-autowriter`.
2. `node scripts/dev/render-autowriter-dashboard.mjs` — screenshots owner/admin/empty/review-failed views + `&theme=dark`; confirm: no gap under inbox, trends directly under inbox, rail spans both, tutors table compact with no-posts chip group; also at 375px width (stack order inbox → health → trends).
3. Real component in dev server (`preview_start`) at `/feedback-autowriter` with prod-like data if available: search, each view tab, sort headers, click row/chip filters inbox + trends, Turn off confirm dialog appears (cancel it).
4. Code review pass (`code-reviewer` agent) before marking PR ready.
