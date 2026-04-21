# Phase 7: PAST-01 Past-Day Session Visibility - Context

**Gathered:** 2026-04-22
**Status:** Ready for planning

<domain>
## Phase Boundary

Capture Wise sessions that expire out of the FUTURE API into a durable, snapshot-independent `past_session_blocks` table via a daily-sync diff-hook, and teach the compare read path to merge captured past data with live future data so prior-week compare views show real past-day sessions instead of the nearest-future weekday-fallback. Wise historical-sessions endpoint spike (`devs@wiseapp.live`) runs in parallel; DB-snapshot fallback ships unconditionally regardless of spike outcome.

**In scope:** PAST-01..06 (6 requirements) — `past_session_blocks` schema + migration, orchestrator diff-hook with `ON CONFLICT DO NOTHING`, new `src/lib/data/past-sessions.ts` cached fetcher with dedicated `cacheTag('past-sessions')`, per-weekday `isHistoricalRange` evaluation in `buildCompareTutor`, `/api/compare` server-side trigger for historical ranges, CACHE_VERSION bump `"v1"` → `"v2"`, Wise-spike email draft, PAST-06 result documentation.

**Out of scope (explicit):** Multi-snapshot diff view (PAST-07, v1.2). Source-of-truth badge on past-day cards (PAST-08, v1.2). Wise historical-endpoint wiring even if Wise responds "yes" during Phase 7 (SPK-03 — defer to v1.2 to protect scope). Any SearchIndex/`buildIndex` changes (past data stays OUT of singleton per research Pitfall 5). Visual distinction between past and future session cards (UX-02 keeps them identical). Admin UI for managing past-session retention. Capture-start date indicators in UI (D-11, v1.2+). Migration-time or lazy backfill (D-02 — empty-forward only).

</domain>

<decisions>
## Implementation Decisions

### Capture strategy

- **D-01:** **Prior-snapshot diff** is the detection method for the daily-sync diff-hook. On each sync, BEFORE promotion, the orchestrator compares the most-recently-active snapshot's `future_session_blocks` to the newly-fetched Wise FUTURE session list. Sessions that (a) existed in the prior snapshot, (b) have `startTime < now()` at sync time (Asia/Bangkok), and (c) are NOT in the new Wise response get inserted into `past_session_blocks` with `ON CONFLICT (wise_session_id) DO NOTHING`. Deterministic, incremental, matches Wise's "drop from FUTURE" semantics exactly. Catches exactly what Wise drops without sweep overhead.
- **D-02:** **Empty-forward backfill only.** `past_session_blocks` starts empty on migration; accumulates as daily-sync cycles run. Day-1 admins viewing past weeks see honest empty cells (per D-09). NO migration-time backfill from existing historical snapshots. NO lazy backfill on query. Accepts the ~7–30 day sparse-history window before steady-state.
- **D-03:** **First-observation wins, `ON CONFLICT DO NOTHING`.** `UNIQUE(wise_session_id)` enforces idempotency; the first snapshot to observe a session sets canonical fields (`student_name`, `location`, `session_type`, `title`, `subject`, `class_type`, `recurrence_id`, etc.). Subsequent observations silently drop. No `conflict_model` data_issue emission on drift — past data is treated as immutable once captured. Satisfies PAST-05 idempotency requirement directly.
- **D-04:** **Schema key: `group_canonical_key text` + nullable `group_id uuid`.** Denormalize the stable `tutor_identity_groups.canonical_key` into `past_session_blocks` so rows survive snapshot rotation — this is the cross-snapshot identity anchor required by PAST-05. `group_id` remains for the snapshot that captured the row (useful for provenance + per-sync queries) but is nullable because snapshots can be pruned in principle. Read path resolves identity via `group_canonical_key` lookup against the active snapshot's `tutor_identity_groups`.

### Historical-range boundary (read path)

