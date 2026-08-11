---
quick_id: 260811-evt
plan: 1
type: execute
wave: 1
depends_on: []
files_modified:
  - src/lib/classrooms/reconciliation.ts
  - src/lib/classrooms/assignment-engine.ts
  - src/lib/classrooms/__tests__/reconciliation.test.ts
  - src/lib/classrooms/__tests__/assignment-engine.test.ts
  - docs/features/classroom-assignments.md
autonomous: true
requirements:
  - HI-01
  - MD-02
  - RECONCILER-CENTER-CHAIN
branch: feat/classroom-continuity
worktree: /Users/kevinhsieh/Developer/bgscheduler-classroom

must_haves:
  truths:
    - "A carried needs_review row's held room is never double-booked by a new session in a reconciled run"
    - "A carried needs_review row seeds same-day sticky-room continuity for a tutor's later pending session, exactly like a carried assigned row does"
    - "A carried needs_review row is eligible to be displaced by the unlock-retry loop when it is the only thing blocking a pending session"
    - "A pending online session's need for a center room is judged against the tutor's full same-day schedule (pending AND carried), not pending sessions alone"
    - "Context sessions passed into the center-room chain calculation never receive a room, never occupy a room, and never seed continuity for anyone"
    - "Every pre-existing pinned test in reconciliation.test.ts and assignment-engine.test.ts still passes unmodified"
  artifacts:
    - path: "src/lib/classrooms/reconciliation.ts"
      provides: "holdsRoom (renamed+widened from blocksRoom), rowToContextSession, contextSessions wired into assignPending's engine options"
      contains: "function holdsRoom"
    - path: "src/lib/classrooms/assignment-engine.ts"
      provides: "ContextSession interface, AssignmentOptions.contextSessions, buildCenterRoomRequirementMap folding contextSessions into the tutor-grouped chain walk"
      exports: ["ContextSession"]
    - path: "src/lib/classrooms/__tests__/reconciliation.test.ts"
      provides: "5 new pinned tests covering needs_review room-holding and the cross-carried center-room chain"
    - path: "src/lib/classrooms/__tests__/assignment-engine.test.ts"
      provides: "2 new pinned tests covering contextSessions in isolation at the engine level"
    - path: "docs/features/classroom-assignments.md"
      provides: "updated reconciliation prose (holdsRoom + contextSessions) and corrected test-count figures"
  key_links:
    - from: "src/lib/classrooms/reconciliation.ts"
      to: "src/lib/classrooms/assignment-engine.ts"
      via: "rowToExternalBlock / fixedTutorAssignmentsFrom now gated by holdsRoom (assigned OR needs_review) instead of blocksRoom (assigned only)"
      pattern: "holdsRoom\\(row\\)"
    - from: "src/lib/classrooms/reconciliation.ts"
      to: "src/lib/classrooms/assignment-engine.ts"
      via: "assignPending passes contextSessions: fixedRows.map(rowToContextSession) into assignClassrooms's options"
      pattern: "contextSessions: fixedRows\\.map\\(rowToContextSession\\)"
    - from: "src/lib/classrooms/assignment-engine.ts"
      to: "src/lib/classrooms/assignment-engine.ts"
      via: "buildCenterRoomRequirementMap folds options.contextSessions into the tutor-grouped adjacency walk, gated so only pending ids get a requirement entry"
      pattern: "buildCenterRoomRequirementMap\\(sessions, options\\.contextSessions"
---

