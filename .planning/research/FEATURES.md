# Feature Research — v1.1 Data Fidelity & Depth

**Domain:** Tutor scheduling / multi-person calendar compare (admin-facing)
**Milestone:** v1.1 (subsequent milestone — building on shipped v1.0 + v1.0.1)
**Researched:** 2026-04-20
**Confidence:** MEDIUM-HIGH (scheduling-tool conventions are well-documented; novel VPOL-03 shapes required some synthesis)

## Scope Note

This research covers **only the five v1.1 features** (MOD-01, PAST-01, VPOL-01, VPOL-02, VPOL-03). POLISH-01..16 are tech-debt drain items, not features — explicitly excluded from this research per orchestrator scope.

Existing v1.0 / v1.0.1 capabilities (range search, recurring/one-time modes, qualification + modality filtering, compare 1-3 tutors, GCal-style week grid, lane tints, sticky lane headers, today indicator, recommended-slots hero, copy-for-parent drawer, discovery modal, data health dashboard) are **not re-researched** — they are treated as the existing substrate and this file builds on top.

This supersedes the prior FEATURES.md research from 2026-04-10 (which was scoped to the v1.0 UX overhaul and is now historical).

---

## MOD-01 — Reliable Online/Onsite Detection

### Current State in BGScheduler

- Location-field heuristic (http/online/learn./zoom/meet.google/virtual) under-matches because most sessions have venue names like "Think Outside the Box", "Tesla", "Nerd"
- Visual distinction (dashed vs solid border) **removed from cards** pending reliable detection
- Modality info still shown in popover text
- `isOnlineVariant` flag on tutor Wise records + Wise `sessionType` are the primary signals to adopt (per PROJECT.md active requirements)
- Fail-closed rule: unresolved → Needs Review, never Available

### Industry Conventions (How Others Distinguish Online vs In-Person)

From Google Calendar, Cal.com, Calendly, Notion Calendar (formerly Cron), and Outlook:

| Convention | Where Seen | Strength |
|---|---|---|
| **Video camera icon next to time** | Google Calendar (Meet), Outlook (Teams), Cal.com | Dominant pattern across all mainstream tools |
| **Map-pin icon for in-person** | Google Calendar, Cal.com (location field), Notion Calendar | Complementary to camera icon; together they form a pair |
| **"Join" call-to-action button** | Google Calendar, Outlook, Notion Calendar | Only visible when online + within N minutes of start |
| **Location badge in popover** | All major calendars | Always in detail view, not always in card |
| **Event-type label** ("In-person", "Online", "Phone") | Cal.com event type creation | Explicit label, not relying on icon alone |
| **Distinct fill/stroke style** | Some experimental tools | Rare — most tools avoid this because it conflicts with color-coding by calendar/category |

**Key insight:** Icon + text label is the dominant pattern. **Color/border styling is NOT used** to distinguish modality in any of the five major tools — color is reserved for calendar/category/person. This aligns with BGScheduler's post-v1 decision to keep tutor-color borders and avoid modality-driven visual styles.

### Table Stakes (Users Expect These)

| Feature | Why Expected | Complexity | Notes |
|---|---|---|---|
| **Icon in session card** indicating online (video camera) vs onsite (map pin) vs unknown (question mark / dimmed) | Every mainstream scheduling tool does this | LOW | Use `lucide-react` icons (`Video`, `MapPin`, `HelpCircle`). Renders inline with time text in card. No card-level styling change — only a small icon glyph. |
| **Modality visible in popover detail** | Already live in BGScheduler | LOW (already shipped) | Keep current popover Badge showing location + classType; add modality-derived Badge (`Online` / `Onsite` / `Needs review`) with explicit label |
| **"Needs review" state for unresolved** | Fail-closed is non-negotiable per PROJECT.md constraints | LOW | Third icon variant (muted HelpCircle) + popover label. Never silently omit. |

### Differentiators (Competitive Advantage)

| Feature | Value Proposition | Complexity | Notes |
|---|---|---|---|
| **Modality filter in compare view** | Admin can hide online-only or onsite-only sessions to see the subset relevant to a given family | LOW | Already exists in search form; mirror in compare panel. Filter is client-side on cached tutor data. |
| **Modality summary per tutor in profile popover** | At-a-glance "85% online / 15% onsite" gives quick read on tutor's primary working style | LOW | Derived from existing sessions array. Display as mini-bar or simple text count. |
| **Unresolved-modality count in data health** | Surfaces the fail-closed escape hatch for admin monitoring | NONE (already shipped) | Already exists. Gains a more reliable denominator once MOD-01 signals are live. |

### Anti-Features (Commonly Requested, Often Problematic)

