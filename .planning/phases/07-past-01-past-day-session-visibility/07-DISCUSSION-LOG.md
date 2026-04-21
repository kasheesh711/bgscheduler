# Phase 7: PAST-01 Past-Day Session Visibility - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-22
**Phase:** 07-past-01-past-day-session-visibility
**Areas discussed:** Capture strategy, Historical-range boundary, Empty-day UX, Wise spike (PAST-06)

---

## Gray-Area Selection

| Option | Description | Selected |
|--------|-------------|----------|
| Capture strategy | How/when daily sync writes into past_session_blocks (diff-hook method, backfill, dedup, schema key) | ✓ |
| Historical-range boundary | When isHistoricalRange kicks in (per-weekday vs fully historical), read-path stitching, cache-tag strategy | ✓ |
| Empty-day UX | Visual treatment of historical days with no captured data | ✓ |
| Wise spike (PAST-06) | Coordination of devs@wiseapp.live email spike, timing, cutoff | ✓ |

**User's selection:** All four areas.
**Notes:** User chose to engage with every gray area rather than skip any — consistent with Phase 6 discussion depth.

---

## Capture strategy

### Q1: How should the daily sync detect sessions that expired out of Wise's FUTURE list?

| Option | Description | Selected |
|--------|-------------|----------|
| Prior-snapshot diff (Recommended) | Compare yesterday's future_session_blocks to today's Wise FUTURE response; insert sessions that existed yesterday, have startTime<now, and are gone today. Deterministic, incremental. | ✓ |
| Prior-snapshot time-sweep | Dump ALL rows from the most recent prior snapshot where startTime<now(). UNIQUE(wise_session_id) handles dedup. Simpler query. | |
| Hybrid (diff + sweep) | Diff first (fast path), then sweep prior snapshot for stragglers. Most defensive. ~2x capture work per sync. | |

**User's choice:** Prior-snapshot diff (Recommended)
**Notes:** Aligns with research SUMMARY.md line 57 and Pitfall 4; deterministic, matches Wise drop semantics exactly, respects sync duration budget (~34s margin).

### Q2: What should past_session_blocks contain on day 1 after deploy?

| Option | Description | Selected |
|--------|-------------|----------|
| Empty forward (Recommended) | past_session_blocks starts empty; accumulates as sync cycles run. Day-1 users see empty past weeks. Simple, low-risk. | ✓ |
| Migration-time backfill | One-shot sweep of all existing snapshots where startTime<now(); populate past_session_blocks in migration. More complete day-1 history. | |
| Lazy backfill on query | On first historical query, check prior snapshots and populate. Amortizes cost; first-per-range slower. | |

**User's choice:** Empty forward (Recommended)
**Notes:** Accepts ~7–30 day sparse-history window; avoids migration-time double-counting risk; relies on D-09 honest empty cells to render gracefully.

### Q3: How should we handle the same wise_session_id observed in multiple snapshots?

| Option | Description | Selected |
|--------|-------------|----------|
| First-obs wins, ON CONFLICT DO NOTHING (Recommended) | UNIQUE(wise_session_id) + ON CONFLICT DO NOTHING. First snapshot to observe sets canonical fields; subsequent observations silently dropped. | ✓ |
| observedInSnapshotIds uuid[] array | Upsert keyed by wise_session_id; every snapshot that observed it appends to the array. Debugging-friendly. | |
| First-wins + conflict_model data_issue on drift | First observation canonical; later observations with differing fields emit conflict_model data_issue. Audit trail. | |

**User's choice:** First-obs wins, ON CONFLICT DO NOTHING (Recommended)
**Notes:** Simplest implementation, matches research Pitfall 4 guidance directly. Treats past data as immutable once captured. Drift detection deferred to v1.2 if ever needed.

### Q4: How should past_session_blocks reference tutor identity across snapshot rotations?

