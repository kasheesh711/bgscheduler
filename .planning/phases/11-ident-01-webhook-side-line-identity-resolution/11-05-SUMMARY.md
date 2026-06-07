---
phase: 11-ident-01-webhook-side-line-identity-resolution
plan: "05"
subsystem: line
tags: [line, link-validation, worklist, phantom, isPhantom, drizzle, scope]

requires:
  - phase: 11-01
    provides: isPhantom column on lineContactStudentLinks + migration 0040_nifty_mercury
  - phase: 11-03
    provides: message_content sourceKind on suggested links from name-matcher

provides:
  - "realContactCondition() helper (isPhantom=false) used across all active worklist queries"
  - "'phantom' scope in LineLinkValidationScope for D-03 archive filter"
  - "getLineLinkValidationSummary count aggregates exclude phantom rows (IDENT-05)"
  - "patchLineLinkValidationTaskStatus guard fixed — message_content links can be verified (IDENT-04)"
  - "listLineLinkValidationReviewers counts real (non-phantom) assignments only"
  - "Tests for phantom scope type membership, scope behavior, verify guard, and summary counts"

affects:
  - line-review/mapping-validation-workspace
  - any consumer of LineLinkValidationScope type
  - line-review panel scope selector (needs 'phantom' option added to UI)

tech-stack:
  added: []
  patterns:
    - "realContactCondition() as the canonical active-scope predicate (replaces lineOaResolverSourceCondition in active queries)"
    - "D-03 archive filter via isPhantomScope boolean + eq(isPhantom, true) branch in listLineLinkValidationTasks"
    - "lineOaResolverSourceCondition() retained as dead code (definition preserved, zero active call sites)"

key-files:
  created: []
  modified:
    - src/lib/line/link-validation.ts
    - src/lib/line/__tests__/link-validation.test.ts

key-decisions:
  - "realContactCondition() uses isPhantom=false (not sourceKind filter) — catches ALL non-phantom sources including message_content and line_followers, not just OA-resolver"
  - "phantom scope returns ALL phantom rows regardless of status (no status constraint) — gives admins full visibility into quarantined links"
  - "lineOaResolverSourceCondition() function definition retained for backward compat; all active queries now use realContactCondition()"
  - "patchLineLinkValidationTaskStatus guard uses isPhantom=false not sourceKind — correctly allows verifying message_content links (IDENT-04 / Pitfall 4 from RESEARCH.md)"

patterns-established:
  - "Active scope queries always open with realContactCondition() as the base predicate"
  - "D-03 archive filter pattern: scope==='phantom' ? isPhantom=true : realContactCondition()"

requirements-completed:
  - IDENT-04
  - IDENT-05

duration: 7min
completed: 2026-06-07
---

# Phase 11 Plan 05: Widen Worklist Scope + Phantom Exclusion Summary

**Widened Mapping Validation worklist to all real contacts (isPhantom=false) and added D-03 phantom archive scope, with verify guard fixed for message_content links**

## Performance

- **Duration:** 7 min
- **Started:** 2026-06-07T08:07:32Z
- **Completed:** 2026-06-07T08:14:41Z
- **Tasks:** 1
- **Files modified:** 2

## Accomplishments

- Dropped `lineOaResolverSourceCondition()` from all 5 active query surfaces, replacing with `realContactCondition()` (isPhantom=false) — worklist now surfaces message_content and line_followers links in addition to historical OA-resolver links
- Added `"phantom"` to `LineLinkValidationScope` union + D-03 archive filter branch in `listLineLinkValidationTasks` (isPhantom=true, no status constraint)
- Fixed `patchLineLinkValidationTaskStatus` WHERE guard — changed from `lineOaResolverSourceCondition()` to `eq(isPhantom, false)` so message_content suggested links can be verified without silently returning null (Pitfall 4 from RESEARCH.md)
- `getLineLinkValidationSummary` count aggregates now exclude the 696 phantom rows — post-migration verified count reflects real contacts only
- 6 new tests added; total test count: 16 in this file; full suite: 1114 passing

## WHERE Clause Changes Made

| Surface | Change |
|---------|--------|
| `listLineLinkValidationReviewers` assignment count | `lineOaResolverSourceCondition()` → `realContactCondition()` |
| `listLineLinkValidationTasks` initial conditions | `lineOaResolverSourceCondition()` → `realContactCondition()` (active scopes) OR `isPhantom=true` (phantom scope) |
| `getLineLinkValidationSummary` count aggregates | `lineOaResolverSourceCondition()` → `realContactCondition()` |
| `assignLineLinkValidationTasks` candidate query | `lineOaResolverSourceCondition()` → `realContactCondition()` |
| `patchLineLinkValidationTaskStatus` WHERE guard | `lineOaResolverSourceCondition()` → `eq(isPhantom, false)` |

