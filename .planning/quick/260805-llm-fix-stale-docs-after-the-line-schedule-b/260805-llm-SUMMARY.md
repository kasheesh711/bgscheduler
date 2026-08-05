---
quick_id: 260805-llm
plan: 1
subsystem: docs
tags: [documentation, line-integration, schedule-bot, runbook, onboarding]

# Dependency graph
requires:
  - phase: chore/line-schedule-bot-admins (commits 2a17065..9f72002 on this branch)
    provides: the `/schedule` LINE bot, the `LINE_SCHEDULE_BOT_ADMIN_IDS` allowlist gate,
      and the student-schedule feature it drives
  - phase: origin/main 241deb5 ("docs: re-document the repo against code")
    provides: a full 72-file doc regeneration (188 tables / 241 endpoints / 25 pages /
      369 test files / 15 crons / 22 features) that this branch was reset onto; already
      carries correct env-var counts (env.md Optional=6, Total=15) and citations, which
      made the original PLAN.md for this quick task obsolete before it ran
  - phase: 260805-k2j (commit c52e907 on this branch, replayed cleanly after the reset)
    provides: "scripts/find-line-user-ids.ts and the `npm run line:find-user-ids` entry
      that this plan documents"
provides:
  - "docs/operations/runbook.md §4.1 'Onboarding a new schedule-bot admin operator' —
    the 5-step recipe (friend the OA -> DM `BGSCHED <name>` -> run the harvest script ->
    append the id + redeploy -> verify with `/schedule help`) that upstream's doc
    regeneration never had, because it predates this branch's schedule-bot work"
  - "docs/operations/runbook.md §3.3 now mentions `npm run line:find-user-ids` as a
    read-only one-off script, alongside the others `package.json:19`-`:33` registers"
  - "Pointers from docs/reference/env.md (LINE_SCHEDULE_BOT_ADMIN_IDS row) and
    docs/features/student-schedule.md (fail-closed-by-env bullet) to the new runbook
    recipe, both resolving to the same verified anchor
    (#41-onboarding-a-new-schedule-bot-admin-operator)"
  - "README.md, .planning/codebase/STACK.md, .planning/codebase/STRUCTURE.md now
    surface `line:find-user-ids` / `scripts/find-line-user-ids.ts` in their
    script/module inventories"
affects: [line-integration docs, operations runbook, env reference, codebase inventory
  docs, student-schedule feature doc]

# Tech tracking
tech-stack:
  added: []
  patterns: []

key-files:
  created: []
  modified:
    - docs/operations/runbook.md
    - docs/reference/env.md
    - docs/features/student-schedule.md
    - README.md
    - .planning/codebase/STACK.md
    - .planning/codebase/STRUCTURE.md
    - .env.example

key-decisions:
  - "Discarded the original 260805-llm-PLAN.md's scope entirely rather than executing
    or amending it. It targeted env.md/runbook.md counts (Optional=3->6, Total=12->15)
    that origin/main's same-day commit 241deb5 ('docs: re-document the repo against
    code') already corrected, better, before this branch was reset onto it. Re-running
    that plan's edits verbatim would have been a no-op at best and a regression at
    worst (re-diffing already-correct numbers). PLAN.md is left on disk untouched as a
    historical record of the superseded scope; this SUMMARY documents what actually
    shipped instead."
  - "Sourced the new scope entirely from this execution's own reconciled instructions
    (seven doc edits + a STATE.md backfill), verified line-by-line against the live,
    regenerated files before writing anything — none of the plan's stale content or
    stale line numbers were reused."
  - "Numbered the new runbook subsection '### 4.1 Onboarding a new schedule-bot admin
    operator' (not an unnumbered heading, unlike the equivalent recipe that existed
    pre-reset) to match every other section's N.M subsection convention in the
    regenerated runbook.md (§§2-9 all number their subsections). Computed the anchor
    via the standard GFM slug rule (lowercase, strip periods, hyphenate spaces) as
    `#41-onboarding-a-new-schedule-bot-admin-operator`, cross-checked against this
    doc set's own existing numbered-heading anchors (e.g. `crons.md#3-the-registry-
    mirror-and-its-test`), and confirmed both new pointer links resolve to the single
    matching heading (`grep -c` = 1)."
  - "Cited `src/lib/line/review-service.ts` for the onboarding DM's 'non-admin
    fall-through' path per the given recipe text, and independently verified it: the
    inbound `line_contacts` row is actually written one layer earlier, in
    `src/lib/line/data.ts`'s `recordLineWebhookPayload` (called synchronously from
    `webhook.ts` before scheduling async work), while `review-service.ts`'s
    `processLineMessageForScheduler` is what skips non-admin senders past the
    schedule-bot's admin gate and then fetches/updates the LINE display name
    (`fetchLineProfile` + `updateLineContactProfile`). The recipe's citation is
    accurate for the display-name fetch and reasonable as the operator-facing
    shorthand for 'the ordinary inbound-message pipeline'; not rewritten, since the
    task's specified content was to be transcribed rather than re-derived."
  - "Left AGENTS.md and CLAUDE.md's '9 required' prose completely untouched — out of
    scope for this reconciled task. AGENTS.md already self-reconciles via its own
    footnote at :307 ('...validates 9 required vars plus 6 optional ones... the
    reconciled inventory is docs/reference/env.md'), and CLAUDE.md is a synced file
    the project convention says not to hand-edit."
  - "Made no changes to any environment-variable count or table in docs/reference/env.md
    or docs/operations/runbook.md beyond the two named pointer/section additions —
    re-verified the TL;DR counts (Optional=6, Total=15) and the Required/Defaulted/
    Optional lists against the live `src/lib/env.ts` before touching either file, and
    they already matched exactly."

requirements-completed:
  - RECON-01-runbook-script-mention
  - RECON-02-runbook-onboarding-recipe
  - RECON-03-inventory-docs-sync
  - RECON-04-env-md-pointer
  - RECON-05-student-schedule-pointer
  - RECON-06-state-md-backfill
  - RECON-07-verify-release-green

duration: ~25min
completed: 2026-08-05
---

# Quick Task 260805-llm: Fix stale docs after the LINE schedule-bot admin work (RECONCILED SCOPE)

**Added the runbook's schedule-bot admin-onboarding recipe (new §4.1: friend the OA -> DM `BGSCHED <name>` -> run `npm run line:find-user-ids` -> append the id to `LINE_SCHEDULE_BOT_ADMIN_IDS` + redeploy -> verify with `/schedule help`), cross-linked it from env.md and the student-schedule feature doc, and surfaced the harvest script across README/STACK/STRUCTURE — after discarding the original PLAN.md, which upstream's same-day doc regeneration (`241deb5`) had already superseded before this task ran.**

## Why the original plan was replaced

`origin/main` gained commit `241deb5` ("docs: re-document the repo against code") on
2026-08-05, independently of this branch, and this branch was subsequently reset onto
it (the harvest-script commit `c52e907` replayed cleanly on top). That regeneration
already fixed every stale count and citation the original `260805-llm-PLAN.md` targeted:
`docs/reference/env.md` already states Optional=**6** / Total=**15** (matching
`src/lib/env.ts`), and `LINE_SCHEDULE_BOT_ADMIN_IDS` / `STUDENT_SCHEDULE_LINK_TTL_DAYS` /
`APP_BASE_URL` are all documented in both `env.md` and `runbook.md`. Re-executing the old
plan verbatim would have re-diffed numbers that were already correct.

**`260805-llm-PLAN.md` in this directory is therefore superseded and was not executed.**
It is left on disk unmodified as a historical record of the pre-reset scope. This
SUMMARY describes the reconciled scope that was actually executed in its place: the one
gap upstream's regeneration genuinely left — it predates this branch's schedule-bot
work, so it has no way to know `scripts/find-line-user-ids.ts` or the operator-onboarding
recipe exist.

## Performance

- **Duration:** ~25 min (verification-heavy: re-confirmed every citation and env-var
  count against live source before writing, computed and cross-checked a new markdown
  anchor, then ran the full `npm run verify:release` chain once)
- **Completed:** 2026-08-05
- **Tasks:** 7 scoped doc edits + 1 planning-state backfill, executed as a single
  reconciled pass (2 commits — see below)
- **Files:** 0 created, 11 modified across both commits (7 docs/inventory files +
  `.env.example` in the first commit; 2 quick-task directories' `PLAN.md`/`SUMMARY.md`
  + `STATE.md` in the second)

## Accomplishments

- **`docs/operations/runbook.md` §3.3** ("Guards and one-off maintenance scripts") now
  lists the read-only LINE user ID harvest alongside the other `tsx` one-offs, described
  exactly as scoped: it "prints inbound LINE DMs matching a code word plus a paste-ready,
  de-duplicated `lineUserId` list." The existing `package.json:19`-`:33` citation range
  needed no change — `line:find-user-ids` already sits inside it (line 26).
- **`docs/operations/runbook.md` new §4.1 "Onboarding a new schedule-bot admin operator"**
  — a 5-step recipe placed at the end of §4 (Environment variables), since it culminates
  in an env-var edit plus redeploy: (1) friend the BeGifted OA, (2) DM it `BGSCHED <name>`
  (writes a `line_contacts` row via the ordinary non-admin message pipeline; the bot
  stays silent by design — fail-closed, not broken), (3) run
  `npm run line:find-user-ids` to get a paste-ready id list, (4) append to
  `LINE_SCHEDULE_BOT_ADMIN_IDS` in production Vercel + redeploy (env vars bake in at
  build time), (5) verify with `/schedule help`. A closing note covers the group-chat
  `/schedule setup staff`/`setup family` step.
- **`docs/reference/env.md`** — the existing `LINE_SCHEDULE_BOT_ADMIN_IDS` row's "If
  unset" cell now points to the new runbook recipe. This is the *only* line changed in
  the file; the TL;DR counts, the Required/Defaulted/Optional tables, and every other
  citation were left exactly as upstream regenerated them.
- **`docs/features/student-schedule.md`** — the "Fail-closed by env" bullet under "LINE
  delivery, in brief" now points to the same runbook recipe.
- **`README.md` / `.planning/codebase/STACK.md` / `.planning/codebase/STRUCTURE.md`** —
  one-line/one-row additions surfacing `line:find-user-ids` and
  `scripts/find-line-user-ids.ts` in the scripts command block, the NPM Scripts table,
  and *both* of `STRUCTURE.md`'s script mentions (the `src/lib/line/` module paragraph,
  which now distinguishes the companion script as living outside that directory, and
  the separate `scripts/` directory enumeration's "LINE/room ops" group).
- **`.env.example`** — the pre-existing uncommitted `LINE_SCHEDULE_BOT_ADMIN_IDS`
  comment-block tweak (noting operator-team scope + the harvest script) was included
  in the first commit, as instructed, rather than left dangling.
- **`.planning/STATE.md`** — backfilled the two `Quick Tasks Completed` rows lost in the
  reset (`260805-k2j`, `260805-llm`) and bumped `Last activity` to today.
- **Zero source changes.** `git diff --stat 241deb5..HEAD -- src/ package.json` shows
  only `package.json | 1 +` (the pre-existing `line:find-user-ids` script entry from
  `c52e907`) — this plan's own two commits touch nothing under `src/`, `scripts/`, or
  `package.json`.
- **`npm run verify:release` passes end-to-end**, run once after all doc edits: typecheck
  clean (both passes), 357 test files / 4036 tests passing, Next.js build succeeds
  (152/152 static pages, two benign `GET /api/post-class-feedback { errorName: 'Error' }`
  build-time log lines from an unrelated route — not a failure), `git diff --check`
  clean, `guard:production-route-surface` passes (207 source routes). Exit code 0.

## Task Commits

Two commits on `chore/line-schedule-bot-admins`:

1. **Doc content fixes** — `7ad5d53` (docs) — the 7 scoped doc/inventory edits plus the
   pre-staged `.env.example` tweak. 7 files changed, 45 insertions(+), 9 deletions(-).
2. **Plan metadata** — committed immediately after this SUMMARY: both quick-task
   directories' `PLAN.md`/`SUMMARY.md` (`260805-k2j` restored as-is; `260805-llm`
   restored with this rewritten `SUMMARY.md` and its original, now-superseded `PLAN.md`
   left untouched) plus `.planning/STATE.md`. Per this execution's explicit
   instructions, this metadata commit is made by this same execution rather than a
   separate orchestrator pass — see `STATE.md`'s `Quick Tasks Completed` table for its
   resulting hash.

## Files Created/Modified

| File | Change |
|---|---|
| `docs/operations/runbook.md` | + harvest-script mention in §3.3; + new §4.1 onboarding recipe |
| `docs/reference/env.md` | + one pointer sentence on the `LINE_SCHEDULE_BOT_ADMIN_IDS` row only |
| `docs/features/student-schedule.md` | + one pointer sentence on the "Fail-closed by env" bullet |
| `README.md` | + `npm run line:find-user-ids` in the one-off maintenance block |
| `.planning/codebase/STACK.md` | + `line:find-user-ids` row in the NPM Scripts table |
| `.planning/codebase/STRUCTURE.md` | + harvest-script mention in both the `src/lib/line/` paragraph and the `scripts/` enumeration |
| `.env.example` | pre-existing staged tweak, included in the first commit as instructed |
| `.planning/STATE.md` | + 2 backfilled `Quick Tasks Completed` rows; bumped `Last activity` |
| `.planning/quick/260805-k2j-.../260805-k2j-{PLAN,SUMMARY}.md` | committed as restored (unmodified by this task) |
| `.planning/quick/260805-llm-.../260805-llm-SUMMARY.md` | rewritten (this file) |

## Decisions Made

See `key-decisions` in the frontmatter above. Summary: (1) treated the original
`260805-llm-PLAN.md` as fully superseded by upstream `241deb5` and did not execute it —
left it on disk as history rather than deleting or amending it; (2) numbered the new
runbook subsection `4.1` for consistency with the rest of the regenerated document, and
independently derived + verified its anchor before using it in two other files; (3)
re-verified the `review-service.ts` citation against the actual message-handling
pipeline rather than taking the given recipe text on faith, and found it accurate for
what it claims (display-name fetch on the non-admin fall-through) even though the
`line_contacts` row write itself lives one file earlier; (4) touched nothing in
`AGENTS.md`, `CLAUDE.md`, or any env-var count/table beyond the two named pointers, all
confirmed via diff after editing.

## Deviations from Plan

None in the sense of Rules 1-4 (no bugs found, no missing functionality, no blocking
issues, no architectural changes) — this execution's own reconciled scope (not the
stale `PLAN.md`) was the instruction set, and every edit matches it. One
verification-only finding worth recording:

**1. [Not a defect] `review-service.ts` is one layer downstream of the actual `line_contacts` INSERT.**
- **Found during:** verification pass before writing the runbook recipe (§4.1, step 2).
- **Detail:** The given recipe text attributes the `line_contacts` row write and the
  display-name fetch to "the normal non-admin fall-through path
  (`src/lib/line/review-service.ts`)". Tracing the actual webhook pipeline: the row
  insert happens synchronously in `src/lib/line/data.ts`'s `recordLineWebhookPayload`
  (called from `src/lib/line/webhook.ts`, itself called from the route handler) *before*
  `review-service.ts`'s `processLineMessageForScheduler` runs asynchronously via
  `after()`. `review-service.ts` is accurately where the non-admin fall-through
  (`if (scheduleBot.handled) return ...` at line 148) and the display-name
  fetch/update (`fetchLineProfile` + `updateLineContactProfile` at lines 150-151) live.
- **Fix:** None needed — the citation is defensible as operator-facing shorthand for
  "the ordinary inbound-message pipeline," and is accurate for the display-name half of
  the claim. Documented here rather than silently rewritten, since the task specified
  this content verbatim.
- **Files modified:** None (verification-only finding).
- **Committed in:** N/A.

---

**Total deviations:** 0 code/content deviations; 1 verification-process note documented
above (not a defect in this execution's output).
**Impact on plan:** None — every doc edit matches the given reconciled scope exactly,
and the one traced citation holds up under scrutiny.

## Issues Encountered

**Resolved, not encountered:** the previous (superseded) SUMMARY for this same quick-task
id flagged that the branch would "need a substantial rebase/reconciliation against
`origin/main` before merge" because of `241deb5`. That reconciliation has since
happened — the branch was reset onto `241deb5` and the harvest-script commit (`c52e907`)
replayed cleanly — so that concern is now closed. This execution's job was the
remaining, smaller gap: documenting what upstream's regeneration couldn't have known
about (the harvest script and the onboarding recipe), which is now done.

No other issues.

## Verification Summary

- **Hard boundary (docs-only):** `git diff --stat 241deb5..HEAD -- src/ package.json` =
  `package.json | 1 +` only (the pre-existing `c52e907` script entry); `scripts/`
  shows only the already-committed `find-line-user-ids.ts`. This plan's own commit
  (`7ad5d53`) touches none of `src/`, `scripts/`, or `package.json`.
- **Anchor integrity:** `^### 4.1 Onboarding a new schedule-bot admin operator$` in
  `docs/operations/runbook.md` matches exactly once; both new pointer links
  (`docs/reference/env.md`, `docs/features/student-schedule.md`) reference the
  identical, verified anchor `#41-onboarding-a-new-schedule-bot-admin-operator`.