| Option | Description | Selected |
|--------|-------------|----------|
| canonical_key text column + nullable groupId (Recommended) | Denormalize stable group_canonical_key into past_session_blocks. groupId stays for capture-time snapshot. Satisfies PAST-05. Simple schema delta. | ✓ |
| Separate canonical groups table | New tutor_identity_groups_canonical (one row per canonical_key); past_session_blocks FKs to it. Cleanest RI but wider schema change. | |
| JOIN via canonical_key at read time | Store only wise_session_id + wise_teacher_id in past_session_blocks. Read path joins through tutor_identity_group_members. No denormalization. | |

**User's choice:** canonical_key text column + nullable groupId (Recommended)
**Notes:** Minimal schema delta; survives snapshot rotation directly; nullable groupId preserves capture-time provenance without breaking referential integrity.

---

## Historical-range boundary

### Q1: How should 'historical range' be defined for disabling the weekday-fallback?

| Option | Description | Selected |
|--------|-------------|----------|
| Per-weekday (Recommended) | For each weekday in the requested range, check if that specific day is before today (Asia/Bangkok). Past days get NO fallback; today + future days keep fallback. Most honest. | ✓ |
| Fully historical week | isHistoricalRange = (dateRange.end < startOfToday BKK). Only fully-past weeks disable fallback. Current week with elapsed days still falls back. Matches Pitfall 6. | |
| Any past day triggers | isHistoricalRange = (dateRange.start < startOfToday BKK). Current week AND past weeks disable fallback. Aggressive cut-off. | |

**User's choice:** Per-weekday (Recommended)
**Notes:** Explicit deviation from research Pitfall 6's binary flag — user preferred correctness over simplicity for the "current week with elapsed Monday" case. This deviation is documented in CONTEXT.md §Specific Ideas so the planner doesn't "simplify" back.

### Q2: How should past_session_blocks rows be stitched into the compare response?

| Option | Description | Selected |
|--------|-------------|----------|
| Merge in buildCompareTutor (Recommended) | buildCompareTutor queries past_session_blocks (via cached fetcher) and unions with SearchIndex's future_session_blocks BEFORE weekday-fallback. Downstream transparent. | ✓ |
| Separate response field | CompareResponse.tutors[].pastSessions as sibling field; UI merges on render. More surface area. | |
| New /api/compare/past route | Historical queries go to a distinct route; client decides. Double wire format and client logic. | |

**User's choice:** Merge in buildCompareTutor (Recommended)
**Notes:** Keeps downstream signatures stable (detectConflicts, findSharedFreeSlots, weeklyHoursBooked, studentCount all transparent). Matches research ARCHITECTURE #2.

### Q3: When should /api/compare trigger a past_session_blocks fetch?

| Option | Description | Selected |
|--------|-------------|----------|
| Server-decides based on dateRange (Recommended) | Server computes: if any day in dateRange is before startOfToday BKK, call the cached past-sessions fetcher. Client stays dumb. | ✓ |
| Client passes isHistorical flag | Client computes isHistorical and sends it. Server trusts the flag. Smaller server cost for future-only. | |
| Always fetch past-sessions | Every /api/compare call queries past_session_blocks even for future-only weeks. cacheTag makes repeat cheap. | |

**User's choice:** Server-decides based on dateRange (Recommended)
**Notes:** No new request parameter; keeps client surface minimal; consistent with server-side business logic preference from v1.0 architecture.

### Q4: cacheLife for the past-sessions 'use cache' fetcher?

| Option | Description | Selected |
|--------|-------------|----------|
| 'days' (Recommended) | Past sessions immutable after capture; 'days' cacheLife keeps warm cache across daily sync runs. cacheTag('past-sessions') allows explicit invalidation. | ✓ |
| 'hours' | Matches filters.ts/tutors.ts pattern. Safer but refetches more than needed for immutable data. | |
| 'max' | Long-lived cache. Relies entirely on explicit revalidateTag for invalidation. Most efficient but brittle. | |

