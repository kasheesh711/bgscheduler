---
quick_id: 260805-llm
plan: 1
type: execute
wave: 1
depends_on: []
files_modified:
  - docs/operations/runbook.md
  - docs/reference/env.md
  - README.md
  - .planning/codebase/STACK.md
  - .planning/codebase/STRUCTURE.md
  - AGENTS.md
autonomous: true
requirements:
  - DOC-01-runbook-env-table
  - DOC-02-runbook-citation
  - DOC-03-env-md-reconcile
  - DOC-04-inventory-sync
  - DOC-05-zero-source-diff
  - DOC-06-anchor-integrity
branch: chore/line-schedule-bot-admins
worktree: /Users/kevinhsieh/Developer/bgscheduler-line-admins

must_haves:
  truths:
    - "The Operations Runbook §3 env table lists LINE_SCHEDULE_BOT_ADMIN_IDS, STUDENT_SCHEDULE_LINK_TTL_DAYS, and APP_BASE_URL, so the runbook's own onboarding recipe, which says the bot is 'gated by LINE_SCHEDULE_BOT_ADMIN_IDS (§3)', is no longer false"
    - "docs/reference/env.md's TL;DR reconciliation table and prose agree with the rest of the document: Optional = 6, Total declared = 15, matching src/lib/env.ts:3-24"
    - "STUDENT_SCHEDULE_LINK_TTL_DAYS and APP_BASE_URL are documented in docs/reference/env.md for the first time, in their own subsection, not folded into the LINE credentials subsection"
    - "README.md, .planning/codebase/STACK.md, .planning/codebase/STRUCTURE.md, and AGENTS.md all surface the line:find-user-ids script / find-line-user-ids.ts / the /schedule bot allowlist, closing the stale-inventory gap left by commit 8229e48"
    - "git diff --stat origin/main..HEAD -- src/ scripts/ package.json is empty after this plan -- zero source changes"
    - "The #onboarding-a-new-schedule-bot-admin-operator anchor still resolves: the runbook heading text is unchanged, and both existing referrers (docs/reference/env.md, docs/features/line-integration.md) still point at it"
    - "npm run verify:release passes, or any failure is demonstrably pre-existing and unrelated to this docs-only change"
  artifacts:
    - path: "docs/operations/runbook.md"
      provides: "§3 env table with the 3 missing rows; corrected package.json citation range"
      contains: "LINE_SCHEDULE_BOT_ADMIN_IDS"
    - path: "docs/reference/env.md"
      provides: "Reconciled Optional=6/Total=15 counts; new student-schedule-link subsection"
      contains: "Optional — student-schedule links (2)"
    - path: "README.md"
      provides: "line:find-user-ids in the scripts/ maintenance block"
      contains: "npm run line:find-user-ids"
    - path: ".planning/codebase/STACK.md"
      provides: "NPM Scripts table row for line:find-user-ids"
      contains: "line:find-user-ids"
    - path: ".planning/codebase/STRUCTURE.md"
      provides: "find-line-user-ids.ts in the scripts/ file enumeration"
      contains: "find-line-user-ids.ts"
    - path: "AGENTS.md"
      provides: "LINE Integration feature row mentions the /schedule bot + its allowlist var"
      contains: "LINE_SCHEDULE_BOT_ADMIN_IDS"
  key_links:
    - from: "docs/operations/runbook.md (§3 table)"
      to: "docs/operations/runbook.md (#onboarding-a-new-schedule-bot-admin-operator)"
      via: "the new LINE_SCHEDULE_BOT_ADMIN_IDS row links to the onboarding recipe below it"
      pattern: "LINE_SCHEDULE_BOT_ADMIN_IDS.*onboarding-a-new-schedule-bot-admin-operator"
    - from: "docs/reference/env.md"
      to: "docs/operations/runbook.md"
      via: "existing onboarding-recipe cross-link, must remain intact"
      pattern: "runbook\\.md#onboarding-a-new-schedule-bot-admin-operator"
    - from: "docs/features/line-integration.md"
      to: "docs/operations/runbook.md"
      via: "existing onboarding-recipe cross-link, must remain intact"
      pattern: "runbook\\.md#onboarding-a-new-schedule-bot-admin-operator"
