---
quick_id: 260811-div
plan: 1
type: execute
wave: 1
depends_on: []
files_modified:
  - src/lib/classrooms/rooms.ts
  - src/lib/classrooms/assignment-engine.ts
  - src/lib/classrooms/reconciliation.ts
  - src/lib/classrooms/visualization.ts
  - src/components/class-assignments/class-assignments-workspace.tsx
  - src/lib/classrooms/__tests__/assignment-engine.test.ts
  - src/lib/classrooms/__tests__/reconciliation.test.ts
  - src/lib/classrooms/__tests__/visualization.test.ts
  - docs/features/classroom-assignments.md
autonomous: true
requirements:
  - RAS-PRIORITY-LOCK
  - STICKY-ROOM-CONTINUITY
  - RECONCILER-CONTINUITY-SEED
  - CHURN-METRIC
source_plan: /Users/kevinhsieh/.claude/plans/i-m-trying-to-figure-reactive-elephant.md
branch: feat/classroom-continuity
worktree: /Users/kevinhsieh/Developer/bgscheduler-classroom

must_haves:
  truths:
    - "Ras (Rasna Rajkitkul) is assigned Never Ever (TV) whenever it's available and not already claimed by a higher-priority overlap, beating Mandy's/Calvin's ordinary preferred-room claim on the same room"
    - "A tutor whose next session starts any amount of time after their last one keeps the same physical room when it's still free, instead of the engine re-rolling to a 'better' room every slot"
    - "An incremental (reconciled) run seeds new-session placement from rooms a tutor already holds that day via carried rows, not only from external Wise room blocks"
    - "Admin staff can see a per-run total room-switch count and a per-tutor room-switch badge in the Class Assignments workspace"
    - "Every pre-existing assertion in the full unit suite still passes unmodified, and the pinned continuity/protection boundary tests (15-min general continuity, 60-min online continuity, Mek's Iconic (TV) protection, the 5-tutor preferred-room protection family, single-session no-ops) are behaviorally untouched"
  artifacts:
    - path: "src/lib/classrooms/rooms.ts"
      provides: "Ras entries in both PREFERRED_BY_TUTOR and the priority-preferred-room map"
      contains: "Rasna (Ras) Rajkitkul"
    - path: "src/lib/classrooms/assignment-engine.ts"
      provides: "GENERAL_CONTINUITY_GAP_MINUTES, exported normalizedPhysicalRoom, FixedTutorAssignment, AssignmentOptions.fixedTutorAssignments, and the new sticky-room cascade step"
      exports: ["GENERAL_CONTINUITY_GAP_MINUTES", "normalizedPhysicalRoom", "FixedTutorAssignment"]
    - path: "src/lib/classrooms/reconciliation.ts"
      provides: "fixedTutorAssignmentsFrom helper wired into assignPending's engine options"
    - path: "src/lib/classrooms/visualization.ts"
      provides: "buildRoomChurnSummary(rows) -> { totalSwitches, switchesByTutor }"
      exports: ["buildRoomChurnSummary"]
    - path: "src/components/class-assignments/class-assignments-workspace.tsx"
      provides: "churnSummary memo, eight-tile run summary with a Room switches tile, per-tutor switch badge in the Tutor Schedule tab"
    - path: "docs/features/classroom-assignments.md"
      provides: "updated cascade/roster/reconciliation/UI prose and corrected test-count figures"
  key_links:
    - from: "src/lib/classrooms/assignment-engine.ts"
      to: "src/lib/classrooms/reconciliation.ts"
      via: "assignClassrooms reads options.fixedTutorAssignments through latestPriorRoomForTutor"
      pattern: "fixedTutorAssignments"
    - from: "src/lib/classrooms/reconciliation.ts"
      to: "src/lib/classrooms/assignment-engine.ts"
      via: "assignPending passes fixedTutorAssignmentsFrom(fixedRows) into assignClassrooms's options"
      pattern: "fixedTutorAssignmentsFrom"
    - from: "src/lib/classrooms/visualization.ts"
      to: "src/lib/classrooms/assignment-engine.ts"
      via: "buildRoomChurnSummary imports normalizedPhysicalRoom to compare physical rooms"
      pattern: "normalizedPhysicalRoom"
    - from: "src/components/class-assignments/class-assignments-workspace.tsx"
      to: "src/lib/classrooms/visualization.ts"
      via: "churnSummary = useMemo(() => buildRoomChurnSummary(rows), [rows])"
      pattern: "buildRoomChurnSummary\\(rows\\)"
---

<objective>
Transcribe the already-approved plan at `source_plan` into an executable GSD quick plan. Ship classroom
assignment continuity: Ras gets a priority lock on Never Ever (TV), the engine gains a same-day
"sticky room" continuity step so tutors stop bouncing rooms every slot, the reconciler seeds that
continuity from carried rows so incremental runs don't lose it, and the workspace surfaces a room-switch
churn metric so admin staff can see the effect. This is a transcription-plus-sequencing job, not a design
job -- every technical decision below was already made and approved by the user in `source_plan`.

Four pieces, one commit each, in the source plan's own build order (engine changes land WITH their test
changes in the same commit, per repo convention):
1. Ras priority lock in `rooms.ts`, plus the one existing test that must change shape because of it.
2. The sticky-room cascade step, the `FixedTutorAssignment` option, and the `GENERAL_CONTINUITY_GAP_MINUTES`
   / `normalizedPhysicalRoom` exports in `assignment-engine.ts`, plus its own new tests.
3. The reconciler continuity seed in `reconciliation.ts`, plus its own new tests.
4. The room-switch churn metric in `visualization.ts` and the workspace UI, plus its own new tests.

Purpose: stop teachers (Ras worst-case: 4 room changes in one Saturday) bouncing between rooms across a
day, without weakening any existing fail-closed/priority-claim/capacity rule.

Output: `rooms.ts` data change, `assignment-engine.ts` new cascade step + exports, `reconciliation.ts`
continuity seed, `visualization.ts` new pure helper, `class-assignments-workspace.tsx` UI surfacing, 16 new
test cases across 3 test files (1 existing test rewritten), and `docs/features/classroom-assignments.md`
updated to match.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@/Users/kevinhsieh/.claude/plans/i-m-trying-to-figure-reactive-elephant.md

Project conventions (already loaded as CLAUDE.md/AGENTS.md project instructions), called out because
they're binding for every task below: engine changes land WITH their test changes in the same commit
(never split code and its tests across commits); `ruleTrace` strings are asserted **verbatim** in tests --
copy them exactly, don't paraphrase; zero `TODO`/`FIXME`/`HACK` comments in non-test source; named exports
only (no default exports) in `src/lib` and `src/components`; 2-space indent, double quotes, semicolons in
`src/lib/**`/`src/app/**`; conventional commits scoped `feat(classrooms): ...` (confirmed against this
repo's own history -- `f2acbb5 feat(classrooms): send tutor schedule emails in morning automation` is the
most recent precedent for this exact scope).

All file paths below are relative to the worktree root `/Users/kevinhsieh/Developer/bgscheduler-classroom`
(this is the correct, linked worktree for this branch -- do not operate from any other worktree).
</context>

<interfaces>
<!-- Current exports relevant to this plan, extracted from the codebase as of this plan's authoring.
     Executor should use these directly -- no exploration needed. Verified line numbers are accurate as of
     HEAD on branch feat/classroom-continuity at plan time; each task's action section also gives exact
     before/after code blocks so line-number drift from earlier edits in the same task doesn't matter. -->

From `src/lib/classrooms/rooms.ts` (unchanged by this plan except two Map literals):
```typescript
export function normalizeTutorName(value: string | null | undefined): string;
export const PREFERRED_BY_TUTOR: Map<string, string>;              // ordinary preferred room, line 100
export const PREFERRED_ROOMS: Set<string>;                          // = new Set(PREFERRED_BY_TUTOR.values())
// PRIORITY_PREFERRED_ROOM_BY_TUTOR (line 152) is NOT exported -- only reachable via:
export function getPreferredRoom(tutorName: string): string | undefined;
export function getPriorityPreferredRoom(tutorName: string): string | undefined;
export function isGiftTutor(tutorName: string): boolean;
export function isKevinPriorityTutor(tutorName: string): boolean;   // true only for ROOM_THINK_OUTSIDE_THE_BOX
export const ROOM_JOY = "Joy (TV)";
export const ROOM_THINK_OUTSIDE_THE_BOX = "Think Outside the Box";
export const TV_REQUIRED_TUTORS: Set<string>;                       // already includes both Ras aliases
export const DEFAULT_CLASSROOM_ROOMS: ClassroomRoomDefinition[];
```

From `src/lib/classrooms/assignment-engine.ts` (this plan adds exports marked NEW):
```typescript
export const REMOTE_NO_ROOM_NEEDED = "REMOTE_NO_ROOM_NEEDED";
export const ONLINE_CENTER_CONNECTION_GAP_MINUTES = 60;
export const GENERAL_CONTINUITY_GAP_MINUTES = 15;                   // NEW (Task 2)
export interface AssignmentSession { groupId: string; tutorDisplayName: string; wiseSessionId: string;
  startMinute: number; endMinute: number; sessionType?: string | null; /* ...+more, unchanged */ }
export interface AssignmentResultRow extends AssignmentSession { assignedRoom: string;
  status: "assigned" | "needs_review" | "no_room" | "remote"; ruleTrace: string[]; /* +more, unchanged */ }
export interface ExternalRoomBlock { wiseSessionId: string; className: string | null; location: string;
  startMinute: number; endMinute: number; }
export interface FixedTutorAssignment {                              // NEW (Task 2)
  tutorDisplayName: string; startMinute: number; endMinute: number; room: string; }
export interface AssignmentOptions {
  externalRoomBlocks?: ExternalRoomBlock[];
  fixedTutorAssignments?: FixedTutorAssignment[];                    // NEW (Task 2)
}
export function normalizedPhysicalRoom(value: string): string;       // NEW: was private, now exported (Task 2)
export function assignClassrooms(
  sessions: AssignmentSession[],
  rooms: ClassroomRoomDefinition[],
  overrideBySessionId?: Map<string, string | null | undefined>,
  options?: AssignmentOptions,
): AssignmentResult;
```

