# Open Questions

Things only a human can answer.

This file is the consolidated output of an automated documentation pass that re-read the
BGScheduler codebase and rewrote the handbook, the 22 feature docs, and the API / database / cron /
env reference against `main@0cd1e81`. Every documentation agent in that run was asked to record
anything it could not settle from code alone — a product decision, an operational fact that lives
outside the repository, a suspected bug, or a contradiction between two sources of truth. Those
findings are collected here, de-duplicated, and grouped.

**How to read this.** Each item is a decision, not a task. Evidence is cited as `path:line` so it
can be checked in seconds. Items marked **(re-verified)** were re-confirmed by grep or by opening
the file during this consolidation; the rest carry the citation supplied by the agent that had the
file open. Nothing here was fixed — the pass documented what the code does, and deliberately did
not change behaviour or paper over a contradiction.

**Item IDs are stable and are cited from other pages.**
`docs/reference/api/classrooms-and-assignments.md` points at DEF-9, DEF-11, SEC-2 and SEC-3;
`docs/features/post-class-feedback.md` points at DEAD-13; `docs/features/leave-requests.md` points
at DEF-5; `docs/features/progress-tests.md` points at SEC-17. **Renumber nothing — append.** IDs
from the previous revision that do not appear below were not re-raised by this run; they are
preserved in git history and should be re-checked before anyone treats them as closed.

**Scale context** (re-verified this pass, all by direct command against the tree):

| Measure | Value | Command |
|---|---:|---|
| `pgTable` declarations | **189** | `grep -c "= pgTable(" src/lib/db/schema.ts` |
| `route.ts` files under `src/app` | **180** | `find src/app -name route.ts \| wc -l` |
| Named HTTP handlers | **241** | 99 GET, 95 POST, 34 PATCH, 12 DELETE, 1 PUT |
| Endpoints (see GOV-13) | **243** | 241 named + 2 from the Auth.js destructure |
| Cron entries in `vercel.json` | **17** | `grep -c '"path"' vercel.json` |
| Jobs in the Data Health registry | **22** | `grep -c '^    key: ' src/lib/data-health/cron-registry.ts` |
| Vitest files | **389** | `find src -name "*.test.ts*" \| wc -l` |
| Migrations | **69** | `ls drizzle/*.sql \| wc -l` |
| `page.tsx` files | **31** (26 in `(app)`) | `find src/app -name page.tsx \| wc -l` |
| `schema.ts` length | **4,772 lines** | `wc -l src/lib/db/schema.ts` |

---

## 0. Resolved since the previous revision

Recorded so nobody re-opens them, and so any doc still asserting the old state can be corrected.

- **DEF-1 (credit-control `maxDuration` drift) — FIXED.** (re-verified)
  `src/lib/data-health/cron-registry.ts:122` now declares `maxDurationSeconds: 800` with a comment
  explaining that health derivation reads this value, and `cron-registry.test.ts` pins route-vs-registry
  parity for all 22 entries. **AGENTS.md's "Known drift" section still asserts the old 300 and should
  drop it.**
- **DEF-24 (Student Schedule print report's back link) — FIXED.** `PrintToolbar` now takes
  `backHref`/`backLabel` (`src/components/learning-plan/print-toolbar.tsx:8-14`) and the report passes
  `/student-schedule` (`report/page.tsx:98`).
- **GOV-3 (Leave Requests uncommitted) — FIXED.** `git status --short src/` is empty at HEAD; all nine
  leave-request source files, five routes, page, components and tests are committed. **Any doc or task
  brief still describing Leave Requests as in-flight WIP is stale — including the 🟡 IN PROGRESS badge
  at `docs/reference/database/erd-leave-requests.md:3`.**
- **Post-class payout accrual is no longer `manualOnly`.** It is scheduled hourly
  (`33 * * * *` in `vercel.json`) and has a Data Health dispatch branch (`run-job.ts:141`). Reference
  pages still describing it as parked and un-dispatchable are wrong — see GOV-23.
- **`sync-room-utilization` is a first-class registry entry**, not an orphan handler:
  `cron-registry.ts:370-383` (`manualOnly: true`), a `run-job.ts:197` dispatch branch, a dashboard
  button, an npm script and a registry test. It still has no `vercel.json` entry — that is OPS-2/OPS-22,
  not an oversight in the registry.

---

## 1. Confirmed defects awaiting an owner decision

These are not documentation ambiguities. Each is a behaviour the code demonstrably has, that an
owner should either accept in writing or fix.

**DEF-2 — `src/lib/env.ts` never runs.** (re-verified: `grep -rn 'lib/env"' src/ scripts/` returns
nothing) The module exports `env = getEnv()`, which validates at module-evaluation time — but nothing
evaluates the module. The documented "environment validated at startup, throws on invalid" guarantee
does not hold; consumers read `process.env.*` directly and fail at their own call site. The schema
declares 18 keys (7 hard-required, 2 defaulted, 9 optional) against roughly 69 named env keys read
across `src/`. The file's own comment (`env.ts:28-31`) explains why `src/middleware.ts` cannot import
it (edge runtime; throws on a partial env), so any wiring must exclude the edge path.
*Wire it into a real startup path (root layout or `instrumentation.ts`) and extend it to the live key
set, narrow it to a non-throwing inventory export, or delete it?*

**DEF-3 — Seven Data Health "Run now" buttons return 404 and write a failed audit row.**
(re-verified) The registry declares 22 job keys; `runDataHealthJob` dispatches 15 and falls through to
`{ error: "Unknown job" }, 404` (`src/lib/data-health/run-job.ts:207`). The seven with no branch are
`progress_tests`, `progress_tests_digest`, `post_class_feedback_backfill`, `student_promotions_july_1`,
`admissions_notifications`, `line_credit_digest`, `line_backlog_recovery`. Meanwhile `buildCronJobs`
hard-codes `canRunManually: true` for every job (`dashboard.ts:474`), so the UI promises a button for
all 22. Two of the seven (`post_class_feedback_backfill`, `line_backlog_recovery`) are the only manual
recovery levers their features have.
*Implement the seven branches, or filter `manualActions` to the dispatchable set?*

**DEF-4 — `weekdayForIsoDate` reads the process timezone, not Bangkok.**
`src/lib/proposals/overlap.ts:45-47`. Proven drift: `2026-05-18` → weekday 1 under `Asia/Bangkok`, 0
under UTC. The production runtime TZ is not pinned anywhere in the repo (only `vitest.config.ts:4`).
*Switch to the Bangkok-pinned helper and backfill stored one-time weekdays, or pin `TZ` on the Vercel
project and record that as a deployment invariant?*

**DEF-5 — Leave Requests has no abandoned-run recovery, so one timeout wedges it forever.**
`leave_request_sync_runs` carries the single-running partial unique index (`schema.ts:2110`) but
`src/lib/leave-requests/sync.ts` only detects the `23505` and throws (`sync.ts:57`, `:385`). A function
killed at `maxDuration` strands the row and every later tick returns 409 until an operator runs
`UPDATE … SET status='failed'` by hand. Seven other `*_sync_runs` lineages were opened this pass and
all sweep stale rows on a 20-minute cutoff. The fix is a `markAbandonedRuns` mirror in
`src/lib/leave-requests/sync.ts` — a path this documentation pass was forbidden to edit.

**DEF-8 — Competitor Intelligence returns 500 for malformed request bodies.** (re-verified)
`competitorIntelligenceErrorResponse` (`src/lib/competitor-intelligence/access.ts:32-53`) has branches
for `HANGING_PROMISE_REJECTION`, `Unauthorized` and `Forbidden`, then falls through to
`{ error: error.message }, 500`. Five routes call throwing `Schema.parse()` on the request body, so a
malformed body is a 500 that serialises the raw Zod message into the response — the opposite of the
repo convention, and something the post-class mapper deliberately refuses to do.
*Add a `ZodError → 400` branch, or switch those five routes to `.safeParse()`?*

**DEF-9 — `GET /api/class-assignments/runs/[runId]/teacher-schedule` 500s on a missing run.**
No 404 branch (`teacher-schedule/route.ts:19-22`).

**DEF-11 — The publish poll erases the live-conflict banner.** The terminal publish-poll detail
hard-codes `liveRoomBlocks: []` and `roomConflictWarnings: []`, discarding a conflict surfaced by
`POST /run`. A PATCH override additionally resets every row's publish state and zeroes the run publish
counters (`src/lib/classrooms/data.ts:1064-1114`).
*Should only affected rows reset?*

**DEF-12 — `createWiseCancelPreview` records ids it never previewed.** It throws only when **zero**
submitted ids belong to the request (`data.ts:623`), then logs the raw submitted list (`:659`) while
the endpoints and `cancellationPreviewCount` come from the filtered rows (`:637`, `:649`). A foreign id
lands in the audit trail without ever being previewed.
*Reject the request outright, or log the matched ids?*

**DEF-13 — `updateLineContactLabels` is a destructive "partial" update.** Both label columns are
written with `input.x ?? null` (`src/lib/line/data.ts:366-382`), so omitting `linkedParentLabel`
clears it. `commitLineAliasImport` routes through the same helper passing only `linkedStudentLabel`
(`contact-aliases.ts:497`), so **every alias-import commit wipes `linkedParentLabel`** on the affected
contacts.
*Deliberate full-replace, or unintended data loss? Is `linkedParentLabel` still load-bearing?*

**DEF-15 — The Wise Activity reconciliation backfill stops on its second run.**
`backfill/route.ts:42-46` never passes `stopOnKnownEvents`, so it defaults to `true` (`sync.ts:163`) —
contradicting the stated intent in `sync/route.ts:49-51` that a targeted backfill must *not* stop on
the first already-known page. With the 15-minute ingest cron healthy, every press of "Backfill selected
range" ends at page one or two with `known_events`. The route also accepts `endDate` only to validate
the pair and never passes it to the engine, and `wiseReconciliationBackfillLookbackDays` clamps at 365
days with no signal in the response. **Net effect: no UI path can extend coverage past the cron's
~3-day horizon.**
*Is `POST /api/wise-activity/sync` the intended deep-crawl path, or should the button send
`stopOnKnownEvents: false`?*

**DEF-16 — Orphan payout invoices are double-counted in Payroll.** They are flagged both `orphan` and
`unresolved_tutor_identity` and open a second `unresolved:<wiseUserId>` aggregate row, inflating
`tutorCount` and `unresolvedTutorCount` (`src/lib/payroll/data.ts:337-342`, `:360-368`, `:515`, `:521`).
The tier sort is `localeCompare` on the tier label (`data.ts:475-481`), so the duplicate row and the
canonical row have no deterministic tiebreak.

**DEF-17 — Sales-dashboard import returns 500 for validation failures.** `POST /api/sales-dashboard/import`
uses throwing `ImportSchema.parse()` and its `errorResponse` helper only special-cases
`MissingGoogleSheetsTokenError` (`import/route.ts:24-28`, `:37`). Sibling verbs in the same family
disagree in the other direction: `sources` POST/PATCH and `projection-source` POST map **every** thrown
error to 400 including genuine DB failures, while `sources/[sourceId]` DELETE maps everything to 500
including the user-actionable "Source is refreshing" guard.

**DEF-18 — `POST /api/credit-control/sync` is guaranteed to time out.** The route sets
`maxDuration = 300` (`sync/route.ts:4`) while its cron twin sets 800 with a comment recording real runs
of 372–390 s (`internal/sync-credit-control/route.ts:7-14`). A manual sync is expected to be killed
mid-run and strand its `running` row until the 20-minute sweep. *Raise it, or retire the manual route?*

**DEF-19 — Search hard-fails on an un-migrated profile table.** `getTutorProfileVersion()`
(`src/lib/search/index.ts:128-137`) lacks the `isMissingTutorProfileTable` guard the workspace has, so
an un-migrated database breaks search while the profile page loads. The guard itself matches the bare
substring `"column"` (`tutor-business-profiles.ts:200-201`) rather than a SQLSTATE.

**DEF-20 — A leave that crosses midnight but lasts under 24 h blocks nothing at all.** The single-day
branch of `hasRecurringLeaveConflict` (`src/lib/search/engine.ts:279-286`) assumes `leaveStart` and
`leaveEnd` share a calendar day. Fail-open and untested. Unreachable via range search; reachable via
the legacy `POST /api/search`. *Fix by duration split or by calendar-day span?*

**DEF-21 — Snapshot retention silently stops working once a classroom run pins a snapshot.**
`pruneOldSnapshots` (`src/lib/sync/snapshot-pruning.ts:64-179`) deletes `snapshots` and
`tutor_identity_groups` but never `classroom_assignment_runs`/`rows`, whose `snapshotId`/`groupId` FKs
declare no `onDelete`. The resulting FK violation is caught and logged by the orchestrator
(`orchestrator.ts:527-541`), so pruning fails silently. `leave_request_affected_sessions.snapshot_id`
(`schema.ts:2177`) has the same shape. *Should pruning skip referenced snapshots, or prune the
dependants with them? Were `deleteClassroomRuns`/`deleteClassroomRowsForRun` (DEAD-11) meant to be
this retention job?*

**DEF-22 — A student-promotion run that crashes mid-apply is unrecoverable.** Nothing writes the
`failed` enum value, nothing sweeps abandoned rows, and re-apply throws `Only verified…`
(`src/lib/student-promotions/data.ts:2299-2301`). *Fresh audit, manual DB edit, or a missing watchdog?*

**DEF-23 — Leave-request tutor matching is last-write-wins on bare first names.** The alias map emits
the bare first name as an alias (`matching.ts:39-40`, `:88-111`) with no ambiguity branch, so two
tutors sharing a first name silently collapse. *Should a collision drop to unmatched?*

**DEF-25 — `fetchAllTeachers` issues a single unpaginated GET.** `src/lib/wise/fetchers.ts:31-37`
reads `data.teachers` with no paging, unlike every other institute-scoped fetcher in the same file. If
Wise ever caps that response, teachers vanish from the snapshot silently — and a large loss produces a
*low* unresolved-identity ratio, so the `<0.5` promotion gate would not catch it. *Is
`/institutes/{id}/teachers` contractually unpaginated? (See EXT-7.)*

**DEF-26 — `PATCH /api/tutor-profiles/[canonicalKey]` returns a framework 500 with no active snapshot.**
`getActiveTutorDisplayNameByCanonicalKey` is called at `route.ts:44`, outside the `try` that begins at
`:49`, so the "No active snapshot found" throw escapes the route's `{ error }` shape. GET,
import-preview and import-commit all wrap the same lookup.

**DEF-27 — `DELETE /api/payroll/adjustments/[adjustmentId]` has no try/catch.** A non-UUID id hitting
the uuid primary key produces a framework 500 with a non-standard body. It is also the only payroll
handler with no route test, is unscoped by month, and records no deleting actor.

**DEF-28 — Proposals: two 23P01 detectors and an unguarded id.** The route-level overlap detector
matches on message substring only (`proposals/route.ts:34-38`) while the data layer also matches
SQLSTATE `23P01` and the constraint property (`data.ts:68-83`), so a driver surfacing only the code on
an error that bypassed the data layer falls through to 500. Separately, PATCH does not validate
`itemId` format, so a non-UUID reaches Postgres as a uuid comparison and surfaces as 500 rather than
404.

**DEF-29 — A publish job that dies before `running` is never swept.** `isStaleRunningPublishJob`
requires `status === 'running'` **and** a `startedAt` (`src/lib/classrooms/data.ts:1335-1338`). A
`pending` job whose background task throws inside `after()` before `runClassroomPublishJob` flips it —
for example `createWiseClientFromEnv()` throwing on unset Wise credentials (`data.ts:1466`,
`:1155-1157`, called from `publish/route.ts:15`) — polls forever in the UI and shows as
`publishPending` in the admin digest until the 07:36 ACTION REQUIRED send.

**DEF-30 — A crashed admin schedule email blocks its date permanently.** If the run row is inserted but
`finalizeEmailRun` never runs, status stays `pending`; `hasTerminalAdminEmailForDate`
(`admin-schedule-email.ts:258-268`) treats only sent/partial/failed as terminal, but the unique
idempotency key rejects the retry insert, so every later attempt returns `skipped`. *Sweep stale
`pending` admin runs the way stale publish jobs are swept?*

**DEF-31 — `GET /api/internal/line-backlog-recovery` hard-codes `dryRun: false`** (`route.ts:19`), so
`runLineBacklogRecovery`'s dry-run mode and its `dryRunMatches` payload are unreachable over HTTP.
Combined with having no Data Health branch (DEF-3), there is no way to preview this job's matches
before it inserts.

**DEF-32 — `POST /api/internal/sync-competitor-intelligence` flattens Forbidden to 401.** It catches
`requireCompetitorIntelligenceSession`'s throw indiscriminately (`route.ts:31-36`); every other CI route
distinguishes 401 from 403.

**DEF-33 — Progress-tests "Resend email" reuses the original idempotency key.**
`teacher-heads-up.ts:285`, `:323-329`. If the Apps Script relay de-duplicates on it, resend is a silent
no-op while the UI reports success (see EXT-3).

**DEF-34 — The DM "multiple verified contacts" prompt has no handler.** The copy asks the admin to
"reply 1 or 2" (`schedule-bot-copy.ts:234-243`) but no numeric handler exists, no pending row is
written (`schedule-bot.ts:441-444`), and `COMMAND_PATTERN` requires ≥2 characters
(`schedule-bot-command.ts:39`). *Implement the choice or change the copy.*

**DEF-35 — Wise Activity double-fetches on every source change.** `onSourceChange` calls
`loadReconciliation(sourceId)` directly (`wise-activity-workspace.tsx:773-776`) **and** sets
`selectedSourceId`, which changes `loadReconciliation`'s identity (`:596`) and re-runs the effect
(`:598-601`). Two reconciliation GETs — each with live Wise calls — per source change, the first with
no abort cleanup.

**DEF-36 — Restoring a recent search silently drops the named-tutor filter.** `saveRecent`
(`search-form.tsx:161-174`) omits `tutorGroupIds`, so the restore path (`:182-205`) cannot reinstate it.

**DEF-37 — `payroll_session_observations.wise_teacher_user_id` can hold a teacher id.**
`getWiseSessionTeacherUserId` (`src/lib/wise/types.ts:322-326`) falls back to `session.teacherId` when
`session.userId` is absent. The tier lookup is by `wiseUserId` (`payroll/data.ts:286`, `:336`), so such
a row raises a spurious `missing_tier`.

**DEF-38 — Three multi-write paths have no transaction and can strand orphans.** The Neon HTTP driver
has none, so: proposal create commits the bundle before the item (best-effort rollback swallows errors,
`proposals/data.ts:361-364`); `acceptCompetitorTaskSuggestion` commits the task before stamping the
suggestion; bulk credit-control actions fan out via `Promise.all` (`actions.ts:96-133`) and can leave a
partial write **and** return 500. Payroll and post-class already use the `pg` driver where transactions
matter. *Move these three, or accept the orphans in writing?*

**DEF-39 — `snapshot_stats` group counters are not group counts.** `unresolvedGroups` is set to
`identityIssues.length` — an issue count — and `resolvedGroups` only excludes groups matched by
`entityId === canonicalKey`, so a solo group created for an unresolvable teacher (whose issue carries
`entityId = teacher._id`, `identity.ts:186`) still counts as resolved
(`src/lib/sync/orchestrator.ts:462-463`). Any dashboard reading these as group counts mis-reports.

**DEF-40 — The room-capacity forecast reports DB faults as a healthy empty model.**
`forecast/route.ts:6-14` decides the missing-model 200 by plain substring match on four
`room_capacity_*` table names rather than the `relation … does not exist` check other optional-table
routes use. A permission error or constraint violation naming one of those tables is returned to the
client as `status: "missing"` with HTTP 200. The missing-forecast body is also hand-maintained in two
places (`data.ts:358-383` and `forecast/route.ts:16-41`).

**DEF-41 — `recomputeAffectedSessionsForRequest` leaves a stale count.** With no active Wise snapshot
it deletes the child rows and returns 0 without resetting `affectedClassCount`
(`src/lib/leave-requests/data.ts:417`). *Zero it, or keep the stale value as a signal?*

**DEF-42 — `POST /api/progress-tests/book` parses `modality` and drops it.** The schema accepts
`'online' | 'offline'` (`book/route.ts:10`) and the dialog sends it, but the handler never forwards it
to `bookTest` (`:31-37`).

**DEF-43 — The AI Scheduler decision checklist can never pass on a ranked-suggestion turn.**
`AiDecisionChecklist` derives its Availability tile from `payload.availabilitySummary?.tutors.length ?? 0`
(`scheduler-workspace.tsx:1001`, `:1034-1037`); ranked-suggestion turns carry no `availabilitySummary`,
so the tile always reads "No availability proof" even when proven suggestions exist.

**DEF-44 — `POST /api/line/contacts/refresh-profiles` fans out over the entire contacts table.** One
sequential LINE profile call per row (`contact-aliases.ts:509-543`), no scoping, no batching, no
try/catch in the handler, and no `maxDuration` export — unlike `followers-reanchor`, which sets 300. On
a roster of ~1,962 followers this looks certain to hit the platform default timeout. *Still used, or
superseded by `followers-reanchor`?* (Formerly SCALE-7.)

---

## 2. Maturity, lifecycle & documentation governance

**GOV-5 — Three shipped surfaces named in the maturity map have no feature doc.** The map supplies 25
badge keys; `docs/features/` holds 22 pages. Missing: **`student-report`** (Parent Report — its `(app)`
page, `src/lib/student-report/`, the `(print)/student-report/report` surface, `/api/student-report`),
**`line-credit-bot`** (`src/lib/line/credit-bot.ts`, `credit-digest.ts`, the
`/api/internal/line-credit-digest` cron at `3 2 * * *`), and **`post-class-payout`**
(`src/lib/post-class-feedback/payout-*.ts`, the hourly payout-accrual cron). All three are
nav- or cron-registered production surfaces.
*Write three pages, or fold `line-credit-bot` into `line-integration.md` and `post-class-payout` into
`post-class-feedback.md` — and settle the headline feature count (22, 24, or 25)?*

**GOV-6 — Six API reference group pages linked from the index do not exist.** (re-verified against
`ls docs/reference/api/`) Absent: `competitor-intelligence.md`, `post-class-feedback.md`,
`progress-tests.md`, `student-schedule.md`, `us-universities.md`, and any home for the new
`student-report` group. `misc.md` has no `student-report` section either.
*Create them, or repoint the index at `misc.md` and add the missing sections there?*
Note that `docs/reference/database/index.md` **does** exist (an earlier agent reported it missing).

**GOV-7 / GOV-8 — Canonical-home calibration.** Three recurring borderline cases were flagged and are
currently resolved in favour of the feature doc; an owner should confirm the policy:
1. Feature docs that carry a method + path + one-line-purpose table for their whole group (payroll,
   credit-control, ai-scheduler, sales-dashboard) — allowed today because no request/response shapes
   appear, but it is a second place to keep in sync.
2. Narrating an enum's full value set with lifecycle meaning (proposals) while the same page promises
   that "enum value sets are not repeated here".
3. Prose that names most of a table's columns (credit-control packages/sessions, tutor-profiles detail
   pane, learning-plan grant table).

