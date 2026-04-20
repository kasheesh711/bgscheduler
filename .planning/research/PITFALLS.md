# Pitfalls Research — v1.1 Data Fidelity & Depth

**Domain:** BGScheduler — live tutor scheduling tool (Next.js 16 App Router, Neon Postgres, in-memory search index, fail-closed data integrity).
**Researched:** 2026-04-20
**Confidence:** HIGH — code-grounded for MOD-01, PAST-01, VPOL-02 (direct inspection of `modality.ts`, `week-overview.tsx`, `compare.ts`, `orchestrator.ts`); MEDIUM for VPOL-01 and VPOL-03 (framework guidance verified via official Next.js docs + current CSS literature; exact regressions depend on implementation shape TBD in phase planning).

*Supersedes the v1.0 PITFALLS.md that used to live here — that research covered the monolith-split and streaming phases; those lessons are folded into the v1.0 audit and retrospective.*

---

## Critical Pitfalls

### Pitfall 1 — MOD-01: Silently bypassing fail-closed when upgrading modality to `isOnlineVariant` + sessionType

**What goes wrong:**
The new primary signal (`isOnlineVariant` from `tutor_identity_group_members.is_online_variant`, plus `sessionType` from Wise) is read directly and used to label a session `online | onsite`. When both are missing or contradictory, the team short-circuits to a default (typically `"onsite"`) instead of returning `"unknown"` / routing to Needs Review. Fail-closed discipline — "unresolved modality → Needs Review, never Available" (`AGENTS.md:146-149`) — gets weakened because the old code path already had fallbacks and the refactor inherits them.

**Why it happens:**
Two root causes compound:
1. **Signal layering.** `src/lib/search/compare.ts:27-70` (`resolveSessionModality`) already has a five-step cascade: `teacherRecord.isOnline` → `supportedModes === ["onsite"]` → `sessionType` → `location` regex → `supportedModes[0]`. When adding "authoritative `isOnlineVariant`" at the top, engineers assume the later steps become unreachable and stop auditing them — but the _group-level_ `supportedModes` fallback at line 65-68 still returns `onsite` for a group that supports only onsite. That's fine for search (which already ran modality checks), but bad if the new MOD-01 rule says "per-session resolution must fail-closed if signals contradict." Every `return X;` is a fallthrough that MUST be reviewed.
2. **Test coverage gap.** `src/lib/normalization/__tests__/modality.test.ts` exercises `deriveModality` at the _group_ level. There is no test that explicitly asserts `resolveSessionModality()` returns `"unknown"` when `isOnlineVariant=false` AND sessionType is missing AND the group supports both modes. That case silently falls through to line 69 (`return "unknown"`) today, which is correct — but a careless refactor can replace it with `return "onsite"` as an "idiot-proof default" and nobody notices.

**How to avoid:**
- Add a test matrix in `compare.test.ts`: for each combination of `{isOnlineVariant: T/F/null, sessionType: online/onsite/null, supportedModes: [online]/[onsite]/[both]/[]}`, assert the expected output, with the "Needs Review" / `unknown` cases explicitly locked in. Specifically: if `isOnlineVariant` is authoritative, both modes supported, and `sessionType` missing → MUST return `"unknown"`. Write this test before changing the implementation.
- Make `resolveSessionModality` return a union type `{ modality: "online"|"onsite"|"both"|"unknown", source: "isOnlineVariant"|"sessionType"|"location"|"groupDefault"|"unresolved" }` so reviewers see in the diff which branch produced which answer. Grep for `groupDefault`/`unresolved` in test snapshots to audit fail-closed hits.
- Add an invariant assertion: if `resolveSessionModality` returns a concrete modality but the group's `dataIssues` contains a `"modality"` issue, throw in development / log a data_issue in production. This catches the case where derivation succeeds for a session but the group-level derivation couldn't agree.
- Do NOT change `deriveModality` in `src/lib/normalization/modality.ts` without simultaneously changing the test file; existing tests assert `issue: null` for resolved cases and `modality: "unresolved"` for ambiguous cases. Preserve that contract.

**Warning signs:**
- A diff to `modality.ts` or `compare.ts:resolveSessionModality` that REMOVES a `return "unknown"` / `unresolved` branch and REPLACES it with a concrete value.
- `/data-health` dashboard shows a sudden drop in `modality` issue count after deploy (not because data got better, because fail-closed got looser).
- `availabilityWindows[i].modality === "unresolved"` rows become rare in queries while the search results suddenly show more "Available" matches.
- Any PR comment saying "we can default to onsite if unsure" without a data_issue being emitted.

**Phase to address:** MOD-01 phase (dedicated, first). The new signal lookup and the fail-closed contract must ship together; do NOT allow "we'll tighten fail-closed in a follow-up." Guard with a diff-level acceptance test that asserts `deriveModality` still emits a `ModalityIssue` for every ambiguous case, and extend coverage to the session-level resolver.

**References:**
- Non-negotiable rule: `AGENTS.md:146-149` ("Unresolved identity, modality, or qualification → Needs review, never Available").
- Current derivation: `src/lib/normalization/modality.ts:23-91`.
- Session-level resolution that will be refactored: `src/lib/search/compare.ts:27-70`.
- Storage: `src/lib/db/schema.ts:96` (`isOnlineVariant` column).

---

### Pitfall 2 — MOD-01: Trusting `isOnlineVariant` as a session label when it describes the teacher record, not the session

**What goes wrong:**
`isOnlineVariant` lives on `tutor_identity_group_members` — it's a property of the Wise _teacher record_ ("Usanee (Aey) Tortermpun Online" vs. "Usanee (Aey) Tortermpun"). For groups with `supportedModality === "both"`, the same physical tutor has two teacher records, and a single future session can be scheduled under either one. Engineers assume "isOnlineVariant of the session's teacherId = the session's modality." That's correct only when the group has just one record. For paired records, a session under the `_online` record might still be scheduled in the tutor's physical classroom if the admin created it under the wrong record in Wise — a classic data-entry mistake in the upstream system.

**Why it happens:**
- The `src/lib/search/compare.ts:35` already encodes the wrong assumption: `if (teacherRecord?.isOnline) return "online"`. This was fine while the heuristic was best-effort, but MOD-01 promotes it to "reliable." Users will start trusting the labels.
- The upstream data quality is better than the heuristic assumes in aggregate but worse in the long tail. Without a trust-level indicator, users can't tell when the label is rock-solid vs. "best guess."

**How to avoid:**
- Introduce a `modalityConfidence: "high" | "medium" | "low"` field on `CompareSessionBlock`: `high` = group has single record + clear `isOnlineVariant` OR sessionType === record's expected modality; `medium` = paired group but sessionType agrees with `isOnlineVariant`; `low` = paired group, sessionType missing. Render a discreet "?" badge for `low` in the popover (don't remove the label).
- Require `sessionType` to corroborate `isOnlineVariant` for paired groups (`supportedModality === "both"`). When they disagree, emit a new `conflict_model` data_issue (already in `dataIssueTypeEnum`, `src/lib/db/schema.ts:23-29`) tagged with the specific session ID, and set `modality: "unknown"`.
- Document the rule in the session popover: "Modality inferred from teacher record; check Wise if booking." This reframes the trust boundary.

**Warning signs:**
- User feedback: "The session shows online but the student came to the office" (or vice versa) — means upstream data is misfiled.
- Deploy-time regression: `deriveModality` calls drop but `sessionType` ↔ `isOnlineVariant` contradiction count rises in the snapshot_stats issuesByType breakdown.

