---
phase: 07-past-01-past-day-session-visibility
plan: 02
type: execute
wave: 2
depends_on:
  - 01
files_modified:
  - src/lib/sync/past-sessions-diff-hook.ts
  - src/lib/sync/orchestrator.ts
  - src/lib/sync/__tests__/past-sessions-diff-hook.test.ts
autonomous: true
requirements:
  - PAST-02
  - PAST-05

must_haves:
  truths:
    - "Daily sync orchestrator, before atomic promotion, compares prior active snapshot's future_session_blocks against the newly-fetched Wise FUTURE list and captures dropped past-start sessions into past_session_blocks"
    - "Per-group errors in the diff-hook emit completeness data_issues but do NOT abort the sync (error isolation matches orchestrator.ts:240-250)"
    - "Double-observation of the same wise_session_id across two snapshots results in exactly ONE row in past_session_blocks (first-observation wins via ON CONFLICT DO NOTHING — D-03)"
    - "Diff-hook runs BEFORE the atomic promotion at orchestrator.ts line 440; the prior snapshot is still active=true when the hook reads it"
    - "diffHookDurationMs + capturedCount are persisted to sync_runs.metadata for observability (A6 margin watch)"
  artifacts:
    - path: "src/lib/sync/past-sessions-diff-hook.ts"
      provides: "Isolated, testable `runPastSessionsDiffHook` function"
      exports: ["runPastSessionsDiffHook"]
    - path: "src/lib/sync/orchestrator.ts"
      provides: "Integrated diff-hook call after MOD-01 contradiction loop, before parallel insert"
      contains: "runPastSessionsDiffHook"
    - path: "src/lib/sync/__tests__/past-sessions-diff-hook.test.ts"
      provides: "Unit tests covering drop detection, not-yet-past exclusion, double-observation idempotency, per-group error isolation"
      contains: "describe(\"runPastSessionsDiffHook\""
  key_links:
    - from: "src/lib/sync/orchestrator.ts (after line 386 MOD-01 loop end)"
      to: "src/lib/sync/past-sessions-diff-hook.ts `runPastSessionsDiffHook`"
      via: "direct import + await call"
      pattern: "await runPastSessionsDiffHook\\("
    - from: "src/lib/sync/past-sessions-diff-hook.ts"
      to: "schema.pastSessionBlocks (Postgres)"
      via: "insertInChunks(... onConflictDoNothing({ target: wiseSessionId }))"
      pattern: "\\.onConflictDoNothing\\(\\{\\s*target:\\s*schema\\.pastSessionBlocks\\.wiseSessionId"
    - from: "src/lib/sync/past-sessions-diff-hook.ts"
      to: "schema.futureSessionBlocks + schema.tutorIdentityGroups (prior snapshot)"
      via: "SELECT WHERE snapshotId = <prior> (two queries: prior future sessions, prior group→canonicalKey map)"
      pattern: "eq\\(schema\\.futureSessionBlocks\\.snapshotId, priorSnapshot\\.id\\)"
---

<objective>
Implement the daily-sync diff-hook that captures sessions dropped from Wise FUTURE into the new `past_session_blocks` table. The hook runs once per sync, right after the Phase 6 MOD-01 contradiction loop ends at `orchestrator.ts:386` and before the parallel-insert block at `orchestrator.ts:392`. It compares the prior active snapshot's `future_session_blocks` against the newly-fetched Wise FUTURE response (already normalized into `sessionBlocks` variable in scope) and inserts rows for sessions that (a) existed in the prior snapshot, (b) have `startTime < now()` in Asia/Bangkok, and (c) are NOT in the new response, using `ON CONFLICT DO NOTHING` on `wise_session_id` (D-03).

Purpose: PAST-02 (orchestrator captures dropped sessions) + PAST-05 (idempotent capture via UNIQUE constraint). The hook must not breach the ~34s sync-duration margin (A6); observability via `diffHookDurationMs` persisted to `sync_runs.metadata`.