| Feature | Why Requested | Why Problematic | Alternative |
|---|---|---|---|
| **Dashed-border cards for online, solid for onsite** | Proposed in earlier BGScheduler iterations | Already rejected — dashed borders read as "tentative/unconfirmed" in most UI conventions, conflicting with tutor-color left-border which carries identity meaning. Two competing border-style signals cause cognitive overload. | Icon + popover label only. Keep border styling reserved for tutor identity (solid 3px left border). |
| **Color-coded modality (green for online, amber for onsite)** | "Easy to scan" at first glance | Collides with existing semantic tokens (`--available` green, `--blocked` amber). Would require redesigning the color system and overlap with conflict-red coding. | Icon + popover only. Color stays with tutor identity + semantic state (available/blocked/conflict). |
| **Replace location text with modality only** | "Less cluttered" | Loses venue information admin staff use for on-site logistics ("is this at the Nerd branch or the Tesla branch?") | Show both: icon first, location text after. |

### Dependencies on Existing Features

- **Depends on:** Wise sync pipeline providing `isOnlineVariant` and `sessionType` (already fetched per AGENTS.md normalization/modality module, currently under-utilized downstream)
- **Depends on:** `tutor-profile-popover.tsx` (exists) for modality-summary differentiator
- **Enhances:** Session cards in both `week-overview.tsx` and `calendar-grid.tsx`
- **Enhances:** Data health dashboard (unresolved modality count already surfaced)
- **No new dependencies on v1.0.1** (recommended-slots hero / copy-drawer)

---

## PAST-01 — Past-Day Session Visibility

### Current State in BGScheduler

- Wise `status: "FUTURE"` API does not return past sessions (confirmed upstream constraint)
- `buildCompareTutor` falls back to nearest future occurrence (deduped by `recurrenceId`) for weekdays with no data
- One-time past sessions cannot be recovered from Wise FUTURE API
- Two paths documented in PROJECT.md: (a) try Wise historical endpoint if it exists, (b) fallback to snapshot-based DB storage of what was FUTURE at sync time

### Industry Conventions (How Others Handle Historical Session Visibility)

From Google Calendar, Outlook, Notion Calendar, and integration patterns research:

| Convention | Source | Implication for BGScheduler |
|---|---|---|
| **Historical events stay visible forever by default** | Google Calendar (web) | User expectation: past events render identically to future, just in the past |
| **Muted/greyed styling for past events** | Google Calendar, Outlook, Cron | Distinguishes "already happened" from "upcoming" visually |
| **Navigable history** — scroll back in time indefinitely | All major calendars | Users don't expect a hard cutoff |
| **Historical snapshots for compliance/audit** | Enterprise scheduling (MyShyft schedule-snapshot-preservation article) | Common pattern: daily snapshot to DB, reconstruct history by replaying snapshots |
| **Tiered retention** — recent in-hot-store, older in cold-store | Enterprise scheduling | Not needed at BGScheduler's data scale (131 teachers) |

**Key insight:** The "append-only snapshot" pattern is the dominant solution when upstream APIs only return future/active data. Every nightly sync already writes a new snapshot row — preserving old snapshot rows for N days (or indefinitely) + reading historical sessions from them is the industry-standard approach. This aligns directly with path (b) from PROJECT.md.

### Table Stakes (Users Expect These)

| Feature | Why Expected | Complexity | Notes |
|---|---|---|---|
| **Past weeks render real historical data, not weekday-fallback substitute** | Admin needs to see what actually happened, not a recurring-pattern guess | MEDIUM | Requires either Wise historical endpoint (try first) OR DB-level preservation of prior snapshots' future-sessions |
| **Visual distinction between past and future sessions** | Standard in every major calendar; avoids accidentally treating a past time as bookable | LOW | Reduce opacity (e.g., `opacity-60`) or shift to a `text-muted-foreground` tone for sessions whose endTime < now. Compositional: add a single prop to the session-card render. |
| **No silent fallback to fabricated data** | Fail-closed principle from PROJECT.md constraints | LOW | If Wise has no data + DB has no historical snapshot record + date is past → show empty slot + inline "No historical data" marker. Remove current weekday-fallback behaviour for past weeks only. |

### Differentiators (Competitive Advantage)

| Feature | Value Proposition | Complexity | Notes |
|---|---|---|---|
| **"Actually-happened" vs "was-scheduled" distinction** | Reveals which sessions were cancelled/rescheduled after the snapshot was taken | HIGH | Requires multi-snapshot comparison — "last FUTURE snapshot for this day" vs "session still present on the day-of" — likely beyond v1.1 scope. Differentiator if later built. |
| **Source-of-truth badge per session** (Wise-live vs Snapshot-reconstructed) | Transparent data lineage for admin staff diagnosing discrepancies | LOW | Add a subtle `snapshot` badge to popover (no card change). Only visible in popover detail. |
| **Historical-week read-only banner** | "Viewing 6 Apr 2026 — historical snapshot from sync on 7 Apr" above past-week calendar | LOW | Banner only appears for past weeks. Reuses existing week picker context. |

### Anti-Features (Commonly Requested, Often Problematic)

