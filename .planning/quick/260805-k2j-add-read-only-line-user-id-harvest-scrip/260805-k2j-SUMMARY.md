---
quick_id: 260805-k2j
plan: 1
subsystem: line-integration
tags: [drizzle, postgres, tsx, cli, line, schedule-bot]

# Dependency graph
requires:
  - phase: chore/line-schedule-bot-admins (commits 2a17065..9f72002 on this branch)
    provides: the `/schedule` LINE bot itself (`schedule-bot.ts`/`-group.ts`/`-command.ts`),
      `LINE_SCHEDULE_BOT_ADMIN_IDS` allowlist gate, and the `line_contacts`/`line_messages`
      onboarding write path (`review-service.ts`'s non-admin fall-through)
provides:
  - "scripts/find-line-user-ids.ts — read-only CLI that turns onboarding DMs into a
    paste-ready lineUserId list for LINE_SCHEDULE_BOT_ADMIN_IDS"
  - "npm run line:find-user-ids npm script entry"
  - "First-ever documentation of LINE_SCHEDULE_BOT_ADMIN_IDS in docs/reference/env.md"
  - "Onboarding a new schedule-bot admin operator recipe in docs/operations/runbook.md"
affects: [line-integration docs, operations runbook, future admin-operator onboarding]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Read-only harvest-script shape: loadEnvConfig(process.cwd()) + getDb() + a single
      .select()...innerJoin()...where() call, zero .insert/.update/.delete anywhere in the
      file — mirrors scripts/backlog-recovery-dry-run.ts and scripts/delete-line-test-data.ts"

key-files:
  created:
    - scripts/find-line-user-ids.ts
  modified:
    - package.json
    - .env.example
    - docs/reference/env.md
    - docs/features/line-integration.md
    - docs/operations/runbook.md

key-decisions:
  - "Followed the plan's own Planner Notes verbatim: docs/features/student-schedule.md
    does not exist in this repo (edited docs/features/line-integration.md's existing
    'Schedule bot (/schedule)' section instead); docs/reference/env.md did not yet
    document LINE_SCHEDULE_BOT_ADMIN_IDS at all (added it as a new table row rather than
    amending a nonexistent note, bumping only that section's local heading count 3->4,
    leaving the separately-stale top-of-doc TL;DR table untouched); the runbook's given
    ~line 212 is unrelated cron-auth prose (added the onboarding recipe under the
    existing 'Other one-off scripts' section instead, ~line 152). All three corrections
    were re-verified against the live file contents before editing and matched exactly."

requirements-completed:
  - QIDS-01-harvest-script
  - QIDS-02-npm-script-wiring
  - QIDS-03-docs-notes

duration: ~15min
completed: 2026-08-05
---

# Quick Task 260805-k2j: Add read-only LINE user ID harvest script

**Read-only `npm run line:find-user-ids` CLI joins `line_messages` to `line_contacts` for inbound `BGSCHED`-tagged onboarding DMs and prints a paste-ready, de-duplicated `LINE_SCHEDULE_BOT_ADMIN_IDS` list, plus doc notes clarifying the allowlist covers the full admin operator team and the onboarding recipe to grow it.**

## Performance

- **Duration:** ~15 min (approximate — exact start timestamp not captured; the two task commits themselves are ~1m42s apart, most time went to interface verification before Task 1 and a cold `npm ci` install)
- **Completed:** 2026-08-05
- **Tasks:** 2/2 completed
- **Files:** 1 created, 5 modified

## Accomplishments

- New `scripts/find-line-user-ids.ts`: a single read-only `SELECT` inner-joining `line_messages` to `line_contacts`, filtered to `direction = "inbound"` messages whose text `ilike`-matches `--match` (default `BGSCHED`) within the last `--since` days (default `7`), ordered newest-first. Prints one `displayName | lineUserId | text | eventTimestamp` line per match, then a blank line, then a de-duplicated comma-joined `lineUserId` list ready to paste into `LINE_SCHEDULE_BOT_ADMIN_IDS`. Prints a clear "No inbound LINE messages matching..." message when nothing matches, instead of silent/empty output.
- Wired as `npm run line:find-user-ids` (`tsx scripts/find-line-user-ids.ts`) in `package.json`, immediately after the existing `line:test-data:cleanup` entry.
- Confirmed strictly read-only by construction: `grep -nE "\.insert\(|\.update\(|\.delete\("` against the file returns nothing.
- Four small, surgical doc edits (no other content in any of the four files changed):
  - `.env.example` — one added sentence to the existing `LINE_SCHEDULE_BOT_ADMIN_IDS` comment block noting operator-team scope and the harvest script.
  - `docs/reference/env.md` — first-ever documented row for `LINE_SCHEDULE_BOT_ADMIN_IDS` in the "Optional — LINE feature flag + credentials" table (heading count bumped 3→4); the separately-stale top-of-doc TL;DR reconciliation table was deliberately left untouched (out of scope, per the plan).
  - `docs/features/line-integration.md` — one added sentence to the "Two working surfaces" paragraph in the "Schedule bot (`/schedule`)" section, cross-linking the runbook recipe.
  - `docs/operations/runbook.md` — added `line:find-user-ids` to the "Other one-off scripts" list, plus a new "### Onboarding a new schedule-bot admin operator" subsection with the full 5-step recipe (friend OA → DM `BGSCHED <name>` → run the script → append ID(s) to Vercel env var + redeploy → verify with `/schedule help`).
- `npx tsc --noEmit` clean, targeted `npx eslint scripts/find-line-user-ids.ts` clean (0 errors/warnings), and the full `npm test` unit suite green both after Task 1 and again after Task 2 (357 test files / 4036 tests passing both times).

## Task Commits

Each task was committed atomically on `chore/line-schedule-bot-admins`:

1. **Task 1: Read-only LINE user ID harvest script + npm wiring** — `60b1b3a` (feat)
2. **Task 2: Doc notes — operator-team scope + onboarding recipe** — `8229e48` (docs)

No separate plan-metadata commit was made — per this execution's explicit constraints, SUMMARY.md/STATE.md are committed by the orchestrator, not by this executor.

## Files Created/Modified

| File | Change |
|---|---|
| `scripts/find-line-user-ids.ts` | New — read-only CLI harvesting onboarding-DM `lineUserId`s |
| `package.json` | + `line:find-user-ids` script entry |
| `.env.example` | + one sentence to the `LINE_SCHEDULE_BOT_ADMIN_IDS` comment block |
| `docs/reference/env.md` | + new table row documenting `LINE_SCHEDULE_BOT_ADMIN_IDS` for the first time; local heading count 3→4 |
| `docs/features/line-integration.md` | + one sentence to the "Two working surfaces" paragraph, cross-linking the runbook |
| `docs/operations/runbook.md` | + script mention in "Other one-off scripts"; + new "Onboarding a new schedule-bot admin operator" subsection |

## Decisions Made

- No decisions beyond following the plan's own Planner Notes verbatim. Before editing, all three of the plan's corrected doc locations (`docs/features/line-integration.md` in place of a nonexistent `student-schedule.md`; a new table row in `docs/reference/env.md` in place of a nonexistent existing note; the "Other one-off scripts" section of `docs/operations/runbook.md` in place of an unrelated `~line 212`) were independently re-verified against the live file contents via `grep`/`sed` line lookups, and every interface referenced in the plan (`getDb()`/`Database` from `src/lib/db/index.ts`, the `lineContacts`/`lineMessages` schema shape, the `ilike` precedent in `src/lib/us-universities/query.ts`, the join pattern in `schedule-bot.ts`) matched exactly, so the plan's literal code block was used as-is with no adjustment needed.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Installed missing `node_modules` via `npm ci`**
- **Found during:** Task 1 verification — `npx tsc --noEmit` failed immediately with npx's "This is not the tsc command you are looking for" error.
- **Issue:** This is a freshly created worktree; `node_modules` had never been installed, so no local tools (`tsc`, `eslint`, `vitest`) were resolvable.
- **Fix:** Ran `npm ci`, which installed 886 packages from the existing `package-lock.json` without modifying it.
- **Files modified:** None (`node_modules/` is gitignored; `package-lock.json` byte-identical after install, confirmed via `git diff --stat`).
- **Verification:** `npx tsc --noEmit` then exited 0; `npx eslint` and `npm test` both then ran successfully.
- **Committed in:** N/A — no trackable file changes resulted from the install.

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Environment setup only; no code or scope changes. No scope creep.

## Issues Encountered

None beyond the `node_modules` install above.

## Verification Summary

- `npx tsc --noEmit` — clean (0 errors), run after both tasks.
- `npx eslint scripts/find-line-user-ids.ts` — clean (0 errors/warnings).
- `npm test` — 357 test files / 4036 tests passing, run after Task 1 and again after Task 2.
- `grep -nE "\.insert\(|\.update\(|\.delete\("  scripts/find-line-user-ids.ts` — no matches (read-only confirmed).
- All four Task 2 `<verify>` grep checks (`admin operator team` x3, `Onboarding a new schedule-bot admin operator` x1) — all pass.
- Hard boundary confirmed untouched: `git diff --name-only 9f72002..HEAD -- src/lib/line/schedule-bot.ts schedule-bot-group.ts schedule-bot-command.ts schedule-bot-copy.ts` — empty.
- No new DB tables, migrations (`drizzle/`), API routes (`src/app/`), or UI — confirmed via `git diff --name-only` scoped to those paths, both empty.
- Files touched across both commits match the plan's `files_modified` frontmatter exactly: `scripts/find-line-user-ids.ts`, `package.json`, `.env.example`, `docs/reference/env.md`, `docs/features/line-integration.md`, `docs/operations/runbook.md`.

**Not automated by this execution (per the plan's own `<verification>` section — requires a real dev/scratch database with seeded LINE data this executor does not have):**
- Sending a real `BGSCHED <name>` DM to a dev/scratch OA and confirming the script's printed row + paste-ready ID list against that live data.
- The Vercel env var edit, redeploy, and `/schedule help` verification in the runbook recipe — the user's own manual follow-up steps, explicitly out of scope for this plan.

## Known Stubs

None — this plan adds a standalone CLI script and doc-only edits; no UI or data-rendering surface is touched.

## User Setup Required

None for this plan itself. The runbook's new onboarding recipe documents manual follow-up steps (Vercel dashboard env var edit + redeploy) that remain the user's own responsibility per the plan's explicit scope — no action is required to land this plan's own changes.

## Next Phase Readiness

- `npm run line:find-user-ids` is ready to run against a real database the next time a new schedule-bot operator needs onboarding — no further code changes required.
- The manual smoke test (real `BGSCHED` DM → script run → ID list) and the Vercel env var / redeploy / `/schedule help` verification remain as the user's own follow-up, per plan scope.
- No blockers for merging `chore/line-schedule-bot-admins`.

## Self-Check: PASSED

- FOUND: `scripts/find-line-user-ids.ts`
- FOUND commit: `60b1b3a` (feat(schedule-bot): add read-only LINE user ID harvest script)
- FOUND commit: `8229e48` (docs(schedule-bot): note operator-team scope and onboarding recipe)
- FOUND: `line:find-user-ids` entry in `package.json`
- FOUND: this SUMMARY.md

---
*Quick task: 260805-k2j*
*Completed: 2026-08-05*
