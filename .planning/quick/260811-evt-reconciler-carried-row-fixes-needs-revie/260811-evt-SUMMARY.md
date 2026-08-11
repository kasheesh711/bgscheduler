---
quick_id: 260811-evt
plan: 1
subsystem: classrooms
tags: [classroom-assignments, reconciliation, assignment-engine, needs-review, center-room-chain]
branch: feat/classroom-continuity
worktree: /Users/kevinhsieh/Developer/bgscheduler-classroom
requires:
  - src/lib/classrooms/reconciliation.ts (carried-row / fixed-block model)
  - src/lib/classrooms/assignment-engine.ts (center-room chain walk, occupancy, sticky continuity)
provides:
  - holdsRoom (renamed + widened from blocksRoom) gating all 3 carried-row call sites
  - ContextSession + AssignmentOptions.contextSessions (engine)
  - rowToContextSession projection wired into both assignPending passes
affects:
  - src/lib/classrooms/data.ts (full-run caller, unaffected — no contextSessions passed)
  - src/lib/room-capacity/data.ts (full-run caller, unaffected — no options object)
tech-stack:
  added: []
  patterns:
    - "context-only engine input: influences the requirement map, never rows/occupancy/continuity"
    - "predicate widening as a strict superset, proven by running pre-existing tests against the narrow version"
key-files:
  created: []
  modified:
    - src/lib/classrooms/reconciliation.ts
    - src/lib/classrooms/assignment-engine.ts
    - src/lib/classrooms/__tests__/reconciliation.test.ts
    - src/lib/classrooms/__tests__/assignment-engine.test.ts
    - docs/features/classroom-assignments.md
decisions:
  - "Claim pre-passes must check occupancy as well as protectedClaims — a claim the cascade cannot honor still fences the room off from everyone else (HI-A)"
  - "holdsRoom includes needs_review because a full engine run already adds such rows to occupancy and lastByTutor — only the NO_ROOM_AVAILABLE / REMOTE_NO_ROOM_NEEDED sentinels are excluded"
  - "ContextSession carries groupId because tutorKey prefers groupId over normalized name; omitting it would split a tutor's carried and pending sessions into different buckets and silently defeat the fix"
  - "contextSessions is consumed only by buildCenterRoomRequirementMap; entries are skipped when already pending and never receive a requirement entry of their own"
metrics:
  tasks: 2
  commits: 3
  new_tests: 8
  files_modified: 5
  completed: 2026-08-11
---

# Quick Task 260811-evt: Reconciler Carried-Row Fixes Summary

Two pre-existing reconciler divergences fixed, both rooted in the reconciler handing `assignClassrooms` an incomplete picture of the day: carried `needs_review` rows were invisible for occupancy and continuity, and the online center-room chain was computed from pending sessions alone.

## What Shipped

**Task 1 — `holdsRoom` (`8654002`)** — fixes HI-01 + MD-02
`blocksRoom` required `status === "assigned"`, so a carried row with `status: "needs_review"` and a real `assignedRoom` (e.g. `needs_review_missing_capacity`) was invisible when pending sessions were placed. Renamed to `holdsRoom` and widened to `assigned || needs_review`, keeping the two sentinel exclusions. Applied at all three call sites — `rowToExternalBlock` (stops double-booking, HI-01), `fixedTutorAssignmentsFrom` (restores sticky continuity seeding, MD-02), and the unlock-retry filter (a carried `needs_review` row is now equally displaceable). `grep -rn "blocksRoom" src/` returns nothing. 3 new tests.

**Task 2 — `contextSessions` (`ec7d31d`)** — fixes the center-room chain blind spot
`assignPending` passes only *pending* sessions, so `buildCenterRoomRequirementMap` computed each tutor's <60-minute online↔onsite adjacency chain from pending sessions alone — a pending online session whose only nearby session was a *carried* onsite row was judged in isolation and wrongly went `REMOTE_NO_ROOM_NEEDED`. Added `ContextSession` + `AssignmentOptions.contextSessions`, consumed only by `buildCenterRoomRequirementMap`: the chain is walked over pending ∪ context, context ids already present in `sessions` are skipped, and only pending ids ever receive a requirement entry. `tutorKey` / `sortedTutorSessions` / `onlineSessionRequiresCenterRoom` were retyped to `ContextSession` (a pure widening — every `AssignmentSession` already satisfies it). The reconciler projects every carried row via `rowToContextSession` on both `assignPending` passes. 4 new tests (2 engine, 2 reconciliation).

## Post-Review Fix — HI-A (`5652f05`)

Follow-up review found a third defect, fixed in a third commit. This is the last code commit before deploy.

**Defect.** All three claim pre-passes in `assignment-engine.ts` (override, priority-preferred, preferred) checked only `isAvailable(protectedClaims, ...)` and never `isAvailable(occupancy, ...)`. At pre-pass time `occupancy` already holds the external room blocks (carried rows + live Wise blocks), so a claim staked on a room an external block occupies is **unusable** at cascade time — the cascade's `roomAvailable` checks occupancy and rejects it — yet the claim still fences that room off from every other session for the claimed interval. Reviewer's repro: external block on `Never Ever (TV)` 10:00–10:30 + a Ras session 10:00–11:00 + a generic session 10:30–11:00 → the generic session gets `NO_ROOM_AVAILABLE`; remove Ras and it gets `Never Ever (TV)`.

This is pre-existing, but two things in this branch enlarge it: commit `8654002` routes carried `needs_review` rows into `externalRoomBlocks` (growing the trigger set on the morning-cron reconciled path), and Ras became priority-preferred in `2b742da`.