**User's choice:** 'days' (Recommended)
**Notes:** Matches research Pitfall 7 "invalidate only on schema change or explicit admin action"; balances efficiency with manageable cache-tag discipline.

---

## Empty-day UX

### Q1: What should a historical day with zero captured sessions render?

| Option | Description | Selected |
|--------|-------------|----------|
| Honest empty cell (Recommended) | Day column renders blank — no card, no marker, no text. Matches 'gap is the truth' (Pitfall 6). Zero visual churn. | ✓ |
| Subtle '?' marker with tooltip | Tiny HelpCircle icon in day column + tooltip 'No sessions recorded'. Signals awareness without implying tutor didn't work. | |
| Inline muted text | 'No sessions recorded' in muted gray text. More explicit but uses vertical space. | |
| Ghost card outline | Dashed-outline empty card with 'no data' label. More visual weight; risks GCal-principle conflict. | |

**User's choice:** Honest empty cell (Recommended)
**Notes:** Strongest alignment with fail-closed philosophy and v1.0 GCal principles. Zero new UI primitives. Wording (Q4) reserved for future phase if a marker is ever added.

### Q2: Should past-session cards be visually distinguished from future-session cards?

| Option | Description | Selected |
|--------|-------------|----------|
| Identical to future cards (Recommended) | Past and future render identical styling (28% bg opacity, 3px left border). Modality icon applies to both. Zero visual churn. | ✓ |
| Subtle dim (85% opacity) | Past cards at ~85% opacity. Soft 'historical' cue. Adds visual distinction without new pattern. | |
| Small 'past' badge on card | Tiny badge signaling captured-from-past_session_blocks vs. live. Maximum provenance; most visual change. | |

**User's choice:** Identical to future cards (Recommended)
**Notes:** Matches user's standing visual-consistency preference (memory: `user-preferences.md` visual-consistency P0). Users infer "past" from week picker context.

### Q3: Should the UI surface when past-session capture started (e.g., PAST-01 deploy date)?

| Option | Description | Selected |
|--------|-------------|----------|
| Not in v1.1 (Recommended) | Plain honest-empty for pre-capture-start days; no footer or banner. Avoids clutter. | ✓ |
| Footer note on historical weeks | Small muted text below calendar: 'Past-session capture started YYYY-MM-DD'. Explains gaps. | |
| Per-week completeness badge | 'N/7 days captured' badge in week picker. Most informative but most UI change. | |

**User's choice:** Not in v1.1 (Recommended)
**Notes:** 8-admin user base can absorb the FAQ via release notes + word-of-mouth; defer feature if feedback requests it.

### Q4: Wording for the empty-historical-day tooltip/text (if any)?

| Option | Description | Selected |
|--------|-------------|----------|
| 'No sessions recorded' (Recommended) | Neutral, honest. Doesn't claim 'tutor didn't work' but also doesn't blame the system. | ✓ |
| 'Historical data not captured' | Explicit about the capture gap. Better for pre-capture-start days but leaky implementation detail. | |
| 'No sessions this day' | Shortest but ambiguous — conflates 'no sessions happened' with 'we don't have data'. | |

**User's choice:** 'No sessions recorded' (Recommended)
**Notes:** Moot for v1.1 since D-09 chose no marker/tooltip. Captured as reserved wording for any future phase that introduces an indicator.

---

## Wise spike (PAST-06)

### Q1: How should the Wise historical-endpoint email spike run?

| Option | Description | Selected |
|--------|-------------|----------|
| Claude drafts, user sends (Recommended) | Claude writes concise email in Phase 7 plan; user sends from kevhsh7@gmail.com. Minimal Claude action. | ✓ |
| User has existing contact | User already has active Wise thread; coordinates directly, no Claude draft. | |
| Skip spike entirely | Ship DB fallback only, defer to v1.2 PAST-07. PAST-06 documented as declined. | |

