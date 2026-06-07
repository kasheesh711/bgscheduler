---
phase: 11
plan: "04"
subsystem: line-identity
tags: [line, followers, reanchor, identity, student-links]
dependency_graph:
  requires: ["11-02", "11-03"]
  provides: ["fetchLineFollowerIds", "runLineFollowersReanchor", "POST /api/line/contacts/followers-reanchor"]
  affects: ["src/lib/line/client.ts", "src/lib/line/student-links.ts"]
tech_stack:
  added: []
  patterns: ["paginated-cursor-fetch", "onConflictDoNothing-upsert", "4-step-route-error-handling"]
key_files:
  created:
    - src/app/api/line/contacts/followers-reanchor/route.ts
    - src/app/api/line/contacts/followers-reanchor/__tests__/route.test.ts
  modified:
    - src/lib/line/client.ts
    - src/lib/line/student-links.ts
    - src/lib/line/__tests__/client.test.ts
decisions:
  - "lineContacts has no sourceKind column — omitted from upsert (schema.ts verified)"
  - "names=undefined passed to ensureLineContactStudentLinkSuggestions — followers have no AI-extracted state at re-anchor time; display-name/dotted-code path only"
  - "upsertLineContactFromFollower returns existing id after onConflictDoNothing for idempotency"
metrics:
  duration: "~3 min"
  completed: "2026-06-07"
  tasks_completed: 2
  files_changed: 5
---

# Phase 11 Plan 04: Followers Re-anchor Job Summary

Paginated LINE followers re-anchor — seeds correct-namespace contacts from the OA's real followers list and runs display-name suggestion matching per contact.

## What Was Built

### New route URL
`POST /api/line/contacts/followers-reanchor`

### maxDuration confirmed
`export const maxDuration = 60;`

### Files Created vs Extended

**Created:**
- `src/app/api/line/contacts/followers-reanchor/route.ts` — admin-authenticated POST route (auth() gate, 4-step error handling, maxDuration=60)
- `src/app/api/line/contacts/followers-reanchor/__tests__/route.test.ts` — 3 route tests (401, 200, 500)

**Extended:**
- `src/lib/line/client.ts` — added `LineFollowersPage` interface and `fetchLineFollowerIds(startCursor?)` with cursor-based pagination, limit=300, non-string filtering
- `src/lib/line/student-links.ts` — added `LineFollowersReanchorResult` interface, `runLineFollowersReanchor` service function, and private `upsertLineContactFromFollower` helper
- `src/lib/line/__tests__/client.test.ts` — 4 new tests for `fetchLineFollowerIds` (first page, next page, error, filter)

### Test Count Added
7 new tests (4 client + 3 route)

Full suite result: **162 test files, 1106 tests passing**

### names=undefined Confirmation

`runLineFollowersReanchor` calls `ensureLineContactStudentLinkSuggestions` with `names=undefined` per follower. This means only the display-name/dotted-code suggestion path runs for followers — followers have no AI-extracted state at re-anchor time. Name-based matching (from `extractedState`) fires separately in Plan 11-03 when real messaging contacts send messages and accumulate conversation state.

## Decisions Made

- **No `sourceKind` on lineContacts**: Confirmed from `schema.ts` — the `lineContacts` table has no `sourceKind` column (it is on `lineContactStudentLinks`). The `upsertLineContactFromFollower` helper inserts only the columns that exist: `lineUserId`, `displayName`, `pictureUrl`, `statusMessage`.
- **Idempotency via onConflictDoNothing**: The upsert returns the inserted id; when a conflict occurs (contact already exists), it fetches the existing id via a subsequent SELECT. Re-running the route does not duplicate contacts or overwrite existing data.
- **Fail-closed per follower**: Profile fetch failures for a single follower are caught and added to `result.errors[]`; the loop continues with remaining followers. The overall job never returns a 500 unless the pagination itself fails.

## Commits

- `74332bd` — test(11-04): add failing tests for fetchLineFollowerIds (RED)
- `d86ddb9` — feat(11-04): add fetchLineFollowerIds with pagination to LINE client (GREEN)
- `e625977` — test(11-04): add failing tests for followers-reanchor route (RED)
- `4d97752` — feat(11-04): implement runLineFollowersReanchor + admin POST route (GREEN)

## Deviations from Plan

None — plan executed exactly as written. One schema adjustment: `sourceKind` was noted in the plan's interface block as conditional ("If sourceKind is not on lineContacts, omit it"), and it was correctly omitted after schema.ts verification.

## Self-Check: PASSED

- `src/lib/line/client.ts` — fetchLineFollowerIds and LineFollowersPage present
- `src/lib/line/student-links.ts` — runLineFollowersReanchor and LineFollowersReanchorResult present; onConflictDoNothing count = 4 (>= 2)
- `src/app/api/line/contacts/followers-reanchor/route.ts` — exists, maxDuration=60, Unauthorized 401 check
- All commits verified in git log
- `npm test` — 162/162 files, 1106/1106 tests passing