**GOV-11 — AGENTS.md, CLAUDE.md and README.md inventories are materially behind the tree.**
(re-verified, see the Scale context table) AGENTS.md asserts 188 tables / 178 route files / 241
endpoints / 15 crons / 369 tests / 65 migrations / 25 `(app)` pages / a 4,719-line `schema.ts`; every
one is wrong. It also omits the `student-report` API group, lists `internal` at 30 endpoints (actual
31), and says "21 nav tools" where `NAV_TOOLS` now has 22. `docs/README.md` and
`docs/handbook/overview.md` were **not** regenerated in this pass and carry the same stale figures plus
a coverage claim that every nav tool has a feature page. The same stale "15 Vercel Crons" appears in
two code comments: `src/lib/maintenance.ts:5` and `.env.example:48` (both re-verified).
*Regenerate all four documents from code, or nominate one as authoritative.*

**GOV-13 — Endpoint-count convention.** 241 named `export async function` handlers plus 2 from the
Auth.js catch-all destructure (`export const { GET, POST } = handlers`, which matches no `function`
grep) = **243**, excluding the 2 CORS preflight `OPTIONS` handlers on the public OA-resolver routes.
AGENTS.md states 241 arrived at as 239 + 2. *Settle one rule and apply it in both AGENTS.md and
`docs/reference/api/index.md`.*

**GOV-14 — Page-count convention.** 31 `page.tsx` files repo-wide; 26 in the `(app)` route group; the
rest are `/login`, the public `/schedule/[token]`, and three `(print)` surfaces (learning-plans,
student-schedule, **student-report**). *Which figure is the headline, and which feature doc owns
`src/app/(print)/student-report/report/page.tsx`?*

**GOV-18 — Branch and merge path.** (re-verified) `0cd1e81` is the tip of
`fix/payout-auto-approve-emergency`, four commits ahead of `origin/main` (`fed828d`), and
`git branch -r --contains 0cd1e81` is empty — it is on no remote branch. *Confirm the intended merge
path before these docs are treated as describing `main`.*

**GOV-19 — The mandated footer's two assertions are both false of this checkout.** Every regenerated
page ends `_Verified against main@0cd1e81 (clean tree)…_`, but (a) `0cd1e81` is not on `main` (GOV-18)
and (b) the working tree was not clean — ~56 files under `docs/`, `AGENTS.md`, `README.md` and
`.planning/codebase/*` were modified concurrently by this same run, plus four untracked `scripts/*.ts`.
**`git status --short src/ drizzle/ vercel.json` *is* empty**, so every code claim in the doc set holds
against committed source. Roughly 25 agents flagged this independently.
*Keep the fixed string, or restamp the set as `fix/payout-auto-approve-emergency@0cd1e81` after merge?*

**GOV-20 — `schema.ts` line ranges in the reference set have drifted ~3 lines.** Confirmed across
`erd-core.md` (IPEDS §6, progress-tests §5, student_schedule_links, room-capacity), `erd-ai-and-proposals.md`,
`erd-tutor-profiles.md`, `erd-student-promotions.md`, `erd-leave-requests.md`, `erd-room-capacity.md`,
`erd-line.md` and `database/index.md`. A single regeneration against one commit fixes all of them.

**GOV-21 — Two ERD pages are structurally stale.** `erd-university-admissions.md` opens by describing
25 tables at `schema.ts:2983-3396`; the schema declares 36 `admissions_*` tables at `3965-4634` (and
`erd-core.md` §8 already says 36). `erd-line.md` counts 12 tables, omits `line_credit_digest_runs`
(`schema.ts:4740`) and the `creditDigest*` columns on `line_group_settings`, and
`database/index.md` has **no entry at all** for `line_credit_digest_runs`.

**GOV-22 — Cron schedules in the reference set predate the 2026-08→09 stagger changes.** Stale
schedules found: `sync-wise-activity` `5,35` (actual `2,17,32,47`), `sync-competitor-intelligence`
`25 18 * * 0` (actual `28 18 * * 0`), `classroom morning` `45 23` (actual `41 23`), `classroom admin
email` `0,10,20,30 0` (actual `4,14,24,36 0`, final retry 07:36 not 07:30), and both
`post-class-feedback/payout-accrual` (`33 * * * *`) and `line-credit-digest` (`3 2 * * *`) missing
entirely. Affected: `docs/reference/crons.md`, `docs/reference/api/internal-crons.md`,
`docs/reference/api/wise-activity.md`, `docs/reference/api/classrooms-and-assignments.md`,
`docs/operations/runbook.md:401`, `docs/handbook/overview.md:61`.

**GOV-23 — `internal-crons.md` is stale on the payout-accrual job in two places.** `:63` lists it as
"Not scheduled" and `:395` names it among the keys with no `run-job.ts` branch; both are contradicted
by `vercel.json` and `run-job.ts:141-149`. The same page says the job runner dispatches "14 of the 21"
keys (actual: 15 of 22) and cites `run-job.ts:195` for the 404 (actual `:32` and `:207`).

**GOV-24 — `docs/reference/api/misc.md` contradicts itself and the code.** `:75` says the post-class
and competitor-intelligence handlers "let the mapper convert the ZodError to 400" while `:464`
correctly says that family has no 400 mapping (DEF-8 confirms `:464`). It also lists 21 registry keys
and omits `line_credit_digest` (which is `dangerous: true`), cites `getDataHealthDashboardPayload` at
`dashboard.ts:885` (actual `:899-1015`), claims the data-health route re-exports `selectModalityIssues`
"for tests" when no test imports it (DEAD-14), and documents only four of the five `payout-runs`
actions — `verify_sheet` (`payout-runs/route.ts:56-61`) is missing.

**GOV-25 — `docs/proposals/2026-09-02-cron-efficiency-and-wise-webhooks.md` links to
`docs/reference/wise-webhooks.md`, which does not exist.**

**GOV-26 — AGENTS.md's opening banner is machine-generated.** It sits between
`<!-- BEGIN:nextjs-agent-rules -->` / `<!-- END:nextjs-agent-rules -->` markers (`AGENTS.md:1`, `:5`),
so it will be overwritten by whatever tool owns those markers. *Which tool, and should the handbook be
regenerated alongside it? Nobody should hand-edit the banner expecting it to stick.*

**GOV-27 — Two AGENTS.md rule summaries do not match the code.** It calls identity resolution a
"5-step cascade" where `identity.ts` documents four numbered steps plus the REL-03 collision check;
and its fail-closed summary says only cancelled sessions are non-blocking, where
`sessions.ts:34-40` also treats `COMPLETED`, `MISSED` and `NO_SHOW` as non-blocking (a five-status
allowlist — see AMB-1).

**GOV-28 — Badge source of truth.** This run was given an explicit maturity map; the previously
regenerated `docs/README.md` states that no map was supplied and derives each badge from the feature
page's own status line. The two now disagree for Credit Control ("live" vs "stable"), Tutor Compare,
Leave Requests, Progress Tests, University Admissions and Learning Plans. No `@deprecated` or status
marker exists anywhere in code, so **every badge is documentation-side only**. *Which artefact is
authoritative going forward?*

**GOV-29 — Four documents were rewritten in place over pre-existing uncommitted edits.**
`docs/handbook/glossary.md`, `docs/features/progress-tests.md`, `docs/features/competitor-intelligence.md`
and `docs/features/us-universities.md` already existed (tracked at `241deb5`, footer 2026-05-31) and in
three cases carried working-tree modifications from a concurrent process when this run overwrote them.
Every citation was independently re-verified, but *confirm nothing from the concurrent edits needed
recovering, and correct the run inventory that told several agents "no doc existed".*

**GOV-30 — The verifier appears to read `HEAD`, not the working tree.** Two passes
(`proposals.md`, `data-health.md`) found the flagged inaccuracies **already corrected** in the
working-tree copy they opened. If verification reads the committed version, those files will keep
failing on already-fixed items.

**GOV-31 — `src/tests/integration/README.md:3-4` is stale.** It says the harness serves suites "in the
`src/lib/sync/__tests__/` directory"; 9 of the 12 consumers now live under
`src/lib/post-class-feedback/__tests__/`.

**GOV-32 — `docs/reference/api/wise-activity.md:25` calls the transactions CSV export "streamed".**
`src/lib/sales-dashboard/csv.ts:22-33` and the route materialise the whole CSV as one string. The
feature doc is right; the reference page is wrong.

**GOV-33 — Repo edits in this pass bypassed the GSD workflow.** `CLAUDE.md` requires file changes to
start through a GSD command; this documentation run wrote directly, as instructed by the orchestration
script. *Confirm the bypass was intended.*

---

## 3. Suspected dead code and unused surface

Nothing here was deleted. Each needs an owner to say "remove" or "this is reserved".

**DEAD-1 — `src/lib/env.ts`.** See DEF-2.

**DEAD-2 — `src/lib/search/parser.ts` (`parseSlotInput`).** Full test suite, no production importer.

**DEAD-3 — Five unimported search components.** `results-view.tsx`, `slot-builder.tsx`,
`slot-chips.tsx`, `slot-input.tsx`, `ai-scheduler-panel.tsx`. The last is the only in-repo caller of
`POST /api/search/assistant`, so that endpoint currently has **no in-app UI consumer** despite being on
the middleware public allowlist (it still requires a session in-handler).

**DEAD-4 — `POST /api/search` (legacy slot search) and `GET /api/tutors`.** Neither has any caller in
`src/`; the form posts to `/api/search/range` (`search-form.tsx:138`) and nothing consumes the
`intersection` field. *Retained for an external or bookmarked client, or retire?* (Feature docs should
also drop the "for the searchable tutor combobox" consumer claim on `/api/tutors`.)

**DEAD-5 — AI Scheduler one-shot parser.** `parseSchedulingRequestWithOpenAi`,
`normalizeAiSchedulerModelParse`, `buildAiSchedulerPrompt`, `openAiSchedulerJsonSchema`,
`resolveAiSchedulerFilters`, `resolveAiSchedulerTutorNames` in `src/lib/ai/scheduler.ts` have no
production caller and disagree with the conversational solver on bare-weekday handling (clarify at
`scheduler.ts:515` vs assume-recurring at `scheduler-conversation.ts:1243-1254`). `aiSchedulerShadowModel()`
/ `OPENAI_SCHEDULER_SHADOW_MODEL` (`scheduler.ts:465-467`) likewise has no caller.

