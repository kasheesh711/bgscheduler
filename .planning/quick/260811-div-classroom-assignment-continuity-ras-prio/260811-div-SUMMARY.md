---
quick_id: 260811-div
plan: 1
subsystem: classrooms
tags: [classroom-assignments, assignment-engine, reconciliation, continuity, churn-metric]
branch: feat/classroom-continuity
worktree: /Users/kevinhsieh/Developer/bgscheduler-classroom
requires:
  - src/lib/classrooms/assignment-engine.ts (existing cascade + pre-pass machinery)
  - src/lib/classrooms/reconciliation.ts (existing carried-row/fixed-block model)
provides:
  - GENERAL_CONTINUITY_GAP_MINUTES, normalizedPhysicalRoom, FixedTutorAssignment (assignment-engine)
  - AssignmentOptions.fixedTutorAssignments + same-day sticky-room cascade step
  - fixedTutorAssignmentsFrom continuity seed (reconciliation)
  - buildRoomChurnSummary + RoomChurnSummary (visualization)
  - eight-tile run summary with Room switches tile, per-tutor room-switch badge (workspace)
affects:
  - src/lib/room-capacity/* (reuses assignClassrooms; full suite green, no behavior pinned)
tech-stack:
  added: []
  patterns:
    - "sticky-room cascade step placed after preferred-room so displaced preferred tutors still return home"
    - "generic <TRow extends ClassroomVisualizationRow> helper, matching every other build* in visualization.ts"
key-files:
  created: []
  modified:
    - src/lib/classrooms/rooms.ts
    - src/lib/classrooms/assignment-engine.ts
    - src/lib/classrooms/reconciliation.ts
    - src/lib/classrooms/visualization.ts
    - src/components/class-assignments/class-assignments-workspace.tsx
    - src/lib/classrooms/__tests__/assignment-engine.test.ts
    - src/lib/classrooms/__tests__/reconciliation.test.ts
    - src/lib/classrooms/__tests__/visualization.test.ts
    - docs/features/classroom-assignments.md
decisions:
  - "Sticky reuse must respect soft scoring, not just hard constraints — it skips any room roomPriorityScore demotes for the current session (CR-01)"
  - "Ras's priority lock needed no engine change — pre-pass 2 already stakes priority-preferred claims before pre-pass 3's ordinary claims"
  - "latestPriorRoomForTutor reads lastByTutor unfiltered (preserves existing semantics) but filters fixed entries to endMinute <= startMinute so an afternoon carried row can't shadow a morning session"
  - "switchesByTutor omits zero-switch tutors — the only consumer checks > 0"
metrics:
  tasks: 4
  commits: 5
  new_tests: 16
  rewritten_tests: 1
  files_modified: 9
  completed: 2026-08-11
---

# Quick Task 260811-div: Classroom Assignment Continuity + Ras Priority Lock Summary

Tutors now keep one physical room across a whole day instead of re-rolling to the "best free room" every slot, Ras holds a priority lock on Never Ever (TV), incremental reconciled runs seed that continuity from carried rows, and the workspace surfaces a room-switch churn count so admin staff can see the effect.

## What Shipped

**Task 1 — Ras priority lock (`2b742da`)**
Added both Ras identities (`Rasna (Ras) Rajkitkul` and its `Online` variant) to `PREFERRED_BY_TUTOR` and the module-private `PRIORITY_PREFERRED_ROOM_BY_TUTOR`, both mapped to `Never Ever (TV)`. No engine change was needed: pre-pass 2 stakes priority-preferred claims before pre-pass 3 considers Mandy's/Calvin's ordinary claim on the same room, so on overlap Mandy/Calvin fall through to the general pool for that slot only. Rewrote the now-inaccurate Rasna test (`preferredRoom` is no longer `null`) and added 4 Ras-priority tests.

**Task 2 — Same-day sticky room (`9360a2a`)**
New cascade step between preferred-room and online-only rooms: a tutor reuses their most recently held room at **any** non-negative gap, subject to `roomOk` / `roomAvailable` (which checks both occupancy and `protectedClaims`) and the non-Gift Joy exclusion. Trace string `assigned by sticky room: {room}`. Added `FixedTutorAssignment`, `AssignmentOptions.fixedTutorAssignments`, the `latestPriorRoomForTutor` resolver, `GENERAL_CONTINUITY_GAP_MINUTES` (extracted from a hardcoded `15`), and exported the previously private `normalizedPhysicalRoom`. 5 new tests, including the regression-prover (30-min gap keeps Hakuna Matata rather than moving to a freed Think Outside the Box) and a step-ordering pin proving a ≤15-min gap still takes the `assigned by continuity:` path, not sticky.

**Task 3 — Reconciler continuity seed (`26bca3d`)**
`fixedTutorAssignmentsFrom(rows)` derives fixed assignments from carried rows, reusing the existing `blocksRoom` predicate so "this row holds a physical room" stays one definition shared with the external-block path. Wired into `assignPending`'s options, which both the initial pass and the unlock-retry pass flow through. 2 new tests: a carried row seeds the new session into Room B (not sort-order-first Room A), and a remote carried row seeds nothing.

**Task 4 — Churn metric (`526bac1`)**
`buildRoomChurnSummary(rows)` in `visualization.ts` counts, per tutor, adjacent pairs whose *physical* room differs (via `normalizedPhysicalRoom`, so `Joy` ≡ `Joy (TV)`), skipping remote and `NO_ROOM_AVAILABLE` rows. The workspace run summary grid went `lg:grid-cols-7` → `-8` with a new "Room switches" tile, and each Tutor Schedule card header carries an outline badge with that tutor's switch count when > 0. 4 new tests on the pure helper; no component test, matching the repo's convention of testing the extracted math rather than the JSX shell.

## Post-Review Fix — CR-01 (`2471148`)

Code review found a **critical** defect in the Task 2 sticky-room step, fixed in a fifth commit.

**Defect.** The sticky step checked only `roomOk` (hard constraints) and never the soft-scoring demotion in `roomPriorityScore`, which returns 2 000 for `Relax (TV)` when `minCapacity <= 3` precisely to keep the only 8-seat room free for large groups. So a tutor teaching a morning group in `Relax (TV)` would stick there through their afternoon 1:1s, and an overlapping later group could be pushed to `NO_ROOM_AVAILABLE` — a regression against `origin/main`, where all three sessions were assigned.

**Fix.**
1. Extracted the `2_000` literal into a module constant `DEMOTED_ROOM_SCORE` and used it in `roomPriorityScore`.
2. Added a per-session `roomDemotedForSession(roomName)` predicate next to `roomOk`/`roomAvailable` that looks the room up via `roomByName` and reports `roomPriorityScore(def, minCapacity) >= DEMOTED_ROOM_SCORE`. The sticky step now additionally requires `!roomDemotedForSession(last.room)`; a small session falls through to `pickBestRoom` exactly as it did before the sticky feature existed. All other sticky conditions are unchanged, and steps 4/6 (online + general continuity) were deliberately left alone — their behavior is pinned and they only fire on tight gaps where the pre-existing engine had the same exposure.
3. Added a regression test pinning the differential scenario: `Relax (TV)` (cap 8) + `Focus` (2) + `Cool` (3); Tutor One 09:00–10:00 with 6 students → `Relax (TV)`; Tutor One 11:00–12:00 1:1 → asserts **not** `Relax (TV)`, status `assigned`, and no `assigned by sticky room: Relax (TV)` trace; Tutor Two 11:00–12:00 with 6 students → asserts `Relax (TV)`; plus `no row has status "no_room"`.
4. Extended the docs cascade sentence with the "never a room that soft scoring demotes for *this* session" clause.

**The regression test was verified to be a true differential**, not just a passing assertion: with the `!roomDemotedForSession(...)` condition temporarily removed, it fails with `expected 'Relax (TV)' not to be 'Relax (TV)'` — the 1:1 squats the big room. The engine file was then byte-for-byte restored (`diff` clean) before committing.

The reviewer's suggested timings (a non-overlapping 13:00–14:00 group) would **not** have reproduced the defect, since `Relax (TV)` frees up at 12:00 regardless. The test therefore places the later group at 11:00–12:00 so it genuinely overlaps the 1:1, which is what starves it. Session sort order (`startMinute`, then tutor name) means Tutor One's 1:1 is placed first, so on the buggy code it takes `Relax (TV)` before Tutor Two's group is ever considered.

## Verification

| Gate | Result |
|------|--------|
| `npx vitest run src/lib/classrooms` (after each task) | green — 121 → 126 → 128 |
| `npx vitest run src/lib/classrooms src/components/class-assignments` | 13 files, 142 tests passed |
| `npm test` (full unit suite, pre-review) | 360 files, 4162 tests passed |
| `npx vitest run src/lib/classrooms` (after CR-01) | 11 files, **133 tests passed** |
| `npm test` (full unit suite, after CR-01) | **360 files, 4163 tests passed** |
| `npx tsc --noEmit` (after CR-01) | clean (exit 0, no output) |
| CR-01 regression test fails without the fix | confirmed (differential verified, engine restored) |
| `TODO`/`FIXME`/`HACK` in changed source | none |
| Unexpected file deletions across all 5 commits | none |

Every pre-existing assertion passed unmodified. The only existing-test change was the sanctioned Rasna rewrite. The pinned boundary tests named in the plan — 15-min general continuity, 60-min online continuity, Mek's Iconic (TV) protection, the 5-tutor preferred-room `it.each` family, and the single-session no-ops — are behaviorally untouched.

## Deviations from Plan

### Auto-fixed issues

**1. [Rule 1 - Bug] Corrected the cascade-range start line in the docs**
- **Found during:** Task 2, docs Edit A
- **Issue:** The plan asserted the cascade citation's start, `assignment-engine.ts:417`, was "unaffected since all of this task's insertions land after it". That is false — the new constant (`+1`), the `FixedTutorAssignment` interface (`+8`), and the `fixedByTutor`/`latestPriorRoomForTutor` block (`+29`) all precede it. Following the plan literally would have shipped a citation 38 lines off.
- **Fix:** Verified both ends against the edited file (`let assignedRoom = "";` is now `:455`; the no-room branch closes at `:591`) and wrote `` `assignment-engine.ts:455`–`:591` ``. This is the same "verify, don't guess" discipline the plan mandated for the range's end.
- **Commit:** `9360a2a`

**2. [Rule 1 - Bug] Corrected two banner citations the churn memo shifted**
- **Found during:** Task 4, docs Edit A
- **Issue:** The plan only asked to update the tile-count citation `:743`. But the `churnSummary` memo added 2 lines above them, so the two sibling citations in that same sentence — the snapshot freshness banner `:704` and the live-Wise-room-blocker banner `:723` — were left stale by my own change.
- **Fix:** Verified all three against the edited file and updated them to `:706`, `:725`, `:745`.
- **Commit:** `526bac1`

**3. [Rule 2 - CLAUDE.md conformance] Added JSDoc to `buildRoomChurnSummary`**
- **Found during:** Task 4
- **Issue:** The plan's code block for `buildRoomChurnSummary` carried no JSDoc, but CLAUDE.md requires "JSDoc on exported functions (numbered steps for multi-step algorithms)" and this is a 4-step algorithm whose switch definition is load-bearing.
- **Fix:** Added a numbered 4-step JSDoc documenting the drop/group/sort/compare sequence. Behavior unchanged.
- **Commit:** `526bac1`

No architectural changes were required, and no checkpoint or authentication gate was hit.

## Follow-ups (carried from the approved plan, deliberately out of scope)

- The reconciler still passes only *pending* sessions to `buildCenterRoomRequirementMap`, so the online center-room 60-minute chain can still break across carried onsite rows in an incremental run. Same root-cause family, but it changes remote/assigned semantics — separate ticket.
- Also out of scope, per the approved plan: AMB-25/26/27, roster changes beyond Ras, and the publish flow.
- Manual validation still pending (post-merge/post-deploy): trigger a run for a future Saturday and confirm the Room switches tile drops and Ras lands on Never Ever (TV) wherever capacity allows; after the morning cron, spot-check a reconciled run for `assigned by sticky room:` traces reusing carried rooms.

## Known Stubs

None. Every code path added here is wired to a real consumer: the sticky step runs in the live cascade, `fixedTutorAssignments` is populated from real carried rows, and `buildRoomChurnSummary` feeds both the run-summary tile and the per-tutor badge.

## Self-Check: PASSED

- CR-01 fix present: `DEMOTED_ROOM_SCORE` constant, `roomDemotedForSession` predicate, and the sticky-step gate all verified in `assignment-engine.ts`; commit `2471148` verified in `git log`.

- All 9 modified files present with the expected exports/content (`Rasna (Ras) Rajkitkul` ×6 in `rooms.ts`; `GENERAL_CONTINUITY_GAP_MINUTES`, `FixedTutorAssignment`, `fixedTutorAssignments?`, `normalizedPhysicalRoom` in the engine; `fixedTutorAssignmentsFrom` defined and wired in `reconciliation.ts`; `RoomChurnSummary` + `buildRoomChurnSummary` in `visualization.ts`; `churnSummary` memo, Room switches tile, and per-tutor badge in the workspace).
- All 4 commits verified present in `git log`: `2b742da`, `9360a2a`, `26bca3d`, `526bac1`.