- **D-05:** **Per-weekday `isHistoricalRange` evaluation** in `buildCompareTutor`. For each weekday in the requested `dateRange`, compute the actual calendar date and check if it is before `startOfToday(Asia/Bangkok)`. Days that are in the past disable the existing weekday-fallback for themselves (honest empty if no data captured); today + future days keep the existing weekday-fallback behavior. Handles the common case of "current week with elapsed Monday" correctly — Monday shows captured past data (or honest empty) while Friday still falls back for empty weekdays.
- **D-06:** **Merge past + future inside `buildCompareTutor` BEFORE the weekday-fallback step.** A new cached server fetcher (e.g., `src/lib/data/past-sessions.ts`) queries `past_session_blocks` for the relevant `(group_canonical_key, dateRange)` tuple. The returned blocks are unioned with the `IndexedTutorGroup.sessionBlocks` already in memory BEFORE the filter/fallback logic executes. Downstream logic (`detectConflicts`, `findSharedFreeSlots`, `weeklyHoursBooked`, `studentCount`) consumes a single unified session list — transparent extension, no signature changes to downstream functions.
- **D-07:** **Server-side trigger in `/api/compare`.** The route handler computes the weekday-date map from `dateRange.start` → `dateRange.end`; if any day is before `startOfToday(Asia/Bangkok)`, it calls the cached past-sessions fetcher before invoking `buildCompareTutor`. Client stays dumb — no new request parameter, no changes to `useCompare` other than the CACHE_VERSION bump (D-17). Trigger applies consistently regardless of `fetchOnly` incremental-fetch semantics.
- **D-08:** **`cacheTag('past-sessions')` + `cacheLife('days')`** on the past-sessions fetcher. Past-session data is immutable once captured (D-03); `'days'` cacheLife keeps warm cache across multiple daily-sync runs, drastically reducing DB pressure for historical queries. `cacheTag('past-sessions')` is **SEPARATE** from `'snapshot'` — the daily sync's existing `revalidateTag('snapshot')` MUST NOT invalidate past-sessions cache (matches research Pitfall 7). Explicit `revalidateTag('past-sessions')` is reserved for schema migrations or admin action.

### Empty-day UX

- **D-09:** **Honest empty cells** for historical days with no captured sessions. The day column in both `week-overview.tsx` and `calendar-grid.tsx` renders blank — no card, no marker icon, no placeholder text. Matches "gap is the truth" (research Pitfall 6). Zero visual churn vs. the current behavior for unbooked days. No tooltip is added in v1.1.
- **D-10:** **Past-session cards render IDENTICAL to future-session cards.** Same background tint (28% opacity), same 3px solid left border, same typography, same modality icon (inherited from Phase 6 MOD-01 `resolveSessionModality` — past cards go through the same resolver). No opacity dim, no "past" badge, no grayscale. Consistent reading experience across weeks; users infer "this is the past" from the week picker label/date context.
- **D-11:** **No capture-start date indicator in v1.1.** No footer banner, no per-week completeness badge, no explanatory tooltip. Plain honest-empty for pre-capture-start days. Accepted FAQ concern for a handful of admin users; lean on release notes + admin word-of-mouth to communicate. Can be added later if users ask.
- **D-12:** **Wording reserved: "No sessions recorded."** Since D-09 chose no marker/tooltip, this phrasing is moot for v1.1. Captured here as the neutral wording to use if a marker is introduced in a future phase. Do NOT use "No sessions this day" (ambiguous) or "Historical data not captured" (leaky implementation detail).

### Wise endpoint spike (PAST-06)

- **D-13:** **Claude drafts the email; user sends.** Phase 7 plan (likely Plan 01 or a dedicated spike plan) includes a concise email draft in a code block — recipient `devs@wiseapp.live`, subject mentioning BG Education + the `begifted-education` namespace, concise question about historical-sessions endpoint availability, auth contract, pagination shape, and quota implications. User reviews and sends from `kevhsh7@gmail.com`.
- **D-14:** **Spike runs in parallel with planning.** Email goes out during the Phase 7 planning phase (after CONTEXT.md committed, before/during execution begins). DB fallback implementation proceeds unconditionally on its own timeline. No blocking, no waiting.
- **D-15:** **If Wise responds "yes, we have an endpoint" during Phase 7, document the response and defer wiring to v1.2.** Response gets captured in a new artifact (e.g., `.planning/phases/07-*/07-WISE-RESPONSE.md` or as a comment in STATE.md). Phase 7's deliverable REMAINS the DB fallback only. A v1.2 phase (candidate: PAST-07 repurposed, or a new PAST-09) handles the endpoint wiring as a secondary capture source layered on the stable `past_session_blocks` table. Protects Phase 7 scope from mid-execution expansion.
- **D-16:** **No cutoff — Phase 7 ships unconditionally.** Spike is parallel and non-blocking. Wise response is handled by whichever phase is open when it arrives (could be Phase 7 execution tail, Phase 8, or v1.2). If no response ever arrives, PAST-06 is closed out in Phase 7 verification as "unreachable — DB fallback is sole source."