| Feature | Why Requested | Why Problematic | Alternative |
|---|---|---|---|
| **Real-time backfill by polling Wise for cancelled sessions in past range** | "Make the data always accurate" | Wise FUTURE API doesn't expose cancellations after the fact; unreliable. Also adds N API calls per past-week view. | Trust the snapshot that was captured at the time; accept the "frozen-in-time" semantic. |
| **Unified "smart" view that blends future + reconstructed past seamlessly** | "Single timeline is cleaner" | Hides data-lineage differences from admin staff; if the historical reconstruction is wrong, they can't tell. | Keep muted styling + optional badge so past-vs-future origin is always distinguishable. |
| **Preserve every Wise API response payload forever (full JSON archive)** | "Capture everything just in case" | Storage bloat; 131 teachers × 365 days × 180-day windows; most data is duplicate. | Preserve only the `future_session_blocks` table per snapshot (already the right grain). Archive older than N days to cold storage later if needed. |

### Dependencies on Existing Features

- **Depends on:** Existing `snapshots` table + `future_session_blocks` table (per AGENTS.md schema) — preservation of old snapshot rows is the natural extension
- **Depends on:** Week picker (`compare-panel.tsx` week navigation) to identify past-vs-current-vs-future context for rendering logic
- **Conflicts with (needs reconciliation):** Current `buildCompareTutor` weekday-fallback logic — needs to be scoped to future-only weeks going forward
- **Enhances:** `buildCompareTutor` in `src/lib/search/compare.ts`
- **Enhances:** Snapshot retention policy (currently implicit — only `active: true` is queried; past snapshots presumably retained but not read)

---

## VPOL-01 — View Transitions Across Calendar / Week / Tutor Navigation

### Current State in BGScheduler

- Week navigation via prev/next arrows + Today button + WeekCalendar month-grid popup (click week label)
- Keyboard: ArrowLeft/Right for week nav (v1.0 T-03-11 mitigated — guarded against input fields)
- Tutor add/remove via chips, Compare (N) button, discovery modal
- Current transition: instant swap (no animation). Data fetch has skeleton fallback.
- Stack: Next.js 16 + React 19.2.4 — both support View Transitions API natively (confirmed HIGH confidence via Next.js docs)

### Industry Conventions (What View Transitions Do Tools Use?)

From Next.js docs, React 19.2 release, Linear, Notion, Google Calendar:

| Transition | Where Seen | Best For |
|---|---|---|
| **Cross-fade (default)** | Linear, Notion, React `<ViewTransition>` default | Default — always-safe fallback; good for content swap where spatial continuity doesn't matter |
| **Directional slide** (left-to-right for forward, right-to-left for back) | Google Calendar week nav, Cron/Notion Calendar | Directional navigation (prev/next week) — reinforces spatial model |
| **Shared element transition** | Linear issue detail, Apple Photos | Clicking a list item → detail view where the clicked element animates into the new view |
| **Scale + fade** (200ms) | Linear board-to-detail | Modal/panel open/close |
| **No transition** (instant) | Google Calendar day→day arrow click | Small changes where motion is distracting; rapid navigation |

**Key insight:** Cross-fade is the safe default (React 19.2 `<ViewTransition>` gives you this for free); **directional slide** is the differentiator for a calendar app because it reinforces the prev/next mental model. React 19.2 `startViewTransition` hook is built-in — **no Framer Motion / Motion-One needed**.

### Table Stakes (Users Expect These)

| Feature | Why Expected | Complexity | Notes |
|---|---|---|---|
| **Smooth cross-fade on week change** | Every mainstream calendar has smooth week transitions; instant swap feels "jank" | LOW | Wrap compare-panel body in `<ViewTransition>`; enable `viewTransition: true` in `next.config.ts`. React 19.2 + Next 16 handle the rest. |
| **No transition during rapid keyboard repeat** | Rapid keyboard nav with animation causes motion sickness and feels slow | LOW | Detect consecutive nav within 300ms → disable transition for that burst. Alternatively, use browser's `prefers-reduced-motion` to bypass entirely. |
| **Respect `prefers-reduced-motion`** | Standard a11y table-stake; required for WCAG 2.2 | LOW | `@media (prefers-reduced-motion: reduce) { ::view-transition-* { animation: none; } }` |

### Differentiators (Competitive Advantage)

| Feature | Value Proposition | Complexity | Notes |
|---|---|---|---|
| **Directional slide on prev/next week** | Reinforces forward/back spatial model; matches Google Calendar + Cron | MEDIUM | Use React 19.2 `transitionTypes` prop on nav buttons to tag forward vs back. CSS animates differently per type via `::view-transition-old(slide-forward)` etc. |
| **Tutor chip add/remove micro-animation** | Adding a tutor to compare feels more tactile; removing feels intentional | LOW | Tutor chip enter/exit with 150ms scale+fade. Pure CSS on chip mount/unmount. |
| **Day-drill-down transition in calendar grid** | Clicking a day header → zoom into CalendarGrid day view; reinforces same data, different lens | MEDIUM | Shared-element transition between WeekOverview day column and CalendarGrid full view. Requires `view-transition-name` per day column. |

### Anti-Features (Commonly Requested, Often Problematic)

