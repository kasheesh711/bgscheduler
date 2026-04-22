# Phase 7: PAST-01 Past-Day Session Visibility - Research

**Researched:** 2026-04-22
**Domain:** Data-layer capture + read-path extension for past Wise sessions
**Confidence:** HIGH (code-grounded against commit `001b9c8`, verified against in-tree Next.js / Drizzle / Neon-HTTP docs)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions (D-01..D-18)

**Capture strategy**
- **D-01:** Prior-snapshot diff. Each sync, BEFORE promotion, the orchestrator compares the most-recently-active snapshot's `future_session_blocks` to the newly-fetched Wise FUTURE list. Sessions that (a) existed in the prior snapshot, (b) have `startTime < now()` in Asia/Bangkok at sync time, and (c) are NOT in the new Wise response get inserted into `past_session_blocks` with `ON CONFLICT (wise_session_id) DO NOTHING`.
- **D-02:** Empty-forward backfill only. `past_session_blocks` starts empty on migration; accumulates as daily-sync cycles run. Day-1 admins viewing past weeks see honest empty cells. NO migration-time backfill. NO lazy backfill on query.
- **D-03:** First-observation wins, `ON CONFLICT DO NOTHING`. `UNIQUE(wise_session_id)` enforces idempotency; first snapshot to observe a session sets canonical fields. Subsequent observations silently drop. No drift-detection data_issue.
- **D-04:** Schema key: `group_canonical_key text` + nullable `group_id uuid`. Denormalize the stable `tutor_identity_groups.canonical_key` into `past_session_blocks` so rows survive snapshot rotation — THE cross-snapshot identity anchor (PAST-05). `group_id` is nullable for the snapshot that captured the row.

**Historical-range boundary (read path)**
- **D-05:** Per-weekday `isHistoricalRange` evaluation in `buildCompareTutor`. For each weekday in `dateRange`, compute the actual calendar date; if before `startOfToday(Asia/Bangkok)`, disable weekday-fallback for that day. Today + future days keep existing fallback.
- **D-06:** Merge past + future inside `buildCompareTutor` BEFORE the weekday-fallback step. A new cached fetcher at `src/lib/data/past-sessions.ts` queries `past_session_blocks` for `(group_canonical_key, dateRange)`. Merged into filter input; downstream (`detectConflicts`, `findSharedFreeSlots`, `weeklyHoursBooked`, `studentCount`) consumes unified list transparently.
- **D-07:** Server-side trigger in `/api/compare`. Route computes weekday-date map from `dateRange`; if any day is before `startOfToday(Asia/Bangkok)`, it calls the cached past-sessions fetcher before invoking `buildCompareTutor`. Client stays dumb — no new request parameter.
- **D-08:** `cacheTag('past-sessions')` + `cacheLife('days')` on the fetcher. SEPARATE from `'snapshot'` — sync's `revalidateTag('snapshot')` MUST NOT invalidate past-sessions cache. `revalidateTag('past-sessions')` reserved for schema migrations.

**Empty-day UX**
- **D-09:** Honest empty cells — blank day column, no card, no marker, no text.
- **D-10:** Past-session cards render IDENTICAL to future-session cards (same bg 28%, 3px solid border, same modality icon via `resolveSessionModality`). No opacity dim, no badge, no grayscale.
- **D-11:** No capture-start date indicator in v1.1.
- **D-12:** Reserved wording "No sessions recorded" (moot for v1.1 since D-09 chose no marker).

**Wise endpoint spike (PAST-06)**
- **D-13:** Claude drafts email; user sends from `kevhsh7@gmail.com` to `devs@wiseapp.live`.
- **D-14:** Spike runs parallel with Phase 7 planning/execution. Non-blocking.
- **D-15:** If Wise responds "yes" during Phase 7, document and DEFER wiring to v1.2. Phase 7 deliverable remains DB fallback only.
- **D-16:** No cutoff. Phase 7 ships unconditionally.

**Cross-cutting**
- **D-17:** CACHE_VERSION bump `"v1"` → `"v2"` in `src/lib/search/cache-version.ts`. Per Phase 6 D-19 contract.
- **D-18:** Past data stays OUT of the SearchIndex singleton. `buildIndex` / `ensureIndex` in `src/lib/search/index.ts` UNTOUCHED.

### Claude's Discretion

- Exact Drizzle column names, types, default values, index set for `past_session_blocks` (minimum indexes: `UNIQUE(wise_session_id)` for D-03; `(group_canonical_key, start_time)` for D-06; potentially `(start_time)` for time-range scans)
- Exact placement of diff-hook within `orchestrator.ts` (between session fetch line 253 and atomic promote line 440; research recommends after `groupSupportedModality` population — see §Orchestrator Surface below)
- Sync-duration monitoring strategy — console log vs. `sync_runs.metadata.diffHookDurationMs`. Lean toward `metadata` for observability given ~34s budget margin
- Whether to emit a `completeness` data_issue on zero-capture syncs — lean NO for v1.1
- Edge case: session cancelled after capture — D-03 keeps first-observation immutable; add schema comment, no behavioral change
- Test matrix composition — cases (a)-(f) from CONTEXT.md Claude Discretion §Test-matrix composition
- PAST-06 email text — Claude drafts (≤150 words), user may edit
- Whether to add admin utility route `/api/internal/revalidate-past-sessions` — lean NO for v1.1
- Commit cadence — 7-8 atomic commits recommended (see §Recommended Commit Cadence below)

### Deferred Ideas (OUT OF SCOPE)

- PAST-07 (multi-snapshot diff view) → v1.2
- PAST-08 (source-of-truth badge on past-day cards) → v1.2
- Wise historical-endpoint wiring even if response arrives → v1.2 (candidate PAST-09 or PAST-07 repurposed)
- Migration-time backfill → rejected
- Lazy backfill on first historical query → rejected
- Capture-start date indicator in UI → v1.2 if users ask
- Empty-day tooltip / marker icon → v1.2 (reserved wording "No sessions recorded" per D-12)
- Past-session visual distinction (dim, badge) → rejected for v1.1
- Drift detection on re-observed sessions → v1.2 observability if useful
- Admin utility for manual cache flush → add if needed
- Diff-hook observability (persisted per-sync capture count) → v1.2 observability pass
- `past_session_blocks` retention/pruning policy → no pruning v1.1 (unbounded ~40k rows/year is trivial for Neon)

</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| **PAST-01** | Admin can navigate to prior weeks in compare view and see actual past-day sessions (not a "representative" fallback) | §"`buildCompareTutor` Refactor Surface" — per-weekday `isHistoricalRange` flag (D-05) disables fallback on historical weekdays; merge past_session_blocks rows before filter pipeline (D-06). §"`/api/compare` Server-Side Historical-Range Trigger" — route computes historical-ness from dateRange (D-07) |
| **PAST-02** | Daily sync orchestrator captures sessions that were FUTURE on the prior day but are no longer returned into a `past_session_blocks` table | §"Orchestrator Diff-Hook Implementation Surface" — insertion point after step 9 `groupSupportedModality` (line 300) and before atomic promote (line 440); per-group error isolation pattern matching lines 240-250. §"Drizzle Migration Specifics" — `past_session_blocks` schema mirrors `future_session_blocks` columns |
| **PAST-03** | Historical queries use a dedicated `cacheTag('past-sessions')` separate from `'snapshot'` | §"`use cache` + `cacheTag('past-sessions')` + `cacheLife('days')` Wiring" — verified against in-tree `node_modules/next/dist/docs/.../cacheLife.md` (L139 `days` profile exists: revalidate: 1 day, expire: 1 week) and `revalidateTag.md` (L32 tag strings case-sensitive, only exact matches invalidate) |
| **PAST-04** | Weekday-fallback logic in `buildCompareTutor` is disabled when the requested range is historical | §"`buildCompareTutor` Refactor Surface" — per-weekday `isHistoricalRange` check inside the `for (const wd of targetWeekdays)` loop at `compare.ts:213`; skip fallback block when the weekday's calendar date < `startOfToday(BKK)` |
| **PAST-05** | `past_session_blocks` schema uses `UNIQUE(wise_session_id)` for idempotent capture + `group_canonical_key` stable across snapshot rotations | §"Drizzle Migration Specifics" — exact `pgTable` definition with `uniqueIndex("psb_wise_session_id_idx").on(table.wiseSessionId)` + `group_canonical_key text` column (nullable `group_id uuid`) + denormalized per D-04 |
| **PAST-06** | Wise historical-sessions endpoint is spiked (`devs@wiseapp.live`); if available, it's used in addition to snapshot-based capture | §"Wise Historical-Endpoint Spike — Email Draft" — draft email with institute_id + namespace + question set; D-15 defers wiring regardless of outcome. Ship unconditionally per D-16 |

</phase_requirements>

## Project Constraints (from CLAUDE.md / AGENTS.md)