**DEAD-6 — `src/lib/payroll/may-reconciliation.ts`.** Imported only by its own test.

**DEAD-7 / DEAD-8 — Credit Control dead exports and inert snapshot-diff machinery.**
`buildDashboardModel` is always called with `{ lastSnapshot: null, history: [] }` (`service.ts:88-93`),
so `statusChange`, `balanceDelta`, `previousUpdatedAt` and `summary.deltas` are always trivial and
`buildSnapshotForPersistence` / `updateHistory` / `buildHistoryPoint` / `buildWeeklyBuckets`
(`analytics.ts:598-675`) plus `HISTORY_LIMIT` have no live consumer. Separately, Sheets-era residue with
no caller outside its own file: the `SHEET_*` names, `DASHBOARD_ACTION_*_SHEET` /
`INACTIVE_STUDENTS_SHEET` headers, `REQUIRED_COLUMNS`, `SHEETS_IN_MEMORY_TTL_MS`, `DASHBOARD_CACHE_TAG`,
`DASHBOARD_CACHE_REVALIDATE_SECONDS`, `ActionStateRow`/`ActionLogRow`/`SnapshotState`,
`fallbackStudentKey`/`fallbackPackageKey`, `defaultCreditAdminOwnership`, and the whole
`src/components/credit-control/filter-toolbar.tsx` (`FilterToolbar` has no importer; the shell renders
an inline filter bar).

**DEAD-9 / DEAD-10 — Sales Dashboard.** `churnList` / `churnedStudents` / `eligibleStudents`
(`analytics.ts:295-302`, `:323-324`) and the persisted `churn_status` column have no consumer;
`GET /api/sales-dashboard/import-runs` and `GET /api/sales-dashboard/sources` have no caller in `src/`;
`insertGoogleSheetRow` and `updateGoogleSheetRowValues` in `sheets.ts` have no caller anywhere.

**DEAD-11 — Classroom assignment orphans.** `classroomTimestampToWiseIso` (`data.ts:359`, tests-only and
assumes a UTC process TZ), `deleteClassroomRowsForRun` (`:1922`), `deleteClassroomRuns` (`:1928`),
`isKevinPriorityTutor` (`rooms.ts:152`), `PREFERRED_ROOMS` (`:174`). See DEF-21 for why the two delete
helpers matter.

**DEAD-12 — `lineBacklogRecoverySyncRuns`.** (re-verified: `grep -rn lineBacklogRecoverySyncRuns src/`
returns only `schema.ts:2666`) The table and its single-running unique index exist; neither
`src/lib/line/backlog-recovery.ts` nor the internal route writes a run row, so the guard enforces
nothing and the job has no run history. *Vestigial, or an unbuilt write path?*

**DEAD-13 — `post_class_tutor_payout_sheets` is NOT dead.** The schema JSDoc (`schema.ts:3740-3744`)
says "nothing reads or writes it" and `docs/reference/database/index.md` repeats it, but three scripts
and `loadActivePayoutWorkbookRegistry` (`payout-repository.ts:2026-2039`, described there as a
"compatibility registry seam for roll scripts") use it. *Correct the comment and the reference, and
decide whether the two registries should merge and which is canonical.*

**DEAD-14 — `selectModalityIssues` re-exported from `src/app/api/data-health/route.ts:6-12`.** The
payload duplicates the filter inline (`dashboard.ts:418-424`) and no test imports the route export.

**DEAD-15 — `countLeaveRequestActionBadge` (`data.ts:677`) and `affectedSessionLabel` (`:670`).**
Exported with zero callers in `src/`.

**DEAD-16 — Tutor Profiles vocabulary and preview payloads.** `STRENGTH_TAG_VOCABULARY`
(`src/lib/tutor-profile-vocabulary.ts:62-71`) and the `TeachingStyleTag` type (`:73`) have zero
consumers; `TutorProfileImportPreview.vocabulary` (`tutor-profile-import.ts:119-122`, `:882-885`) is
shipped to the client and never read.

**DEAD-17 — Enum members and fields with no writer.** `data_issue_type = 'sync'` (`schema.ts:33`) and
`data_issue_severity = 'low'` (`:40`); `classroom_assignment_run_status = 'failed'`;
`student_promotion_run_status = 'failed'`; `progress_test_booking_status = 'dry_run'`; the
`overflow_only` room category (in the enum and the engine cascade at `assignment-engine.ts:644-650`
but on no default room); `medium` modality confidence (declared at `compare.ts:69` and `types.ts:130`,
emitted by no branch — the docstring calls it "reserved for future phases"); `in_progress` and
`canceled_by_tutor` on leave requests (never set by the sync path; `in_progress` has no sheet keyword
either, only admin PATCH); `competitor_task_comments` (never written) and, in the same domain,
`captureMedia`, `archivedAt`, `reviewStatus` (always `"new"`), `taskSuggestionStatus` (always `"none"`)
and the `backfill` trigger value; `progress_test_attendance_ledger.first_observed_snapshot_id`
(documented as provenance, never written); `PROGRESS_TESTS_CACHE_TAG` (revalidated at nine call sites,
no `cacheTag()` consumer); `isAttendedWithCredit` (`engine.ts:93-101`, exported and tested, never
called in the pipeline); `pctAwardedAid` / `avgGrantAid` (`schema.ts:3099-3100`, never populated —
`Cost2_2024_FinancialAid` and the IC tables are converted but never imported);
`student_schedule_links.view_count` / `last_viewed_at` (written, never read).

**DEAD-22 — Unwired room-capacity endpoints.** `GET /api/room-capacity/month` and `/forecast`: only
caller is their own route test. Git history (`6d076c9` → `3cc56f1`) shows the original month dashboard
was replaced by the utilization dashboard and the component test asserts the heatmap is gone.
*Pending UI, API-only analyst surface, or superseded?*

**DEAD-23 — Unrendered metrics slices.** `GET /api/ai-scheduler/metrics` computes `scheduler`, `line`
and `correction` rollups; `metrics-view.tsx:57` reads `correction` alone, so two aggregators are
computed and discarded on every request.

**DEAD-24 — Unwired filters and fields.** Wise Activity `topActors` / `topClassrooms`
(`data.ts:235-236`) are computed and never rendered; the `sessionId` / `transactionId` filters
(`:106-107`) have no UI; `WiseActivityEvent.participant` (`types.ts:186`) is typed and never
normalised. Discovery's `curriculum` and `level` filters are validated and applied server-side
(`discover/route.ts:20-26`, `:85-93`) but the panel only ever sends `subject`. `WeekOverview` accepts
and destructures a `sharedFreeSlots` prop and never renders it (`week-overview.tsx:242`, `:253`).

**DEAD-25 — Endpoints with no in-app caller.** `POST /api/credit-control/admin-ownership` and
`POST /api/credit-control/sync` (ownership is seeded offline; the cron covers sync);
`GET /api/us-universities` and `GET /api/us-universities/institutions/[unitId]` (both pages call the
cached data helpers directly).

**DEAD-27 — Middleware for a namespace that does not exist.** The `/api/learning-plans*` deny
(`src/middleware.ts:54-57`) guards a namespace with no routes, and only ever runs for restricted users
because `isPathAllowed` is not consulted when `allowedPages` is null (`:97`). *Confirm it is
intentional forward-looking protection so it is not removed as dead code.*

**DEAD-28 — More exported functions with zero callers.** `getYearSummary`
(`src/lib/syllabus/topics-index.ts:6-8`, the form re-implements the lookup inline);
`dataHealthSummaryIsStale` (`dashboard.ts:1017-1019`); `isProposalActiveAt` (`overlap.ts:57-67`);
`markProgressTestBookedManually` (`booking.ts:354-405` — implemented, untested, no caller: *is this a
missing endpoint for the `manual_required` follow-up?*); `revokeStudentScheduleLink`
(`src/lib/student-schedule/links.ts:171-184` — no caller, endpoint, UI or test);
`getStudentMonthlyScheduleForRequest` (`data.ts:410-415`); `buildTaskSuggestionSeed`
(`normalization.ts:227-243`); `budgetUsageRatio` (`budget.ts:32-35`, imported only by its test);
`closePayoutRun` (`payout-run.ts:1023-1036` — reachable only via
`scripts/roll-payout-workbook-dates.ts`; *is CLI-only close intended?*); `parsePayRateRows`
(`src/lib/payroll/rate-card.ts:98-160`, no caller outside its test — see OPS-23).

**DEAD-29 — Two unused escape hatches on the student-promotions apply path.** `allowBeforeTarget`
(`data.ts:161`) and the `targetDate` override (`data.ts:142`) are honoured but never passed by any
route, service or test.

**DEAD-30 — Orphan admissions schema with no code path.** Migrations `0053`/`0054` shipped 11 new
`admissions_*` tables, 2 enums and extra columns to `main` inside `a7c8ef8` (a post-class feedback PR)
with none of the authoring code; the authoring commit `a1db1d0` lives only on
`origin/codex/admissions-parity-hardening`, ~127 commits behind. Concretely orphaned:
`admissions_academic_records` (no write path, route or UI), `admissions_test_sittings.deleted_at` and
`.status` (testing.ts still hard-deletes at `:469-471`), `admissions_cases.family_portal_open`, and
`notificationPrefs` (honoured by digest assembly at `notifications.ts:749-759`, written by nothing on
`main`). *Land the parity branch via rebase, or revert the orphaned schema?*

**DEAD-31 — `scripts/seed-tutor-business-profiles.ts` defaults to a developer's `~/Downloads` paths**
(`:18-19`), bypasses `clearSearchIndex()`, and appears in no runbook. *Operator tool to document, or a
retired one-off whose npm script should go?*

**DEAD-32 — The positional branch of `parseAvailabilityWorkbook`** (columns 0-3 and 18-21,
`tutor-profile-import.ts:346-356`) contradicts the only committed workbook of that name (root
`Availability.xlsx`, first sheet `Master`, an 8-column weekday grid). *Which layout was it written for
— delete it, or give it a header fallback plus a fixture?*

---

## 4. Data model, schema & migrations

**DATA-5 — Free-text columns with closed value sets.** `leave_request_activity_logs.action_type` and
`.status` (`schema.ts:2208-2209`, six and three emitted values); `credit_control_follow_up_state.status`
and `credit_control_follow_up_log.action_type` (vocabularies live only in TypeScript, and the churn pass
writes `auto-remove` / `auto-reactivate` outside the declared union);
`payroll_adjustments.adjustment_type` (no enum or allowlist, so categories are unconstrained across
months); `sales_dashboard_projection_sources.status` is plain text while the sibling
`sales_dashboard_sources.status` is a `pgEnum` with the same default (`schema.ts:626` vs `:725`), and
`trigger_type` / `scenario` / `month_kind` are unconstrained text over closed unions;
`aiSchedulerRuns.status` (`:2391`) and `aiSchedulerFeedback.action` (`:2415`) are text while four
neighbouring columns use `pgEnum`; `room_capacity_demand_mix.mode` is free text whose only producer
hard-codes `"onsite"`; `student_promotion_graduation_actions.status` is free text where the ERD calls
the four-value enum canonical.

**DATA-6 — Type unions that no longer match the data.** `ActionLogRow.action_type`
(`src/types/credit-control.ts:258-262`) and `ActionHistoryEntry.actionType` (`student-detail.tsx:24`)
enumerate the four human values, but the log also carries `auto-clear`, `auto-remove` and
`auto-reactivate`. `getGoogleTokenStatus` returns a `writeConnected` boolean
(`google-oauth.ts:288`) that the `SalesDashboardPayload` `token` type does not declare
(`types.ts:87-92`) yet is serialised to clients.

**DATA-7 — Missing constraints and indexes.**
- `snapshots.active` has **no** database guard (`schema.ts:456-461`); single-activeness is upheld only
  by the orchestrator's bounded promotion `UPDATE` (`orchestrator.ts:489-496`). Every comparable
  "exactly one" in the schema uses a partial unique index. *Promote it?*
- `sales_dashboard_projection_import_runs` has no single-flight partial unique index and
  `importSalesDashboardProjectionSource` acquires no guard, unlike the per-source monthly path. Two
  concurrent projection imports each insert months under their own run id; last writer wins the source
  repoint (see OPS-3).
- Neither `rcfd_scenario_month_idx` nor `rcpm_bucket_idx` is unique, so duplicate driver rows per
  (run, scenario, month) and duplicate package-hour buckets per run are representable.
- The two proposals GiST exclusion constraints are scope-partitioned
  (`drizzle/0006_admin_proposal_holds.sql:52`, `:57`), so mixed recurring-vs-one-time conflicts have no
  DB backstop.
- `lineThreads` is 1:1 with `lineContacts` only by convention — the unique index is on `line_user_id`
  (`schema.ts:2466`), not `contact_id`.
- `ipeds_import_runs` single-flight is **per data year** (`.on(dataYear).where(status='running')`,
  `schema.ts:3019-3021`), unlike every other lineage's `.on(status)`. *Intended, or merely permitted?*
- `data_issues.severity` is written with deliberate intent (`critical` for alias, `high` for most,
  `medium` for the PAST-01 diff hook) but is never selected or filtered in the read path
  (`dashboard.ts:952-960`). *Should severity drive triage, or should the write-side values go?*

**DATA-8 — `payroll_sync_runs` single-flight is global, not per month.** The partial unique index is on
`status` alone (`schema.ts:1776-1778`), so syncing one month 409s every other month.

**DATA-9 — Unvalidated soft references, none carrying a comment explaining why.**
`post_class_sessions.latestFeedbackVersionId` / `firstOnTimeCompliantVersionId`;
`competitor_task_suggestions.acceptedTaskId`; `admissions_cases.committedListItemId`;
`admissions_essays.listItemId`; `admissions_college_docs.testSittingId`;
`admissions_announcements.cohortId`/`caseId`; `admissions_case_tasks.templateId`;
`progress_test_attendance_ledger.firstObservedSnapshotId`;
`lineContactStudentLinks.source_run_id` (`schema.ts:2517`, with three partial indexes built on it) and
`.validation_assigned_run_id` (`:2524`); `sales_dashboard_*.lastSuccessfulImportRunId`
(`schema.ts:627`, `:726` — the pointer every read path dereferences);
`payroll_adjustments.tutorCanonicalKey` (captured at `data.ts:641`, echoed in the DTO, never joined);
`proposal_items.tutorCanonicalKey` (a hold can outlive any tutor identity group);
`proposalItems.bundleId` (`schema.ts:2317`) is the only proposals FK declaring no `onDelete`.
Circular-FK avoidance and soft-delete tolerance are plausible motives but are inferred, not documented.

**DATA-10 — `classroom_rooms` is a name-keyed projection, not an editable catalog.** It declares no FK
and is referenced by nobody; rows store the room *name* in `preferred_room` / `override_room` /
`assigned_room`, and `assigned_room` also carries the non-room sentinels `NO_ROOM_AVAILABLE` and
`REMOTE_NO_ROOM_NEEDED`. Renaming a catalog room silently orphans historical rows. Compounding this,
`TV_REQUIRED_TUTORS`, `PREFERRED_BY_TUTOR`, `PRIORITY_PREFERRED_ROOM_BY_TUTOR` (`rooms.ts:89-163`) and
`RAW_TUTOR_CONTACTS` (`tutor-contacts.ts:24-164`) are hard-coded and re-seeded on every read, and
`ensureDefaultClassroomRooms` (`data.ts:456-478`) overwrites DB edits to default rooms.
*Is deploy-to-change intentional?*

**DATA-15 — `tutor_contacts` is filed under Tutor Profiles but no tutor-profiles code path touches it.**
Writers are the classroom schedule-email path and post-class feedback settings; readers include
post-class dashboard/AI/tutor-emails, progress tests, learning plans and leave-request matching.
*Re-home it in the reference docs, or grow a contacts editor under Tutor Profiles?* Related:
`src/lib/post-class-feedback/ai.ts:158-162` is the only `tutor_contacts` read that does **not** filter
`active = true`, and `src/lib/learning-plans/access.ts:47-57` matches only `onsiteEmail`/`onlineEmail`
and ignores `primaryEmail`.

**DATA-18 — A future session whose teacher cannot be resolved is dropped with no `data_issue`.**
`sessions.ts:64-65` and again at `orchestrator.ts:279-280` — unlike every other unresolvable entity in
the pipeline. *Emit a completeness issue so the loss is countable in `snapshot_stats`?* (See also
DEF-39 and AMB-2.)