**Total surfaces updated: 5**

## lineOaResolverSourceCondition Status

Function definition is **still present** at line 243. Zero call sites remain in active queries. Retained for backward compatibility (could be used if phantom-scope needs explicit sourceKind filtering in future). No calls from outside the file.

## Test Cases Added

| Test | Behavior Verified |
|------|-------------------|
| `"phantom"` is valid `LineLinkValidationScope` | Type union includes phantom; runtime passes |
| All 6 scope values in the union | Explicit exhaustive check |
| `scope: "phantom"` resolves without error | D-03 archive branch runs; result has tasks/pagination |
| `scope: "all"` resolves without error | Active scope still works |
| `patchLineLinkValidationTaskStatus` returns non-null for message_content link | isPhantom=false guard allows message_content verify |
| `patchLineLinkValidationTaskStatus` returns null when DB returns empty | Phantom link correctly blocked |
| `getLineLinkValidationSummary` empty for non-lead actor | canViewTracker=false gating works |
| `getLineLinkValidationSummary` correct totals for lead actor | Count aggregates wired through correctly |

**Test pass count: 1114 / 1114 (full suite)**

## Task Commits

1. **Task 1: Widen worklist scope + phantom filter on all count queries** - `14fb004` (feat)

**Plan metadata:** (created below)

## Files Created/Modified

- `/Users/kevinhsieh/Developer/Scheduling/src/lib/line/link-validation.ts` — widened scope predicate, phantom filter on all active queries, phantom archive scope, verify guard fix
- `/Users/kevinhsieh/Developer/Scheduling/src/lib/line/__tests__/link-validation.test.ts` — 6 new test cases for phantom exclusion, scope type membership, verify guard fix, and summary count behavior

## Decisions Made

- `realContactCondition()` uses `isPhantom=false` (not a sourceKind filter) so it automatically covers `message_content`, `line_followers`, and any future sourceKind values — widened scope is source-agnostic
- Phantom archive scope returns ALL phantom rows regardless of status (no status constraint) — allows admins to audit historical OA-resolver links without filtering out already-verified or rejected ones
- `lineOaResolverSourceCondition()` definition intentionally preserved (zero active call sites) — in case phantom scope needs to be narrowed to OA-resolver-only in a future plan

## Deviations from Plan

None — plan executed exactly as written.

`listLineLinkValidationReviewers` was also updated (it was listed in the RESEARCH.md surfaces table but not explicitly called out in the plan task steps). This was a minor auto-inclusion: the function used `lineOaResolverSourceCondition()` for its assignment count query, which would have produced inflated counts (counting real-contact assignments against a phantom-only filter). Updating it to `realContactCondition()` ensures reviewer open-assignment counts reflect real contacts. This is covered under Rule 2 (missing correctness condition).

## Security Notes (Threat Model T-11-15, T-11-16, T-11-17)

- **T-11-15 (Tampering — phantom linkId verify):** `patchLineLinkValidationTaskStatus` WHERE `isPhantom=false` blocks any attempt to verify a phantom link even if the linkId is known. The route handler returns 404 on null result.
- **T-11-16 (Info Disclosure — inflated verified count):** All count aggregates now exclude phantoms. Post-migration verified count accurately reflects real-contact verifications only (~0 initially since no real-contact links have been verified yet).
- **T-11-17 (Tampering — phantom scope bulk un-quarantine):** Phantom scope is read-only (list only). No update action is connected to the phantom scope in this plan.

## Known Stubs

None — all data flows are wired to the real DB.

## Threat Flags

None — no new network endpoints, auth paths, or schema changes introduced in this plan.

## Next Phase Readiness

- Worklist re-pointed to real contacts; `message_content` suggested links now surfaced and verifiable
- Phantom archive filter available at `scope: "phantom"` for D-03 operations
- 11-06 (UI wiring for re-anchor button + phantom archive tab) and 11-07 (IDENT-06 inline recompute on verify) can proceed
- The mapping-validation-workspace UI needs to add `"phantom"` as a scope option to expose the archive filter to admins

## Self-Check: PASSED

- FOUND: src/lib/line/link-validation.ts
- FOUND: src/lib/line/__tests__/link-validation.test.ts
- FOUND: 11-05-SUMMARY.md
- FOUND: commit 14fb004

---

*Phase: 11-ident-01-webhook-side-line-identity-resolution*
*Completed: 2026-06-07*
