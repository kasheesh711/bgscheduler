---
phase: 260811-evt-reconciler-carried-row-fixes-needs-review
reviewed: 2026-08-11T04:35:00Z
depth: quick (rigorous, differential probes)
diff_range: 2471148..HEAD (2 commits, feat/classroom-continuity)
commits:
  - 8654002 fix(classrooms) hold rooms and continuity for carried needs-review rows
  - ec7d31d fix(classrooms) compute online center-room chains across carried sessions
files_reviewed: 5
files_reviewed_list:
  - src/lib/classrooms/assignment-engine.ts
  - src/lib/classrooms/reconciliation.ts
  - src/lib/classrooms/__tests__/assignment-engine.test.ts
  - src/lib/classrooms/__tests__/reconciliation.test.ts
  - docs/features/classroom-assignments.md
findings:
  critical: 0
  high: 1
  medium: 1
  low: 3
  total: 5
status: issues_found
---

# Reconciler carried-row fixes (`holdsRoom` + `contextSessions`) — Code Review

**Reviewed:** 2026-08-11
**Depth:** quick, with differential probes (reconciled run vs. equivalent full run) on every claim the two commits make
**Verification:** `tsc --noEmit` clean; full unit suite `360 files / 4170 tests` pass; 16 throwaway probe scenarios executed and deleted. Working tree left clean.

## Summary

**Both fixes are correct and land exactly what they claim.** Verified end to end:

- **HI-01 is closed.** A carried `needs_review` row now emits an `ExternalRoomBlock`, so the double-booking I reproduced last round is gone: carried `needs_review` in `Room A` 09:00–10:00 + new session 09:30–10:30 now yields `Room A` / **`Room B`** instead of `Room A` / `Room A`.
- **MD-02 is closed.** A carried `needs_review` row now seeds `fixedTutorAssignments`: the tutor's 13:00 session lands back in the carried `Room B` via `assigned by sticky room: Room B`.
- **The `holdsRoom` predicate is now exactly equivalent to the engine's own guard.** `assignment-engine.ts:655` gates `lastByTutor` on the sentinels only, with no status check, and `status` is derived in lockstep with those sentinels (`remote` ⟺ `REMOTE_NO_ROOM_NEEDED`, `no_room` ⟺ `NO_ROOM_AVAILABLE`), so `(assigned | needs_review) && not-a-sentinel` is the same set. Full-run parity for occupancy and continuity inputs is now genuine.
- **`blocksRoom` is fully retired** — zero stale references anywhere in `src/`.
- **The widening does not leak into any "assigned"-gated path.** Publish eligibility (`data.ts:1221`), schedule email (`schedule-email.ts:231`), and both summary counters (`data.ts:846`, `assignment-engine.ts:689`) still test `status === "assigned"` and are untouched, so a `needs_review` row still cannot publish or be emailed.
- **Unlock semantics are right.** Verified: a carried `needs_review` row that overlaps a failed pending session *is* displaced, re-assigned, lands back in the same room, and is correctly re-labeled `carried` with `publishStatus: "success"` preserved (`preservePublish` via the `sameAssignment` branch). A non-overlapping one is not unlocked. An **override-pinned** `needs_review` row is still protected (`!row.overrideRoom` guard at `:376`).
- **`contextSessions` is genuinely inert.** Its only consumer in the entire codebase is `buildCenterRoomRequirementMap` (`assignment-engine.ts:396`) — it never reaches rows, occupancy, `lastByTutor`, `fixedByTutor`, or any of the three claim pre-passes. Verified: a run with one pending session plus one context session returns `rows.length === 1` and `counts.totalSessions === 1`, and the context session's room is not occupied. There is no `assignedRoom` field on `ContextSession` for a room to leak through.
- **Dedupe works.** The `pendingIds.has(context.wiseSessionId)` skip at `:306` plus the `if (!pendingIds.has(...)) continue` guard at `:314` mean a colliding id is ignored and context sessions never receive a requirement entry. Unreachable from the reconciler anyway (carried and pending are disjoint by construction, and the unlock-retry moves rows from `fixedRows` into `sessions` before re-calling).
- **`tutorKey` is consistent across both populations.** `carryRow` spreads the *current* session (`...session`), so a carried row's `groupId` / `tutorDisplayName` are the live values, identical to what the pending sessions carry.
- **Chain bridging is faithful.** Carried rows of *every* status — including `remote` and `no_room` — are passed as context, which is right: a full run over the same final session set sees all of them too. Verified with an onsite→online→online chain: reconciled and full runs agree that the trailing pending online session requires a center room. Canceled sessions correctly are *not* context (they never enter `carriedRows`).
- **No regression to the earlier checklist.** The demotion guard added in the base commit `2471148` holds — the CR-01 `Relax (TV)` squat no longer reproduces (`solo-pm` → `Think Outside the Box`, `group-pm` → `Relax (TV)`, no `NO_ROOM_AVAILABLE`). Sticky, the Joy exclusion, and the Ras config are untouched by this range.