### Cross-cutting / carrying forward from Phase 6

- **D-17:** **CACHE_VERSION bump `"v1"` → `"v2"`.** Update `src/lib/search/cache-version.ts` from `"v1"` → `"v2"` as part of this phase (likely as the first or final commit). Required by Phase 6 D-19 contract: "Future v1.1 phases (PAST-01, VPOL-03) MUST bump this alongside their shape change." PAST-01 extends the session block shape in-memory (past blocks merged with future blocks; downstream may add provenance fields in v1.2). Bumping invalidates all long-lived client tabs' `tutorCache` entries, preventing stale-shape hydration issues. Update the file-level comment to document the v1→v2 migration.
- **D-18:** **Past data stays OUT of the SearchIndex singleton.** `buildIndex` / `ensureIndex` in `src/lib/search/index.ts` is UNTOUCHED. Past sessions are fetched per-request via the new cached fetcher, never loaded eagerly at index build time. Preserves the ~34s sync-duration margin and the <2s cold-start budget. Matches research Pitfall 5 mitigation directly.

### Claude's Discretion

The following are explicitly left to the planner / executor — no user decision needed:

- **Drizzle migration shape** — exact column names, types, default values, and indexes for `past_session_blocks`. Minimum indexes required: `UNIQUE(wise_session_id)` for idempotency (D-03); `(group_canonical_key, start_time)` for the compare read path (D-06); potentially `(start_time)` for time-range scans. Planner picks naming convention per existing schema (snake_case columns, camelCase Drizzle object).
- **Exact placement of the diff-hook within `orchestrator.ts`** — likely a new step between step 9 (derive modality) and step 10 (atomic promotion), or step 8.5 between future-session write and modality derivation. Planner chooses based on transaction boundaries and error handling patterns already used in the file.
- **Sync-duration monitoring strategy** — whether to add a `diffHookDurationMs` field to `sync_runs.metadata` or just log to console. Planner's call; sync duration is already close to the 300s ceiling (~34s margin) so some observability is warranted.
- **Whether to emit a `completeness` data_issue when the diff-hook captures zero past sessions** — e.g., a sync run where no sessions expired (rare but possible on low-activity days). Lean toward **no** for first ship; add as a v1.2 observability improvement if useful.
- **Edge case: session cancelled after capture** — current D-03 says first-observation wins with no drift handling. If a later snapshot observes that a captured session was retroactively cancelled (via `wiseStatus` change), the past row stays as originally captured. Planner can add a note to the migration/README but no behavioral change in Phase 7.
- **Test-matrix composition** — planner picks Vitest cases covering: (a) diff-hook correctly captures dropped-from-FUTURE sessions, (b) `ON CONFLICT DO NOTHING` handles same `wise_session_id` across snapshots, (c) per-weekday `isHistoricalRange` (D-05) correctly splits a mixed current week into past+future behaviors, (d) `buildCompareTutor` merges past+future transparently without double-counting, (e) `detectConflicts` and `findSharedFreeSlots` behave correctly with merged session list, (f) `cacheTag('past-sessions')` survives `revalidateTag('snapshot')` (spy on DB call count).
- **PAST-06 email text** — Claude drafts; user may edit before sending. Keep it short (≤150 words), factual, include the institute ID for context.
- **Whether to add a small admin-only utility route for manually triggering `revalidateTag('past-sessions')`** (useful during schema migrations or if a bug requires a cache flush). Lean toward **not needed in v1.1**; can be added later as a `GET /api/internal/revalidate-past-sessions` with `CRON_SECRET` protection if ever required.
- **Commit cadence** — atomic per-concern is fine and matches phase 5/6 style. Suggested split: (1) schema migration + Drizzle types, (2) orchestrator diff-hook, (3) past-sessions cached fetcher, (4) `buildCompareTutor` per-weekday flag + merge, (5) `/api/compare` server-side trigger, (6) CACHE_VERSION bump + use-compare cache-key audit, (7) test matrix, (8) Wise spike email draft artifact.

### Folded Todos

