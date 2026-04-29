# Milestone v1.1 - Project Summary

**Generated:** 2026-04-29
**Purpose:** Team onboarding and project review
**Status:** In progress - Phase 8 executing

---

## 1. Project Overview

BGScheduler is a production tutor scheduling workspace for BG Education admin staff. It searches normalized Wise API snapshots, proves tutor availability fail-closed, and lets staff compare up to 3 tutors side by side in a GCal-style weekly view.

The core value remains unchanged: admin staff can find, compare, and schedule tutors instantly and independently without engineering support.

Milestone v1.1, **Data Fidelity & Depth**, focuses on making the existing production tool more truthful and easier to operate:

- Close v1.0 polish and accessibility debt before new feature churn.
- Replace weak online/onsite guesses with reliable modality confidence and visible Needs Review states.
- Capture past-day sessions from snapshot history so historical compare views do not show future-session fallback data.
- Prepare v2 visual polish: sticky tutor legend, density overview, and view transitions.

Current milestone position:

- Phase 5 POLISH Drain: complete and verified.
- Phase 6 MOD-01 Reliable Modality Detection: code complete, gap closure landed, post-deploy visual/data-health UAT still noted.
- Phase 7 PAST-01 Past-Day Session Visibility: code complete; production Neon migration and post-sync live smoke tests remain required.
- Phase 8 VPOL-02 Sticky Tutor Legend: in progress; stacking audit and `Z_INDEX` constant are complete.
- Phases 9 and 10: planned, not started.

## 2. Architecture & Technical Decisions

- **Decision:** Keep production truth anchored on Wise snapshots and fail-closed search behavior.
  - **Why:** The product rule is strict: unresolved identity, modality, or qualification must never become Available.
  - **Phase:** Milestone-wide constraint carried from production system.

- **Decision:** Drain v1.0 polish first.
  - **Why:** Phase 5 removed scattered debt, restored verification traceability, and established the accessibility baseline that later visual phases depend on.
  - **Phase:** 5.

- **Decision:** Scope POLISH-01 to VoiceOver and defer NVDA to v1.2.
  - **Why:** The user only has macOS access; the scope change was recorded before execution and tracked as `NVDA-v12`.
  - **Phase:** 5.

- **Decision:** Resolve session modality from `isOnlineVariant` and `sessionType`; never from visual styling or location heuristics.
  - **Why:** `supportedModes[0]` silently guessed in ambiguous cases. The new resolver returns `{ modality, confidence }` and contradiction payloads, with ambiguous cases shown as Needs Review.
  - **Phase:** 6.

- **Decision:** Surface modality through icon + popover, not border or fill color.
  - **Why:** Border/fill colors already encode tutor identity; overloading them for modality made the calendar less legible.
  - **Phase:** 6.

- **Decision:** Add `CACHE_VERSION` and bump it on client cache shape changes.
  - **Why:** Compare cache entries can outlive deploys in browser tabs; versioned keys force one clean refetch after shape changes.
  - **Phase:** 6 introduced `v1`; Phase 7 bumped to `v2`.

- **Decision:** Capture past sessions in a dedicated `past_session_blocks` table outside the warm SearchIndex.
  - **Why:** Past-session history should not slow warm search queries or bind immutable history to daily snapshot invalidation.
  - **Phase:** 7.

- **Decision:** Use `cacheTag("past-sessions")`, separate from `cacheTag("snapshot")`.
  - **Why:** Daily active-snapshot promotion should not invalidate immutable historical rows.
  - **Phase:** 7.

- **Decision:** Disable weekday fallback per historical weekday.
  - **Why:** Past views should show actual captured sessions or honest empty gaps, never a nearest-future representative.
  - **Phase:** 7.

- **Decision:** Use a 3-tier z-index scale: content 1, legend 6, popover 50.
  - **Why:** Phase 8 consolidates per-day lane headers into a single sticky legend, so the original 5-slot scale was unnecessary.
  - **Phase:** 8.

## 3. Phases Delivered

