---
phase: 260811-div-classroom-assignment-continuity-ras-prio
reviewed: 2026-08-11T03:35:00Z
depth: quick (rigorous on engine)
diff_range: origin/main..HEAD (4 commits, feat/classroom-continuity)
files_reviewed: 9
files_reviewed_list:
  - src/lib/classrooms/rooms.ts
  - src/lib/classrooms/assignment-engine.ts
  - src/lib/classrooms/reconciliation.ts
  - src/lib/classrooms/visualization.ts
  - src/components/class-assignments/class-assignments-workspace.tsx
  - src/lib/classrooms/__tests__/assignment-engine.test.ts
  - src/lib/classrooms/__tests__/reconciliation.test.ts
  - src/lib/classrooms/__tests__/visualization.test.ts
  - docs/features/classroom-assignments.md
findings:
  critical: 1
  high: 1
  medium: 3
  low: 6
  total: 11
status: issues_found
---

# Classroom continuity + Ras priority — Code Review

**Reviewed:** 2026-08-11
**Depth:** quick, with rigorous differential analysis of `assignment-engine.ts`
**Verification performed:** full unit suite (`360 files / 4162 tests` pass), `tsc --noEmit` clean, plus 15 throwaway probe scenarios run against **both** `HEAD` and the `origin/main` build of `assignment-engine.ts` to separate regressions from pre-existing behavior. All probe files were deleted; working tree is clean.

## Summary

The mechanics of the change are correct. Specifically, every item on the requested checklist that concerns *plumbing* passes:

- `latestPriorRoomForTutor` filters fixed entries with `endMinute <= startMinute`, leaves the dynamic entry unfiltered, and resolves ties to the dynamic entry (`assignment-engine.ts:336`–`:351`). The fixed list is pre-sorted ascending by `endMinute`, so the "last match wins" loop genuinely yields the maximum qualifying entry.
- With no `fixedTutorAssignments`, the helper collapses to `lastByTutor.get(tutorNorm)` (returning `null` instead of `undefined`; both falsy, both consumed via `if (last)`). The two pre-existing continuity reads at `:494` and `:510` are behaviorally identical to `main`.
- The sticky step sits after the preferred-claim block and before online-only rooms, and checks `roomOk` + `roomAvailable` (occupancy **and** `protectedClaims`) + `gap >= 0` + Joy-exclusion (`:535`–`:544`).
- **It cannot pre-empt a protected claim** — verified: a generic tutor's sticky claim on `Iconic (TV)` is refused in favour of Mek's later priority claim.
- **It cannot trap a preferred tutor** — verified: Mandy, displaced from `Never Ever (TV)` at 09:00 by Ras, returns to `Never Ever (TV)` at 14:00 via the preferred block, which runs first.
- **Single-session-per-tutor scenarios are byte-identical** to `main`.
- The reconciler's `fixedTutorAssignmentsFrom` mirrors `blocksRoom` exactly, and both `assignPending` call sites (initial and unlock-retry) derive `externalRoomBlocks` and `fixedTutorAssignments` from the same `fixedRows` argument, so they cannot drift.
- The Ras config is clean: display names match `tutor-contacts.ts:28`–`:29` verbatim, `TV_REQUIRED_TUTORS` already carried Ras on `main`, and an exhaustive alias-collision scan over both maps (92 preferred keys, 12 priority keys) shows the new `Ras` / `Rasna` keys collide with nothing and no existing key changed room.
- The churn metric is sound: remote and `NO_ROOM_AVAILABLE` rows are filtered, sort is fully deterministic (`start`, `end`, `id`), `Joy` ≡ `Joy (TV)` via `normalizedPhysicalRoom`, the grouping key matches the `tutors` list that renders the badge, empty input yields `{ totalSwitches: 0 }`, `useMemo(..., [rows])` is correct because `rows` is itself memoized (`:271`), `Badge` was already imported, and the tile count matches the new `lg:grid-cols-8`.
- No production code parses `ruleTrace`; no shared state is mutated; nothing new touches dates or timezones.

**What the change gets wrong is the policy, not the plumbing.** The sticky step reuses the tutor's last room after only a *hard-constraint* check (`roomPassesConstraints`: active / capacity / TV / category). It never re-applies `roomPriorityScore`, which is the function that encodes room *suitability*. Because the sticky step also has no gap bound, one bad morning placement now propagates to the end of the day. The concrete consequence is reproducible and is a hard regression: a 1:1 class squats the only 8-seat room for the whole day and a later 6-student group is emitted as `NO_ROOM_AVAILABLE` where `main` assigned it a room.