No GSD todos surfaced for Phase 7 (todo match returned 0). The STATE.md pending todo "Wise historical-sessions endpoint spike to `devs@wiseapp.live`" is already captured as PAST-06 and addressed by D-13..D-16 above.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope & requirements

- `.planning/REQUIREMENTS.md` §History — PAST-01..06 specifications (canonical phrasing for each requirement)
- `.planning/REQUIREMENTS.md` §Traceability — PAST-01..06 all mapped to Phase 7
- `.planning/ROADMAP.md` §"Phase 7: PAST-01 Past-Day Session Visibility" — 5 success-criteria truths that must become true
- `.planning/STATE.md` §Accumulated Context — "Phase 7 data-layer only" decision + Wise historical endpoint advisory flag

### Project constraints

- `.planning/PROJECT.md` §Constraints — no stack changes, fail-closed non-negotiable, 669 tests must continue passing
- `.planning/PROJECT.md` §Context — performance budgets: sync duration ~4m26s (~34s margin below 300s ceiling); cold-start <2s
- `.planning/PROJECT.md` §"Known limits" — "Past-day sessions unavailable from Wise FUTURE API" (the problem PAST-01 closes)
- `AGENTS.md` §"Non-Negotiable Product Rules" — fail-closed rule (applies: honest empty > misleading fallback)
- `AGENTS.md` §"Source of Truth Rules" — tenant `begifted-education`, institute `696e1f4d90102225641cc413` (needed for PAST-06 email)
- `AGENTS.md` §"Known Issues (open)" §Past-day session data — describes the current weekday-fallback limitation PAST-01 closes
- `CLAUDE.md` §"Known Issues (open)" — "Wise's `status: "FUTURE"` API does not return past sessions" — the root problem

### Research intelligence (HIGH confidence, code-grounded)

- `.planning/research/SUMMARY.md:57` — "Past-session storage — new `past_session_blocks` table (NOT snapshot-scoped; keyed `UNIQUE(wise_session_id)` + `group_canonical_key` stable across snapshots) + new helper `src/lib/data/past-sessions.ts` + orchestrator diff-hook"
- `.planning/research/SUMMARY.md:96-100` — full Phase-3 (now Phase 7) plan sketch
- `.planning/research/SUMMARY.md:133-134,158` — Wise historical-sessions endpoint spike context
- `.planning/research/PITFALLS.md#pitfall-4` — cross-snapshot session double-counting; dedup strategy (D-03 chose first-observation-wins)
- `.planning/research/PITFALLS.md#pitfall-5` — cross-snapshot JOIN blowing 300s ceiling; keep past OUT of SearchIndex (D-18)
- `.planning/research/PITFALLS.md#pitfall-6` — weekday-fallback swallowing past-data truth (D-05 per-weekday resolution)
- `.planning/research/PITFALLS.md#pitfall-7` — stale-detection false positives; dedicated `cacheTag('past-sessions')` (D-08)
- `.planning/research/PITFALLS.md#pitfall-13` — `detectConflicts` must stay name-based even when session shape grows (applies: past sessions merged into same conflict detection)
- `.planning/research/PITFALLS.md#pitfall-14` — CACHE_VERSION discipline (D-17 bump)
- `.planning/research/PITFALLS.md` §"Looks Done But Isn't" (PAST-01 section) — 4-item checklist the planner should codify as test cases

### Prior phase context (CACHE_VERSION + modality contract)

- `.planning/phases/06-mod-01-reliable-modality-detection/06-CONTEXT.md` §Decisions D-17..D-20 — CACHE_VERSION constant contract; PAST-01 MUST bump (D-17 in this doc satisfies D-19 there)
- `.planning/phases/06-mod-01-reliable-modality-detection/06-CONTEXT.md` §Decisions D-01..D-08 — `resolveSessionModality` contract; past sessions go through the SAME resolver (D-10 visual identity requires this)
- `.planning/phases/06-mod-01-reliable-modality-detection/06-CONTEXT.md` §"Reusable Assets" — `resolveSessionModality` already handles the confidence grading; past-session modality icons are free-inherited

### Source code — data layer (THE integration surface)