**Phase to address:** MOD-01, Stage 2 (after the primary signal is wired, add confidence grading and conflict detection). Do NOT skip this — the whole point of MOD-01 is fidelity, not just changing which column we read.

---

### Pitfall 3 — MOD-01: Visual restoration that re-introduces the exact rendering regression v1.0 removed

**What goes wrong:**
Once modality is "reliable," the temptation is to restore the dashed-vs-solid border distinction (or similar visual tell) that was removed from `session-colors.ts` during v1.0 "because detection was unreliable." The render code is still there as git history and will be restored with a one-line diff. But `modalityConfidence === "low"` cases still exist, and rendering them with a solid border (claiming "reliable onsite") is worse than the v1.0 state (no claim).

**Why it happens:**
The MOD-01 roadmap sells "reliable detection" → UI engineer interprets that as "re-enable the visual distinction." They miss the subset of sessions that still can't be trusted (paired-group ambiguity, missing sessionType).

**How to avoid:**
- Any session with `modalityConfidence === "low"` MUST render identically to the current v1.0 solid styling (no claim). Only `high`/`medium` sessions get dashed borders for online.
- Add a visual regression test: snapshot `week-overview.tsx` with a mixed-confidence dataset and assert `low`-confidence cards have no dashed border class.
- Keep `session-colors.ts` as the single source of truth — any function that decides border style must accept `modalityConfidence` as a required parameter (not optional with a default).

**Warning signs:**
- User reports an onsite session rendering as online (or vice versa) after MOD-01 ships, and it turns out `modalityConfidence` was `low`.
- A PR re-introduces `isOnline: boolean` as a boolean on `CompareSessionBlock` (instead of `{modality, confidence}`) — boolean is lossy.

**Phase to address:** MOD-01, Stage 3 (visual). Gate the visual restoration behind the confidence grading added in Stage 2.

---

### Pitfall 4 — PAST-01: Cross-snapshot session double-counting when sessions survive across sync runs