| Phase | Name | Status | One-liner |
|-------|------|--------|-----------|
| 5 | POLISH Drain | Complete / verified | Cleared v1.0 backlog, fixed URL/date/hook polish, signed off production QA, added recommended-slot tests, and restored v1.0 Phase 02 verification traceability. |
| 6 | MOD-01 Reliable Modality Detection | Code complete / gaps closed / UAT pending | Replaced silent modality fallback with fail-closed session modality resolution, confidence tiers, icons, popover labels, data-health issue surfacing, and regression tests. |
| 7 | PAST-01 Past-Day Session Visibility | Code complete / human migration needed | Added durable past-session capture, cached historical reads, compare merge logic, fallback suppression for historical days, cache version bump, and Wise endpoint spike draft. |
| 8 | VPOL-02 Sticky Tutor Legend | In progress | Landed pre-implementation stacking-context audit, amended STICKY-02 to a 3-tier z-index scale, and added `src/lib/ui/z-index.ts`. |
| 9 | VPOL-03 Density Overview | Planned | Client-side density aggregation over existing compare sessions; shape decision deferred to phase planning. |
| 10 | VPOL-01 View Transitions | Planned | Native view transitions for week/day navigation after sticky and density layout are stable. |

## 4. Requirements Coverage

Phase 5 coverage:

- [x] POLISH-01..16 satisfied.
- [x] VoiceOver production QA signed off; NVDA explicitly deferred as `NVDA-v12`.
- [x] URL-sync dependency churn, stale mount closure, malformed week params, midnight today indicator, semantic token usage, TutorSelector dead body, and v1.0.1 recommendation tests all addressed.

Phase 6 coverage:

- [x] MOD-01..05 satisfied at code level.
- [x] Contradictions route to `unknown` and emit `conflict_model` issues.
- [x] Test matrix covers contradiction cases.
- [!] Production visual checks and data-health counter confirmation remain documented as human UAT items.

Phase 7 coverage:

- [x] PAST-03 and PAST-04 satisfied by cached historical reads and fallback suppression.
- [x] PAST-05 satisfied in schema/code: unique `wise_session_id`, stable `group_canonical_key`, idempotent insert.
- [!] PAST-01, PAST-02, and live PAST-05 proof require applying `drizzle/0002_past_session_blocks.sql` to Neon and waiting for a post-migration sync.
- [!] PAST-06 has a completed Wise email draft; user send/follow-up remains pending or may close as unreachable.

Phase 8 coverage:

- [x] STICKY-03 audit artifact exists.
- [x] STICKY-02 requirement amended to match the 3-tier scale and `Z_INDEX` constant.
- [ ] STICKY-01, STICKY-02 consumer application, and STICKY-04 visual verification are not complete yet.

Milestone audit status:

- No v1.1 milestone-level audit file exists yet because the milestone is still in progress.
- Last archived milestone audit is v1.0, with accepted tech debt rolled into v1.1 Phase 5.

## 5. Key Decisions Log

| ID | Decision | Phase | Rationale |
|----|----------|-------|-----------|
| P5-D02 | VoiceOver-only accessibility signoff; NVDA deferred | 5 | Mac-only access made NVDA signoff infeasible; tracked cleanly as v1.2 deferred work. |
| P5-D05 | Retroactive Phase 02 verification stored in milestone archive | 5 | Recreating deleted phase directories would fight the v1.0 archive model. |
| P5-D09 | Prep commit for archived phase deletions | 5 | Kept Phase 5 history readable and separated inherited archival cleanup from POLISH work. |
| P6-D01..D03 | Confidence rubric with low-confidence fail-closed UX | 6 | Staff should see uncertainty instead of guessed online/onsite labels. |
| P6-D07..D08 | Contradictions become `unknown` | 6 | Conflicting Wise signals are data issues, not scheduling truth. |
| P6-D11 | Higher data-health modality counts are expected | 6 | Tightened detection surfaces hidden issues; a rise is surface-of-reality, not regression. |
| P6-D17..D20 | `CACHE_VERSION` convention | 6 | Protects long-lived browser tabs across response-shape changes. |
| P7-D01 | Snapshot diff-hook capture strategy | 7 | Wise FUTURE API drops past sessions; prior snapshot comparison creates a production-safe fallback. |
| P7-D05..D08 | Keep past sessions out of SearchIndex | 7 | Preserves warm search performance and isolates immutable historical cache behavior. |
| P7-D09 | Honest empty historical days | 7 | Historical UI must not fabricate sessions from future recurring fallbacks. |
| P7-D13..D16 | Wise endpoint spike non-blocking | 7 | DB-snapshot fallback ships unconditionally; Wise response can enhance later. |
| P8-D01 | Consolidate per-day lane headers into one sticky legend | 8 | The tutor-color mapping should remain visible while scrolling without competing sticky layers. |
| P8-D08..D10 | Simplify z-index to content/legend/popover | 8 | The separate lane-header and day-header layers no longer need independent slots after consolidation. |
| P8-D11..D13 | Audit before source edits | 8 | Sticky behavior is fragile; every ancestor overflow/stacking context was reviewed before implementation. |