---

## CRITICAL

### CR-01: Sticky room bypasses the `Relax (TV)` capacity demotion and can starve a later large group into `NO_ROOM_AVAILABLE`

**File:** `src/lib/classrooms/assignment-engine.ts:535`–`:544`

**Issue.** `roomPriorityScore` deliberately demotes `Relax (TV)` (capacity 8 — the only room in the catalog above capacity 3) to score `2_000` for groups of `minCapacity <= 3`, so the pool reserves it for groups that actually need it (`:188`–`:193`). The sticky step does not call `pickBestRoom` and therefore never sees that score; it only calls `roomOk`, which passes any room whose `capacity >= minCapacity`. A tutor who teaches one large group in `Relax (TV)` in the morning now sticks there for every subsequent 1:1 that day, no matter how large the gap.

Verified against `DEFAULT_CLASSROOM_ROOMS`, same three sessions, `origin/main` engine vs `HEAD` engine:

| session | students | time | `origin/main` | `HEAD` |
|---|---|---|---|---|
| `big-am` (Alpha Squatter) | 8 | 09:00–10:00 | `Relax (TV)` | `Relax (TV)` |
| `solo-pm` (Alpha Squatter) | 1 | 13:00–14:00 | `Think Outside the Box` | **`Relax (TV)`** ← `assigned by sticky room` |
| `group-pm` (Zed Tutor) | 6 | 13:00–14:00 | `Relax (TV)` | **`NO_ROOM_AVAILABLE`** |

A control run with the morning session removed places `group-pm` in `Relax (TV)` correctly, so the sticky step is the sole cause. The pre-existing `assigned by continuity` rule had the same hole but was bounded to a 15-minute gap; removing the bound is what makes an all-day squat reachable.

The same class of failure applies to any room the tutor holds that is much larger or more specialised than the next session needs (TV rooms held for non-TV classes, and — if a catalog ever re-activates one — `overflow_only` rooms; `Dream. Plan. Do.` is seeded `overflow_only` in `drizzle/0003_wandering_gravity.sql:89` and is only repaired back to `standard` by `data.ts:455`–`:477`).

**Fix.** Re-apply the suitability tier inside the sticky guard so it can only keep a room the pool would also have been willing to hand out. Minimal version:

```ts
if (!assignedRoom) {
  const last = latestPriorRoomForTutor(tutorNorm, session.startMinute);
  const lastRoom = last ? roomByName.get(last.room) : undefined;
  if (
    last &&
    lastRoom &&
    session.startMinute - last.endMinute >= 0 &&
    roomOk(last.room) &&
    roomAvailable(last.room) &&
    !(last.room === ROOM_JOY && !isGift) &&
    // do not squat a room the pool would have demoted for this group size
    roomPriorityScore(lastRoom, minCapacity) < 2_000 &&
    lastRoom.category === "standard"
  ) {
    assignedRoom = last.room;
    ruleTrace.push(`assigned by sticky room: ${last.room}`);
  }
}
```

Consider applying the same `roomPriorityScore(...) < 2_000` guard to the existing `assigned by continuity` branch at `:509`–`:520`, which has the identical (narrower) hole. Add a regression test asserting the three-session table above.

---

## HIGH

### HI-01: Reconciler double-books the room held by a carried `needs_review` row (pre-existing, surfaced by the new mirror)

**File:** `src/lib/classrooms/reconciliation.ts:109`–`:115` (`blocksRoom`), consumed at `:117`–`:126` and `:237`–`:246`

**Issue.** `blocksRoom` requires `row.status === "assigned"`. A carried row with status `needs_review` still holds a real physical room (`needs_review` only means `needs_review_missing_capacity` — see `assignment-engine.ts:601`–`:608`), but `rowToExternalBlock` returns `null` for it, so its room is not passed to the dynamic pass as an `ExternalRoomBlock`. The engine then places a new session into the same room at an overlapping time.

Verified:

```
R> existing  Tutor One  540-600 -> Room A  needs_review  carried
R> new       Tutor Two  570-630 -> Room A  assigned      added      <-- overlapping double booking
```

This is **not introduced by this diff** — `blocksRoom` is unchanged. It is reported here because the review brief asked to confirm that `fixedTutorAssignmentsFrom` mirrors `blocksRoom`: it does, faithfully, and that is precisely what makes the shared predicate worth fixing in one place.

**Fix.** Split the two concerns. Room *blocking* should key on "this row physically holds a room", which is broader than "assigned":