- `src/lib/search/compare.ts:7-11` — `DateRange` interface (read by `buildCompareTutor`; dateRange is the primary trigger for D-05/D-07)
- `src/lib/search/compare.ts:60-135` — `resolveSessionModality` (past sessions call this identically — D-10)
- `src/lib/search/compare.ts:188-233` — `buildCompareTutor` function + weekday-fallback block at lines 204-233 — **THE refactor target for D-05 (per-weekday flag) + D-06 (merge past+future before fallback)**
- `src/lib/search/compare.ts:235-246` — session block → CompareSessionBlock mapping (past sessions flow through this unchanged)
- `src/lib/search/compare.ts:263-300` — `detectConflicts` (must stay name-based per research Pitfall 13; will consume merged past+future list transparently)
- `src/lib/search/compare.ts:302-346` — `findSharedFreeSlots` (must subtract past session blocks from availability; already uses `dateRange` filter at lines 319-322)
- `src/lib/search/index.ts` — SearchIndex singleton; **NO changes** (D-18 keeps past data out)
- `src/lib/search/types.ts` — `CompareSessionBlock`, `CompareTutor` types; minor extension may be needed if provenance field added (planner's call)
- `src/lib/db/schema.ts:177-201` — `futureSessionBlocks` table — source for the diff-hook in D-01 (prior snapshot rows are the diff input)
- `src/lib/db/schema.ts:78-100` — `tutorIdentityGroups` + `tutorIdentityGroupMembers` — `canonicalKey` column at line 81 is the stable key D-04 denormalizes into `past_session_blocks`
- `src/lib/db/schema.ts:22-29` — `dataIssueTypeEnum` — `completeness` type is what the planner would use IF deciding to emit observability data_issues per Claude Discretion
- `src/lib/sync/orchestrator.ts:253-293` — session fetch + `futureSessionBlockRows` write (diff-hook inserts BEFORE this write completes OR after — planner decides)
- `src/lib/sync/orchestrator.ts:440-463` — atomic promotion (diff-hook MUST run BEFORE the new snapshot becomes active, otherwise the "prior snapshot" reference breaks)
- `src/app/api/compare/route.ts:46-139` — compare API route — **target for D-07 server-side trigger** at lines 97-114 where `dateRange` and `weekdays` are computed; insert historical-range evaluation before `buildCompareTutor` loop at line 108

### Source code — cache & client

- `src/lib/data/filters.ts` — `"use cache"` + `cacheTag("snapshot")` + `cacheLife("hours")` pattern — **reference implementation** for the new past-sessions fetcher, but adjust tag → `'past-sessions'` and life → `'days'` per D-08
- `src/lib/data/tutors.ts` — same pattern, second reference
- `src/lib/search/cache-version.ts:13` — `export const CACHE_VERSION = "v1";` — **bump to `"v2"` per D-17**
- `src/hooks/use-compare.ts:140,145,170` — `tutorCache.current.set/get/delete` call sites; all three use `${tutorGroupId}:${week}:${CACHE_VERSION}` composite key; no code change needed here (bumping the constant invalidates transparently)

### Source code — UI (read-path only; NO visual changes in Phase 7)

- `src/components/compare/week-overview.tsx` — week view; past cards render via the SAME code path as future cards (D-10); empty-day logic already renders nothing when `sessions` for that weekday is empty (D-09)
- `src/components/compare/calendar-grid.tsx` — day drill-down; same
- `src/components/compare/session-colors.ts` — shared card styling; **NO changes** (D-10 identical treatment)
- `src/components/compare/week-overview.tsx` + `calendar-grid.tsx` — session card rendering with modality icon; inherits Phase 6 MOD-04 HelpCircle / Video / MapPin icons for past sessions automatically

### Testing surfaces

- `src/lib/search/__tests__/compare.test.ts` — existing test for `buildCompareTutor`, `detectConflicts`, `findSharedFreeSlots`; extend here per Claude Discretion test-matrix (a)–(f)
- `src/lib/sync/__tests__/` — orchestrator tests if they exist (planner greps to confirm); new diff-hook test case
- `src/lib/data/__tests__/` — new file `past-sessions.test.ts` for the cached fetcher behavior including `cacheTag` survival through `revalidateTag('snapshot')`
- `src/__tests__/` — integration test directory if a higher-level integration test for /api/compare with historical range is warranted

### Operations / Commands

- `CLAUDE.md` §"Running Commands" — `npm run db:generate` for migration + `DATABASE_URL=... npm run db:migrate` for apply; sync trigger `curl -X POST .../api/internal/sync-wise -H "Authorization: Bearer $CRON_SECRET"` for manual sync during testing

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- **`'use cache' + cacheTag + cacheLife` pattern** at `src/lib/data/filters.ts:12-16` and `src/lib/data/tutors.ts:13-16` — **direct blueprint** for the new `src/lib/data/past-sessions.ts` fetcher. Same three-line cache block, just with `cacheTag('past-sessions')` and `cacheLife('days')` per D-08.
- **`resolveSessionModality`** at `src/lib/search/compare.ts:60-135` (Phase 6) — past sessions go through this unchanged; modality icons + confidence grading inherited for free. D-10 identical visual treatment.
- **`IndexedTutorGroup.sessionBlocks` + `buildCompareTutor` filter pipeline** at `compare.ts:194-202` — filters by `isBlocking`, `dateRange`, and `weekdaySet` in sequence. Merging past blocks means concatenating them into `group.sessionBlocks` scope BEFORE line 194 (or injecting into the filter input). Planner picks signature: new parameter `pastBlocks: IndexedSessionBlock[]` or extend `IndexedTutorGroup` temporarily at the call site.
- **Drizzle migration toolchain** — `drizzle.config.ts`, `npm run db:generate`, migrations in `drizzle/` — well-understood from Phase 5/6 work; no new config needed.
- **`ON CONFLICT DO NOTHING`** pattern — Drizzle supports `.onConflictDoNothing()` on insert builders; compact and idempotent, required for D-03.
- **`detectSessionModalityConflict`** at `compare.ts:148-186` and its call site at `orchestrator.ts:355-386` — same pattern the diff-hook follows (iterate prior-snapshot rows, compare against new state, emit rows to a target table). Structural reference for the new diff-hook.

### Established Patterns

- **`snapshotId`-scoped tables everywhere else** (tutors, future_session_blocks, etc.) make `past_session_blocks` the ONLY cross-snapshot table — explicitly documented in D-04. Planner should add a code comment at the schema declaration noting this deviation.
- **Atomic snapshot promotion** at `orchestrator.ts:440-463` — diff-hook MUST run BEFORE this block; the hook reads "prior snapshot" which must still be `active=true` when the hook runs, so the hook must complete before the new snapshot gets promoted.
- **`insertInChunks` helper** at `orchestrator.ts:34-42` with `INSERT_CHUNK_SIZE = 250` — diff-hook should use this for `past_session_blocks` inserts to respect Neon's connection budget.
- **`completeness` data_issue type** at `schema.ts:26` — available if the planner decides to emit a data_issue when the diff-hook produces zero captured sessions (Claude Discretion).
- **Error isolation per-teacher** in `orchestrator.ts:240-250` — per-teacher errors don't abort sync; diff-hook should follow the same pattern (a query failure on one canonical_key shouldn't break the whole sync).

