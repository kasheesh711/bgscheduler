---
phase: 11-ident-01-webhook-side-line-identity-resolution
plan: "01"
subsystem: database
tags: [drizzle, migration, neon, postgres, line, quarantine, is_phantom]

# Dependency graph
requires: []
provides:
  - "line_contact_student_links.is_phantom column (boolean NOT NULL DEFAULT false) in production Neon"
  - "line_contact_student_links_phantom_idx index on (is_phantom, status)"
  - "696 OA-resolver phantom rows quarantined (is_phantom=true) in production"
affects: [11-03 student-links isPhantom filter, 11-05 link-validation phantom scope, 11-06 recompute, 11-07 archive filter + metric]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Flag-only quarantine (is_phantom) — no row deletion; reversible by admin DB access"
    - "Trimmed Drizzle migration discipline (verify generated SQL contains ONLY intended DDL before apply)"

key-files:
  created:
    - drizzle/0040_nifty_mercury.sql
    - drizzle/meta/0040_snapshot.json
  modified:
    - src/lib/db/schema.ts
    - drizzle/meta/_journal.json

key-decisions:
  - "Used drizzle-kit migrate (not push) per project convention; generated migration was clean (2 DDL statements) — no trimming required"
  - "Verified production migration state before applying: prod was current through journal idx 39, so db:migrate applied ONLY idx 40 (is_phantom) and nothing else"
  - "Quarantine is flag-only (is_phantom=true) — zero rows deleted"

patterns-established:
  - "Pre-apply production safety check: confirm max(__drizzle_migrations.created_at) == prior journal when before db:migrate, so only the intended migration applies"

requirements-completed: [IDENT-05]

# Metrics
duration: ~15min
completed: 2026-06-07
---

# Phase 11 / Plan 01: isPhantom Quarantine Column Summary

**Added the `is_phantom` quarantine column + index to `line_contact_student_links` and quarantined 696 OA-resolver phantom rows in production Neon — flag-only, zero deletions.**

## Performance

- **Duration:** ~15 min
- **Completed:** 2026-06-07
- **Tasks:** 2 (schema/migration + production apply)
- **Files modified:** 4 (schema.ts, migration .sql, journal, snapshot)

## Accomplishments
- `is_phantom boolean NOT NULL DEFAULT false` column on `lineContactStudentLinks` (schema.ts) + `line_contact_student_links_phantom_idx` on `(is_phantom, status)`
- Clean 2-statement Drizzle migration `0040_nifty_mercury.sql` (no catch-up bloat)
- Production Neon migrated and 696 phantom rows quarantined; unit suite 1094/1094 green

## Task Commits

1. **Task 1: schema column + index** - `0aedd37` (feat)
2. **Task 2 (local): generate migration** - `933eca6` (feat)
3. **Task 2 (checkpoint): production apply** - runtime action (db:migrate + data UPDATE), not a repo commit

## Files Created/Modified
- `src/lib/db/schema.ts` - isPhantom column + phantom index on lineContactStudentLinks (2 lines added)
- `drizzle/0040_nifty_mercury.sql` - ADD COLUMN is_phantom + CREATE INDEX phantom_idx (exactly 2 DDL statements)
- `drizzle/meta/_journal.json` - appended journal idx 40
- `drizzle/meta/0040_snapshot.json` - drizzle snapshot for idx 40

## Production Apply (checkpoint output, per plan)
- **Migration filename:** `drizzle/0040_nifty_mercury.sql`
- **Trimmed?** No — `db:generate` produced a clean 2-statement migration (no catch-up bloat); no trimming needed.
- **Pre-apply safety check:** Production `max(drizzle.__drizzle_migrations.created_at)` was `1780622893951` (journal idx 39). My migration is idx 40 (`when` 1780769330280). Confirmed `db:migrate` would apply ONLY idx 40 — `0040_student_promotions` (idx 37) and all prior were already applied to production, so nothing unintended ran.
- **Schema apply:** `drizzle-kit migrate` applied successfully; column + index verified present; `max(created_at)` now `1780769330280` (only idx 40 newly recorded).
- **Data migration:** `UPDATE line_contact_student_links SET is_phantom = true WHERE source_kind = 'line_oa_resolver';` → **`UPDATE 696`**.
- **Quarantined row count:** **696** (>= 520 required).
- **Post-verify:** is_phantom=true: 696; is_phantom=false: 7 (the `line_display_name` real links); total: 703 (unchanged — zero deletions); OA-resolver rows with is_phantom=false: 0.
- **Test pass count:** 1094/1094 (unit suite). Integration suite (testcontainers) not run — Docker unavailable locally; migration SQL is standard DDL and applied cleanly to production.

## Decisions Made
- Confirmed the production journal state before applying to avoid the `db:migrate`-applies-all-pending hazard flagged in the plan; production was current through idx 39, so the apply was surgical (only the is_phantom migration).
- Actual OA-resolver row count was 696 (plan estimated ~520; the OA-resolver has accumulated more rows since planning). The 7 `line_display_name` links were correctly left un-quarantined.

## Deviations from Plan
None of substance. The orchestrator performed the production checkpoint inline at the user's explicit request (rather than the user running the commands), with a pre-apply production-state safety check added before `db:migrate`. Quarantine count (696) exceeds the planned estimate (~520) but satisfies the `>= 520` must_have.

## Issues Encountered
- `db:migrate` emitted an SSL-mode deprecation warning (pg-connection-string v3 future change) — informational only, migration applied successfully.

## User Setup Required
None — production DB already migrated and quarantined.

## Next Phase Readiness
- `is_phantom` exists in production and in the committed Drizzle schema/migration, so Wave 2 plans (11-03 filter, 11-05 phantom scope) can rely on it. Testcontainers-based tests will apply `0040_nifty_mercury.sql` and get the column automatically.
- 696 phantom rows are now excluded from active worklist queries once Wave 2 adds the `is_phantom = false` filters.

---
*Phase: 11-ident-01-webhook-side-line-identity-resolution*
*Completed: 2026-06-07*