## 6. Tech Debt & Deferred Items

Open human gates:

- Apply `drizzle/0002_past_session_blocks.sql` to Neon before the Phase 7 diff-hook can work in production.
- Run post-migration sync and verify `sync_runs.metadata.diffHookDurationMs` plus `pastSessionsCapturedCount`.
- Smoke-test prior-week compare after captured rows exist.
- Send or close the Wise historical endpoint spike email from `07-WISE-SPIKE.md`.
- Complete Phase 8 implementation and visual verification.

Carried technical debt:

- Phase 7 WR-01: mixed-timezone comparison in the diff-hook can skip sessions in a boundary window; recommended fix is to compare UTC instants directly.
- Phase 7 WR-02: `captured_in_snapshot_id` is nullable without FK; current writers set it, but schema should become stricter or document orphan policy.
- Phase 5 WR-01 / IN-01: keyboard navigation effect and some compare hook callbacks still have memoization cleanup opportunities.
- Pre-existing date math around `getCurrentMonday` / `parseMondayDate` uses host-timezone semantics; BKK anchoring should be reviewed.
- NVDA signoff remains deferred to v1.2 due to macOS-only operator access.

Planned future scope:

- Phase 9 density overview.
- Phase 10 view transitions.
- v1.2 advanced workflow: inline free-slot actions, conflict suggestions, drag-to-select.

## 7. Getting Started

Run the project:

- Install dependencies already expected in the repo.
- Start local dev with the project script from `package.json` (typically `npm run dev`) and open `/search`.
- Production is https://bgscheduler.vercel.app.

Key directories:

- `src/app/api/compare/route.ts` - compare API, historical-range trigger, and free-slot pre-merge.
- `src/lib/search/compare.ts` - compare tutor assembly, modality resolver, fallback logic.
- `src/lib/search/index.ts` - active snapshot indexing and `IndexedTutorGroup` mapping.
- `src/lib/sync/orchestrator.ts` - Wise sync pipeline and Phase 7 diff-hook integration.
- `src/lib/sync/past-sessions-diff-hook.ts` - dropped FUTURE-session capture.
- `src/lib/data/past-sessions.ts` - cached historical read path.
- `src/components/compare/week-overview.tsx` - weekly calendar view and Phase 8 sticky legend target.
- `src/components/compare/calendar-grid.tsx` - day-view grid and sticky day-header normalization target.
- `src/components/search/search-workspace.tsx` - search/compare composition root and URL state.
- `.planning/phases/05-*`, `06-*`, `07-*`, `08-*` - phase artifacts for v1.1.

Tests:

- Phase 5 verification recorded 669 passing tests.
- Phase 6 verification recorded 118 passing tests in that worktree.
- Phase 7 verification recorded 141 passing tests across 16 files.
- Useful targeted suites include `src/lib/search/__tests__/compare.test.ts`, `src/lib/data/__tests__/past-sessions.test.ts`, `src/lib/sync/__tests__/past-sessions-diff-hook.test.ts`, and `src/lib/search/__tests__/recommend.test.ts`.

Where to look first:

- Read `.planning/PROJECT.md` for current product state and constraints.
- Read `.planning/ROADMAP.md` for v1.1 phase sequencing.
- Read `.planning/phases/07-past-01-past-day-session-visibility/07-VERIFICATION.md` before touching historical sessions; it lists the live migration gate and warning-level follow-ups.
- Read `.planning/phases/08-vpol-02-sticky-tutor-legend/08-STACKING-AUDIT.md` before changing sticky calendar layout.

---

## Stats

- **Timeline:** 2026-04-20 -> 2026-04-29 generated report; milestone still executing.
- **Phases:** 2 complete/verified, 1 code-complete with human gate, 1 in progress, 2 planned.
- **Commits:** 106 since 2026-04-20.
- **Files changed:** 167 since the pre-2026-04-20 boundary commit.
- **Diff volume:** +27,600 / -11,578 since the pre-2026-04-20 boundary commit.
- **Contributors:** kasheesh711 <kevhsh7@gmail.com>.