| Feature | Why Requested | Why Problematic | Alternative |
|---|---|---|---|
| **Long (>300ms) decorative transitions** | "Feels premium" | Adds friction for admin staff doing repetitive compare tasks; 300+ms becomes perceptible delay when clicking through 5 weeks quickly | Keep under 200ms; default Next.js viewTransition is already fast |
| **3D transforms / parallax** | "Looks impressive" | Compute-heavy, unnecessary for 2D calendar; breaks sticky-positioning (VPOL-02) | 2D slide/fade only |
| **Separate animation library (Framer Motion / Motion-One)** | "More control" | React 19.2 ships `<ViewTransition>` built-in; adding a dep is bloat and more to maintain | Native View Transitions API + CSS keyframes |

### Dependencies on Existing Features

- **Depends on:** React 19.2 `<ViewTransition>` component + Next.js 16 `viewTransition: true` config flag
- **Depends on:** Week picker navigation state (`compare-panel.tsx`)
- **Depends on:** Tutor-selector chip mount/unmount (`tutor-selector.tsx`) for chip micro-animation
- **Coordinates with:** VPOL-02 sticky tutor legend — sticky elements can break during view transitions if not given a `view-transition-name`. Scope together in the same phase.
- **Enhances:** Week navigation in compare panel
- **Enhances:** Day-drill-down from WeekOverview → CalendarGrid

---

## VPOL-02 — Sticky Tutor Legend During Calendar Scroll

### Current State in BGScheduler

- Sticky lane headers exist (per-day column) showing tutor name + color dot when 2+ tutors are compared — `week-overview.tsx:295-327`
- The lane headers are inside each day column, so scrolling down the time axis keeps them visible at the top of each day
- There is NO app-level tutor chip strip that sticks during scroll — the chip strip in `compare-panel.tsx` is above the calendar container and scrolls with the page on longer pages
- Current sticky header lane: 20px tall, backdrop-blur background

### Industry Conventions (Sticky Person Identifiers)

From FullCalendar, React Calendar Timeline, and multi-person calendar libraries:

| Pattern | Where Seen | Relevance to BGScheduler |
|---|---|---|
| **Per-column resource header that sticks to top during vertical scroll** | FullCalendar resource view, React Calendar Timeline | Already implemented in BGScheduler (lane headers within day columns) |
| **Global legend strip that sticks to top of scroll container** | Mobiscroll, Resource Timeline, codelibrary sticky-header patterns | Not implemented — but this is the missing piece for VPOL-02 |
| **Frozen left column** (resource/person names in a sidebar that scrolls independently) | FullCalendar timeline (horizontal), Airtable grid | Not applicable — BGScheduler uses lane columns not lane rows |
| **Color-dot indicator in legend** | All multi-person tools | BGScheduler already has this in chips; need to preserve during scroll |

**Key insight:** The existing per-column lane headers cover *sub-week-level* scroll (scrolling time vertically). What's missing is the *app-level* tutor legend that stays visible when the user scrolls the whole page or expands beyond viewport. Standard fix: `position: sticky; top: 0` on the tutor chip strip or convert chips to a compact legend row that sticks. The CSS-Tricks pattern confirms `position: sticky` is the right primitive (no JS needed).

### Table Stakes (Users Expect These)

| Feature | Why Expected | Complexity | Notes |
|---|---|---|---|
| **Tutor chip strip stays visible during vertical calendar scroll** | Without it, users lose track of which color = which tutor when scanning dense session blocks | LOW | `position: sticky; top: 0; z-index: 10; background: var(--background)` on the chip strip container. Needs solid/backdrop-blur background so content doesn't bleed through. |
| **Stick height ≤ 48px** | Any taller and it eats too much calendar real estate | LOW | Current chip strip is ~40px — well within budget. Minimal redesign needed. |
| **Compact legend fallback when chip strip is cramped** | On narrow panels (50% width of workspace), 3 full chips with remove-X can be cramped | LOW | Display mode toggle — if ≤ 50% viewport width, collapse to `[color-dot + initials]` per tutor; expand on hover. Only needed if responsive breakpoints demand it. |

### Differentiators (Competitive Advantage)

| Feature | Value Proposition | Complexity | Notes |
|---|---|---|---|
| **Per-lane header dims when that tutor is out-of-view** | Visual cue that "tutor has sessions below fold" — subtle desaturation when no session of that tutor is in the viewport | MEDIUM | IntersectionObserver on session elements per tutor. Rare pattern, but high value for dense calendars. |
| **Clickable legend → jump to that tutor's next session** | One-click navigation to where the tutor actually has data | MEDIUM | Scroll the calendar container to the earliest visible session element for that tutor. Useful for empty-day stretches. |
| **Hover preview in sticky legend** | Mouse-over shows mini-stats (sessions this week, hours booked) without clicking | LOW | Reuse existing `tutor-profile-popover.tsx` for consistency. |

### Anti-Features (Commonly Requested, Often Problematic)