**DATA-19 — The unit of `wise_activity_events.transaction_amount` cannot be settled from the repo.**
Ingest stores `payload.transaction.amount.value` raw (`sync.ts:122`) while the receipt/trend fetchers
divide THB by 100 (`fetchers.ts:563-565`); the Activity table formats raw values as currency, and
reconciliation fixtures treat event amounts as minor units (`reconciliation.test.ts:46`, `:52`, `:297`).
If minor, the Activity view overstates by 100× and `persistedEventMatchesSale`'s amount path
(`reconciliation.ts:604`) never matches a sheet amount.

**DATA-20 — Progress-test ledger rows are never retired.** The sync only upserts rows present in the
current source query (`db.ts:242-266`), so a session that later stops matching (refunded credit, status
no longer `ENDED`) stays counted forever. The same shape applies to `room_utilization_sessions`
(upsert-only, `utilization.ts:441-464`): a session removed in Wise keeps its last-known row and keeps
contributing occupied minutes.

**DATA-21 — Stored `room_capacity_demand_mix.share` values do not sum to 1.0** whenever the grouped set
exceeded the 120-row truncation, and no consumer re-normalises them (`data.ts:320-338`).

**DATA-22 — Sales derived columns are frozen at import time and scoped to one month.**
`enrollment_type` and `churn_status` are computed by grouping rows within a single source's parse
against the import-time clock (`parser.ts:165-227`) and read back verbatim (`analytics.ts:295-301`), so
a finalised month's churn labels never age and a student whose trial and first paid package straddle a
month boundary is grouped in neither pass. See also AMB-18.

**DATA-23 — `credit_control_inactive_students.source` values disagree with their own documentation.**
Schema comment says `manual|auto-churn` (`schema.ts:1316`) but Student Promotions writes
`student-promotion-graduation` (`student-promotions/data.ts:2258`), which the UI labels "Manual"
(`dashboard-shell.tsx:1180`).

**DATA-24 — `leave_requests.sourceRowNumber` binds a row to a sheet position** (`offset + 2`,
`parser.ts:344`). *Is "Form Responses 1" guaranteed append-only, and should orphaned rows be reaped?*

**DATA-25 — In-code schema section headers are wrong or orphaned.** `schema.ts:3960` says
"25 tables, prefix `admissions_`" where 36 are declared; a stray
`// ── Admissions Case Management ──` sits at `:3135` directly above the Post-Class Feedback header
while the `admissions_*` tables do not begin until `:3965`; and four LINE tables
(`line_schedule_bot_pending`, `line_group_settings`, `line_credit_digest_runs`,
`line_group_schedule_sends`, `:4668-4772`) were appended under the "Student monthly schedule" header
with no header of their own, detaching the `lineGroupScheduleSends` JSDoc from its table.
(`schema.ts` is on the do-not-edit list for this pass.)

**DATA-26 — `classroom_schedule_email_recipients.resend_email_id` is misnamed.** The id written comes
from an Apps Script sender (`schedule-email.ts:597`, `:919`); the admin lineage's equivalent column is
`providerMessageId`. Which sender delivered a schedule email is also **not persisted** — no
`sender_key` column, so primary vs backup is only inferable from which `email_run_id` a row belongs to.

**DATA-27 — `wiseSessionSubject` prefers the populated `classId.subject` over the session's own
`subject`** (`student-promotions/data.ts:438-443`). If the Wise FUTURE payload embeds the class, every
session of a class whose subject was already moved classifies as idempotent. *Should per-session
subject be authoritative?*

**DATA-28 — Payroll invoices matched to non-`ENDED` sessions count as paid hours** and appear only as
variance, never as an issue (`data.ts:272` vs `:285`).

---

## 5. Time, timezone & date semantics

**TZ-1 — The runtime timezone is not pinned anywhere and cannot be determined from the repo.**
(re-verified: no `TZ` entry in `vercel.json`, `next.config.ts` or `package.json`; only
`vitest.config.ts` pins `Asia/Bangkok`.) Paths that read runtime-local time and would change behaviour
under UTC: `src/lib/search/engine.ts:68`, `:269`, `:279-283`, `:300-304`;
`src/lib/proposals/overlap.ts:45-47` (DEF-4); credit-control `getTodayDate`/`parseDate`/`formatDate`
(`helpers.ts:40-64`, while `formatDateTime` pins Bangkok — so on a UTC runtime the pending-deduction
cut-off, projection day boundaries and "actioned today" flip at 07:00 Bangkok);
`classroomTimestampToWiseIso` (`classrooms/data.ts:359-371`); the Tutor Profiles workspace "Today" and
import default review date (`workspace:48-58`, `:125`, `:710-712`); `search-workspace.tsx:208-212` in
the browser; `/api/compare`'s `date` handling (`route.ts:177`).
*Pin `TZ` on the Vercel project and record it as an invariant, or rewrite these with `date-fns-tz` /
`Intl` like `src/lib/bangkok-time.ts:44-51`?*

**TZ-2 — UTC calendar-day comparison in one-time search.** `engine.ts:180-185` and `:217-219` slice
`toISOString()`, so a Bangkok session before 07:00 local is attributed to the previous day.
*Are any real sessions scheduled that early? (The default search window is 15:00–20:00.)*

**TZ-4 — Diff-hook clock mixing, and it may be a permanent miss rather than a deferral.**
`past-sessions-diff-hook.ts:113`, `:119` compares `prior.startTime` — stored under the
Bangkok-wall-clock-as-instant convention from `toZonedTime` — against a raw `new Date()`. On a UTC host
the stored value is ~7 h ahead of the true instant, so a just-dropped session reads as "not yet
started" and is skipped. Because the new snapshot contains only sessions Wise still returns, that
session is also absent from the **next** run's prior snapshot. An earlier draft of the tutor-compare
doc asserted "capture still happens on a later cron tick, so nothing is lost"; reading the code does not
support that. *Should the comparison use `toLocalTime(new Date())`?*
The same file's header comment carries stale pointers: it says the hook runs before promotion at
`orchestrator.ts:440` and mirrors the loop at `:240-250`; at HEAD those are `:488-498` and `:249-259`.

**TZ-7 — Cron schedules are UTC and the Bangkok wall-clock intent is implicit.** Two live consequences:
`runWeeklyDigest`'s JSDoc describes a "Sunday 18:00 Asia/Bangkok slot" (`admissions/notifications.ts:1012`)
while the cron fires `12 1 * * *` = 08:12 Bangkok and the digest runs inside that daily pass on Bangkok
Sundays; and `minutesFromSchedule` parses only the first cron field and ignores hour/day/month
(`status.ts:57-69`) — safe today only because every job with a non-`*` hour also carries an
`expectedBangkok*` hint. *Should the registry type or a test enforce that invariant?*

**TZ-8 — `student-promotions/july-1` is pinned to a single calendar date.** `STUDENT_PROMOTION_TARGET_DATE`
is `'2026-07-01'` (`rules.ts:1`) and the latest-run / verified-run lookups hard-code the same string
(`data.ts:1932`, `:2501`), while the annual cron `5 17 30 6 *` fires every 30 June. From 2027 the job
409s on every fire. See OPS-4.

---

## 6. Operations: crons, deployment, runbooks

**OPS-1 — `vercel.json` (17) and the cron registry (22) disagree by design.** (re-verified) Five
registry jobs are `schedule: null` + `manualOnly: true` and run only from `/data-health`:
`post_class_feedback_digest`, `post_class_feedback_day_after`, `post_class_feedback_deadline`,
`room_utilization`, `line_backlog_recovery`. *Confirm the registry is the intended single source of
truth for ops runbooks.*

**OPS-2 — `/api/internal/sync-room-utilization` could not be scheduled as written.** It exports only
`POST` (`route.ts:26`), so adding a `vercel.json` line alone would not fire it (see EXT-14). The Room
Capacity dashboard therefore serves data as stale as the last operator run — and that same
`room_utilization_sessions` table is the health-evidence fallback for five other registry keys
(OPS-8). *Is adding a GET export plus a stagger slot the intended fix?*

**OPS-3 — Four parked post-class jobs, plus a lineage with no stale-run recovery.** The admin digest
and both tutor reminders have been `manualOnly` since the reminder lane was parked; if they will never
be scheduled, the `dangerous: true` + confirm gate is the only thing preventing an accidental tutor
email from the Data Health UI. `settings-tab.tsx:404` still tells access managers the admin digest
runs "Daily at 08:00 Bangkok". Separately, the **projection** import lineage has neither a stale sweep
nor a skip path (`sales-dashboard/data.ts:641-650`): a run left `running` blocks every later projection
import via `sdpir_source_single_running_idx` until repaired by hand, unlike the monthly path's
`acquireSalesImportRun` recovery.

**OPS-4 — `student_promotions_july_1` will fail every year from 2027, permanently alerting.** It is the
only scheduled route not wrapped in `withCronInvocationAudit`, so it writes no `cron_invocations` row
and Data Health fails it closed to `unknown` (`dashboard.ts:274-286`) — an alertable status holding an
open watchdog episode — and `run-job.ts` cannot dispatch it (DEF-3). It is also one of the nine
`criticalRoutes` in `production-route-surface.json`, and its 409-on-any-other-day guard makes the
Vercel cron UI show a failure every non-target day. *Remove the `vercel.json` entry, make the target
date a rolling rule, or accept a permanent alert?*

**OPS-5 — The cron watchdog is itself unmonitored.** `sweepCronJobs` excludes `cron_watchdog`
(`cron-watchdog.ts:167`) and nothing else checks it, so a silently dead watchdog is indistinguishable
from a healthy system. An external heartbeat is the obvious gap.

**OPS-7 — Stranded `cron_invocations` rows are never closed.** The audit inserts `outcome='running'`
before the job (`cron-audit.ts:131-159`) and nothing sweeps them to `failed`; only retention removes
them (90 days **and** outside the newest 8 per job, `cron-retention.ts:16-55`).

**OPS-8 — Run-evidence fallback is wider than its own comment claims.** `pickJobRuns` says
"Only `room_utilization` reaches this fallback" (`dashboard.ts:317-319`), but six keys have no earlier
branch and land there: `post_class_feedback_backfill`, `post_class_feedback_payout_accrual`,
`admissions_notifications`, `line_credit_digest`, `line_backlog_recovery`, `room_utilization`. Four are
scheduled, so a stale `room_utilization_sessions` row can stand in as their `latestSuccessfulRun` —
exactly the masking the comment says is impossible. *Is the comment stale or the branch list
incomplete?*

**OPS-9 — Domains invisible to Data Health.** `payroll_sync_runs` is absent from `fetchAllRuns`
(`dashboard.ts:752-806`), so a failed or stranded payroll sync never reaches `/data-health`, the overall
verdict, or the watchdog email — and payroll has no cron and no registry entry at all, so nothing
alerts when a month goes stale. `admissions_notification_runs` and `line_credit_digest_runs` exist and
are likewise absent from `fetchAllRuns`. `progress_test_sync_runs` and
`progress_test_admin_digest_runs` feed cron health but have no freshness card;
`room_utilization_sessions` has a card but no run-history rows. `post_class_payout_window` is
synthesised by the watchdog at sweep time and can email alerts but never appears on `/data-health`.
*Deliberate scoping, or omissions?*

**OPS-10 — Blocked promotions are invisible.** `sync_runs.status = 'success'` with
`promotedSnapshotId = null` is a real state (`orchestrator.ts:473-476`, `:516-525`). Alerting keyed on
status alone treats a non-promoting run as healthy. *Does Data Health check `promoted_snapshot_id`?*

**OPS-11 — Six internal routes duplicate the REL-07 cron-secret check.** (re-verified: 17 route files
import `src/lib/internal/cron-auth.ts`; six declare a local `hasValidCronSecret` — `sync-wise`,
`sync-credit-control`, `sync-sales-dashboard`, `sync-room-utilization`,
`sync-competitor-intelligence`, `student-promotions/july-1`.) Behaviour is identical today, but this is
security-critical code duplicated six ways with no test binding the copies, and a change would need
seven edits. *Migrate them — noting `sync-wise`'s session fallback for manual admin triggers — or record
the duplication as deliberate?*

**OPS-12 — Trigger-source mislabelling.** `sync-leave-requests` hard-codes `triggerType: 'cron'` on both
verbs (`route.ts:17`), so operator reruns persist as cron-triggered. A session-authenticated POST to
`sync-sales-dashboard` records `triggerSource: 'admin'` on the audit row but still passes
`triggerType: 'cron'` to both imports (`route.ts:53-60`). A `manual` row in `wise_activity_sync_runs`
can come from the workspace buttons (unaudited) or the Data Health job (audited); the ledger does not
distinguish them.

**OPS-13 — Error detail is discarded for six post-class routes.** `sync-post-class-feedback/route.ts:42`,
`post-class-feedback-backfill/route.ts:75-78`, `payout-accrual/route.ts:33-37`, both reminders and the
admin digest return fixed generic 500 strings, so `cron_invocations.errorSummary` carries no
diagnostic detail. `sync-leave-requests`, `sync-competitor-intelligence`, `cron-watchdog`,
`line-credit-digest`, `line-backlog-recovery` and `progress-tests/admin-digest` all preserve the real
message. *Deliberate information-hiding, or an inconsistency to close?*

**OPS-14 — Stale-running cutoffs vs the function ceiling.** The Wise sync cutoff is 20 minutes
(`run-wise-sync.ts:10`) against `maxDuration = 800` (~13.3 min), so a sync cannot legitimately outlive
the ceiling but a wedged row still blocks ~1.5 cron cycles. Wise Activity's 20-minute
`STALE_RUNNING_MS` against a 15-minute cadence means a killed run blocks exactly one tick (recorded
`skipped`) and is reaped by the second.

**OPS-15 — The 15-minute Wise Activity cadence has two competing rationales.** `fa29c52` frames
`2,17,32,47` as freshness-only; `docs/proposals/2026-09-02-cron-efficiency-and-wise-webhooks.md:61`
calls it load-bearing for Post-Class Feedback deadline evidence — yet the post-class collector still
runs at `13,43` (23:43 Bangkok, before the 23:47 mirror). *Which framing binds future stagger changes,
and should the reason live next to the schedule (registry comment or pinning test)?*

**OPS-16 — Morning-automation timing budget.** ~55 minutes between morning automation (06:41 Bangkok)
and the admin digest's final retry (07:36), during which a triggered Wise sync plus seven
reconciliations and publishes may be needed. *Is that intended?*

**OPS-20 — Apps Script relay de-duplication is unverifiable from this repo.** See EXT-3 and DEF-33.

**OPS-23 — No runtime path re-imports a payroll rate card.** The only card (`PayRate May 2026`) is
seeded by `drizzle/0037_payroll_rate_cards.sql`; nothing in `src/` writes
`payroll_rate_card_versions` / `payroll_rate_rules`, and `parsePayRateRows` has no caller outside its
test. Without an active card every rate check silently no-ops (`payroll/data.ts:271`, `:409`).
Compounding it, `effectiveMonth` is never used as a selector (only `active = true` ordered by
`createdAt`, `data.ts:552-557`), so activating a new card **retroactively re-prices every past month**.
*How is a new version meant to be published — another migration, manual SQL, or an unbuilt UI — and
should a payroll month pin its card?*

**OPS-26 — No first-class snapshot rollback path.** The runbook §6.6 procedure is hand-derived SQL
mirroring `orchestrator.ts:488-498`; it does not expire the `snapshot` Next cache tag (only a
successful sync calls `revalidateTag`, `run-wise-sync.ts:160-162`) and is undone by the next successful
cron within 30 minutes. *Should a rollback route or script exist?*

**OPS-27 — `sync-progress-tests` keeps a 300 s ceiling.** It is the only Wise-fetching sync still at
300 (`route.ts:7`) while pulling all Wise PAST sessions since 2026-03-01 plus all teachers each tick.
Given the credit-control precedent (DEF-18), *confirm current durations leave headroom or raise both
the route and its registry mirror.*

**OPS-28 — `importRefreshableSalesSources` re-throws on the first failing source**
(`data.ts:567-585`), so one broken workbook aborts the remaining sources and prevents the projection
import in the same cron run. *Should per-source failures be isolated the way the Wise sync isolates
per-teacher errors?*

**OPS-29 — Competitor Intelligence has a weekly cadence and no mid-week retry.** A failed or
stale-marked run costs seven days of coverage; only manual Run Sync / Data Health "Run now" recover it.

**OPS-30 — Wise Activity retention and backfill floor are now load-bearing for another feature.**
Post-Class Feedback depends on `SessionFeedbackSubmittedEvent` / `SessionDeletedEvent` reach
(`repository.ts:73` notes the deletion mirror reaches back only to 2026-05-27; `:1122-1128` derives a
coverage floor). *Should Wise Activity own a documented retention/backfill floor, and is the
single-entry `BACKFILLABLE_EVENT_NAMES` allowlist meant to grow?*