<objective>
Fix two pre-existing reconciler bugs surfaced by `260811-div-REVIEW.md` (HI-01, MD-02) plus the reconciler's
own already-flagged center-room-chain blind spot (called out as "deliberately out of scope... separate
ticket" in `260811-div-PLAN.md`'s `risks_and_non_breakage`). Both bugs share one root cause: the reconciler
feeds `assignClassrooms` an incomplete picture of the day when it re-assigns only the *pending* (changed)
sessions. Design principle for both fixes: **a reconciled run should converge to what a full run over the
same final session set would produce**, minus the deliberate carry-forward of rows that did not change.

1. **HI-01 + MD-02 (Task 1):** `blocksRoom` requires `status === "assigned"`, so a carried row with status
   `needs_review` (which still has a real `assignedRoom` — e.g. `needs_review_missing_capacity`) is invisible
   when pending sessions are placed. This double-books its room (HI-01) and fails to seed same-day continuity
   from it (MD-02), even though a full engine run treats a `needs_review` row identically to an `assigned` one
   for both occupancy and `lastByTutor`. Fix: rename `blocksRoom` to `holdsRoom`, widen it to `status ===
   "assigned" || status === "needs_review"`, and use it everywhere `blocksRoom` was used — including the
   unlock-retry loop, where a carried `needs_review` row becomes just as displaceable as an assigned one.

2. **Center-room chain (Task 2):** `assignPending` passes only *pending* sessions into `assignClassrooms`, so
   `buildCenterRoomRequirementMap` computes each tutor's <60-minute online↔onsite adjacency chain from pending
   sessions alone. A pending online session whose only nearby session is a *carried* onsite row (or vice
   versa) is judged in isolation and gets the wrong `REMOTE_NO_ROOM_NEEDED` / center-room verdict. Fix: a new
   `AssignmentOptions.contextSessions` field, consumed only by `buildCenterRoomRequirementMap` — the chain is
   computed over pending ∪ context, but only pending session ids ever receive a requirement-map entry, and
   context sessions are never assigned a room, never occupy one, and never seed continuity (that is already
   handled by the existing `externalRoomBlocks` / `fixedTutorAssignments` options). The reconciler passes
   every currently-carried row (any status) as context on both `assignPending` calls.

Purpose: stop a reconciled (incremental) run from silently diverging from what a full run over the same day
would have produced, for two production-affecting scenarios: a partially-unresolvable session's carried room
being handed to someone else, and an online session flip-flopping between remote and center-required purely
because of *how* the day's assignments happened to be generated (fresh vs. incremental).

Output: `reconciliation.ts` predicate rename/widen + new context-session projection, `assignment-engine.ts`
new `ContextSession` type + `AssignmentOptions` field + chain-map rewrite, 7 new pinned tests across the two
test files (5 reconciliation-level, 2 engine-level), and `docs/features/classroom-assignments.md` updated to
describe both behaviors.

**Pinned-test conflict check (done at planning time, see `<planner_concerns>` for the full trace):** none of
the 9 existing `reconciliation.test.ts` cases or 42 existing `assignment-engine.test.ts` cases are weakened,
changed, or made to assert different values by either fix. In particular the two tests the task brief called
out by name — "unlocks the smallest overlapping carried set when a new class cannot fit" (minimal-displacement,
~line 140) and "does not move hard-pinned override rows during minimal displacement" (override-pinned, ~line
162) — both use a carried row with the *default* `status: "assigned"`, which `holdsRoom` treats identically to
the old `blocksRoom`. No plan-time conflict was found; nothing here required stopping to flag a test change.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/quick/260811-div-classroom-assignment-continuity-ras-prio/260811-div-REVIEW.md

Project conventions (already loaded as CLAUDE.md/AGENTS.md project instructions), binding for every task
below: `ruleTrace` strings are asserted **verbatim** in tests — copy them exactly, don't paraphrase; zero
`TODO`/`FIXME`/`HACK` comments in non-test source; named exports only (no default exports) in `src/lib`;
2-space indent, double quotes, semicolons; JSDoc on exported functions and on private helpers whose behavior
is easy to get subtly wrong (this plan's two predicates qualify); conventional commits scoped
`fix(classrooms): ...` (this repo's own history: `2471148 fix(classrooms): keep sticky room from squatting
capacity-demoted rooms` is the most recent precedent for this exact scope and type).

All file paths below are relative to the worktree root `/Users/kevinhsieh/Developer/bgscheduler-classroom`
(this is the correct, linked worktree for branch `feat/classroom-continuity` — do not operate from any other
worktree). The tree is clean and 6 commits ahead of `origin/main` as of plan time; this plan adds 2 more
commits on top, in order.
</context>

<interfaces>
<!-- Current exports relevant to this plan, as of HEAD on feat/classroom-continuity at plan time. Each
     task's action section also gives exact before/after code, so line-number drift from earlier edits in
     the same task doesn't matter -- this block is orientation, not the source of truth for edits. -->

From `src/lib/classrooms/assignment-engine.ts` (this plan adds `ContextSession`, marked NEW):
```typescript
export const REMOTE_NO_ROOM_NEEDED = "REMOTE_NO_ROOM_NEEDED";
export const ONLINE_CENTER_CONNECTION_GAP_MINUTES = 60;
export interface AssignmentSession {
  groupId: string; tutorDisplayName: string; wiseSessionId: string;
  startMinute: number; endMinute: number; sessionType?: string | null; /* ...+more, unchanged */
}
export interface ExternalRoomBlock { wiseSessionId: string; className: string | null; location: string;
  startMinute: number; endMinute: number; }
export interface FixedTutorAssignment { tutorDisplayName: string; startMinute: number; endMinute: number;
  room: string; }
export interface ContextSession {                                    // NEW (Task 2)
  wiseSessionId: string; tutorDisplayName: string; groupId: string;
  startMinute: number; endMinute: number; sessionType?: string | null;
}
export interface AssignmentOptions {
  externalRoomBlocks?: ExternalRoomBlock[];
  fixedTutorAssignments?: FixedTutorAssignment[];
  contextSessions?: ContextSession[];                                 // NEW (Task 2)
}
export function assignClassrooms(
  sessions: AssignmentSession[], rooms: ClassroomRoomDefinition[],
  overrideBySessionId?: Map<string, string | null | undefined>, options?: AssignmentOptions,
): AssignmentResult;
```

Why `ContextSession` carries `groupId` even though it isn't strictly needed to *place* a session: the
internal `tutorKey(session)` helper that buckets sessions for the chain walk prefers `session.groupId` over
the normalized display name (`return session.groupId || normalizeTutorName(session.tutorDisplayName)`), and
carried rows always carry a real, stable `groupId` (sourced from `tutor_identity_groups.id` at load time —
`data.ts:744`). Omitting it would silently split a real tutor's carried and pending sessions into two
different buckets whenever the pending side has a truthy `groupId` (the normal case in production), which
would defeat the fix. Task 2's own reconciliation-level tests are written so they would fail if this field
were dropped — see `<planner_concerns>` item 1.

From `src/lib/classrooms/reconciliation.ts` (unchanged shapes this plan reuses):
```typescript
export interface ReconciledAssignmentRow extends AssignmentResultRow {
  sourceRowId: string | null;
  changeType: "manual" | "carried" | "added" | "changed" | "rescheduled" | "moved";
  assignmentFingerprint: string; publishStatus: "not_published" | "skipped" | "success" | "failed"; }
export interface PreviousAssignmentRow extends AssignmentSession { id: string; assignedRoom: string;
  status: "assigned" | "needs_review" | "no_room" | "remote"; /* +more, unchanged */ }
export function reconcileClassroomAssignments(input: {
  sessions: AssignmentSession[]; previousRows: PreviousAssignmentRow[];
  rooms: ClassroomRoomDefinition[]; externalRoomBlocks?: ExternalRoomBlock[];
}): ReconciliationResult;
// Internal (not exported), current definition -- Task 1 renames + widens this:
// function blocksRoom(row): boolean
//   -- status === "assigned" && assignedRoom not NO_ROOM_AVAILABLE/REMOTE_NO_ROOM_NEEDED
// Call sites (all 3, confirmed via grep -- blocksRoom has no callers outside this file):
//   rowToExternalBlock (:118), fixedTutorAssignmentsFrom (:239), unlock-retry filter (:342)
```

`assignClassrooms` has exactly 3 call sites in the repo: `src/lib/room-capacity/data.ts:203` (no options
object -- a full, non-reconciled run, unaffected by this plan), `src/lib/classrooms/data.ts:898` (full run,
`{ externalRoomBlocks }` only, unaffected), and `reconciliation.ts`'s internal `assignPending` (the only
caller this plan touches). Both external callers are safe by construction: `contextSessions` is a new
*optional* field, and a full run has no separate "carried" bucket to project into it in the first place.
</interfaces>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: holdsRoom -- carried needs_review rows hold their rooms (fixes HI-01, MD-02)</name>
  <files>src/lib/classrooms/reconciliation.ts, src/lib/classrooms/__tests__/reconciliation.test.ts, docs/features/classroom-assignments.md</files>
  <behavior>
    - A carried row with `status: "needs_review"` and a real `assignedRoom` is emitted as an
      `ExternalRoomBlock`, so a new overlapping session lands elsewhere instead of double-booking it.
    - The same carried `needs_review` row is included in `fixedTutorAssignmentsFrom`'s output, so a later
      pending session for the same tutor can seed same-day sticky-room continuity from it.
    - The unlock-retry loop treats a carried `needs_review` row as displaceable (same eligibility as an
      `assigned` row) when it is the only thing overlapping a pending session that would otherwise fail.
    - A carried row with `status: "assigned"` (today's only path) keeps behaving exactly as before --
      `holdsRoom` is a strict superset of the old `blocksRoom`, never a narrower set.
  </behavior>
  <action>
**1. `src/lib/classrooms/reconciliation.ts` -- four edits, in this order (verified against current file
content; run each Edit sequentially since edits 2-4 each individually replace only the one line/word that
changed, and are independent of each other's exact surrounding line numbers):**

Edit A -- rename and widen the predicate, with a comment explaining why (this is the one delicate part of
this task: the widening must be a strict superset of the old check, never narrower):

Find:
```typescript
function blocksRoom(row: Pick<ReconciledAssignmentRow, "status" | "assignedRoom">): boolean {
  return (
    row.status === "assigned" &&
    row.assignedRoom !== NO_ROOM_AVAILABLE &&
    row.assignedRoom !== REMOTE_NO_ROOM_NEEDED
  );
}
```
Replace with:
```typescript
/**
 * Whether a row currently occupies a real physical room. Broader than "assigned by design": a
 * needs_review row (e.g. needs_review_missing_capacity) still carries a real assignedRoom, and a
 * full engine run adds any such row to occupancy and lastByTutor exactly like an assigned one --
 * assignment-engine.ts only excludes the NO_ROOM_AVAILABLE / REMOTE_NO_ROOM_NEEDED sentinels, not
 * the needs_review status. The reconciled path must match, or it silently double-books the room a
 * carried needs_review row holds (HI-01) and fails to seed continuity from it (MD-02).
 */
function holdsRoom(row: Pick<ReconciledAssignmentRow, "status" | "assignedRoom">): boolean {
  return (
    (row.status === "assigned" || row.status === "needs_review") &&
    row.assignedRoom !== NO_ROOM_AVAILABLE &&
    row.assignedRoom !== REMOTE_NO_ROOM_NEEDED
  );
}
```

Edit B -- `rowToExternalBlock` (fixes HI-01):

Find:
```typescript
function rowToExternalBlock(row: ReconciledAssignmentRow): ExternalRoomBlock | null {
  if (!blocksRoom(row)) return null;
```
Replace with:
```typescript
function rowToExternalBlock(row: ReconciledAssignmentRow): ExternalRoomBlock | null {
  if (!holdsRoom(row)) return null;
```

Edit C -- `fixedTutorAssignmentsFrom` (fixes MD-02):

Find:
```typescript
function fixedTutorAssignmentsFrom(rows: ReconciledAssignmentRow[]): FixedTutorAssignment[] {
  return rows
    .filter((row) => blocksRoom(row))
```
Replace with:
```typescript
function fixedTutorAssignmentsFrom(rows: ReconciledAssignmentRow[]): FixedTutorAssignment[] {
  return rows
    .filter((row) => holdsRoom(row))
```

Edit D -- the unlock-retry loop. Widening this means a carried `needs_review` row is now also unlockable
when it blocks a `no_room` pending session -- confirmed correct per this task's brief ("they genuinely hold
rooms"), and pinned by this task's new "unlocks a carried needs_review row..." test below:

Find:
```typescript
  if (failedDynamicRows.length > 0) {
    const unlockSessionIds = new Set(
      finalCarriedRows
        .filter((row) =>
          !row.overrideRoom &&
          blocksRoom(row) &&
          failedDynamicRows.some((failed) => rowsOverlap(row, failed))
        )
        .map((row) => row.wiseSessionId),
    );
```
Replace with:
```typescript
  if (failedDynamicRows.length > 0) {
    // A carried needs_review row genuinely holds a room (see holdsRoom above), so it is just as
    // displaceable as an assigned row when it is the only thing blocking a pending session that
    // otherwise has nowhere to go.
    const unlockSessionIds = new Set(
      finalCarriedRows
        .filter((row) =>
          !row.overrideRoom &&
          holdsRoom(row) &&
          failedDynamicRows.some((failed) => rowsOverlap(row, failed))
        )
        .map((row) => row.wiseSessionId),
    );
```

After these 4 edits, `grep -n "blocksRoom" src/lib/classrooms/reconciliation.ts` must return zero matches --
every call site (and the definition) is now `holdsRoom`. This is the complete audit of `blocksRoom`'s call
sites; there are no others in the file or the repo.

**2. `src/lib/classrooms/__tests__/reconciliation.test.ts` -- append 3 new tests inside the existing
`describe("reconcileClassroomAssignments", ...)` block, right after the last existing test (anchor on it so
this doesn't depend on line numbers):**

Find:
```typescript
  it("does not seed continuity from a remote carried row", () => {
    const remoteOverrides = {
      wiseSessionId: "existing",
      tutorDisplayName: "Tutor One",
      groupId: "group-1",
      sessionType: "SCHEDULED",
      startMinute: 9 * 60,
      endMinute: 10 * 60,
    };
    const carried = previous({
      ...remoteOverrides,
      assignedRoom: REMOTE_NO_ROOM_NEEDED,
      status: "remote",
    });
    const newSession = session({
      wiseSessionId: "new",
      tutorDisplayName: "Tutor One",
      groupId: "group-1",
      startMinute: 11 * 60,
      endMinute: 12 * 60,
    });

    const result = reconcileClassroomAssignments({
      sessions: [session(remoteOverrides), newSession],
      previousRows: [carried],
      rooms,
    });

    const newRow = result.rows.find((row) => row.wiseSessionId === "new")!;
    expect(newRow.assignedRoom).toBe("Room A");
    expect(newRow.ruleTrace.some((trace) => trace.startsWith("assigned by sticky room:"))).toBe(false);
  });
});
```
Replace with:
```typescript
  it("does not seed continuity from a remote carried row", () => {
    const remoteOverrides = {
      wiseSessionId: "existing",
      tutorDisplayName: "Tutor One",
      groupId: "group-1",
      sessionType: "SCHEDULED",
      startMinute: 9 * 60,
      endMinute: 10 * 60,
    };
    const carried = previous({
      ...remoteOverrides,
      assignedRoom: REMOTE_NO_ROOM_NEEDED,
      status: "remote",
    });
    const newSession = session({
      wiseSessionId: "new",
      tutorDisplayName: "Tutor One",
      groupId: "group-1",
      startMinute: 11 * 60,
      endMinute: 12 * 60,
    });

    const result = reconcileClassroomAssignments({
      sessions: [session(remoteOverrides), newSession],
      previousRows: [carried],
      rooms,
    });

    const newRow = result.rows.find((row) => row.wiseSessionId === "new")!;
    expect(newRow.assignedRoom).toBe("Room A");
    expect(newRow.ruleTrace.some((trace) => trace.startsWith("assigned by sticky room:"))).toBe(false);
  });

  it("does not double-book the room held by a carried needs_review row", () => {
    const carried = previous({
      wiseSessionId: "existing",
      assignedRoom: "Room A",
      status: "needs_review",
      warnings: ["needs_review_missing_capacity"],
    });
    const overlapping = session({
      wiseSessionId: "new",
      tutorDisplayName: "Tutor Two",
      groupId: "group-2",
      startMinute: 9 * 60 + 30,
      endMinute: 10 * 60 + 30,
    });

    const result = reconcileClassroomAssignments({
      sessions: [session({ wiseSessionId: "existing" }), overlapping],
      previousRows: [carried],
      rooms,
    });

    const existingRow = result.rows.find((row) => row.wiseSessionId === "existing")!;
    const newRow = result.rows.find((row) => row.wiseSessionId === "new")!;
    expect(existingRow).toMatchObject({ status: "needs_review", assignedRoom: "Room A", changeType: "carried" });
    expect(newRow.assignedRoom).toBe("Room B");
  });

  it("seeds same-day continuity from a carried needs_review row", () => {
    const existingOverrides = {
      wiseSessionId: "existing",
      tutorDisplayName: "Tutor One",
      groupId: "group-1",
      startMinute: 9 * 60,
      endMinute: 10 * 60,
    };
    const carried = previous({
      ...existingOverrides,
      assignedRoom: "Room B",
      status: "needs_review",
      warnings: ["needs_review_missing_capacity"],
    });
    const newSession = session({
      wiseSessionId: "new",
      tutorDisplayName: "Tutor One",
      groupId: "group-1",
      startMinute: 11 * 60,
      endMinute: 12 * 60,
    });

    const result = reconcileClassroomAssignments({
      sessions: [session(existingOverrides), newSession],
      previousRows: [carried],
      rooms,
    });

    const newRow = result.rows.find((row) => row.wiseSessionId === "new")!;
    expect(newRow.assignedRoom).toBe("Room B");
    expect(newRow.ruleTrace).toContain("assigned by sticky room: Room B");
  });

  it("unlocks a carried needs_review row when it is the only way to place an overlapping pending session", () => {
    const singleRoom = [rooms[0]];
    const oldRow = previous({
      wiseSessionId: "existing",
      assignedRoom: "Room A",
      status: "needs_review",
      warnings: ["needs_review_missing_capacity"],
    });
    const newSession = session({
      wiseSessionId: "new",
      tutorDisplayName: "Tutor Two",
      groupId: "group-2",
      startMinute: 9 * 60,
      endMinute: 10 * 60,
    });

    const result = reconcileClassroomAssignments({
      sessions: [session({ wiseSessionId: "existing" }), newSession],
      previousRows: [oldRow],
      rooms: singleRoom,
    });

    expect(result.rows.map((row) => row.wiseSessionId).sort()).toEqual(["existing", "new"]);
    expect(result.rows.filter((row) => row.assignedRoom === NO_ROOM_AVAILABLE)).toHaveLength(1);
  });
});
```
No new imports needed -- `previous`, `session`, `reconcileClassroomAssignments`, `NO_ROOM_AVAILABLE`, `rooms`
are already imported/defined in this file. Each scenario was hand-traced against the exact current predicate
and cascade order before being written into this plan (see `<planner_concerns>` for the "unlocks a carried
needs_review row..." test's trace, since its final `changeType` is deliberately not asserted -- explained
there). If an assertion doesn't hold, that's a signal Edit A-D above deviated from this plan, not that the
test needs adjusting.

**Differential proof these tests actually pin the fix (not just re-describe existing behavior):** under the
pre-fix `blocksRoom` (status `"assigned"` only), "does not double-book..." would place `new` into `Room A`
(the carried row's room is invisible to the engine) instead of `Room B`; "seeds same-day continuity..." would
land `new` in `Room A` (sort-order-first, no seed found) instead of `Room B` via sticky; "unlocks a carried
needs_review row..." would produce **zero** `NO_ROOM_AVAILABLE` rows (both sessions silently claim `Room A`
at the same time) instead of exactly one.

**3. `docs/features/classroom-assignments.md` -- two edits:**

Edit A (reconciliation paragraph -- rewrite to describe `holdsRoom`). First run these five greps against your
already-edited `reconciliation.ts` from step 1 and use the real line numbers in place of every `:<...>`
placeholder below -- do not guess, these all shifted because of the edits above:
```bash
grep -n "export function reconcileClassroomAssignments" src/lib/classrooms/reconciliation.ts
grep -n "const assignPending = (" src/lib/classrooms/reconciliation.ts
grep -n "^function holdsRoom" src/lib/classrooms/reconciliation.ts
grep -n "if (failedDynamicRows.length > 0)" src/lib/classrooms/reconciliation.ts
grep -n "const finalRows: ReconciledAssignmentRow" src/lib/classrooms/reconciliation.ts
```

Find:
```
**Reconciliation optimizes for minimal moves.** The incremental run fingerprints each session over 17 identity/time/content fields (`src/lib/classrooms/reconciliation.ts:66`, `:91`). Identical sessions are *carried* — same room, same publish state — and only the rest are re-assigned against the carried rows treated as fixed blocks (`:268`, `:320`). Carried rows also seed same-day continuity for the dynamic pass via `fixedTutorAssignments`, so a newly placed session can land back in a room the tutor already holds that day. If a new session cannot fit anywhere, the engine unlocks only the carried rows that overlap it and are not override-pinned, then retries (`:337`–`:359`). Rows whose room changed anyway are labeled `moved` and have their publish state reset (`:361`–`:399`); disappeared sessions emit a `canceled` event but nothing is written back to Wise.
```
Replace with (substituting the five grep results for the placeholders, in order):
```
**Reconciliation optimizes for minimal moves.** The incremental run fingerprints each session over 17 identity/time/content fields (`src/lib/classrooms/reconciliation.ts:66`, `:91`). Identical sessions are *carried* — same room, same publish state — and only the rest are re-assigned against the carried rows treated as fixed blocks (`:<grep 1>`, `:<grep 2>`). A carried row *holds its room* (`holdsRoom`, `:<grep 3>`) once it has a real `assignedRoom` and a status of `assigned` **or** `needs_review` — a `needs_review_missing_capacity` row still occupies a physical room, and a full engine run treats it identically to an assigned row for both occupancy and continuity, excluding only the `NO_ROOM_AVAILABLE` / `REMOTE_NO_ROOM_NEEDED` sentinels. Carried rows that hold a room are emitted as `ExternalRoomBlock`s, so a new session can never double-book a room a carried `needs_review` row still sits in, and they seed same-day continuity for the dynamic pass via `fixedTutorAssignments`, so a newly placed session can land back in a room the tutor already holds that day. If a new session cannot fit anywhere, the engine unlocks only the carried rows that hold a room, overlap it, and are not override-pinned, then retries (`:<grep 4>`) — a carried `needs_review` row is exactly as displaceable as an assigned one. Rows whose room changed anyway are labeled `moved` and have their publish state reset (`:<grep 5>`); disappeared sessions emit a `canceled` event but nothing is written back to Wise.
```

Edit B (test-count bump -- this task adds 3 new `it()` declarations to `reconciliation.test.ts`; no
parameterized block involved so the executed-case offset (+4, from the pre-existing `it.each` in
`assignment-engine.test.ts`) is unchanged):

Find:
```
Sixteen test files, 159 test declarations (163 executed cases once the one parameterized block expands):
```
Replace with:
```
Sixteen test files, 162 test declarations (166 executed cases once the one parameterized block expands):
```

Find:
```
- **`reconciliation.test.ts`** (9) — carry-forward with preserved publish state, canceled removal, fitting new sessions against carried blocks, reschedule detection, minimal-displacement unlock, override protection, same-day continuity seeding from a carried row, and remote carried rows seeding nothing.
```
Replace with:
```
- **`reconciliation.test.ts`** (12) — carry-forward with preserved publish state, canceled removal, fitting new sessions against carried blocks, reschedule detection, minimal-displacement unlock (including displacing a carried `needs_review` row), override protection, same-day continuity seeding from a carried row (including a carried `needs_review` row), remote carried rows seeding nothing, and a carried `needs_review` row's held room never being double-booked.
```
  </action>
  <verify>
    <automated>npx vitest run src/lib/classrooms</automated>
  </verify>
  <done>
`blocksRoom` no longer exists anywhere in the repo (`grep -rn "blocksRoom" src/` returns nothing); `holdsRoom`
gates `rowToExternalBlock`, `fixedTutorAssignmentsFrom`, and the unlock-retry filter; all 3 new tests pass
with the exact assertions shown; the two pinned tests named in the objective (minimal-displacement,
override-pinned) and all 6 other pre-existing `reconciliation.test.ts` cases are unaffected; docs
reconciliation paragraph and test-count figures updated with grep-verified line numbers; `npx vitest run
src/lib/classrooms` is green; one commit: `fix(classrooms): hold rooms and continuity for carried
needs-review rows`.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: contextSessions -- online center-room chain sees carried sessions</name>
  <files>src/lib/classrooms/assignment-engine.ts, src/lib/classrooms/reconciliation.ts, src/lib/classrooms/__tests__/assignment-engine.test.ts, src/lib/classrooms/__tests__/reconciliation.test.ts, docs/features/classroom-assignments.md</files>
  <behavior>
    - A pending online session whose only nearby same-tutor session is a *carried* onsite row gets a real
      center room instead of `REMOTE_NO_ROOM_NEEDED` (today's bug: the chain walk never sees it).
    - A pending online session with no onsite neighbor anywhere (pending or carried, same tutor) still goes
      remote -- the fix must not over-connect across tutors or invent adjacency that isn't there.
    - `contextSessions` entries never appear in `assignClassrooms`'s output rows, never occupy a room, and
      never seed `lastByTutor`/`fixedByTutor` continuity -- they only ever influence the requirement map.
    - With `contextSessions` omitted, empty, or absent entirely, `assignClassrooms` produces byte-identical
      output to today (this option must be a strict, inert addition when unused).
  </behavior>
  <action>
**1. `src/lib/classrooms/assignment-engine.ts` -- six edits, in this order:**

Edit A -- new `ContextSession` interface and `AssignmentOptions` field, right after `FixedTutorAssignment`:

Find:
```typescript
export interface FixedTutorAssignment {
  tutorDisplayName: string;
  startMinute: number;
  endMinute: number;
  room: string;
}

export interface AssignmentOptions {
  externalRoomBlocks?: ExternalRoomBlock[];
  fixedTutorAssignments?: FixedTutorAssignment[];
}
```
Replace with:
```typescript
export interface FixedTutorAssignment {
  tutorDisplayName: string;
  startMinute: number;
  endMinute: number;
  room: string;
}

/**
 * Minimal session shape for center-room chain context. Carried-but-unchanged sessions are passed
 * through as context so buildCenterRoomRequirementMap can see a tutor's full same-day schedule
 * when walking the online<->onsite adjacency chain -- without those sessions being (re-)assigned
 * a room, occupying a room, or seeding continuity for anyone else (there is no assignedRoom field
 * on this type at all, by design).
 */
export interface ContextSession {
  wiseSessionId: string;
  tutorDisplayName: string;
  groupId: string;
  startMinute: number;
  endMinute: number;
  sessionType?: string | null;
}

export interface AssignmentOptions {
  externalRoomBlocks?: ExternalRoomBlock[];
  fixedTutorAssignments?: FixedTutorAssignment[];
  /** Same-day sessions to fold into the center-room chain walk only; see ContextSession. */
  contextSessions?: ContextSession[];
}
```

Edit B -- retype `tutorKey` (structurally compatible: every real `AssignmentSession` already satisfies
`ContextSession`, so this is a pure widening, not a behavior change):

Find:
```typescript
function tutorKey(session: AssignmentSession): string {
  return session.groupId || normalizeTutorName(session.tutorDisplayName);
}
```
Replace with:
```typescript
function tutorKey(session: ContextSession): string {
  return session.groupId || normalizeTutorName(session.tutorDisplayName);
}
```

Edit C -- retype `sortedTutorSessions`:

Find:
```typescript
function sortedTutorSessions(sessions: AssignmentSession[]): AssignmentSession[] {
  return [...sessions].sort((a, b) => {
    if (a.startMinute !== b.startMinute) return a.startMinute - b.startMinute;
    if (a.endMinute !== b.endMinute) return a.endMinute - b.endMinute;
    return a.wiseSessionId.localeCompare(b.wiseSessionId);
  });
}
```
Replace with:
```typescript
function sortedTutorSessions(sessions: ContextSession[]): ContextSession[] {
  return [...sessions].sort((a, b) => {
    if (a.startMinute !== b.startMinute) return a.startMinute - b.startMinute;
    if (a.endMinute !== b.endMinute) return a.endMinute - b.endMinute;
    return a.wiseSessionId.localeCompare(b.wiseSessionId);
  });
}
```

Edit D -- retype `onlineSessionRequiresCenterRoom` (signature only; body is untouched, it already only reads
`sessionType` / `wiseSessionId` / `startMinute` / `endMinute`, all present on `ContextSession`):

Find:
```typescript
function onlineSessionRequiresCenterRoom(
  session: AssignmentSession,
  tutorSessions: AssignmentSession[],
): boolean {
```
Replace with:
```typescript
function onlineSessionRequiresCenterRoom(
  session: ContextSession,
  tutorSessions: ContextSession[],
): boolean {
```

Edit E -- the core fix: rewrite `buildCenterRoomRequirementMap` to accept and fold in `contextSessions`:

Find:
```typescript
function buildCenterRoomRequirementMap(sessions: AssignmentSession[]): Map<string, boolean> {
  const byTutor = new Map<string, AssignmentSession[]>();
  for (const session of sessions) {
    const key = tutorKey(session);
    byTutor.set(key, [...(byTutor.get(key) ?? []), session]);
  }

  const requirements = new Map<string, boolean>();
  for (const tutorSessions of byTutor.values()) {
    for (const session of tutorSessions) {
      requirements.set(
        session.wiseSessionId,
        !isOnlineSession(session.sessionType) || onlineSessionRequiresCenterRoom(session, tutorSessions),
      );
    }
  }
  return requirements;
}
```
Replace with:
```typescript
/**
 * Builds the online-session center-room requirement map.
 *
 * 1. Buckets pending sessions by tutor (groupId, falling back to normalized display name).
 * 2. Folds contextSessions (e.g. this day's carried rows) into the same tutor buckets, skipping any
 *    id already present in `sessions` -- this lets a pending online session see a carried onsite
 *    neighbor (or vice versa) when walking the adjacency chain, matching what a full, non-reconciled
 *    run over the same final session set would see.
 * 3. Walks the <60-minute transitive chain per pending session to decide whether it is adjacent to
 *    an onsite session and therefore still needs a center room. Context sessions never receive a
 *    requirement entry of their own -- they are not being (re-)assigned by this call.
 */
function buildCenterRoomRequirementMap(
  sessions: AssignmentSession[],
  contextSessions: ContextSession[] = [],
): Map<string, boolean> {
  const pendingIds = new Set(sessions.map((session) => session.wiseSessionId));
  const byTutor = new Map<string, ContextSession[]>();
  for (const session of sessions) {
    const key = tutorKey(session);
    byTutor.set(key, [...(byTutor.get(key) ?? []), session]);
  }
  for (const context of contextSessions) {
    if (pendingIds.has(context.wiseSessionId)) continue;
    const key = tutorKey(context);
    byTutor.set(key, [...(byTutor.get(key) ?? []), context]);
  }

  const requirements = new Map<string, boolean>();
  for (const tutorSessions of byTutor.values()) {
    for (const session of tutorSessions) {
      if (!pendingIds.has(session.wiseSessionId)) continue;
      requirements.set(
        session.wiseSessionId,
        !isOnlineSession(session.sessionType) || onlineSessionRequiresCenterRoom(session, tutorSessions),
      );
    }
  }
  return requirements;
}
```

Edit F -- wire `options.contextSessions` into the one call site:

Find:
```typescript
  const centerRoomRequiredBySessionId = buildCenterRoomRequirementMap(sessions);
```
Replace with:
```typescript
  const centerRoomRequiredBySessionId = buildCenterRoomRequirementMap(sessions, options.contextSessions ?? []);
```

**Byte-identical guard, reasoned through (also pinned by a test below):** with `contextSessions` empty or
absent, the `for (const context of contextSessions)` loop is a no-op, so `byTutor` is built exactly as
before; the new `if (!pendingIds.has(session.wiseSessionId)) continue;` guard is *always* true for every
session that reaches it in that case (every session in every bucket originated from `sessions` itself), so
it never skips anything that used to run. Nothing else in `assignClassrooms` changed.

**2. `src/lib/classrooms/__tests__/assignment-engine.test.ts` -- append 2 new tests at the very end of the
`describe("assignClassrooms", ...)` block (anchor on the existing last test):**

Find:
```typescript
  it("does not let a sticky claim squat the capacity-demoted Relax (TV) and starve a later group", () => {
    const result = assignClassrooms(
      [
        session({
          wiseSessionId: "morning-group",
          tutorDisplayName: "Tutor One",
          groupId: "morning-group",
          studentCount: 6,
          classType: "GROUP",
          startMinute: 9 * 60,
          endMinute: 10 * 60,
        }),
        session({
          wiseSessionId: "afternoon-solo",
          tutorDisplayName: "Tutor One",
          groupId: "afternoon-solo",
          studentCount: 1,
          startMinute: 11 * 60,
          endMinute: 12 * 60,
        }),
        session({
          wiseSessionId: "overlapping-group",
          tutorDisplayName: "Tutor Two",
          groupId: "overlapping-group",
          studentCount: 6,
          classType: "GROUP",
          startMinute: 11 * 60,
          endMinute: 12 * 60,
        }),
      ],
      roomsFor("Focus", "Cool", "Relax (TV)"),
    );

    const morningGroup = result.rows.find((row) => row.wiseSessionId === "morning-group")!;
    const afternoonSolo = result.rows.find((row) => row.wiseSessionId === "afternoon-solo")!;
    const overlappingGroup = result.rows.find((row) => row.wiseSessionId === "overlapping-group")!;

    expect(morningGroup.assignedRoom).toBe("Relax (TV)");
    expect(afternoonSolo.assignedRoom).not.toBe("Relax (TV)");
    expect(afternoonSolo.status).toBe("assigned");
    expect(afternoonSolo.ruleTrace).not.toContain("assigned by sticky room: Relax (TV)");
    expect(overlappingGroup.assignedRoom).toBe("Relax (TV)");
    expect(result.rows.some((row) => row.status === "no_room")).toBe(false);
  });
});
```
Replace with:
```typescript
  it("does not let a sticky claim squat the capacity-demoted Relax (TV) and starve a later group", () => {
    const result = assignClassrooms(
      [
        session({
          wiseSessionId: "morning-group",
          tutorDisplayName: "Tutor One",
          groupId: "morning-group",
          studentCount: 6,
          classType: "GROUP",
          startMinute: 9 * 60,
          endMinute: 10 * 60,
        }),
        session({
          wiseSessionId: "afternoon-solo",
          tutorDisplayName: "Tutor One",
          groupId: "afternoon-solo",
          studentCount: 1,
          startMinute: 11 * 60,
          endMinute: 12 * 60,
        }),
        session({
          wiseSessionId: "overlapping-group",
          tutorDisplayName: "Tutor Two",
          groupId: "overlapping-group",
          studentCount: 6,
          classType: "GROUP",
          startMinute: 11 * 60,
          endMinute: 12 * 60,
        }),
      ],
      roomsFor("Focus", "Cool", "Relax (TV)"),
    );

    const morningGroup = result.rows.find((row) => row.wiseSessionId === "morning-group")!;
    const afternoonSolo = result.rows.find((row) => row.wiseSessionId === "afternoon-solo")!;
    const overlappingGroup = result.rows.find((row) => row.wiseSessionId === "overlapping-group")!;

    expect(morningGroup.assignedRoom).toBe("Relax (TV)");
    expect(afternoonSolo.assignedRoom).not.toBe("Relax (TV)");
    expect(afternoonSolo.status).toBe("assigned");
    expect(afternoonSolo.ruleTrace).not.toContain("assigned by sticky room: Relax (TV)");
    expect(overlappingGroup.assignedRoom).toBe("Relax (TV)");
    expect(result.rows.some((row) => row.status === "no_room")).toBe(false);
  });

  it("computes the center-room chain through contextSessions but never assigns, occupies, or seeds continuity for them", () => {
    const result = assignClassrooms(
      [
        session({
          wiseSessionId: "online",
          tutorDisplayName: "Tutor One",
          groupId: "group-1",
          sessionType: "SCHEDULED",
          startMinute: 10 * 60 + 30,
          endMinute: 11 * 60 + 30,
        }),
        session({
          wiseSessionId: "unrelated",
          tutorDisplayName: "Tutor Two",
          groupId: "group-2",
          startMinute: 9 * 60,
          endMinute: 10 * 60,
        }),
      ],
      rememberOnlyRoom,
      new Map(),
      {
        contextSessions: [
          {
            wiseSessionId: "context-onsite",
            tutorDisplayName: "Tutor One",
            groupId: "group-1",
            startMinute: 9 * 60,
            endMinute: 10 * 60,
            sessionType: "OFFLINE",
          },
        ],
      },
    );

    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((row) => row.wiseSessionId).sort()).toEqual(["online", "unrelated"]);

    const online = result.rows.find((row) => row.wiseSessionId === "online")!;
    const unrelated = result.rows.find((row) => row.wiseSessionId === "unrelated")!;
    expect(online.status).not.toBe("remote");
    expect(online.assignedRoom).toBe("Remember (TV)");
    expect(online.ruleTrace).toContain("assigned priority-scored standard room: Remember (TV)");
    // The context session occupies 9-10 in this same room in a full run's terms, but it must never
    // seed occupancy here -- "unrelated" (a different tutor, same 9-10 slot) still gets the room.
    expect(unrelated.assignedRoom).toBe("Remember (TV)");
    expect(unrelated.status).toBe("assigned");
  });

  it("produces identical results whether options.contextSessions is omitted, empty, or absent entirely", () => {
    const sessions = [
      session({
        wiseSessionId: "onsite",
        tutorDisplayName: "Tutor One",
        sessionType: "OFFLINE",
        startMinute: 9 * 60,
        endMinute: 10 * 60,
      }),
      session({
        wiseSessionId: "online",
        tutorDisplayName: "Tutor One",
        sessionType: "SCHEDULED",
        startMinute: 10 * 60 + 30,
        endMinute: 11 * 60 + 30,
      }),
    ];

    const noOptions = assignClassrooms(sessions, DEFAULT_CLASSROOM_ROOMS);
    const emptyOptions = assignClassrooms(sessions, DEFAULT_CLASSROOM_ROOMS, new Map(), {});
    const explicitEmptyContext = assignClassrooms(sessions, DEFAULT_CLASSROOM_ROOMS, new Map(), { contextSessions: [] });

    expect(emptyOptions).toEqual(noOptions);
    expect(explicitEmptyContext).toEqual(noOptions);
  });
});
```
No new imports needed -- `rememberOnlyRoom` and `DEFAULT_CLASSROOM_ROOMS` are already defined/imported in
this file. The `contextSessions` array literal is checked structurally against `ContextSession` through the
`options` parameter; no explicit type import is required.

**3. `src/lib/classrooms/reconciliation.ts` -- three edits, layered on top of Task 1's already-committed
`holdsRoom` rename:**

Edit A -- import the new type:

Find:
```typescript
import {
  assignClassrooms,
  REMOTE_NO_ROOM_NEEDED,
  type AssignmentResultRow,
  type AssignmentSession,
  type ExternalRoomBlock,
  type FixedTutorAssignment,
} from "./assignment-engine";
```
Replace with:
```typescript
import {
  assignClassrooms,
  REMOTE_NO_ROOM_NEEDED,
  type AssignmentResultRow,
  type AssignmentSession,
  type ContextSession,
  type ExternalRoomBlock,
  type FixedTutorAssignment,
} from "./assignment-engine";
```

Edit B -- new projection helper, right after `rowToExternalBlock`:

Find:
```typescript
function rowToExternalBlock(row: ReconciledAssignmentRow): ExternalRoomBlock | null {
  if (!holdsRoom(row)) return null;
  return {
    wiseSessionId: row.wiseSessionId,
    className: row.studentName ?? row.title ?? null,
    location: row.assignedRoom,
    startMinute: row.startMinute,
    endMinute: row.endMinute,
  };
}
```
Replace with:
```typescript
function rowToExternalBlock(row: ReconciledAssignmentRow): ExternalRoomBlock | null {
  if (!holdsRoom(row)) return null;
  return {
    wiseSessionId: row.wiseSessionId,
    className: row.studentName ?? row.title ?? null,
    location: row.assignedRoom,
    startMinute: row.startMinute,
    endMinute: row.endMinute,
  };
}

/**
 * Projects a carried row into the minimal shape assignClassrooms needs to fold it into the
 * center-room chain walk (see ContextSession). Passed for every carried row regardless of status --
 * a full, non-reconciled run over the same final session set would see all of them.
 */
function rowToContextSession(row: ReconciledAssignmentRow): ContextSession {
  return {
    wiseSessionId: row.wiseSessionId,
    tutorDisplayName: row.tutorDisplayName,
    groupId: row.groupId,
    startMinute: row.startMinute,
    endMinute: row.endMinute,
    sessionType: row.sessionType,
  };
}
```

Edit C -- wire it into `assignPending`'s engine options (this one function serves both the initial pass and
the unlock-retry pass, so both automatically pick up context with no further change):

Find:
```typescript
  const assignPending = (
    sessions: AssignmentSession[],
    fixedRows: ReconciledAssignmentRow[],
  ): AssignmentResultRow[] => assignClassrooms(
    sessions,
    input.rooms,
    overrides,
    {
      externalRoomBlocks: fixedBlocks(fixedRows, externalRoomBlocks),
      fixedTutorAssignments: fixedTutorAssignmentsFrom(fixedRows),
    },
  ).rows;
```
Replace with:
```typescript
  const assignPending = (
    sessions: AssignmentSession[],
    fixedRows: ReconciledAssignmentRow[],
  ): AssignmentResultRow[] => assignClassrooms(
    sessions,
    input.rooms,
    overrides,
    {
      externalRoomBlocks: fixedBlocks(fixedRows, externalRoomBlocks),
      fixedTutorAssignments: fixedTutorAssignmentsFrom(fixedRows),
      // fixedRows is exactly today's still-carried rows (any status) at this point in the
      // reconcile. A full run would see all of them when walking the online<->onsite center-room
      // chain, so pass them as context -- without re-assigning, re-occupying, or re-seeding
      // continuity for them (that is already handled by externalRoomBlocks / fixedTutorAssignments
      // above). On the unlock-retry call, previously-unlocked rows have already moved out of
      // fixedRows and into the `sessions` argument itself, so nothing is ever double-counted.
      contextSessions: fixedRows.map(rowToContextSession),
    },
  ).rows;
```

**4. `src/lib/classrooms/__tests__/reconciliation.test.ts` -- append 2 more tests, right after Task 1's last
new test (anchor on it so this doesn't depend on line numbers; by the time this task runs, Task 1's 3 tests
already exist earlier in the file, which is fine -- this anchor is at the very end regardless):**

Find:
```typescript
  it("unlocks a carried needs_review row when it is the only way to place an overlapping pending session", () => {
    const singleRoom = [rooms[0]];
    const oldRow = previous({
      wiseSessionId: "existing",
      assignedRoom: "Room A",
      status: "needs_review",
      warnings: ["needs_review_missing_capacity"],
    });
    const newSession = session({
      wiseSessionId: "new",
      tutorDisplayName: "Tutor Two",
      groupId: "group-2",
      startMinute: 9 * 60,
      endMinute: 10 * 60,
    });

    const result = reconcileClassroomAssignments({
      sessions: [session({ wiseSessionId: "existing" }), newSession],
      previousRows: [oldRow],
      rooms: singleRoom,
    });

    expect(result.rows.map((row) => row.wiseSessionId).sort()).toEqual(["existing", "new"]);
    expect(result.rows.filter((row) => row.assignedRoom === NO_ROOM_AVAILABLE)).toHaveLength(1);
  });
});
```
Replace with:
```typescript
  it("unlocks a carried needs_review row when it is the only way to place an overlapping pending session", () => {
    const singleRoom = [rooms[0]];
    const oldRow = previous({
      wiseSessionId: "existing",
      assignedRoom: "Room A",
      status: "needs_review",
      warnings: ["needs_review_missing_capacity"],
    });
    const newSession = session({
      wiseSessionId: "new",
      tutorDisplayName: "Tutor Two",
      groupId: "group-2",
      startMinute: 9 * 60,
      endMinute: 10 * 60,
    });

    const result = reconcileClassroomAssignments({
      sessions: [session({ wiseSessionId: "existing" }), newSession],
      previousRows: [oldRow],
      rooms: singleRoom,
    });

    expect(result.rows.map((row) => row.wiseSessionId).sort()).toEqual(["existing", "new"]);
    expect(result.rows.filter((row) => row.assignedRoom === NO_ROOM_AVAILABLE)).toHaveLength(1);
  });

  it("gives a pending online session a center room when its only chain neighbor is a carried onsite session", () => {
    const tutorOverrides = { tutorDisplayName: "Tutor One", groupId: "group-1" };
    const onsiteOverrides = {
      ...tutorOverrides,
      wiseSessionId: "existing-onsite",
      sessionType: "OFFLINE",
      startMinute: 9 * 60,
      endMinute: 10 * 60,
    };
    const carried = previous({ ...onsiteOverrides, assignedRoom: "Room A" });
    const pendingOnline = session({
      ...tutorOverrides,
      wiseSessionId: "new-online",
      sessionType: "SCHEDULED",
      startMinute: 10 * 60 + 30,
      endMinute: 11 * 60 + 30,
    });

    const result = reconcileClassroomAssignments({
      sessions: [session(onsiteOverrides), pendingOnline],
      previousRows: [carried],
      rooms,
    });

    const onlineRow = result.rows.find((row) => row.wiseSessionId === "new-online")!;
    expect(onlineRow.status).not.toBe("remote");
    expect(onlineRow.assignedRoom).toBe("Room A");
    expect(onlineRow.ruleTrace).toContain("assigned by online continuity: Room A");
  });

  it("keeps a pending online session remote when it has no onsite chain neighbor, even with unrelated carried context", () => {
    const carried = previous({
      wiseSessionId: "other-tutor-onsite",
      tutorDisplayName: "Tutor Two",
      groupId: "group-2",
      sessionType: "OFFLINE",
      assignedRoom: "Room A",
      startMinute: 9 * 60,
      endMinute: 10 * 60,
    });
    const pendingOnline = session({
      wiseSessionId: "new-online",
      tutorDisplayName: "Tutor One",
      groupId: "group-1",
      sessionType: "SCHEDULED",
      startMinute: 12 * 60,
      endMinute: 13 * 60,
    });

    const result = reconcileClassroomAssignments({
      sessions: [
        session({
          wiseSessionId: "other-tutor-onsite",
          tutorDisplayName: "Tutor Two",
          groupId: "group-2",
          sessionType: "OFFLINE",
          startMinute: 9 * 60,
          endMinute: 10 * 60,
        }),
        pendingOnline,
      ],
      previousRows: [carried],
      rooms,
    });

    const onlineRow = result.rows.find((row) => row.wiseSessionId === "new-online")!;
    expect(onlineRow.status).toBe("remote");
    expect(onlineRow.assignedRoom).toBe(REMOTE_NO_ROOM_NEEDED);
  });
});
```

**5. `docs/features/classroom-assignments.md` -- three edits:**

Edit A (append a new paragraph right after the reconciliation paragraph Task 1 rewrote). First run these
three greps against your already-edited `assignment-engine.ts` and `reconciliation.ts` and use the real
numbers in place of the placeholders:
```bash
grep -n "^export interface ContextSession" src/lib/classrooms/assignment-engine.ts
grep -n "^function buildCenterRoomRequirementMap" src/lib/classrooms/assignment-engine.ts
grep -n "^function rowToContextSession" src/lib/classrooms/reconciliation.ts
```
Then re-run Task 1's same five greps (they shifted again because of this task's own edits to
`reconciliation.ts` above) to refresh the paragraph Task 1 wrote:
```bash
grep -n "export function reconcileClassroomAssignments" src/lib/classrooms/reconciliation.ts
grep -n "const assignPending = (" src/lib/classrooms/reconciliation.ts
grep -n "^function holdsRoom" src/lib/classrooms/reconciliation.ts
grep -n "if (failedDynamicRows.length > 0)" src/lib/classrooms/reconciliation.ts
grep -n "const finalRows: ReconciledAssignmentRow" src/lib/classrooms/reconciliation.ts
```
Use the Read tool to fetch the current reconciliation paragraph (it now reads as Task 1 wrote it, starting
`**Reconciliation optimizes for minimal moves.**` and ending `nothing is written back to Wise.`) and use that
exact text as the Edit tool's old_string. Construct new_string as: the same paragraph with its five citations
refreshed to this task's grep results, followed immediately by this new paragraph:
```
**Carried rows also inform the online-center-room chain.** `assignClassrooms`'s `contextSessions` option (`ContextSession`, `assignment-engine.ts:<grep 1>`) lets `buildCenterRoomRequirementMap` (`:<grep 2>`) fold every carried row — any status — into the tutor-grouped adjacency walk alongside the pending sessions, so a pending online session's <60-minute chain can see a carried onsite neighbor (and vice versa) exactly as a full, non-reconciled run over the same final session set would. Context sessions never receive a room, never occupy one, and never seed continuity themselves (`reconciliation.ts`'s `rowToContextSession`, `:<grep 3>`, projects only scheduling fields — there is no `assignedRoom` on `ContextSession` to leak) — only pending sessions are ever assigned, occupied, or looked up in the requirement map.
```

Edit B (test-count bump -- this task adds 2 declarations to `assignment-engine.test.ts` and 2 more to
`reconciliation.test.ts`, on top of Task 1's 3):

Find:
```
Sixteen test files, 162 test declarations (166 executed cases once the one parameterized block expands):
```
Replace with:
```
Sixteen test files, 166 test declarations (170 executed cases once the one parameterized block expands):
```

Find:
```
- **`src/lib/classrooms/__tests__/assignment-engine.test.ts`** (42 declarations → 46 executed cases; one `it.each` covers 5 preferred-room tutors at `:350`–`:380`) — capacity inference and the missing-capacity warning, TV requirement, external live-block availability, online/`SCHEDULED` remote handling, the 60-minute online-center rule, the Gift/Joy hard pin, priority-room protection, continuity, overrides, overflow ordering, and no-room. Override coverage is partial: valid overrides are asserted at `:417`, `:485` and `:520`, and `invalid_override_room` at `:516` (inactive room) and `:592` (unknown room) — but the *occupied*-override branch is not covered anywhere. `override_room_unavailable` (`assignment-engine.ts:432`) appears in exactly one place in the repo, its own `warnings.push`, and is asserted by no test.
```
Replace with:
```
- **`src/lib/classrooms/__tests__/assignment-engine.test.ts`** (44 declarations → 48 executed cases; one `it.each` covers 5 preferred-room tutors at `:350`–`:380`) — capacity inference and the missing-capacity warning, TV requirement, external live-block availability, online/`SCHEDULED` remote handling, the 60-minute online-center rule, the Gift/Joy hard pin, priority-room protection, continuity, overrides, overflow ordering, no-room, and `contextSessions`' isolation (chain influence without producing rows/occupancy, plus no-options equivalence). Override coverage is partial: valid overrides are asserted at `:417`, `:485` and `:520`, and `invalid_override_room` at `:516` (inactive room) and `:592` (unknown room) — but the *occupied*-override branch is not covered anywhere. `override_room_unavailable` (`assignment-engine.ts:432`) appears in exactly one place in the repo, its own `warnings.push`, and is asserted by no test.
```
(The `:350`–`:380`, `:417`, `:485`, `:520`, `:516`, `:592`, and `assignment-engine.ts:432` citations in that
bullet are untouched on purpose: this task's 2 new tests are appended at the very end of the file, after
every existing test, so none of those earlier citations move.)

Find:
```
- **`reconciliation.test.ts`** (12) — carry-forward with preserved publish state, canceled removal, fitting new sessions against carried blocks, reschedule detection, minimal-displacement unlock (including displacing a carried `needs_review` row), override protection, same-day continuity seeding from a carried row (including a carried `needs_review` row), remote carried rows seeding nothing, and a carried `needs_review` row's held room never being double-booked.
```
Replace with:
```
- **`reconciliation.test.ts`** (14) — carry-forward with preserved publish state, canceled removal, fitting new sessions against carried blocks, reschedule detection, minimal-displacement unlock (including displacing a carried `needs_review` row), override protection, same-day continuity seeding from a carried row (including a carried `needs_review` row), remote carried rows seeding nothing, a carried `needs_review` row's held room never being double-booked, and the online-center-room chain seeing (and correctly ignoring, when unrelated) carried sessions as context.
```
  </action>
  <verify>
    <automated>npx vitest run src/lib/classrooms && npm test && npx tsc --noEmit</automated>
  </verify>
  <done>
`assignment-engine.ts` exports `ContextSession` and `AssignmentOptions.contextSessions`;
`buildCenterRoomRequirementMap` folds `contextSessions` into the chain walk gated so only pending ids get a
requirement entry; `reconciliation.ts`'s `assignPending` passes `contextSessions: fixedRows.map
(rowToContextSession)` on both call sites; all 4 new tests (2 engine, 2 reconciliation) pass with the exact
assertions shown; all 3 of Task 1's tests and all 9 original pinned tests are still green; docs
reconciliation section (both paragraphs) and both test-count bullets updated with grep-verified line numbers;
full unit suite (`npm test`) and `npx tsc --noEmit` are both clean; one commit: `fix(classrooms): compute
online center-room chains across carried sessions`.
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|--------------|
| Admin session → `/class-assignments` run/reconcile path | Pre-existing Auth.js-gated admin action (`src/middleware.ts`, `data.ts:877`, `runIncrementalClassroomAssignment`). This plan changes only server-side pure-function scheduling logic reachable from that same already-authenticated path -- no new endpoint, no new client-supplied field, no new deserialization boundary. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-260811-evt-01 | Tampering | `holdsRoom`'s widened predicate; `contextSessions` / `fixedTutorAssignments` / `externalRoomBlocks` | accept | All three are built entirely server-side inside `reconcileClassroomAssignments` from the run's own carried rows (already-persisted `classroom_assignment_rows`, read via `previousRows`) -- no external or client-supplied value flows into any of them, and `ContextSession` structurally cannot carry a room (no `assignedRoom` field), so even a hypothetical bad actor controlling a carried row's content could not use context to force a room assignment. |
| T-260811-evt-02 | Denial of Service | `buildCenterRoomRequirementMap`'s new `contextSessions` loop | accept | Bounded by the day's total row count (carried + pending), the same order of magnitude `buildCenterRoomRequirementMap` already iterates today; no new unbounded or externally-controlled collection, and the added work is a single extra `for` loop plus one `Set` membership check per session. |
| T-260811-evt-03 | Information Disclosure | Carried `needs_review` rows now flow into `ExternalRoomBlock` / `ContextSession` | accept | Both projections carry only session id, tutor display name, room/time (`ExternalRoomBlock`) or scheduling fields with no room at all (`ContextSession`) -- the same fields already rendered on the same already-authenticated `/class-assignments` page for every other row; no new data class is exposed, and `needs_review` rows were already visible in the Rows/Tutor Schedule tabs before this plan. |

No new endpoint, no new persisted field, no new external I/O, and no change to the auth/session boundary is
introduced by this plan -- the STRIDE surface is materially identical to the pre-existing
`assignClassrooms`/`reconcileClassroomAssignments` code path this plan modifies in place.
</threat_model>

<planner_concerns>
Interpretations and scope decisions made while turning the task brief into executable, internally-consistent
tasks, flagged per the fidelity instructions:

1. **`ContextSession` carries `groupId`, beyond the task brief's suggested "minimal shape" (wiseSessionId,
   tutorDisplayName, startMinute, endMinute, sessionType).** `tutorKey` -- the function that buckets sessions
   for the chain walk -- prefers `session.groupId` over the normalized display name whenever `groupId` is
   truthy, and every real `AssignmentSession` (pending or carried) always carries one (sourced from
   `tutor_identity_groups.id`, `data.ts:744`). Omitting `groupId` from `ContextSession` would mean a pending
   session (keyed by its real, non-empty `groupId`) and its context counterpart for the same tutor
   (falling back to normalized-name keying, since it would have no `groupId`) land in *different* buckets --
   silently defeating the entire fix in production, while still passing a naive test that forgets to set
   `groupId` on both sides. This is not scope creep: it is a correctness requirement for the exact behavior
   the task brief asks for. The "gives a pending online session a center room..." reconciliation test is
   deliberately written with matching non-empty `groupId`s on both the carried and pending side specifically
   so it would fail if this field were dropped.
2. **Doc-update scope is the reconciliation paragraph(s) plus the directly-mechanical test-count bullets --
   not a general line-citation audit of the file.** `docs/features/classroom-assignments.md` already carries
   material pre-existing line-citation drift unrelated to this plan (verified by inspection, not guessed --
   e.g. the doc's `assignment-engine.ts:199` citation for the tie-break comment actually lands mid-parameter-
   list of an unrelated function today, and `:405`–`:415` for `pickBestRoom` is off by roughly 50 lines). The
   sibling `260811-div-PLAN.md` explicitly scoped the *same* citations out ("This does not extend to
   auditing every other pre-existing citation elsewhere in the doc ... e.g. assignment-engine.ts:199, :222–
   :270, :432"). I apply the same boundary here: the "Room selection cascade" sentence's `:455`–`:591` range
   and its nested `:179`–`:184` / `:405`–`:415` sub-citations are **not** touched by this plan, even though
   Task 2's insertions shift them further, because (a) that sentence is not "the reconciliation section" the
   task brief asked for, and (b) it was already inaccurate before this plan touched anything -- fixing it
   properly would require a full independent audit pass, which is out of scope for a 2-task bugfix.
3. **Task 2's engine-level equivalence test asserts `toEqual`, not a hand-picked subset of fields.** `
   AssignmentResult` is plain data (strings/numbers/arrays/`Date`s, no `Map`/`Set`/functions in the return
   value), so a full deep-equality check between "no options", "`{}`", and "`{ contextSessions: [] }`" is
   both safe and the strongest available proof that the new field is fully inert when unused -- stronger
   than spot-checking a few fields would be.
4. **The "unlocks a carried needs_review row..." test does not assert a final `changeType` for the unlocked
   row.** Traced through by hand: the carried row's *stored* `needs_review` status (set directly on the test
   fixture via `previous({ status: "needs_review", ... })`) does not match what a *fresh* re-derivation of
   that same session would produce (the test session's `studentCount: 1` + default `classType:
   "ONE_TO_ONE"` is a reliably-inferable 1:1, so once unlocked and re-run through the engine from scratch it
   comes back `status: "assigned"`, not `needs_review`). Because the reconciler's merge step compares the
   *previous* row's `status`/`warnings` against the *freshly re-derived* row's to decide whether to keep
   `changeType: "carried"` (`preservePublish`) or flip to `"moved"` (`resetPublish`), this particular
   fixture's `existing` row ends up `changeType: "moved"` after unlocking -- an accurate, expected
   consequence of the fixture (a real needs_review row whose underlying data happens to *also* satisfy
   reliable-1:1 inference), not a defect in the fix. The test asserts only what it needs to prove the
   mechanism engaged (both ids present; exactly one `NO_ROOM_AVAILABLE`), matching the existing pinned
   "unlocks the smallest overlapping carried set..." test's own assertion scope.
5. **Task 2's docs edit instructs Read-then-Edit rather than a literal Find block for the reconciliation
   paragraph.** Its exact text depends on numbers Task 1's own executor resolves at Task-1-edit-time via
   grep, which cannot be known at plan-authoring time. This mirrors (and is more explicit than) the sibling
   plan's own `:<verified end line>` placeholder convention for the same reason.
</planner_concerns>

<verification>
1. After Task 1: `npx vitest run src/lib/classrooms` green, including the 3 new needs_review tests.
2. After Task 2: `npx vitest run src/lib/classrooms && npm test && npx tsc --noEmit` all green -- full unit
   suite (all 369+ files, including the 7 new cases from this plan) and a clean typecheck.
3. Manual, not automated by this plan (post-merge rollout step): trigger an incremental/reconciled run for a
   date with at least one `needs_review_missing_capacity` session via the morning cron or
   `POST /api/class-assignments/run` on an unchanged day; confirm the `needs_review` row's room does not
   change and no new session lands in it.
4. Manual, post-deploy: watch for a day where a tutor has an online session shortly before/after an unchanged
   (carried) onsite session across a reconcile boundary; confirm the online session keeps a real room instead
   of flipping to remote purely because of which sessions happened to change that day.
</verification>

<success_criteria>
- [ ] Both tasks complete, one commit each, in the order written
- [ ] `npm test` passes; `npx tsc --noEmit` clean
- [ ] `grep -rn "blocksRoom" src/` returns nothing -- fully renamed to `holdsRoom` and widened to include `needs_review`
- [ ] `holdsRoom` gates `rowToExternalBlock`, `fixedTutorAssignmentsFrom`, and the unlock-retry filter (all 3 confirmed call sites)
- [ ] `AssignmentOptions.contextSessions` exists, is consumed only by `buildCenterRoomRequirementMap`, and never produces rows/occupancy/continuity
- [ ] `reconciliation.ts`'s `assignPending` passes `contextSessions: fixedRows.map(rowToContextSession)` on both call sites (initial + unlock-retry)
- [ ] All 9 original pinned tests in `reconciliation.test.ts` and all 42 original pinned tests in `assignment-engine.test.ts` are unaffected
- [ ] 7 new tests added (5 reconciliation-level, 2 engine-level) all pass with the exact assertions specified
- [ ] `docs/features/classroom-assignments.md` reflects both behaviors with grep-verified (not guessed) line numbers, scoped to the reconciliation section per `<planner_concerns>` item 2
- [ ] No `TODO`/`FIXME`/`HACK` comments introduced; all new exports (`ContextSession`) are named exports
</success_criteria>

<output>
After completion, create `.planning/quick/260811-evt-reconciler-carried-row-fixes-needs-revie/260811-evt-SUMMARY.md`
</output>