| Feature | Why Requested | Why Problematic | Alternative |
|---|---|---|---|
| **Sticky chip strip that shadows / layers aggressively on scroll** | "Feels more elevated" | Shadow/border change on scroll triggers a layout shift; annoying when scrolling back-and-forth. Confusing accessibility story. | Static `position: sticky` with consistent background — no scroll-triggered style changes. |
| **Two sticky layers (chip strip + lane headers both sticky)** | "Both should be visible" | Causes header-stacking where 80+ pixels of chrome eats the calendar. Also breaks vertical scroll performance on some browsers. | Keep lane headers (within each day column) + sticky chip strip only at top of scroll container. They occupy different axes. |
| **Dragging chips to reorder within the sticky strip** | "More control" | Reordering tutors changes column assignments, which means cached data keying (`tutorGroupId:weekStart`) stays stable but render order changes — visual churn without real value for 3-tutor limit. | Keep order = insertion order. If user wants different order, remove + re-add. |

### Dependencies on Existing Features

- **Depends on:** Existing tutor chip strip in `compare-panel.tsx` (strong dependency — this IS the element to make sticky)
- **Depends on:** Existing per-column lane headers in `week-overview.tsx` — need to coordinate z-index / scroll container boundaries so the two sticky layers don't collide
- **Depends on:** Existing `TUTOR_COLORS` in `session-colors.ts` (already single-source-of-truth post-v1.0)
- **Coordinates with:** VPOL-01 view transitions — sticky-positioned elements need a `view-transition-name` to prevent them from being captured in the transition frame and jumping
- **Enhances:** compare-panel scroll ergonomics
- **Enhances:** Works especially well with future longer-day views (e.g., if calendar range extends beyond 7am-9pm)

---

## VPOL-03 — Density Overview / Mini-Map (Shape Undecided)

### Current State in BGScheduler

- No overview/mini-map exists today
- Week picker shows week-label text + month-grid popup (`week-calendar.tsx`) — this is for navigation, not for density at-a-glance
- Day conflict badges in week header show *count* of conflicts per day (numeric)
- No at-a-glance "how busy is the tutor this week" signal beyond scanning the calendar itself
- Previous BGScheduler iteration considered a "density view" (free=figure, busy=ground), but it was **explicitly rejected** (per PROJECT.md decision log) because overlapping student data caused readability problems. This is a constraint for VPOL-03: the density overview must be **additive above the calendar**, not a replacement.

### Industry Conventions (Density / Mini-Map Patterns)

Research across Outlook mini-calendar, GitHub contribution graph, Linear density heatmaps, Figma minimap, and calendar UI survey (uxpatterns.dev, eleken.co):

| Shape | Where Seen | Strengths | Weaknesses |
|---|---|---|---|
| **Heatmap strip** (GitHub-style contribution row) | GitHub, Cal-Heatmap, shadcn-calendar-heatmap | Ultra-compact; colour intensity = load; works for multi-week lookback | Only encodes ONE dimension (total load); can't show per-tutor breakdown; abstract for unfamiliar users |
| **Mini-calendar month grid** | Outlook Peek, Google Calendar sidebar, Apple Calendar month | Familiar (months users already know); great for navigation + high-level busy/free | Takes ~160x160px; limited at-a-glance density encoding (usually just dot-per-event) |
| **Day-segmented bar (morning / afternoon / evening)** | Doodle, When2Meet, OnceHub | Very compact (horizontal bar split into 3-5 segments per day); encodes per-time-of-day load | Lossy; doesn't show specific session overlaps; only useful at the busy/free level |
| **Stacked horizontal bar per day** | Toggl Track, MyShyft enterprise scheduling | Encodes per-tutor load per day; compact; reinforces tutor colours already in the app | Less "at-a-glance" — requires reading stacked segments; not as dense as heatmap |
| **Sparkline per tutor** (mini-chart showing booked hours over the week) | Linear issue velocity, Fantastical sidebar | Shows per-tutor trend; compact; good for "which tutor is more booked" comparison | Abstract — doesn't map to specific days without hover |
| **Conflict marker strip** | Calendly team scheduling | Highlights only conflict days; very low visual noise | Only shows conflict density, not load density |

**Key insight:** Each shape encodes different dimensions. For BGScheduler's 3-tutor compare at 7-day scope, the top candidate shapes are narrowed to four (with the fourth being a rejection reference):

### Candidate Shape Comparison (Required by Orchestrator — pick one for phase planning)