**User's choice:** Claude drafts, user sends (Recommended)
**Notes:** Matches minimal-ceremony preference; user keeps Wise relationship. Email draft becomes an artifact in the Phase 7 plan.

### Q2: When in Phase 7 should the spike happen?

| Option | Description | Selected |
|--------|-------------|----------|
| Parallel with planning (Recommended) | Email goes out during planning phase (after CONTEXT.md, before/during execution). Response handled async. | ✓ |
| Post-implementation | Ship DB fallback first; email after Phase 7 completion. Keeps scope pure; loses parallelism. | |
| Before CONTEXT finalized | Send now so response might inform CONTEXT. Blocks planning on email action. | |

**User's choice:** Parallel with planning (Recommended)
**Notes:** DB fallback proceeds unconditionally; endpoint discovery never gates Phase 7 progress.

### Q3: If Wise responds 'yes, we have an endpoint' during Phase 7, what happens?

| Option | Description | Selected |
|--------|-------------|----------|
| Document response, defer wiring to v1.2 (Recommended) | Response captured in artifact; Phase 7 deliverable unchanged. v1.2 phase handles wiring. Protects scope. | ✓ |
| Add to Phase 7 execution scope | Extend scope to wire endpoint mid-execution. Risk: scope creep. | |
| Decide per-response-content | Triage based on endpoint shape. Max flexibility, requires judgment call. | |

**User's choice:** Document response, defer wiring to v1.2 (Recommended)
**Notes:** Protects Phase 7 scope from runtime expansion; v1.2 phase can layer on top of stable past_session_blocks table as a secondary source.

### Q4: What's the cutoff for Wise response before Phase 7 proceeds?

| Option | Description | Selected |
|--------|-------------|----------|
| No cutoff — ship unconditionally (Recommended) | DB fallback is sole deliverable; spike is parallel. Wise response handled by whichever phase is open. | ✓ |
| Soft 2-business-day wait | Document as unreachable if no response in 2 days; proceed with DB-only. | |
| 1-week wait | More generous cushion; better chance of catching slow response. | |

**User's choice:** No cutoff — ship unconditionally (Recommended)
**Notes:** Matches research "ship unconditionally regardless of spike outcome"; eliminates any blocking risk.

---

## Claude's Discretion

Areas where the user deferred to the planner / executor without explicit decision:

- Drizzle migration shape (column names, indexes, types) — planner picks per existing schema conventions
- Exact placement of the diff-hook step within `orchestrator.ts` — planner picks based on transaction boundaries
- Sync-duration monitoring strategy (console log vs. `sync_runs.metadata`) — planner's call
- Whether to emit a `completeness` data_issue when the diff-hook captures zero sessions — lean "no" for first ship
- Edge case: session cancelled after capture — D-03 says no drift handling; planner adds a note only
- Test-matrix composition — planner picks representative cases covering the 6 behaviors listed in CONTEXT.md
- Exact email text for PAST-06 — Claude drafts; user may edit
- Admin utility route for `revalidateTag('past-sessions')` — not needed v1.1
- Commit cadence — atomic per-concern; planner picks split

## Deferred Ideas

- PAST-07 (multi-snapshot diff view) — v1.2
- PAST-08 (source-of-truth badge on past-day cards) — v1.2
- Wise historical-endpoint wiring (even if response positive) — v1.2 per D-15
- Migration-time backfill — rejected v1.1, revisit v1.2 if requested
- Lazy backfill on first historical query — rejected v1.1
- Capture-start date indicator in UI — deferred, revisit on user feedback
- Empty-day tooltip / marker icon — reserved wording captured (D-12)
- Past-session visual distinction (dim, badge) — rejected v1.1 per visual-consistency
- Drift detection on re-observed sessions — deferred to v1.2 if useful
- Admin utility for manual cache flush — deferred
- Diff-hook observability (per-sync capture count, duration) — planner discretion, likely simple log v1.1
- `past_session_blocks` retention / pruning policy — no pruning v1.1; revisit if >1M rows