Output: New helper file `past-sessions-diff-hook.ts` + integration call in orchestrator.ts + unit test file.
</objective>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Wise FUTURE response → diff-hook input | Already-validated via `normalizeSessions` upstream (line 263) |
| Prior-snapshot DB rows → diff-hook input | Database-validated via Drizzle schema types; read-only |
| Diff-hook → past_session_blocks inserts | Drizzle parameterized inserts (no string interpolation) |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-07-02-01 | Tampering | Crafted wise_session_id in Wise response | accept | Upstream `normalizeSessions` validates shape; Drizzle `.values(chunk)` parameterizes the insert (no SQL injection vector). ON CONFLICT DO NOTHING makes duplicate-id attacks idempotent, not destructive. |
| T-07-02-02 | Denial of Service | Diff-hook runs O(N_prior × N_new) membership test per sync | mitigate | Use `Set<string>` for O(1) `wiseSessionId` lookup (single pass over prior list). Research §Summary estimates ≤100 dropped sessions/day; ≤35k×1 hash-set membership tests take <50ms. Log `diffHookDurationMs`; if >20s after first deploy, escalate per A6. |
| T-07-02-03 | Information Disclosure | student_name/location in error log messages | mitigate | Error messages emitted as data_issues ONLY include group canonical key + wiseSessionId + generic error string; do NOT interpolate `studentName`, `location`, or `subject` into messages (PITFALLS.md §Security). |
| T-07-02-04 | Repudiation | Partial-failure sync re-runs can't distinguish "captured in past" vs "captured in this run" | accept | `captured_in_snapshot_id` + `captured_at` provide audit trail (Plan 01 T-07-04). First-observation wins is accepted D-03 behavior. |
| T-07-02-05 | Elevation of Privilege | Diff-hook reads tutor_identity_groups of the prior snapshot | accept | Same DB connection, same Drizzle schema ACLs as existing orchestrator SELECTs (line 78, 125-128). No new privileges introduced. |

All threats LOW or MEDIUM (T-07-02-02 watched via observability). No HIGH severity threats.
</threat_model>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/phases/07-past-01-past-day-session-visibility/07-CONTEXT.md
@.planning/phases/07-past-01-past-day-session-visibility/07-RESEARCH.md
@src/lib/sync/orchestrator.ts
@src/lib/db/schema.ts
@src/lib/normalization/sessions.ts

<interfaces>
<!-- Key types and imports the executor will use -->

From src/lib/db/schema.ts (lines 177-201, the prior-snapshot read source):
```typescript
export const futureSessionBlocks = pgTable("future_session_blocks", {
  id: uuid("id").primaryKey().defaultRandom(),
  snapshotId: uuid("snapshot_id").notNull().references(() => snapshots.id),
  groupId: uuid("group_id").notNull().references(() => tutorIdentityGroups.id),
  wiseSessionId: text("wise_session_id").notNull(),
  wiseTeacherId: text("wise_teacher_id").notNull(),
  startTime: timestamp("start_time", { withTimezone: true }).notNull(),
  // ... (other columns same as pastSessionBlocks minus snapshot-scoped ones)
});
```

From src/lib/db/schema.ts (lines 78-86, for canonicalKey lookup):
```typescript
export const tutorIdentityGroups = pgTable("tutor_identity_groups", {
  id: uuid("id").primaryKey().defaultRandom(),
  snapshotId: uuid("snapshot_id").notNull().references(() => snapshots.id),
  canonicalKey: text("canonical_key").notNull(),
  // ...
});
```

From src/lib/normalization/sessions.ts — the normalized session shape in `sessionBlocks`:
```typescript
export interface NormalizedSessionBlock {
  wiseTeacherId: string;
  wiseSessionId: string;
  startTime: Date;
  endTime: Date;
  weekday: number;
  startMinute: number;
  endMinute: number;
  wiseStatus: string;
  isBlocking: boolean;
  title: string | null;
  sessionType: string | null;
  location: string | null;
  studentName: string | null;
  subject: string | null;
  classType: string | null;
  recurrenceId: string | null;
}
```