**What remains** is one pre-existing engine defect that this diff makes materially more reachable, and one half of the parity invariant that `ec7d31d` states but does not establish. Neither is a defect in the code that was written; both are gaps the fixes bring into focus.

---

## HIGH

### HI-A: A priority/preferred claim staked on a room that an external block already occupies is wasted *and* blocks that room for everyone else — reachable via carried rows, and now more so

**File:** `src/lib/classrooms/assignment-engine.ts:413`–`:459` (all three claim pre-passes), consumed at `:481`

**Issue.** The three claim pre-passes test only `isAvailable(protectedClaims, …)` (`:419`, `:442`, `:456`). None of them consults `occupancy`, which is where `externalRoomBlocks` — live Wise room blockers **and every carried row from the reconciler** — are seeded (`:352`–`:360`). So a claimant can stake `protectedClaims` on a room it will never be able to use, and because `roomAvailable` (`:479`–`:481`) checks `protectedClaims` for *everyone*, that dead claim removes the room from the pool for the rest of its window.

Verified with two TV rooms, an external block on `Never Ever (TV)` for 10:00–10:30, Ras at 10:00–11:00, and a generic tutor at 10:30–11:00:

| | with Ras present | control (Ras removed) |
|---|---|---|
| `ras` 10:00–11:00 | `Iconic (TV)` (priority room unusable — occupancy) | — |
| `gen` 10:30–11:00 | **`NO_ROOM_AVAILABLE`** | `Never Ever (TV)` |

The 10:30–11:00 half of `Never Ever (TV)` is free in `occupancy` but fenced off by Ras's dead claim, so a placeable session is emitted as `no_room`.

**This is pre-existing** — the pre-passes have never consulted `occupancy`, and `externalRoomBlocks` predate this branch. It is reported here because (a) the coordinator asked what reconciled-vs-full divergence remains in the *occupancy* inputs, and this is one where the reconciled path emits `NO_ROOM_AVAILABLE` that an equivalent full run does not, and (b) `8654002` widens `holdsRoom`, which routes carried `needs_review` rows into `externalRoomBlocks` for the first time — so the set of blocks that can trigger this just grew. It fires on the reconciled path, which is the one the morning cron actually runs.

**Fix.** Make a claim conditional on the room being physically free as well, in all three pre-passes:

```ts
if (!isAvailable(protectedClaims, priorityPreferredRoom, session, session.wiseSessionId)) continue;
if (!isAvailable(occupancy, priorityPreferredRoom, session, session.wiseSessionId)) continue;   // add
```

`occupancy` at that point contains only `externalRoomBlocks` (no session has been placed yet), so this is safe and order-independent. Pin it with the two-row table above.

---

## MEDIUM

### MD-A: Only half the center-room parity invariant is established — a carried row's own requirement is never recomputed

**File:** `src/lib/classrooms/reconciliation.ts:361` and `src/lib/classrooms/assignment-engine.ts:296`–`:320`

**Issue.** `ec7d31d` states full-run parity as the invariant, and it achieves it in one direction: a *pending* session now sees carried neighbours when walking the `<60`-minute chain. Verified working — a pending `ONLINE` session 10:30–11:30 next to a carried onsite 09:00–10:00 now correctly gets `Room A` instead of being marked `remote`.

The mirror case is untouched. A carried row keeps whatever verdict the *previous* run computed, and nothing re-examines it when the day's session set changes around it. Because `classifyChange` fingerprints only the session's own 17 fields (`:67`–`:85`), a session whose *neighbours* changed still fingerprints identical and is carried. Verified:

| | reconciled run | equivalent full run |
|---|---|---|
| `online-old` `ONLINE` 10:30–11:30 (carried, was alone) | **`REMOTE_NO_ROOM_NEEDED`** / `remote` | `Booth (online)` / `assigned` |
| `onsite-new` `OFFLINE` 12:00–13:00 (added) | `Room A` | `Room A` |

Operationally: the tutor is told to teach 10:30–11:30 remotely, then has an onsite class at 12:00 they must physically attend — with no room booked for the online hour. The reverse also holds: removing an onsite neighbour leaves a carried online session squatting a center room it no longer needs.

**Fix.** Recompute the requirement for carried rows and un-carry the ones whose verdict flipped. Cheapest form: after `carriedRows` is built, run `buildCenterRoomRequirementMap(allSessions)` over the *full* set once, compare each carried row's `status === "remote"` against `centerRoomRequired`, and move any mismatch into `pendingSessions` with `changeType: "changed"`. Alternatively, narrow the invariant claim in `docs/features/classroom-assignments.md` so it does not promise parity it does not deliver.