```ts
function holdsRoom(row: Pick<ReconciledAssignmentRow, "status" | "assignedRoom">): boolean {
  return (
    row.status !== "remote" &&
    row.assignedRoom !== NO_ROOM_AVAILABLE &&
    row.assignedRoom !== REMOTE_NO_ROOM_NEEDED
  );
}
```

Use `holdsRoom` for both `rowToExternalBlock` and `fixedTutorAssignmentsFrom` (see MD-02), and keep `blocksRoom` only where "assigned" is genuinely the intent. Add a reconciliation test for the overlap above.

---

## MEDIUM

### MD-01: Sticky pulls center-required ONLINE sessions out of the online-only booths into physical teaching rooms

**File:** `src/lib/classrooms/assignment-engine.ts:535`–`:552`

**Issue.** Placing the sticky step before the `online_only` step means an online session that requires a center room and is more than 60 minutes from the tutor's previous session now re-uses the tutor's physical teaching room instead of an online booth. Verified (offline 09:00–10:00, online 12:00–13:00, offline 13:15–14:15):

- `origin/main`: `Think Outside the Box` / **`I learned (online)`** / `Think Outside the Box`
- `HEAD`: `Think Outside the Box` / **`Think Outside the Box`** (sticky) / `Think Outside the Box`

The ordering matches the approved plan, so this is intended — but the plan does not appear to have costed it. The net effect is that a teaching room is consumed for the online hour and one of the two capacity-1 booths (`I learned (online)`, `Hope (online)`) is left idle, reducing onsite room supply center-wide. Given CR-01 shows the center can run out of rooms, this is worth an explicit decision rather than a side effect.

**Fix.** Either confirm the trade-off and document it in `docs/features/classroom-assignments.md`, or move the sticky step below the `online_only` step for `isOnlineSession(session.sessionType)` (keeping it above the standard pool), so online classes prefer a booth and only fall back to the sticky teaching room.

### MD-02: A carried `needs_review` row seeds no continuity, so a reconciled run diverges from a full run

**File:** `src/lib/classrooms/reconciliation.ts:237`–`:246` vs `src/lib/classrooms/assignment-engine.ts:597`–`:599`

**Issue.** In a full run, a `needs_review` session **does** update `lastByTutor` (the guard at `:597` only excludes `NO_ROOM_AVAILABLE` and `REMOTE_NO_ROOM_NEEDED`), so it seeds continuity for the tutor's later sessions. In a reconciled run, `fixedTutorAssignmentsFrom` filters on `blocksRoom`, which excludes `needs_review` — so the same tutor's later session gets no seed and falls to the pool. Identical inputs therefore produce different rooms depending on whether the day was generated fresh or reconciled, and the new "Room switches" tile will show phantom churn after a reconcile. `needs_review_missing_capacity` fires whenever `studentCount` is absent and 1:1 cannot be inferred (`assignment-engine.ts:130`–`:141`), which is not rare.

**Fix.** Use the `holdsRoom` predicate from HI-01 for `fixedTutorAssignmentsFrom`, and add a reconciliation test that a carried `needs_review` row seeds the sticky room.

### MD-03: The sticky step has no gap bound and no re-evaluation, so one crowded morning degrades a tutor's room for the whole day

**File:** `src/lib/classrooms/assignment-engine.ts:535`–`:544`

**Issue.** This is the general form of CR-01. Verified: with 13 concurrent 09:00 sessions, "Late Tutor" is pushed into `Focus` (capacity 2, the last-ranked core room). Their 15:00 session — by which time every core room including `Think Outside the Box` is free — is still assigned `Focus` via `assigned by sticky room`. On `main` it would have been re-scored into the best free room. Note the capacity-2 ceiling also means the tutor silently drops out of stickiness the moment they have a 3-student class, producing a switch anyway.

**Fix.** Bound the benefit: either cap the gap (e.g. `gap <= SAME_DAY_STICKY_GAP_MINUTES`, 120–180 min), or only stick when the room's priority score is within one tier of what `pickBestRoom` would return now — i.e. do not stick if a materially better-ranked room is free. Whichever is chosen, pin it with a test so the intent is legible.

---

## LOW

### LO-01: An overlapping dynamic entry masks a still-valid fixed seed

`assignment-engine.ts:336`–`:351`. The dynamic entry is compared on `endMinute` alone and is deliberately unfiltered, so if a same-tutor session overlaps the one being placed (`dynamic.endMinute > session.startMinute`) it wins the comparison and the `gap >= 0` check then rejects it — discarding a valid earlier fixed seed that would have qualified. Verified with a `Nerd` seed ending at 10:00 and overlapping 10:30/11:00 sessions. Harmless when both point at the same room; only reachable with overlapping same-tutor sessions. Consider returning the better of the two *qualifying* entries: filter the dynamic entry with `dynamic.endMinute <= startMinute` too, then take the max.