From src/lib/sync/orchestrator.ts (line 34-42): the chunked-insert helper:
```typescript
async function insertInChunks<T>(rows: T[], insertChunk: (chunk: T[]) => Promise<unknown>, chunkSize: number = INSERT_CHUNK_SIZE) {
  for (let i = 0; i < rows.length; i += chunkSize) {
    await insertChunk(rows.slice(i, i + chunkSize));
  }
}
```

From src/lib/sync/orchestrator.ts (line 352-386): the structural pattern to mirror (per-group iteration + error isolation).

Verified Drizzle API (from 07-RESEARCH.md A4): `.onConflictDoNothing({ target: schema.pastSessionBlocks.wiseSessionId })` — single IndexColumn.
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Create past-sessions-diff-hook.ts helper with isolated, testable function</name>
  <files>src/lib/sync/past-sessions-diff-hook.ts, src/lib/sync/__tests__/past-sessions-diff-hook.test.ts</files>
  <read_first>
    - src/lib/sync/orchestrator.ts (full file — especially lines 34-42 insertInChunks, lines 240-250 per-teacher error-isolation pattern, lines 352-386 MOD-01 structural reference)
    - src/lib/db/schema.ts (lines 47-51 snapshots, 78-86 tutorIdentityGroups, 177-201 futureSessionBlocks, new pastSessionBlocks from Plan 01)
    - src/lib/normalization/sessions.ts (NormalizedSessionBlock shape)
    - src/app/api/data-health/__tests__/modality-counter.test.ts (test-pattern reference that avoids next/server import issues)
    - .planning/phases/07-past-01-past-day-session-visibility/07-RESEARCH.md §"Pattern 2: Diff-hook in orchestrator" (verbatim function body blueprint)
  </read_first>
  <behavior>
    - Test 1: Happy path — prior snapshot has 3 future sessions (S1 startTime=past, S2 startTime=past, S3 startTime=future). New Wise response contains only S3. Expect: 2 rows inserted into past_session_blocks (S1, S2); 1 row NOT inserted (S3, still future). `capturedCount` returns 2; `issues` is empty.
    - Test 2: Double-observation idempotency — call `runPastSessionsDiffHook` twice with the same prior snapshot + same new sessions. First call captures 2 rows; second call captures 0 additional rows (returns `capturedCount: 0`). Assertion via mock DB state: only 2 rows exist total. Validates ON CONFLICT DO NOTHING (D-03 / PAST-05).
    - Test 3: No prior snapshot (first-ever sync) — mock returns empty array for `snapshots WHERE active=true AND id != newId`. Expect: `capturedCount: 0`, `issues: []`, no DB insert attempted.
    - Test 4: Not-yet-past session — prior has a session with `startTime > now()`. New response omits it (e.g., cancelled upstream). Expect: NOT captured (hasn't started yet). `capturedCount: 0`.
    - Test 5: Missing canonical_key resolution — prior future_session_blocks row references a groupId NOT present in the prior snapshot's tutor_identity_groups (DB anomaly). Expect: `issues` contains one `completeness` data_issue with severity `"medium"` and message mentioning the dangling `groupId`; session is SKIPPED (not captured). Sync does not abort.
    - Test 6: Still in Wise response — prior has session S1 (startTime=past). New Wise response still contains S1 (unusual but legal). Expect: NOT captured (not "dropped"). `capturedCount: 0`.
  </behavior>
  <action>
Create `src/lib/sync/past-sessions-diff-hook.ts` with the following exact structure. The hook is extracted to a standalone file (not inline in orchestrator.ts) per research §"Claude's Discretion" test-matrix composition, so Vitest can mock the DB and assert behavior without running the full sync pipeline.

Required function signature and behavior:

```typescript
import { and, eq, sql } from "drizzle-orm";
import { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import type { NormalizedSessionBlock } from "@/lib/normalization/sessions";
import { toZonedTime } from "date-fns-tz";

const INSERT_CHUNK_SIZE = 250;

/**
 * Data issue row shape matching the orchestrator's `allIssues` array.
 * Caller (orchestrator) forwards these to schema.dataIssues via insertInChunks.
 */
export interface DiffHookIssue {
  snapshotId: string;
  type: "completeness";
  severity: "medium";
  entityType: "past_session_block";
  entityId: string;
  entityName: string | null;
  message: string;
}

export interface DiffHookResult {
  capturedCount: number;
  issues: DiffHookIssue[];
  durationMs: number;
}

/**
 * PAST-01 diff-hook. Compares the prior active snapshot's future_session_blocks
 * against the newly-fetched Wise FUTURE list and captures dropped past-start
 * sessions into past_session_blocks with ON CONFLICT DO NOTHING.
 *
 * MUST run BEFORE atomic promotion (orchestrator.ts:440) so the prior snapshot
 * is still `active=true` when the hook reads it.
 *
 * Neon HTTP driver has no transaction support — idempotency relies entirely on
 * UNIQUE(wise_session_id) + onConflictDoNothing. A crashed sync that
 * partially-inserted rows can safely re-run on the next cron tick.
 *
 * Per-group errors emit completeness data_issues; the hook never throws — a
 * diff-hook failure on one group does not abort the sync (error-isolation
 * matches orchestrator.ts:240-250).
 */
export async function runPastSessionsDiffHook(
  db: Database,
  newWiseSessions: NormalizedSessionBlock[],
  newSnapshotId: string,
): Promise<DiffHookResult> {
  const startedAt = Date.now();
  const issues: DiffHookIssue[] = [];

  // 1. Find the currently-active (prior) snapshot. MUST run before promotion.
  const [priorSnapshot] = await db
    .select({ id: schema.snapshots.id })
    .from(schema.snapshots)
    .where(and(
      eq(schema.snapshots.active, true),
      sql`${schema.snapshots.id} != ${newSnapshotId}`,
    ))
    .limit(1);

  if (!priorSnapshot) {
    // First-ever sync or prior active snapshot missing — nothing to diff.
    return { capturedCount: 0, issues, durationMs: Date.now() - startedAt };
  }

  // 2. Build prior groupId -> canonicalKey map (single batch SELECT).
  const priorGroups = await db
    .select({
      id: schema.tutorIdentityGroups.id,
      canonicalKey: schema.tutorIdentityGroups.canonicalKey,
    })
    .from(schema.tutorIdentityGroups)
    .where(eq(schema.tutorIdentityGroups.snapshotId, priorSnapshot.id));
  const priorGroupIdToCanonicalKey = new Map(
    priorGroups.map((g) => [g.id, g.canonicalKey]),
  );

  // 3. Read all prior-snapshot future_session_blocks in one query.
  const priorBlocks = await db
    .select()
    .from(schema.futureSessionBlocks)
    .where(eq(schema.futureSessionBlocks.snapshotId, priorSnapshot.id));

  // 4. Build O(1) lookup of wiseSessionIds present in the new Wise response.
  const newWiseSessionIds = new Set(newWiseSessions.map((s) => s.wiseSessionId));

  // 5. "Now" in Asia/Bangkok — used to test if a prior session has already started.
  const nowBkk = toZonedTime(new Date(), "Asia/Bangkok");

  // 6. Compute the "dropped" set: in prior, not in new, and startTime < now.
  const droppedRows: typeof schema.pastSessionBlocks.$inferInsert[] = [];
  for (const prior of priorBlocks) {
    if (newWiseSessionIds.has(prior.wiseSessionId)) continue; // still future — not dropped
    if (prior.startTime >= nowBkk) continue; // hasn't started yet
    const canonicalKey = priorGroupIdToCanonicalKey.get(prior.groupId);
    if (!canonicalKey) {
      issues.push({
        snapshotId: newSnapshotId,
        type: "completeness",
        severity: "medium",
        entityType: "past_session_block",
        entityId: prior.wiseSessionId,
        entityName: null,
        message: `Diff-hook: could not resolve group_canonical_key for prior-snapshot groupId=${prior.groupId}; skipping capture of wise_session_id=${prior.wiseSessionId}`,
      });
      continue;
    }
    droppedRows.push({
      groupCanonicalKey: canonicalKey,
      capturedInSnapshotId: newSnapshotId,
      wiseTeacherId: prior.wiseTeacherId,
      wiseSessionId: prior.wiseSessionId,
      startTime: prior.startTime,
      endTime: prior.endTime,
      weekday: prior.weekday,
      startMinute: prior.startMinute,
      endMinute: prior.endMinute,
      wiseStatus: prior.wiseStatus,
      isBlocking: prior.isBlocking,
      title: prior.title,
      sessionType: prior.sessionType,
      location: prior.location,
      studentName: prior.studentName,
      subject: prior.subject,
      classType: prior.classType,
      recurrenceId: prior.recurrenceId,
    });
  }

  // 7. Chunked insert with ON CONFLICT DO NOTHING (D-03 / PAST-05).
  let capturedCount = 0;
  for (let i = 0; i < droppedRows.length; i += INSERT_CHUNK_SIZE) {
    const chunk = droppedRows.slice(i, i + INSERT_CHUNK_SIZE);
    const result = await db
      .insert(schema.pastSessionBlocks)
      .values(chunk)
      .onConflictDoNothing({ target: schema.pastSessionBlocks.wiseSessionId })
      .returning({ id: schema.pastSessionBlocks.id });
    capturedCount += result.length;
  }

  return {
    capturedCount,
    issues,
    durationMs: Date.now() - startedAt,
  };
}
```

Then create the test file `src/lib/sync/__tests__/past-sessions-diff-hook.test.ts` with test cases matching the behavior list above. Use Vitest's `vi.mock` or an in-file mock Database object (mirror `modality-counter.test.ts` pattern — avoid importing `next/server` or full orchestrator to prevent framework-import issues).

Test scaffold:
```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runPastSessionsDiffHook } from "../past-sessions-diff-hook";
import type { NormalizedSessionBlock } from "@/lib/normalization/sessions";

// Minimal mock-DB helper — returns a `db` object with the Drizzle surface the
// hook uses (select/insert chains). Tracks inserted rows in a Map for
// ON CONFLICT DO NOTHING assertions.
function makeMockDb(opts: {
  priorSnapshotId: string | null;
  priorGroups: { id: string; canonicalKey: string }[];
  priorBlocks: Array<{ groupId: string; wiseSessionId: string; startTime: Date; /* ... other fields */ }>;
  existingPastRows: Set<string>; // wise_session_ids already in past_session_blocks
}) { /* ... */ }

describe("runPastSessionsDiffHook", () => {
  it("captures dropped past sessions from prior snapshot", async () => { /* Test 1 */ });
  it("is idempotent across repeat invocations (ON CONFLICT DO NOTHING)", async () => { /* Test 2 */ });
  it("returns early when no prior active snapshot exists", async () => { /* Test 3 */ });
  it("does not capture sessions whose startTime is still in the future", async () => { /* Test 4 */ });
  it("emits completeness data_issue when canonical_key cannot be resolved", async () => { /* Test 5 */ });
  it("does not capture sessions still present in the new Wise response", async () => { /* Test 6 */ });
});
```

Fill in concrete expectations; don't leave `/* ... */` placeholders in the final code. Use small fixed dates (e.g., `new Date("2026-04-01T10:00:00+07:00")` for past, `new Date("2099-01-01T00:00:00+07:00")` for future-far) so time-dependent assertions are stable.

Do NOT add any `'use cache'` directive to this file — diff-hook runs inside the sync pipeline (not an HTTP request), caching would be incorrect.
Do NOT invoke `revalidateTag` from inside this file — cache invalidation is the caller's responsibility (orchestrator handles `revalidateTag("snapshot")` elsewhere).
  </action>
  <verify>
    <automated>npm test -- src/lib/sync/__tests__/past-sessions-diff-hook.test.ts --run</automated>
  </verify>
  <acceptance_criteria>
    - File `src/lib/sync/past-sessions-diff-hook.ts` exists
    - `grep -c "export async function runPastSessionsDiffHook" src/lib/sync/past-sessions-diff-hook.ts` returns `1`
    - `grep -c "\.onConflictDoNothing({ target: schema.pastSessionBlocks.wiseSessionId })" src/lib/sync/past-sessions-diff-hook.ts` returns `1`
    - `grep -c "toZonedTime.*Asia/Bangkok" src/lib/sync/past-sessions-diff-hook.ts` returns `1`
    - `grep -c "if (newWiseSessionIds.has(prior.wiseSessionId)) continue" src/lib/sync/past-sessions-diff-hook.ts` returns `1`
    - `grep -c "if (prior.startTime >= nowBkk) continue" src/lib/sync/past-sessions-diff-hook.ts` returns `1`
    - File `src/lib/sync/__tests__/past-sessions-diff-hook.test.ts` exists
    - `grep -c "it(\"" src/lib/sync/__tests__/past-sessions-diff-hook.test.ts` returns at least `6` (six test cases)
    - `npm test -- src/lib/sync/__tests__/past-sessions-diff-hook.test.ts --run` exits `0` with all tests passing
    - `grep -c "'use cache'" src/lib/sync/past-sessions-diff-hook.ts` returns `0` (no cache directive)
    - `grep -c "revalidateTag" src/lib/sync/past-sessions-diff-hook.ts` returns `0` (no cache invalidation)
  </acceptance_criteria>
  <done>Helper file exports `runPastSessionsDiffHook` with correct D-01 diff algorithm and D-03 idempotency; 6 test cases pass.</done>
</task>

<task type="auto">
  <name>Task 2: Integrate diff-hook call into orchestrator.ts and persist observability</name>
  <files>src/lib/sync/orchestrator.ts</files>
  <read_first>
    - src/lib/sync/orchestrator.ts (full file — target insertion point is between line 386 MOD-01 loop end and line 388 `for (const row of recurringAvailabilityRows)`; observability lands in the syncRuns update at lines 466-474)
    - src/lib/sync/past-sessions-diff-hook.ts (just-created from Task 1 — confirm exported names)
  </read_first>
  <action>
Add two modifications to `src/lib/sync/orchestrator.ts`:

**Modification A — Import at top of file (after line 18):**
Add after the existing `import { detectSessionModalityConflict } from "@/lib/search/compare";` line:
```typescript
import { runPastSessionsDiffHook } from "@/lib/sync/past-sessions-diff-hook";
```

**Modification B — Insert the diff-hook call between the MOD-01 contradiction loop (ends at line 386) and the `for (const row of recurringAvailabilityRows)` modality backfill (starts at line 388):**

At the current line 387 (blank line between the two blocks), insert:

```typescript
    // ── 9.5. PAST-01 diff-hook ──
    // Capture sessions dropped from Wise FUTURE into past_session_blocks.
    // MUST run BEFORE atomic promotion (step 12, line 450) — the prior
    // snapshot must still be active=true when the hook reads it.
    //
    // Per-group errors emit completeness data_issues but do not abort the
    // sync (error-isolation matches the MOD-01 loop above).
    const diffHookResult = await runPastSessionsDiffHook(db, sessionBlocks, snapshotId);
    allIssues.push(
      ...diffHookResult.issues.map((i) => ({
        snapshotId: i.snapshotId,
        type: i.type,
        severity: i.severity,
        entityType: i.entityType,
        entityId: i.entityId,
        entityName: i.entityName,
        message: i.message,
      })),
    );
```

**Modification C — Persist observability to `sync_runs.metadata`:**

Find the `db.update(schema.syncRuns).set({ status: "success", ... })` block at lines 466-474. Add a `metadata` field to the `.set({...})` object so the persisted row captures `diffHookDurationMs` and `capturedCount`:

Replace the existing:
```typescript
      .set({
        status: "success",
        finishedAt: new Date(),
        promotedSnapshotId,
        teacherCount: wiseTeachers.length,
      })
```

With:
```typescript
      .set({
        status: "success",
        finishedAt: new Date(),
        promotedSnapshotId,
        teacherCount: wiseTeachers.length,
        metadata: {
          diffHookDurationMs: diffHookResult.durationMs,
          pastSessionsCapturedCount: diffHookResult.capturedCount,
        },
      })
```

Do NOT modify any other line. Do NOT change the insertion-chunks block at lines 392-411. Do NOT move the atomic promotion block. Do NOT wrap the diff-hook call in a try/catch — the hook itself never throws (per Task 1 contract); any DB failure propagates to the top-level catch at line 487 and marks the sync as `"failed"`, which is the correct behavior.

Do NOT add the diff-hook to the per-teacher availability loop (lines 147-251) — research §"Alternatives Considered" confirms batched post-loop is the correct shape.
  </action>
  <verify>
    <automated>npm test 2>&1 | tail -20 && grep -c "await runPastSessionsDiffHook" src/lib/sync/orchestrator.ts</automated>
  </verify>
  <acceptance_criteria>
    - `grep -c "import { runPastSessionsDiffHook } from \"@/lib/sync/past-sessions-diff-hook\"" src/lib/sync/orchestrator.ts` returns `1`
    - `grep -c "await runPastSessionsDiffHook(db, sessionBlocks, snapshotId)" src/lib/sync/orchestrator.ts` returns `1`
    - `grep -c "diffHookDurationMs: diffHookResult.durationMs" src/lib/sync/orchestrator.ts` returns `1`
    - `grep -c "pastSessionsCapturedCount: diffHookResult.capturedCount" src/lib/sync/orchestrator.ts` returns `1`
    - The line number of `await runPastSessionsDiffHook` is strictly less than the line number of `await db.update(schema.snapshots).set({ active: false })` (verified via `grep -n`) — confirms diff-hook runs BEFORE atomic promotion
    - `npx tsc --noEmit 2>&1 | grep -c "error TS" | head -1` returns `0`
    - `npm test --run` exits `0` with at least 246 tests passing (247+ once Task 1 tests added)
    - No existing test deleted or skipped (count diff only additive)
  </acceptance_criteria>
  <done>Orchestrator calls diff-hook after MOD-01 loop, before atomic promotion; observability persisted to sync_runs.metadata; all tests pass.</done>
</task>

</tasks>

<verification>
- `npm test --run` exits 0 with 252+ passing (246 baseline + 6 new diff-hook tests)
- `grep -c "onConflictDoNothing" src/lib/sync/past-sessions-diff-hook.ts` returns `1`
- Insertion point: `await runPastSessionsDiffHook` appears in orchestrator.ts at a line number LESS than the atomic promotion block (line ~450)
- `grep -c "past_session_blocks\\|pastSessionBlocks" src/lib/search/index.ts` returns `0` (regression guard for D-18)
</verification>

<success_criteria>
- Diff-hook captures dropped past-start sessions from prior snapshot into past_session_blocks with ON CONFLICT DO NOTHING
- Double-observation results in exactly one row (first-observation wins)
- First-ever sync (no prior snapshot) returns 0 captured without error
- Unresolved canonical_key emits completeness data_issue; hook does not throw
- Orchestrator integration runs BEFORE atomic promotion
- sync_runs.metadata persists diffHookDurationMs + pastSessionsCapturedCount
- All existing tests continue to pass; 6 new tests added
</success_criteria>

<output>
After completion, create `.planning/phases/07-past-01-past-day-session-visibility/07-02-SUMMARY.md` documenting:
- New file created (past-sessions-diff-hook.ts, LOC count)
- Orchestrator insertion point (exact line number post-edit)
- Test count delta (246 → 252)
- Any deviations from the research blueprint (note in "Decisions" section)
</output>