From `src/lib/classrooms/reconciliation.ts` (unchanged shapes this plan's Task 3 reuses):
```typescript
export interface ReconciledAssignmentRow extends AssignmentResultRow {
  sourceRowId: string | null; changeType: "manual" | "carried" | "added" | "changed" | "rescheduled" | "moved";
  assignmentFingerprint: string; publishStatus: "not_published" | "skipped" | "success" | "failed"; }
export interface PreviousAssignmentRow extends AssignmentSession { id: string; assignedRoom: string;
  status: "assigned" | "needs_review" | "no_room" | "remote"; /* +more, unchanged */ }
export function reconcileClassroomAssignments(input: {
  sessions: AssignmentSession[]; previousRows: PreviousAssignmentRow[];
  rooms: ClassroomRoomDefinition[]; externalRoomBlocks?: ExternalRoomBlock[];
}): ReconciliationResult;
// Internal (not exported, but referenced by Task 3's new helper):
// function blocksRoom(row): boolean  -- status==="assigned" && assignedRoom not NO_ROOM_AVAILABLE/REMOTE_NO_ROOM_NEEDED
```

From `src/lib/classrooms/visualization.ts` (unchanged shapes this plan's Task 4 reuses):
```typescript
export interface ClassroomVisualizationRow { id: string; tutorDisplayName: string; startMinute: number;
  endMinute: number; assignedRoom: string; status: "assigned" | "needs_review" | "no_room" | "remote";
  /* +more, unchanged */ }
export function shouldSkipRoomOccupancy(row: ClassroomVisualizationRow): boolean; // true for remote rows
```

From `src/components/class-assignments/types.ts` (unchanged; `ClassroomRow` already satisfies
`ClassroomVisualizationRow` structurally -- the workspace already passes its `rows` into
`buildTimelineBounds(rows)` today, so no adapter is needed to also call `buildRoomChurnSummary(rows)`):
```typescript
export interface ClassroomRow { id: string; tutorDisplayName: string; startMinute: number; endMinute: number;
  assignedRoom: string; status: "assigned" | "needs_review" | "no_room" | "remote"; /* +more, unchanged */ }
```
</interfaces>

<tasks>

<task type="auto">
  <name>Task 1: Ras priority lock (rooms.ts) + Rasna test rewrite + new Ras-priority tests</name>
  <files>src/lib/classrooms/rooms.ts, src/lib/classrooms/__tests__/assignment-engine.test.ts, docs/features/classroom-assignments.md</files>
  <action>
**Why this is a self-contained commit:** every test added here exercises only the new `rooms.ts` data plus
*already-existing* engine mechanics (the priority-preferred-room pre-pass at `assignment-engine.ts:344-365`
and the ordinary-preferred-room pre-pass at `:367-379`, both untouched by this plan). None of these tests
depend on Task 2's sticky-room code, so this commit is fully green on its own before Task 2 exists.

**1. `src/lib/classrooms/rooms.ts` -- add Ras to both tutor-room maps (Kevin/Mek convention: both maps get
both identities, per D-noted user decision "Ras gets a priority lock on Never Ever (TV)"):**

Edit A -- `PREFERRED_BY_TUTOR`, insert next to the Mandy/Calvin cluster:

Find:
```typescript
    ["Calvin (Calvin) Lim Wen Quan", "Never Ever (TV)"],
    ["Calvin (Calvin) Lim Wen Quan Online", "Never Ever (TV)"],
    ["Narongsak (Sagotty) Sriwiran", "Relax (TV)"],
```
Replace with:
```typescript
    ["Calvin (Calvin) Lim Wen Quan", "Never Ever (TV)"],
    ["Calvin (Calvin) Lim Wen Quan Online", "Never Ever (TV)"],
    ["Rasna (Ras) Rajkitkul", "Never Ever (TV)"],
    ["Rasna (Ras) Rajkitkul Online", "Never Ever (TV)"],
    ["Narongsak (Sagotty) Sriwiran", "Relax (TV)"],
```

Edit B -- `PRIORITY_PREFERRED_ROOM_BY_TUTOR` (currently module-private, not exported -- leave it that way;
`getPriorityPreferredRoom` is the public accessor), insert after Mek:

Find:
```typescript
    ["Rachata (Mek) Sakpuaram", "Iconic (TV)"],
    ["Rachata (Mek) Sakpuaram Online", "Iconic (TV)"],
  ].flatMap(([name, room]) => tutorRuleAliases(name).map((alias) => [normalizeTutorName(alias), room])),
);

export function isGiftTutor(tutorName: string): boolean {
```
Replace with:
```typescript
    ["Rachata (Mek) Sakpuaram", "Iconic (TV)"],
    ["Rachata (Mek) Sakpuaram Online", "Iconic (TV)"],
    ["Rasna (Ras) Rajkitkul", "Never Ever (TV)"],
    ["Rasna (Ras) Rajkitkul Online", "Never Ever (TV)"],
  ].flatMap(([name, room]) => tutorRuleAliases(name).map((alias) => [normalizeTutorName(alias), room])),
);

export function isGiftTutor(tutorName: string): boolean {
```

No engine change needed for the priority lock itself: pre-pass 2 (priority-preferred rooms,
`assignment-engine.ts:344-365`) already stakes Ras's claim before pre-pass 3 (ordinary preferred rooms,
`:367-379`) considers Mandy's/Calvin's claim on the same room; on overlap Mandy/Calvin fall through to the
general room pool for that slot only. The trace string this produces is the existing **generic** branch at
`:451` (`` `assigned priority preferred room: ${priorityPreferredRoom}` ``) -- NOT the Kevin-specific branch
at `:449` (that one only fires for `ROOM_THINK_OUTSIDE_THE_BOX`). `tutorRuleAliases` (`rooms.ts:52-60`)
auto-covers the "Ras"/"Rasna" nicknames used in tests below; there is no alias collision with any other
tutor in either map.

**2. `src/lib/classrooms/__tests__/assignment-engine.test.ts` -- rewrite the now-inaccurate Rasna test:**

Because Ras now has a `preferredRoom`, the existing test's `preferredRoom: null` assertion is no longer
true. Rewrite it (same behavior under test -- Ras still needs a TV room and still isn't pinned to one exact
room when her preferred room isn't in the catalog -- just a different assertion on `preferredRoom`):

Find:
```typescript
  it("requires a TV-capable room for Rasna without pinning her to one exact room", () => {
    const result = assignClassrooms(
      [session({ tutorDisplayName: "Rasna", studentCount: 1 })],
      roomsFor("Focus", "Iconic (TV)"),
    );

    expect(result.rows[0].needsTv).toBe(true);
    expect(result.rows[0].preferredRoom).toBeNull();
    expect(result.rows[0].assignedRoom).toBe("Iconic (TV)");
  });
```
Replace with:
```typescript
  it("falls back to another TV room when Never Ever (TV) is not in the catalog", () => {
    const result = assignClassrooms(
      [session({ tutorDisplayName: "Rasna", studentCount: 1 })],
      roomsFor("Focus", "Iconic (TV)"),
    );

    expect(result.rows[0].needsTv).toBe(true);
    expect(result.rows[0].preferredRoom).toBe("Never Ever (TV)");
    expect(result.rows[0].assignedRoom).toBe("Iconic (TV)");
  });
```
(Reasoning, so you don't need to re-derive it: with catalog `["Focus", "Iconic (TV)"]`, Ras's priority and
ordinary preferred room "Never Ever (TV)" isn't in the catalog so both pre-pass claims fail
`roomPassesConstraints` (room lookup is `undefined`); "Focus" fails `roomOk` because Ras needs a TV room and
Focus has none; the only surviving candidate for `pickBestRoom` is "Iconic (TV)".)

**3. Same test file -- add 4 new tests.** Insert them immediately before the just-rewritten test (anchor on
its new title so this edit doesn't depend on line numbers):

Find:
```typescript
  it("falls back to another TV room when Never Ever (TV) is not in the catalog", () => {
```
Replace with:
```typescript
  it("assigns Ras to Never Ever (TV) when available", () => {
    const result = assignClassrooms([
      session({ tutorDisplayName: "Rasna (Ras) Rajkitkul" }),
    ], DEFAULT_CLASSROOM_ROOMS);

    expect(result.rows[0].preferredRoom).toBe("Never Ever (TV)");
    expect(result.rows[0].assignedRoom).toBe("Never Ever (TV)");
    expect(result.rows[0].ruleTrace).toContain("assigned priority preferred room: Never Ever (TV)");
  });

  it("gives Ras Never Ever (TV) over overlapping Mandy and Calvin sessions", () => {
    const result = assignClassrooms([
      session({
        groupId: "mandy",
        wiseSessionId: "mandy",
        tutorDisplayName: "Mandy (Mandy) Boontanrart",
        startMinute: 9 * 60,
        endMinute: 10 * 60,
      }),
      session({
        groupId: "calvin",
        wiseSessionId: "calvin",
        tutorDisplayName: "Calvin (Calvin) Lim Wen Quan",
        startMinute: 9 * 60,
        endMinute: 10 * 60,
      }),
      session({
        groupId: "ras",
        wiseSessionId: "ras",
        tutorDisplayName: "Rasna (Ras) Rajkitkul",
        startMinute: 9 * 60,
        endMinute: 10 * 60,
      }),
    ], DEFAULT_CLASSROOM_ROOMS);

    const ras = result.rows.find((row) => row.wiseSessionId === "ras")!;
    const mandy = result.rows.find((row) => row.wiseSessionId === "mandy")!;
    const calvin = result.rows.find((row) => row.wiseSessionId === "calvin")!;
    expect(ras.assignedRoom).toBe("Never Ever (TV)");
    expect(mandy.assignedRoom).not.toBe("Never Ever (TV)");
    expect(calvin.assignedRoom).not.toBe("Never Ever (TV)");
  });

  it("still assigns Mandy to Never Ever (TV) when Ras is absent", () => {
    const result = assignClassrooms([
      session({ tutorDisplayName: "Mandy (Mandy) Boontanrart" }),
    ], DEFAULT_CLASSROOM_ROOMS);

    expect(result.rows[0].preferredRoom).toBe("Never Ever (TV)");
    expect(result.rows[0].assignedRoom).toBe("Never Ever (TV)");
  });

  it("protects Ras's Never Ever (TV) priority from an earlier overlapping generic session", () => {
    const result = assignClassrooms(
      [
        session({
          wiseSessionId: "generic",
          tutorDisplayName: "Generic Tutor",
          startMinute: 9 * 60,
          endMinute: 11 * 60,
        }),
        session({
          wiseSessionId: "ras",
          tutorDisplayName: "Ras",
          startMinute: 10 * 60,
          endMinute: 11 * 60,
        }),
      ],
      roomsFor("Never Ever (TV)", "Remember (TV)"),
    );

    const generic = result.rows.find((row) => row.wiseSessionId === "generic")!;
    const ras = result.rows.find((row) => row.wiseSessionId === "ras")!;
    expect(generic.assignedRoom).not.toBe("Never Ever (TV)");
    expect(ras.preferredRoom).toBe("Never Ever (TV)");
    expect(ras.assignedRoom).toBe("Never Ever (TV)");
  });

  it("falls back to another TV room when Never Ever (TV) is not in the catalog", () => {
```
(No new imports needed -- `DEFAULT_CLASSROOM_ROOMS`, `roomsFor`, and `session` are already imported/defined
in this file.)

**4. `docs/features/classroom-assignments.md` -- two edits:**

Edit A (roster mention, line ~132 area -- append a sentence to the existing "Priority claims are reserved
before the main pass" paragraph):

Find:
```
**Priority claims are reserved before the main pass.** Three pre-passes stake out `protectedClaims` for valid overrides, then priority-preferred rooms, then ordinary preferred rooms (`assignment-engine.ts:332`–`:379`). Without this, an earlier-starting generic session could take a room that a later high-priority tutor is pinned to. The main loop then only honors a preferred/priority room if that session actually won its claim (`:443`, `:487`).
```
Replace with:
```
**Priority claims are reserved before the main pass.** Three pre-passes stake out `protectedClaims` for valid overrides, then priority-preferred rooms, then ordinary preferred rooms (`assignment-engine.ts:332`–`:379`). Without this, an earlier-starting generic session could take a room that a later high-priority tutor is pinned to. The main loop then only honors a preferred/priority room if that session actually won its claim (`:443`, `:487`). Because priority-preferred claims are staked before ordinary preferred claims, Ras's priority lock on `Never Ever (TV)` beats an overlapping Mandy or Calvin session -- both of whom hold it only as an *ordinary* preferred room -- and Mandy/Calvin fall back to the general room pool for that slot only.
```

Edit B (roster mention, line ~190 area -- Open Questions "Hardcoded rosters" bullet):

Find:
```
named individuals are baked into rule branches (Gift→Joy, Kevin/Mek priority rooms).
```
Replace with:
```
named individuals are baked into rule branches (Gift→Joy, Kevin/Mek/Ras priority rooms).
```
(Leave the rest of that bullet's sentence -- the question about moving rosters to DB config -- unchanged.)

Edit C (test-count bump -- this task adds 4 new `it()` declarations to `assignment-engine.test.ts`; the
rewrite in step 2 does not change the declaration count):

Find:
```
Sixteen test files, 143 test declarations (147 executed cases once the one parameterized block expands):
```
Replace with:
```
Sixteen test files, 147 test declarations (151 executed cases once the one parameterized block expands):
```

Find:
```
- **`src/lib/classrooms/__tests__/assignment-engine.test.ts`** (32 declarations → 36 executed cases; one `it.each` covers 5 preferred-room tutors at `:350`–`:380`)
```
Replace with:
```
- **`src/lib/classrooms/__tests__/assignment-engine.test.ts`** (36 declarations → 40 executed cases; one `it.each` covers 5 preferred-room tutors at `:350`–`:380`)
```
(Keep the rest of that bullet's sentence -- the coverage-gap discussion about `override_room_unavailable`
-- exactly as-is; it's still accurate. The `:350`–`:380` citation is unaffected because this task's new
tests are inserted well after that range.)
  </action>
  <verify>
    <automated>npx vitest run src/lib/classrooms</automated>
  </verify>
  <done>rooms.ts has Ras in both PREFERRED_BY_TUTOR and PRIORITY_PREFERRED_ROOM_BY_TUTOR with Online variants; the Rasna test is rewritten and 4 new Ras-priority tests pass with the exact ruleTrace strings shown; docs reflect the Ras roster addition and the bumped assignment-engine.test.ts counts; `npx vitest run src/lib/classrooms` is green; one commit.</done>
</task>

<task type="auto">
  <name>Task 2: Same-day sticky-room continuity + FixedTutorAssignment option (assignment-engine.ts) + engine tests</name>
  <files>src/lib/classrooms/assignment-engine.ts, src/lib/classrooms/__tests__/assignment-engine.test.ts, docs/features/classroom-assignments.md</files>
  <action>
**1. `src/lib/classrooms/assignment-engine.ts` -- five edits, in this order:**

Edit A -- new constant next to the existing gap constant:

Find:
```typescript
export const ONLINE_CENTER_CONNECTION_GAP_MINUTES = 60;
```
Replace with:
```typescript
export const ONLINE_CENTER_CONNECTION_GAP_MINUTES = 60;
export const GENERAL_CONTINUITY_GAP_MINUTES = 15;
```

Edit B -- export the existing private helper (needed by Task 4's churn metric):

Find:
```typescript
function normalizedPhysicalRoom(value: string): string {
  return value.trim().toLowerCase().replace(/\s+\(tv\)$/, "");
}
```
Replace with:
```typescript
export function normalizedPhysicalRoom(value: string): string {
  return value.trim().toLowerCase().replace(/\s+\(tv\)$/, "");
}
```

Edit C -- new interface + extend `AssignmentOptions` (needed by Task 3):

Find:
```typescript
export interface AssignmentOptions {
  externalRoomBlocks?: ExternalRoomBlock[];
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

export interface AssignmentOptions {
  externalRoomBlocks?: ExternalRoomBlock[];
  fixedTutorAssignments?: FixedTutorAssignment[];
}
```

Edit D -- build `fixedByTutor` and add the `latestPriorRoomForTutor` helper, right after `lastByTutor` is
declared inside `assignClassrooms`:

Find:
```typescript
  const lastByTutor = new Map<string, { endMinute: number; room: string }>();
  const centerRoomRequiredBySessionId = buildCenterRoomRequirementMap(sessions);
```
Replace with:
```typescript
  const lastByTutor = new Map<string, { endMinute: number; room: string }>();

  const fixedByTutor = new Map<string, FixedTutorAssignment[]>();
  for (const fixed of options.fixedTutorAssignments ?? []) {
    const tutorNorm = normalizeTutorName(fixed.tutorDisplayName);
    const list = fixedByTutor.get(tutorNorm) ?? [];
    list.push(fixed);
    fixedByTutor.set(tutorNorm, list);
  }
  for (const list of fixedByTutor.values()) {
    list.sort((a, b) => a.endMinute - b.endMinute);
  }

  const latestPriorRoomForTutor = (
    tutorNorm: string,
    startMinute: number,
  ): { endMinute: number; room: string } | null => {
    const dynamic = lastByTutor.get(tutorNorm) ?? null;
    const fixedForTutor = fixedByTutor.get(tutorNorm) ?? [];
    let latestFixed: { endMinute: number; room: string } | null = null;
    for (const entry of fixedForTutor) {
      if (entry.endMinute <= startMinute) latestFixed = entry;
    }
    if (!dynamic) return latestFixed;
    if (!latestFixed) return dynamic;
    return latestFixed.endMinute > dynamic.endMinute
      ? { endMinute: latestFixed.endMinute, room: latestFixed.room }
      : dynamic;
  };

  const centerRoomRequiredBySessionId = buildCenterRoomRequirementMap(sessions);
```
Semantics (must match exactly, this is the one delicate part of the whole plan): the dynamic
(`lastByTutor`) branch is read **unfiltered** -- it preserves current behavior exactly, since a session
already recorded there was already processed in this same run. The fixed-list branch **must** filter to
`endMinute <= startMinute` -- the fixed list can span the whole day (it will, once Task 3 wires in a full
day's carried rows), so an afternoon carried room must never shadow the correct morning room for an
early session. On a tie, dynamic wins.

Edit E -- replace the raw `lastByTutor.get` read inside the **online continuity** step (this one keeps its
existing `< ONLINE_CENTER_CONNECTION_GAP_MINUTES` gap check untouched -- only the lookup call changes):

Find:
```typescript
    if (!assignedRoom && isOnlineSession(session.sessionType)) {
      const last = lastByTutor.get(tutorNorm);
      if (last) {
        const gap = session.startMinute - last.endMinute;
        if (gap >= 0 && gap < ONLINE_CENTER_CONNECTION_GAP_MINUTES && roomOk(last.room) && roomAvailable(last.room)) {
```
Replace with:
```typescript
    if (!assignedRoom && isOnlineSession(session.sessionType)) {
      const last = latestPriorRoomForTutor(tutorNorm, session.startMinute);
      if (last) {
        const gap = session.startMinute - last.endMinute;
        if (gap >= 0 && gap < ONLINE_CENTER_CONNECTION_GAP_MINUTES && roomOk(last.room) && roomAvailable(last.room)) {
```

Edit F -- the main edit: swap the **general continuity** step's lookup + hardcoded gap literal, and insert
the **new sticky-room step** immediately after the existing preferred-room block and before the existing
online-only-room block. This one old_string spans both existing blocks plus the start of the next one, so
the insertion point is unambiguous:

Find:
```typescript
    if (!assignedRoom) {
      const last = lastByTutor.get(tutorNorm);
      if (last) {
        const gap = session.startMinute - last.endMinute;
        if (gap >= 0 && gap <= 15 && roomOk(last.room) && roomAvailable(last.room)) {
          if (!(last.room === ROOM_JOY && !isGift)) {
            assignedRoom = last.room;
            ruleTrace.push(`assigned by continuity: ${last.room}`);
          }
        }
      }
    }

    if (
      !assignedRoom &&
      preferredRoom &&
      preferredRoomClaimBySessionId.has(session.wiseSessionId) &&
      roomOk(preferredRoom) &&
      roomAvailable(preferredRoom)
    ) {
      if (!(preferredRoom === ROOM_JOY && !isGift)) {
        assignedRoom = preferredRoom;
        ruleTrace.push(`assigned preferred room: ${preferredRoom}`);
      }
    }

    if (!assignedRoom && isOnlineSession(session.sessionType)) {
      const picked = pickRoom(activeRooms.filter((room) => room.category === "online_only"));
```
Replace with:
```typescript
    if (!assignedRoom) {
      const last = latestPriorRoomForTutor(tutorNorm, session.startMinute);
      if (last) {
        const gap = session.startMinute - last.endMinute;
        if (gap >= 0 && gap <= GENERAL_CONTINUITY_GAP_MINUTES && roomOk(last.room) && roomAvailable(last.room)) {
          if (!(last.room === ROOM_JOY && !isGift)) {
            assignedRoom = last.room;
            ruleTrace.push(`assigned by continuity: ${last.room}`);
          }
        }
      }
    }

    if (
      !assignedRoom &&
      preferredRoom &&
      preferredRoomClaimBySessionId.has(session.wiseSessionId) &&
      roomOk(preferredRoom) &&
      roomAvailable(preferredRoom)
    ) {
      if (!(preferredRoom === ROOM_JOY && !isGift)) {
        assignedRoom = preferredRoom;
        ruleTrace.push(`assigned preferred room: ${preferredRoom}`);
      }
    }

    if (!assignedRoom) {
      const last = latestPriorRoomForTutor(tutorNorm, session.startMinute);
      if (last) {
        const gap = session.startMinute - last.endMinute;
        if (gap >= 0 && roomOk(last.room) && roomAvailable(last.room) && !(last.room === ROOM_JOY && !isGift)) {
          assignedRoom = last.room;
          ruleTrace.push(`assigned by sticky room: ${last.room}`);
        }
      }
    }

    if (!assignedRoom && isOnlineSession(session.sessionType)) {
      const picked = pickRoom(activeRooms.filter((room) => room.category === "online_only"));
```
Placement rationale (already validated by user): after preferred so a displaced preferred tutor *returns*
to their preferred room rather than sticking to a fallback; before `pickBestRoom` so generic tutors stop
re-rolling every slot. Sticky accepts **any** non-negative gap (same run = same day), unlike general
continuity's ≤15-min cap. `roomAvailable` checks both `occupancy` and `protectedClaims`, so sticky can never
steal an override/priority/preferred claim. Joy is excluded for non-Gift tutors, matching steps 6/7/11
elsewhere in this same cascade. The write to `lastByTutor` at the end of the function (unchanged, `` `
lastByTutor.set(tutorNorm, { endMinute: session.endMinute, room: assignedRoom }); ` ``) needs no change.

**2. Same test file -- append 5 new tests at the very end of the `describe("assignClassrooms", ...)` block**
(anchor on the existing last test so this doesn't depend on line numbers; by the time this task runs,
Task 1's 4 new tests + rewrite already exist earlier in the file, which is fine -- this anchor is at the
very end regardless):

Find:
```typescript
  it("marks no room when constraints cannot be met", () => {
    const result = assignClassrooms([
      session({ studentCount: 9, classType: "GROUP" }),
    ], DEFAULT_CLASSROOM_ROOMS);

    expect(result.rows[0].assignedRoom).toBe(NO_ROOM_AVAILABLE);
    expect(result.rows[0].status).toBe("no_room");
  });
});
```
Replace with:
```typescript
  it("marks no room when constraints cannot be met", () => {
    const result = assignClassrooms([
      session({ studentCount: 9, classType: "GROUP" }),
    ], DEFAULT_CLASSROOM_ROOMS);

    expect(result.rows[0].assignedRoom).toBe(NO_ROOM_AVAILABLE);
    expect(result.rows[0].status).toBe("no_room");
  });

  it("keeps a tutor in their sticky room across a 30-minute gap instead of moving to a freed higher-priority room", () => {
    const result = assignClassrooms([
      session({
        wiseSessionId: "blocker",
        tutorDisplayName: "Blocker Tutor",
        startMinute: 9 * 60,
        endMinute: 10 * 60,
      }),
      session({
        wiseSessionId: "first",
        tutorDisplayName: "Generic Tutor",
        startMinute: 9 * 60,
        endMinute: 10 * 60,
      }),
      session({
        wiseSessionId: "second",
        tutorDisplayName: "Generic Tutor",
        startMinute: 10 * 60 + 30,
        endMinute: 11 * 60 + 30,
      }),
    ], roomsFor(ROOM_THINK_OUTSIDE_THE_BOX, "Hakuna Matata"));

    const first = result.rows.find((row) => row.wiseSessionId === "first")!;
    const second = result.rows.find((row) => row.wiseSessionId === "second")!;
    expect(first.assignedRoom).toBe("Hakuna Matata");
    expect(second.assignedRoom).toBe("Hakuna Matata");
    expect(second.ruleTrace).toContain("assigned by sticky room: Hakuna Matata");
  });

  it("does not let a sticky claim steal Mek's protected Iconic (TV) claim", () => {
    const result = assignClassrooms(
      [
        session({
          wiseSessionId: "generic-first",
          tutorDisplayName: "Generic Tutor",
          startMinute: 9 * 60,
          endMinute: 10 * 60,
        }),
        session({
          wiseSessionId: "generic-second",
          tutorDisplayName: "Generic Tutor",
          startMinute: 10 * 60 + 20,
          endMinute: 11 * 60 + 20,
        }),
        session({
          wiseSessionId: "mek",
          tutorDisplayName: "Rachata (Mek) Sakpuaram",
          startMinute: 10 * 60 + 30,
          endMinute: 11 * 60 + 30,
        }),
      ],
      roomsFor("Iconic (TV)", "Remember (TV)"),
    );

    const genericFirst = result.rows.find((row) => row.wiseSessionId === "generic-first")!;
    const genericSecond = result.rows.find((row) => row.wiseSessionId === "generic-second")!;
    const mek = result.rows.find((row) => row.wiseSessionId === "mek")!;
    expect(genericFirst.assignedRoom).toBe("Iconic (TV)");
    expect(genericSecond.assignedRoom).not.toBe("Iconic (TV)");
    expect(genericSecond.ruleTrace).not.toContain("assigned by sticky room: Iconic (TV)");
    expect(mek.assignedRoom).toBe("Iconic (TV)");
  });

  it("lets a displaced preferred tutor (Ek) return to OMG on their next session instead of sticking to the fallback room", () => {
    const result = assignClassrooms(
      [
        session({
          wiseSessionId: "override-blocker",
          tutorDisplayName: "Tutor Two",
          groupId: "blocker",
          startMinute: 9 * 60,
          endMinute: 10 * 60,
        }),
        session({
          wiseSessionId: "ek-first",
          tutorDisplayName: "Apivit (Ek) Sirithana",
          startMinute: 9 * 60,
          endMinute: 10 * 60,
        }),
        session({
          wiseSessionId: "ek-second",
          tutorDisplayName: "Apivit (Ek) Sirithana",
          startMinute: 10 * 60 + 30,
          endMinute: 11 * 60 + 30,
        }),
      ],
      roomsFor("OMG", "Cool"),
      new Map([["override-blocker", "OMG"]]),
    );

    const ekFirst = result.rows.find((row) => row.wiseSessionId === "ek-first")!;
    const ekSecond = result.rows.find((row) => row.wiseSessionId === "ek-second")!;
    expect(ekFirst.assignedRoom).not.toBe("OMG");
    expect(ekSecond.preferredRoom).toBe("OMG");
    expect(ekSecond.assignedRoom).toBe("OMG");
    expect(ekSecond.ruleTrace).toContain("assigned preferred room: OMG");
  });

  it("uses general continuity (not sticky) when the gap is 15 minutes or less", () => {
    const result = assignClassrooms([
      session({
        wiseSessionId: "first",
        tutorDisplayName: "Tutor One",
        startMinute: 9 * 60,
        endMinute: 10 * 60,
      }),
      session({
        wiseSessionId: "second",
        tutorDisplayName: "Tutor One",
        startMinute: 10 * 60 + 15,
        endMinute: 11 * 60,
      }),
    ], DEFAULT_CLASSROOM_ROOMS);

    const first = result.rows.find((row) => row.wiseSessionId === "first")!;
    const second = result.rows.find((row) => row.wiseSessionId === "second")!;
    expect(second.ruleTrace).toContain(`assigned by continuity: ${first.assignedRoom}`);
    expect(second.ruleTrace.some((trace) => trace.startsWith("assigned by sticky room:"))).toBe(false);
  });

  it("keeps one tutor in the same room across three sessions with mixed gaps including 90 minutes", () => {
    const result = assignClassrooms([
      session({
        wiseSessionId: "morning",
        tutorDisplayName: "Generic Tutor",
        startMinute: 9 * 60,
        endMinute: 10 * 60,
      }),
      session({
        wiseSessionId: "midday",
        tutorDisplayName: "Generic Tutor",
        startMinute: 10 * 60 + 15,
        endMinute: 11 * 60,
      }),
      session({
        wiseSessionId: "afternoon",
        tutorDisplayName: "Generic Tutor",
        startMinute: 12 * 60 + 30,
        endMinute: 13 * 60 + 30,
      }),
    ], DEFAULT_CLASSROOM_ROOMS);

    const morning = result.rows.find((row) => row.wiseSessionId === "morning")!;
    const midday = result.rows.find((row) => row.wiseSessionId === "midday")!;
    const afternoon = result.rows.find((row) => row.wiseSessionId === "afternoon")!;
    expect(morning.assignedRoom).toBe(ROOM_THINK_OUTSIDE_THE_BOX);
    expect(midday.assignedRoom).toBe(ROOM_THINK_OUTSIDE_THE_BOX);
    expect(afternoon.assignedRoom).toBe(ROOM_THINK_OUTSIDE_THE_BOX);
    expect(midday.ruleTrace).toContain(`assigned by continuity: ${ROOM_THINK_OUTSIDE_THE_BOX}`);
    expect(afternoon.ruleTrace).toContain(`assigned by sticky room: ${ROOM_THINK_OUTSIDE_THE_BOX}`);
  });
});
```
Every scenario above was hand-traced against the exact cascade order and pre-pass mechanics before being
written into this plan -- you should not need to redesign any of them, only implement and run them. If any
assertion doesn't hold, that's a signal the engine edit deviated from Edits A-F above, not that the test
needs adjusting.

**3. `docs/features/classroom-assignments.md` -- two edits:**

Edit A (cascade sentence -- only the first sentence of the "Room selection cascade" paragraph changes; the
rest of that paragraph, about room priority scoring and the untested tier boundary, is unrelated and stays
as-is):

Find:
```
**Room selection cascade** (`assignment-engine.ts:417`–`:542`), first match wins: remote-online short-circuit → valid override → priority preferred room → online continuity (previous room reused when the gap is under 60 min) → Gift hard-pinned to `Joy (TV)` → general continuity (gap ≤ 15 min, and never Joy for a non-Gift tutor) → preferred room → online-only room → priority-scored standard room → any standard room → Joy as last-resort for non-Gift → overflow-only → `NO_ROOM_AVAILABLE`.
```
Replace with (before writing this, run `grep -n '"no room available"' src/lib/classrooms/assignment-engine.ts`
against your already-edited file and use that line number as the range's end -- your earlier edits in this
task shift it well below the original `:542`, so do not guess; the range's start, `:417`, is unaffected
since all of this task's insertions land after it):
```
**Room selection cascade** (`assignment-engine.ts:417`–`:<verified end line>`), first match wins: remote-online short-circuit → valid override → priority preferred room → online continuity (previous room reused when the gap is under 60 min) → Gift hard-pinned to `Joy (TV)` → general continuity (gap ≤ `GENERAL_CONTINUITY_GAP_MINUTES` = 15 min, and never Joy for a non-Gift tutor) → preferred room → same-day sticky room (any gap size, reuses the tutor's most recently held room -- including one seeded from a reconciled run's carried rows -- when it's still free, and never Joy for a non-Gift tutor) → online-only room → priority-scored standard room → any standard room → Joy as last-resort for non-Gift → overflow-only → `NO_ROOM_AVAILABLE`.
```

Edit B (test-count bump -- this task adds 5 new `it()` declarations to `assignment-engine.test.ts`, on top
of Task 1's 4):

Find:
```
Sixteen test files, 147 test declarations (151 executed cases once the one parameterized block expands):
```
Replace with:
```
Sixteen test files, 152 test declarations (156 executed cases once the one parameterized block expands):
```

Find:
```
- **`src/lib/classrooms/__tests__/assignment-engine.test.ts`** (36 declarations → 40 executed cases; one `it.each` covers 5 preferred-room tutors at `:350`–`:380`)
```
Replace with:
```
- **`src/lib/classrooms/__tests__/assignment-engine.test.ts`** (41 declarations → 45 executed cases; one `it.each` covers 5 preferred-room tutors at `:350`–`:380`)
```
  </action>
  <verify>
    <automated>npx vitest run src/lib/classrooms</automated>
  </verify>
  <done>assignment-engine.ts exports GENERAL_CONTINUITY_GAP_MINUTES, normalizedPhysicalRoom, and FixedTutorAssignment; AssignmentOptions accepts fixedTutorAssignments; the sticky-room step sits between preferred-room and online-only in the cascade; all 5 new tests pass with the exact ruleTrace strings shown; the 4 pinned continuity-boundary tests (:170/:191/:212 online-gap boundary, :241 online-same-room, :563 15-min continuity) are unaffected; docs cascade sentence and test counts updated; `npx vitest run src/lib/classrooms` is green; one commit.</done>
</task>

<task type="auto">
  <name>Task 3: Reconciler continuity seed (reconciliation.ts) + reconciliation tests</name>
  <files>src/lib/classrooms/reconciliation.ts, src/lib/classrooms/__tests__/reconciliation.test.ts, docs/features/classroom-assignments.md</files>
  <action>
**1. `src/lib/classrooms/reconciliation.ts` -- three edits:**

Edit A -- import the new type from Task 2:

Find:
```typescript
import {
  assignClassrooms,
  REMOTE_NO_ROOM_NEEDED,
  type AssignmentResultRow,
  type AssignmentSession,
  type ExternalRoomBlock,
} from "./assignment-engine";
```
Replace with:
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

Edit B -- new helper next to `fixedBlocks`, deliberately reusing the existing `blocksRoom` predicate so
"this row occupies a physical room" stays a single definition shared by both the external-block path and
the new continuity-seed path:

Find:
```typescript
function fixedBlocks(rows: ReconciledAssignmentRow[], externalRoomBlocks: ExternalRoomBlock[]): ExternalRoomBlock[] {
  return [
    ...externalRoomBlocks,
    ...rows.map(rowToExternalBlock).filter((block): block is ExternalRoomBlock => Boolean(block)),
  ];
}
```
Replace with:
```typescript
function fixedBlocks(rows: ReconciledAssignmentRow[], externalRoomBlocks: ExternalRoomBlock[]): ExternalRoomBlock[] {
  return [
    ...externalRoomBlocks,
    ...rows.map(rowToExternalBlock).filter((block): block is ExternalRoomBlock => Boolean(block)),
  ];
}

function fixedTutorAssignmentsFrom(rows: ReconciledAssignmentRow[]): FixedTutorAssignment[] {
  return rows
    .filter((row) => blocksRoom(row))
    .map((row) => ({
      tutorDisplayName: row.tutorDisplayName,
      startMinute: row.startMinute,
      endMinute: row.endMinute,
      room: row.assignedRoom,
    }));
}
```

Edit C -- wire it into `assignPending`'s engine options:

Find:
```typescript
  const overrides = makeOverrideMap(input.previousRows);
  const assignPending = (
    sessions: AssignmentSession[],
    fixedRows: ReconciledAssignmentRow[],
  ): AssignmentResultRow[] => assignClassrooms(
    sessions,
    input.rooms,
    overrides,
    { externalRoomBlocks: fixedBlocks(fixedRows, externalRoomBlocks) },
  ).rows;
```
Replace with:
```typescript
  const overrides = makeOverrideMap(input.previousRows);
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
`assignPending` is called twice in this file (the initial pass, and the unlock-retry pass inside the
`failedDynamicRows.length > 0` branch) -- both go through this same function definition, so both
automatically pick up the continuity seed with no further change. No changes needed to `data.ts` or
`morning-automation.ts` -- this is entirely self-contained inside the engine invocation.

**2. `src/lib/classrooms/__tests__/reconciliation.test.ts` -- append 2 new tests inside the existing
`describe("reconcileClassroomAssignments", ...)` block, right after the last existing test:**

Find:
```typescript
  it("keeps remote carried rows as remote/no-room-needed", () => {
    const current = session({ sessionType: "SCHEDULED" });
    const result = reconcileClassroomAssignments({
      sessions: [current],
      previousRows: [
        previous({
          sessionType: "SCHEDULED",
          assignedRoom: REMOTE_NO_ROOM_NEEDED,
          status: "remote",
        }),
      ],
      rooms,
    });

    expect(result.rows[0]).toMatchObject({
      assignedRoom: REMOTE_NO_ROOM_NEEDED,
      status: "remote",
      changeType: "carried",
    });
  });
});
```
Replace with:
```typescript
  it("keeps remote carried rows as remote/no-room-needed", () => {
    const current = session({ sessionType: "SCHEDULED" });
    const result = reconcileClassroomAssignments({
      sessions: [current],
      previousRows: [
        previous({
          sessionType: "SCHEDULED",
          assignedRoom: REMOTE_NO_ROOM_NEEDED,
          status: "remote",
        }),
      ],
      rooms,
    });

    expect(result.rows[0]).toMatchObject({
      assignedRoom: REMOTE_NO_ROOM_NEEDED,
      status: "remote",
      changeType: "carried",
    });
  });

  it("seeds same-day continuity from a carried row so a new session lands in the tutor's held room, not the sort-order-first room", () => {
    const existingOverrides = {
      wiseSessionId: "existing",
      tutorDisplayName: "Tutor One",
      groupId: "group-1",
      startMinute: 9 * 60,
      endMinute: 10 * 60,
    };
    const carried = previous({ ...existingOverrides, assignedRoom: "Room B" });
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

    const existingRow = result.rows.find((row) => row.wiseSessionId === "existing")!;
    const newRow = result.rows.find((row) => row.wiseSessionId === "new")!;
    expect(existingRow.changeType).toBe("carried");
    expect(existingRow.assignedRoom).toBe("Room B");
    expect(newRow.assignedRoom).toBe("Room B");
    expect(newRow.ruleTrace).toContain("assigned by sticky room: Room B");
  });

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
(No new imports needed -- `REMOTE_NO_ROOM_NEEDED`, `session`, and `previous` are already
imported/defined in this file. Both new tests rely on `rooms` = `[Room A (sortOrder 1), Room B (sortOrder
2)]`, already declared at the top of this file, and on the `previous()`/`session()` helpers producing
matching fingerprints when given the same overrides, exactly like the file's existing "carries unchanged
rows forward" test.)

**3. `docs/features/classroom-assignments.md` -- two edits:**

Edit A (reconciliation prose -- add the continuity-seed mention; this paragraph cites several
`reconciliation.ts` line numbers that shift because of Edit B above, so verify them before writing):

Find:
```
**Reconciliation optimizes for minimal moves.** The incremental run fingerprints each session over 17 identity/time/content fields (`src/lib/classrooms/reconciliation.ts:66`, `:91`). Identical sessions are *carried* — same room, same publish state — and only the rest are re-assigned against the carried rows treated as fixed blocks (`:256`, `:308`). If a new session cannot fit anywhere, the engine unlocks only the carried rows that overlap it and are not override-pinned, then retries (`:322`–`:344`). Rows whose room changed anyway are labeled `moved` and have their publish state reset (`:346`–`:384`); disappeared sessions emit a `canceled` event but nothing is written back to Wise.
```
Replace with (run `grep -n 'export function reconcileClassroomAssignments\|const assignPending\|if (failedDynamicRows.length > 0)\|finalRows.sort' src/lib/classrooms/reconciliation.ts` against your already-edited
file to get the correct replacements for `:256`, `:308`, `:322`–`:344`, and `:346`–`:384` -- the new
`fixedTutorAssignmentsFrom` helper you just added shifts everything below it; `:66`/`:91` are before your
edit point and stay correct as-is):
```
**Reconciliation optimizes for minimal moves.** The incremental run fingerprints each session over 17 identity/time/content fields (`src/lib/classrooms/reconciliation.ts:66`, `:91`). Identical sessions are *carried* — same room, same publish state — and only the rest are re-assigned against the carried rows treated as fixed blocks (`:<verified>`, `:<verified>`). Carried rows also seed same-day continuity for the dynamic pass via `fixedTutorAssignments`, so a newly placed session can land back in a room the tutor already holds that day. If a new session cannot fit anywhere, the engine unlocks only the carried rows that overlap it and are not override-pinned, then retries (`:<verified>`–`:<verified>`). Rows whose room changed anyway are labeled `moved` and have their publish state reset (`:<verified>`–`:<verified>`); disappeared sessions emit a `canceled` event but nothing is written back to Wise.
```

Edit B (test-count bump -- this task adds 2 new `it()` declarations to `reconciliation.test.ts`):

Find:
```
Sixteen test files, 152 test declarations (156 executed cases once the one parameterized block expands):
```
Replace with:
```
Sixteen test files, 154 test declarations (158 executed cases once the one parameterized block expands):
```

Find:
```
- **`reconciliation.test.ts`** (7) — carry-forward with preserved publish state, canceled removal, fitting new sessions against carried blocks, reschedule detection, minimal-displacement unlock, override protection.
```
Replace with:
```
- **`reconciliation.test.ts`** (9) — carry-forward with preserved publish state, canceled removal, fitting new sessions against carried blocks, reschedule detection, minimal-displacement unlock, override protection, same-day continuity seeding from a carried row, and remote carried rows seeding nothing.
```
  </action>
  <verify>
    <automated>npx vitest run src/lib/classrooms</automated>
  </verify>
  <done>reconciliation.ts imports FixedTutorAssignment, defines fixedTutorAssignmentsFrom next to fixedBlocks, and passes it into both assignPending call sites via the same function definition; both new tests pass with the exact assignedRoom/ruleTrace assertions shown; docs reconciliation paragraph and test counts updated with verified (not guessed) line numbers; `npx vitest run src/lib/classrooms` is green; one commit.</done>
</task>

<task type="auto">
  <name>Task 4: Room-switch churn metric (visualization.ts + workspace UI) + visualization tests + full verification</name>
  <files>src/lib/classrooms/visualization.ts, src/components/class-assignments/class-assignments-workspace.tsx, src/lib/classrooms/__tests__/visualization.test.ts, docs/features/classroom-assignments.md</files>
  <action>
**Switch definition (must match exactly):** per tutor, keyed by their exact `tutorDisplayName`, drop
remote rows (`shouldSkipRoomOccupancy`) and no-room rows (`assignedRoom === NO_ROOM_AVAILABLE`), sort the
remainder by `startMinute → endMinute → id`, and count a switch for each adjacent pair whose **physical**
room differs (compared via `normalizedPhysicalRoom`, so `Joy` and `Joy (TV)` are the same room and are
never counted as a switch). The run total is the sum across all tutors. This is purely client-side and
informational -- the engine emits nothing new for it.

**1. `src/lib/classrooms/visualization.ts` -- two edits:**

Edit A -- import `normalizedPhysicalRoom` from Task 2's export:

Find:
```typescript
import { REMOTE_NO_ROOM_NEEDED } from "./assignment-engine";
```
Replace with:
```typescript
import { normalizedPhysicalRoom, REMOTE_NO_ROOM_NEEDED } from "./assignment-engine";
```
(`NO_ROOM_AVAILABLE` is already imported from `./rooms` at the top of this file -- reuse it, don't
re-import.)

Edit B -- append the new helper at the end of the file, after `groupCellsByRoom` (matches this file's
established generic `<TRow extends ClassroomVisualizationRow>` pattern used by every other `build*`
helper here):

Find:
```typescript
export function groupCellsByRoom<TRow extends ClassroomVisualizationRow>(
  cells: Array<HeatmapCell<TRow>>,
): Array<{ roomName: string; cells: Array<HeatmapCell<TRow>>; isReview: boolean }> {
  const grouped = new Map<string, { roomName: string; cells: Array<HeatmapCell<TRow>>; isReview: boolean }>();
  for (const cell of cells) {
    const group = grouped.get(cell.roomName) ?? {
      roomName: cell.roomName,
      cells: [],
      isReview: cell.isReview,
    };
    group.cells.push(cell);
    group.isReview = group.isReview || cell.isReview;
    grouped.set(cell.roomName, group);
  }
  return [...grouped.values()];
}
```
Replace with:
```typescript
export function groupCellsByRoom<TRow extends ClassroomVisualizationRow>(
  cells: Array<HeatmapCell<TRow>>,
): Array<{ roomName: string; cells: Array<HeatmapCell<TRow>>; isReview: boolean }> {
  const grouped = new Map<string, { roomName: string; cells: Array<HeatmapCell<TRow>>; isReview: boolean }>();
  for (const cell of cells) {
    const group = grouped.get(cell.roomName) ?? {
      roomName: cell.roomName,
      cells: [],
      isReview: cell.isReview,
    };
    group.cells.push(cell);
    group.isReview = group.isReview || cell.isReview;
    grouped.set(cell.roomName, group);
  }
  return [...grouped.values()];
}

export interface RoomChurnSummary {
  totalSwitches: number;
  switchesByTutor: Map<string, number>;
}

export function buildRoomChurnSummary<TRow extends ClassroomVisualizationRow>(
  rows: TRow[],
): RoomChurnSummary {
  const byTutor = new Map<string, TRow[]>();
  for (const row of rows) {
    if (shouldSkipRoomOccupancy(row)) continue;
    if (row.assignedRoom === NO_ROOM_AVAILABLE) continue;
    const list = byTutor.get(row.tutorDisplayName) ?? [];
    list.push(row);
    byTutor.set(row.tutorDisplayName, list);
  }

  const switchesByTutor = new Map<string, number>();
  let totalSwitches = 0;
  for (const [tutorDisplayName, tutorRows] of byTutor) {
    const sorted = [...tutorRows].sort((a, b) => {
      if (a.startMinute !== b.startMinute) return a.startMinute - b.startMinute;
      if (a.endMinute !== b.endMinute) return a.endMinute - b.endMinute;
      return a.id.localeCompare(b.id);
    });
    let switches = 0;
    for (let i = 1; i < sorted.length; i += 1) {
      if (normalizedPhysicalRoom(sorted[i].assignedRoom) !== normalizedPhysicalRoom(sorted[i - 1].assignedRoom)) {
        switches += 1;
      }
    }
    if (switches > 0) switchesByTutor.set(tutorDisplayName, switches);
    totalSwitches += switches;
  }

  return { totalSwitches, switchesByTutor };
}
```
(`switchesByTutor` intentionally omits zero-switch tutors -- the only consumer, the workspace badge, only
ever checks `> 0`.)

**2. `src/lib/classrooms/__tests__/visualization.test.ts` -- add imports, then a new describe block at the
end of the file:**

Edit A -- imports:

Find:
```typescript
import { DEFAULT_CLASSROOM_ROOMS, NO_ROOM_AVAILABLE } from "../rooms";
import {
  buildHeatmapCells,
  buildRoomCalendarEvents,
  buildRoomOccupancyState,
  buildTimelineBounds,
  snapTimelinePlaybackMinute,
  type ClassroomVisualizationRoom,
  type ClassroomVisualizationRow,
  REVIEW_LANE_ROOM_NAME,
} from "../visualization";
```
Replace with:
```typescript
import { DEFAULT_CLASSROOM_ROOMS, NO_ROOM_AVAILABLE, ROOM_JOY } from "../rooms";
import {
  buildHeatmapCells,
  buildRoomCalendarEvents,
  buildRoomChurnSummary,
  buildRoomOccupancyState,
  buildTimelineBounds,
  snapTimelinePlaybackMinute,
  type ClassroomVisualizationRoom,
  type ClassroomVisualizationRow,
  REVIEW_LANE_ROOM_NAME,
} from "../visualization";
```

Edit B -- append new describe block, anchored on the file's last existing test:

Find:
```typescript
  it("splits overlapping room-calendar events into lanes", () => {
    const events = buildRoomCalendarEvents(
      [
        row({ id: "first", assignedRoom: "Focus", startMinute: 9 * 60, endMinute: 10 * 60 }),
        row({ id: "second", assignedRoom: "Focus", startMinute: 9 * 60 + 30, endMinute: 10 * 60 + 30 }),
      ],
      rooms(),
    ).filter((event) => event.roomName === "Focus");

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.lane).sort()).toEqual([0, 1]);
    expect(events.every((event) => event.laneCount === 2)).toBe(true);
    expect(events.every((event) => event.hasRoomConflict)).toBe(true);
  });
});
```
Replace with:
```typescript
  it("splits overlapping room-calendar events into lanes", () => {
    const events = buildRoomCalendarEvents(
      [
        row({ id: "first", assignedRoom: "Focus", startMinute: 9 * 60, endMinute: 10 * 60 }),
        row({ id: "second", assignedRoom: "Focus", startMinute: 9 * 60 + 30, endMinute: 10 * 60 + 30 }),
      ],
      rooms(),
    ).filter((event) => event.roomName === "Focus");

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.lane).sort()).toEqual([0, 1]);
    expect(events.every((event) => event.laneCount === 2)).toBe(true);
    expect(events.every((event) => event.hasRoomConflict)).toBe(true);
  });
});

describe("buildRoomChurnSummary", () => {
  it("counts each physical-room change across a tutor's day", () => {
    const summary = buildRoomChurnSummary([
      row({ id: "a1", assignedRoom: "Focus", startMinute: 9 * 60, endMinute: 10 * 60 }),
      row({ id: "b1", assignedRoom: "Cool", startMinute: 10 * 60 + 15, endMinute: 11 * 60 }),
      row({ id: "a2", assignedRoom: "Focus", startMinute: 11 * 60 + 30, endMinute: 12 * 60 + 30 }),
    ]);

    expect(summary.totalSwitches).toBe(2);
    expect(summary.switchesByTutor.get("Tutor One")).toBe(2);
  });

  it("does not count a remote session as a room change", () => {
    const summary = buildRoomChurnSummary([
      row({ id: "a1", assignedRoom: "Focus", startMinute: 9 * 60, endMinute: 10 * 60 }),
      row({
        id: "remote",
        assignedRoom: REMOTE_NO_ROOM_NEEDED,
        status: "remote",
        sessionType: "SCHEDULED",
        startMinute: 10 * 60 + 15,
        endMinute: 11 * 60,
      }),
      row({ id: "a2", assignedRoom: "Focus", startMinute: 11 * 60 + 15, endMinute: 12 * 60 }),
    ]);

    expect(summary.totalSwitches).toBe(0);
    expect(summary.switchesByTutor.has("Tutor One")).toBe(false);
  });

  it("treats Joy and Joy (TV) as the same physical room", () => {
    const summary = buildRoomChurnSummary([
      row({ id: "joy1", assignedRoom: "Joy", startMinute: 9 * 60, endMinute: 10 * 60 }),
      row({ id: "joy2", assignedRoom: ROOM_JOY, startMinute: 10 * 60 + 15, endMinute: 11 * 60 }),
    ]);

    expect(summary.totalSwitches).toBe(0);
  });

  it("sums switches across multiple tutors", () => {
    const summary = buildRoomChurnSummary([
      row({ id: "t1-a", tutorDisplayName: "Tutor One", assignedRoom: "Focus", startMinute: 9 * 60, endMinute: 10 * 60 }),
      row({ id: "t1-b", tutorDisplayName: "Tutor One", assignedRoom: "Cool", startMinute: 10 * 60 + 30, endMinute: 11 * 60 + 30 }),
      row({ id: "t2-a", tutorDisplayName: "Tutor Two", assignedRoom: "OMG", startMinute: 9 * 60, endMinute: 10 * 60 }),
      row({ id: "t2-b", tutorDisplayName: "Tutor Two", assignedRoom: "Nerd", startMinute: 10 * 60 + 30, endMinute: 11 * 60 + 30 }),
      row({ id: "t2-c", tutorDisplayName: "Tutor Two", assignedRoom: "Nerd", startMinute: 12 * 60, endMinute: 13 * 60 }),
    ]);

    expect(summary.switchesByTutor.get("Tutor One")).toBe(1);
    expect(summary.switchesByTutor.get("Tutor Two")).toBe(1);
    expect(summary.totalSwitches).toBe(2);
  });
});
```
(`REMOTE_NO_ROOM_NEEDED` is already imported from `../assignment-engine` in this file.)

**3. `src/components/class-assignments/class-assignments-workspace.tsx` -- four edits:**

Edit A -- import:

Find:
```typescript
import { buildTimelineBounds, minuteToTimeLabel, snapTimelinePlaybackMinute } from "@/lib/classrooms/visualization";
```
Replace with:
```typescript
import { buildRoomChurnSummary, buildTimelineBounds, minuteToTimeLabel, snapTimelinePlaybackMinute } from "@/lib/classrooms/visualization";
```

Edit B -- new memo next to the existing `tutors` memo:

Find:
```typescript
  const tutors = useMemo(() => {
    return [...new Set(rows.map((row) => row.tutorDisplayName))].sort((a, b) => a.localeCompare(b));
  }, [rows]);
```
Replace with:
```typescript
  const tutors = useMemo(() => {
    return [...new Set(rows.map((row) => row.tutorDisplayName))].sort((a, b) => a.localeCompare(b));
  }, [rows]);

  const churnSummary = useMemo(() => buildRoomChurnSummary(rows), [rows]);
```

Edit C -- grid goes seven-tile to eight-tile, new "Room switches" tile after "Remote":

Find:
```typescript
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-7">
```
Replace with:
```typescript
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-8">
```

Find:
```typescript
        <div className="rounded-lg border bg-card p-3">
          <div className="text-xs text-muted-foreground">Remote</div>
          <div className="mt-1 text-lg font-semibold">{run?.remoteCount ?? 0}</div>
        </div>
        <div className="rounded-lg border bg-card p-3">
          <div className="text-xs text-muted-foreground">Wise publish</div>
```
Replace with:
```typescript
        <div className="rounded-lg border bg-card p-3">
          <div className="text-xs text-muted-foreground">Remote</div>
          <div className="mt-1 text-lg font-semibold">{run?.remoteCount ?? 0}</div>
        </div>
        <div className="rounded-lg border bg-card p-3">
          <div className="text-xs text-muted-foreground">Room switches</div>
          <div className="mt-1 text-lg font-semibold">{churnSummary.totalSwitches}</div>
        </div>
        <div className="rounded-lg border bg-card p-3">
          <div className="text-xs text-muted-foreground">Wise publish</div>
```

Edit D -- Tutor Schedule tab card header gets an outline `Badge` with the switch count when > 0 (`Badge`
is already imported at the top of this file):

Find:
```typescript
                    return (
                      <div key={tutor} className="rounded-lg border p-3">
                        <div className="mb-2 text-sm font-semibold">{tutor}</div>
                        <div className="space-y-2">
```
Replace with:
```typescript
                    const tutorSwitchCount = churnSummary.switchesByTutor.get(tutor) ?? 0;
                    return (
                      <div key={tutor} className="rounded-lg border p-3">
                        <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
                          <span>{tutor}</span>
                          {tutorSwitchCount > 0 && (
                            <Badge variant="outline">
                              {tutorSwitchCount} room switch{tutorSwitchCount === 1 ? "" : "es"}
                            </Badge>
                          )}
                        </div>
                        <div className="space-y-2">
```

No new test file for this component -- per the source plan, tiles/tabs in this workspace have zero
existing test coverage (confirmed: `src/components/class-assignments/__tests__/visualization-components.test.tsx`
does not render `ClassAssignmentsWorkspace` and has no `grid-cols` assertions), and the pure math lives in
`visualization.ts`, which is fully covered above. This matches repo convention of testing the extracted pure
helper, not the JSX shell.

**4. `docs/features/classroom-assignments.md` -- three edits:**

Edit A (seven-tile → eight-tile mention; verify the line number before writing since Task 1-3's docs edits
and this task's own workspace.tsx edits don't move this specific citation target, but confirm with
`grep -n 'lg:grid-cols-8' src/components/class-assignments/class-assignments-workspace.tsx` after Edit C
above to get the real line number):

Find:
```
**Workspace** — `src/components/class-assignments/class-assignments-workspace.tsx` is the whole operational surface: date input, "Force reassign" checkbox, Refresh, the combined **"Sync Wise, then run"** action, "Publish to Wise", and "Email schedules". Above the tabs it renders a snapshot freshness banner (`:704`), a live-Wise-room-blocker warning banner (`:723`), and a seven-tile run summary (`:743`).
```
Replace with:
```
**Workspace** — `src/components/class-assignments/class-assignments-workspace.tsx` is the whole operational surface: date input, "Force reassign" checkbox, Refresh, the combined **"Sync Wise, then run"** action, "Publish to Wise", and "Email schedules". Above the tabs it renders a snapshot freshness banner (`:704`), a live-Wise-room-blocker warning banner (`:723`), and an eight-tile run summary (`:<verified>`) including a client-computed Room switches tile.
```

Edit B (badge mention on the Tutor Schedule tab bullet):

Find:
```
  - **Tutor Schedule** — per-tutor blocks; disabled until the run has rows.
```
Replace with:
```
  - **Tutor Schedule** — per-tutor blocks; disabled until the run has rows; each tutor's card header shows an outline badge with their room-switch count for the day when it's greater than zero.
```

Edit C (final test-count bump -- this task adds 4 new `it()` declarations in a brand-new
`buildRoomChurnSummary` describe block inside the existing `visualization.test.ts` file; file count stays
sixteen since no new test *file* is created):

Find:
```
Sixteen test files, 154 test declarations (158 executed cases once the one parameterized block expands):
```
Replace with:
```
Sixteen test files, 158 test declarations (162 executed cases once the one parameterized block expands):
```
  </action>
  <verify>
    <automated>npx vitest run src/lib/classrooms src/components/class-assignments && npm test && npx tsc --noEmit</automated>
  </verify>
  <done>visualization.ts exports buildRoomChurnSummary and RoomChurnSummary; all 4 new visualization tests pass; the workspace shows an 8-tile grid with a Room switches tile and per-tutor outline badges in the Tutor Schedule tab; docs UI/test-count edits land with verified line numbers; full unit suite (`npm test`) and `npx tsc --noEmit` are both clean; one commit.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|--------------|
| Admin session → `/class-assignments` workspace | Pre-existing Auth.js-gated admin page (`src/middleware.ts`). This plan adds only client-side derived display (churn counts) computed from data the page already receives -- no new input field, no new endpoint, no new value sent to the server. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-260811-01 | Information Disclosure | `buildRoomChurnSummary` output rendered in the workspace | accept | Room names and tutor display names are already rendered elsewhere on the same already-authenticated page (Rows tab, Tutor Schedule tab); the new tile/badge exposes no new data class, only a derived count over data already visible on screen. |
| T-260811-02 | Tampering | `assignClassrooms`'s new `fixedTutorAssignments` option | accept | Same-process, same-request pure-function input built entirely server-side inside `reconcileClassroomAssignments` from the run's own carried rows -- no external or client-supplied value flows into it, no new deserialization boundary. |
| T-260811-03 | Denial of Service | New sticky-room cascade step / `latestPriorRoomForTutor` | accept | O(1) map lookups per session against a per-run tutor map bounded by that day's session count; no new loop over an unbounded or externally-controlled collection. |

No new endpoint, no new persisted field, no new external I/O, and no change to the auth/session boundary is
introduced by this plan -- the STRIDE surface here is materially identical to the pre-existing
`assignClassrooms`/reconciliation code path this plan extends.
</threat_model>

<risks_and_non_breakage>
Transcribed verbatim from the approved plan's "Risks / non-breakage" section, plus this planner's own
corroboration where noted:

- Pinned trace strings are untouched; the new trace `assigned by sticky room:` has no collision with any
  existing trace string. `ruleTrace` has no consumers outside the engine and its tests (verified).
- The existing onsite-continuity test at `assignment-engine.test.ts:170` now takes the sticky path
  internally, but that test only asserts the online row's outcome -- it still passes.
- Single-session-per-tutor tests (originally at `:337`, `:446` [now shifted by Task 1's insertions],
  `:61`, `:596`, `:264`, and the whole preferred-room-protection `it.each` family) are unaffected --
  `lastByTutor`/`fixedByTutor` are empty for a tutor's first and only session, so both continuity steps and
  the sticky step are no-ops.
- Room Capacity (`src/lib/room-capacity/`) reuses `assignClassrooms`, but its own test suite never pins
  specific `assignedRoom` names (**planner-verified**: `grep -n "assignedRoom" src/lib/room-capacity/__tests__/*.test.ts`
  shows only manually-constructed fixture values, never assertions against `assignClassrooms`'s emergent
  room choice) -- the full `npm test` run in Task 4 is what actually proves this, not a targeted command.
- **Deliberately out of scope** (a follow-up, not a gap in this plan): the reconciler's pending-only session
  list still means `buildCenterRoomRequirementMap` only sees pending sessions, so the online center-room
  60-minute continuity chain can still break across carried onsite rows in an incremental run. Same
  root-cause family as this plan, but touches remote/assigned semantics differently -- separate ticket, per
  the approved plan. Also out of scope: AMB-25/26/27, roster changes beyond Ras, and the publish flow.
- **Planner-verified, not in the source plan:** `src/lib/classrooms/__tests__/rooms.test.ts` only asserts
  `TV_ROOM_NAME_BY_PHYSICAL_NAME` canonicalization and the historical-rename migration -- it never touches
  `PREFERRED_BY_TUTOR` or the priority map, so Task 1's data change carries zero risk to that file.
- **Planner-verified, not in the source plan:** no component test renders `ClassAssignmentsWorkspace`
  directly or asserts on `grid-cols`, confirming Task 4's UI edit needs no new/updated component test beyond
  the pure-helper coverage in `visualization.test.ts`.
</risks_and_non_breakage>

<planner_concerns>
Interpretations required to turn the approved plan's prose into executable, internally-consistent tasks,
none of which contradict any explicit sentence in `source_plan` -- flagging per the transcription
instructions:

1. **Test-to-commit distribution.** The orchestrator's task breakdown says Task 1 is "Ras priority lock ...
   + test rewrite" (singular) and Task 2 is "sticky-room step ... + engine tests" (plural, unscoped). The
   source plan's own "## New tests" section lists all 10 `assignment-engine.test.ts` items together without
   assigning them to a specific commit. I assigned items 1-4 (the new Ras-only tests) to Task 1 and items
   6-10 (the sticky tests) to Task 2, because none of items 1-4 exercise any Task 2 code -- they only
   exercise the new `rooms.ts` data plus pre-existing, unmodified pre-pass mechanics. This keeps each commit
   fully self-verifying on its own, matching the repo convention "engine changes land WITH their test
   changes in the same commit" applied at the finest reasonable grain.
2. **File count.** The source plan's closing "Execution note" says "8 files"; the enumerated Commits 1-4
   plus its own "### Docs" section together touch 9 (the docs file itself makes the ninth). `files_modified`
   above lists the accurate 9 -- flagging the source's own tally as slightly off rather than silently
   matching it, per the "transcription, not redesign" instruction (I'm not omitting or adding scope, just
   correcting an arithmetic slip in the source's summary line).
3. **`buildRoomChurnSummary` signature.** The source plan sketches `buildRoomChurnSummary(rows): {
   totalSwitches, switchesByTutor: Map<string, number> }` without a generic parameter. I made it generic
   (`<TRow extends ClassroomVisualizationRow>`) to match every other `build*` helper already in
   `visualization.ts` (`buildRoomOccupancyState`, `buildHeatmapCells`, `buildRoomCalendarEvents` are all
   written this way) -- this is the file's own established convention, not a new one.
4. **`switchesByTutor` sparsity.** Not specified in the source plan. I chose to omit zero-switch tutors from
   the map (rather than including every tutor at 0) since the only consumer -- the workspace badge -- only
   ever checks `> 0`, and this avoids building a map entry per tutor per run for no benefit.
5. **Doc line-number citations that sit inside edited sentences.** Several docs edits (Task 2's cascade
   range `:417`–`:542`, Task 3's four reconciliation citations, Task 4's `:743` tile citation) name specific
   line numbers that shift because of *earlier* edits in the *same* task. I hand-computed a shift estimate
   twice for the Task 2 case and got two different answers 38 lines apart, which is exactly why each
   affected edit above tells the executor to `grep -n` the real number rather than trust a hardcoded guess.
   This is more reliable than a plan-time estimate and keeps the shipped doc accurate. This does **not**
   extend to auditing every other pre-existing citation elsewhere in the doc (e.g. `assignment-engine.ts:199`,
   `:222`–`:270`, `:432`) -- those are outside the four docs bullets the source plan explicitly asked for,
   and re-auditing the whole document is out of this task's scope.
6. **Concrete test scenarios for prose-only bullets.** Source-plan items 4 and 6-12 were English descriptions
   ("mirror of `:382`", "regression-prover: sticky across 30-min gap...", "displaced preferred tutor (Ek)
   returns to OMG...") without code. I designed and hand-traced each scenario against the exact current
   algorithm (pre-pass ordering, `sortedSessions` tie-breaks, `protectedClaims` vs `occupancy`) to confirm
   it exercises the intended behavior and asserts a value the new code actually produces -- full code is
   given in each task so the executor does not need to re-derive scenarios or guess at fixture data.
</planner_concerns>

<verification>
1. `npm test` — full unit suite must stay green, including the 16 new cases (Task 4's verify step; run
   after all 4 tasks are committed).
2. Targeted, after each of Tasks 1-3: `npx vitest run src/lib/classrooms` green.
3. Targeted, after Task 4: `npx vitest run src/lib/classrooms src/components/class-assignments` green (the
   component-tests directory has existing coverage unrelated to this plan that must not regress).
4. `npx tsc --noEmit` clean (Task 4's verify step covers this for the whole plan).
5. Manual (not automated by this plan, a post-merge rollout step): trigger a run for a future Saturday via
   the Class Assignments UI "Run" button; check the new Room switches tile and Ras's rows -- expect Never
   Ever (TV) on every Ras session that fits (capacity ≤ 3), and per-tutor switch badges visibly lower for
   high-volume tutors than before this change.
6. Manual (post-deploy): after the morning cron runs, spot-check a reconciled run -- newly placed sessions
   should show `assigned by sticky room:` traces reusing rooms from carried rows.
</verification>

<success_criteria>
- [ ] All 4 tasks complete, one commit each, in the order written
- [ ] `npm test` passes
- [ ] `npx tsc --noEmit` clean
- [ ] Ras is in both `PREFERRED_BY_TUTOR` and the priority-preferred-room map with Online variants
- [ ] The sticky-room cascade step sits between preferred-room and online-only, using `latestPriorRoomForTutor`
- [ ] `reconciliation.ts`'s `assignPending` passes `fixedTutorAssignments` derived from carried rows
- [ ] The workspace shows an eight-tile summary with a Room switches tile and per-tutor switch badges
- [ ] All pinned trace strings and the 4 continuity-boundary tests named in `<risks_and_non_breakage>` are unaffected
- [ ] `docs/features/classroom-assignments.md` reflects every change above with verified (not guessed) line numbers
- [ ] No `TODO`/`FIXME`/`HACK` comments introduced; all new exports are named exports
</success_criteria>

<output>
After completion, create `.planning/quick/260811-div-classroom-assignment-continuity-ras-prio/260811-div-SUMMARY.md`
</output>