| # | Shape | Dimensions Encoded | Footprint | Fit for 3-Tutor Compare | Fit for BGScheduler Aesthetic | Complexity | Recommendation |
|---|---|---|---|---|---|---|---|
| **A** | **Day-segmented bar per day, 7 bars** (morning / afternoon / evening split) | time-of-day load; aggregated across tutors | Compact (~8px tall × 7 slots along top of calendar) | Good — shows load density across the 14-hour daily window | Aligns with GCal minimalism; uses semantic green/amber tokens | **LOW** | **Strong candidate — lowest effort** |
| **B** | **Stacked per-tutor horizontal bar** (one row per tutor, 7-day week) | per-tutor × per-day booked hours; exposes imbalance ("tutor A is 30hr, tutor C is 5hr") | Medium (~3 rows × 20px each = 60px above calendar) | Excellent — reveals per-tutor load differences at-a-glance | Uses existing TUTOR_COLORS; reinforces lane tint concept | **MEDIUM** | **Strongest candidate for compare — highest value** |
| **C** | **GitHub-style heatmap strip** (single row, 7 cells, colour intensity = total booked hours) | total load per day; no per-tutor breakdown | Minimal (~16px tall × full-width row) | Moderate — loses per-tutor detail which IS the point of compare | Very minimal; might feel under-informative for this use case | **LOW** | **Weak candidate — simpler than A but less informative** |
| **D** | **Mini-week calendar preview** (thumbnail grid showing session blocks tiny) | same as main calendar but smaller | Large (~120px tall × full-width) — redundant with main calendar | Low — this IS the main calendar, just smaller; doesn't add summary value | Redundant; user already sees the main calendar | **HIGH** | **Reject — redundant** |

**Phase-planning recommendation:**
- **If phase capacity is tight:** pick shape (A). LOW complexity, answers "when is this week busy?"
- **If phase has room for one medium-effort feature:** pick shape (B). MEDIUM complexity, answers "which tutor is busiest?" which is more compare-specific and higher-value for BGScheduler's core use case.
- **Hybrid A+B:** possible but bumps to HIGH complexity; not recommended unless VPOL-03 is the phase's only headline feature.

### Table Stakes (Users Expect These)

| Feature | Why Expected | Complexity | Notes |
|---|---|---|---|
| **Some form of at-a-glance density indicator above the week calendar** | Without it, user must scan all 7 days × 14 hours to understand "is this week busy overall" | LOW-MEDIUM (depends on shape) | Shape A, B, or C. 20-60px tall, above calendar grid header |
| **Conflict count per day already visible** | Already live in BGScheduler (numeric conflict badge in day header) | NONE (already shipped) | Keep; integrate with new density bar for cohesion |
| **No regression of existing calendar grid clarity** | PROJECT.md constraint: "Calendar grid layout overhaul" is out-of-scope | LOW | Density indicator is a *header* layer above the calendar; doesn't touch cells |

### Differentiators (Competitive Advantage)

| Feature | Value Proposition | Complexity | Notes |
|---|---|---|---|
| **Click density segment → jump calendar to that day/time** | Functional mini-map: not just visualisation but navigation | MEDIUM | For shape (A): click morning segment → scroll calendar to 7am-11am that day. For shape (B): click tutor row segment → highlight that tutor's sessions that day. |
| **Shared-free-slot density overlay** | Show where ALL selected tutors are simultaneously free (the core compare value proposition) visually in the overview | LOW | Already computed server-side (`findSharedFreeSlots`). Render as green tick under each day's density bar where a ≥30min shared slot exists. |
| **Per-tutor utilisation percentage** (e.g. "62% booked this week") | Quick read on how heavily used each tutor is | LOW | Derived from existing sessions + availability windows. Display as small text next to tutor name in legend or as bar fill percentage. |

### Anti-Features (Commonly Requested, Often Problematic)

| Feature | Why Requested | Why Problematic | Alternative |
|---|---|---|---|
| **Density view as a REPLACEMENT for the week calendar** (busy=ground, free=figure) | Proposed in earlier BGScheduler iteration | Already rejected per PROJECT.md decision log — overlapping student data caused readability problems | Keep calendar grid; density indicator is an ADDITION not a replacement |
| **Full-month density heatmap (GitHub-style, 30 days)** | "More context" | BGScheduler scope is week-centric; month-heatmap implies navigating across weeks, which is a different UX motion. Also pulls focus from the current-week task. | Keep density scoped to the visible week. Use the WeekCalendar popup for month-level navigation. |
| **Animated density bar filling in as data loads** | "Feels alive" | Adds ~300ms perceptual delay before density is readable; counterproductive to the "instant" goal from PROJECT.md core value | Render static; data already loaded via existing compare API. |
| **Tooltip on every density segment with session details** | "More information" | Session details already live in the main calendar below the density bar. Duplicating them in tooltip = double the hover surface with no added info. | Tooltip only gives summary text ("Tue afternoon: 4 sessions, 1 conflict"). Detail stays in main calendar. |

### Dependencies on Existing Features

- **Depends on:** Existing compare tutors state from `useCompare` hook (per-tutor sessions + availability windows)
- **Depends on:** Existing `detectConflicts` + `findSharedFreeSlots` results (no new computation — just new presentation)
- **Depends on:** Existing `TUTOR_COLORS` for per-tutor shape (B)
- **Depends on:** Semantic colour tokens (`--available`, `--blocked`, `--conflict`) for aggregate shape (A)
- **Enhances:** WeekOverview header region (above day name buttons)
- **No conflict** with VPOL-01 / VPOL-02 — density bar is in the non-scrollable part of the compare panel

---

## Consolidated Feature Dependencies

