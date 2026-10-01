# SDD ledger — plan: docs/superpowers/plans/2026-10-01-tutor-offboarding-pr1-dashboard.md
Worktree: /Users/kevinhsieh/Developer/Scheduling/.claude/worktrees/slot-a (branch feat/tutor-offboarding)
Owner ruling (pre-flight, 2026-10-01): keep the plan's copies of the autowriter render script (Task 10) and UI atoms (Task 8); no autowriter files touched. Follow-up: extract a shared preview kit + atoms later.
Owner gate: no push / PR without explicit OK (Task 12 Step 4). Task 12 Step 3 review = the SDD final whole-branch review.
Task 0: complete (no code; rebased on origin/main 4d3bd32f, migration 0102 free, node_modules cloned, Docker 29.4 up)
Ruling (attribution): subagent commits carry their own model's Co-Authored-By line (e.g. Sonnet 5.5) per their harness; accurate attribution beats the plan's Opus line. Not a defect.
Note: pre-existing integration failures on origin/main (date rot): post-class-feedback nightly-reminders (1), tutor-sit-ins workflow (11); also tutor-sit-ins/coverage.test needs Node 22+ (Map.groupBy). Out of scope.
Task 1: review 1 — spec ❌, 2 Important (both plan-mandated; owner ruled): (1) missing-column guarantee false → owner chose migration-first gate (apply 0102 before PR 1 merges; fix comments/spec/plan); (2) roster-facts error must be "<Name> (<SQLSTATE>)", never message text → new shared src/lib/db/sql-state.ts.
Task 1: minor (deferred): activated:false extraction not pinned in roster-facts.test.ts
Task 1: minor (deferred): roster-facts.integration.test.ts:81 selects first sync_runs row instead of result.syncRunId
Task 1: minor (deferred): roster-facts.ts:37-38 line break inside ${} placeholder (readability)
Task 1: minor (deferred): known→null overwrite of relation clears OFF-03 exclusion for one sync if Wise omits it (removal still blocked: relation must be TEACHER; PR 2 re-reads live roster)
Task 1: minor (deferred): audit log called "Immutable" without append-only trigger; grants email lacks CHECK (email = lower(btrim(email)))
Follow-up: consolidate sqlStateOf copies (src/lib/db/sql-state.ts vs feedback-autowriter/db-errors.ts) after fix/drizzle-unique-violation-cause + fix/missing-table-sqlstate merge.
Task 1: fix round 1/5 (2 addressed, 0 open — migration-first gate wording; SQLSTATE-only roster facts error via src/lib/db/sql-state.ts; commits 64569bd4..257fa929)
Task 1: minor (deferred): spec §11 step 3 still says "apply migrations to production" after both PRs — ambiguous next to the new step-1 gate for migration A
Task 1: minor (deferred): plan Task 1 Step 9 shows the pre-fix single sync test; committed test is a superset (failure-path cases + vi.mock) — doc drift
Task 1: minor (deferred): failure-path assertions live in the integration project, which CI does not run (CI runs `npm test` = unit only)
Task 1: minor (deferred, pre-existing): orchestrator.ts modality-history, pruning and outer catches still persist/log full err.message (query text + params)
Task 1: minor (deferred): missing 0102 also breaks non-sync readers (tutor-sit-ins/sources.ts:99 selects tutorWiseAccounts) — covered by the migration-first gate
Task 1: complete (commits de313297..257fa929, review clean after 1 fix round)
PAUSED after Task 1 at owner request (handoff to GPT-6 Astra). Next: Task 2.

Resumed 2026-10-01 by Codex. User requests aggressive GPT-6.1 Sol / GPT-6 Luna delegation and completion before 14:00 Bangkok.
Ruling: execute dependency-aware parallel lanes (core, UI, routes/docs), with targeted tests and independent whole-branch review, instead of serial per-task agents; latest user speed/token instruction takes precedence.
Ruling: GSD execute-phase initialized, but this plan is outside the historical LINE milestone (phase_found=false); resume the existing approved SDD plan and ledger, preserving unrelated .planning state.
Ruling: add source-backed Confirmed terminated evidence from the user-provided Tutors sheet, separate from estimated likelihood; preserve all exclusions and removal gates. Read actual effective strikethrough; never infer from blank or merely unstruck names. No Sheet writes.
Source check: 80 nonempty tutor rows, 27 with all populated name fields D:F struck through; D151:F1060 empty. Read 2026-10-01.
Task 2: complete — calibration test RED import failure, GREEN 6/6; committed core calibration.
Task 3: complete — score and day-label tests RED import failure, GREEN 9/9; all plan types available to parallel workers.
Task 2-6: Ruling: commit attribution GPT-6.1 Sol replaces plan Claude attribution — explicit user instruction; no behavior cost.

Task 8/UI pre-flight: Tasks 2/3/6 types, date labels, dashboard fixture builder match Task 8 consumers; optional termination contract is owner-authorized addition, not a scoring change.
Task 8: Ruling: keep supplied staff assertion and capitalize the standalone removal guidance sentence — supplied component used lower-case text but test required upper-case — no behavior cost.
Task 9: Ruling: nav description says review Wise accounts, because PR1 adds no removal controls — prevents suggesting an action the page cannot yet perform — no functional cost.
UI TDD: baseline component imports and tutor-offboarding nav assertion failed before implementation (12:20 Bangkok).
Task 4: complete — integration RED import failure, GREEN 3/3 on scratch Testcontainers Postgres; core files produce no typecheck errors (parallel UI/source modules still incomplete).
Task 5: complete — integration RED import failure, GREEN 5/5 on scratch Testcontainers Postgres; API mapper GREEN 4/4, privacy logging assertions pass.
Task 6: complete — dashboard test RED import failure, GREEN 4/4; service built after reading bundled Next use-cache/cacheLife/cacheTag guides. Whole typecheck pending parallel files.
Task 8: complete (baseline components; RED import failure → GREEN 10 component checks; scoped eslint passed; model GPT-6.1 Sol).
Task 9: implementation and scoped checks complete (20/20 UI/navigation checks; scoped eslint passed); global typecheck/unit gate remains for parent after concurrent lanes finish.

OFF-15 source implementation: commits 8b3a1100, 42170724, 1dc844f9. Parser/matcher 12 unit tests green; source persistence 3 integration tests green; exact live Sheet parse gives 80 rows / 27 marked. Source was read only; no production DB or Wise access.
Ruling: email columns contain modality notes on two source rows; parser treats non-email text as unknown instead of rejecting an otherwise valid source, covered by regression test.
Ruling: source confirmations use unique exact email/full-name matching, with all unstruck rows included in ambiguity checks; a future or malformed source timestamp is visibly stale.
Fresh origin/main check: still 4d3bd32f; migration 0102 remains free.
Task 7: complete — four admin/owner API routes and 10 route tests; targeted Vitest passed, route ESLint passed; commit 4c2541e5. Request-path scan found no Wise/Sheets calls under routes; only termination-sync owns the Sheets fetch.
Task 11: complete — feature/API/database/Wise docs plus environment reference and commented optional credential example; records the separate OFF-15 source, exact-name/email matching, stale/error visibility, no score override, and that production import/sync is not verified; diff check passed; commit b829d742.
