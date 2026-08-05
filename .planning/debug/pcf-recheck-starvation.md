---
status: resolved
trigger: Post-class-feedback source-ready backlog — eligible sessions stuck at source_status='unavailable' forever; every completed payout month is ~97% not-source-ready, so payout deduction lists are permanently incomplete.
created: 2026-07-31
updated: 2026-07-31
slug: pcf-recheck-starvation
---

# Debug: pcf-recheck-starvation

Diagnosis is COMPLETE and evidence-confirmed against prod (neondb) on 2026-07-31.
Full write-up: /Users/kevinhsieh/.claude/plans/why-are-payout-writes-steady-sparkle.md
Do NOT re-investigate. Proceed to fix (TDD) + verification.

## Symptoms
- expected: A completed payout month's post-class sessions should nearly all be `source_status='ready'`, so the payout deduction list is complete and publishable.
- actual: ~2,496 eligible sessions are stuck at `source_status='unavailable'` indefinitely. Completed payout month 2026-07 (window 06-26→07-26) is 97.3% not-ready (2090/2149). The Payouts tab shows "N of M sessions are not source-ready, so the deduction list is incomplete".
- errors: none surfaced; a transient global source issue `configuration_changed` fired 07-30 15:15→15:26 (resolved).
- timeline: mass-demotion at 07-30 15:26; never recovered since.
- reproduction: query prod — all eligible sessions share `updated_at≈07-30 15:26`; oldest-500 recheck slice is 100% `ready`; a 2-batch backfill on the oldest window fetched 20, flipped 0.

## Current Focus
hypothesis: CONFIRMED — two compounding faults (see Resolution.root_cause). Primary = recheck-lane ordering starves the non-ready backlog; secondary = per-observation global demotion doesn't set source_status_before so 0058 restore can't heal it.
test: Prod SQL + an empirical backfill probe (below). Both confirm.
expecting: Part A reorders the recheck lane so non-ready rows enter the fetch slice; Part B stashes source_status_before on the sync.ts:863 demotion so 0058 restore self-heals future incidents.
next_action: Write failing tests first (TDD), then apply Part A (repository.ts:959 ordering) + Part B (sync.ts:863 + saveObservation source_status_before). Run `npm test` and `npx tsc --noEmit`. Commit atomically. Deployment to main and the operational recovery drain are handled by the orchestrator afterward.
reasoning_checkpoint:
  hypothesis: "listIncompleteRecheckCandidates orders the eligible lane by updated_at only; a run-wide demotion flattened every updated_at so the detailCap slice is 100% already-ready rows and the unavailable backlog is never re-observed. Secondary: the sync.ts:863 global demotion writes source_status_before=null via saveObservation, defeating the 0058 restore."
  confirming_evidence:
    - "Prod: 2,496 eligible rows stuck unavailable, all updated_at≈07-30 15:26, source_status_before NULL, zero per-session issues."
    - "Oldest-500 recheck slice = 100% ready; a 2-batch backfill fetched 20, flipped 0 — lane ordering, not volume."
    - "saveObservation insert+update both hardcode sourceStatusBefore: null (repository.ts:1466/1492); bulk path coalesces (repository.ts:2002)."
  falsification_test: "Part A test: with ready rows preceding unavailable in updated_at and pool>detailCap, the current ordering returns only ready rows (RED); non-ready-first ordering returns the unavailable backlog (GREEN)."
  fix_rationale: "Part A orders `source_status='ready'` ASC so non-ready (false) enters the detailCap slice first — un-starves the backlog. Part B captures prior source_status into source_status_before (coalesce/keep-first) only on the global-demotion path so the existing 0058 restore self-heals future incidents. Both preserve fail-closed: never invent ready."
  blind_spots: "Whether a re-observed row actually re-derives ready can only be proven by the first post-deploy recheck batch (out of scope). Genuinely unresolved rows (fresh billing_evidence_missing/identity) correctly stay non-ready."
tdd_checkpoint:
  part_a:
    test_file: src/lib/post-class-feedback/__tests__/recheck-queue.integration.test.ts
    test_name: "REC-04 non-ready-first recheck ordering > admits the demoted backlog into the capped slice even when the ready rows are older"
    red_then_green: "RED pre-fix (slice returned only ready rows), GREEN after repository.ts ordering. Commit 8540a80."
  part_b:
    test_file: src/lib/post-class-feedback/__tests__/source-status-restore.integration.test.ts
    test_name: "REC-01 saveObservation run-wide demotion capture (capture / keep-first / restore / per-session-supersede)"
    red_then_green: "3 tests RED pre-fix (source_status_before stayed null), GREEN after sync.ts flag + repository.ts coalesce + types.ts field. Commit df00c14."
  results: "unit 3872 pass; integration 138 pass; tsc --noEmit clean."

