---
phase: 11-ident-01-webhook-side-line-identity-resolution
plan: "07"
subsystem: ui
tags: [line-review, react, mapping-validation, re-anchor, phantom-archive, next16]

# Dependency graph
requires:
  - phase: 11-04
    provides: "POST /api/line/contacts/followers-reanchor route"
  - phase: 11-05
    provides: "widened worklist + phantom scope in LineLinkValidationScope"
  - phase: 11-06
    provides: "inline re-link recompute on verify"
provides:
  - "Re-anchor followers button in Mapping Validation workspace"
  - "Phantom/legacy archive scope selectable in link-validation panel"
  - "Phase 11 acceptance verification + >=80% metric baseline measurement"
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Workspace action button bound to real route response fields (followerCount/upsertedContacts/suggestionsCreated)"
    - "Scope-tab archive filter (Path B): phantom added to panel SCOPES array, default scope stays real-contacts"

key-files:
  created: []
  modified:
    - src/components/line-review/mapping-validation-workspace.tsx
    - src/components/line-review/link-validation-panel.tsx
    - src/components/line-review/types.ts

key-decisions:
  - "Archive filter Path B: added { value: 'phantom', label: 'Legacy / needs re-match' } to the panel SCOPES array; the panel's existing scope-tab strip is the UI affordance (no separate workspace toggle needed)"
  - "Fixed a second component-local LineLinkValidationScope in types.ts that Plan 05 missed (would have been a TS error otherwise)"
  - "Phase >=80% metric is an ops metric measured against production; the phase ships the tooling, admin verification drives the number up"

patterns-established:
  - "Re-anchor button mirrors existing Refresh button (variant=outline size=sm, disabled while busy), spinner on busy='reanchor'"

requirements-completed: [IDENT-03, IDENT-04, IDENT-05, IDENT-06]

# Metrics
duration: ~25min (incl. checkpoint + a regression fix to Plan 06 type errors)
completed: 2026-06-07
---

# Phase 11 / Plan 07: Mapping Validation UI + Phase Acceptance Summary

**Re-anchor button + phantom-archive scope in the Mapping Validation workspace, plus full Phase 11 acceptance verification (eval gate, fail-closed, phantom quarantine, build-clean) with the >=80% verified-link metric measured at a 1.6% post-quarantine baseline.**

## Performance
- **Duration:** ~25 min (Tasks 1-2 by executor; Task 3 human-verify + a Plan-06 regression fix by orchestrator)
- **Completed:** 2026-06-07
- **Tasks:** 3 (2 auto UI + 1 human-verify checkpoint)
- **Files modified:** 3 components

## Accomplishments
- "Re-anchor followers" button in the Mapping Validation workspace → `POST /api/line/contacts/followers-reanchor`, spinner while busy, success message bound to the real route fields (`upsertedContacts`, `suggestionsCreated`), `disabled` while busy (T-11-23)
- Phantom/legacy archive scope ("Legacy / needs re-match") selectable via the panel's scope tabs (D-03); default load stays on real contacts
- Caught + fixed a build-breaking type regression introduced by Plan 06 (see below)
- Full Phase 11 acceptance verified

## Task Commits
1. **Task 1: re-anchor button** - `357b30b` (feat)
2. **Task 2: phantom scope (Path B)** - `d829af8` (feat) — link-validation-panel.tsx + types.ts
3. **Tasks 1-2 checkpoint note** - `f84e1d6` (docs)
4. **Plan-06 type regression fix** - `3fd2dc4` (fix) — link-validation.ts + test

## Files Created/Modified
- `src/components/line-review/mapping-validation-workspace.tsx` - re-anchor button + handler
- `src/components/line-review/link-validation-panel.tsx` - "phantom" added to SCOPES array
- `src/components/line-review/types.ts` - LineLinkValidationScope union now includes "phantom" (Plan 05 gap)

## Archive Filter Implementation Path
**Path B** — `"phantom"` was in `LineLinkValidationScope` in `src/lib/line/link-validation.ts` (Plan 05) but NOT in the component-local copy in `src/components/line-review/types.ts`, and not in the panel's `SCOPES` array. Added it to both; the panel's existing scope-tab strip surfaces "Legacy / needs re-match". Default scope remains real-contacts; phantom is reachable only by selecting that tab.

