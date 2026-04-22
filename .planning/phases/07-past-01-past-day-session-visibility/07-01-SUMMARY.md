---
phase: 07-past-01-past-day-session-visibility
plan: 01
subsystem: database

tags: [drizzle, postgres, neon, schema, migration, past-sessions]

# Dependency graph
requires:
  - phase: 06-mod-01-reliable-modality-detection
    provides: snapshot-scoped session schema pattern (futureSessionBlocks mirror target)
provides:
  - cross-snapshot `past_session_blocks` table in Drizzle schema (groupCanonicalKey anchor, nullable capturedInSnapshotId, capturedAt audit timestamp)
  - Drizzle migration `drizzle/0002_past_session_blocks.sql` with UNIQUE INDEX on wise_session_id (PAST-05 idempotency enforcement) and two supporting indexes
  - foundation for Plan 02 orchestrator diff-hook, Plan 03 past-sessions cached fetcher, Plan 04 buildCompareTutor historical-merge
affects: 07-02-orchestrator-diff-hook, 07-03-past-sessions-cached-fetcher, 07-04-buildcomparetutor-historical-merge, 07-05-api-compare-historical-trigger

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Cross-snapshot table with denormalized canonical key (group_canonical_key) and nullable non-FK snapshot provenance (captured_in_snapshot_id)"
    - "First-observation-wins idempotency via UNIQUE INDEX on wise_session_id"

key-files:
  created:
    - drizzle/0002_past_session_blocks.sql
    - drizzle/meta/0002_snapshot.json
  modified:
    - src/lib/db/schema.ts (+60 lines; line 222 pastSessionBlocks export)
    - drizzle/meta/_journal.json (+7 lines; 3rd entry for migration 0002)

key-decisions:
  - "Used drizzle-kit --name=past_session_blocks to skip interactive prompt and get descriptive filename directly (no rename step required)"
  - "Transcribed plan's exact Drizzle block verbatim (no paraphrasing) to preserve D-04 column intent"
  - "Committed schema separately from generated migration (atomic per-concern split, matches Phase 5/6 style)"

patterns-established:
  - "Cross-snapshot table rationale documented in 16-line schema.ts comment (D-04 denormalization, retention policy, drift policy) — reference for PAST-07/08 in v1.2"
  - "drizzle-kit --name flag preferred over interactive prompt for agent-run migrations (avoids stdin hang)"

requirements-completed: [PAST-05]

# Metrics
duration: 28min
completed: 2026-04-22
---

# Phase 7 Plan 01: Schema past_session_blocks Summary

**Cross-snapshot `past_session_blocks` Drizzle table + migration 0002 ready for Neon; UNIQUE(wise_session_id) enforces PAST-05 first-observation-wins idempotency.**

## Performance

- **Duration:** ~28 min (includes drizzle-kit interactive-prompt troubleshooting + retry with --name flag)
- **Started:** 2026-04-22T04:21:22Z
- **Completed:** 2026-04-22T04:49:04Z
- **Tasks:** 2 auto executed + 1 checkpoint returned = 3 total
- **Files modified:** 3 files (1 edit + 2 new)

## Accomplishments

- Added `pastSessionBlocks` Drizzle export at `src/lib/db/schema.ts:222` with the exact D-04 column set: `groupCanonicalKey` (cross-snapshot anchor, NOT NULL), `capturedInSnapshotId` (nullable, non-FK provenance), full mirror of `futureSessionBlocks` columns minus snapshot-scoped fields, and `capturedAt` audit timestamp.
- Generated `drizzle/0002_past_session_blocks.sql` containing the exact CREATE TABLE + 3 indexes (UNIQUE on wise_session_id + two supporting indexes for compare read-path and time-range scans).
- Pre-existing migrations `0000_tidy_black_bolt.sql` and `0001_tough_plazm.sql` untouched (schema-drift regression guard passes).
- `src/lib/search/index.ts` has zero `past_session_blocks` references — D-18 "past data stays OUT of SearchIndex singleton" regression guard enforced.

## Task Commits

Each task was committed atomically:

1. **Task 1: Add pastSessionBlocks table to Drizzle schema** - `f1cd4ee` (feat)
2. **Task 2: Generate Drizzle migration SQL via drizzle-kit** - `9a304e4` (feat)
3. **Task 3: [BLOCKING] Apply migration to Neon Postgres** - **CHECKPOINT RETURNED** (not executed — requires DATABASE_URL out-of-band)

_No plan metadata commit created in this parallel-executor run; orchestrator will make the final metadata commit after all worktree agents in the wave complete._