---

## LOW

### LO-A: Continuity-seed selection differs between a full run and a reconciled run when a tutor has overlapping same-day sessions

`assignment-engine.ts:378`–`:391` vs `:655`. A full run's `lastByTutor` holds the **last-processed** (greatest *start*) session; `latestPriorRoomForTutor` picks the greatest **end** among the qualifying fixed entry and the dynamic entry. These disagree when a tutor has two overlapping sessions. Verified — same three sessions (X 09:00–11:00, Y 09:30–10:00, Z 12:00–13:00), X carried in the split run:

- full run: `Z` → `Iconic (TV)` (seeded from Y, the last-started)
- reconciled run: `Z` → `Never Ever (TV)` (seeded from X, the later-ending)

Requires concurrent same-tutor sessions, which should not occur in clean Wise data, and the reconciled choice is arguably the better one. Worth a decision rather than a silent divergence: either filter the dynamic entry by `endMinute <= startMinute` too and take the max end in both paths, or key `lastByTutor` on max-end so the full run matches.

### LO-B: An unlocked carried row whose stored `status`/`warnings` disagree with a fresh recomputation is labeled `moved` with its publish state reset, even when the room is identical

`reconciliation.ts:403`–`:406`. `sameAssignment` compares `assignedRoom` **and** `status` **and** `JSON.stringify(warnings)`. Verified: a stored row claiming `status: "assigned", warnings: []` for a session that recomputes to `needs_review` is re-assigned to the same `Room A` yet emits `changeType: "moved"`, `publishStatus: "not_published"`, and the event `"Moved Wise session nr from Room A to Room A"` — which will drive an unnecessary `location` write back to Wise.

For a non-override row, `warnings` and `status` are pure functions of the fingerprinted fields, so this cannot fire on consistent data. It becomes reachable when stored rows were written by different logic — precisely the situation on the first reconcile after this branch deploys — and `8654002` opens the path for `needs_review` rows for the first time, since they were previously never unlockable. Guard by comparing the room first: `if (previous.assignedRoom === row.assignedRoom) { /* preserve publish, no moved event */ }` and treat status/warning drift as a `changed` row rather than a `moved` one.

### LO-C: The unlock is never rolled back when the retry fails to place the session it was performed for

`reconciliation.ts:369`–`:390`. `finalCarriedRows` is reduced and `assignedDynamicRows` is replaced unconditionally; nothing compares the retry's `no_room` count against the original. If the retry still cannot place the failing session (verified: a 3-sessions-into-2-rooms day still ends with one `no_room` after the unlock), any carried row that moved has been churned — publish state reset, `moved` event, re-publish to Wise — for no benefit. Pre-existing, but the `holdsRoom` widening adds `needs_review` rows to the pool of rows that can be churned this way. Cheap guard: keep the retry result only if `failedRows.length` strictly decreased.

---

## Verified clean (no action)

- `holdsRoom` ≡ the engine's `lastByTutor` guard; the status clause is redundant-but-harmless given the sentinel checks.
- `blocksRoom` fully removed; no stale call sites.
- Publish eligibility, schedule email, and both `assignedCount` summaries are unaffected by the widening.
- Unlock: overlap-scoped, override-protected, and correctly re-labels a same-room landing as `carried` with publish state preserved.
- `contextSessions` has exactly one consumer; creates no rows, no occupancy, no continuity, no claims; produces no requirement entries of its own; id collisions are skipped.
- `tutorKey` (`groupId` → normalized display name) resolves identically for context and pending sessions.
- Carried `remote` / `no_room` rows are passed as context — correct, since a full run would see them; chain bridging through them matches a full run.
- Canceled sessions are excluded from context.
- Unlock-retry passes a consistently reduced `fixedRows` to all three of `externalRoomBlocks`, `fixedTutorAssignments`, and `contextSessions`; the union of context + pending is always the full day.
- `ContextSession` widening of `tutorKey` / `sortedTutorSessions` / `onlineSessionRequiresCenterRoom` is structurally sound; `AssignmentSession` satisfies it; `tsc --noEmit` clean.
- No regression to sticky, the capacity-demotion guard (CR-01 confirmed closed), the Joy exclusion, or the Ras configuration.
- Doc line references (`:118`, `:142`, `:293`, `:345`, `:369`, `:396`, `assignment-engine.ts:101`, `:295`) and the 44 / 14 test-declaration counts check out.

---

_Reviewed: 2026-08-11_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: quick, differential probes on the reconciler and engine_