**Fix.** Added `if (!isAvailable(occupancy, <room>, session, session.wiseSessionId)) continue;` to each of the three pre-passes, mirroring the existing `protectedClaims` call, plus a block comment at the pre-pass head explaining the invariant: a claim is only ever staked when the cascade could actually honor it.

**Regression test** pins the reviewer's exact differential — external block on `Never Ever (TV)` 600–630, Ras 600–660, generic 630–660 over `roomsFor("Never Ever (TV)", "Remember (TV)")` — asserting no row is `no_room`, the generic session gets `Never Ever (TV)` (it starts exactly when the block ends), and Ras gets a real room that is *not* `Never Ever (TV)` (`Remember (TV)`, since the block overlaps her whole window and she is TV-required).

**Differential proof.** With the three occupancy checks stripped out, the classroom suite reports **exactly 1 failure — the new test — and 140 passes**. The failure is `expected true to be false` on the `no_room` assertion, reproducing the reviewer's scenario precisely. That single-failure result also empirically answers the "does any pinned test stake claims over external blocks?" question: **none do**, since every other test behaves identically with and without the checks. The engine file was restored and `diff`-confirmed byte-identical before committing.

## Verification

| Gate | Result |
|------|--------|
| `npx vitest run src/lib/classrooms` after Task 1 | 11 files, **136 passed** (+3) |
| `npx vitest run src/lib/classrooms` after Task 2 | 11 files, **140 passed** (+4) |
| `npm test` after Task 2 | 360 files, 4170 tests passed |
| `npx vitest run src/lib/classrooms` after HI-A | 11 files, **141 passed** (+1) |
| `npm test` after HI-A (final) | **360 files, 4171 tests passed** |
| `npx tsc --noEmit` (final) | clean (exit 0, no output) |
| HI-A differential (checks removed) | exactly 1 failure — the new test — 140 pass |
| `grep -rn "blocksRoom" src/` | no matches |
| `TODO`/`FIXME`/`HACK` in changed source | none |
| Unexpected file deletions in either commit | none |
| Declaration counts vs docs | engine 44, reconciliation 14 — both match |

### Differential proof (both fixes verified to actually pin the bugs)

Rather than trusting that the new tests assert real behavior change, each fix was temporarily reverted and the tests re-run:

- **Task 1** — with `holdsRoom` narrowed back to `status === "assigned"`, all 3 new tests fail with exactly the predicted symptoms: `expected 'Room A' to be 'Room B'` (double-booking), `expected 'Room A' to be 'Room B'` (no continuity seed), and `expected [] to have a length of 1` (both sessions silently claiming the same room). The **9 pre-existing tests still passed under the narrow predicate**, which is the direct evidence that the widening is a strict superset and changes no existing behavior.
- **Task 2** — with `contextSessions` forced to `[]` in the reconciler, the center-room test fails with `expected 'remote' not to be 'remote'`, while the "keeps remote when it has no onsite chain neighbor" test still passes — proving the fix connects real neighbors without over-connecting across tutors.

Both files were restored and byte-compared (`diff` clean) before committing.

### Engine-inertness when unused

The coordinator's hard constraint was that engine behavior with no `contextSessions` must be identical to HEAD. Three things establish this:
1. A dedicated engine test deep-compares (`toEqual`) full `AssignmentResult`s across no-options / `{}` / `{ contextSessions: [] }` — all identical.
2. With an empty context list the new `for` loop is a no-op and the new `pendingIds` guard is always true for every session that reaches it (every bucket entry originated from `sessions`), so nothing that used to run is skipped.
3. The two external `assignClassrooms` callers (`classrooms/data.ts`, `room-capacity/data.ts`) pass no `contextSessions` and were untouched; the full 4170-test suite passes.

## Deviations from Plan

**None.** All edits applied exactly as specified — the plan's Find/Replace blocks matched the files verbatim, every hand-traced test assertion held on first run, and the plan's pinned-test conflict analysis proved correct (no pre-existing test in either file needed changing, so the "STOP and report" condition never triggered). The only additions beyond the literal instructions were the two differential verifications above, which are validation steps, not code changes.

Doc line citations were grep-verified twice as the plan required — once in Task 1 (`:276`/`:328`/`:117`/`:345`/`:372`) and refreshed in Task 2 after that task's own insertions shifted them (`:293`/`:345`/`:118`/`:369`/`:396`), plus the new paragraph's `assignment-engine.ts:101`, `:295`, and `reconciliation.ts:142`.

## Known Stubs

None. Both fixes are wired to live call paths: `holdsRoom` gates all three carried-row consumers, and `contextSessions` is populated on both `assignPending` passes from real carried rows.

## Out of Scope (unchanged, per plan `<planner_concerns>` item 2)

The docs carry pre-existing line-citation drift unrelated to this work — the "Room selection cascade" sentence's `:455`–`:591` range and its nested `:179`–`:184` / `:405`–`:415` sub-citations were already inaccurate before this plan and are shifted further by Task 2's insertions. Fixing them properly needs a full independent citation audit, which the sibling plan also explicitly scoped out. Flagging so it is a known debt item, not an oversight.

## Self-Check: PASSED

- `holdsRoom` defined and gating all 3 call sites; `blocksRoom` absent from `src/`.
- `ContextSession` exported, `AssignmentOptions.contextSessions` present, `buildCenterRoomRequirementMap(sessions, options.contextSessions ?? [])` wired, `contextSessions: fixedRows.map(rowToContextSession)` present in `assignPending`.
- All three claim pre-passes carry the `isAvailable(occupancy, ...)` guard (3 occurrences confirmed).
- All three commits verified in `git log`: `8654002`, `ec7d31d`, `5652f05`.