---

## 7. Auth, access control & security surface

**SEC-2 — The page → API namespace mapping is wrong for at least six features.** `isPathAllowed`
derives the API namespace as `/api${page}` (`src/middleware.ts:59-66`), so a page-restricted admin
granted a page loads it and then 403s on the endpoints it calls:
`/search` → does not reach `/api/filters`, `/api/compare` or `/api/proposals`;
`/scheduler` → does not reach `/api/ai-scheduler`;
`/line-review` → does not reach `/api/line`;
`/class-assignments` → does not reach `/api/classrooms`;
`/payroll`, `/credit-control` etc. are fine only because their namespaces happen to match.
*Alias the grants, rename the route groups, or move to an explicit per-request capability lookup?*

**SEC-3 — `/api/internal/*` bypasses middleware entirely and five snapshot-writing crons accept any
signed-in session.** `sync-wise`, `sync-sales-dashboard`, `sync-credit-control`, `sync-progress-tests`
and `sync-room-utilization` check only that a session exists — no role, no `allowedPages` — as does
`POST /api/admin/sync-wise`; only `sync-competitor-intelligence` gates via
`requireCompetitorIntelligenceSession`. Combined with the middleware exemption
(`middleware.ts:24`), **a page-restricted admin with no scheduling access can trigger a full snapshot
promotion.** *Confirm the intended blast radius.*

**SEC-4 — `GET /api/classrooms/floor-plan-map` has no auth check at all.** (re-verified) The handler is
16 lines: it renders an SVG from a user-supplied `rooms` query param with
`Cache-Control: public, max-age=3600` and no session, signature or token check, while sitting on the
middleware public allowlist. The two OA-resolver endpoints likewise serve
`Access-Control-Allow-Origin: *`. *Intended?*

**SEC-5 — JWT claims are frozen until re-login.** No `session.maxAge` is configured in either NextAuth
config, so promoting a teacher to admin or deleting an `admin_users` row takes effect only at next
sign-in, except where a Layer-4 guard reads live state. *Shorter `maxAge`, or a claim-refresh path?*

**SEC-6 — `admin_users` has no active/disabled column.** Deactivation means deleting the row, which
also silently removes the person from cron-watchdog alerts, schedule emails, LINE reviewer pools and
the post-class roles matrix. *Add a soft-disable column?*

**SEC-7 — The "9 allowlisted admins" figure is unverifiable from the repo.** (re-verified) Zero
full-admin emails are hardcoded; they come only from `SEED_ADMIN_EMAILS`, which is **absent from
`.env.example`** and from `src/lib/env.ts`, and no migration inserts into `admin_users`. A fresh deploy
without it would leave the single page-restricted seeded user as the only account able to sign in.
*Should the docs cite a live `SELECT count(*)`, or drop the number — and should `SEED_ADMIN_EMAILS` be
added to `.env.example`?*

**SEC-8 — OAuth scope divergence and a downgrade risk.** Sign-in requests `spreadsheets` +
`drive.file` (`src/lib/auth.ts:39`) while the edge config requests `spreadsheets.readonly`
(`auth-edge.ts:11`) — inert, since only node runs the consent flow. But the sales-dashboard shell's
Connect button re-consents with `spreadsheets.readonly` (`shell.tsx:50`) and
`storeGoogleOAuthTokenForUser` overwrites `scope` (`google-oauth.ts:119`, `:132`).
*Can that strip the write/Drive scope Leave Requests and the payout writer depend on?*

**SEC-9 — Login denial copy predates the role model.** "Access denied. Your email is not on the admin
allowlist." (`src/app/login/page.tsx:27`) is wrong for four of the five roles
(counselor / teacher / student / parent).

**SEC-10 — Session-only guards on high-consequence surfaces.** Every payroll route gates on `auth()`
alone with no role check, and `DELETE /api/payroll/adjustments/[adjustmentId]` is unscoped by month and
records no deleting actor. `requireStudentPromotionSession` (`api.ts:9-15`) gates nine Wise-mutating
endpoints on session-email presence only. The eight AI Scheduler handlers have **no ownership check**:
conversations store `created_by_email` and the list endpoint can filter by it, but any signed-in user
can read, PATCH, archive or post turns into another admin's conversation. *Accepted for a finance
approval surface and for a shared queue?*

**SEC-11 — `POST /api/credit-control/admin-ownership` accepts the pseudo-key `"all"`.** It validates
`adminKey` against `getAdminViewOptions()` (`config.ts:110-116`), whose first entry is the `all` filter
pseudo-key, so a student can be persisted with owner name `all` (`db.ts:302-306`).

**SEC-12 — `POST .../oa-resolver/runs/[runId]/commit` swallows malformed JSON and treats it as `{}`**
(`commit/route.ts:23-28`). Because an empty body means "no rowIds and no selectedCandidates",
`commitLineOaResolverRun` then commits **every** matched/ambiguous row in the run
(`oa-resolver.ts:986-995`). A malformed request body silently becomes a full-run commit.

**SEC-14 — Nothing in the codebase sets `is_phantom = true`.** Only read filters exist. *How were
phantom rows flagged, and can new ones arise?* SCHED-BOT-02 depends on that filter.

**SEC-15 — Personal data hardcoded in checked-in source.** `SCHEDULE_EMAIL_REPLY_TO`
(`schedule-email.ts:607`), `ADMISSIONS_EMAIL_REPLY_TO` (`notifications.ts:49`) and the two-address
`DEFAULT_LINE_VALIDATION_LEAD_EMAILS` (`link-validation.ts:122-125`) all default to personal Gmail
addresses; `LINE_VALIDATION_LEAD_EMAILS` is read straight from `process.env` and is not in
`src/lib/env.ts`. `ADMISSIONS_EMAIL_FROM` additionally defaults to the Resend sandbox sender
`onboarding@resend.dev` (`notifications.ts:46`), so unset in production, admissions mail ships from a
sandbox domain rather than failing loudly. The three bootstrap grants in
`drizzle/0056_learning_plan_access_grants.sql:9-13` are real personal/company addresses committed in a
migration. *Require these vars, move them to a shared mailbox, or parameterise the migration?*

**SEC-17 — Being a tutor silently revokes a parent's or student's admissions access.**
`resolveUserAccess` resolves `teacher` (which grants only `/progress-tests`) before checking admissions
student/parent membership (`auth-access.ts:75-82`), so a tutor whose child is an admissions case member
gets the No-access card at `/admissions`. *Is teacher-wins deliberate?*

**SEC-18 — `requireCaseAccess` checks membership status only.** It does not enforce case status or the
audited `admissions_cases.family_portal_open` opt-in (which nothing outside `schema.ts`/`0053`
references), so never-revoked family members can reach withdrawn or archived cases by URL.
*Enforce case status and/or the flag for family roles, or is revoke-on-archive the intended operational
step?*

**SEC-19 — The middleware capability exemption has zero test coverage.** `src/middleware.ts:39-46`
widens a security gate; `middleware.test.ts` has no case for it (capability-layer coverage exists in
`access.test.ts`). *Is the capability-layer test sufficient?*

**SEC-20 — Learning-plan report data travels in the URL by design.** Student names and parent notes go
in the query string (`reportParamsSchema`, `src/lib/syllabus/report-params.ts:7-17`) and therefore into
browser history and request logs. *Acceptable long-term, or should notes move to a short-lived
server-side token like Student Schedule's capability links?*

**SEC-21 — `src/middleware.ts` uses a convention Next 16 documents as deprecated.** It is renamed to
`proxy.ts` and defaults to the Node.js runtime instead of Edge (`proxy.md:11`, `219`, `743`). Migrating
could retire `src/lib/auth-edge.ts` entirely — or break the Edge assumptions. *Which is intended?*

---

## 8. Environment & configuration

**ENV-1 — See DEF-2 / DEAD-1.** `src/lib/env.ts` has zero importers.

**ENV-2 — The documented required-var contract is wrong in every source.** Verified at HEAD:
`src/lib/env.ts` declares **18** keys — 7 hard-required, 2 defaulted, 9 optional. `AGENTS.md:291` says
"9 required"; `AGENTS.md:307` says "9 required plus 9 optional … roughly 50 read"; `README.md:180-187`
says 15 declared / 6 optional and "throws at startup". The reconciled figures are **18 declared** and
**~69 named keys read at runtime** (75 including `scripts/`). None of these were changed by this pass —
they need an owner-approved edit.

**ENV-3 — The schema covers 18 of ~69 live keys.** *Is per-call-site `process.env` access with local
guards the intended architecture, or should `env.ts` become the real inventory?* Only
`src/lib/post-class-feedback/payout-config.ts:65-71` argues its position explicitly (validate at the
operation boundary so the dashboard can report incomplete setup without crashing); every other
subsystem is silent. Note that nine payout vars are read through a **dynamic indexer** (`env[name]`,
`payout-config.ts:11-13`) and are therefore invisible to any `process.env.X` grep — including whatever
generates `docs/reference/env.md`.

**ENV-4 — Three different failure modes for the same missing Wise credentials.** `createWiseClient()`
asserts with `!` and produces a client whose Basic header encodes `undefined:undefined`
(`wise/client.ts:215-221`, `:70`), 401ing only at request time; `createWiseClientFromEnv()`
(`classrooms/data.ts:1151-1159`) and `createPromotionWiseClient()` (`student-promotions/data.ts:298-306`)
throw named errors immediately; `wise-activity/reconciliation.ts:770`, `:797` return a typed error
result. *Which is the intended contract?* (This is also the mechanism behind DEF-29.)

**ENV-5 — `STUDENT_SCHEDULE_LINK_TTL_DAYS` validation is bypassed.** `env.ts:25` declares
`z.coerce.number().int().positive()`, but all three consumers use `Number(x) || DEFAULT_LINK_TTL_DAYS`
(`link/route.ts:55`, `schedule-bot.ts:138`, `schedule-bot-group.ts:137`), so `'0'`, `''` and
non-numeric values silently become 30 — and a negative value would mint already-expired links. If the
schema is ever wired up the two behaviours disagree.

**ENV-6 — `APP_BASE_URL` is two unrelated things.** The env var (read by the schedule-link route and
the LINE bots) and an exported constant of the same name in `leave-requests/config.ts:17`, sourced from
`NEXT_PUBLIC_APP_URL` through a different fallback cascade. The bot call sites also use `??` (so an
empty value yields a relative link inside a LINE message) while the API route uses `||`. *Rename one,
and share one base-URL helper?*

**ENV-7 — Flags captured at module load need a redeploy to toggle.** `WISE_SESSION_OPERATIONS_VERIFIED`
in `line/operational.ts:21` (unlike the function reader in `wise/operations.ts:11`); the six
`POST_CLASS_PAYOUT_*` module consts at `payout-config.ts:15-35`; the `APIFY_*_ACTOR` slugs at
`providers.ts:17-18`; all four `LEAVE_REQUESTS_*` values at `config.ts:1-21`. *Acceptable for the payout
consts specifically, given `requirePayoutGoogleTarget` re-reads?*

**ENV-8 — `ENABLE_LINE_SCHEDULER` gates webhook ingest, not sending.** (`src/lib/line/client.ts:19-23`,
`webhook/route.ts:9-11`.) The parent push in `approveLineSchedulerReview` and the schedule bot consult
only `LINE_CHANNEL_ACCESS_TOKEN`, and the Wise path is unconditionally dry-run. AGENTS.md's summary
already says this; several task briefs do not. *Should outbound sends also honour the kill switch?*
Related: `ENABLE_AI_SCHEDULER` is **opt-out** (`!== "false"`), so a present API key alone enables the
feature, and neither it nor `OPENAI_API_KEY` is declared in `env.ts` — misconfiguration fails at
request time with a 503 rather than at boot.

**ENV-9 — `SALES_DASHBOARD_CONNECTED_EMAIL` has exactly one reader left** — the leave-requests fallback
at `config.ts:13`. The sales dashboard resolves `connectedEmail` per source row from Postgres
(`sales-dashboard/data.ts:195`). *Rename to a leave-requests-scoped name, or remove?*

**ENV-11 — `.env.example` ships keys blank that the schema would reject.** `LINE_CHANNEL_SECRET=`,
`LINE_CHANNEL_ACCESS_TOKEN=` (lines 24-25) and `APP_BASE_URL=` (line 45): a dotenv loader sets those to
`''`, and `.min(1).optional()` / `.url().optional()` reject `''`. Harmless today only because the
schema never runs. It also omits ~15 live vars including `SEED_ADMIN_EMAILS` (SEC-7) and
`POST_CLASS_AUTO_APPROVE_ENABLED` — the switch that arms unattended charging.
*Omit the blank keys, or make the schema tolerate `''`?*

**ENV-12 — `WISE_INSTITUTE_ID` is effectively hard-coded.** The literal `696e1f4d90102225641cc413`
appears 18 times in non-test `src/` (11 inline `??` fallbacks + 6 `DEFAULT_INSTITUTE_ID` consts); only
`room-capacity/utilization.ts:433` and `post-class-feedback/sync.ts:1053` refuse to guess and throw.
*Is a per-tenant deployment ever intended, or should the literal collapse to one exported constant?*

---

## 9. Ambiguous behaviour & product rules

**AMB-1 — Fail-closed rule vs the non-blocking status allowlist.** `NON_BLOCKING_STATUSES` includes
`COMPLETED`, `MISSED` and `NO_SHOW` alongside the two cancellation spellings (`sessions.ts:34-40`). For
a feed fetched with `status=FUTURE` these should not appear. *Can they legitimately, per the Wise
contract?* (See GOV-27.)

**AMB-2 — Silent session drops contradict the fail-closed posture.** See DATA-18.

**AMB-3 — Modality filtering excludes rather than routes to Needs Review.** A tutor whose modality
could not be derived is written as `"unresolved"` into their window modality
(`orchestrator.ts:333-336`, `:420-422`) and rejected outright by `engine.ts:104`/`:108` on any
`online`/`onsite` request — silently dropped, not flagged, and untested for that path
(`engine.test.ts:134-150` covers only `mode: "either"`). Given how unreliable modality derivation is
for the tutor snapshot, *should a mis-derived modality exclude the tutor (current hard skip at
`engine.ts:93-97`) or route them to Needs Review?*

**AMB-5 — Shared free slots ignore leaves, and never see fallback sessions.** `findSharedFreeSlots`
(`compare.ts:361-405`) ignores `dated_leaves` entirely while discovery checks them
(`discover/route.ts:113-121`), and it reads `group.sessionBlocks` with the date filter so it never sees
the weekday-fallback copies `buildCompareTutor` fabricates (`compare.ts:374-381` vs `:274-289`) — the
day view can show "All free" across a representative card.

**AMB-7 — Session-type vocabularies diverge in three places.** `detectSessionModalityConflict` treats
`'scheduled'` as online evidence (`compare.ts:6`) while `deriveModality` does not consider it at all
(`modality.ts:46-52`), so `'scheduled'` can raise a `conflict_model` issue without ever having
contributed to the derivation; and `classrooms/session-mode.ts:1-2` holds the same six tokens
independently, so a new Wise value must be added in two places. Separately, `deriveModality` steps 3
and 4 (`modality.ts:65-79`, `:81-91`) both return `unresolved` with near-identical issues differing only
in message. *Share the token sets, and does the step split earn its keep? Is `'scheduled'` Wise's
semantics for this tenant or a workaround?*

**AMB-8 — `detectConflicts` dedup key is casing-sensitive while the grouping key is not.** Buckets by
lower-cased `studentName` (`compare.ts:329`), dedups on the raw-case value (`:343`), so "Anna" and
"anna" can emit two conflicts for the same student × weekday × tutor pair.

**AMB-9 — Discovery scope mismatches.** Discovery ranks candidate conflicts over the whole future
horizon (`discover/route.ts:69`, `:127`) rather than the displayed week; `existingTutorGroupIds` is
capped at 2 (`:13`) while `ComparePanel` passes all selected ids (`compare-panel.tsx:496`), so
"Advanced search" with three tutors selected returns 400; and the "Find alt" subject prefill never
works because `subjectFilter` is seeded only in a `useState` initializer
(`discovery-panel.tsx:45`) that never re-runs, while the prefill effect (`:63-70`) omits it.
*Week-scope the ranking, hide or raise the three-tutor cap, and either wire the prefill or delete the
initializer.*

**AMB-13 — Payroll approval is not a lock, and a re-sync silently un-approves.** A successful sync
resets `payroll_reviews` to draft and clears the approver fields (`sync.ts:394-412`) with no warning in
the API or dashboard. *Does finance expect this?*