```
MOD-01 (modality detection)
    └──depends──> Wise sync pipeline (existing, v1.0)
    └──enhances──> session card rendering in week-overview + calendar-grid
    └──enhances──> tutor-profile-popover
    └──independent of──> VPOL-01/02/03 (can ship in any order)

PAST-01 (past-day visibility)
    ├──depends──> snapshots + future_session_blocks tables (existing)
    ├──depends──> week picker navigation state (existing)
    └──modifies──> buildCompareTutor weekday-fallback logic

VPOL-01 (view transitions)
    ├──depends──> React 19.2 + Next.js 16 (existing)
    ├──depends──> week picker (existing)
    └──depends──> tutor-selector chips (existing)
    ↕──coordinate with──> VPOL-02 (sticky elements need view-transition-name)

VPOL-02 (sticky tutor legend)
    ├──depends──> tutor chip strip in compare-panel (existing)
    ├──depends──> lane headers in week-overview (existing — z-index coordination)
    └──depends──> TUTOR_COLORS (existing, v1.0)
    ↕──coordinate with──> VPOL-01

VPOL-03 (density overview)
    ├──depends──> useCompare hook data (existing)
    ├──depends──> detectConflicts + findSharedFreeSlots (existing)
    ├──depends──> TUTOR_COLORS + semantic tokens (existing)
    └──depends──> WeekOverview header region (existing — add layer above)
```

### Dependency Notes

- **MOD-01 is independent** — can ship solo in any phase
- **PAST-01 is independent of VPOL-\*** — data-layer feature; can ship in parallel with UI-layer work
- **VPOL-01 + VPOL-02 must coordinate** — sticky elements need `view-transition-name` to avoid jumping during transitions. Scope them in the same phase or sequence VPOL-02 before VPOL-01.
- **VPOL-03 is UI-layer only** — no backend changes; pure client-side derived presentation

## Complexity Summary (for Phase Planning)

| Feature | Overall Complexity | Key Risk |
|---|---|---|
| MOD-01 | **LOW-MEDIUM** | Depends on `isOnlineVariant` + `sessionType` data quality from Wise — verify signal reliability before building (spike first if uncertain) |
| PAST-01 | **MEDIUM-HIGH** | Data-layer change with schema implications (snapshot retention, historical read path). Verify whether Wise historical endpoint exists before committing to path (a) vs path (b). Path (b) — DB-preserved snapshot reads — is the safer default. |
| VPOL-01 | **LOW-MEDIUM** | LOW for cross-fade (React 19.2 + Next 16 handle it); MEDIUM for directional slide + shared-element transitions |
| VPOL-02 | **LOW** | Essentially CSS `position: sticky` + z-index coordination with existing lane headers |
| VPOL-03 | **LOW (shape A or C) or MEDIUM (shape B) or HIGH (A+B hybrid)** | Shape decision is the risk — stacked per-tutor (B) is highest-value but also highest-complexity. Decide shape during phase planning. |

## MVP Definition

Since this is a **subsequent milestone**, MVP framing doesn't apply the same way. Instead: **what's the minimum to call v1.1 shipped?**

### Must-ship for v1.1 (data fidelity + visible polish)

- [x] **MOD-01** — table-stakes trio (icon in card, popover label, Needs Review state). Fail-closed is non-negotiable per existing constraints.
- [x] **PAST-01** — table-stakes trio (real historical data OR explicit empty state, visual distinction past-vs-future, no silent fallback for past weeks). Answers the known "past-day sessions" product gap.
- [x] **VPOL-02** — sticky tutor legend table-stakes (always-visible chip strip). Low complexity, clear user value.

### Should-ship for v1.1 (visual polish target per milestone name)

- [x] **VPOL-01** — cross-fade transition (table-stakes only). Directional slide is nice-to-have.
- [x] **VPOL-03** — shape (A) or (B), whichever phase planning picks. The "shape TBD" nature means this could slip to v1.2 if complexity is higher than estimated.

### Defer to v1.2 if phases are tight

- [ ] MOD-01 **modality filter in compare view** differentiator
- [ ] MOD-01 **modality summary in profile popover** differentiator
- [ ] PAST-01 **source-of-truth badge** differentiator
- [ ] PAST-01 **historical-week banner** differentiator
- [ ] VPOL-01 **directional slide + shared-element transitions** differentiators
- [ ] VPOL-02 **hover preview / jump-to-next-session** differentiators
- [ ] VPOL-03 **click-to-jump navigation** + **per-tutor utilisation %** differentiators

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---|---|---|---|
| MOD-01 table stakes (icon + popover + Needs Review) | HIGH (closes known bug) | LOW | P1 |
| PAST-01 table stakes (real historical data or empty state) | HIGH (closes known bug) | MEDIUM-HIGH | P1 |
| VPOL-02 table stakes (sticky chip strip) | MEDIUM (ergonomic win) | LOW | P1 |
| VPOL-01 table stakes (cross-fade) | LOW-MEDIUM (polish) | LOW | P2 |
| VPOL-03 shape A or B | MEDIUM (new at-a-glance capability) | LOW-MEDIUM | P2 |
| MOD-01 differentiators | MEDIUM | LOW | P2 |
| VPOL-01 directional slide | LOW (polish) | MEDIUM | P3 |
| VPOL-03 click-to-jump | MEDIUM | MEDIUM | P3 |
| All other differentiators | LOW-MEDIUM | varies | P3 |