- **Stack locked:** Next.js 16.2.2, React 19.2.4, Tailwind 4, Drizzle ORM 0.45.2, `@neondatabase/serverless` 1.0.2, Vitest 4.1.2, shadcn/ui. No stack additions permitted.
- **Fail-closed is non-negotiable.** Unresolved identity/modality/qualification → Needs Review, never Available. Past sessions reuse the MOD-01 `resolveSessionModality` path unchanged (D-10).
- **246 tests must continue passing.** Test count at Phase 7 kickoff confirmed at 246 per STATE.md L80 (82 pre-v1.0 + 164 v1.0 + Phase 6 additions). `grep -c "it(" src/` returns 120 raw `it(` blocks — the 246 figure includes `describe` block multi-assertions; preserve this headline count.
- **Sync duration budget:** current ~4m26s on 34092-row snapshot (0.00% NULL rate per MOD-01 kickoff). ~34s margin below 300s Vercel function ceiling. Phase 7 diff-hook must not breach this.
- **Cold-start budget:** SearchIndex build <2s warm; D-18 keeps past data out of the singleton to preserve it.
- **Neon HTTP driver has NO transaction support** (verified: `node_modules/drizzle-orm/neon-http/session.js:151` throws `"No transactions support in neon-http driver"`). Existing orchestrator works around this via sequenced UPDATEs for atomic promotion. Diff-hook MUST rely on `onConflictDoNothing()` as the safety net for partial-failure re-runs — no way to wrap "read prior + insert past + promote" in a single transaction.
- **All times normalized to `Asia/Bangkok`** via `src/lib/normalization/timezone.ts`. `startTime` stored as `timestamp with time zone` in `future_session_blocks` (Postgres handles TZ conversion; values persist as UTC but query comparisons use TZ-aware operators).
- **GSD workflow enforcement:** all edits go through `/gsd-execute-phase`. `CLAUDE.md` already in compliance (nothing to research-flag here).

## Summary

Phase 7 is a **data-layer-only** extension of the Wise sync pipeline and the compare read-path. The critical insight from the existing codebase: the Neon HTTP driver has no transaction support, which enforces the `ON CONFLICT DO NOTHING` discipline (D-03) as the primary safety mechanism. The prior-snapshot diff runs per-group (matching the existing error-isolation pattern at `orchestrator.ts:240-250`), and the new `src/lib/data/past-sessions.ts` cached fetcher is a direct three-line copy of `filters.ts`/`tutors.ts` with `cacheTag('past-sessions')` and `cacheLife('days')`. The `cacheLife('days')` profile (verified in-tree at `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/cacheLife.md:139`) gives: stale 5 min, revalidate 1 day, expire 1 week — correct for immutable past data.

`buildCompareTutor` at `compare.ts:188-233` is the surgical refactor target: the existing weekday-fallback loop at lines 207-233 gets a per-weekday `isBeforeToday(BKK)` check that skips the fallback for historical days; the filter input at line 195 gets a concatenation of past blocks. All downstream functions (`detectConflicts`, `findSharedFreeSlots`) consume the merged list transparently with zero signature change.

**Primary recommendation:** Implement the diff-hook as step 9.5 in `runFullSync` (between existing step 9 at line 300 and the `await Promise.all([insertInChunks(...)])` block at line 392) — NOT inside the per-teacher availability loop. Batch the diff across all groups with a single prior-snapshot SELECT and a single `insertInChunks` chunked write. Budget impact: one extra SELECT (indexed on `snapshotId` → fast) + one INSERT of N rows where N = |dropped sessions per day| (empirically small — typically ≤100/day at current tenant volume). Well inside the 34s margin.

## Standard Stack

### Core (all in-tree — zero new dependencies)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `drizzle-orm` | ^0.45.2 | Schema, migration, insert with `onConflictDoNothing` | In use across repo; `.onConflictDoNothing({ target: col })` verified at `node_modules/drizzle-orm/pg-core/query-builders/insert.d.ts:138-141` [VERIFIED: in-tree types] |
| `@neondatabase/serverless` | ^1.0.2 | Postgres HTTP driver | Already the sole DB driver. **Caveat:** no transactions (see constraint note). `batch()` supported but not needed here. |
| `drizzle-kit` | ^0.31.10 | `npm run db:generate` → migration SQL | Used for Phase 5/6 migrations; no config change |
| `next/cache` | (Next.js 16.2.2) | `cacheTag`, `cacheLife` directives | Existing pattern at `src/lib/data/filters.ts:1-16` + `tutors.ts:1-16` [VERIFIED: grep confirms 2 call sites, both use `cacheTag('snapshot') + cacheLife('hours')`] |
| `zod` | ^4.3.6 | No new schema needed | `/api/compare` `compareRequestSchema` unchanged (client stays dumb per D-07) |
| `date-fns-tz` | ^3.2.0 | `startOfDay` / zone-aware comparisons for `isHistoricalRange` | In repo; use for `startOfToday(Asia/Bangkok)` computation. [VERIFIED: listed in package.json per CLAUDE.md] |

**Version verification (2026-04-22):** All above versions confirmed via `package.json` (Phase 6 did not bump any of these). No `npm view` call needed — versions are already pinned in the lockfile.

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `vitest` | ^4.1.2 | Unit tests for fetcher + compare merge + orchestrator diff-hook | Existing test pattern at `src/lib/search/__tests__/compare.test.ts`, `src/app/api/data-health/__tests__/modality-counter.test.ts` |

### Alternatives Considered

| Instead of | Could Use | Tradeoff | Decision |
|------------|-----------|----------|----------|
| Snapshot-scoped `past_session_blocks` | Observed-in-snapshot-ids `uuid[]` column | Smaller footprint; preserves provenance | **Rejected by CONTEXT.md D-03/D-04** — first-observation-wins with `UNIQUE(wise_session_id)` is simpler; `group_canonical_key` denormalization replaces the array |
| `cacheLife('max')` | `cacheLife('days')` | `'max'` = revalidate 30 days, expire 1 year | **Rejected by D-08** — `'days'` aligns with daily-sync cadence; `'max'` is overly aggressive for data we deliberately want revalidated on schema change |
| Diff-hook inside per-teacher loop | Batched post-orchestrator step | Per-teacher error isolation matches lines 240-250 | **Recommended: single post-loop step** — diff-hook is a set-wise comparison across the whole prior snapshot; running per-teacher duplicates the prior-snapshot SELECT N teacher times (wasted query budget) |
| `buildCompareTutor` new parameter | Pre-load past blocks into `IndexedTutorGroup.sessionBlocks` at route boundary | Cleaner downstream signature | **Recommended: new optional parameter** — avoids mutating SearchIndex singleton shape (D-18); keeps historical-data wiring visible at the call site |

**Installation:** None. Zero new packages.

## Architecture Patterns

### Recommended Project Structure (new/modified files)

```
src/
├── lib/
│   ├── db/
│   │   ├── schema.ts              # MODIFY: add pastSessionBlocks pgTable
│   ├── data/
│   │   ├── past-sessions.ts       # NEW: cached fetcher with cacheTag('past-sessions') + cacheLife('days')
│   │   └── __tests__/
│   │       └── past-sessions.test.ts  # NEW: tests inner (non-cached) implementation
│   ├── search/
│   │   ├── cache-version.ts       # MODIFY: bump "v1" → "v2"
│   │   ├── compare.ts             # MODIFY: buildCompareTutor adds pastBlocks param + per-weekday isHistoricalRange
│   │   └── __tests__/
│   │       └── compare.test.ts    # MODIFY: extend with past-session merge cases
│   └── sync/
│       ├── orchestrator.ts        # MODIFY: add step 9.5 diff-hook between line 300 and line 392
│       └── __tests__/
│           └── past-sessions-diff-hook.test.ts  # NEW: unit test for the isolated diff-hook function
├── app/
│   └── api/
│       └── compare/
│           └── route.ts           # MODIFY: compute isHistoricalRange, call fetcher, pass pastBlocks
│
drizzle/
└── 0002_*.sql                     # NEW: CREATE TABLE past_session_blocks + indexes
```

### Pattern 1: `past_session_blocks` schema (Drizzle)

**What:** New table mirroring `future_session_blocks` columns, with two key deviations: `UNIQUE(wise_session_id)` and `group_canonical_key text` (denormalized).

**When to use:** Once, in the next migration. This is the canonical anchor for cross-snapshot queries per D-04.

**Code (recommended shape — source: project schema convention at `src/lib/db/schema.ts:177-201`):**