### Integration Points

- **Orchestrator diff-hook location** — new step between current step 8 (session fetch, line 253) and step 10 (atomic promote, line 440). Suggest step 9.5 after `groupSupportedModality` population (line 300) so `group_canonical_key` is accessible from the same data structure.
- **`buildCompareTutor` parameter extension** — either add `pastBlocks?: IndexedTutorGroup["sessionBlocks"]` as a new parameter (clean), or preload past blocks into `IndexedTutorGroup.sessionBlocks` at the `/api/compare` route boundary before calling `buildCompareTutor` (more invasive but keeps the signature stable).
- **`/api/compare` route integration** at `route.ts:108` — the `allCompareTutors` map call is where to inject the past-sessions merge. Before mapping, compute per-day historicalness from `dateRange`; if any day is historical, fetch `past_session_blocks` by `(group_canonical_key, dateRange)` for all indexedGroups (batch-fetch by canonical-key array is more efficient than per-group); then pass results into `buildCompareTutor`.
- **CACHE_VERSION bump** at `src/lib/search/cache-version.ts:13` — single-line change; no other code changes needed because `use-compare.ts` already uses the constant at all three cache-key call sites.
- **No UI file changes** — `week-overview.tsx` and `calendar-grid.tsx` render whatever `CompareResponse.tutors[].sessions[]` contains. Past sessions merged in via D-06 flow to these renderers transparently (D-10).

</code_context>

<specifics>
## Specific Ideas