**Priority key:**
- P1 — required for v1.1 ship (closes known bugs or ships the core of each feature line)
- P2 — should ship in v1.1 if phase capacity allows
- P3 — defer to v1.2

## Competitor Feature Analysis

| Feature | Google Calendar | Notion Calendar (Cron) | Cal.com | Our Approach |
|---|---|---|---|---|
| Online/onsite distinction | Video camera icon + "Join" button | Video icon + join shortcut | Event-type label ("In-person" / "Online") | Icon in card + explicit Badge in popover (no border/color styling) |
| Past-day visibility | Past events stay forever, muted | Past events muted | N/A (booking-centric, not history-centric) | Snapshot-based DB preservation + muted opacity on past-week sessions |
| View transitions | Directional slide on week nav | Directional slide on week nav | Cross-fade on view change | Cross-fade (table stakes) + directional slide (differentiator) |
| Sticky person identifier | Per-column resource header (sticky on scroll) | Per-day column header | N/A (single-event-focused) | Sticky chip strip at top of compare panel + existing lane headers |
| Density overview | Mini-calendar sidebar (month grid) | Day-of-month density dots | N/A | Shape (A) aggregate bar or (B) per-tutor bar — phase decides |

## Sources

- [Cal.com vs Calendly: 2026 Comparison - Fluent Booking](https://fluentbooking.com/articles/cal-com-vs-calendly/)
- [The Better Booking Tool: Cal.com vs Calendly 2026 - YouCanBook.me](https://youcanbook.me/blog/calendly-vs-cal-dot-com)
- [Google Calendar Community - Finding Past Events](https://support.google.com/calendar/thread/288054868/finding-events-from-more-than-a-year-ago?hl=en)
- [How Do You Look Up Past Appointments - Calendar.com](https://www.calendar.com/blog/how-do-you-look-up-past-appointments-in-your-calendar/)
- [Next.js View Transitions Guide](https://nextjs.org/docs/app/guides/view-transitions)
- [Next.js 16 viewTransition config](https://nextjs.org/docs/app/api-reference/config/next-config-js/viewTransition)
- [React Labs: View Transitions, Activity - April 2025](https://react.dev/blog/2025/04/23/react-labs-view-transitions-activity-and-more)
- [React ViewTransition Reference](https://react.dev/reference/react/ViewTransition)
- [React 19.2 View Transitions + Next.js 16 - Digital Applied](https://www.digitalapplied.com/blog/react-19-2-view-transitions-animate-navigation-nextjs-16)
- [View Transitions in React, Next.js - rebeccamdeprey.com](https://rebeccamdeprey.com/blog/view-transition-api)
- [Notion Calendar Keyboard Shortcuts](https://www.notion.com/help/notion-calendar-keyboard-shortcuts)
- [Cron (Notion Calendar) Global Keyboard Shortcuts](https://cronhq.notion.site/Global-keyboard-shortcuts-e933a55e7fb648028b09cedf933d3e76)
- [Fantastical Calendar Views Help](https://flexibits.com/fantastical/help/calendar-views)
- [FullCalendar stickyHeaderDates docs](https://fullcalendar.io/docs/stickyHeaderDates)
- [FullCalendar sticky timeline demo](https://fullcalendar.io/docs/sticky-timeline-demo)
- [React Calendar Timeline (namespace-ee) GitHub](https://github.com/namespace-ee/react-calendar-timeline)
- [CSS-Tricks Position Sticky and Table Headers](https://css-tricks.com/position-sticky-and-table-headers/)
- [Calendar Heatmap UI Patterns - Sisense Docs](https://docs.sisense.com/main/SisenseLinux/calendar-heatmap.htm)
- [Shadcn Calendar Heatmap](https://shadcn-calendar-heatmap.vercel.app/)
- [Cal-Heatmap JS library](https://cal-heatmap.com/)
- [UX Patterns for Developers: Calendar View](https://uxpatterns.dev/patterns/data-display/calendar)
- [Calendar UI Examples: Eleken](https://www.eleken.co/blog-posts/calendar-ui)
- [Enterprise Schedule Versioning: Snapshot Preservation - MyShyft](https://www.myshyft.com/blog/schedule-snapshot-preservation/)
- [Outlook Calendar Peek - Microsoft Support](https://support.microsoft.com/en-us/office/keep-upcoming-appointments-and-meetings-always-in-view-0e5f30da-c44d-4b96-8fd9-ba5d10db0962)
- [Google Calendar Video Conferencing - Support](https://support.google.com/calendar/answer/9896448?hl=en)

---
*Feature research for: v1.1 Data Fidelity & Depth milestone*
*Researched: 2026-04-20*
*Confidence: MEDIUM-HIGH — scheduling conventions well-documented; VPOL-03 shape-comparison required synthesis across multiple patterns*