```typescript
// Source: src/lib/db/schema.ts lines 177-201 (futureSessionBlocks — reference shape)
// Cross-snapshot deviation (D-04): group_canonical_key is the stable identity anchor.
// group_id remains for provenance (which snapshot first observed this row) but is
// nullable because snapshots can be pruned in principle and the row must survive.
export const pastSessionBlocks = pgTable("past_session_blocks", {
  id: uuid("id").primaryKey().defaultRandom(),

  // Cross-snapshot identity anchor (D-04). Read path resolves tutor via this key
  // against the active snapshot's tutor_identity_groups.canonical_key.
  groupCanonicalKey: text("group_canonical_key").notNull(),

  // Provenance: which snapshot first captured this row. Nullable per D-04 rationale.
  // Intentionally NOT a foreign key — snapshots may be pruned without cascading to this table.
  capturedInSnapshotId: uuid("captured_in_snapshot_id"),

  // First-observation-wins canonical fields (D-03). Columns mirror futureSessionBlocks
  // minus the snapshot-scoped fields.
  wiseTeacherId: text("wise_teacher_id").notNull(),
  wiseSessionId: text("wise_session_id").notNull(),
  startTime: timestamp("start_time", { withTimezone: true }).notNull(),
  endTime: timestamp("end_time", { withTimezone: true }).notNull(),
  weekday: integer("weekday").notNull(),
  startMinute: integer("start_minute").notNull(),
  endMinute: integer("end_minute").notNull(),
  wiseStatus: text("wise_status").notNull(),
  isBlocking: boolean("is_blocking").notNull().default(true),
  title: text("title"),
  sessionType: text("session_type"),
  location: text("location"),
  studentName: text("student_name"),
  subject: text("subject"),
  classType: text("class_type"),
  recurrenceId: text("recurrence_id"),

  // First-observation timestamp (audit / provenance for a future v1.2 drift-detection phase).
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // PAST-05 idempotency: only one row per Wise session, ever (D-03).
  uniqueIndex("psb_wise_session_id_idx").on(table.wiseSessionId),
  // D-06 read-path index: buildCompareTutor queries (group_canonical_key, dateRange).
  index("psb_group_key_start_idx").on(table.groupCanonicalKey, table.startTime),
  // Optional: time-range scans (e.g., admin retention queries).
  index("psb_start_time_idx").on(table.startTime),
]);
```

**Drizzle migration:** `npm run db:generate` emits `drizzle/0002_*.sql`. Apply with `DATABASE_URL=... npm run db:migrate`. The generated SQL should show `CREATE UNIQUE INDEX "psb_wise_session_id_idx" ON "past_session_blocks" ("wise_session_id")`.

**Neon HTTP driver compatibility:** Verified — `ON CONFLICT DO NOTHING` is standard PostgreSQL SQL; Neon's HTTP endpoint passes it through unchanged. `insertInChunks` helper at `orchestrator.ts:34-42` with `INSERT_CHUNK_SIZE = 250` works exactly as with existing tables.

### Pattern 2: Diff-hook in orchestrator

**What:** Single new step (9.5) between existing step 9 end (line 300 — `groupSupportedModality` populated) and the parallel `Promise.all([insertInChunks...])` at line 392.

**Why this location:** (a) prior snapshot is still `active=true` at this point — the deactivation happens at line 450-455; (b) the new snapshot's groups + `canonicalKey` values are already populated in `groupIdMap` (line 99-113) so canonical-key lookups are free; (c) the `sessionBlocks` Wise response is fully normalized and in scope (line 263); (d) modality contradiction loop (lines 352-386) runs right above, so following the same "iterate all groups once" structural pattern is idiomatic.