## Files Created/Modified

- `src/lib/db/schema.ts` — Appended 60 lines: 16-line block comment explaining cross-snapshot deviation + `pastSessionBlocks` pgTable export with 20 columns and 3 indexes. No existing export altered.
- `drizzle/0002_past_session_blocks.sql` — New 26-line migration: `CREATE TABLE "past_session_blocks"` with all 20 columns (id, group_canonical_key, captured_in_snapshot_id, wise_teacher_id, wise_session_id, start_time, end_time, weekday, start_minute, end_minute, wise_status, is_blocking, title, session_type, location, student_name, subject, class_type, recurrence_id, captured_at) and 3 index statements (UNIQUE `psb_wise_session_id_idx`, `psb_group_key_start_idx` on (group_canonical_key, start_time), `psb_start_time_idx` on (start_time)).
- `drizzle/meta/0002_snapshot.json` — New drizzle-kit snapshot including the new table definition.
- `drizzle/meta/_journal.json` — Appended 3rd entry: `{"idx": 2, "version": "7", "when": 1776833276656, "tag": "0002_past_session_blocks", "breakpoints": true}`.

## Acceptance Criteria Verification

**Task 1 (9/9 passed):**
- `grep -c "export const pastSessionBlocks = pgTable(\"past_session_blocks\"" src/lib/db/schema.ts` → `1`
- `grep -c "groupCanonicalKey: text(\"group_canonical_key\").notNull()" src/lib/db/schema.ts` → `1`
- `grep -c "capturedInSnapshotId: uuid(\"captured_in_snapshot_id\")" src/lib/db/schema.ts` → `1`
- `grep -c "uniqueIndex(\"psb_wise_session_id_idx\").on(table.wiseSessionId)" src/lib/db/schema.ts` → `1`
- `grep -c "index(\"psb_group_key_start_idx\").on(table.groupCanonicalKey, table.startTime)" src/lib/db/schema.ts` → `1`
- `grep -c "index(\"psb_start_time_idx\").on(table.startTime)" src/lib/db/schema.ts` → `1`
- `grep -c "capturedAt: timestamp(\"captured_at\"" src/lib/db/schema.ts` → `1`
- `grep "references(() => snapshots.id)" src/lib/db/schema.ts | grep -c "captured_in_snapshot_id"` → `0` (confirms no FK on `capturedInSnapshotId` per D-04)
- `npx tsc --noEmit --skipLibCheck src/lib/db/schema.ts` → exit 0, no "error TS" output

**Task 2 (9/9 passed):**
- File `drizzle/0002_past_session_blocks.sql` exists
- `grep -c 'CREATE TABLE "past_session_blocks"'` → `1`
- `grep -c 'CREATE UNIQUE INDEX "psb_wise_session_id_idx"'` → `1`
- `grep -c '"group_canonical_key"'` → `2` (column + index, meets "at least 2" bar)
- `grep -c '"captured_in_snapshot_id"'` → `1` (meets "at least 1" bar)
- `grep -c 'CREATE INDEX "psb_group_key_start_idx"'` → `1`
- `grep -c 'CREATE INDEX "psb_start_time_idx"'` → `1`
- `drizzle/meta/_journal.json` contains `"tag": "0002_past_session_blocks"` (via drizzle-kit `--name` flag; no rename required)
- `drizzle/meta/0002_snapshot.json` exists
- `git diff drizzle/0000_tidy_black_bolt.sql drizzle/0001_tough_plazm.sql` → empty (pre-existing migrations unchanged)

**Task 3 acceptance criteria (DB-backed):** PENDING — requires operator to apply migration.

**Plan-level regression guards passed:**
- `grep -c "pastSessionBlocks" src/lib/db/schema.ts` → `1`
- `grep -c "past_session_blocks" src/lib/search/index.ts` → `0` (D-18 enforced — past data stays OUT of SearchIndex)
- `drizzle/meta/_journal.json` has exactly 3 entries (0000, 0001, 0002)

## Decisions Made

- **Used `drizzle-kit generate --name=past_session_blocks` flag** — bypassed interactive prompt (drizzle-kit 0.31.10 without `--name` hangs waiting for stdin in the agent runtime). The `--name` value became the migration tag directly, so the rename step described in the plan (`mv 0002_<random-tag>.sql 0002_past_session_blocks.sql`) was unnecessary. _Documented as an anti-pattern mitigation for future Phase 7/8/9/10 migrations._
- **Committed schema change and migration generation as two separate atomic commits** (`f1cd4ee` for schema.ts, `9a304e4` for `drizzle/0002_*`) — matches the Phase 5/6 per-concern commit style suggested by 07-CONTEXT.md Claude Discretion "Commit cadence" bullet.
- **Transcribed the plan's Drizzle block verbatim** — did not paraphrase column names or types; the plan's acceptance grep patterns are string-exact, and preserving verbatim guarantees they all pass on the first attempt.