## Human Verification — 6 SPEC acceptance criteria (IDENT-01..06)
Checkpoint closed on code+test evidence (user approved). Results:

| Criterion | Status | Evidence |
|-----------|--------|----------|
| IDENT-01 name-based matcher (precision >=0.90, recall >=0.60) | ✓ | name-matcher.eval.test.ts 4/4 pass (precision 0.905, recall 1.0) |
| IDENT-02 no verified-from-content (fail-closed) | ✓ | `ensureLineContactStudentLinkSuggestions` writes `status:'suggested'`; `'verified'` only in `createVerifiedLineContactStudentLink` / `patchLineContactStudentLinkStatus` (explicit admin actions) and read filters |
| IDENT-03 admin-triggered re-anchor (UI) | ✓ | button → POST /api/line/contacts/followers-reanchor (auth-gated); 11-04 idempotent via onConflictDoNothing |
| IDENT-04 real-contact worklist | ✓ | Plan 05 widened queries; metric shows 187 real active messaging contacts now in scope |
| IDENT-05 phantom archive filter | ✓ | 656 phantom-"verified" rows quarantined (is_phantom=true, excluded from active scopes); "Legacy" scope surfaces them |
| IDENT-06 badge update after verify | ✓ | Plan 06 inline recompute (fail-isolated); covered by 4 link-validation tests |

UI behavioral walkthrough steps (3d live verify, 5 double-click re-anchor, 6 badge refresh) were NOT executed by the orchestrator because they mutate production (LINE followers fetch / writing verified status). Their code paths are test-covered; the live walkthrough is left to the admin.

## Phase Metric (Task 3 step 7 — measured against production Neon)
```
total_messaging_contacts = 187
verified_count           = 3
verified_pct             = 1.6%
```
**verified_pct = 1.6% — post-quarantine baseline, NOT a code failure (ops metric).** Before this phase, the worklist was dominated by 656 wrong-namespace OA-resolver phantom auto-"verified" links and the real messaging-contact worklist was hidden. Those 656 are now quarantined and 187 real active messaging contacts are surfaced with name-matched suggestions. Verifying a link is a manual admin action; the 80% target is reached as admins work the newly-populated worklist (the tooling delivered by plans 02-07). **Gap-closure to 80% is an operational task, not additional code.**

## Decisions Made
- Closed the human-verify checkpoint on code+test evidence per user instruction; recorded the 1.6% baseline.
- Did not trigger the live re-anchor or verify-link flows (production mutations) without an explicit request.

## Deviations from Plan
### Regression fix (Plan 06 type errors — caught during Task 3 build verification)
- **Found during:** Task 3 tsc verification. Plan 06's inline recompute passed `buildLineOperationalReviewPlan`'s strongly-typed `LineOperational*` values directly to `patchLineSchedulerOperationalPlan` (which takes `Record<string, unknown>`), and its test mocks built an incomplete `intentPayload`. vitest strips types so it passed; `tsc --noEmit` (and thus `next build`) reported 7 errors — a deploy-blocking regression.
- **Fix:** Added the established `as unknown as Record<string, unknown>` casts (mirroring `scheduler-reviews/[reviewId]/operational-plan/route.ts`); completed the test `intentPayload` mocks with `summary/confidence/source`. tsc now reports 0 errors.
- **Committed in:** `3fd2dc4`
- **Path B types.ts gap:** Plan 05 updated only the lib-side `LineLinkValidationScope`; the component-local copy in `types.ts` was missing `"phantom"`. Fixed as part of Task 2.

**Impact:** Both fixes necessary for correctness/build. No scope creep.

## Issues Encountered
- The 7 tsc errors were initially mislabeled "pre-existing" by the UI executor (they were present on its HEAD but introduced earlier in this same phase by Plan 06). Root-caused to Plan 06 and fixed.

## User Setup Required
None.

## Next Phase Readiness
- Phase 11 tooling is complete and build-clean. The operational follow-up: admins work the Mapping Validation worklist to raise verified_pct toward 80% (and can run "Re-anchor followers" to seed correct-namespace contacts).

---
*Phase: 11-ident-01-webhook-side-line-identity-resolution*
*Completed: 2026-06-07*