- **Numeric integrity:** `docs/reference/env.md`'s single changed line was diffed
  in isolation (`git diff -- docs/reference/env.md`) and confirmed to be *only* the
  appended pointer sentence — no digit, count, or existing citation altered. The
  Optional=6/Total=15 TL;DR and the Required/Defaulted/Optional tables were re-checked
  against `src/lib/env.ts:3`-`24` before editing and needed no correction.
  `docs/operations/runbook.md`'s `package.json:19`-`:33` citation range was left as-is
  (still accurate — `line:find-user-ids` sits at line 26, inside the range).
- **Footer integrity:** all seven touched files' `_Verified against HEAD + uncommitted
  WIP on 2026-05-31._` footers confirmed unchanged (same text, same line numbers) after
  editing.
- **Release gate:** `npm run verify:release` — **exit code 0**. Chain: `typecheck`
  (clean) -> `test` (357 files / 4036 tests passing) -> `build` (Next.js 16.2.2,
  152/152 static pages) -> `typecheck` (clean) -> `git diff --check` (clean) ->
  `guard:production-route-surface` (207 source routes, passed).

## Known Stubs

None — docs-only plan, no UI or data-rendering surface touched.

## User Setup Required

None for landing this plan's own changes. The runbook's new §4.1 recipe documents a
manual follow-up (Vercel dashboard env-var edit + redeploy) that remains the user's own
responsibility whenever a new schedule-bot operator is actually onboarded — no action
is required to land this plan's changes themselves.

## Next Phase Readiness

- `chore/line-schedule-bot-admins` (now at the plan-metadata commit atop `7ad5d53`,
  atop `c52e907`, atop `origin/main`'s `241deb5`) is internally consistent, fully
  reconciled with upstream, and passes `verify:release`. No outstanding rebase/merge
  concern remains — that was the previous (superseded) SUMMARY's open item, and it is
  now closed by the reset itself.
- No blockers to merging this branch. The schedule-bot feature (commits
  `2a17065`..`9f72002`), the harvest script (`c52e907`), and this plan's doc fixes are
  all committed and self-consistent as of `HEAD`.
- The manual smoke test (a real `BGSCHED` DM against a dev/scratch OA -> script run ->
  Vercel env-var append + redeploy -> `/schedule help` verification) remains the user's
  own follow-up, per the recipe's own scope — not something a docs-only quick task can
  automate.

## Self-Check: PASSED

- FOUND: `docs/operations/runbook.md` (§3.3 mention + new §4.1 present)
- FOUND: `docs/reference/env.md` (pointer present, single-line diff confirmed)
- FOUND: `docs/features/student-schedule.md` (pointer present)
- FOUND: `README.md`, `.planning/codebase/STACK.md`, `.planning/codebase/STRUCTURE.md`
  (harvest-script mentions present)
- FOUND: `.env.example` (staged tweak included)
- FOUND commit: `7ad5d53` (docs(260805-llm): document the LINE user-ID harvest script
  and admin-onboarding recipe)
- FOUND commit: `c52e907` (feat(schedule-bot): add read-only LINE user ID harvest
  script — pre-existing, referenced by the STATE.md backfill)
- FOUND: this SUMMARY.md

---
*Quick task: 260805-llm*
*Completed: 2026-08-05*