### LO-02: Joy exclusion uses a raw string compare, not `normalizedPhysicalRoom`

`assignment-engine.ts:514` and `:539`. `last.room === ROOM_JOY` misses a room labelled plainly `Joy`, which would let a non-Gift tutor stick in Joy. The catalog repair deactivates the non-TV duplicates (`data.ts:479`–`:485`), so it is not reachable today — but `normalizedPhysicalRoom` is now exported and would make the guard robust: `normalizedPhysicalRoom(last.room) === normalizedPhysicalRoom(ROOM_JOY)`.

### LO-03: `latestPriorRoomForTutor` returns the caller's object in one branch and a fresh object in the other

`assignment-engine.ts:346`–`:350`. The `!dynamic` branch returns the `FixedTutorAssignment` supplied by the caller (carrying extra `tutorDisplayName` / `startMinute` fields), while the comparison branch allocates `{ endMinute, room }`. No caller mutates the result, so this is inert — but the asymmetry is a latent aliasing hazard. Return a fresh `{ endMinute, room }` in both branches.

### LO-04: The churn metric groups by raw `tutorDisplayName`

`visualization.ts:334`–`:344`. The engine keys continuity by `normalizeTutorName(...)`; the metric uses the raw string. Display names all come from `tutorIdentityGroups.displayName` so they agree today, but a stray double space would split one tutor into two buckets and under-report switches. Applying `normalizeTutorName` would remove the divergence — note the badge lookup at `class-assignments-workspace.tsx:971` would need the same treatment.

### LO-05: Ras's new preferred entry silently changes `sessionPriority` for every same-start session

`rooms.ts:131`–`:132`. Ras was priority `2` (TV-required); with a `PREFERRED_BY_TUTOR` entry she is now priority `1` (`assignment-engine.ts:208`–`:213`), which reorders the `sortedSessions` tie-break at any minute where she shares a start time. That reordering can shift room assignments for unrelated tutors at that minute. Intended, but undocumented — worth a line in the feature doc alongside the Mandy/Calvin note.

### LO-06: Test-coverage gaps around the new surfaces

`buildRoomChurnSummary` has no test for empty input or for the `NO_ROOM_AVAILABLE` exclusion (both behave correctly — verified by reading, not by test). The renamed engine test also reverses a previously pinned product decision: `"requires a TV-capable room for Rasna without pinning her to one exact room"` asserted `preferredRoom` `toBeNull()`; it is now `"falls back to another TV room when Never Ever (TV) is not in the catalog"` asserting `"Never Ever (TV)"`. That flip is exactly what the plan asked for, but it retires an explicit "do not pin Ras" rule — worth confirming with the requester that the old rule was superseded rather than forgotten.

---

## Verified clean (no action)

- Ras display names, room targets, and alias expansion — no collisions in `PREFERRED_BY_TUTOR` (92 keys) or `PRIORITY_PREFERRED_ROOM_BY_TUTOR` (12 keys); `Ras` / `Rasna` are new keys, and no existing alias changed room.
- Ras's priority claim correctly skips remote online sessions (`requiresCenterRoom === false`), so a fully-remote Ras day does not deny Mandy her preferred room.
- Sticky cannot pre-empt any protected override / priority / preferred claim (`roomAvailable` checks `protectedClaims`).
- Sticky cannot trap a preferred tutor — the preferred block runs first and displaced tutors return.
- Both `assignPending` call sites in the reconciler pass `externalRoomBlocks` and `fixedTutorAssignments` from the same `fixedRows`; the unlock-retry correctly reduces both.
- Remote carried rows seed nothing (double-excluded by status and by room sentinel).
- Fixed seeds naming an unknown room or a room too small for the new session fall through safely.
- No production code parses `ruleTrace`; the new trace string is display/audit only.
- `options.fixedTutorAssignments` is not mutated; the internal per-tutor arrays are fresh.
- No new date/timezone logic; all comparisons are minute integers.
- `normalizedPhysicalRoom` export introduces no import cycle (`visualization.ts` already imported from `assignment-engine.ts`).
- Doc line references (`:706`, `:725`, `:745`, `:268`, `:320`, `:337`–`:359`, `:361`–`:399`) and the 41 / 9 test-declaration counts all check out.

---

_Reviewed: 2026-08-11_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: quick, differential on the engine_