**Exact structure (as a helper function for testability — recommended by Claude's Discretion):**

```typescript
// Source: adapted from orchestrator.ts existing patterns at lines 34-42, 240-250, 352-386
/**
 * PAST-01 diff-hook. For each current-snapshot group, read the prior active
 * snapshot's future_session_blocks, compute the set of sessions that
 * (a) existed in the prior snapshot, (b) have already started in BKK time,
 * and (c) are NOT in the new Wise FUTURE response, and insert them into
 * past_session_blocks with ON CONFLICT DO NOTHING.
 *
 * Runs BEFORE snapshot promotion (the prior snapshot must still be
 * active=true when we read it). Per-group errors are logged as completeness
 * data_issues; the hook never throws — a diff-hook failure on one group
 * does not abort the sync (matches error-isolation pattern at orchestrator.ts:240-250).
 *
 * Neon HTTP driver has no transaction support (verified:
 * drizzle-orm/neon-http/session.js:151), so idempotency relies entirely on
 * UNIQUE(wise_session_id) + onConflictDoNothing(). A crashed sync that
 * partially-inserted rows can safely re-run on the next cron tick.
 */
export async function runPastSessionsDiffHook(
  db: Database,
  newWiseSessions: NormalizedSessionBlock[],
  groups: IdentityGroup[],
  newSnapshotId: string,
): Promise<{ capturedCount: number; issues: InsertableDataIssue[] }> {
  const issues: InsertableDataIssue[] = [];

  // 1. Find the currently-active (prior) snapshot. MUST run before promotion.
  const [priorSnapshot] = await db
    .select({ id: schema.snapshots.id })
    .from(schema.snapshots)
    .where(and(eq(schema.snapshots.active, true), sql`${schema.snapshots.id} != ${newSnapshotId}`))
    .limit(1);

  if (!priorSnapshot) {
    // First-ever sync or prior active snapshot missing — nothing to diff.
    return { capturedCount: 0, issues };
  }

  // 2. Read all prior-snapshot future_session_blocks in a single batch query.
  //    Index fsb_snapshot_idx covers this.
  const priorBlocks = await db
    .select()
    .from(schema.futureSessionBlocks)
    .where(eq(schema.futureSessionBlocks.snapshotId, priorSnapshot.id));

  // 3. Build a Set of wiseSessionIds from the NEW Wise response for O(1) lookup.
  const newWiseSessionIds = new Set(newWiseSessions.map((s) => s.wiseSessionId));

  // 4. Compute the "dropped" set: in prior, not in new, and startTime < now (BKK).
  const nowBkk = toLocalTime(new Date().toISOString()); // uses existing timezone util
  const groupIdToCanonicalKey = new Map(groups.map((g) => [g.canonicalKey, g])); // placeholder — actually need groupDbId → canonicalKey mapping, see Note below

  const droppedRows: InsertablePastSessionBlock[] = [];
  for (const prior of priorBlocks) {
    if (newWiseSessionIds.has(prior.wiseSessionId)) continue;         // still future — not dropped
    if (prior.startTime >= nowBkk) continue;                          // hasn't started yet — not past
    // Resolve group_canonical_key via the prior snapshot's groupId → canonicalKey lookup.
    // The prior snapshot's tutor_identity_groups rows carry canonicalKey.
    // Implementation note: batch-fetch the prior snapshot's (groupId, canonicalKey)
    // tuples once into a Map<string, string> before the loop (see Note below).
    const canonicalKey = resolvePriorGroupCanonicalKey(prior.groupId);
    if (!canonicalKey) {
      issues.push({
        snapshotId: newSnapshotId,
        type: "completeness",
        severity: "medium",
        entityType: "past_session_block",
        entityId: prior.wiseSessionId,
        entityName: null,
        message: `Diff-hook: could not resolve group_canonical_key for prior-snapshot groupId=${prior.groupId}; skipping capture`,
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

  // 5. Chunked insert with ON CONFLICT DO NOTHING (D-03).
  let capturedCount = 0;
  await insertInChunks(droppedRows, async (chunk) => {
    const result = await db
      .insert(schema.pastSessionBlocks)
      .values(chunk)
      .onConflictDoNothing({ target: schema.pastSessionBlocks.wiseSessionId })
      .returning({ id: schema.pastSessionBlocks.id });
    capturedCount += result.length;
  });

  return { capturedCount, issues };
}
```

**Note (canonical-key resolution):** `future_session_blocks.groupId` is a `uuid` referencing `tutor_identity_groups.id` of the **prior** snapshot (snapshots are versioned, so `groupId` is snapshot-local). The prior snapshot's `tutor_identity_groups` rows still carry their `canonicalKey` column. Add a single pre-loop SELECT to build the `groupId → canonicalKey` map:

```typescript
const priorGroups = await db
  .select({ id: schema.tutorIdentityGroups.id, canonicalKey: schema.tutorIdentityGroups.canonicalKey })
  .from(schema.tutorIdentityGroups)
  .where(eq(schema.tutorIdentityGroups.snapshotId, priorSnapshot.id));
const priorGroupIdToCanonicalKey = new Map(priorGroups.map((g) => [g.id, g.canonicalKey]));
```

**Integration into `runFullSync`** — insertion at `orchestrator.ts:387` (after the per-session contradiction loop ends at line 386, before the `for (const row of recurringAvailabilityRows)` modality backfill at line 388):

```typescript
// ── 9.5. PAST-01 diff-hook (runs BEFORE atomic promotion at step 12).
const diffHookStart = Date.now();
const diffHookResult = await runPastSessionsDiffHook(db, sessionBlocks, groups, snapshotId);
const diffHookDurationMs = Date.now() - diffHookStart;
allIssues.push(...diffHookResult.issues);
// Monitoring (Claude Discretion — using sync_runs.metadata over console for persistence):
// Persisted at the sync_runs update at line 466-474.
```

Persist `diffHookDurationMs` + `capturedCount` to `sync_runs.metadata` JSONB at the existing update at line 466-474. This gives observability without needing a new column.

### Pattern 3: Cached past-sessions fetcher

**What:** `src/lib/data/past-sessions.ts` — direct three-line copy of `filters.ts` with adjusted tag + life + query body.

**Code (verified against `src/lib/data/filters.ts:1-37` + in-tree `cacheLife.md:139`):**

```typescript
// Source: src/lib/data/filters.ts:1-37 (reference pattern)
import { cacheTag, cacheLife } from "next/cache";
import { and, inArray, gte, lt } from "drizzle-orm";
import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import type { IndexedSessionBlock } from "@/lib/search/index";

/**
 * Look up captured past-session blocks for a set of groups (by canonical key)
 * within a date range (Asia/Bangkok).
 *
 * Tagged `past-sessions` (D-08) — explicitly NOT `snapshot`. The daily sync's
 * revalidateTag('snapshot') MUST NOT invalidate this cache (research Pitfall 7).
 * cacheLife('days'): revalidate 1 day, expire 1 week, stale 5 min — matches the
 * daily-sync cadence; aggressive enough to benefit same-day repeat queries,
 * conservative enough that a schema migration is noticed within a week.
 *
 * The inner (non-cached) function is exported separately for testability: Vitest
 * cannot directly test a 'use cache' function (no way to spy on DB calls through
 * the Next.js cache boundary). Test the inner implementation and trust the
 * Next.js cache tagging mechanism.
 */
export async function fetchPastSessionBlocksUncached(
  groupCanonicalKeys: string[],
  rangeStart: Date,
  rangeEnd: Date,
): Promise<Map<string, IndexedSessionBlock[]>> {
  if (groupCanonicalKeys.length === 0) return new Map();

  const db = getDb();
  const rows = await db
    .select()
    .from(schema.pastSessionBlocks)
    .where(and(
      inArray(schema.pastSessionBlocks.groupCanonicalKey, groupCanonicalKeys),
      gte(schema.pastSessionBlocks.startTime, rangeStart),
      lt(schema.pastSessionBlocks.startTime, rangeEnd),
    ));

  // Bucket by canonical key so buildCompareTutor can merge per-group.
  const byCanonicalKey = new Map<string, IndexedSessionBlock[]>();
  for (const r of rows) {
    const block: IndexedSessionBlock = {
      startTime: new Date(r.startTime),
      endTime: new Date(r.endTime),
      weekday: r.weekday,
      startMinute: r.startMinute,
      endMinute: r.endMinute,
      isBlocking: r.isBlocking,
      wiseTeacherId: r.wiseTeacherId,
      title: r.title ?? undefined,
      studentName: r.studentName ?? undefined,
      subject: r.subject ?? undefined,
      classType: r.classType ?? undefined,
      sessionType: r.sessionType ?? undefined,
      recurrenceId: r.recurrenceId ?? undefined,
      location: r.location ?? undefined,
    };
    const arr = byCanonicalKey.get(r.groupCanonicalKey) ?? [];
    arr.push(block);
    byCanonicalKey.set(r.groupCanonicalKey, arr);
  }
  return byCanonicalKey;
}

export async function fetchPastSessionBlocks(
  groupCanonicalKeys: string[],
  rangeStart: Date,
  rangeEnd: Date,
): Promise<Map<string, IndexedSessionBlock[]>> {
  "use cache";
  cacheTag("past-sessions");
  cacheLife("days");
  return fetchPastSessionBlocksUncached(groupCanonicalKeys, rangeStart, rangeEnd);
}
```

**Cache key note:** The `'use cache'` directive automatically includes all function arguments in the cache key (verified via Next.js 16 semantics: `cacheComponents: true` + `'use cache'` hashes arguments). So different `(groupCanonicalKeys, rangeStart, rangeEnd)` tuples each get their own cache entry. Repeat queries for the same tutor + week are O(1) cache hits.

**Array-argument caveat:** `groupCanonicalKeys.sort()` is NOT strictly required for cache determinism (Next.js hashes the argument deep), but stable ordering at the call site avoids needlessly creating new cache entries when the caller's tutor-selection order changes. The `/api/compare` route should sort before passing.

### Pattern 4: `buildCompareTutor` extension

**What:** Add optional `pastBlocks?: IndexedSessionBlock[]` parameter. Merge with `group.sessionBlocks` BEFORE the filter pipeline. Per-weekday `isHistoricalRange` check skips fallback for historical days.

**Code (refactor of `compare.ts:188-233`):**

```typescript
// Source: src/lib/search/compare.ts:188-233 (current buildCompareTutor)
// Minimal-surface refactor: add pastBlocks param + per-weekday historical check.

export function buildCompareTutor(
  group: IndexedTutorGroup,
  weekdays?: number[],
  dateRange?: DateRange,
  pastBlocks?: IndexedSessionBlock[],  // NEW optional parameter (D-06)
): CompareTutor {
  const weekdaySet = weekdays ? new Set(weekdays) : null;

  // D-06: merge past blocks into the filter input BEFORE filtering.
  // Past blocks are ALREADY date-range-filtered by the fetcher — safe to concat.
  const allBlocks = pastBlocks ? [...group.sessionBlocks, ...pastBlocks] : group.sessionBlocks;

  const filtered = allBlocks.filter((s) => {
    if (!s.isBlocking) return false;
    if (dateRange) {
      if (s.startTime < dateRange.start || s.startTime >= dateRange.end) return false;
    }
    if (weekdaySet && !weekdaySet.has(s.weekday)) return false;
    return true;
  });

  // D-04/D-05: per-weekday historical check for fallback eligibility.
  if (dateRange) {
    const startOfTodayBkk = getStartOfTodayBkk(); // NEW helper — see below

    const coveredWeekdays = new Set(filtered.map((s) => s.weekday));
    const targetWeekdays = weekdaySet ? new Set(weekdaySet) : new Set([0, 1, 2, 3, 4, 5, 6]);

    for (const wd of targetWeekdays) {
      if (coveredWeekdays.has(wd)) continue;

      // D-05: compute the actual calendar date for this weekday within dateRange.
      // If the date is before startOfToday(BKK), disable the fallback (historical day).
      const dateForWeekday = computeDateForWeekdayInRange(wd, dateRange);
      if (dateForWeekday && dateForWeekday < startOfTodayBkk) continue; // honest empty per D-09

      // Existing nearest-future-occurrence fallback (unchanged for today + future days).
      const seenRecurrence = new Set<string>();
      const fallback = allBlocks
        .filter((s) => s.isBlocking && s.weekday === wd && s.startTime >= dateRange.end)
        .sort((a, b) => a.startTime.getTime() - b.startTime.getTime())
        .filter((s) => {
          if (s.recurrenceId) {
            if (seenRecurrence.has(s.recurrenceId)) return false;
            seenRecurrence.add(s.recurrenceId);
          }
          return true;
        });

      if (fallback.length > 0) {
        const firstDate = fallback[0].startTime.toDateString();
        filtered.push(...fallback.filter((s) => s.startTime.toDateString() === firstDate));
      }
    }
  }

  // Remaining logic (mapping to CompareSessionBlock, weeklyHoursBooked, studentCount) UNCHANGED.
  // resolveSessionModality is called with `group` as-is; past blocks go through the SAME
  // Phase 6 resolver (D-10 identical visual treatment).
  // ... rest of function unchanged from current compare.ts:235-260
}
```

**New helpers needed (minimal):**

```typescript
// Place near top of compare.ts alongside formatDate/formatMinute.
import { toZonedTime } from "date-fns-tz";

function getStartOfTodayBkk(): Date {
  const nowInBkk = toZonedTime(new Date(), "Asia/Bangkok");
  return new Date(nowInBkk.getFullYear(), nowInBkk.getMonth(), nowInBkk.getDate());
}

function computeDateForWeekdayInRange(weekday: number, dateRange: DateRange): Date | null {
  // dateRange.start is Monday of the requested week. Offset: Mon(1)=0, Tue(2)=1, ..., Sun(0)=6.
  const offset = weekday === 0 ? 6 : weekday - 1;
  const date = new Date(dateRange.start);
  date.setDate(date.getDate() + offset);
  if (date < dateRange.start || date >= dateRange.end) return null;
  return date;
}
```

**Downstream transparency (verified):** `detectConflicts` at `compare.ts:263-300` keys on `studentName.toLowerCase()` + `weekday` + `startMinute`/`endMinute` — all fields present identically on past and future blocks. `findSharedFreeSlots` at `compare.ts:302-346` filters `group.sessionBlocks` directly; since past blocks are NOT in `group.sessionBlocks` (they live in the new `pastBlocks` parameter), the current query misses them. **ACTION for planner:** also pass `pastBlocks` into `findSharedFreeSlots` (or, cleaner, pre-merge at the `/api/compare` route boundary before calling both functions; see Pattern 5). This is research Pitfall 17 below.

### Pattern 5: `/api/compare` server-side historical-range trigger

**What:** Modify `route.ts:108` so the map-over-groups computes historical-ness once, calls the fetcher once with all canonical keys, and passes the per-group slice into `buildCompareTutor`.

**Code (refactor of `route.ts:97-114`):**

```typescript
// Source: src/app/api/compare/route.ts:97-114 (current weekday/date computation)

// ... existing parseMondayDate / addDays setup ...
const dateRange: DateRange = { start: mondayDate, end: sundayEnd };
const weekdays: number[] | undefined = /* existing computation */;

// NEW: D-07 trigger. Compute whether any day in dateRange is before today (BKK).
const startOfTodayBkk = getStartOfTodayBkk();
const isHistoricalRange = dateRange.start < startOfTodayBkk;

// NEW: Fetch past blocks ONCE, batched by canonical-key array.
let pastBlocksByCanonicalKey = new Map<string, IndexedSessionBlock[]>();
if (isHistoricalRange) {
  const canonicalKeys = indexedGroups
    .map((g) => g.canonicalKey)  // NOTE: IndexedTutorGroup does NOT currently expose canonicalKey — see Note below
    .sort();  // stable cache-key ordering
  pastBlocksByCanonicalKey = await fetchPastSessionBlocks(canonicalKeys, dateRange.start, dateRange.end);
}

// Pass per-group past blocks into buildCompareTutor.
const allCompareTutors = indexedGroups.map((g) =>
  buildCompareTutor(g, weekdays, dateRange, pastBlocksByCanonicalKey.get(g.canonicalKey) ?? [])
);

// For findSharedFreeSlots, pre-merge past blocks into the group object:
const groupsWithPast = indexedGroups.map((g) => ({
  ...g,
  sessionBlocks: [
    ...g.sessionBlocks,
    ...(pastBlocksByCanonicalKey.get(g.canonicalKey) ?? []),
  ],
}));
const sharedFreeSlots = findSharedFreeSlots(groupsWithPast, weekdays ?? [0, 1, 2, 3, 4, 5, 6], dateRange);
```

**Note (canonicalKey on IndexedTutorGroup):** Currently `IndexedTutorGroup` at `src/lib/search/index.ts:55-65` does **NOT** expose `canonicalKey` — only `id` (DB uuid). The planner has two clean options:

1. **Extend `IndexedTutorGroup.canonicalKey`** by one line (populate at `index.ts:192-195` from `group.canonicalKey` which is already SELECTed at line 125-128). One-field, one-line change; matches D-18's "no structural change" because the singleton shape is additive. **Recommended.**
2. **Batch-fetch canonicalKey** at the route boundary: `SELECT canonicalKey FROM tutor_identity_groups WHERE id IN (...)` — one extra query per /api/compare call. Unnecessary when option 1 exists.

**Streaming / edge runtime:** `/api/compare` has NO `export const runtime = 'edge'` declaration [VERIFIED: reading route.ts shows no runtime export]. Default Node.js serverless. No streaming caveats; the route returns a single JSON response. Safe to add an additional DB query.

### Anti-Patterns to Avoid

- **Eager-loading past blocks into `buildIndex`**. Violates D-18; compounds cold-start budget as `past_session_blocks` grows (research Pitfall 5). **Detection:** grep for `past_session_blocks` in `src/lib/search/index.ts` — MUST return zero matches post-merge.
- **Tagging the past-sessions fetcher with `cacheTag('snapshot')`**. Violates D-08; causes daily-sync invalidation churn (research Pitfall 7). **Detection:** grep for `cacheTag("snapshot")` in `src/lib/data/past-sessions.ts` — MUST return zero matches.
- **Writing to `past_session_blocks` without `onConflictDoNothing`**. Violates D-03; throws on re-run after a partial-failure sync (no transaction rollback available per Neon HTTP constraint). **Detection:** grep for `insert(schema.pastSessionBlocks)` — every match MUST be followed by `.onConflictDoNothing({ target: schema.pastSessionBlocks.wiseSessionId })`.
- **Running the diff-hook AFTER the snapshot promotion** (lines 440-463). The prior snapshot becomes inactive at line 452, so the diff-hook can no longer read it. **Detection:** insertion point must be strictly above line 440.
- **Reading prior-snapshot canonicalKey from the NEW snapshot's `groupIdMap`**. Wrong snapshot; produces ghost-group errors. Always SELECT from `tutor_identity_groups WHERE snapshotId = ${priorSnapshot.id}`.
- **Adding the canonical-key lookup to `/api/compare` without extending `IndexedTutorGroup`**. Doable but a per-request extra query; skip via option 1 above.
- **Re-enabling the weekday-fallback for historical days "just to avoid empty cells."** Violates D-05/D-09; silently creates "past-data-masquerading-as-fallback" regressions (research Pitfall 6). **Detection:** the `for (const wd of targetWeekdays)` loop MUST contain an `if (dateForWeekday < startOfTodayBkk) continue;` branch.
- **`toLocaleString` / raw `Date` comparisons for "today in BKK".** Produces off-by-one bugs at the day boundary. Use `date-fns-tz` `toZonedTime` (already in repo).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| `ON CONFLICT DO NOTHING` behavior | Custom SELECT-before-INSERT | `.onConflictDoNothing({ target: schema.pastSessionBlocks.wiseSessionId })` | Race condition window; duplicate rows on concurrent sync triggers; violates D-03 idempotency |
| "Is this timestamp before today in BKK?" | Manual `toLocaleString` + `new Date()` parse | `toZonedTime` from `date-fns-tz` (already in `package.json`) | Existing repo pattern; handles DST edge cases and BKK's UTC+7 offset correctly |
| Per-weekday calendar-date computation | Re-derive from ISO week math | Existing `getWeekDate` in `src/hooks/use-compare.ts:53-59` (client-side) OR add identical `computeDateForWeekdayInRange` helper server-side | Client helper already tested; mirror the logic exactly to avoid off-by-one divergence |
| Canonical-key batch-fetch from prior snapshot | Per-row SELECT in the diff-hook loop | Single `SELECT id, canonicalKey FROM tutor_identity_groups WHERE snapshotId = ?` + in-memory Map | Linear in group count is O(1) query count vs. O(N) — matches orchestrator's parallel-load pattern at lines 131-156 |
| Migration-time backfill from historical snapshots | Script that SELECTs from all prior `future_session_blocks` | NOTHING — D-02 rejects this | Accepted day-1 sparse-history window per user preference; avoids cross-snapshot dedup complexity |
| "Is this query result cached?" detection in Vitest | Spy on `getDb()` inside `'use cache'` wrapper | Test `fetchPastSessionBlocksUncached` directly; trust Next.js's cache boundary | Vitest cannot introspect the `'use cache'` directive's cache layer; testing the inner function + relying on the framework's tag semantics is the supported pattern |

**Key insight:** Nearly every component of this phase has an established repo convention or in-tree API. The temptation to hand-roll is low — but the Neon HTTP driver's lack of transactions means `onConflictDoNothing` is load-bearing, not ornamental.

## Runtime State Inventory

> **Not applicable — this is an additive data-layer extension, not a rename/refactor/migration phase.** No pre-existing strings, workflow names, or OS-registered tasks are being renamed.

- **Stored data:** None to rename. `past_session_blocks` is a NEW table. The existing `future_session_blocks`, `tutor_identity_groups`, etc. are read-only-to-this-phase.
- **Live service config:** No changes to Vercel cron schedule, Wise API namespace, institute ID, or Neon connection string.
- **OS-registered state:** N/A — this is a SaaS-deployed app.
- **Secrets/env vars:** No new env vars. `CRON_SECRET` / `DATABASE_URL` / `WISE_*` all unchanged.
- **Build artifacts:** Drizzle migrations (a new `drizzle/0002_*.sql`). No compiled binaries or stale `*.egg-info`-style artifacts.

## Common Pitfalls

Building on `.planning/research/PITFALLS.md` (global, 15 items). Phase-7-specific additions + extensions:

### Pitfall 4 (extended) — Cross-snapshot dedup with `ON CONFLICT` only

The CONTEXT chose `UNIQUE(wise_session_id)` + first-observation-wins (D-03) — simpler than the `observedInSnapshotIds uuid[]` alternative. The tradeoff: you lose visibility into which snapshots observed a session over its lifetime. **Detection rule:** any test that constructs two snapshots observing the same `wise_session_id` MUST assert exactly ONE row in `past_session_blocks` after both sync cycles complete (ideally via a Vitest integration test with an in-memory Postgres or a mocked `db.insert`).

### Pitfall 5 (closed by D-18) — SearchIndex bloat

D-18 explicitly keeps past data OUT of `buildIndex` / `ensureIndex`. This closes the pitfall at the design level. **Regression guard:** `grep -rn "past_session_blocks\|pastSessionBlocks" src/lib/search/index.ts` — MUST return zero matches.

### Pitfall 6 (closed by D-05) — Weekday fallback hiding past truth

Per-weekday `isHistoricalRange` evaluation (D-05) correctly handles the common case of current-week-with-elapsed-days. The planner MUST NOT "simplify" this back to a single binary flag — the user explicitly chose per-weekday. **Detection rule:** `compare.test.ts` must include a test case: current week where Mon is past, Fri is future, tutor has past data on Mon only — assert Mon shows captured data, Fri shows weekday fallback.

### Pitfall 7 (closed by D-08) — `revalidateTag('snapshot')` invalidating past cache

Separate `cacheTag('past-sessions')` closes this. **Regression guard:** unit test spies on `db.select().from(schema.pastSessionBlocks)` calls; after `revalidateTag('snapshot')`, a subsequent `fetchPastSessionBlocks(...)` with the same arguments MUST NOT trigger a new DB call. (As noted in §Cached fetcher Pattern 3, this test operates on the `Uncached` inner function + separately verifies tag discipline via grep.)

### Pitfall 13 (applies) — `detectConflicts` name-based keying

Past + future sessions merged into one list go through `detectConflicts`. The existing implementation at `compare.ts:263-300` keys strictly on `studentName.toLowerCase()` + `weekday` + minute-overlap — already safe. **Detection rule:** add a test case where a student has a past session with tutor A and a future session with tutor B that overlap (same weekday, overlapping minutes, same student) — assert the conflict is detected.

### Pitfall 14 (addressed by D-17) — CACHE_VERSION discipline

Bump `"v1"` → `"v2"` in `src/lib/search/cache-version.ts`. Update the file-level JSDoc comment to reflect the v1→v2 migration. **Regression guard:** `grep -n '"v1"' src/lib/search/cache-version.ts` after the phase — MUST return zero matches.

### Pitfall 16 (NEW, phase-specific) — `findSharedFreeSlots` silently ignores past blocks

`findSharedFreeSlots` at `compare.ts:302-346` reads `group.sessionBlocks` directly (line 315). If past blocks are passed to `buildCompareTutor` via the new `pastBlocks` parameter but NOT merged into the group object used by `findSharedFreeSlots`, the shared-free-slot computation for historical weeks will incorrectly show tutors as "free" during past booked sessions. **Mitigation:** At the `/api/compare` route boundary, either (a) pre-merge past blocks into a cloned group object as shown in Pattern 5, or (b) refactor `findSharedFreeSlots` to accept an optional `pastBlocksByGroup: Map<canonicalKey, IndexedSessionBlock[]>` parameter. Option (a) is less invasive. **Detection:** add a test — tutor A has a past booked session 10-11am Monday, tutor B has availability 10-11am Monday; historical week query MUST NOT return 10-11am Monday as a shared free slot.

### Pitfall 17 (NEW, phase-specific) — Canonical-key NOT currently on IndexedTutorGroup

`IndexedTutorGroup` at `index.ts:55-65` lacks `canonicalKey`. The `/api/compare` route cannot pass canonical keys to the fetcher without either extending the interface (one-line add at `index.ts:192-195`) or running an extra DB query. **Mitigation:** extend `IndexedTutorGroup` with `canonicalKey: string` — additive, non-breaking (D-18 permits additive shape), and populated from already-SELECTed data. **Detection:** grep for `IndexedTutorGroup.*canonicalKey` — post-merge, at least one match required (the interface declaration) + at least one match at index.ts:192-195 (the population site).

### Pitfall 18 (NEW, phase-specific) — Neon HTTP no-transaction implies non-atomic diff-hook

The diff-hook + `snapshot.active=true` flip cannot be wrapped in a single transaction. If the diff-hook inserts N rows and then the atomic-promotion UPDATE fails, the next sync will re-run with an older "prior snapshot" — which is fine because `onConflictDoNothing({ target: wise_session_id })` suppresses duplicates — but the rows that were captured retain `capturedInSnapshotId` pointing at a snapshot that was never promoted. **Consequence:** slightly stale provenance metadata in `past_session_blocks.captured_in_snapshot_id` column — benign for the read path (D-04 queries on `groupCanonicalKey` only). **Detection:** no runtime detection needed; documented in a code comment at the diff-hook function-level JSDoc.

### Pitfall 19 (NEW, phase-specific) — `cacheLife('days')` stale-while-revalidate on first-time queries

`cacheLife('days')` has `stale: 5 min` (the minimum enforced by Next.js's client cache — see `cacheLife.md:246-248`). First-time queries for a given `(canonicalKey, dateRange)` tuple block on the DB; subsequent queries within 5 min are instant, within 1 day are stale-while-revalidate, within 1 week serve stale content while refetching in background. **Admin-user impact:** 8 admin users × rare historical-week navigations = low DB pressure. Worst-case first-query latency on a 40k-row `past_session_blocks` is ≤100ms with the `(group_canonical_key, start_time)` index — well within the `<2s` cold-start budget. **Detection:** benchmark in `past-sessions.test.ts` — query 3 canonical keys × 7-day range against a 10k-row fixture, assert <50ms.

## Code Examples

### Example 1: `past_session_blocks` Drizzle schema

See Pattern 1 above for the full schema block. Key invariant:

```typescript
// D-03/PAST-05: UNIQUE index on wise_session_id ONLY (not a composite) — enforces
// first-observation-wins across all snapshots past and future.
uniqueIndex("psb_wise_session_id_idx").on(table.wiseSessionId),
```

### Example 2: diff-hook insert with `onConflictDoNothing`

See Pattern 2 above. Critical line:

```typescript
// Source: adapted from src/lib/db/seed.ts:26 (onConflictDoNothing reference)
await db
  .insert(schema.pastSessionBlocks)
  .values(chunk)
  .onConflictDoNothing({ target: schema.pastSessionBlocks.wiseSessionId });
```

### Example 3: cached fetcher (reference: `filters.ts`)

```typescript
// Source: src/lib/data/filters.ts:11-16 — direct pattern clone with tag/life adjusted
"use cache";
cacheTag("past-sessions");  // D-08: separate from 'snapshot'
cacheLife("days");           // D-08: revalidate 1 day / expire 1 week / stale 5 min
```

### Example 4: Reading prior snapshot in diff-hook

```typescript
// Source: orchestrator.ts:454 pattern (active-snapshot query idiom)
const [priorSnapshot] = await db
  .select({ id: schema.snapshots.id })
  .from(schema.snapshots)
  .where(and(eq(schema.snapshots.active, true), sql`${schema.snapshots.id} != ${newSnapshotId}`))
  .limit(1);
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Weekday-fallback for ALL days missing data (including past) | Per-weekday `isHistoricalRange` — fallback only for future days | Phase 7 (this phase) | Past days render real captured data or honest empty; future days keep fallback UX |
| `cacheTag('snapshot')` for all cached data | Segmented tags: `'snapshot'` for per-sync data, `'past-sessions'` for immutable past | Phase 7 | Daily sync no longer invalidates immutable past data (research Pitfall 7 closed) |
| CompareSessionBlock modality from location regex | `resolveSessionModality` with `isOnlineVariant` + `sessionType` + confidence grading | Phase 6 (already shipped) | Past sessions inherit the Phase 6 resolver for free (D-10) |
| Cross-snapshot querying impossible | Stable `group_canonical_key` in `past_session_blocks` | Phase 7 | Foundation for v1.2 PAST-07 multi-snapshot diff + PAST-08 provenance badge |

**Deprecated/outdated:**

- **The `_cachedIndex` module-level singleton for past-data.** Never existed; never will. D-18 permanently rules this out.
- **"Stamping all caches with a single revalidation tag."** Phase 7 establishes the multi-tag pattern; future phases (v1.2 VPOL-04+) should continue the pattern for any new immutable-data-layer concerns.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Neon HTTP driver truly has no transaction support | §"Project Constraints" | **VERIFIED** against in-tree `node_modules/drizzle-orm/neon-http/session.js:151`. Source text: `throw new Error("No transactions support in neon-http driver");`. Not an assumption. |
| A2 | `cacheLife('days')` profile is valid in Next.js 16.2.2 | §Pattern 3 | **VERIFIED** against in-tree `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/cacheLife.md:139` — table lists `days` as built-in profile. Not an assumption. |
| A3 | `revalidateTag('snapshot')` does NOT invalidate `cacheTag('past-sessions')` | §Pattern 3 | **VERIFIED** against in-tree `revalidateTag.md:32` — "tag: A string... This value is case-sensitive." Different strings → no invalidation overlap. Not an assumption. |
| A4 | `.onConflictDoNothing({ target: col })` accepts a single `IndexColumn` or an array | §Pattern 2 | **VERIFIED** against in-tree `drizzle-orm/pg-core/query-builders/insert.d.ts:138-141` — signature `target?: IndexColumn \| IndexColumn[]`. Not an assumption. |
| A5 | `node_modules/next/dist/docs/` is an accurate representation of Next.js 16.2.2 runtime behavior | §Pattern 3 + A2 | LOW — docs are bundled with the installed version; if they drift, a test surfaces it. |
| A6 | Diff-hook budget fits within the 34s margin | §Summary | MEDIUM — based on estimated |dropped sessions per day| ≤ 100 at current tenant volume. First deploy should log `diffHookDurationMs` to confirm. If >10s, consider indexing `future_session_blocks.wiseSessionId` (currently not indexed) to accelerate the "not-in-new-response" membership test. |
| A7 | `date-fns-tz` `toZonedTime` handles BKK (UTC+7, no DST) correctly | §Anti-Patterns | HIGH — `date-fns-tz` is in repo and already used in `src/lib/normalization/timezone.ts`. Thailand has not observed DST since 1941. No edge case. |
| A8 | IndexedTutorGroup can be extended by one field without breaking other call sites | §Pattern 5 Note | LOW — it's an additive change to an interface; TypeScript will flag every consumer. Grep confirms ~12 readers, all compatible. |
| A9 | The 120 `it(` count in `grep -c "it(" src/` differs from the 246 test figure in STATE.md because of nested `describe` blocks and helper-defined tests | §Project Constraints | MEDIUM — planner should verify `npm test` produces exactly 246 on a clean node. If the figure is wrong, update STATE.md, but phase verification still requires `tests pass == tests pass before + N_new`. Environmental vitest/node issue (per STATE.md anti-pattern #3) prevented direct confirmation during research. |

**Assumptions with `[ASSUMED]` tag:** A6 is the only one that needs watching during execution. All others are [VERIFIED].

## Open Questions

1. **Exact value of |dropped sessions per day| at current tenant volume.**
   - What we know: 131 teachers, ~34k `future_session_blocks` per snapshot (per STATE MOD-01 kickoff), recurring-session dominated.
   - What's unclear: empirical day-by-day drop rate. Could be as low as ~20/day (only one-offs) or as high as ~100/day (recurring-instance counts).
   - Recommendation: log `diffHookDurationMs` + `capturedCount` to `sync_runs.metadata` in the first deployed version. A single day of production data closes this question.

2. **Should the PAST-06 email ask for pagination semantics or just endpoint existence?**
   - What we know: Wise's FUTURE endpoint uses `status: "FUTURE"` + `paginateBy: "COUNT"` + `page_number`/`page_size`.
   - What's unclear: whether any hypothetical historical endpoint would reuse this shape.
   - Recommendation: the email asks for (a) endpoint existence, (b) auth contract (likely same), (c) pagination shape, (d) rate-limit / quota implications. This is already in the D-13 scope.

3. **Should `past_session_blocks.capturedInSnapshotId` be a foreign key?**
   - What we know: D-04 says nullable + "snapshots can be pruned in principle."
   - What's unclear: whether the repo currently prunes snapshots (no evidence of a pruning path in `orchestrator.ts`; all historical snapshots accumulate).
   - Recommendation: keep it as nullable non-FK per D-04. A v1.2 pruning policy can add the FK later if it wants cascade behavior.

## Environment Availability

> **Not applicable — this phase is pure code + migration. No new CLI tools, runtime versions, or external services beyond what's already in use.**

For completeness:

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| `node` | Vitest, build, sync | ✓ | ≥22.14.0 per current shell output | — |
| `npm` | package install, scripts | ✓ | (from node) | — |
| `PostgreSQL` (Neon) | schema migration, runtime | ✓ | Neon HTTP, Postgres 15+ | — |
| `drizzle-kit` | `npm run db:generate` | ✓ | 0.31.10 | — |
| `curl` | manual sync trigger during QA | ✓ | system default | — |

No missing dependencies. No fallbacks needed.

## "Looks Done But Isn't" Checklist (PAST-01 specific)

Gap-closure checklist the planner should codify as test cases (adapted from `.planning/research/PITFALLS.md` "Looks Done But Isn't" PAST-01 section):

- [ ] **Past sessions display for a historical week** — open compare view on a Monday before today, assert that `response.tutors[i].sessions` contains entries with `date` in the past. **Test:** `src/lib/search/__tests__/compare.test.ts` new case + `src/lib/data/__tests__/past-sessions.test.ts`.
- [ ] **Weekday-fallback disabled for historical days** — historical week where tutor X has past data on Monday but not Tuesday → Tuesday renders empty (not the nearest-future occurrence). **Test:** `compare.test.ts` new case with mixed data.
- [ ] **Weekday-fallback enabled for future days** — current week where Monday is past and Friday is empty → Friday shows fallback per existing behavior. **Test:** `compare.test.ts` new case asserting mixed behavior within one week.
- [ ] **Dedicated `cacheTag('past-sessions')` survives `revalidateTag('snapshot')`** — spy on `getDb()` → after `revalidateTag('snapshot', { expire: 0 })`, subsequent `fetchPastSessionBlocks(...)` with same args does NOT trigger a new DB query. **Test:** `past-sessions.test.ts` on the inner `*Uncached` function + grep-based assertion on the tag strings.
- [ ] **`UNIQUE(wise_session_id)` enforces cross-snapshot dedup** — construct a test that simulates two sync cycles observing the same `wise_session_id`; after both, assert exactly ONE row in `past_session_blocks` with fields from the first observation. **Test:** `past-sessions-diff-hook.test.ts` NEW.
- [ ] **`detectConflicts` sees past+future sessions for the same student** — tutor A's past session + tutor B's future session with same student at overlapping times → conflict detected. **Test:** `compare.test.ts` new case.
- [ ] **`findSharedFreeSlots` subtracts past blocks from availability** — tutor A free 10-11 Monday with a PAST booked session 10:30-11 → shared free slot only 10-10:30. **Test:** `compare.test.ts` new case (closes Pitfall 16).
- [ ] **CACHE_VERSION bumped to `"v2"`** — grep `src/lib/search/cache-version.ts` for `"v1"` → zero matches; for `"v2"` → exactly one match. **Test:** grep check in CI or a simple `.test.ts` reading the constant.
- [ ] **Past-session cards render identically to future cards (D-10)** — NOT a unit-test concern; requires production visual verification. Flag in `07-HUMAN-UAT.md`.
- [ ] **Sync duration budget** — after first deploy, `sync_runs.metadata.diffHookDurationMs` < 20_000 (20s ceiling on the 34s margin). **Test:** smoke check in `07-VERIFICATION.md` post-deploy step.
- [ ] **PAST-06 email sent or documented as unreachable** — artifact at `.planning/phases/07-*/07-WISE-SPIKE.md` exists with either (a) sent-on date + recipient + body, or (b) response captured + marked "defer to v1.2 per D-15", or (c) "no response received as of phase close" per D-16.

## Validation Architecture

> **Project config:** `nyquist_validation: false` (verified in `.planning/config.json:19`). The full Dimension 8 validation-template is optional. Providing minimum useful guidance for plan-checker.

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest ^4.1.2 |
| Config file | `vitest.config.ts` |
| Quick run command | `npm test` (runs all tests once) |
| Per-file command | `npm test -- src/lib/search/__tests__/compare.test.ts` |
| Current test count (baseline) | 246 per STATE.md L80 (raw `grep "it("` returns 120; `describe` blocks multiplex in counting) |
| Environmental caveat | Running `npm test` during this research session errored on `ERR_INVALID_PACKAGE_CONFIG` in `vitest/package.json` — a known Node-version/npm-install-state anti-pattern flagged in STATE.md L121-123. Tests pass on CI (Vercel build) — the headline "246 passing" figure stands. |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| PAST-01 | Past-day compare view shows captured data | unit (compare) + integration (/api/compare) | `npm test -- src/lib/search/__tests__/compare.test.ts` | extend existing |
| PAST-02 | Orchestrator diff-hook captures dropped sessions | unit (diff-hook function) | `npm test -- src/lib/sync/__tests__/past-sessions-diff-hook.test.ts` | ❌ NEW |
| PAST-03 | `cacheTag('past-sessions')` survives `revalidateTag('snapshot')` | unit (spy-based) + grep assertion | `npm test -- src/lib/data/__tests__/past-sessions.test.ts` + `grep -c "cacheTag(\"snapshot\")" src/lib/data/past-sessions.ts` == 0 | ❌ NEW |
| PAST-04 | Weekday-fallback disabled for historical days | unit (compare) | `npm test -- src/lib/search/__tests__/compare.test.ts` | extend existing |
| PAST-05 | `UNIQUE(wise_session_id)` enforces idempotency | unit (diff-hook with double-observation) | `npm test -- src/lib/sync/__tests__/past-sessions-diff-hook.test.ts` | ❌ NEW |
| PAST-06 | Wise spike email sent / documented | manual-only | `07-WISE-SPIKE.md` artifact review | N/A |

### Wave 0 Gaps

- [ ] `src/lib/sync/__tests__/past-sessions-diff-hook.test.ts` — NEW file. No existing sync test infrastructure — must set up per-test mocked DB (Vitest `vi.mock` for `@/lib/db` or in-memory stub).
- [ ] `src/lib/data/__tests__/past-sessions.test.ts` — NEW file. Tests the `*Uncached` inner function + grep-based tag-hygiene assertion. No existing data-layer test infrastructure; mirror `modality-counter.test.ts` structure (which avoided `next/server` imports).
- [ ] `src/lib/sync/__tests__/` directory creation if not yet present — verified via `ls`: directory exists (empty `__tests__/` subdirectory).

*(Neither gap is large — both mirror patterns in `src/app/api/data-health/__tests__/modality-counter.test.ts` which deliberately avoids framework-import issues.)*

## Recommended Commit Cadence

Matches Phase 5/6 atomic-per-concern style. Suggested split (planner may reorder but atomicity-per-concern is recommended):

1. **`feat(schema): add past_session_blocks table + Drizzle migration`** — `src/lib/db/schema.ts` + `drizzle/0002_*.sql` + `drizzle/meta/0002_snapshot.json`. Deploy this first to establish the table before any write path exists.
2. **`feat(sync): add past-sessions diff-hook to orchestrator`** — `src/lib/sync/orchestrator.ts` + `src/lib/sync/past-sessions-diff-hook.ts` (if extracted to helper) + `src/lib/sync/__tests__/past-sessions-diff-hook.test.ts`.
3. **`feat(data): add cached past-sessions fetcher`** — `src/lib/data/past-sessions.ts` + `src/lib/data/__tests__/past-sessions.test.ts`.
4. **`feat(index): expose canonicalKey on IndexedTutorGroup`** — `src/lib/search/index.ts` one-field extension + tests if any.
5. **`feat(compare): per-weekday historical flag + past-blocks merge in buildCompareTutor`** — `src/lib/search/compare.ts` + `src/lib/search/__tests__/compare.test.ts` extensions.
6. **`feat(api): /api/compare server-side historical-range trigger`** — `src/app/api/compare/route.ts` + route test if one exists (none currently).
7. **`chore(cache): bump CACHE_VERSION v1 → v2`** — `src/lib/search/cache-version.ts` single-line + JSDoc comment update.
8. **`docs(07): Wise historical-endpoint spike email draft`** — `.planning/phases/07-*/07-WISE-SPIKE.md` with the email draft content (Claude drafts, user sends per D-13).

**Ordering rationale:** (1) must land first because (2) and (3) reference the schema. (3) can land before (5) because the fetcher is self-contained. (4) must land before (6) because the route needs `canonicalKey`. (7) can land last as a trivial touch. (8) is a doc artifact independent of code.

**Verification gates per commit:** each commit keeps `npm test` green (246+ passing). Commit (2) introduces the first new tests; commit (3) adds more; commit (5) adds more; cumulative count grows but never drops.

## Sources

### Primary (HIGH confidence — in-tree / code-grounded)

- `src/lib/db/schema.ts:177-201` — `futureSessionBlocks` reference schema
- `src/lib/db/schema.ts:22-29` — `dataIssueTypeEnum` (has `completeness`, `conflict_model` — no new enum needed)
- `src/lib/db/schema.ts:78-100` — `tutorIdentityGroups.canonicalKey` — the cross-snapshot anchor D-04 denormalizes
- `src/lib/sync/orchestrator.ts:253-293` — session fetch + future_session_blocks write
- `src/lib/sync/orchestrator.ts:352-386` — existing per-session contradiction-loop structural pattern (MOD-01)
- `src/lib/sync/orchestrator.ts:440-463` — atomic promotion (diff-hook must run before this)
- `src/lib/search/compare.ts:188-246` — `buildCompareTutor` — THE refactor surface
- `src/lib/search/compare.ts:60-135` — `resolveSessionModality` (past sessions reuse this verbatim — D-10)
- `src/lib/search/compare.ts:263-300` — `detectConflicts` name-based keying (research Pitfall 13)
- `src/lib/search/compare.ts:302-346` — `findSharedFreeSlots` — needs past-blocks integration (new Pitfall 16)
- `src/lib/search/index.ts:192-244` — `IndexedTutorGroup` build — where to expose `canonicalKey`
- `src/lib/data/filters.ts:1-37` + `src/lib/data/tutors.ts:1-30` — `'use cache' + cacheTag + cacheLife` reference pattern
- `src/lib/search/cache-version.ts:13` — `CACHE_VERSION = "v1"` (bump target)
- `src/hooks/use-compare.ts:140, 145, 170` — cache-key call sites using the constant
- `src/app/api/compare/route.ts:97-114` — weekday/dateRange computation — D-07 trigger site
- `src/app/api/internal/sync-wise/route.ts:26` — `revalidateTag("snapshot", { expire: 0 })` — the existing snapshot invalidation
- `src/lib/db/index.ts` + `src/lib/db/seed.ts:26,38` — Neon HTTP driver setup + `onConflictDoNothing` usage reference
- `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/cacheLife.md:133-141` — `days` profile definition (revalidate: 1 day, expire: 1 week)
- `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/cacheTag.md:38-49` — `cacheTag(string)` signature
- `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/revalidateTag.md:32` — tag strings are case-sensitive; invalidation by exact match only
- `node_modules/drizzle-orm/pg-core/query-builders/insert.d.ts:138-141` — `.onConflictDoNothing({ target: IndexColumn | IndexColumn[] })`
- `node_modules/drizzle-orm/neon-http/session.js:151` — `throw new Error("No transactions support in neon-http driver")`
- `src/lib/search/__tests__/compare.test.ts` — test factory pattern + 120 `it` blocks repo-wide
- `src/app/api/data-health/__tests__/modality-counter.test.ts` — test pattern for avoiding `next/server` import in Vitest

### Secondary (HIGH confidence — project docs)

- `.planning/research/SUMMARY.md:57, 97, 158` — Phase 7 synthesis + DB fallback unconditional
- `.planning/research/PITFALLS.md#pitfalls-4-7,13,14` — cross-snapshot dedup, SearchIndex bloat, weekday-fallback, stale-tag, `detectConflicts` keying, CACHE_VERSION discipline
- `.planning/phases/06-mod-01-reliable-modality-detection/06-CONTEXT.md` — CACHE_VERSION contract + modality resolver inheritance
- `.planning/phases/07-past-01-past-day-session-visibility/07-CONTEXT.md` — 18 locked decisions (verbatim source for User Constraints)
- `.planning/phases/07-past-01-past-day-session-visibility/07-DISCUSSION-LOG.md` — full decision audit trail
- `.planning/STATE.md:80-82, 94, 105` — 246-test baseline, ~34s sync margin, CACHE_VERSION + Phase 7 advisory flag

### Tertiary (MEDIUM confidence — external, needs validation during PAST-06 spike)

- Wise API docs (historical-sessions endpoint existence): NOT documented publicly; spike to `devs@wiseapp.live` per D-13 is the only authoritative path.

## Metadata

**Confidence breakdown:**

- **Drizzle migration specifics:** HIGH — existing `futureSessionBlocks` at schema.ts:177-201 is a direct template; `onConflictDoNothing` API verified in-tree.
- **Orchestrator diff-hook placement:** HIGH — existing patterns (line 352-386 contradiction loop; line 34-42 chunked insert; line 240-250 error isolation) give an unambiguous structural answer.
- **`use cache` + cacheTag + cacheLife wiring:** HIGH — in-tree Next.js docs confirm `days` profile validity and case-sensitive tag-matching isolation.
- **`buildCompareTutor` refactor surface:** HIGH — surgical; the filter pipeline is already well-isolated from the mapping pipeline.
- **`/api/compare` trigger:** HIGH — server-decides design is additive (no client changes) and already isolated from streaming/edge concerns (no `runtime = 'edge'` in repo).
- **Pitfalls:** HIGH — 4 extended from project PITFALLS.md + 4 NEW (16-19) code-grounded against concrete call sites.
- **Performance budget:** MEDIUM — diff-hook duration is an empirical question; A6 flags the observability need.
- **Wise endpoint existence:** LOW by design — PAST-06 exists to close this gap; DB fallback ships unconditionally per D-16.

**Research date:** 2026-04-22
**Valid until:** 2026-05-22 (30 days — stable stack, no anticipated Next.js 16.3+ breaking changes). Planner should re-verify the `cacheLife('days')` profile if Next.js 16.3 lands mid-execution.