**AMB-15 — Payroll approval strictness mismatch.** The UI disables Approve on any issue
(`payroll-dashboard.tsx:390`) while the server 409s only on the three rate-issue types
(`review/route.ts:27-40`).

**AMB-16 — Manual payroll adjustments never reach a total.** They are summed only into
`summary.manualAdjustment*` and never applied to tutor rows or totals (`data.ts:483-487`); `hours` and
`amount` are coerced to 0 when non-finite (`:643-644`) rather than returning 400, so a typo posts a
silent zero-value row. *Who applies them downstream?*

**AMB-17 — Credit Control asymmetries.** `POST /api/credit-control/actions` coerces an unrecognised
status into a clear (`actions/route.ts:23`) while the bulk route rejects it with 400
(`actions/bulk/route.ts:19-23`); the single sync route returns the full result object with HTTP 500 on
failure rather than the `{ error }` envelope every sibling uses. Also, after a manual restore via
`DELETE /api/credit-control/inactive` the zero-tracking row was already cleared while inactive
(`churn.ts:119`), so the 45-day streak **restarts** rather than resuming.

**AMB-18 — Sales Dashboard churn is computed two ways.** The rule is identical but the paid-row
selector differs: import-time churn uses `packageHours !== "trial"` (`parser.ts:204`, `:210`) while
`computeLiveStatus` uses `enrollmentType !== "Trial"` (`cohorts.ts:69`). Rows whose sheet-supplied
Enrollment Type disagrees with the Package column diverge between stored and live status independent of
clock drift.

**AMB-19 — Sales Dashboard hardcoded targets, presets and a dead ternary.**
`MONTHLY_NORMAL_SALES_TARGET = 4,000,000` (`gm-insights.ts:15`); period presets are hardcoded calendar
spans (`shell.tsx:121-143`) while `period-toolbar.tsx:7-9` says computed presets await owner sign-off;
`DEFAULT_SALES_SOURCES` ends at May 2026 (`default-sources.ts:4-17`); and `upsertSalesDashboardSource`
has a dead ternary (`data.ts:198` — both branches `"active"`), so a back-dated month is created active
and only reaches `finalized` on its next import. *Was a distinct initial status intended? Is the target
still current? Who signs off the presets? Should new-month sources auto-create?*

**AMB-29 — Room-capacity forecast mixes two occupancy pictures and one non-fail-closed step.**
`simulateSaturation` and the demand-mix fallback use raw snapshot sessions while the weekend readiness
gate and breakpoint use engine-projected sessions (`data.ts:405`, `:411-425`); `matchesSubject` degrades
to "has at least one qualification" when `subject` is null (`forecast.ts:427-430`); and the weekend
`preferred_slot_only` policy counts a lead fully lost when its exact preferred weekend slot is taken
even while other weekend rooms are open (`forecast.ts:555-578`, `:816-818`). *Is the weekend policy the
intended business model?*

**AMB-30 — Utilization denominators and demand-mix bucketing.** Every calendar day contributes
`activeRooms × 14 h` including holidays, structurally depressing reported utilization; and both
`seededDemandMixFromSchedule` (`forecast.ts:833-843`) and `buildDemandMixFromSessions`
(`analysis.ts:250-275`) admit any session with a non-empty `location` and stamp it **onsite**, so
meeting-URL online classes inflate onsite demand.

**AMB-31 — Tutor-profile import guardrails.** A merged import patch can exceed the 30-tag / 80-char /
12-education Zod caps (`mergeTags`/`mergeEducation` have no caps) and import-commit then rejects the
whole batch with 400; `invalidRows` reports out-of-range ages only for matched rows
(`tutor-profile-import.ts:849-851`); the importer stamps hardcoded provenance names
(`'BeGifted Tutors-3.xlsx'`, `'Availability.xlsx'`) regardless of the uploaded filename (`:469`, `:485`,
`:490`, `:510`); stored `displayName` freezes after the first save and masks later Wise renames
(`tutor-business-profiles.ts:342`, `:271`); and `verifiedBy` / `lastReviewedAt` are stored verbatim from
the client (`:359-364`) with no session stamping or edit history.
*Should preview pre-validate, should the workspace chunk commits above the 200-row cap, should
provenance be parameterised, and is self-reported verification the intended accountability level for
do-not-use notes?*

**AMB-33 — Leave-request sheet semantics.** Sheet `Status` is read into workflow status only on insert
(`sync.ts:242-246`). *Is the sheet meant to be write-only from the app after first ingest?* The header
Sheets badge also reflects the signed-in admin's token (`route.ts:22`) while writes may go through
`LEAVE_REQUESTS_CONNECTED_EMAIL`. *Should it report the resolved writer?*

**AMB-34 — Where does "AI Scheduler" end and "LINE AI Review" begin?** Both share the four
`ai_scheduler_*` tables; LINE writes parent-role messages and runs turns via `executeSchedulerTurn`
(`review-service.ts:302-318`), and both `/scheduler` and `/line-review` action the same review queue.
`ai_scheduler_runs` additionally mixes LLM runs with LINE operational-planner rows logged as model
`'deterministic-line-ops'` with `modelMs 0` (`:228-244`), counted in the same newest-500 metrics
window. *Which surface is canonical, and is that the intended denominator?*

**AMB-35 — AI Scheduler caps and precedence.** Every turn replays the full message history
(`messages/route.ts:102-105`) and `GET /conversations/[id]` returns messages with no LIMIT — no
truncation anywhere; `GET /conversations` applies `LIMIT 200` in SQL (`scheduler-data.ts:204-215`)
**before** the `q` search and owner filter run in JavaScript, so a search can silently miss older
matches; customer labels typed in the Notes panel are overwritten by the next turn's extraction when
the model returns a value (`messages/route.ts:129-131`); LINE enrichment fields are populated only by
`GET /conversations`, so seven of eight endpoints report a LINE-sourced conversation as
`source: "manual"` with 0 pending reviews; and when `isAiSchedulerConfigured()` is false the LINE path
opens a `pending_review` row with an empty draft and writes no conversation or message
(`review-service.ts:268-280`). In the suppressed-search path the run is logged `needs_clarification`
with non-empty `questions`, yet the parent draft contains no question.

**AMB-36 — The DM `send` path is looser than every other schedule-bot path.** `startSend` gates on
`matches.length` (`schedule-bot.ts:418-432`, substring and parent-name hits included) whereas
`replyWithLink` and the whole group path require `exactCodeMatches` (`:355-361`;
`schedule-bot-group.ts:515-522`). So `/schedule Aad send` with one substring hit proceeds to a confirm
prompt. Related: `hasPendingDm` / `hasPendingQuestion` do not filter on `expiresAt` (expiry is enforced
only in the confirm handlers), and two code comments disagree on snapshot staleness —
`live.ts:4-6` says "~36 minutes", `schedule-bot-group.ts:527` says "≤30-min-old".

**AMB-37 — Wise event-feed ordering is assumed but unverified.** See EXT-5.

**AMB-38 — Two different reconciliation matchers can legitimately disagree.** Home uses
`persistedEventMatchesSale` over persisted events (`reconciliation.ts:586-616`, `:997`) while the page
uses `scoreReceiptCandidate` over live receipts (`:372`, `:623-627`); the needs-review rules differ
(`:999-1000` vs `:560-565`). The finance predicate is also inconsistent between layers: the SQL
`financeOnly` filter matches `%invoice%`/`%payment%`/`%payout%` (`data.ts:108-116`) while the in-JS
`isWiseFinanceEvent` used for summary cards also matches `%transaction%` (`format.ts:57-66`), so a
summary's `financeEvents` count can exceed what `financeOnly=true` returns.

**AMB-40 — `reconcileProposalState` runs on every read.** `POST /api/search/range` calls
`listActiveProposalHolds(db)` with default options (`range-search.ts:116`; `proposals/data.ts:263-264`),
writing `expired`/`auto_resolved` statuses, and runs a blocking-session scan whenever any confirmed
hold exists — while other call sites pass `{ reconcile: false }` explicitly. The search workspace
additionally re-fetches `/api/proposals/active` after every successful search
(`search-workspace.tsx:194-253`) although the range response already overlays holds server-side
(`range-search.ts:144-168`). *Intended belt-and-braces, or an accidental memoization consequence?*

**AMB-50 — The `/compare` legacy redirect forwards only `?tutors=`** (`page.tsx:11-16`), dropping
`?week=`. It has been a redirect since `70cfa06` (2026-04-08) and `stale-snapshot-banner.tsx:25-26`
still allowlists the path. *Delete it, or keep it indefinitely — and should it preserve `?week=`?*

**AMB-52 — Progress-test cadence semantics.** Every completed test does `cycleIndex + 1` regardless of
position (`engine.ts:171-183`; `booking.ts:431`, `:537`), so a test taken at 6/8 leaves ten classes
until the next due; and `approaching` is an exact equality on position 6 (`engine.ts:205`), so a student
gaining two counted classes between syncs skips the state and the teacher heads-up entirely.
*Is "one test per block of 8" the intended semantics?*

**AMB-53 — The progress-test admin digest nags forever with pseudo-addresses.** The "Action needed" list
selects every unresolved notification with no date or cycle filter (`admin-digest.ts:130-137`), so
unresolved rows from rolled cycles persist, and the listed values are `unresolved:<canonicalKey>`
pseudo-addresses (`teacher-heads-up.ts:301`), not mailboxes.

**AMB-54 — Competitor Intelligence: three behaviours that look unintended.** `budgetUsedPercent` sums
`competitor_vendor_usage` across **every** month (`data.ts:305-306`, `:333`) while the sync's ratio is
current-month only (`sync.ts:400-409`), so the KPI overstates spend after the first rollover; budget-cap
and missing-credential skips both write `source.lastError` (`sync.ts:564-566`; `providers.ts:99`,
`:139`), lowering the coverage score even though no fetch was attempted — but the SERP path is
asymmetric, since DataForSEO credential and budget skips never mark `begifted:serp-baseline` unhealthy
(`sync.ts:646-654`, `:673-685`) while Apify skips do (`:606-612`); and `POST /api/competitor-intelligence/sync`
returns HTTP 500 whenever `result.status !== 'success'` (`route.ts:17-19`), so a cleanly-reported
partial sync is indistinguishable from a server fault.

**AMB-55 — "Daily Market Brief" is produced on a weekly cron from one run's items**
(`sync.ts:696-711`); the daily naming dates from the pre-`6604377` schedule `25 18 * * *`. AI failure
handling is also asymmetric: a daily-brief OpenAI error fails the whole run and writes no brief row
(`sync.ts:774-786`, `802`), while a War Room error falls back to deterministic insights with status
`ai_fallback` (`war-room.ts:569-581`, `599`). Finally, AI-discovered competitors are inserted
`active: false` with `needsReview` (`sync.ts:461-492`) and sub-0.8 keywords as `needs_review`
(`data.ts:747-780`), but **no UI or endpoint can approve them** — a dead-end review queue. And because
the seeded own-brand entity ships with only the SERP baseline (`default-sources.ts:27-42`), the
"BeGifted baseline sources are not configured" branch (`war-room.ts:209`) is effectively unreachable
and `gapCount` counts every competitor as a gap until BeGifted sources produce evidence.
*Rename or widen the brief; should the brief also fall back; should the seed include own-brand
website/social sources; and where does an admin approve a discovered competitor?*

**AMB-56 — US Universities: three labelled fallbacks and a silent cap.** The scatter's "In-state sticker
price" axis substitutes avg net price when sticker is null (`data.ts:241`) while the dossier's
"Net price" headline substitutes sticker price when net price is null
(`institution-dossier.tsx:377`) — two labelled cost measures that mix inputs; CSV export silently caps
at `EXPORT_ROW_CAP = 5000` with no warning or total comparison (`data.ts:155`, `:170-176`); and
`FilterParams` and the API accept **lists** of states/controls while every UI entry sets exactly one and
each chip's clear patch wipes the whole facet (`institution-filters.tsx:77-80`, `active-filters.ts:34-40`,
`:57-63`). *Is multi-select a future intent, or should the params narrow to scalars?*

**AMB-57 — `GET /api/sales-dashboard/sources` and the payload's `sources` array return different sets.**
The endpoint excludes archived sources; the payload includes them (`data.ts:164-178` vs `:869-871`).
Also `POST /api/sales-dashboard/sources/seed` writes the caller's email into `connected_email` for all
14 hardcoded default months, silently repointing every historical workbook's Google connection.
*Which is the intended contract, and should seed require an explicit confirmation step?*

**AMB-58 — Admissions member and role semantics.** `addMember` cannot add a `student` role at all
(student is fixed at creation), the design doc lists `/calendar` GET as "student/parent (shaped)" while
the implementation is `minRole student` (`calendar/route.ts:54`) with parents reading deadlines only via
the dashboard, and `admissions_test_sittings` still hard-deletes despite having `deleted_at`/`status`
columns (DEAD-30). *Is the stricter calendar contract final?*

**AMB-59 — `PATCH` verbs that are not partial updates.**
`PATCH /api/competitor-intelligence/own-sources/[sourceId]` reuses the full create schema, so
`sourceType`, `label` and `url` are all required — a replace, not a merge. See DEF-13 for the LINE
contact-label case. `PATCH /api/post-class-feedback/tutor-emails` uses the `tutor_contacts` row's
`updatedAt` floored to whole seconds as `expectedVersion` (`route.ts:23-30`) rather than a monotonic
counter, so two writes inside the same second could both pass.

**AMB-60 — `/api/compare` validates three inputs it never uses.** `mode` is never read
(`route.ts:26`, `:133`); `date` uses host-TZ `getDay()` (`:177`); the client sends none of them
(`use-compare.ts:135-145`). *Drop them?*

**AMB-61 — Wise Activity free-text search re-fetches on every keystroke.** Filters are effect deps
(`wise-activity-workspace.tsx:572-574`), so "Apply" only resets to page one; and the `q` filter is a
leading-wildcard `ILIKE` across six columns, three unindexed (`data.ts:117-127`). *Is a trigram index
intended?*

---

## 10. Retention, scale & cost

**SCALE-1 — Credit Control snapshots are never pruned.** A full copy of `credit_control_sessions` and
`credit_control_credit_history` is written every 30 minutes; the only four
`delete(schema.creditControl*)` call sites in `src/` all target sidecars (`sync.ts:614`, `:636`;
`db.ts:233`, `:286`). The only production figure in the repo — 67.8M session rows / 39 GB across 3,367
snapshots (`schema.ts:1255-1261`) — is undated. *Is unbounded retention intended, or is a pruning
policy owed?*

**SCALE-2 — Sales Dashboard rows are never pruned.** No `delete()` against any of the seven tables
exists in `src/`; the `10,40` cron appends a complete copy of every sheet row roughly every 30 minutes
while only rows under `lastSuccessfulImportRunId` are read. *Deliberate audit trail, or a retention
job?*

**SCALE-3 / SCALE-4 / SCALE-5 — Payroll sync runs, classroom assignment runs, leave-request sync runs
and `room_capacity_model_runs` all accumulate with no pruning path.** `roomCapacityModelRuns`
additionally has no active flag and `ON DELETE no action` FKs, so deleting an old run requires deleting
its detail rows first.

**SCALE-6 — `getTutorProfileVersion()` runs `count(*)` + `max(updated_at)` on every `ensureIndex` call**
(`src/lib/search/index.ts:128-137`, `:368-375`), so the "zero-query hot path" is a two-query hot path.
Its `count(*)` term matters only for row deletion, which no code performs — reachable by manual SQL
only. Separately, `buildIndex()`'s data-issue → tutor-group join is O(issues × groups)
(`search/index.ts:232-250`); fine at ~130 tutors but it sits in the one path that must stay fast on a
cold serverless instance.

**SCALE-8 — Unbounded reads with no cap.** `getWiseActivitySummary` loads every matching row into
memory with no LIMIT (`data.ts:167-171`) on a route with no `maxDuration`;
`listLeaveRequests({summaryOnly:true})` SELECTs up to 200 full rows and discards them
(`data.ts:230`) so badge/KPI counts truncate at 200; `getInstitutionProfile` ships the raw JSONB source
records to the client (`us-universities/data.ts:305-327`) while every other payload strips them, and
nothing reads them client-side. *A guardrail, SQL-side aggregation, or `count(*)`?*

**SCALE-9 — No AI Scheduler route exports `maxDuration`** despite an OpenAI Responses call plus a
possible cold `ensureIndex` build on the request path, while every heavy sync route sets 800 and the
published eval p95 is ~11.4 s on a non-default model. *Is the platform default acceptable?*

---

## 11. Testing & verification gaps