---

<objective>
Fix the stale documentation left behind by commit `8229e48` ("note operator-team scope and
onboarding recipe"): that commit added an onboarding recipe to the Operations Runbook that
cross-references a table row which doesn't exist, and left `docs/reference/env.md`
self-contradictory (its own subsection heading says "(4)" optional LINE vars but its TL;DR table
at the top still says "3"/"12"). It also never touched the four inventory docs that list npm
scripts / feature summaries, so those still don't mention `line:find-user-ids` or the `/schedule`
bot's admin allowlist.

Purpose: `src/lib/env.ts` is the ground truth for every environment variable BGScheduler reads
through its Zod schema. Three docs (`docs/operations/runbook.md`, `docs/reference/env.md`, and
`AGENTS.md`) either omit or miscount the three newest schema fields
(`LINE_SCHEDULE_BOT_ADMIN_IDS`, `STUDENT_SCHEDULE_LINK_TTL_DAYS`, `APP_BASE_URL`), and a broken
in-doc cross-reference actively misleads whoever follows the runbook's own onboarding recipe.

Output: six documentation files edited, zero source changes. `git diff --stat
origin/main..HEAD -- src/` stays empty before and after this plan.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@src/lib/env.ts

**Ground truth (verified against `src/lib/env.ts` at HEAD, lines 3-24):** 15 declared vars.
7 hard-required (no `.default()`/`.optional()`): `DATABASE_URL`, `AUTH_GOOGLE_ID`,
`AUTH_GOOGLE_SECRET`, `AUTH_SECRET`, `WISE_USER_ID`, `WISE_API_KEY`, `CRON_SECRET`.
2 defaulted: `WISE_NAMESPACE` (:10), `WISE_INSTITUTE_ID` (:11).
6 optional: `LINE_CHANNEL_SECRET` (:13), `LINE_CHANNEL_ACCESS_TOKEN` (:14),
`ENABLE_LINE_SCHEDULER` (:15), `LINE_SCHEDULE_BOT_ADMIN_IDS` (:19),
`STUDENT_SCHEDULE_LINK_TTL_DAYS` (:21), `APP_BASE_URL` (:23).
`safeParse` at :29, throw at :32, `export const env = getEnv()` at :37.

**Do NOT touch (explicitly out of scope, tracked separately at `docs/OPEN-QUESTIONS.md:46`):**
the `## Environment Variables (9 required)` table at `AGENTS.md:194`, or any other "9 required"
prose anywhere in the repo. That is a *different*, pre-existing drift (7 hard-required vs. "9" in
prose) unrelated to this plan's job (documenting the 3 newest optional vars).

**Do NOT touch:** anything under `src/`, `scripts/`, or `package.json`. This plan is docs-only.

**Naming collision to be aware of (do not confuse the two):** `src/lib/leave-requests/config.ts:17`
exports its own local constant literally named `APP_BASE_URL`, derived from `NEXT_PUBLIC_APP_URL` /
`SCHEDULE_EMAIL_PUBLIC_BASE_URL` / `VERCEL_URL` — this is unrelated to `process.env.APP_BASE_URL`
(the new `src/lib/env.ts:23` schema field this plan documents). Same name, different variable,
different subsystem.
</context>

<tasks>

<task type="auto">
  <name>Task 1: Reconcile the two self-contradictory reference docs (runbook.md, env.md)</name>
  <files>docs/operations/runbook.md, docs/reference/env.md</files>
  <action>
Read both files first (Edit requires a prior Read). Apply the following edits exactly —
each "Find" block is the `old_string`, each "Replace with" block is the `new_string` for the
Edit tool. Do not paraphrase; use the text verbatim.

=== docs/operations/runbook.md — Edit 1 of 2 (add 3 rows to the §3 env table) ===

Find (this is the end of the §3 table, immediately before the "The README documents..."
paragraph):
```
| `ENABLE_LINE_SCHEDULER` | optional | feature flag |

The README documents additional runtime variables consumed by leave-requests and
```

Replace with:
```
| `ENABLE_LINE_SCHEDULER` | optional | feature flag |
| `LINE_SCHEDULE_BOT_ADMIN_IDS` | optional | comma-separated LINE user IDs allowed to drive the `/schedule` bot; empty/unset disables it, fail-closed by construction (`src/lib/env.ts:19`) — see the [onboarding recipe](#onboarding-a-new-schedule-bot-admin-operator) below |
| `STUDENT_SCHEDULE_LINK_TTL_DAYS` | optional | days a parent schedule link stays live before expiring; defaults to 30 (`src/lib/env.ts:21`) |
| `APP_BASE_URL` | optional | absolute origin used to build parent schedule links; unset means previews/localhost link to themselves (`src/lib/env.ts:23`) |

The README documents additional runtime variables consumed by leave-requests and
```

This is what repairs the broken cross-reference later in the same file (§4's "Onboarding a new
schedule-bot admin operator" section, currently ~line 163), which says the bot is "gated by
`LINE_SCHEDULE_BOT_ADMIN_IDS` (§3)" while §3 previously had no such row.

=== docs/operations/runbook.md — Edit 2 of 2 (fix the stale package.json citation) ===

Find:
```
`room-capacity:import-model`, `room-utilization:sync`, `line:find-user-ids`, and the
`guard:sales-dashboard-scope` check (`package.json:19`–`package.json:26`). These
```

Replace with:
```
`room-capacity:import-model`, `room-utilization:sync`, `line:find-user-ids`, and the
`guard:sales-dashboard-scope` check (`package.json:19`–`package.json:33`). These
```

(Verified against the real `package.json`: `credit-control:seed-admin-ownership` is still at
line 19, but `guard:sales-dashboard-scope` is now at line 33 — six `payout:*` scripts and
`line:find-user-ids` were inserted between them since the citation was written.)

Do NOT modify the "### Onboarding a new schedule-bot admin operator" heading text anywhere in
this file — it is the anchor target for two external cross-references (checked in Task 3).

=== docs/reference/env.md — 6 edits ===

Edit 1 (schema line-range citation):

Find: `Zod schema. Here is the exact reconciliation, derived from \`src/lib/env.ts:3-16\`:`

Replace with: `Zod schema. Here is the exact reconciliation, derived from \`src/lib/env.ts:3-24\`:`

Edit 2 (TL;DR table: Optional row + Total row):

Find:
```
| **Optional** (may be absent; if present must be non-empty for the two `.min(1)` ones) | `.optional()` | **3** | `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, `ENABLE_LINE_SCHEDULER` |
| **Total declared in schema** | | **12** | |
```

Replace with:
```
| **Optional** (may be absent; if present must be non-empty for the two `.min(1)` ones) | `.optional()` | **6** | `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, `ENABLE_LINE_SCHEDULER`, `LINE_SCHEDULE_BOT_ADMIN_IDS`, `STUDENT_SCHEDULE_LINK_TTL_DAYS`, `APP_BASE_URL` |
| **Total declared in schema** | | **15** | |
```

Edit 3 (the "three optional" summary sentence):

Find:
```
The three optional LINE/feature-flag variables in the schema
(`src/lib/env.ts:13-15`) are omitted from the prose "9" entirely.
```

Replace with:
```
The six optional variables in the schema (`src/lib/env.ts:13-23`) — four
LINE-related plus the two student-schedule-link variables below — are omitted
from the prose "9" entirely.
```

Edit 4 (module-load citation in the "Critical caveat" section):

Find: `` `src/lib/env.ts:29` eagerly runs validation at module-eval time: ``

Replace with: `` `src/lib/env.ts:37` eagerly runs validation at module-eval time: ``

Edit 5 (schema-declared variable count):

Find: `These are the 12 variables the Zod schema knows about. "Runtime guard" describes`

Replace with: `These are the 15 variables the Zod schema knows about. "Runtime guard" describes`

Edit 6 (new subsection — insert after the LINE feature-flag mermaid diagram, before the
`---` that precedes "## Variables read at runtime but not in the Zod schema". Placed as a
sibling of "Hard-required (7)" / "Defaulted (2)" / "Optional — LINE feature flag + credentials
(4)", since these two vars are schema-declared. Deliberately NOT folded into the "(4)" LINE
section — see Planner Notes for why):

Find:
```
  T -->|yes| ON["lineSchedulerEnabled() = true"]
  T -->|no| OFF
```

---

## Variables read at runtime but **not** in the Zod schema
```

Replace with:
```
  T -->|yes| ON["lineSchedulerEnabled() = true"]
  T -->|no| OFF
```

### Optional — student-schedule links (2)

Not LINE credentials — kept separate from the "Optional — LINE feature flag + credentials (4)"
section above. Both back the parent-facing student-schedule link (`POST
/api/student-schedule/link`, and the LINE `/schedule` bot's DM and group-chat flows).

| Variable | Schema (`src/lib/env.ts`) | Purpose | Consumed at | Behavior |
|---|---|---|---|---|
| `STUDENT_SCHEDULE_LINK_TTL_DAYS` | `z.coerce.number().int().positive().optional()` (line 21) | Days a minted parent schedule link stays valid before expiring. | `src/app/api/student-schedule/link/route.ts:55`; `src/lib/line/schedule-bot.ts:134`; `src/lib/line/schedule-bot-group.ts:124` | Unset or non-positive → falls back to `DEFAULT_LINK_TTL_DAYS = 30` (`src/lib/student-schedule/links.ts:27`) |
| `APP_BASE_URL` | `z.string().url().optional()` (line 23) | Absolute origin used to build the student-schedule link URL. | `src/app/api/student-schedule/link/route.ts:19`; `src/lib/line/schedule-bot.ts:131`; `src/lib/line/schedule-bot-group.ts:121` | Unset → the admin API route falls back to the inbound request's own origin; the LINE bot falls back to the hardcoded `DEFAULT_BASE_URL = "https://bgscheduler.vercel.app"` (`schedule-bot.ts:78`) |

> Same name, unrelated variable: `src/lib/leave-requests/config.ts` also exports a constant
> called `APP_BASE_URL`, derived from `NEXT_PUBLIC_APP_URL` / `VERCEL_URL` (see the base-URL
> cascades note further below) — that is a different value from `process.env.APP_BASE_URL`
> documented here.

---

## Variables read at runtime but **not** in the Zod schema
```

Leave `docs/reference/env.md` line ~270 ("Prose says '9 required'; Zod says 7") UNCHANGED — it
remains accurate and is out of scope.
  </action>
  <verify>
    <automated>cd /Users/kevinhsieh/Developer/bgscheduler-line-admins && grep -n 'LINE_SCHEDULE_BOT_ADMIN_IDS.*fail-closed by construction' docs/operations/runbook.md && grep -n 'STUDENT_SCHEDULE_LINK_TTL_DAYS.*defaults to 30' docs/operations/runbook.md && grep -n 'APP_BASE_URL.*previews/localhost link to themselves' docs/operations/runbook.md && grep -n 'package.json:19.\{1,2\}package.json:33' docs/operations/runbook.md && grep -n '^### Onboarding a new schedule-bot admin operator$' docs/operations/runbook.md && grep -n 'src/lib/env.ts:3-24' docs/reference/env.md && grep -n '\*\*Total declared in schema\*\* | | \*\*15\*\* |' docs/reference/env.md && grep -n 'src/lib/env.ts:37.\{1,2\} eagerly runs validation' docs/reference/env.md && grep -n 'These are the 15 variables' docs/reference/env.md && grep -n '### Optional — student-schedule links (2)' docs/reference/env.md</automated>
  </verify>
  <done>All 10 grep checks above print at least one match each. The runbook §3 table has exactly 3 new rows immediately after the ENABLE_LINE_SCHEDULER row. docs/reference/env.md's TL;DR table shows Optional=6/Total=15, and a new "### Optional — student-schedule links (2)" subsection documents both STUDENT_SCHEDULE_LINK_TTL_DAYS and APP_BASE_URL with real consumer citations.</done>
</task>

<task type="auto">
  <name>Task 2: Sync the stale inventories (README, STACK, STRUCTURE, AGENTS)</name>
  <files>README.md, .planning/codebase/STACK.md, .planning/codebase/STRUCTURE.md, AGENTS.md</files>
  <action>
Read each of the four files first, then apply these edits exactly (one `old_string` /
`new_string` pair per file — each is a single-line addition to an existing list/table/row).

=== README.md ===

Find:
```
npm run line:test-data:cleanup
npm run guard:sales-dashboard-scope
```

Replace with:
```
npm run line:test-data:cleanup
npm run line:find-user-ids
npm run guard:sales-dashboard-scope
```

=== .planning/codebase/STACK.md ===

Find:
```
| `line:test-data:cleanup` | `tsx scripts/delete-line-test-data.ts` | Delete LINE test data |
| `guard:sales-dashboard-scope` | `node scripts/check-sales-dashboard-scope.mjs` | Guard sales-dashboard change scope |
```

Replace with:
```
| `line:test-data:cleanup` | `tsx scripts/delete-line-test-data.ts` | Delete LINE test data |
| `line:find-user-ids` | `tsx scripts/find-line-user-ids.ts` | Harvest LINE user IDs for the schedule-bot allowlist (read-only) |
| `guard:sales-dashboard-scope` | `node scripts/check-sales-dashboard-scope.mjs` | Guard sales-dashboard change scope |
```

=== .planning/codebase/STRUCTURE.md ===

Find:
```
- Contains: seeds (`seed-credit-control-admin-ownership.ts`, `seed-tutor-business-profiles.ts`), AI scheduler evals (`evaluate-ai-scheduler*.ts`, `compare-ai-scheduler-models.ts`, `replay-ai-scheduler-runs.ts`), `import-room-capacity-model.ts`, `sync-room-utilization.ts`, `delete-line-test-data.ts`, `check-sales-dashboard-scope.mjs`
```

Replace with:
```
- Contains: seeds (`seed-credit-control-admin-ownership.ts`, `seed-tutor-business-profiles.ts`), AI scheduler evals (`evaluate-ai-scheduler*.ts`, `compare-ai-scheduler-models.ts`, `replay-ai-scheduler-runs.ts`), `import-room-capacity-model.ts`, `sync-room-utilization.ts`, `delete-line-test-data.ts`, `find-line-user-ids.ts`, `check-sales-dashboard-scope.mjs`
```

=== AGENTS.md ===

Find:
```
| 10 | LINE Integration | stable (write-path dry-run) | LINE OA inbox: webhook ingest, contact resolution, classifier + scheduler reviews, OA-resolver, Wise-action audit. Reply/Wise writeback flag-gated (`ENABLE_LINE_SCHEDULER`) and dry-run only. | [line-integration](docs/features/line-integration.md) |
```

Replace with:
```
| 10 | LINE Integration | stable (write-path dry-run) | LINE OA inbox: webhook ingest, contact resolution, classifier + scheduler reviews, OA-resolver, Wise-action audit, and an operator-gated `/schedule` bot allowlisted via `LINE_SCHEDULE_BOT_ADMIN_IDS`. Reply/Wise writeback flag-gated (`ENABLE_LINE_SCHEDULER`) and dry-run only. | [line-integration](docs/features/line-integration.md) |
```

Do NOT touch the "## Environment Variables (9 required)" table further down in AGENTS.md
(~line 194), and do NOT touch the "_Verified against HEAD..." footer date in any of these
four files.
  </action>
  <verify>
    <automated>cd /Users/kevinhsieh/Developer/bgscheduler-line-admins \
      && grep -n 'npm run line:find-user-ids' README.md \
      && grep -n 'line:find-user-ids.*Harvest LINE user IDs' .planning/codebase/STACK.md \
      && grep -n 'find-line-user-ids.ts' .planning/codebase/STRUCTURE.md \
      && grep -n 'LINE_SCHEDULE_BOT_ADMIN_IDS' AGENTS.md</automated>
  </verify>
  <done>All 4 grep checks above print at least one match each; each of the 4 files carries exactly its one-line/one-row addition and is otherwise unchanged.</done>
</task>

<task type="auto">
  <name>Task 3: Verify anchor integrity, zero source diff, and the release gate</name>
  <files>N/A -- verification only (reads the 6 files edited above; runs shell commands; writes nothing)</files>
  <action>
Run these checks in order; inspect each command's output before moving to the next.

1. Anchor integrity -- confirm the heading backing `#onboarding-a-new-schedule-bot-admin-operator`
   is unchanged, and both external referrers still point at it:
```bash
cd /Users/kevinhsieh/Developer/bgscheduler-line-admins
grep -n '^### Onboarding a new schedule-bot admin operator$' docs/operations/runbook.md
grep -n 'runbook.md#onboarding-a-new-schedule-bot-admin-operator' docs/reference/env.md docs/features/line-integration.md
```
   The first grep must print exactly one match; the second must print one match per file (two
   lines total). Zero matches on either means an edit in Task 1 broke the anchor -- fix before
   continuing.

2. Scope check -- must print nothing:
```bash
git diff --stat origin/main..HEAD -- src/ scripts/ package.json
```
   Any output means an edit touched a forbidden path -- revert it before continuing.

3. Full diff sanity check -- confirm only doc files changed:
```bash
git diff --stat origin/main..HEAD
```
   Expect the 6 files this plan edits (`docs/operations/runbook.md`, `docs/reference/env.md`,
   `README.md`, `.planning/codebase/STACK.md`, `.planning/codebase/STRUCTURE.md`, `AGENTS.md`),
   plus files already dirty from prior commits on this branch (`.env.example`,
   `.planning/STATE.md`, the `260805-k2j-*` plan/summary files, and duplicate entries for
   `docs/features/line-integration.md`, `docs/operations/runbook.md`, `docs/reference/env.md`,
   `package.json`, `scripts/find-line-user-ids.ts`).

4. Release gate, run last:
```bash
npm run verify:release
```
   Run this directly -- do not pipe through `tail`/`head` (swallows the exit code, a known
   footgun on this project per `.planning/STATE.md`'s anti-patterns list). This chains
   `typecheck` -> `test` -> `build` -> `typecheck` -> `git diff --check` -> `guard:production-route-surface`.
   Since this plan touches nothing under `src/`, `scripts/`, or `package.json`, a clean exit (0)
   is expected. If any step fails, confirm from the output that it is pre-existing/environmental
   and not caused by this plan's edits, then say so plainly in the SUMMARY rather than treating
   the task as failed.
  </action>
  <verify>
    <automated>cd /Users/kevinhsieh/Developer/bgscheduler-line-admins \
      && test -z "$(git diff --stat origin/main..HEAD -- src/ scripts/ package.json)" && echo SCOPE_CLEAN \
      && npm run verify:release; echo "verify:release exit code: $?"</automated>
  </verify>
  <done>Both anchor greps in step 1 return the expected match counts; the scope-check diff in step 2 is empty; `npm run verify:release` exits 0, or a non-zero exit is confirmed pre-existing/environmental and documented plainly in the SUMMARY.</done>
</task>

</tasks>

<verification>
- `git diff --stat origin/main..HEAD -- src/ scripts/ package.json` empty (no source changes)
- `git diff --stat origin/main..HEAD` shows only the expected doc files changed (the 6 from this
  plan, plus the 8 already-dirty files from prior commits on this branch)
- Every grep check in Task 1 / Task 2 / Task 3 returns at least one match
- `#onboarding-a-new-schedule-bot-admin-operator` resolves from both existing referrers
- `npm run verify:release` passes, or its failure is confirmed pre-existing/environmental
</verification>

<success_criteria>
- [ ] `docs/operations/runbook.md` §3 table lists all 15 schema-declared env vars; its
      "gated by `LINE_SCHEDULE_BOT_ADMIN_IDS` (§3)" cross-reference is now true
- [ ] `docs/operations/runbook.md`'s `package.json:19`-`package.json:33` citation matches the
      real file
- [ ] `docs/reference/env.md` is internally consistent: TL;DR says Optional=6/Total=15,
      matching the "(4)" LINE subsection plus the new "(2)" student-schedule-link subsection
- [ ] `README.md`, `.planning/codebase/STACK.md`, `.planning/codebase/STRUCTURE.md`, and
      `AGENTS.md` all mention `line:find-user-ids` / `find-line-user-ids.ts` /
      `LINE_SCHEDULE_BOT_ADMIN_IDS` as appropriate to each file's format
- [ ] `AGENTS.md:194`'s "9 required" table and every other "9 required" prose instance are
      untouched (tracked separately at `docs/OPEN-QUESTIONS.md:46`)
- [ ] Zero changes under `src/`, `scripts/`, or `package.json`
- [ ] `npm run verify:release` passes (or failure confirmed unrelated to this plan)
</success_criteria>

<output>
After completion, create `.planning/quick/260805-llm-fix-stale-docs-after-the-line-schedule-b/260805-llm-SUMMARY.md`
</output>

## Planner Notes

Corrections and judgment calls made while locating the six stated edit sites (all verified
against the real files, not assumed from the task description):

1. **All stated line numbers checked out closely.** `docs/operations/runbook.md`'s §3 table
   insertion point (~:88, actual: the `ENABLE_LINE_SCHEDULER` row is at line 88) and the
   `package.json` citation (~:157, actual: line 157) both matched exactly.
2. **`package.json:26` -> `package.json:33` confirmed by reading the real file**, not just
   trusting the task description's hint: `credit-control:seed-admin-ownership` is still at
   line 19 (unchanged), but `guard:sales-dashboard-scope` moved from 26 to 33 -- six `payout:*`
   scripts plus `line:find-user-ids` were inserted between them (lines 26-32) since the citation
   was last written.
3. **`docs/reference/env.md`'s new subsection placement was not given a line number** in the
   task description (it only said "add a SHORT new section"). Placed it as a sibling of the
   existing "Hard-required (7)" / "Defaulted (2)" / "Optional -- LINE feature flag + credentials
   (4)" subsections (still inside "## Schema-declared variables", right after the LINE mermaid
   diagram and before that section's closing `---`), since both new vars genuinely are
   schema-declared. This keeps the doc's own bucket math checking out: 7 + 2 + 4 + 2 = 15.
4. **Found and deliberately left alone two more stale citations** in the same runbook §3
   preamble (`src/lib/env.ts:20` and `src/lib/env.ts:22`, now at lines 70 and 72, describing
   where `getEnv()`/`safeParse`/the throw live). These are stale for the same root cause (three
   new schema fields shifted every later line number) but were not in the six-file `<scope>`
   list handed to this plan, and fixing them isn't necessary to repair the specific broken
   cross-reference or self-contradiction this task targets. Flagging for a possible follow-up
   quick task rather than silently expanding this one's scope.
5. **Found a same-name-different-variable trap:** `src/lib/leave-requests/config.ts:17` exports
   its own local constant literally named `APP_BASE_URL`, unrelated to
   `process.env.APP_BASE_URL` (the schema field this plan documents; it is derived from
   `NEXT_PUBLIC_APP_URL` / `SCHEDULE_EMAIL_PUBLIC_BASE_URL` / `VERCEL_URL` instead). Added one
   disambiguating sentence in the new env.md subsection so a future reader doesn't conflate the
   two. This is a minimal, in-scope addition -- it is part of accurately documenting
   `APP_BASE_URL`, not a new topic.
6. **Confirmed the "zero source changes" baseline is real, not aspirational:** `git diff --stat
   origin/main..HEAD -- src/` was already empty before this plan (the three commits ahead of
   `origin/main` on this branch only touch `.env.example`, `.planning/`, `docs/`,
   `package.json`, and `scripts/find-line-user-ids.ts` -- none under `src/`). Task 3 re-checks
   this after the plan's edits to prove it is still true.
