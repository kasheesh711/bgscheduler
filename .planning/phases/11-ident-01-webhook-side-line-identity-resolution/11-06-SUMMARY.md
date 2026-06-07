---
phase: 11
plan: "06"
subsystem: line-identity-resolution
tags: [line, identity, recompute, ident-06, tdd]
dependency_graph:
  requires: [11-05]
  provides: [inline-recompute-on-verify]
  affects: [patchLineLinkValidationTaskStatus, pending-review-badge, matchedStudentKeys]
tech_stack:
  added: []
  patterns: [fail-isolated-per-row-catch, inline-recompute-on-status-transition]
key_files:
  modified:
    - src/lib/line/link-validation.ts
    - src/lib/line/__tests__/link-validation.test.ts
decisions:
  - "adminSelectedSessionIds reset to [] on recompute — intentional (fresh base plan; admin re-selects sessions), matching existing operational-plan route behavior (T-11-20 accepted)"
  - "Recompute block inserted after contact fetch, before student enrichment — verify logic completes regardless of recompute outcome"
  - "classifierCategory falls back to 'scheduling_change' when null in DB — consistent with operational.ts default path"
metrics:
  duration: "9m"
  completed: "2026-06-07"
  tasks: 1
  files: 2
---

# Phase 11 Plan 06: Inline Re-Link Recompute on Verify Summary

**One-liner:** Inline recompute of `pending_review` scheduler rows via `buildLineOperationalReviewPlan` + `patchLineSchedulerOperationalPlan` triggered when a student link transitions to `verified`, updating `matchedStudentKeys` and `writebackStatus` in the DB without a manual recompute click.

## What Was Built

Added an inline recompute block to `patchLineLinkValidationTaskStatus` in `src/lib/line/link-validation.ts`. When a link's status transitions to `verified`, the function now:

1. Queries `lineSchedulerReviews` for all rows with `status = 'pending_review'` and `contactId = row.contactId` (using the contact ID returned from the UPDATE's `.returning()` clause — T-11-18 mitigation: correct contact scoping)
2. For each pending review, fetches the inbound message text from `lineMessages` via `inboundMessageId`
3. Skips any review whose message text is absent (`continue`)
4. Calls `buildLineOperationalReviewPlan({ db, contactId, messageText, classifierCategory })` — re-runs identity resolution with the freshly-verified link
5. Calls `patchLineSchedulerOperationalPlan(db, review.id, { ...plan, adminSelectedSessionIds: [] })` — persists updated `matchedStudentKeys` and `writebackStatus`
6. Each step is fail-isolated: `.catch(() => null)` on build, `.catch(() => undefined)` on patch — per-row failure does not abort the loop or the status patch (T-11-19 mitigation)

The `rejected` path is unaffected — no recompute is triggered.

## TDD Gate Compliance

- RED commit `7bd6171`: 4 failing tests added (verify triggers recompute, reject does not, error isolation continues loop, missing message text skips review)
- GREEN commit `d8ee4b0`: implementation added — all 4 new tests pass, all 18 prior tests continue passing
- No REFACTOR phase needed — implementation is clean as written

## Recompute Context

Per the 805 real scheduling messages pattern documented in 11-RESEARCH.md: contacts typically have 1 pending review at the time of first link verification. The loop is expected to iterate 1 time per verify action in the common case. Multiple pending reviews occur when a contact sent several scheduling messages before any link was verified (e.g., parent sent 2-3 scheduling requests across different weeks). The loop handles any count correctly.

## Imports Added to link-validation.ts

Both imports were **new** to link-validation.ts — neither `buildLineOperationalReviewPlan` nor `patchLineSchedulerOperationalPlan` was previously imported there:

```typescript
import { buildLineOperationalReviewPlan } from "@/lib/line/operational";
import { patchLineSchedulerOperationalPlan } from "@/lib/line/data";
```

No circular import risk: `data.ts` and `operational.ts` have no import path back to `link-validation.ts`.

## Test Cases Added

4 new tests in `describe("patchLineLinkValidationTaskStatus — re-link recompute (IDENT-06)")`:

1. **verify triggers recompute** — asserts `buildLineOperationalReviewPlan` called once with correct `contactId`/`messageText`/`classifierCategory`; asserts `patchLineSchedulerOperationalPlan` called with `review.id` and plan fields including `matchedStudentKeys`
2. **reject does NOT trigger recompute** — asserts neither function called when `status="rejected"`
3. **error isolation continues loop** — two pending reviews; first `buildLineOperationalReviewPlan` rejects, second resolves; asserts `patchLineSchedulerOperationalPlan` called exactly once (for the second review)
4. **missing message text skips review** — message fetch returns `null`; asserts `buildLineOperationalReviewPlan` not called (skip via `continue`)

Also added `makeRecomputeDb` helper for structured DB mock sequencing and added `vi.mock` declarations for `@/lib/line/operational` and `@/lib/line/data`.

## Test Pass Count

- Targeted suite: 20/20 passing (16 pre-existing + 4 new)
- Full suite: 1118/1118 passing (162 test files)

## Deviations from Plan

None — plan executed exactly as written. The recompute block from the `<interfaces>` section matches the implementation verbatim, with field names confirmed against `schema.ts` before coding.

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes. The recompute block reuses existing `buildLineOperationalReviewPlan` and `patchLineSchedulerOperationalPlan` paths — no new trust boundaries.

## Self-Check: PASSED

- `src/lib/line/link-validation.ts` — FOUND
- `src/lib/line/__tests__/link-validation.test.ts` — FOUND
- commit `7bd6171` (RED) — FOUND
- commit `d8ee4b0` (GREEN) — FOUND
- `npm test` — 1118/1118 passing