**TEST-5 — The integration `truncateAll` list is hand-maintained and covers 39 of 189 tables**, and only
20 of the 32 `post_class_*` tables. Nothing fails loudly when a table is missing, so a future
integration test can silently inherit dirty rows. *Deliberate scoping or oversight?*

**TEST-10 — Route-handler tests missing on the highest-risk surfaces.** No route test exists for:
`PATCH /api/line/scheduler-reviews/[reviewId]` (the only path that sends a real message to a parent and
the only enforcement point for the verified-student-link gate) or `POST /api/line/webhook`; the LINE
scheduler-reviews list / operational-plan / wise-actions routes, contact label/student-links routes,
`GET /api/line/students`, alias-import preview, or either internal LINE cron route;
`conversations/[conversationId]/route.ts` (GET/PATCH/DELETE) and `metrics/route.ts` in AI Scheduler;
`DELETE /api/payroll/adjustments/[adjustmentId]`; `select-at-home` and `mark-at-home-submitted` in
progress tests (only their lib functions are covered); the server-side `MAX_COMPARE` truncation in
`compare/route.ts:21-25`; and `extractSchedulerStateWithOpenAi` (`scheduler-conversation.ts:2334-2386`).
`src/lib/auth.ts` is mocked in 78 test files and unit-tested in none; `src/lib/db` has zero tests.

**TEST-11 — Seven of the eight AI Scheduler handlers have no try/catch around DB work**, deviating from
the repo-wide auth → JSON → Zod → try/catch convention, so a driver error surfaces as an unwrapped
framework 500. `GET /api/leave-requests/[requestId]` (`route.ts:14-24`) has the same gap.

**TEST-12 — `cron-registry.test.ts` now pins `maxDurationSeconds` parity for all 22 entries** (the fix
for DEF-1), but nothing tests the `manualActions` / `run-job.ts` pairing (DEF-3) or the six duplicated
cron-secret copies (OPS-11). `migration.test.ts` pins post-class migrations `0055` and `0057`–`0062` but
not `0068_payout_adjustment_superseded.sql`, whose `superseded` status is load-bearing for retirement,
close readiness and the accrual planner.

**TEST-13 — Test-coverage descriptions in several feature docs are derived from `describe`/`it` titles,
not test bodies.** The Classroom Assignments and Competitor Intelligence "not covered" lists were read
from the test files rather than from a coverage run. *A `vitest --coverage` pass over the two lib
directories would settle them.*

---

## 12. Reference-doc drift (mechanical fixes)

Consolidated from every pass; all are one-line corrections that a regeneration would sweep. Full detail
in GOV-20 → GOV-25 and GOV-32.

1. `schema.ts` line ranges ~3 lines stale across all 13 `erd-*.md` pages and `database/index.md` (GOV-20).
2. `erd-university-admissions.md` "25 tables"; `erd-line.md` "12 tables" and no `line_credit_digest_runs`
   anywhere in `database/index.md` (GOV-21).
3. Cron schedules `5,35`, `25 18 * * 0`, `45 23`, `0,10,20,30 0`, "07:30 final retry" (GOV-22).
4. `internal-crons.md` payout-accrual "Not scheduled" + "14 of the 21" (GOV-23).
5. `misc.md` self-contradictions and stale `dashboard.ts` line refs (GOV-24).
6. `api/wise-activity.md` ingest step 5 still describes a pre-SELECT removed by `da88794`;
   `lateAfterMinutes: 45` (actual 30).
7. `api/student-promotions.md` documents 400 for run-not-found where the handler returns 404
   (`api.ts:43-45`), and its Response Shape shows `totalAcceptedWiseStudents` /
   `totalWebsiteSnapshotStudents` and omits `freshness`.
8. `api/payroll.md` labels payroll auth "admin"; the code enforces session-only. It also cites the
   payroll schema section at `schema.ts:1758` (actual `:1761`).
9. `api/room-capacity.md`, `erd-core.md`, `crons.md` cite `middleware.ts:4-20` / `:18` (actual `:10-26`
   / `:24`) and `cron-registry.test.ts:33-36` (actual `:45-48`).
10. `api/line.md:50` cites `middleware.ts:4-19` for the LINE exemptions (actual `isPublicRoute` at
    `:10-26`).
11. `api/classrooms-and-assignments.md` cites `cron-registry.ts:263-278`/`279-295` and
    `admin-schedule-email.ts:19`/`:369-382` (actual `:274-288`/`:290-305` and `:24`/`:374-387`).
12. `internal-crons.md:61` cites the admissions cron at `vercel.json:60-61` / `cron-registry.ts:318`
    (actual `:64-67` / `:322-337`), and the page has **no stable anchor** for that section — feature docs
    currently deep-link a generated heading slug.
13. `api/proposals.md:48`/`:150` cite `schema.ts:2315`/`:2313` (actual `:2318`/`:2316`).
14. `erd-leave-requests.md:132` cites the single-flight index at `schema.ts:2107-2109` (actual
    `:2110-2112`) and still carries a 🟡 IN PROGRESS badge (see §0).
15. **Resolved — no page carries the stale footer.** This item read "Fifteen `docs/reference/api/`
    pages still carry the footer `_Verified against HEAD + uncommitted WIP on 2026-05-31._`".
    `grep -rlx` for that exact line across `docs/reference/api/` now returns **0**, and all 22 files
    in that directory end with `_Verified against main@0cd1e81 (clean tree) on 2026-09-02._` — as do
    83 files tree-wide. The string survives only as prose quoted in two places, neither a footer:
    this item, and `features/leave-requests.md` open question 1.
16. Source-comment drift, outside the docs but same family:
    `src/lib/maintenance.ts:5` and `.env.example:48` say "15 Vercel Crons" (17);
    `maintenance.ts:21` cites `schedule-bot.ts:112` for `scheduleBotAdminIds` (now `:116`);
    `sync-credit-control/route.ts:11-13` says a stranded row is failed by "the watchdog 30 minutes
    later" when the only recovery is the 20-minute sweep in `run-sync-request.ts:50-68` and the
    watchdog never edits ledgers; `student-schedule/data.ts:6-8` says `credit_control_sessions` is
    "truncated and rebuilt", when the sync inserts a new snapshot and flips active
    (`credit-control/sync.ts:669-684`, `:714-719`); `overview-charts.tsx:4` says "Four Chart.js visuals"
    where five render; `past-sessions-diff-hook.ts` header pointers (TZ-4);
    `src/middleware.ts:19-20` justifies the trailing slash on `/schedule/` by a
    `startsWith` argument that is false either way.

---

## 13. Conventions & naming

**CONV-1 — `.parse()` vs `.safeParse()` is now two dialects.** The convention is "always `.safeParse()`,
never `.parse()`", but five competitor-intelligence routes and the sales-dashboard import route throw
(DEF-8, DEF-17).

**CONV-2 — `isUniqueViolation` exists eight times in three signature variants.** Some check only
`err.code`, newer ones also `cause.code`, and `admissions/notifications.ts` takes an extra `indexName`
argument. Only `admissions/cohorts.ts` exports it. *Deliberate domain decoupling, or one shared
predicate?*

**CONV-3 — Duplicated missing-forecast payload** (`room-capacity/data.ts:358-383` and
`forecast/route.ts:16-41`) — identical today, free to drift.

**CONV-4 — Directory naming inconsistency.** `src/lib/auth/` (a directory) coexists with
`src/lib/auth.ts`, `auth-edge.ts` and `auth-access.ts`. *Intentional, or a half-finished move?*

**CONV-9 — `competitorIntelligenceErrorResponse` is the odd mapper out.** See DEF-8.

**CONV-10 — Shared infrastructure lives under a feature namespace.** The Google Sheets / OAuth / CSV
layer sits in `src/lib/sales-dashboard/` while six other features and nine scripts consume it, and the
CI scope guard depends on that path prefix. `PrintToolbar` and `DigitSafe` live under
`src/components/learning-plan/` but are used by Student Schedule and Student Report, and the app-wide
`@page { size: A4 }` default lives in `src/app/learning-plans.css:97-101`.
*Move to `src/lib/google/`, `src/components/print/`, and `globals.css`?*

**CONV-11 — Two undeclared but load-bearing dependencies.** `tsx` backs 19 npm scripts and is not in
`package.json` (it resolves transitively via `drizzle-kit` and `vitest`→`vite`); `server-only` is
imported by 57 modules, is likewise undeclared, and Next resolves it from
`next/dist/compiled/server-only` at build time only. A dependency bump could silently break every
seed/payout/eval script.

**CONV-12 — Two distinct "tier" concepts share a name** (payroll pay tier vs Data Health job tier), and
the sales-dashboard collaborator scope guard hardcodes `aoengnatchasmith-spec` in three files.
*Is the collaborator still active, and should the guard be configurable or retired?*

---

## 14. Requires access outside this repository

These cannot be answered by reading code at all. They need someone with production, Vercel, Google,
Wise, Neon or GitHub access.

1. **EXT-1 — Whether the 17 crons are actually firing**, and whether the cron watchdog is alive (OPS-5):
   by construction, a dead watchdog looks identical to a healthy system from inside the app.
2. **EXT-2 — The production process timezone** (TZ-1). Nothing in the repo pins it; ten code paths and
   one confirmed defect (DEF-4) turn on it.
3. **EXT-3 — Whether the Apps Script email relay de-duplicates on `idempotencyKey`** (OPS-20, DEF-33).
   `createAppsScriptScheduleEmailSender` forwards it (`schedule-email.ts:621`) and falls back to
   `apps-script:${idempotencyKey}` as the id (`:632`).
4. **EXT-4 — The live `admin_users` count and composition**, and whether `SEED_ADMIN_EMAILS` is set in
   production (SEC-7).
5. **EXT-5 — Whether Wise's `/institutes/{id}/events` feed is guaranteed newest-first.**
   `lookback_reached` and `known_events` both assume it (`sync.ts:196-200`, `:238-245`); no sort param is
   sent, no fixture pins an ordered payload, and `docs/reference/wise-api.md:402` states it as fact.
   The payroll payout-event early-stop heuristic (`sync.ts:203-229`) relies on the same assumption.