## Deviations from Plan

**None material — plan executed exactly as written.** One tooling-level workaround (see Decisions: `--name` flag) that the plan anticipated with the "if drizzle-kit generates a different tag..." fallback instruction. The workaround produced the desired filename directly, so the fallback mv/edit flow was not required.

## Issues Encountered

- **drizzle-kit interactive prompt hang** (Task 2): First invocation of `npm run db:generate` ran for 2+ minutes without emitting any migration files. Root cause: drizzle-kit 0.31.10 prompts for "Migration name" on stdin by default; the agent runtime's closed stdin hung the prompt indefinitely. Mitigation: killed the hung process and re-ran with explicit `--name=past_session_blocks` flag, which completed in < 5 seconds and produced the correctly-named migration file. Pre-existing migrations (0000/0001) untouched throughout.

## User Setup Required

**Task 3 requires operator action.** Claude committed the schema + migration files; applying the migration to Neon Postgres needs a real `DATABASE_URL` which is out-of-band for the agent runtime.

### Migration-pending state

- Code artifacts committed: YES (f1cd4ee + 9a304e4)
- Neon table present: **NO (pending operator action)**
- Migration file reviewed: YES (see Files Created/Modified, all columns and indexes verified)

### Exact operator command

```bash
DATABASE_URL="<neon-connection-string>" npm run db:migrate
```

Where `<neon-connection-string>` is the production Neon URL from `.env.local` (same value configured in Vercel env). The `db:migrate` script invokes drizzle-kit which applies all pending migrations in order against the target database; migration 0002 is the only new one.

### Expected behavior on apply

drizzle-kit will print:
```
applying migration 0002_past_session_blocks...
done
```

No errors. Migration is safe (CREATE TABLE only — no ALTER on existing tables, no data modifications; table is empty on creation per D-02 empty-forward policy).

### Operator verification (post-apply)

```sql
-- Confirm table exists with all 20 columns
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
  WHERE table_name = 'past_session_blocks'
  ORDER BY ordinal_position;

-- Confirm indexes
SELECT indexname FROM pg_indexes WHERE tablename = 'past_session_blocks';

-- Confirm empty on creation (D-02)
SELECT count(*) FROM past_session_blocks;
```

Expected results:
- 20 rows in information_schema query (id, group_canonical_key, captured_in_snapshot_id, wise_teacher_id, wise_session_id, start_time, end_time, weekday, start_minute, end_minute, wise_status, is_blocking, title, session_type, location, student_name, subject, class_type, recurrence_id, captured_at)
- At minimum 3 indexes: `psb_wise_session_id_idx`, `psb_group_key_start_idx`, `psb_start_time_idx` (plus the implicit primary-key index, which brings the total to 4)
- `count(*)` returns `0`

## Next Phase Readiness

- Plan 02 (orchestrator diff-hook) can start as soon as the migration is applied — it needs the `past_session_blocks` table live to test the `ON CONFLICT DO NOTHING` insert path.
- Plans 03/04/05 depend transitively on Plan 02 (the diff-hook must be producing rows before the read path can merge them).
- CACHE_VERSION bump (Plan 06) and Wise spike email draft (Plan 07) are independent of Plan 01 migration state.

**Blocker on downstream execution:** Plan 02 cannot run autonomously until Task 3 (operator applies migration) completes.

## Self-Check: PASSED

- FOUND: src/lib/db/schema.ts (pastSessionBlocks export at line 222)
- FOUND: drizzle/0002_past_session_blocks.sql
- FOUND: drizzle/meta/0002_snapshot.json
- FOUND: drizzle/meta/_journal.json (updated with idx=2 entry)
- FOUND commit: f1cd4ee (Task 1: feat(07-01): add pastSessionBlocks table to Drizzle schema)
- FOUND commit: 9a304e4 (Task 2: feat(07-01): generate Drizzle migration 0002_past_session_blocks)
- CHECKPOINT RETURNED: Task 3 (human-action, gate=blocking) — operator must apply migration

---
*Phase: 07-past-01-past-day-session-visibility*
*Completed: 2026-04-22 (Tasks 1–2) / Task 3 pending operator migration apply*