**What goes wrong:**
The PAST-01 design stores past sessions by reading `future_session_blocks` rows from historical snapshots (since the Wise FUTURE API doesn't return past sessions). But `future_session_blocks` is scoped by `snapshotId` — the same recurring session `wiseSessionId` can appear in multiple snapshots, sometimes with slightly different data (e.g., student name corrected, location updated, or session got cancelled in one snapshot and uncancelled the next). A naive cross-snapshot UNION returns duplicates; a naive "most recent snapshot wins" hides historical truth (the whole point of PAST-01 is "what the schedule looked like at time T").

**Why it happens:**
- `future_session_blocks` was designed as a per-snapshot mirror of the Wise FUTURE response. It has `wiseSessionId` but no unique constraint across snapshots (`src/lib/db/schema.ts:177-201`). It is not a historical record — it's a cache.
- Engineers often treat snapshots as interchangeable ("just pick one"), missing that snapshots are point-in-time captures with `active=true` atomic promotion (`src/lib/sync/orchestrator.ts`).

**How to avoid:**
- Design PAST-01 storage as a NEW table `past_session_blocks` (or similar), not a query on historical snapshots. Insert only on first observation (`ON CONFLICT DO NOTHING` keyed by `(wiseSessionId, scheduledStartTime)`). Never mutate.
- Alternative (smaller footprint): add an `observedInSnapshotIds uuid[]` column to dedupe by `wiseSessionId`. Returning a session's history = list of snapshots that observed it; returning canonical state = most recent snapshot that saw it.
- Either way: write a test that creates two snapshots observing the same `wiseSessionId`, runs the PAST-01 query, and asserts exactly ONE session returned with the canonical fields from the newest observation (plus issue markers if fields differ between snapshots).
- Re-use the snapshot index patterns already built: if past sessions are loaded at index-build time, don't create a per-query cross-snapshot JOIN (performance disaster — see Pitfall 5).

**Warning signs:**
- Integration test: open compare view on a tutor, see the same recurring past session rendered twice (one under each snapshot that observed it).
- `weeklyHoursBooked` doubles for past weeks without the tutor actually working more.
- `detectConflicts` produces false-positive same-student conflicts because the same session is in the list twice.

**Phase to address:** PAST-01 phase, Stage 1 (storage). Choose and document the dedup strategy BEFORE writing any query code.

---

### Pitfall 5 — PAST-01: Query-time JOIN across snapshots blowing past the 35-minute stale threshold and 300s function ceiling

**What goes wrong:**
If PAST-01 is implemented by querying `future_session_blocks WHERE groupId = ? AND startTime < now()` across all snapshots (not just `active=true`), the query scans every historical snapshot's blocks. At current data volume (one snapshot is ~thousands of rows; daily cron has been running since 2026-04-07), there are already 10+ snapshots. The in-memory SearchIndex rebuild (`src/lib/search/index.ts:110-267`) runs 6 parallel `SELECT * WHERE snapshotId = ?` queries against `active=true` — adding a "past sessions from all snapshots" query breaks the parallel-load pattern and can push index build past Vercel's 300s ceiling during cold start.

Worse: the daily sync's `revalidateTag('snapshot')` triggers a full index rebuild on next request. If the rebuild pulls multi-snapshot history, the first user after sync waits seconds for the page to load, and during that time all subsequent requests also wait (the `buildingPromise` singleton, `src/lib/search/index.ts:80-97`).

**Why it happens:**
- It's tempting to "just add a query" without considering the build-time cost on the singleton.
- `future_session_blocks` doesn't have an index on `(groupId, startTime)` — only `(snapshotId)` and `(snapshotId, weekday)`. A cross-snapshot query will seq-scan.

**How to avoid:**
- Materialize past sessions into a dedicated table with indexes on `(groupId, startTime)` and `(groupId, recurrenceId)` so PAST-01 can query it directly without joining across snapshots.
- Keep PAST-01 data OUT of the in-memory SearchIndex. Instead, fetch past sessions on-demand in `buildCompareTutor` (`src/lib/search/compare.ts:72-141`) when `dateRange` overlaps the past, and cache per-tutor with `'use cache' + cacheTag('snapshot')` similar to `src/lib/data/filters.ts` / `src/lib/data/tutors.ts`.
- Write a benchmark test that loads past sessions for 3 tutors × 12 weeks back and asserts `< 100ms` on warm cache. Fail CI if it regresses.
- Budget check: verify `buildIndex` stays under 2s on cold start before merging. Run on a snapshot with ≥30 days of historical data.
- If using daily cron + `revalidateTag`, run a canary after sync that cold-fetches `/search?tutors=a,b,c&week=PAST_WEEK` and asserts latency under a threshold (e.g. 1500ms p95).

**Warning signs:**
- Cold-start latency on `/search` rises from ~400ms to >1s.
- Sync job completes in >4m30s (recall: ~34s margin from `AGENTS.md:138`).
- `buildIndex` timing logs grow proportional to `snapshot count * avg sessions/snapshot`.

**Phase to address:** PAST-01 phase, Stage 2 (query). Explicitly called out in the phase plan: "past sessions must not enter the SearchIndex singleton; they are fetched lazily per-tutor with snapshot-tagged cache."

---

### Pitfall 6 — PAST-01: Weekday-fallback logic swallowing the new past-data truth

**What goes wrong:**
`src/lib/search/compare.ts:91-117` currently has a fallback: for weekdays with no sessions in the date range, it pulls the nearest future occurrence (deduped by `recurrenceId`). After PAST-01 ships, a past date range SHOULD return real past sessions — but the fallback still kicks in for any weekday the past-data query didn't cover (e.g., a one-off cancelled past session leaves a "gap"). The user sees a future session masquerading as a past fact.

**Why it happens:**
The fallback was added specifically to mitigate the "no past data" limitation. When past data becomes available, the fallback becomes a bug — but the code doesn't know that the date range is historical.

**How to avoid:**
- Pass a flag `isHistoricalRange: boolean` to `buildCompareTutor` (or derive it from `dateRange.end < now()`). When historical, DO NOT apply the nearest-future fallback — a gap is the truth.
- Add a test: past date range, no past sessions on Tuesday → `sessions` for Tuesday is empty (not padded with next Tuesday's session).
- Visual: for historical weeks, remove the implicit "sample schedule" UX cue — the week view should honestly reflect the past, including empty days.

**Warning signs:**
- User points at a compare view for last week and says "this Tuesday shouldn't have a session — I cancelled it."
- Integration test: historical week for tutor who was on leave shows sessions from the week after.

**Phase to address:** PAST-01 phase, Stage 2 (query + integration with existing compare engine). Requires coordinated change to `buildCompareTutor`, not isolated.

---

### Pitfall 7 — PAST-01: Stale-detection false positives because past data is snapshot-scoped

**What goes wrong:**
`ensureIndex()` (`src/lib/search/index.ts:272-296`) rebuilds the singleton when `active` snapshot changes. PAST-01 queries past sessions that DO NOT change when a new snapshot is promoted (past is past). But if past data is loaded eagerly at index-build time, it gets thrown away and reloaded every daily rebuild — wasting cold-start budget without benefit. Conversely, if past data is loaded lazily with `cacheTag('snapshot')`, a daily sync's `revalidateTag('snapshot')` invalidates the past-data cache too, forcing a refetch even though the data is immutable.

**Why it happens:**
- Existing cache strategy conflates "data may change" with "tag says snapshot." Past data is immutable (once observed, never changes), so it doesn't belong in the same cache namespace.

**How to avoid:**
- Give past-session data a separate cache tag, e.g. `cacheTag('past-sessions')`, that is NOT invalidated by the daily sync. Invalidate only on schema change or explicit admin action.
- Document the tag discipline in `src/lib/data/`: "`snapshot` tag → data that changes per sync; `past-sessions` tag → historical, changes only when new past observations are recorded."
- Write a test: after `revalidateTag('snapshot')`, fetching past sessions does NOT trigger a DB query (use a spy on `getDb()`).

**Warning signs:**
- Cold-start latency after daily sync is 2-3x higher than steady-state.
- Observability shows `getDb()` calls with `SELECT FROM past_session_blocks` firing on every request, not cached.

**Phase to address:** PAST-01 phase, Stage 2 (caching). Decide tag strategy alongside the storage decision — not as a polish pass.

---

### Pitfall 8 — VPOL-01: View transitions causing SSR/streaming flicker and defeating `cacheComponents`

**What goes wrong:**
Next.js 16's experimental `viewTransition` config ([Next.js docs](https://nextjs.org/docs/app/api-reference/config/next-config-js/viewTransition)) animates client-side navigations. BGScheduler's `/search` page is an async RSC with `cacheComponents: true` that streams filter options + tutor list via `'use cache'` (`src/lib/data/filters.ts:13-14`, `src/lib/data/tutors.ts:14-15`). When view transitions are enabled naively, three regressions stack:

1. **Flicker between streamed RSC and client-navigated state.** The server's initial render (streaming) completes before the client hydrates. If a `<ViewTransition>` boundary wraps a Suspense region, the transition can "snapshot" mid-stream, producing a flash of old → skeleton → new.
2. **Scroll restoration broken.** The GCal-style week view has an internal scroll container (`week-overview.tsx:293` `overflow-y-auto min-h-0`). View transitions that capture the whole document's scroll position lose the calendar's internal scroll (time-of-day vertical position).
3. **`cacheComponents` invalidation surprise.** If view transitions trigger a soft navigation with revalidation (e.g., `router.refresh`), cached RSC output is bypassed and a full server roundtrip happens — killing the "instant feel" v1.0 shipped.

**Why it happens:**
- View transitions are new in Next.js 16 (March 2026 release). The docs emphasize animation, not scroll/Suspense/cache interactions. Engineers copy a blog post, wrap the page, and don't test the Suspense/streaming flow.
- `prefers-reduced-motion` is supposed to auto-disable transitions ([Next.js view transitions guide](https://nextjs.org/docs/app/guides/view-transitions)) but only if the CSS is written correctly (`@media (prefers-reduced-motion: reduce) { animation-duration: 0s }`). A custom `::view-transition-*` CSS that forgets the media query ignores accessibility.

**How to avoid:**
- Scope view transitions to NAVIGATIONS the user explicitly initiates (week arrow clicks, day tab switches, fullscreen toggle), not to every re-render. Use React's `<ViewTransition>` component with an explicit `name` prop for the calendar region, and omit it for list-style panels.
- Do NOT wrap the async RSC `/search` page in a view transition boundary. Wrap the CLIENT-side interactive regions (`WeekOverview`, `CalendarGrid`, the tutor chip list) where the state change is purely client-side.
- Preserve internal scroll: capture `scrollTop` of the calendar container before transition and restore after. There is no built-in browser API for sub-document scroll restoration inside a view transition; write this manually in a `useEffect`.
- Add a media-query block: `@media (prefers-reduced-motion: reduce) { ::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*) { animation-duration: 0s !important; } }`. Lock this into the stylesheet alongside the transition definitions — don't let them live apart.
- Test with `cacheComponents: true` by performing a navigation while an RSC stream is still in-flight (throttle network to slow 3G). Assert: no double-render, no scroll jump, no revalidation storm.

**Warning signs:**
- "The calendar jumps to 7am every time I switch weeks" — scroll not restored.
- "The filter panel flickers when I click a result" — Suspense boundary inside a transition.
- Network tab shows two RSC requests for a single navigation — revalidation triggered unintentionally.
- VoiceOver users report "the whole page seems to re-announce" on navigation — focus management broken by the transition.

**Phase to address:** VPOL-01 phase, behind a feature flag (next.config `experimental.viewTransition`) gated by an a11y + streaming regression test. SHIP LAST of the VPOL trio so sticky legend + density overview aren't simultaneously moving targets.

**References:**
- [Next.js: Guides: View transitions](https://nextjs.org/docs/app/guides/view-transitions)
- [Next.js: viewTransition config](https://nextjs.org/docs/app/api-reference/config/next-config-js/viewTransition)
- [React 19.2 View Transitions with Next.js 16](https://www.digitalapplied.com/blog/react-19-2-view-transitions-animate-navigation-nextjs-16)
- v1.0 accessibility baseline: `.planning/PROJECT.md:38` (aria-labels, semantic tokens).

---

### Pitfall 9 — VPOL-02: Sticky tutor legend fighting the existing sticky lane headers in `week-overview.tsx`

**What goes wrong:**
`src/components/compare/week-overview.tsx:297` already has sticky lane headers: `sticky top-0 z-[5] flex bg-background/90 backdrop-blur-sm` inside the `overflow-y-auto` scroll container at line 293. Adding a "sticky tutor legend" above them introduces two overlapping sticky elements in the same scroll parent. Four failure modes:

1. **Stacking-context fight.** The existing legend uses `z-[5]`; `PopoverContent` uses `z-50` (line 523); `zIndex` on session cards uses `multiTutorLayout ? 1 : tutorIdx + 1` (line 485). A new sticky legend at `z-[10]` covers session popovers when they expand upward. Popovers render via a portal but still respect the trigger's stacking context in some combinations (especially when the trigger has a non-auto zIndex).
2. **Scroll-parent trap.** The scrollable ancestor is `div.flex-1.overflow-y-auto.min-h-0` (line 293). That's what both sticky headers "stick to." If the new legend is placed OUTSIDE this container but visually above it, it won't be sticky — it'll scroll with the page (which doesn't scroll because the page uses `overflow-hidden` at the body level, `.planning/PROJECT.md:95`).
3. **Fullscreen mode regression.** In fullscreen (`search-workspace.tsx:164-174`, class `w-full pl-0`), the compare panel expands to full viewport. The new legend must reflow — if pinned with a fixed width (e.g., `w-1/2`), it either clips or gets hidden.
4. **Position:sticky + overflow-hidden killer.** If anywhere in the ancestor chain `overflow-hidden` is applied (search-workspace line 124 does: `overflow-hidden min-h-0`), `position: sticky` silently fails — the sticky element scrolls normally with content ([CSS Tricks: Dealing with overflow and position: sticky](https://css-tricks.com/dealing-with-overflow-and-position-sticky/), [Polypane: all the ways position:sticky can fail](https://polypane.app/blog/getting-stuck-all-the-ways-position-sticky-can-fail/)).

**Why it happens:**
- The "add a sticky legend above the calendar" spec sounds trivial. It isn't — the existing layout has four nested containers (workspace → compare-panel → calendar-view-wrapper → week-overview) with different overflow and min-h-0 settings.
- `z-[5]` vs `z-50` vs `z-[10]` "magic numbers" drift apart across features. There's no z-index scale documented in the codebase.

**How to avoid:**
- Before coding, diagram the stacking-context tree from `search-workspace.tsx` down to `week-overview.tsx` session card. Explicitly note every `transform`, `opacity < 1`, `filter`, `backdrop-blur`, `z-index !== auto` — each creates a stacking context.
- Put the new tutor legend INSIDE `week-overview.tsx`, pinned to the same scroll ancestor as the existing `z-[5]` lane headers. Use `z-[6]` (one above lane headers), and verify popovers (`z-50` via portal) still paint on top. If not, increase popover portal z-index first.
- Document a z-index scale in `src/components/compare/session-colors.ts` (or new `z-index.ts`): `BASE_LANE=0`, `CONFLICT_BAND=0`, `FREE_GAP=0`, `SESSION=1-3`, `TODAY_INDICATOR=3`, `STICKY_LANE_HEADER=5`, `STICKY_TUTOR_LEGEND=6`, `POPOVER=50`, `DIALOG=50`. Reference from components.
- Write a Playwright/Vitest visual test that (a) scrolls the week view down, (b) opens a session popover, and asserts the popover renders above the sticky legend. Run in both normal and fullscreen modes.
- Verify the scroll ancestor: audit `overflow-hidden` in the chain. If any ancestor has it, the sticky element will not stick. Use the browser devtools's "Scroll offsets" to confirm.

**Warning signs:**
- In dev, scroll the week view down — legend does NOT stay at top → broken scroll parent.
- Open a session popover near the top of the visible calendar area — legend covers it.
- Switch to fullscreen — legend width doesn't match the now-wider calendar.
- Hover-tooltip (`title="..."` on button line 475) sometimes appears behind the legend because native tooltip z-index is not controllable.

**Phase to address:** VPOL-02 phase, with a required pre-implementation "stacking context audit" document (could be a markdown diagram in the plan). SHIP BEFORE VPOL-01 (view transitions) so transitions animate a known-good sticky setup, not a broken one.

**References:**
- Existing sticky header: `src/components/compare/week-overview.tsx:297` and `:103` in `calendar-grid.tsx`.
- Stacking-context primer: [Smashing Magazine: Unstacking CSS Stacking Contexts](https://www.smashingmagazine.com/2026/01/unstacking-css-stacking-contexts/).
- Dropdown/popover scroll-container traps: [Smashing Magazine: Dropdowns Inside Scrollable Containers](https://www.smashingmagazine.com/2026/03/dropdowns-scrollable-containers-why-break-how-fix/).
- Sticky failure modes: [Polypane: all the ways position:sticky can fail](https://polypane.app/blog/getting-stuck-all-the-ways-position-sticky-can-fail/).

---

### Pitfall 10 — VPOL-02: Sticky legend breaking `?tutors=` URL deep-link and chip-remove flow

**What goes wrong:**
The tutor legend is NOT just visual — it's interactive (mirrors the chips in `compare-panel.tsx:88-104`). If the legend duplicates chip state, two sources of truth exist. A user clicks "remove tutor" in the legend while `useCompare.removeTutor` (`src/hooks/use-compare.ts:166-176`) assumes the remove came from the chips: the legend state goes stale, or the `?tutors=` URL sync in `search-workspace.tsx:54-66` races the removal and writes a stale URL.

**Why it happens:**
Adding "a sticky legend" sounds visual, but admin-staff UX usually wants the legend to be actionable (remove, reorder, quick-jump). Treating it as display-only is the right call for v1.1 — but the next iteration will make it interactive, and the data flow must be designed now.

**How to avoid:**
- v1.1 scope: legend is display-only. It READS `compare.compareTutors` and `compare.tutorChips`; it does not call `removeTutor`, `addTutor`, etc. Enforce with TypeScript — legend props are `{tutors: TutorChip[]}` with no callbacks.
- If actions are added later (v1.2+), they MUST go through `useCompare` — no local state in the legend. Add an integration test: remove from chips, assert legend reflects; remove from legend (future), assert chips reflect.

**Warning signs:**
- PR review shows a `useState` in the legend component for local tutor order or visibility.
- Duplicated `onClick={() => removeTutor(id)}` between chips and legend without going through `useCompare`.

**Phase to address:** VPOL-02 phase, scope the component as display-only; schedule interactive features for v1.2 if requested.

---

### Pitfall 11 — VPOL-03: Density overview re-render churn via shared compare state

**What goes wrong:**
The density overview (mini-map) shows tutor density across a ~180-day horizon. If implemented as a child of `ComparePanel` reading the same `compareResponse` via `useCompare`, it re-renders every time the compare panel does — on every chip add/remove, week change, fullscreen toggle. For 3 tutors × 180 days × some density bucket (e.g., 20 minute blocks × 14 hours/day = 42 buckets/day = 7,560 cells × 3 tutors = 22,680 cells), naive render cost is noticeable (10-50ms) and re-rendering on every parent state change drops compare-panel interactions to sluggish.

**Why it happens:**
- `useCompare` returns the full state object; any consumer re-renders on any field change. The density overview doesn't care about `activeDay`, `discoveryOpen`, `prefillConflict`, etc., but will re-render on them.
- `useMemo` is not enough — the memo depends on `compareResponse` which is a new object reference on every fetch.

**How to avoid:**
- Density data is NOT currently in `compareResponse`. Add a separate API (`POST /api/compare/density`) that returns just per-tutor density buckets for the 180-day range. Cache client-side with its own key: `densityCache.current.get(tutorGroupId)`.
- Render the density overview from a dedicated hook: `useDensity(tutorGroupIds)` that only re-fetches when the tutor ID set changes — not on `activeDay` or `discoveryOpen`.
- Memoize the density rendering with `React.memo` and compare props by tutor IDs (not object identity). Since density is a static-per-snapshot view, this is safe.
- If rendering 22k cells is too expensive, use a `<canvas>` with imperative drawing (batched rAF paints). DOM-based rendering hits the React reconciler cost ceiling above ~5k nodes on admin-laptop hardware.
- Benchmark: 3 tutors × 180 days, first paint < 150ms, subsequent re-renders on `activeDay` change < 16ms (single frame). Use React Profiler.

**Warning signs:**
- Chip add/remove feels laggy after density ships (React DevTools shows density re-rendering with same props).
- Scrolling the week view drops frames when the mini-map is visible.
- Memory profile shows growing retained heap after 10 navigations.

**Phase to address:** VPOL-03 phase. The shape of the density view is TBD (`.planning/PROJECT.md:91`) — the phase plan MUST commit to (a) separate API, (b) separate cache, (c) canvas vs DOM decision, (d) React.memo boundary, BEFORE building.

---

### Pitfall 12 — VPOL-03: Density view a11y — color-only encoding of density failing WCAG

**What goes wrong:**
Density overviews typically use color gradient (e.g., light-to-dark blue) to encode "sessions per hour." Admin staff with color-vision deficiency cannot distinguish density levels. Screen-reader users get nothing at all — a visualization without text alternatives.

**Why it happens:**
- Design decks (e.g., the density deck rejected in v1.0.1) show density via gradient without spec'ing the a11y affordance.
- The app's semantic color tokens (`--available`, `--blocked`, etc. per `.planning/PROJECT.md:94`) don't include "density levels" — engineers improvise with `bg-primary/10`, `bg-primary/30`, etc.

**How to avoid:**
- Pair color with a secondary encoding: text (e.g., session count in tooltip), pattern (dots, stripes) for high-density cells, or height (bar chart instead of heatmap).
- Provide aria-label on each density cell: `aria-label="Monday 10am-11am: 2 sessions booked, 1 tutor available"`. Expensive for 22k cells — use a roving aria-label via `aria-describedby` that updates on focus/hover, not per-cell.
- Support keyboard navigation: arrow keys within the density grid, Enter to drill down to that date. Maintain the keyboard-nav contract from v1.0 (`.planning/PROJECT.md:35`).
- Respect `prefers-reduced-motion` — no pulsing/animating density transitions.
- Cross-check v1.0 Phase 04 a11y items still pending (`POLISH-01..05`) — ship density overview ONLY AFTER those are verified in production, so the accessibility baseline is known-good.

**Warning signs:**
- Lighthouse a11y score drops on `/search` after density ships.
- Screen reader transcript of the compare panel has no announcement for the density region.
- Manual colorblind-mode test (browser devtools emulation) shows density cells indistinguishable.

**Phase to address:** VPOL-03 phase, with a mandatory a11y checklist item in the plan: aria-label strategy, keyboard nav, prefers-reduced-motion, colorblind test. Also — block VPOL-03 on `POLISH-01..05` (Phase 04 human QA items) being verified first.

---

### Pitfall 13 — Cross-feature: Regressing `detectConflicts` case-insensitivity when modality confidence is added to session blocks

**What goes wrong:**
`src/lib/search/compare.ts:143-180` (`detectConflicts`) keys conflict detection on `studentName.toLowerCase()`. When MOD-01 adds fields to `CompareSessionBlock` (`modality`, `modalityConfidence`), a careless refactor switches from `toLowerCase()` string keys to object-equality keys that inadvertently include the new fields. Conflict detection suddenly misses overlaps because `{studentName: "Alex", modality: "online"}` doesn't equal `{studentName: "Alex", modality: "onsite"}`.

**Why it happens:**
- Adding new fields to a shared type invites "richer" key composition.
- The conflict detection test (`src/lib/search/__tests__/compare.test.ts`) tests presence of overlaps — if all test sessions have the same modality, a field-leak regression passes tests silently.

**How to avoid:**
- `detectConflicts` keys MUST remain name-based (student name only). Add a lint/review rule: `detectConflicts` input type is intentionally NOT typed as `CompareSessionBlock` — define a `ConflictCandidate` interface with only `studentName`, `weekday`, `startMinute`, `endMinute`, `tutorIdx` fields.
- Add a test: same student, different modality across two tutors at overlapping times → still a conflict.

**Warning signs:**
- After MOD-01 ships, compare panel shows zero conflicts for a student that v1.0 flagged.

**Phase to address:** MOD-01 phase regression suite — extend existing `compare.test.ts` conflict cases with `modality` variation assertions.

---

### Pitfall 14 — Cross-feature: Client-side tutor cache not invalidating when density view adds new data shapes

**What goes wrong:**
`useCompare.tutorCache` (`src/hooks/use-compare.ts:84`) is keyed by `tutorGroupId:weekStart` and stores `CompareTutor`. If VPOL-03 or PAST-01 extends `CompareTutor` with new fields (e.g., `densityBuckets: number[]` or `pastSessions: CompareSessionBlock[]`) but the cache key doesn't include those, stale cached tutors missing the new fields are served. Snapshot invalidation (`use-compare.ts:124-134`) handles DB-side changes but not client-schema migrations.

**Why it happens:**
- Cache keys rarely evolve when the stored value's shape does. Engineers assume TypeScript catches this — but a cached `CompareTutor` at runtime is whatever was there last time, not what the new type says.
- No cache version in the key.

**How to avoid:**
- Add a cache version constant: `const CACHE_VERSION = "v1";` → key becomes `${tutorGroupId}:${weekStart}:${CACHE_VERSION}`. Bump on any shape change.
- At hydration (browser load), invalidate any cache entries (there are none — tutorCache is `useRef`, in-memory only — but add the discipline for the day this moves to localStorage/sessionStorage).
- Test: mount `useCompare`, populate cache, mount again with new CACHE_VERSION → cache is empty.

**Warning signs:**
- After deploy, users with long-lived tabs see a mixture of old-shape and new-shape tutor data.
- Density cells render for newly-added tutors but not for cached ones.

**Phase to address:** MOD-01, PAST-01, and VPOL-03 phases — whichever ships first should add the CACHE_VERSION constant; subsequent phases bump it.

---

### Pitfall 15 — Scope creep: v1.0 polish items (POLISH-01..16) getting lumped into feature phases instead of a dedicated drain

**What goes wrong:**
POLISH-01..16 is a mix of a11y verification (`01..05`), code hygiene (`06..14`), and UAT (`15..16`). If scattered across MOD-01/PAST-01/VPOL phases, they either block feature work (engineer in MOD-01 phase gets stuck on unrelated "M3: `?week=` regex strictness") or get silently deferred. v1.0 audit (`v1.0-MILESTONE-AUDIT.md:123-152`) explicitly flags these; a partial drain across feature phases leaves the audit chain incomplete.

**Why it happens:**
- Tech-debt items feel small enough to "just slip in" while editing adjacent code.
- `POLISH-02 (midnight crossover)` and `POLISH-10` (M2) touch `week-overview.tsx` — the same file VPOL-02 edits. Tempting to combine.

**How to avoid:**
- Dedicate a Phase to POLISH-01..16 drain, ordered EARLY so a11y baseline (POLISH-01..05) is verified before VPOL-02/03 build on it. Do NOT interleave.
- Explicit dependency: VPOL-03 (density a11y) depends on POLISH-01..05 verified. State this in the roadmap.
- The one exception: POLISH-14 (remove unused `TutorSelector`) is a zero-cost change — can land in any phase's prep commit.

**Warning signs:**
- PR with title "MOD-01: add isOnlineVariant" includes 10 unrelated polish changes.
- Phase audit asks "did POLISH-04 (skeleton proportions) land?" and no one knows which phase touched it.

**Phase to address:** Create a dedicated POLISH drain phase FIRST in the v1.1 roadmap. Sequencing recommendation: POLISH drain → MOD-01 → PAST-01 → VPOL-02 (sticky legend) → VPOL-03 (density) → VPOL-01 (view transitions LAST).

---

## Technical Debt Patterns

Shortcuts that seem reasonable but create long-term problems.

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Default modality to `"onsite"` when signals ambiguous | Fewer "Needs Review" rows → UI looks cleaner | Breaks fail-closed rule; users make wrong assumptions; upstream data-quality issues hidden from data-health dashboard | **Never** — violates `AGENTS.md:146-149`. |
| Query past sessions via cross-snapshot UNION at request time | No new table, no migration | Double-counts sessions; blows past 300s function timeout as snapshot count grows; stale-tag invalidates immutable data | Only for a <1 week debug/prototype window, with a TODO marked for PAST-01 storage migration. |
| Wrap the entire `/search` page in `<ViewTransition>` | Simplest way to enable transitions everywhere | Breaks RSC streaming, scroll restoration, Suspense coordination, and `cacheComponents` | Never for streaming RSC pages. |
| Use literal z-index values (`z-[6]`, `z-50`) per component | Fast to write | Drift creates stacking-context bugs that only manifest when features combine | Only for one-off components with no sticky/fixed siblings. |
| Re-use `CompareTutor` shape for density buckets | One type to maintain | Client cache serves stale-shape data; React renders more often than needed | Never — density is a separate concern, deserves its own type + API + cache. |
| Skip `VERIFICATION.md` because integration check "covers it" | Faster phase completion | Audit chain has a hole; next milestone has to retroactively verify (`v1.0-MILESTONE-AUDIT.md:124-128`) | Only if integration-checker is ALSO named as verifier in the archive — not worth the confusion. |
| Add sticky legend above existing sticky lane headers with ad-hoc `z-index` | "Done in 10 lines" | Hidden popovers, broken fullscreen mode, inaccessible content | Never without a stacking-context audit. |
| Re-enable dashed-border "online" visual the moment MOD-01 ships | Visual signal is "free" | Low-confidence cases get falsely confident styling → worse than no signal | Never — gate visual on `modalityConfidence` grading. |
| Put density data in `compareResponse` | Fewer API endpoints | Every chip/week/day re-render re-renders density at 22k cells | Never — separate endpoint + separate cache. |
| Keep stale `REQUIREMENTS.md` checkboxes (`v1.0-MILESTONE-AUDIT.md:88-92`) | No time spent on housekeeping | Traceability rotted → future audits have to reconstruct requirement status | Only if `/gsd-complete-milestone` auto-marks them (which it does) — the debt is self-clearing. |

---

## Integration Gotchas

Common mistakes when connecting to external services and existing subsystems.

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Wise API `sessionType` | Assume field is always present; default missing to `"onsite"` | `sessionType?: string` in types (`src/lib/wise/types.ts:63`); treat `undefined` as signal absence → feeds MOD-01 fail-closed path. |
| Wise API `isOnlineVariant` (via teacher record) | Treat as session-level fact | It's a record-level fact; for paired groups, corroborate with `sessionType` before labeling a session. |
| Wise FUTURE API | Assume it returns past sessions on a retry | It doesn't (`AGENTS.md:113`, `PROJECT.md:122`). PAST-01 must use snapshot-based storage, not API replay. |
| Neon Postgres `future_session_blocks` | Treat rows from any snapshot as interchangeable | Rows are snapshot-scoped; cross-snapshot semantics need explicit dedup by `wiseSessionId`. |
| `revalidateTag('snapshot')` | Assume invalidates everything cache-related on the page | Only invalidates entries tagged `snapshot`. Past-session data should have its own tag to avoid churn. |
| Next.js `cacheComponents: true` | Assume cache is per-user or per-session | It's per-(route + props + cache-tag). A bad cache key leaks data between users. Verify every `'use cache'` function has tenant-scoped inputs if needed. (Current BGScheduler is single-tenant per snapshot → safe, but document.) |
| React View Transitions | Wrap whole page | Wrap client-side region only; exclude RSC streaming boundaries. |
| `position: sticky` in compare panel | Ignore scroll-parent chain | Audit every ancestor's `overflow` — `overflow-hidden` on any ancestor silently breaks sticky. |
| `<PopoverContent>` in scroll containers | Rely on component's default z-index | Portal-rendered popovers still lose to new stacking contexts — verify z-index in situ. |

---

## Performance Traps

Patterns that work at small scale but fail as usage grows.

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Loading past sessions into `SearchIndex` on rebuild | Cold-start latency grows daily; sync run approaches 300s ceiling | Keep past data out of the singleton; fetch per-tutor via `'use cache'` with dedicated tag | ~30 days after PAST-01 ships (roughly every 30 snapshots' worth of accumulated past data). |
| Rendering 22k density cells as DOM nodes | Scroll jank, input lag in compare panel | `<canvas>` + requestAnimationFrame, or bucket at day-level (180 cells) instead of 20-min-level | 3 tutors × 180 days at 20-min bucket; breaks at first render on hardware below M1-class. |
| Re-fetching past sessions on every `revalidateTag('snapshot')` | Latency spike after every daily sync | Separate `cacheTag('past-sessions')` that sync doesn't invalidate | First deploy after PAST-01 ships; noticed when cron runs. |
| View-transition capture of entire document | Scroll jump to top on every navigation; dropped frames on streaming RSC | Scope transitions to named regions only; custom scroll restoration inside calendar scroll container | Immediately on VPOL-01 ship if unscoped. |
| `detectConflicts` O(n²) across selected tutors' sessions | Compare panel hangs for tutors with many sessions | Fine at `max 3 tutors × ~40 sessions/week = 120 pairs`. If expanding beyond 3 tutors, switch to student-indexed map (already done in `compare.ts:145-154`). | Only if max-tutor cap raised above 3. |
| Unmemoized `compare` object in effect deps (v1.0 M1, M4 finding) | `history.replaceState` fires every render | `useCallback` + memoize compare sub-objects; POLISH-08 addresses | Already present in v1.0; idempotent so not breaking — but a latent trap when a non-idempotent effect is added. |
| Rebuilding SearchIndex per-request (not singleton) | Every API call takes seconds | Already solved via globalThis singleton (`src/lib/search/index.ts:76-97`); don't regress by importing `buildIndex` directly | Only if a refactor accidentally bypasses `ensureIndex`. |

---

## Security Mistakes

Domain-specific security issues beyond general web security.

| Mistake | Risk | Prevention |
|---------|------|------------|
| Expose past student names on `/api/compare` for historical weeks without re-checking admin allowlist | PII leak if session expires mid-usage | Every endpoint already goes through `src/middleware.ts` auth — preserve that. Add an explicit auth check in the PAST-01 past-session fetcher too; don't bypass with `/api/internal/*` shape. |
| Cache past-session data at the CDN (e.g., via `Cache-Control: public`) | Student names served to unauthenticated users | Use `Cache-Control: private, no-store` on any response carrying student data; validate header in route handler. Verify v1.0 routes: `POST /api/compare` is POST, not cached at CDN — preserve. |
| Log student names in sync orchestrator or error logs | PII in logs (retained longer than necessary) | `console.error` in routes returns `{error: err.message}` — audit sync/normalization layers to confirm student names aren't in error strings. |
| Store `recurrenceId` across snapshots without realizing it's a Wise-internal ID | Potentially correlate students across leaves/vacations | Low risk (admin-only tool) but document: `recurrenceId` is stable per recurring series; treat as PII-adjacent. |
| Allow `CRON_SECRET` to be guessable | Unauthorized snapshot promotion | Already required to be strong env var (`AGENTS.md:172`) — verify it rotates; don't log it on boot. |

---

## UX Pitfalls

Common user experience mistakes in this domain.

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| MOD-01 shows "online" label confidently for a session admin knows is misfiled in Wise | User trusts the tool less | Confidence badge (`?` icon for `medium`/`low`), popover explaining the signals used. |
| PAST-01 silently falls back to nearest-future session for gaps in past data | User believes the past week had a session that actually didn't | On historical weeks, render gaps as empty; add a subtle "?" with "no data recorded for this day" tooltip. |
| View transitions animate too slowly for admin power-users who switch weeks constantly | Staff find the tool slower than v1.0 (reverse goal) | Default duration ≤ 200ms; respect `prefers-reduced-motion`; allow opt-out via localStorage flag. |
| Sticky tutor legend covers a row that user wants to read | Legend becomes an obstacle, not an aid | Auto-hide on scroll-down, reveal on scroll-up (GitHub-style), OR keep minimal height (≤ 20px) so coverage is tolerable. |
| Density mini-map uses color alone for density | Color-blind staff can't use it | Secondary encoding: tooltip count, pattern, height. Test with browser colorblind emulation. |
| Sticky legend + sticky lane headers + today indicator all at top → visual clutter | Cognitive load spike; "where am I?" confusion | Coalesce into a single sticky container; lane-header names + tutor chips inline. |
| Popovers open over the sticky legend (z-index fight) | User clicks a session, popover appears "behind" → feels broken | Explicit z-index scale document (see Pitfall 9); visual regression test. |
| Fullscreen mode forgets scroll position when exiting | User loses context | Preserve scroll across fullscreen toggle; write a targeted test. |

---

## "Looks Done But Isn't" Checklist

Things that appear complete but are missing critical pieces.

- [ ] **MOD-01:** Per-session modality is labeled — but `modalityConfidence` is exposed, honored by visual renderers, and fail-closed Needs Review still fires for low-confidence cases. Verify via a test matrix that explicitly includes `isOnlineVariant=true` + `sessionType="onsite"` (contradiction) → `unknown` + data_issue.
- [ ] **MOD-01:** Visual restoration of dashed-border "online" cards is gated on confidence. Verify by snapshotting `week-overview.tsx` with a mixed dataset.
- [ ] **PAST-01:** Past sessions display — and weekday-fallback is disabled for historical ranges. Verify by opening a week-in-the-past where the tutor had no sessions; assert no nearest-future fallback content appears.
- [ ] **PAST-01:** Past-session data uses dedicated cache tag — verify `revalidateTag('snapshot')` does not refetch past sessions (spy on DB call).
- [ ] **PAST-01:** Cross-snapshot dedup — verify by creating a fixture with two snapshots observing the same `wiseSessionId` and asserting one row returned.
- [ ] **PAST-01:** `detectConflicts` and `weeklyHoursBooked` don't double-count across snapshots — regression test required.
- [ ] **VPOL-01:** View transitions work — AND `prefers-reduced-motion` disables them AND scroll restoration in the calendar container is intact AND `cacheComponents` streaming doesn't flicker. Manual QA across two browsers.
- [ ] **VPOL-01:** Keyboard nav (ArrowLeft/Right in `search-workspace.tsx:68-85`) doesn't produce double-transitions. Verify by holding the key.
- [ ] **VPOL-02:** Sticky legend stays sticky in fullscreen mode. Verify by toggling fullscreen and scrolling.
- [ ] **VPOL-02:** Session popovers render ABOVE the sticky legend. Verify by opening popovers at the very top of the visible area.
- [ ] **VPOL-02:** The existing sticky lane headers (line 297) still work — no overlap, no z-index fight. Verify by scrolling the multi-tutor week view.
- [ ] **VPOL-02:** Legend is display-only (no `useState`, no callbacks) — verify via TypeScript props shape.
- [ ] **VPOL-03:** Density view has aria-label per cell OR a roving aria-described-by. Verify with a screen reader.
- [ ] **VPOL-03:** Colorblind emulation test (deuteranopia, protanopia, tritanopia) passes — density levels remain distinguishable.
- [ ] **VPOL-03:** Canvas-based rendering is off the React reconciler path (if chosen). Verify Profiler shows density renders under 16ms after first paint.
- [ ] **VPOL-03:** Density view is behind its own cache, not `compareResponse`. Verify by adding a chip and asserting density data doesn't refetch.
- [ ] **POLISH drain:** All 5 human-QA items (POLISH-01..05) verified in production before VPOL-03 ships. Sign-off recorded.
- [ ] **Cross-feature:** CACHE_VERSION constant landed with the first v1.1 shape-changing feature, bumped on subsequent ones. Verify by grepping for the constant and confirming a code comment exists explaining the bumping rule.
- [ ] **Cross-feature:** Tests grow to 246 + N_new; no existing tests deleted or skipped. Verify `npm test` output.
- [ ] **Cross-feature:** Sync duration monitored after PAST-01 ships; if > 4m40s, escalate (margin only ~34s per `AGENTS.md:138`).

---

## Recovery Strategies

When pitfalls occur despite prevention, how to recover.

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| MOD-01 fail-closed regression (silently labels unknown as onsite) | LOW | Revert the `return "onsite"` line to `return "unknown"`; push hotfix. Add test retroactively. Document in milestone archive. |
| MOD-01 visual dashed-border re-introduced without confidence gating | LOW | Revert the visual change; keep data-layer changes. |
| PAST-01 double-counted sessions after deploy | MEDIUM | Roll back the past-session fetch endpoint; disable the feature flag; fix dedup; re-ship. No data corruption (past data is read-only). |
| PAST-01 sync duration exceeds 300s | HIGH | Revert storage/fetch changes. Investigate whether bulk-insert chunking (`orchestrator.ts:31 INSERT_CHUNK_SIZE`) needs adjustment. Consider Vercel Pro for 600s ceiling. |
| PAST-01 `revalidateTag('snapshot')` invalidating past cache | LOW | Switch to dedicated `'past-sessions'` tag; deploy; warm cache by re-fetching. |
| VPOL-01 view transitions breaking scroll restoration | LOW | Disable `viewTransition` flag in `next.config.ts`; re-enable after per-region scoping. |
| VPOL-01 a11y regression (reduced-motion ignored) | LOW | Add the `@media (prefers-reduced-motion)` CSS block; re-deploy. |
| VPOL-02 sticky legend covers popover | MEDIUM | Adjust z-index scale; re-verify with visual test. If root cause is stacking context on an ancestor, may require layout restructure (higher cost). |
| VPOL-02 sticky breaks in fullscreen | LOW | Conditional classes on `isFullscreen`; add fullscreen to visual test matrix. |
| VPOL-03 density performance regression | MEDIUM | Switch DOM → canvas (if not already); reduce bucket resolution (20-min → hourly); deploy. |
| VPOL-03 accessibility violation caught after ship | HIGH | Depending on severity, emergency hotfix adding aria-labels and patterns; worst case, hide the density view behind a flag until fixed. |
| Cross-feature client cache stale after shape change | LOW | Bump CACHE_VERSION; deploy. Long-lived tabs auto-invalidate. |
| Phase skips VERIFICATION.md (per v1.0 M1 pattern) | LOW | Retroactive verifier run; archive document update. |

---

## Pitfall-to-Phase Mapping

How roadmap phases should address these pitfalls.

| # | Pitfall | Prevention Phase | Verification |
|---|---------|------------------|--------------|
| 1 | MOD-01 fail-closed bypass | MOD-01, stage 1 | Test matrix in `compare.test.ts` asserting `unknown` for ambiguous cases; `data_issues` count monitoring post-deploy. |
| 2 | `isOnlineVariant` trusted as session-level fact | MOD-01, stage 2 | `modalityConfidence` field + test for paired groups with contradictory signals. |
| 3 | Visual regression of v1.0 border removal | MOD-01, stage 3 | Visual test of mixed-confidence dataset; only `high`/`medium` get distinction. |
| 4 | Cross-snapshot session double-count | PAST-01, stage 1 | Dedup test fixture with duplicate `wiseSessionId` across snapshots. |
| 5 | Cross-snapshot query blowing function timeout | PAST-01, stage 2 | Benchmark test; cold-start latency budget (<2s); synchronous sync-duration monitoring. |
| 6 | Weekday fallback hiding past truth | PAST-01, stage 2 | `isHistoricalRange` flag in `buildCompareTutor` + empty-gap test. |
| 7 | Past-data cache invalidated by daily sync | PAST-01, stage 2 | Dedicated `'past-sessions'` cacheTag; spy test confirms no DB call after `revalidateTag('snapshot')`. |
| 8 | View transitions breaking streaming/scroll/cache | VPOL-01 (LAST) | Media query for `prefers-reduced-motion`; scroll-restoration test; streaming flicker manual QA. |
| 9 | Sticky legend fighting existing sticky lane headers | VPOL-02 (BEFORE VPOL-01) | Pre-implementation stacking-context audit; visual regression test in normal + fullscreen; popover-above-legend test. |
| 10 | Sticky legend state duplication | VPOL-02 | TypeScript enforcement (display-only props); integration test for chip-legend sync. |
| 11 | Density re-render churn | VPOL-03 | Separate API + separate cache; React.memo boundary; 16ms re-render budget. |
| 12 | Density a11y (color-only encoding) | VPOL-03 (AFTER POLISH-01..05) | Secondary encoding; colorblind emulation; screen-reader transcript review. |
| 13 | `detectConflicts` modality field leak | MOD-01 | Test: same student + different modality across tutors → still a conflict. |
| 14 | Client cache shape drift | First v1.1 shape-changing phase (likely MOD-01) | CACHE_VERSION constant + comment. |
| 15 | POLISH items scattered across phases | Dedicated POLISH phase FIRST | Phase-audit check that POLISH items land in their own commits/phase. |

### Suggested Phase Ordering

Based on the pitfall dependencies above:

1. **POLISH drain** (POLISH-01..16) — establishes a11y baseline, clears v1.0 debt, prevents future phases building on unverified polish.
2. **MOD-01** — reliable online/onsite detection. Introduces `modalityConfidence` + CACHE_VERSION. Most test-heavy phase; gets fresh test discipline momentum going.
3. **PAST-01** — past-day session visibility. Requires separate storage + cache tag decisions. Heavier data-layer work.
4. **VPOL-02** — sticky tutor legend. Low surface area, stable sticky configuration before transitions animate it.
5. **VPOL-03** — density overview. Depends on a11y baseline (POLISH-01..05) being verified.
6. **VPOL-01** — view transitions LAST. Animates a known-good UI; lowest risk of interacting with partly-built features.

---

## Sources

- **Code inspected (in-repo, commit `9e3e4ad` baseline):**
  - `src/lib/normalization/modality.ts` — existing group-level fail-closed logic
  - `src/lib/search/compare.ts` — session-level modality heuristic (to be upgraded by MOD-01)
  - `src/lib/search/index.ts` — in-memory SearchIndex singleton, stale detection
  - `src/lib/search/engine.ts` — fail-closed Needs Review routing
  - `src/lib/sync/orchestrator.ts` — ETL pipeline, atomic promotion, 300s function budget
  - `src/lib/db/schema.ts` — snapshot-scoped tables, `isOnlineVariant` column, `future_session_blocks` indexes
  - `src/components/compare/week-overview.tsx` — existing sticky lane headers (line 297), z-index usage
  - `src/components/compare/calendar-grid.tsx` — second sticky header (line 103)
  - `src/components/compare/compare-panel.tsx` — fullscreen toggle, compare panel composition
  - `src/components/search/search-workspace.tsx` — workspace-level `overflow-hidden`, URL sync, keyboard nav
  - `src/hooks/use-compare.ts` — client-side tutor cache, snapshot invalidation
  - `src/lib/data/filters.ts`, `src/lib/data/tutors.ts` — `'use cache' + cacheTag('snapshot')` pattern
- **Project docs:**
  - `AGENTS.md` (non-negotiable product rules; fail-closed; sync duration margin)
  - `.planning/PROJECT.md` (v1.1 scope, constraints, v1.0 context)
  - `.planning/milestones/v1.0-MILESTONE-AUDIT.md` (accepted tech debt, outstanding human-QA items)
- **Framework references:**
  - [Next.js 16 View Transitions Guide](https://nextjs.org/docs/app/guides/view-transitions)
  - [Next.js 16 viewTransition config](https://nextjs.org/docs/app/api-reference/config/next-config-js/viewTransition)
  - [React 19.2 View Transitions with Next.js 16](https://www.digitalapplied.com/blog/react-19-2-view-transitions-animate-navigation-nextjs-16)
  - [Next.js 16 Cache Components Guide](https://vercel.com/academy/nextjs-foundations/cache-components)
  - [Next.js cacheComponents config](https://nextjs.org/docs/app/api-reference/config/next-config-js/cacheComponents)
  - [Smashing Magazine: Unstacking CSS Stacking Contexts (Jan 2026)](https://www.smashingmagazine.com/2026/01/unstacking-css-stacking-contexts/)
  - [Smashing Magazine: Dropdowns Inside Scrollable Containers (Mar 2026)](https://www.smashingmagazine.com/2026/03/dropdowns-scrollable-containers-why-break-how-fix/)
  - [Polypane: All the ways position:sticky can fail](https://polypane.app/blog/getting-stuck-all-the-ways-position-sticky-can-fail/)
  - [CSS-Tricks: Dealing with overflow and position: sticky](https://css-tricks.com/dealing-with-overflow-and-position-sticky/)
  - [MDN: position CSS property](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/properties/position)

---

*Pitfalls research for: BGScheduler v1.1 — Data Fidelity & Depth milestone*
*Researched: 2026-04-20*
*Confidence: HIGH (code-grounded for MOD-01, PAST-01, VPOL-02); MEDIUM (VPOL-01 depends on implementation shape; VPOL-03 depends on final design)*