- **"Honest empty is the truth"** — user repeatedly endorsed the fail-closed philosophy across Phase 5, 6, and now 7. Empty cells (D-09) over fallback-with-tag over ghost cards. Applies also to day-1 UX (D-02 empty-forward).
- **"Past cards look exactly like future cards"** — user's visual-consistency preference (memory: `user-preferences.md` visual-consistency P0) directly informs D-10. No opacity dim, no badge, no grayscale. Relies on week picker context to communicate "this is the past."
- **"Ship the DB fallback unconditionally"** — user's stance on the Wise spike (D-14..D-16) is clear: the spike is a parallel curiosity, not a gate. DB fallback is the deliverable. If Wise responds positively, document and defer wiring to v1.2 (D-15) rather than risk Phase 7 scope expansion.
- **"Claude drafts, user sends" for the email** — matches the user's preference for minimal ceremony (memory: POLISH Drain "one prod-site sitting" style). User keeps the Wise relationship; Claude provides the boilerplate.
- **Per-weekday historical flag (D-05)** is the one deviation from research Pitfall 6's "fully historical" recommendation — user explicitly preferred handling current-week-with-elapsed-days correctly. Record this deviation so the planner doesn't "simplify" back to the binary flag.
- **Client stays dumb (D-07)** — server derives historical-ness from `dateRange`. No changes to the `/api/compare` request body shape. CACHE_VERSION bump handles long-lived tab invalidation. Minimal client surface area, consistent with v1.0 architecture choice to keep business logic server-side.

</specifics>

<deferred>
## Deferred Ideas

- **PAST-07 (multi-snapshot diff view showing session changes over time)** — v1.2 territory per REQUIREMENTS.md §v1.2+. PAST-01 lays the schema (D-04 canonical_key denormalization) that PAST-07 would read from.
- **PAST-08 (source-of-truth badge on past-day cards, e.g., snapshot vs. live endpoint origin)** — v1.2 territory. Depends on Wise historical endpoint being available (PAST-06 outcome) AND user opting into visual provenance markers.
- **Wise historical-endpoint wiring** — even if Wise responds "yes" during Phase 7, D-15 defers wiring to v1.2 to protect Phase 7 scope. A new v1.2 phase (candidate: PAST-09 or PAST-07 repurposed) handles this.
- **Migration-time backfill** — explicitly rejected in D-02. If users strongly request "show me last month even though we didn't capture it," could be revisited as a one-shot admin script in v1.2 (pulls from remaining historical snapshots).
- **Lazy backfill on first historical query** — also rejected in D-02. Would add per-range population complexity with cache-coherency edge cases; not worth it for an admin-only tool with 8 users who will accumulate data naturally.
- **Capture-start date indicator in UI** (D-11 deferred) — small muted footer note or per-week completeness badge. Reconsider in v1.2 if admins ask "why is old data sparse."
- **Empty-day tooltip / marker icon** (D-09 deferred) — reserved wording "No sessions recorded" (D-12) applies if a future phase adds a visible indicator.
- **Past-session visual distinction (dim, badge)** (D-10 deferred) — explicitly rejected for v1.1 per user visual-consistency preference.
- **Drift detection on re-observed sessions** (D-03 deferred) — e.g., a later snapshot sees a captured session as cancelled. D-03 keeps first-observation immutable; no drift flag. Could add a `completeness` or new `past_drift` data_issue type in v1.2 if useful for data-quality investigation.
- **Admin utility for manual cache flush** — `GET /api/internal/revalidate-past-sessions` behind `CRON_SECRET`. Not needed v1.1; add if a future migration or bug requires it.
- **Diff-hook observability (per-sync capture count, duration)** — planner's discretion. Lean toward simple console log in v1.1; consider persisting to `sync_runs.metadata` in a v1.2 observability pass.
- **`past_session_blocks` retention / pruning policy** — no pruning in v1.1. Table grows unbounded (admin-scale: 8 users × ~100 sessions/week × 52 weeks ≈ 40k rows/year, trivial for Neon). Revisit if ever >1M rows.

### Reviewed Todos (not folded)

None — todo match returned 0 results for Phase 7. STATE.md's "Wise historical-sessions endpoint spike" is already captured as PAST-06 in REQUIREMENTS.md and addressed by D-13..D-16.

</deferred>

---

*Phase: 07-past-01-past-day-session-visibility*
*Context gathered: 2026-04-22*