6. **EXT-6 — Whether the unfiltered `/institutes/{id}/sessions` call returns past sessions.**
   Room-capacity's sync sends no `status` param (`utilization.ts:436`) while
   `fetchWisePastSessionsByBangkokDate` deliberately sends `status: "PAST"` — other features chose the
   explicit variant. All downstream handling (ENDED/MISSED/NO_SHOW, the 2026-03-01 floor, the "backfill
   from March 2026" empty state) assumes the unfiltered call returns them.
7. **EXT-7 — Whether `/institutes/{id}/teachers` is contractually unpaginated** (DEF-25), and whether
   Wise honours or caps `page_size: 1000` in the progress-tests sync (`sync.ts:66`, `:148`).
8. **EXT-8 — Whether the admissions migrations (0053/0054) are applied to the production database**
   (DEAD-30), and the same for `drizzle/0037_payroll_rate_cards.sql`, which is the only thing that makes
   payroll expected-rate checks live (OPS-23).
9. **EXT-9 — Whether `POST_CLASS_AUTO_APPROVE_ENABLED` and `POST_CLASS_PAYOUT_WRITES_ENABLED` are set in
   production**, whether `POST_CLASS_PAYOUT_TARGET` is correctly production/scratch per environment
   (`requirePayoutGoogleTarget` enforces it only when `VERCEL_ENV` is present, and `value()` returns `''`
   rather than `undefined`, so locally neither cross-check fires), and whether the tutor-workbook fleet
   has been cut over to the composite tab. Both flags default off in code.
10. **EXT-10 — Whether the July 1 2026 student-promotion run actually happened.** The target date is
    past: the cron route now always 409s while the manual apply floor is permanently open
    (`data.ts:2289-2291`). Verified/applied state is a database fact.
11. **EXT-11 — Current credit-control sync duration** (the route comment says 372-390 s as of a
    2026-06-16 incident), whether Vercel actually kills the 300 s manual route mid-run (DEF-18), and the
    production row counts behind `schema.ts:1255-1261` (SCALE-1).
12. **EXT-12 — Which IPEDS data years are loaded** (2024-25 plus 2020-21…2023-24). Nothing checks at
    runtime; a missing historical year silently shortens every trend. Related: whether `mdb-export`
    emits zero-padded CIP codes, since `isSixDigitCip` requires exactly `\d{2}\.\d{4}`
    (`parser.ts:52`) — if unpadded, all CIP-01 completions are silently dropped.
13. **EXT-13 — Whether Wise populates `userId` / `teacherName` / `title` on every session in the
    credit-control feed.** The TBC fallback is the only guard.
14. **EXT-14 — Whether Vercel invokes crons via GET.** The routes, the registry's `routeMethod` and the
    `sync-wise` comment all model it as GET; nothing in the repository can attest what the platform
    sends. This matters for `sync-room-utilization`, which exports only POST (OPS-2).
15. **EXT-15 — Whether `docs/reference/production-route-surface.json` is in sync.** It records 211 source
    routes with `recordedAt` 2026-07-29; `src/app` now walks to exactly 211 (180 `route.ts` + 31
    `page.tsx`), so the guard passes — *coincidence, or was it refreshed alongside the `student-report`
    and `line-credit-digest` additions?*
16. **EXT-16 — Cold-start index build latency on Vercel** and instance recycle frequency (SCALE-6).
    Also: a brand-new environment has no active snapshot, and `buildIndex()` throws "No active snapshot
    found" (`index.ts:151`) on every index-backed route until the first promotion — *do deployment
    runbooks guarantee a promoted snapshot before serving traffic?*
17. **EXT-17 — How many families the LINE DM `send` path can actually reach.** The group path was built
    because "almost none" survived the OA-resolver quarantine; the code comment says ~7 students.
18. **EXT-18 — Whether `origin/codex/admissions-parity-hardening` is still intended to merge**, and on
    what date (DEAD-30).
19. **EXT-19 — Whether "Form Responses 1" is append-only in practice** (DATA-24), and whether the
    `(2)AdditionalSales` tab is guaranteed to keep Thai headers (`parser.ts:139-163`).
20. **EXT-20 — Whether the `sales-dashboard-scope` collaborator guard is still needed** (CONV-12).

---

## 15. Published claims that verification could not settle

Every regenerated feature doc carries inline `unverified:` annotations where a claim could not be
grounded in code. They fall into six recurring shapes; the doc itself names the specific line in each
case.

1. **Production-only measurements preserved as code comments**, with no fixture or dated record behind
   them: the 2026-08-11 modality cross-join (>99.5 % agreement, counts 5,815/2,613/2,443/1,010,
   `student-schedule/data.ts:101-115`); the live-sweep latency profile (min 1178 ms / p50 1485 ms /
   p95 2783 ms, `live.ts:22-26`); the content-hash "two indistinguishable blues" anecdote
   (`schedule-month-calendar.tsx:48-50`); the 2026-06-10 Wise "Invalid start or end date!" event
   (`progress-tests/sync.ts:67-70`); the June 2026 post-class reconciliation collapse; the
   ~1,962-follower roster. *Each would be better as a date-stamped measurement in `docs/` or a fixture.*
2. **Platform behaviours asserted from outside the repo**: that LINE desktop/web clients offer no bot in
   their mention picker; that LINE has no webhook event for a message the OA itself sends; Vercel's
   ~14 KB request-URI limit and Node's 16 KB header budget behind the learning-plan report cap; Base
   UI's `DialogPortal` default `keepMounted = false`; Next `cacheComponents` stale-while-revalidate
   timing behind the sales-dashboard failed-source banner lag; that rotating `AUTH_SECRET` invalidates
   every stored Google token.
3. **Negative-existence claims** ("no other caller", "nothing else reads this", "never asserted
   anywhere") — verified by grep at one revision and true then, but cheap to falsify later. The
   `weekdayForIsoDate` call-site census in `proposals.md` was already off by one at this revision.
4. **Deployment status** — every "shipped"/"live"/"in production use" phrase. The repo can attest that
   code landed on a branch; it cannot attest a deployment. Several docs were softened to "landed on
   `main`" for exactly this reason.
5. **Test-coverage negatives** — the "Not covered" lists were derived by reading test files, not from a
   coverage run (TEST-13).
6. **Historical rationale** ("this exists because X used to happen") — for example the per-key ranking
   in Data Health, the post-class digest cap, and the pre-`da88794` Wise Activity pre-SELECT. These come
   from commit messages and code comments, not from a decision record.

---

## Appendix — items this pass could not place

Recorded verbatim so nothing is lost, even though they did not fit a section above.

- **The run inventory given to several agents was wrong in three places**: it named
  `src/app/api/learning-plans` (no such directory exists — Learning Plans has zero HTTP endpoints), it
  described Leave Requests as uncommitted WIP (§0), and it cited "the spine cron data provided below"
  for the Wise Activity pass without supplying any inventory. It also told three agents no feature doc
  existed when one did (GOV-29). *Correct the inventory generator before the next run.*
- **Four untracked scripts sat in the working tree during this pass** —
  `scripts/price-student-credits.ts`, `report-online-by-year.ts`, `report-student-classes.ts`,
  `report-tutor-feedback-submissions.ts` — and were deliberately left out of every doc.
  `price-student-credits.ts:117-132` reads the active payroll rate card, so once committed it becomes a
  third consumer of that card alongside Payroll and Student Promotions (OPS-23), and three of them
  import `room-capacity/dates`, which changes a consumer count in `room-capacity.md`.
  *Commit and document, or delete.*
- **`extensions/line-oa-resolver/`** (manifest, popup, content and background scripts, README) has no
  documentation anywhere in `docs/`.
- **Eight npm scripts and four `scripts/` files are documented nowhere.**
- **`docs/` still has no page for**: local development / first run, frontend-UI architecture, testing
  strategy, database backup / restore / disaster recovery, or the Home Hub at `/`.
  `docs/reference/` has an external-contract page for Wise only — none for Google Sheets, LINE, OpenAI,
  Resend, Apify or DataForSEO.

---

## Completeness review (automated)

A machine-checked pass over the generated `docs/` tree (78 `.md` files) at `main@0cd1e81`. Every item
below was produced by a script or a direct `grep` against the tree, not by reading prose. Items are
gaps in *coverage or link integrity* only — nothing here is a rewrite request, and no document was
modified by this pass except this section.

### C-1 — Three features in the maturity map have no `features/*` page

`ls docs/features/` returns 22 files; the program's maturity map names 25 areas. All three missing
areas exist in code:

| Missing page | Code that exists | Map badge |
|---|---|---|
| `features/student-report.md` | `src/lib/student-report/` (6 modules), `src/app/api/student-report/route.ts`, `src/app/(app)/student-report/page.tsx`, `src/app/(print)/student-report/report/page.tsx`, `src/components/student-report/` | stable |
| `features/line-credit-bot.md` | `src/lib/line/credit-bot.ts`, `src/lib/line/credit-digest.ts`, `src/lib/line/report-bot.ts`, cron `/api/internal/line-credit-digest` (`3 2 * * *`) | stable |
| `features/post-class-payout.md` | `src/lib/post-class-feedback/payout-*.ts` (14 modules), cron `/api/internal/post-class-feedback/payout-accrual` (`33 * * * *`) | stable (writes flag-gated) |

[`README.md`](./README.md) already declares this under *Feature areas with no dedicated page yet* and
argues the meaning is carried elsewhere. That is a reasonable disposition for `post-class-payout`
(it is the finance half of [post-class-feedback.md](./features/post-class-feedback.md)), weaker for
`line-credit-bot` (split across two pages), and weakest for **`student-report`**, whose meaning lives
nowhere in `features/` while the surface is nav-registered as **"Parent Report"**
(`src/lib/navigation/tools.ts:179-180`) and carries a print report and a public-facing artefact.

**For a human:** is `student-report.md` a required page, or is the *Parent Report* deliberately
documented only as an endpoint contract?

### C-2 — Three broken relative file links

Verified by resolving every non-`http` markdown destination against the filesystem (angle-bracket and
backslash-escaped destinations handled; 3 of 6 initial hits were parser artefacts and are **not**
defects — the `\(app\)` and `<…(app)…>` link forms in `handbook/overview.md`,
`reference/api/ai-scheduler.md:259` and `reference/api/room-capacity.md:16` resolve correctly).

| Source | Destination | Note |
|---|---|---|
| `features/credit-control.md:13` | `student-report.md` | file does not exist (C-1) |
| `features/credit-control.md:62` | `line-credit-bot.md` | file does not exist (C-1) |
| `proposals/2026-09-02-cron-efficiency-and-wise-webhooks.md:7,202` | `../reference/wise-webhooks.md` | file does not exist; cited twice as "Companion reference … (event catalogue)" |

`credit-control.md:223` and `README.md` both flag the first two as known. The third is not flagged
anywhere: the proposal points at a companion reference page that was never written.

### C-3 — Twelve broken heading anchors

Resolved with GitHub's slug rules (lowercase, strip punctuation except `-`/`_`, spaces → `-`), so
em-dash headings correctly yield a double hyphen. All twelve target a file that exists but a fragment
that does not.

| Source | Broken fragment | Actual heading at target |
|---|---|---|
| `features/ai-scheduler.md` | `erd-ai-and-proposals.md#aischedulerruns--ai_scheduler_runs` | slug ends `…-2386-2409` (line range is part of the heading) |
| `features/ai-scheduler.md` | `erd-ai-and-proposals.md#aischedulerfeedback--ai_scheduler_feedback` | slug ends `…-2410-2436` |
| `features/competitor-intelligence.md` | `erd-core.md#2-competitor-intelligence-16-tables` | competitor intelligence is section **3**, not 2 (`erd-core.md:417`) |
| `features/wise-activity-audit.md` | `erd-core.md#1-snapshot--sync-control-plane-activity-audit-auth--access-9-tables` | heading includes `cron observability` (`erd-core.md:54`) |
| `features/wise-activity-audit.md` | `erd-core.md#7b-sessions-feedback-evidence-and-assessment` | no `7b` sub-heading exists; `erd-core.md` H2s run `1`–`9` plus *Open questions* |
| `features/room-capacity.md` | `erd-classrooms.md#classroomrooms-classroom_rooms` | single hyphen; heading is `### \`classroomRooms\` — \`classroom_rooms\`` → `classroomrooms--classroom_rooms` |
| `features/room-capacity.md` | `erd-room-capacity.md#roomcapacitydemandmix-room_capacity_demand_mix` | same single-vs-double hyphen defect |
| `features/line-integration.md` | `../reference/api/line.md#authentication-model` | `api/line.md` has no such H2; nearest is `## Conventions shared across the endpoints` (`:45`) |
| `features/student-schedule.md` | `../operations/runbook.md#41-onboarding-a-new-schedule-bot-admin-operator` | `runbook.md:273` is `### 4.1 How the auth check works`; no onboarding section exists |
| `features/university-admissions.md` | `../reference/database/enums.md#university-admissions-case-management` | heading is `## University admissions` (`enums.md:667`) |
| `reference/api/line.md` | `#post-apilineschedulerreviewsreviewidwise-actions` | self-link; correct slug keeps the hyphen in *scheduler-reviews* → `post-apilinescheduler-reviewsreviewidwise-actions` |
| `reference/api/university-admissions.md` | `../crons.md#9-admissions-notifications--…` | the admissions cron is entry **16** in the regenerated `crons.md:527` |

The last row is a symptom of C-4 rather than an independent defect.

### C-4 — Five reference pages were not regenerated and lack the required footer

`git status --porcelain docs/` shows the pass touched 58 files. These five were **not** among them,
and each still carries an older verification footer:

| File | Footer it carries |
|---|---|
| `reference/wise-api.md` | `_Verified against the release tree on 2026-07-21._` |
| `reference/api/university-admissions.md` | `_Verified against the route handlers and \`src/lib/admissions/**\` on 2026-07-10._` |
| `reference/api/student-promotions.md` | *(no verification footer at all)* |
| `reference/database/erd-student-promotions.md` | *(no verification footer at all)* |
| `reference/database/erd-university-admissions.md` | *(no verification footer at all)* |

Every other handbook, feature, operations and reference page (59 files) carries
`_Verified against main@0cd1e81 (clean tree) on 2026-09-02._` exactly. The remaining footer-less files
are out of scope by design: the AI-scheduler eval reports, `superpowers/`, the two admissions
background docs, the historical release checkpoint, and the dated proposal (which carries its own
`origin/main fed828d` footer).

### C-5 — `erd-university-admissions.md` documents 25 of 36 `admissions_*` tables

`grep -c '= pgTable("admissions_' src/lib/db/schema.ts` → **36**. The page opens with "**25 tables**"
(`erd-university-admissions.md:3`) and contains exactly 25 `### \`admissions_*\`` entries. Eleven
tables are therefore absent from the only mechanical reference for that domain — the largest
single-domain coverage hole in `reference/`. This is the reference-side face of the caveat the feature
page already carries (schema landed on `main` ahead of its code); §12 item 2 records the count, but
the eleven undocumented tables are not enumerated anywhere.

### C-6 — `reference/api/index.md` contradicts `reference/api/misc.md` on `student-report`

`api/index.md:75` states: *"`student-report` has no detail section anywhere yet … `docs/reference/api/`
does not mention it at this revision."* But `api/misc.md:434` is a full `## Student report` section
with query schema, response shape and all six status codes (`:438-452`), and `README.md` lists
student-report among the groups `misc.md` covers. Consequently:

- the group table row (`api/index.md:64`) links to bare `./misc.md` while every neighbouring row uses
  an anchor — the only row missing its `#…` fragment;
- the bullet at `api/index.md:74` enumerating the sections inside `misc.md` omits *student-report*.

### C-7 — §12 item 15 of this document is now self-stale

Item 15 reads "Fifteen `docs/reference/api/` pages still carry the footer `_Verified against HEAD +
uncommitted WIP on 2026-05-31._`". `grep -rl` for that string across `docs/` now returns **two** files,
neither of them a reference page: this document (quoting it) and
`features/leave-requests.md:152` (quoting it inside an open question). Zero `reference/api/` pages
carry it. The item survived a regeneration that fixed the thing it describes.

### C-8 — Foundation topics with no page (confirmed against the tree)

The Appendix already lists these; this pass narrows the claim to what is actually uncovered, because
two of them are in fact covered:

- **Covered, contrary to the Appendix** — *local development / first run* is documented at
  `operations/runbook.md:164-215` (`npm run dev` / `build` / `lint` / `typecheck`, `.env.example` →
  `.env.local`, the five test scripts, and the Docker requirement for `testcontainers`).
- **Genuinely uncovered** — frontend/UI architecture (design tokens, `components/ui` vs feature
  components, the Server-Component→client-shell pattern, `TUTOR_COLORS`); a single home for testing
  strategy (it is split across `handbook/data-flow.md:413`, `operations/runbook.md:187`,
  `operations/observability.md:728`, `operations/auth-and-access.md:616`); database backup / restore /
  disaster recovery; the Home Hub at `/`; and the `scripts/` directory (42 entries, including ~15
  one-shot payout-workbook remediation scripts) which no page inventories.
- **External contracts** — `reference/` has a page for Wise only. Google Sheets, LINE Messaging,
  OpenAI, Resend, Apify and DataForSEO appear only inside `reference/env.md` and scattered feature
  pages; none has a contract page describing transport, auth, retry or failure modes.

### C-9 — ERD page granularity is asymmetric

Two of the three largest table families have no `erd-*` page and are documented as sections inside
`erd-core.md`: **post-class feedback (32 tables)** and **competitor intelligence (16 tables)**. Domains
an order of magnitude smaller each get their own file — `erd-tutor-profiles.md` (2 tables),
`erd-room-capacity.md` (4), `erd-leave-requests.md` (5). `README.md` explains the post-class case;
competitor intelligence is not explained. The deep-link failures in C-3 (three of twelve target
`erd-core.md` sub-sections) are a direct consequence: long generated section slugs are fragile link
targets in a way that dedicated files are not.

### What this pass checked and found clean

Recorded so a later pass does not re-derive it: all **17** `vercel.json` cron paths appear in
`reference/crons.md`; all **29** `src/app/api/*` route groups appear in `reference/api/index.md`
(student-report included); all **22** feature pages carry exactly the badge string the maturity map
assigns; and every scale figure in `README.md:31-45` reproduces from the tree — 189 `pgTable`, 61
`pgEnum`, 69 migrations, 180 route files, 241 named handlers (+2 Auth.js, −2 `OPTIONS` = 243), 17
crons, 26 `(app)` pages of 31 total, 22 nav tools, 389 test files.

### Gap-fill follow-up — 2026-09-02, `main@0cd1e81`

A second pass over the same tree wrote the missing pages and repaired every link. Eight of the nine
gaps are closed; the counts below are re-derived, not carried forward from the review above.

| Gap | State | Evidence |
|---|---|---|
| **C-1** — three maturity-map features with no page | **closed** | `ls docs/features/*.md \| wc -l` → **25**. [`student-report.md`](./features/student-report.md), [`line-credit-bot.md`](./features/line-credit-bot.md) and [`post-class-payout.md`](./features/post-class-payout.md) all exist and are listed in [`README.md`](./README.md). The human question C-1 asked — *is `student-report.md` required?* — is answered by writing it. |
| **C-2** — three broken relative file links | **closed** | All three destinations exist: `features/student-report.md`, `features/line-credit-bot.md`, and [`reference/wise-webhooks.md`](./reference/wise-webhooks.md), the proposal's companion event catalogue. |
| **C-3** — twelve broken heading anchors | **closed** | Of the twelve: **3** were retargeted onto pages created by this pass (competitor intelligence and Wise activity out of `erd-core.md`, and the `7b` evidence sub-section into `erd-post-class-feedback.md`); **5** were re-slugged in place (the two `erd-ai-and-proposals.md` headings that carry a line range, the two em-dash headings that need a double hyphen, and `line.md`'s own `scheduler-reviews` self-link); **3** were retargeted to the right heading on the page they already named (`api/line.md`, `runbook.md`, `enums.md#university-admissions`); and **1** — `api/university-admissions.md` into `crons.md` — was already correct at this revision, the regenerated `crons.md` having renumbered the admissions cron to entry 16. A full sweep found **46** broken links tree-wide, not twelve; all 46 are fixed and all **6,655** relative links now resolve. |
| **C-4** — five pages without the required footer | **closed** | `grep -rlx '_Verified against main@0cd1e81 (clean tree) on 2026-09-02._' docs/` → **83**, all five formerly-stale pages included. See [`README.md` → Footer coverage](./README.md#footer-coverage). |
| **C-5** — `erd-university-admissions.md` documented 25 of 36 tables | **closed** | The page now opens at **36** and carries 36 `### \`admissions_*\`` entries — `grep -cE '^### \`admissions_' docs/reference/database/erd-university-admissions.md` → 36, matching `grep -c '= pgTable("admissions_' src/lib/db/schema.ts` → 36. The remaining unreconciled item is the `schema.ts:3959-3963` comment, which the page now attributes rather than repeats. |
| **C-6** — `api/index.md` contradicted `misc.md` on `student-report` | **closed** | The group row now reads `student-report \| /api/student-report \| 1 \| student-schedule-and-report.md#parent-class-report` ([`index.md:69`](./reference/api/index.md)) — an anchored link like every neighbour, to a page that owns the contract. |
| **C-7** — §12 item 15 was self-stale | **closed** | Item 15 above is rewritten to the verified state. |
| **C-8** — foundation topics with no page | **open** | Two pages landed near this area — [`operations/maintenance-mode.md`](./operations/maintenance-mode.md) and [`reference/wise-webhooks.md`](./reference/wise-webhooks.md) — but neither is on C-8's list. Still uncovered, with no page in `handbook/`, `reference/` or `operations/` owning any of them: frontend/UI architecture (the only mentions of `TUTOR_COLORS` in the tree are inside `features/tutor-compare.md` and an unmaintained `superpowers/` plan); a single home for testing strategy; database backup / restore / disaster recovery; the Home Hub at `/`; the `scripts/` inventory; and contract pages for the six non-Wise external services (Google Sheets, LINE Messaging, OpenAI, Resend, Apify, DataForSEO). |
| **C-9** — asymmetric ERD granularity | **closed** | Six new `erd-*` pages: [post-class-feedback](./reference/database/erd-post-class-feedback.md) (32), [competitor-intelligence](./reference/database/erd-competitor-intelligence.md) (16), [progress-tests](./reference/database/erd-progress-tests.md) (8), [wise-activity](./reference/database/erd-wise-activity.md) (2), [learning-plans](./reference/database/erd-learning-plans.md) (1), [student-schedule](./reference/database/erd-student-schedule.md) (1). `erd-core.md` drops from 124 tables to **22** and opens with a *Moved* table; [`database/index.md`](./reference/database/index.md) now uses eighteen domains, one per diagram page. |

**Not a gap, but corrected alongside them:** five open-question items across the tree asserted drift
that their own regenerated link targets no longer carry — `post-class-feedback.md` items 11 and 13,
`university-admissions.md`'s reference-disagreement item, and `credit-control.md` items 10 and 12.
Each is rewritten to record the closure rather than deleted, so the audit trail survives.

**For a human:** C-8 is the only gap this pass did not touch, and it is the one that needs a scope
decision rather than a regeneration — all six remaining topics would each be a new page.

---

_Verified against main@0cd1e81 (clean tree) on 2026-09-02._