## Evidence
- 2026-07-31: Migration 0058 IS applied to prod (`post_class_sessions.source_status_before` column exists). Restore-gap is real but not the primary blocker.
- 2026-07-31: Table-wide (eligible, not-deleted): 4,791 ready / 2,496 unavailable; zero form_drift, zero identity_review; ALL rows have `source_status_before` NULL (nothing demoted via the bulk path). No open global source issue now.
- 2026-07-31: The 07-30 `configuration_changed` global issue (blocks_enforcement, 15:15→15:26) touched 2,496 eligible non-ready sessions — all now `updated_at≈07-30 15:26`, `source_status_before` NULL, zero per-session source issues. This is the sync.ts:863 `blockingGlobalSourceIssue` per-observation demotion path (records no issue, no source_status_before).
- 2026-07-31: `listIncompleteRecheckCandidates` (repository.ts:959) orders `eligible=true` by `updated_at ASC, scheduled_end_at ASC`, cap detailCap. Oldest-500 slice = 100% `ready` (all updated 07-30 15:26). The unavailable backlog is buried and never enters the fetch set.
- 2026-07-31: PROBE — triggered GET /api/internal/post-class-feedback-backfill?detailCap=100&maxBatches=2 on the auto-selected oldest window (06-10). Each batch fetched only 20 (rolling lane). The 8 sampled stuck sessions did NOT move (source_status unavailable, updated_at frozen 07-30 15:26:23). Whole 06-10 window unchanged: 126 unavailable / 80 ready. → recovery drain does not work until the recheck lane is un-starved.
- 2026-07-31: `shouldFetchPostClassCandidate` (repository.ts:470) only throttles `rolling_window` candidates; it then drops fresh fully-reconciled `ready` rows, collapsing the fetch pool to the rolling lane once the recheck slice is all-ready.

## Eliminated
- hypothesis: migration 0058 not applied to prod — REFUTED (source_status_before column exists in prod).
- hypothesis: an open global source issue is actively demoting — REFUTED (no open global issue; recent runs status=success).
- hypothesis: throughput / detailCap too low — REFUTED (rows are re-observed daily elsewhere; probe fetched 20, flipped 0; problem is lane ordering, not volume).
- hypothesis: form_drift / identity_review holding rows non-ready — REFUTED (zero of each in the table).
- hypothesis: sessions abandoned/deleted in Wise (notAbandonedMissingSession / notDeletedInWise) — REFUTED for the stuck sample (no issues of any status; not deleted).

## Resolution
root_cause: |
  Two compounding faults.
  (1) TRIGGER: the transient global `configuration_changed` issue mass-demoted all 7,287 eligible
      sessions to `unavailable` via the per-observation branch at sync.ts:861-865
      (`else if (blockingGlobalSourceIssue) sourceStatus="unavailable"`). That branch writes status
      directly through saveObservation and does NOT set source_status_before, so migration 0058's
      bulk-restore (repository.ts:833-837, keyed on source_status_before IS NOT NULL) can never heal them.
  (2) PRIMARY BLOCKER: listIncompleteRecheckCandidates (repository.ts:959) orders eligible sessions by
      updated_at ASC with no non-ready priority, capped at detailCap. The demotion reset every eligible
      row's updated_at to the same instant, so the fetch slice is ~100% already-ready rows and the
      unavailable backlog is never re-observed → permanent non-convergence.
fix: |
  Part A (PRIMARY): listIncompleteRecheckCandidates prioritises non-ready sessions
    (ORDER BY (source_status = 'ready') ASC, updated_at ASC, scheduled_end_at ASC, or a dedicated
    non-ready-first lane). Un-starves the backlog; each run re-observes detailCap non-ready rows.
  Part B (DEFENSE): the sync.ts:863 demotion stashes prior source_status into source_status_before
    (mirror bulk path repository.ts:2001-2005 coalesce) threaded through saveObservation
    (repository.ts ~1459/1491), so future transient global issues self-heal via the 0058 restore.
  Fail-closed intact: only restore a previously-proven state; never invent `ready`.
verification: |
  TDD tests under src/lib/post-class-feedback/__tests__/:
   (a) Part A — ready rows sharing/preceding the updated_at of unavailable rows, pool > detailCap ⇒
       listIncompleteRecheckCandidates returns non-ready first.
   (b) Part B — blockingGlobalSourceIssue demotes an eligible session, next healthy run restores it to
       ready with source_status_before cleared (mirror existing 0058 restore tests).
  `npm test` + `npx tsc --noEmit` green. Post-deploy: operational recovery drain (orchestrator step),
  verify closed-month coverage SQL: 2026-07 window was 2149 denom / 2090 non-ready → expect ≈0 non-ready.
  RESIDUAL UNKNOWN: confirm a re-observed session actually derives `ready` (probe couldn't — never fetched);
  the first post-fix recheck batch confirms it. Any re-deriving to unavailable WITH a fresh
  billing_evidence_missing/identity issue are genuinely unresolved (out of scope).
files_changed:
  - src/lib/post-class-feedback/repository.ts  # Part A: eligible-recheck lane orders source_status='ready' ASC (non-ready first); Part B: saveObservation onConflict update stashes source_status_before via coalesce/keep-first on the global-demotion path
  - src/lib/post-class-feedback/sync.ts  # Part B: derive globalSourceDemotion at the blockingGlobalSourceIssue branch and thread it into saveObservation
  - src/lib/post-class-feedback/types.ts  # Part B: PostClassSessionObservation.globalSourceDemotion? flag
  - src/lib/post-class-feedback/__tests__/recheck-queue.integration.test.ts  # Part A test (REC-04 non-ready-first ordering)
  - src/lib/post-class-feedback/__tests__/source-status-restore.integration.test.ts  # Part B tests (saveObservation demotion capture/keep-first/restore/supersede)
commits:
  - 8540a80  # Part A: prioritise non-ready sessions in recheck lane
  - df00c14  # Part B: capture source_status_before on run-wide demotion via saveObservation
