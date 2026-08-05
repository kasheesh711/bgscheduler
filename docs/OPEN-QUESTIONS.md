# Open Questions

Things only a human can answer.

This file is the consolidated output of an automated documentation pass that re-read the
BGScheduler codebase and rewrote the handbook, the feature docs, and the API/DB/cron/env
reference against HEAD plus uncommitted work in progress. Every documentation agent in that run
was asked to record anything it could not settle from code alone — a product decision, an
operational fact that lives outside the repo, a suspected bug, or a contradiction between two
sources of truth. Those findings are collected here, de-duplicated, and grouped. This revision
supersedes an earlier version of this file produced on the `docs/full-redocumentation` branch,
whose inventory numbers (110 endpoints, 96 route files, 14 features) no longer describe the tree.

**How to read this.** Each item is a decision, not a task. Evidence is cited as `path:line` so it
can be checked in seconds. Items marked **(re-verified)** were re-confirmed by grep or by opening
the file during consolidation; the rest carry the citation supplied by the agent that had the file
open. Nothing here was fixed — the pass documented what the code does, and deliberately did not
change behaviour or paper over a contradiction.

**Item IDs are stable and are cited from other pages.** `docs/reference/api/classrooms-and-assignments.md`
points at DEF-9, DEF-11, SEC-2, and SEC-3; `docs/features/post-class-feedback.md` points at DEAD-13.
Renumber nothing — append. One correction was applied in this revision: **DEAD-13 was wrong** and has
been rewritten in place rather than deleted, because the claim it repeated is still live in
`src/lib/db/schema.ts` and in `docs/reference/database/index.md`.

**Scale context** (re-verified this pass): 188 `pgTable` declarations in `src/lib/db/schema.ts`,
178 `route.ts` files under `src/app/api`, 15 cron entries in `vercel.json`, 29 `page.tsx` files of
which 25 are in the `(app)` route group, 65 migrations in `drizzle/`.

---

## 1. Confirmed defects awaiting an owner decision

These are not documentation ambiguities. Each is a behaviour the code demonstrably has, that an
owner should either accept in writing or fix.

**DEF-1 — Credit Control is reported as failing while it is running normally.**
(re-verified) `src/app/api/internal/sync-credit-control/route.ts:14` sets `maxDuration = 800`, with
a comment recording that successful runs take 372–390s and that 300s produced recurring Vercel
timeouts from 2026-06-16. But `src/lib/data-health/cron-registry.ts:118` still declares
`maxDurationSeconds: 300`, and stuck-run detection reads the **registry** value
(`src/lib/data-health/status.ts:239`). Any run between 300s and 800s — i.e. every healthy run — is
classified `failing` on `/data-health` and is alertable by the cron watchdog.
`cron-registry.test.ts` compares only path and schedule, so nothing catches this.
*Correct the registry to 800, and should the test also assert `maxDurationSeconds` against each
route's exported `maxDuration` so the other 20 jobs cannot drift the same way?*

**DEF-2 — `src/lib/env.ts` never runs.**
(re-verified) A repo-wide grep for `@/lib/env` and `lib/env` across `src/` and `scripts/` returns
zero importers outside the file itself. The module exports `env = getEnv()`, which validates at
module-evaluation time (`src/lib/env.ts:37`) — but nothing evaluates the module. The documented
"environment validated at startup, throws on invalid" guarantee therefore does not hold. Consumers
read `process.env.*` directly and fail at their own call site (e.g. `getDb()` throwing
`DATABASE_URL is not set`, `src/lib/db/index.ts:6-9`). The schema declares 15 keys; roughly 56–58
distinct env keys are read across `src/`.
*Wire it into a real startup path (root layout or `instrumentation.ts`) and extend it to the live
key set, or delete it and document per-call-site reads as the actual convention?*

**DEF-3 — Seven Data Health "Run now" buttons return 404 and write a failed audit row.**
(re-verified) `src/lib/data-health/cron-registry.ts:3-23` declares 21 `CronJobKey` values;
`src/lib/data-health/run-job.ts` branches on 14 of them and falls through to
`{ error: "Unknown job" }` 404 at `run-job.ts:195`. The seven with no branch — `progress_tests`,
`progress_tests_digest`, `post_class_feedback_backfill`, `post_class_feedback_payout_accrual`,
`student_promotions_july_1`, `admissions_notifications`, `line_backlog_recovery` — still render
buttons in the `manualActions` list. Each click also writes a `failed` admin row to
`cron_invocations` through the audit wrapper (`run-job.ts:34-41`), polluting `latestInvocation` in
the Cron control plane. Note `src/app/api/internal/post-class-feedback/payout-accrual/route.ts:12-14`
claims it is "Reachable only manually from Data Health", which is not true today.
*Filter `manualActions` to runnable keys, or implement the branches? Several are dangerous
finance/Wise write paths, which is plausibly why they were omitted.*

**DEF-4 — `weekdayForIsoDate` reads the process timezone, not Bangkok.**
(re-verified) `src/lib/proposals/overlap.ts:45-47` builds a `+07:00`-anchored `Date` and then calls
`.getDay()`, which resolves in the *process* zone. On a UTC runtime it returns the previous day's
weekday. It feeds one-time proposal-hold creation (`src/app/api/proposals/route.ts:73-75`) and,
more seriously, one-time range-search matching including `getBlockingSessions`
(`src/lib/search/range-search.ts:143`, `:192`) — so it can shift *Wise blocking evidence* on the
live search path, not just proposal overlap.
*Fix to a Bangkok-anchored weekday, and decide whether existing `one_time` `proposal_items` rows
need a weekday backfill.*

**DEF-5 — Leave Requests has no abandoned-run recovery, so one timeout wedges it forever.**
(re-verified) Thirteen other modules implement a stale-`running` reclaim (`sync/run-wise-sync.ts`,
`credit-control/run-sync-request.ts`, `progress-tests/run-sync-request.ts`, `wise-activity/sync.ts`,
`post-class-feedback/repository.ts`, `sales-dashboard/import-guard.ts`,
`competitor-intelligence/sync.ts`, `payroll/sync.ts`, `admissions/notifications.ts`); grep for
`stale`/`reclaim` in `src/lib/leave-requests/sync.ts` returns nothing. The run row defaults to
`status = "running"` and the unique-index violation becomes `LeaveRequestSyncAlreadyRunningError`
(`src/lib/leave-requests/sync.ts:385`). A function killed at `maxDuration` strands the row and every
subsequent sync returns 409 permanently.
*Intentional, or add the standard 20-minute reclaim?* (`src/lib/leave-requests/**` is on the
do-not-edit list for this pass.)

**DEF-6 — The LINE write path is not flag-gated, contrary to AGENTS.md.**
(re-verified) `lineSchedulerEnabled()` is defined at `src/lib/line/client.ts:19` and called in
exactly one place: `src/app/api/line/webhook/route.ts:11`. It gates **ingest** only.
`approveLineSchedulerReview` calls `pushLineTextMessage` unconditionally
(`src/lib/line/review-service.ts:487-491`), so the practical send gate is
`LINE_CHANNEL_ACCESS_TOKEN` plus the verified-link requirement — not the flag. AGENTS.md and the
feature summary still describe the reply path as "flag-gated (`ENABLE_LINE_SCHEDULER`) and dry-run
only".
*Is the real push intended (then correct AGENTS.md), or is the missing flag check a bug?*

**DEF-7 — A successful LINE send can be reported to the operator as a failure.**
`patchLineSchedulerReview` at `src/lib/line/review-service.ts:493-505` is not wrapped in
`recordPostSendAudit`, while the two writes around it are. If the patch throws after the push
succeeded, the parent has the message but the review stays `pending_review` and the UI reports a
send failure. *Retry the patch, or move the whole tail behind one guard?*

**DEF-8 — Competitor Intelligence returns 500 for malformed request bodies.**
`competitorIntelligenceErrorResponse` (`src/lib/competitor-intelligence/access.ts:32-54`) has no
`ZodError` branch, yet its mutation routes call `Schema.parse()`. A bad body surfaces as HTTP 500
with the raw Zod message. Every sibling family maps `ZodError` to 400.

**DEF-9 — `GET /api/class-assignments/runs/[runId]/teacher-schedule` 500s on a missing run.**
It has no 404 branch, unlike every sibling run-scoped route: "Assignment run not found" is returned
as a 500.

**DEF-10 — Two leave-request routes have inverted error mapping.**
`POST /api/leave-requests/[requestId]/wise-cancel-preview` maps *every* thrown error to 400
(`route.ts:33-36`), so a database or Wise outage is reported as a client error and there is no 500
path. `GET /api/leave-requests/[requestId]` (`route.ts:14-24`) has no try/catch at all, so an
infrastructure failure escapes as an unhandled Next 500 with no JSON `{ error }` body —
inconsistent with the PATCH in the same file.

**DEF-11 — The publish poll erases the live-conflict banner.**
`getClassroomAssignmentByRunId` hard-codes `liveRoomBlocks`/`roomConflictWarnings` to empty
(`src/lib/classrooms/data.ts:1864-1877`) and the workspace overwrites its state with that payload
(`class-assignments-workspace.tsx:449`). A conflict surfaced by `POST /run` disappears the moment a
publish job goes terminal — precisely when an operator most needs it.
*Should the terminal detail recompute conflicts like a fresh run?*

**DEF-12 — `createWiseCancelPreview` bypasses the normalization gate.**
`src/lib/leave-requests/data.ts:647-650` overwrites `cancellationPreviewCount` with a bare
`rows.length`, skipping the gate and class-id/session-id filter the sync recompute applies
(`data.ts:490`). A `needs_review` request can therefore advertise previewable cancellations.

**DEF-13 — `updateLineContactLabels` is a destructive "partial" update.**
`src/lib/line/data.ts:374-381` writes `input.X ?? null` for **both** label columns, so
`PATCH /api/line/contacts/[contactId]` silently clears any label the caller omitted — and
alias-import/commit clears `linkedParentLabel` on every committed row
(`src/lib/line/contact-aliases.ts:498`). *Intentional, or latent data loss?*

**DEF-14 — Calendar-day highlighting in Credit Control cannot ever match.**
`selectedDayStudentKeys` is built from `CalendarStudentEntry.key = "<student name>::<date>"`
(`src/lib/credit-control/analytics.ts:339-340`) but is tested against
`row.studentKey = "<normalized name>::<normalized parent>"` (`queue-panel.tsx:291`). The two key
spaces never intersect. Separately, `isDayHighlighted` is passed only to the desktop table rows and
never to the compact card layout (`queue-panel.tsx:234-247`), so even a fixed version would be
desktop-only. *Regression, or dead prop to remove?*

**DEF-15 — The Wise Activity reconciliation backfill stops on its second run.**
`POST /api/wise-activity/reconciliation/backfill` never passes `stopOnKnownEvents`
(`route.ts:38-46`), inheriting the library default of `true` (`src/lib/wise-activity/sync.ts:163`).
The sibling `POST /api/wise-activity/sync` carries a comment stating that a targeted backfill *must
not* stop on the first already-known page because "on a re-run that is page one"
(`sync/route.ts:49-51`). So a second press of "Backfill selected range" aborts at page one with
`stoppedReason: known_events`.

**DEF-16 — Orphan payout invoices are double-counted in Payroll.**
The invoice loop raises `unresolved_tutor_identity` on top of `orphan_payout_invoice` and opens a
second `unresolved:<wiseUserId>` aggregate row beside the tutor's canonical-key row, inflating
`summary.tutorCount` and `summary.unresolvedTutorCount` (`src/lib/payroll/data.ts:337`, `:360-368`,
`:515`, `:521`). The loop already looks up `payroll_teacher_tiers` by the same `wiseUserId`, so it
could resolve identity itself.

**DEF-17 — Sales-dashboard import returns 500 for validation failures.**
`ImportSchema.parse()` sits inside the try and `errorResponse` only special-cases
`MissingGoogleSheetsTokenError` (`src/app/api/sales-dashboard/import/route.ts:24-28`, `:36-37`), so
malformed JSON and Zod failures return 500 where every sibling route returns 400.

**DEF-18 — `POST /api/credit-control/sync` is guaranteed to time out.**
It sets `maxDuration = 300` (`sync/route.ts:4`) while its cron twin was raised to 800 precisely
because runs take 372–390s (DEF-1). *Raise the manual route to 800.*

**DEF-19 — Search hard-fails on an un-migrated profile table.**
`getTutorProfileVersion()` (`src/lib/search/index.ts:128-137`) is the only
`tutor_business_profiles` query without the `isMissingTutorProfileTable` guard, so a missing table
throws out of `buildIndex`/`ensureIndex` and returns 500 from `/api/search` — while
`/tutor-profiles` still loads via the guarded path. Related: the guard itself matches on error
substrings including the bare word `column` (`src/lib/tutor-business-profiles.ts:200-201`), so an
unrelated error could be silently swallowed as an empty profile set.
*Apply the guard (falling back to a constant version), and match SQLSTATE instead of substrings?*

**DEF-20 — A leave that crosses midnight but lasts under 24h blocks nothing at all.**
(re-verified) `isBlockedByLeave` (`src/lib/search/engine.ts:257-286`) discriminates on **duration**:
`isMultiDay = end - start > 24h`. A leave from Mon 20:00 to Tue 10:00 is 14 hours, so it takes the
single-day branch, which reads `leaveStart.getDay()` and compares minute-of-day
(`engine.ts:279-284`). Searching **Monday** 15:00-20:00 gives `leaveStartMin = 1200`,
`leaveEndMin = 600`, and `1200 < 1200` is false → not blocked. Searching **Tuesday** fails the
`leaveStart.getDay() !== weekday` guard at `:279` → not blocked. The tutor is returned **Available**
on both days while on approved leave.
This violates the AGENTS.md non-negotiable that the system must never return a tutor as available
without proof, it is timezone-independent (unlike TZ-1), and no test covers it.
*Fix the discriminator to a calendar-day span rather than a duration — or accept it in writing. This
one needs a code change; the feature docs should not be edited to bless it.*

**DEF-21 — Snapshot retention silently stops working once a classroom run pins a snapshot.**
(re-verified) `classroom_assignment_runs.snapshotId` and `classroom_assignment_rows.snapshotId` both
declare `.references(() => snapshots.id)` with no `onDelete`, i.e. `NO ACTION`
(`src/lib/db/schema.ts`, classroom block). `pruneOldSnapshots` deletes eleven tutor-domain tables and
then `schema.snapshots` itself (`src/lib/sync/snapshot-pruning.ts:106-176`) and never touches the
classroom tables. Pruning a snapshot still referenced by a classroom run therefore raises a foreign-key
violation — which the orchestrator catches, logs to `console.error`, and records as
`metadata.pruning = { attempted: true, failed: true, error }` while the sync still reports
`status = "success"` (`src/lib/sync/orchestrator.ts:525-548`). Retention quietly stops; nothing on
`/data-health` surfaces it. No test covers classroom rows during pruning.
*Should pruning detach or cascade classroom runs, should classroom runs stop FK-referencing snapshots,
or should a failed prune at least degrade the sync's reported status?*

**DEF-22 — A student-promotion run that crashes mid-apply is unrecoverable.**
(re-verified) `applyVerifiedStudentPromotionRun` flips the run to `applying`
(`src/lib/student-promotions/data.ts:2312-2313`) and only ever writes a terminal status at `:2347-2348`,
where `terminalStatus` is `applied` or `applied_with_errors` — individual action failures are absorbed
into counts (`:2340-2342`). Nothing writes `failed` at the **run** level (the `failed` writes at
`:2387` and `:2399` are on `student_promotion_future_session_actions`). If the function throws — Wise
outage in `fetchWiseAcceptedStudents` (`:2307`), a crash inside the `mapLimit` fan-out, or the 800s
`maxDuration` ceiling — the row stays `applying` forever, and a retry is refused because apply requires
`verified` (`:2299-2300`, "Only verified student promotion runs can be applied").
*Is the recovery path a fresh audit run, a manual `UPDATE`, or a watchdog that was intended and never
built? This is the operational sibling of the missing single-flight guard on `POST /api/student-promotions/runs`.*

**DEF-23 — Leave-request tutor matching is last-write-wins on bare first names, and never routes to
Needs Review.** (re-verified) `tutorNameAliases` (`src/lib/leave-requests/matching.ts:31-42`) emits the
bare **first name** as an alias alongside the full name and the parenthesised nickname. The lookup map
is then populated with `byName.set(alias, group)` from four successive sources — identity groups,
group members, tutor contacts (including `sourceNames`), and `tutor_aliases`
(`matching.ts:88-111`) — with no collision detection. Two tutors sharing a first name means the alias
resolves to whichever group was iterated **last**, and the match is recorded with
`matchConfidence: "name"`, so it never routes to Needs Review. `recomputeAffectedSessionsForRequest`
will then compute — and the Wise-cancel preview will offer — the **wrong tutor's** classes.
This contradicts the fail-closed posture the feature otherwise holds (it correctly refuses to compute
anything when there is no active snapshot).
*Add an ambiguity branch that demotes a colliding alias to `needs_review` rather than picking one.*
(`src/lib/leave-requests/**` is read-only for this pass, so this is recorded, not fixed.)

**DEF-24 — The Student Schedule print report's "Back to form" navigates to Learning Plans.**
(re-verified) `PrintToolbar` hard-codes `render={<Link href="/learning-plans" />}`
(`src/components/learning-plan/print-toolbar.tsx:20-24`) and is rendered by **both** print pages —
`src/app/(print)/learning-plans/report/page.tsx` and
`src/app/(print)/student-schedule/report/page.tsx`. A staff member printing a student schedule is
therefore sent to the Learning Plans form.
*Give the toolbar a `backHref` prop, or move it out of the `learning-plan` component directory as a
shared print primitive.*

---

## 2. Maturity, lifecycle & documentation governance

**GOV-1 — No maturity-badge map was supplied to any agent.** Every documentation agent in this run
received an empty badge map (`{}`). Agents variously kept an existing badge, dropped it, derived it
from `docs/README.md`, or stated reach from code instead. There are no `@deprecated` or status
markers anywhere in the source, so there is currently no authoritative source for a feature's
maturity label.
*Establish one (a checked-in map, or a `Status:` line owned by each feature doc), and decide whether
`docs/reference/*` pages carry badges at all — today they are inconsistent.*

**GOV-2 — Specific badges that could not be validated.** Credit Control (`stable` vs the
code-grounded `live`), Data Health (`stable` vs `deployed`), Proposals (`stable` in
`reference/api/proposals.md` vs `experimental` in `docs/features/proposals.md` and AGENTS.md), Room
Capacity (`stable` while `docs/reference/crons.md:322` calls its sync "effectively disabled"), Leave
Requests (`in progress / uncommitted` — see GOV-3), AI Scheduler (`experimental` with no flag gating
anything, so it is reachable by every authenticated admin).
*Pick one label per feature and apply it consistently across AGENTS.md, `docs/README.md`, the
feature doc, and the reference pages.*

**GOV-3 — Leave Requests is no longer uncommitted.** AGENTS.md, `docs/README.md`, and
`docs/reference/database/erd-leave-requests.md` all describe the feature as uncommitted WIP. At HEAD
every file is committed (`git log -1 -- src/lib/leave-requests/` → `8cc2717`, 2026-06-04), the
working tree is clean, and the routes, page, nav entry, `vercel.json` cron, and 6 test files all
exist. The ERD's "🟡 IN PROGRESS — uncommitted" banner is wrong.
*Confirm the intended label and remove the banner.*

**GOV-4 — The mandated footer date (2026-05-31) is older than the tree it describes.** HEAD is
`9f72002` dated 2026-08-05, and it includes subsystems (student-schedule, post-class-feedback,
progress-tests, admissions, competitor-intelligence) that postdate the footer. Other docs carry
conflicting dates: `docs/README.md` and `docs/reference/env.md` said "Verified against the release
tree on 2026-07-21"; `docs/handbook/overview.md` said 2026-07-23. Agents applied the mandated footer
verbatim as instructed.
*Decide the authoritative verification date and apply it repo-wide, or make the footer a real
timestamp rather than a workflow constant.*

**GOV-5 — Four shipped, nav-registered features have no feature doc.** Progress Tests
(`src/lib/progress-tests/`, cron `25,55 * * * *` plus a daily admin digest), Student Schedule
(`src/lib/student-schedule/`, public `/schedule/[token]` plus the LINE schedule bot), Competitor
Intelligence (`src/lib/competitor-intelligence/`, weekly cron), and US Universities/IPEDS
(`src/lib/us-universities/`). Each has a `src/lib` module, an API group, a nav entry in
`src/lib/navigation/tools.ts`, and tests. Three of the 15 crons therefore have no "why/rules"
canonical home to link to. *Author these four.*

**GOV-6 — Five API reference pages linked from the index do not exist.** (re-verified by
`ls docs/reference/api/`) Missing: `competitor-intelligence.md`, `post-class-feedback.md`,
`progress-tests.md`, `student-schedule.md`, `us-universities.md`. Their endpoints are documented
only in `misc.md` or nowhere, and the index links are dead.

**GOV-7 — Canonical-home conflict for API families.** `docs/reference/api/index.md` routes
admissions (61), competitor-intelligence (9), post-class-feedback (13), progress-tests (6),
student-promotions (9), student-schedule (2), and us-universities (5) to dedicated pages, but the
authoritative inventory placed all 105 in `misc.md`. `student-promotions.md` and
`university-admissions.md` already exist and now overlap `misc.md` directly.
*Decide which page is canonical per family; the other should link, not restate.*

**GOV-8 — Canonical-home conflict for database columns.** Seven ERD pages (`erd-classrooms`,
`erd-payroll`, `erd-line`, `erd-credit-control`, `erd-room-capacity`, `erd-tutor-profiles`,
`erd-ai-and-proposals`) tell readers that full column listings live in
`docs/reference/database/index.md`, but that index is now a per-table directory keyed by `schema.ts`
line ranges, not a column dump.
*Either reword the cross-references to point at `src/lib/db/schema.ts`, or expand `index.md` to
carry full column tables for all 188 tables.*

**GOV-9 — `erd-core.md` has swollen past its title.** It now also carries competitor intelligence
(16 tables), progress tests (8), IPEDS (3), post-class feedback including finance/payout (32),
admissions (36), and student-schedule links (1) — and duplicates the 42 tables already documented in
`erd-student-promotions.md` and `erd-university-admissions.md`.
*Rename it, split the non-core clusters into their own `erd-*.md`, or retire the sibling pages.*

**GOV-10 — `.planning/codebase/*` is stale and should stop being cited as authoritative.** Measured
drift at HEAD: 130 vs 369 test files, 96 vs 178 `route.ts` files, 13 vs 15 shadcn primitives, and
eight whole subsystems missing. Agents kept the pointer and added explicit drift tables rather than
silently deviating. *Regenerate via `/gsd-map-codebase`, or drop the pointers.* One concrete example
worth correcting wherever it propagated: the prior `INTEGRATIONS.md` claimed there is no
`.github/workflows/` — there are two (`ci.yml`, `sales-dashboard-scope.yml`, re-verified by `ls`), so
any doc repeating "no CI" is wrong.

**GOV-11 — AGENTS.md / CLAUDE.md / README.md inventories are materially behind the tree.**
AGENTS.md claims 78 tables, 110 endpoints, 7 crons, 14 pages, 130 test files, and "82 existing tests
must continue to pass". The tree has 188 tables, 178 `route.ts` files, 15 crons, 29 pages (25 in
`(app)`). README.md says "8 Vercel crons" at `:33` and "Seven Vercel crons" at `:101` with a 7-row
table, plus 117 handlers and 82 tables at `:21-22`. `docs/handbook/overview.md` says 176/117/24.
*These need one owner and one refresh.*

**GOV-12 — Feature count disagreement.** The pass brief said 14 features; `docs/features/` holds 18
pages; `src/lib/navigation/tools.ts` declares 21 nav tools across 6 sections (23 counting Tutor
Compare and Proposals, which surface inside `/search`); `src/lib` has 35 modules.
*Fix the canonical number and its definition.*

**GOV-13 — Endpoint-count definition.** `docs/reference/api/index.md` declares 241 method+path
endpoints and its per-group rows sum to 241. An independent grep finds 243 if both CORS `OPTIONS`
handlers (`src/app/api/line/contacts/oa-resolver/worklist/route.ts:17` and
`.../runs/[runId]/rows/route.ts:48`) are counted; the index counts the Auth.js catch-all as 2 via
`export const { GET, POST } = handlers` while excluding the two `OPTIONS`.
*Should `OPTIONS` handlers be in the canonical count?*

**GOV-14 — Page-count definition.** (re-verified) 25 `page.tsx` under `src/app/(app)/`, 29 total.
The extra four are `/login`, `/schedule/[token]` (public, token-gated), and two `(print)` report
routes — one of which has test coverage (`learning-plans/__tests__/page-guards.test.ts`).
*Confirm 25 deliberately excludes them.*

**GOV-15 — `docs/handbook/overview.md:35` still calls the AI Scheduler "the newest, least settled
feature"**, a claim removed from `docs/features/ai-scheduler.md` during this pass (six lib
directories postdate `src/lib/ai`). The two files now contradict each other.

**GOV-16 — AGENTS.md's Zod claim is false.** It states Zod validates external Wise payloads; there
is zero Zod in `src/lib/wise`, `src/lib/normalization`, or `src/lib/sync`.
*Is boundary schema validation wanted, or is accessor-based tolerance the deliberate policy?
AGENTS.md needs correcting either way.*

**GOV-17 — AGENTS.md's "reads never hit Wise on the request path" is over-scoped.** True of tutor
search/compare only. 21 non-test files import `@/lib/wise/client` or `@/lib/wise/fetchers`, and
`POST /api/class-assignments/run` reaches `fetchAllFutureSessions` synchronously during an admin
request (`src/lib/classrooms/data.ts:889`, `:993`).
*Rescope the Source-of-Truth section, or record the classroom live-fetch as a named exception.*
The same section's "no production fallback to Google Sheets or `.xlsx`" line now reads oddly too,
since Sales Dashboard, Credit Control, Leave Requests, and Post-Class payouts all read Sheets as
first-class sources.

**GOV-18 — Branch and merge path.** Documentation was generated on `docs/comprehensive-refresh`
(parts on `feat/student-schedule`), which is ahead of `main`. Line anchors into `middleware.ts` and
`schema.ts` may differ on `main`. *Confirm the intended merge path.*

---

## 3. Suspected dead code and unused surface

**DEAD-1 — `src/lib/env.ts`** — see DEF-2. Zero importers.

**DEAD-2 — `src/lib/search/parser.ts` (`parseSlotInput`)** — full test suite, but its only importer
is that test file.

**DEAD-3 — Five unimported components.** `results-view.tsx`, `slot-builder.tsx`, `slot-chips.tsx`,
`slot-input.tsx`, `ai-scheduler-panel.tsx` have no importer anywhere in `src/`.
`ai-scheduler-panel.tsx:87` was the only caller of `POST /api/search/assistant`, which therefore has
no in-app UI consumer.

**DEAD-4 — `POST /api/search` (legacy slot search).** No frontend posts to it
(`search-form.tsx:138` posts to `/api/search/range`) and the legacy `intersection` field has no
consumer. *Retire, or is it kept for external/bookmarked callers?*

**DEAD-5 — AI Scheduler one-shot parser.** `parseSchedulingRequestWithOpenAi`,
`normalizeAiSchedulerModelParse`, `buildAiSchedulerPrompt`, `openAiSchedulerJsonSchema`,
`resolveAiSchedulerFilters`, `resolveAiSchedulerTutorNames` in `src/lib/ai/scheduler.ts` have no
production caller; `/api/search/assistant` imports only types and calls the conversational solver.
The two paths also disagree on bare-weekday handling (clarify vs assume-recurring). Separately,
`aiSchedulerShadowModel()` / `OPENAI_SCHEDULER_SHADOW_MODEL` (`src/lib/ai/scheduler.ts:465-467`) has
no caller anywhere, including the model-comparison script.

**DEAD-6 — `src/lib/payroll/may-reconciliation.ts`** (legacy Aggregate/Long sheet parsers +
`buildMayPayrollReconciliationReport`) is imported only by its own test. *One-off migration aid,
dead code, or pending UI wiring?* Same question for `parsePayRateRows`
(`src/lib/payroll/rate-card.ts:98-160`), referenced solely by its test.

**DEAD-7 — Credit Control dead exports.** `FilterToolbar`
(`src/components/credit-control/filter-toolbar.tsx`), `buildWeeklyBuckets`,
`defaultCreditAdminOwnership`, `fallbackStudentKey`, `fallbackPackageKey`, `sortByEarliestDate`,
`diffDays`, `DASHBOARD_CACHE_TAG` (`config.ts:10`), `buildStudentQueue` (`analytics.ts:214`,
test-only), `isActionStateToday` (`analytics.ts:687`, a byte-identical duplicate of the one actually
used at `action-helpers.ts:52`), and the Sheets-era constants `SHEETS_IN_MEMORY_TTL_MS`,
`REQUIRED_COLUMNS`, `DASHBOARD_ACTION_STATE_SHEET`, `DASHBOARD_LOG_SHEET`,
`INACTIVE_STUDENTS_SHEET`.

**DEAD-8 — Credit Control inert snapshot-diff machinery.**
`buildSummaryDeltas`/`updateHistory`/`buildWeeklyBuckets`/`buildSnapshotForPersistence` in
`analytics.ts` can never produce a delta: `service.ts:88-93` always passes
`{lastSnapshot: null, history: []}` and discards `snapshotState`, so all deltas are `null` and
`statusChange` is always `"new"`. *Unfinished feature or dead code?*

**DEAD-9 — Sales Dashboard churn fields.** `churnList`, `churnedStudents`, and `eligibleStudents`
are computed on every payload build (`src/lib/sales-dashboard/analytics.ts:295-324`) from the frozen
import-time `churn_status` column and consumed by nothing. *Delete them and the persisted column
(`parser.ts:194-224`, `data.ts:501`), or keep the frozen value as an "as of last import" audit
trail?*

**DEAD-10 — `GET /api/sales-dashboard/import-runs`** and `listRecentSalesDashboardImportRuns` have
no caller; Source Manager renders import status from the landing payload and Data Health now covers
run history (`src/lib/data-health/dashboard.ts:669-690`).

**DEAD-11 — Classroom assignment orphans.** `classroomTimestampToWiseIso`
(`src/lib/classrooms/data.ts:359`, tests only), `deleteClassroomRowsForRun` / `deleteClassroomRuns`
(`data.ts:1922`, `:1928`, no callers), `isKevinPriorityTutor` / `PREFERRED_ROOMS` (`rooms.ts:170`,
`:150`, unreferenced). *Dropped-feature remnants — and were the delete helpers the intended
retention job (SCALE-4)?*

**DEAD-12 — `lineBacklogRecoverySyncRuns`** (`src/lib/db/schema.ts:2663-2684`) is declared and
migrated (`drizzle/0042_special_titania.sql`) but has zero consumers; the implementation
(`src/lib/line/backlog-recovery.ts`) returns counts without inserting a run row, so its single-flight
partial unique index is inert. *Reserved, or is run tracking missing?*

**DEAD-13 — `post_class_tutor_payout_sheets` is NOT dead; the claim that it is has spread into three
files.** (corrected and re-verified this revision) The JSDoc at `src/lib/db/schema.ts:3737-3741` says
the table is "Superseded by `postClassPayoutTutorNames` … nothing reads or writes it." That is false at
HEAD. Three callers touch it: `loadActivePayoutWorkbookRegistry` selects its `active` rows
(`src/lib/post-class-feedback/payout-repository.ts:1933-1943`) and is called by
`scripts/roll-payout-workbook-dates.ts:387`; `scripts/repoint-payout-workbook-formulas.ts:66-68`
selects the same rows; and `scripts/inventory-payout-workbooks.ts:295-309` deactivates and re-upserts
them inside a transaction. So it is a **second workbook registry**, maintained only by scripts, living
alongside `post_class_payout_tutor_names`.
The stale claim propagated from the schema comment into `docs/reference/database/index.md` and into the
earlier revision of this file; `docs/features/post-class-feedback.md:355` already flags the drift and
correctly declines to fix it there.
*The real question is not "can it be dropped" but: should the two registries be merged, and which one
owns workbook addressing? Fix the schema JSDoc first — it is the upstream source that keeps
re-infecting derived docs.*

**DEAD-14 — `selectModalityIssues` re-exported from `src/app/api/data-health/route.ts:6-12`** has
zero importers anywhere (the live payload duplicates the filter inline at `dashboard.ts:418-424`;
the test imports `../modality-counter`). *Dead, or an intentional acceptance-grep anchor?*

**DEAD-15 — `countLeaveRequestActionBadge`** (`src/lib/leave-requests/data.ts:677`) is exported with
zero callers; superseded by `listLeaveRequests({summaryOnly:true}).unreadActionCount`.

**DEAD-16 — Vocabulary and preview payloads in Tutor Profiles.** `STRENGTH_TAG_VOCABULARY`
(`src/lib/tutor-profile-vocabulary.ts:62-71`) and the exported `TeachingStyleTag` type (`:73`) are
referenced nowhere; the workspace's strength-tag field is free text. The import preview ships a
`vocabulary` payload (`src/lib/tutor-profile-import.ts:119-122`, `:882-885`) that the workspace never
reads.

**DEAD-17 — Enum members and fields with no writer.** `data_issue_type` includes `"sync"` which no
code path emits, and `data_issue_severity` is written but read by nothing (not the dashboard, not
Needs-Review routing — any non-empty `dataIssues` array triggers it).
`CompareSessionBlock.modalityConfidence` includes a `"medium"` member the rubric says is never
emitted (`src/lib/search/compare.ts:69`, `types.ts:130`). `ai_scheduler_feedback` supports a
`dismiss` action in the data layer and telemetry (`scheduler-data.ts:71`,
`correction-telemetry.ts:34`) and the metrics UI shows a Dismiss rate, but the route's discriminated
union accepts only accept/edit/reject (`feedback/route.ts:7-30`); the reply-dock UI has no dismiss
control either. `ImportSchema` accepts `mode: "source"` (`sales-dashboard/import/route.ts:16`) with
no branch reading it. Nothing in the leave-request sync sets workflow status `in_progress`; it and
`canceled_by_tutor` are reachable only via admin PATCH or a sheet keyword.

**DEAD-18 — `CompareTutor.leaves`** is serialized on every payload (`src/lib/search/compare.ts:314`)
but has zero client consumers. *Consume it (AMB-5) or document the field as inert.*

**DEAD-19 — Dead ternary.** `upsertSalesDashboardSource` at `src/lib/sales-dashboard/data.ts:198`:
`sourceMonth === currentBangkokMonthStart(now) ? "active" : "active"`.
*Was a non-current month meant to be created as `finalized`?*

**DEAD-20 — Unreachable branch.** `src/lib/leave-requests/sync.ts:119-120` (the actor read-scoped
fallback): with `requiresWrite = false` the identical predicate already ran at `:112-113`; with
`requiresWrite = true` the function returned `null` at `:117`.

**DEAD-21 — Modality location evidence may be dead in production.** `deriveModality` matches
`location` against the exact strings `online`/`virtual`/`onsite`
(`src/lib/normalization/modality.ts:44-52`) while real Wise locations are venue names — the same
unreliability AGENTS.md records as a known issue. *Remove the branch?*

**DEAD-22 — Unwired room-capacity endpoints.** `GET /api/room-capacity/month` and
`GET /api/room-capacity/forecast` are fully implemented, authenticated, and tested, but their only
callers are their own tests; the dashboard fetches only `/utilization`
(`room-capacity-dashboard.tsx:354`). *Pending UI or abandoned?*

**DEAD-23 — Unrendered metrics slices.** `GET /api/ai-scheduler/metrics` returns `scheduler`,
`line`, and `correction` slices; `SchedulerMetricsView` renders only `correction`
(`src/components/scheduler/metrics-view.tsx:61`, `:64`). Run-level latency p50/p95, solved/failed
counts, version distribution, and recent failures surface nowhere. Similarly
`GET /api/wise-activity/summary` returns `topActors`/`topClassrooms` that the workspace never
renders.

**DEAD-24 — Unwired filters and fields.** `sessionId` and `transactionId` are accepted server-side
(`src/lib/wise-activity/data.ts:106-107`) with no UI input. `WiseActivityEvent.participant`
(`src/lib/wise/types.ts:186`) is parsed into the type but never read by `normalizeWiseActivityEvent`.
The required `mode` field on `POST /api/compare` is validated (`route.ts:27`) but never read
(`:133`), and the only client hard-codes `"recurring"` (`src/hooks/use-compare.ts:140`);
`dayOfWeek`/`date` are honored (`:173-178`) but never sent.

**DEAD-25 — No in-app caller** for `POST /api/credit-control/sync` or
`POST /api/credit-control/admin-ownership`. *Operator-only endpoints, or dead surface?*

**DEAD-26 — `src/lib/auth/` contains no implementation** — only
`__tests__/signin-callback.test.ts`. The real code is in the root files `auth.ts`, `auth-edge.ts`,
`auth-access.ts`.

**DEAD-27 — Middleware for a namespace that does not exist.** `src/middleware.ts:41-51` has explicit
allow/deny branches for `/learning-plans` and `/api/learning-plans`, but no route handler exists
under `/api/learning-plans`. The deny appears forward-looking (it stops a future API namespace
inheriting the page-level pass). *Confirm intent.*

**DEAD-28 — Six more exported functions with zero callers.** (all re-verified by repo-wide grep over
`src/` and `scripts/`; each returns only its own definition, or definition + its own test)
`dataHealthSummaryIsStale` (`src/lib/data-health/dashboard.ts:1003`) — notable because the doc's
"Staleness thresholds" narrative presents it as live machinery;
`getYearSummary` (`src/lib/syllabus/topics-index.ts:6`);
`markProgressTestBookedManually` (`src/lib/progress-tests/booking.ts:364`) — it looks like the intended
companion to the `manual_required` gate that never got an endpoint;
`revokeStudentScheduleLink` (`src/lib/student-schedule/links.ts:172`) — no endpoint, no test, so a
wrongly-sent parent link has no revoke path;
`buildTaskSuggestionSeed` (`src/lib/competitor-intelligence/normalization.ts:227`) — both the AI and
deterministic paths build their own suggestion objects;
`budgetUsageRatio` (`src/lib/competitor-intelligence/budget.ts:32`) — its only importer is
`__tests__/budget.test.ts:3`, while production computes the ratio with a private `budgetRatio` in
`sync.ts:741`.

**DEAD-29 — Two unused escape hatches on the student-promotions apply path.**
`ApplyRunInput.allowBeforeTarget` is declared (`src/lib/student-promotions/data.ts:161`) and honoured
(`:2288`) but is never passed by any route, service, or test — so the July-1 date gate has a bypass
that nothing can reach. `createStudentPromotionDryRun`'s optional `targetDate` override is in the same
state. *Remove both, or wire one of them to an admin-only override?*

**DEAD-30 — Orphan admissions schema with no code path.** `admissions_cases` carries
`family_portal_open` (boolean, NOT NULL, default false), `family_portal_opened_at`, and
`family_portal_opened_by_email` (`src/lib/db/schema.ts:3997-3999`) under a comment describing family
access as "opt-in per case … an audited staff action". A repo-wide grep for
`familyPortalOpen`/`family_portal_open` outside `schema.ts` returns **zero** hits — no lib module, no
route, no component, no test. Separately `admissions_academic_records` is declared (`schema.ts:4408`)
with no `academics.ts` module, no route, and no UI, so GPA / A-level / IB entry has no write path at
all (`ls src/lib/admissions/` confirms no academics module).
*Two consequences: (a) is this more collateral from the unmerged `codex/admissions-parity-hardening`
branch (see the migration question in §4), and (b) if the opt-in flag is inert, family access is
currently **not** gated per case — which is exactly where SEC-2's archived-case question would want to
be enforced.*

> **Recorded as NOT dead** (a claim that reached this pass and did not survive verification):
> `uploadCsvToDrive` (`src/lib/post-class-feedback/drive.ts:38`) was reported as having only a script
> caller. It has a production caller — `src/lib/post-class-feedback/payout-run.ts:13` imports it and
> `:916` wires it as the default `upload` dependency. Drive is a live egress path.

---

## 4. Data model, schema & migrations

**DATA-1 — Timezone storage semantics are a hard undocumented invariant.**
`future_session_blocks.start_time`/`end_time` are declared `timestamptz` but the orchestrator
persists the output of `toLocalTime()` (`src/lib/sync/orchestrator.ts:289-290`) — Bangkok
wall-clock encoded as if UTC. All current readers apply the same convention, but any SQL comparing
these columns to `now()` is 7 hours off.
*Document as a hard invariant, or migrate to true instants?*

**DATA-2 — `canonicalKey` is not rename-stable for unresolved teachers.** `resolveIdentities` sets
`canonicalKey = displayName`, which falls back through `canonicalKey ?? nickname ?? full Wise display
name` (`src/lib/normalization/identity.ts:129-136`). For unresolved teachers the cross-snapshot
anchor is therefore the full Wise display name, which changes on a Wise rename — breaking
`past_session_blocks.group_canonical_key` and tutor-profile joins.

**DATA-3 — Schema/migration drift on the proposals overlap guard.** The three CHECK constraints and
two `EXCLUDE USING gist` constraints on `proposal_items` exist only in
`drizzle/0006_admin_proposal_holds.sql`; the Drizzle definition (`src/lib/db/schema.ts:2312-2340`)
declares indexes only. A regenerate-from-schema would silently drop the app's only race-condition
backstop, which `src/lib/proposals/data.ts:68-83` depends on. The two exclusion constraints are also
scope-partitioned (`WHERE scope='recurring'` / `'one_time'`), so the mixed recurring-vs-one-time
conflict that app-level `proposalSlotsOverlap` catches has **no DB backstop under concurrency**.
*Is the drift known and accepted, and is the mixed-scope gap deliberate?*

**DATA-4 — 29 Drizzle meta snapshots are missing.** (re-verified) 65 `.sql` migrations vs 36
`drizzle/meta/*_snapshot.json`. Missing: 0006, 0009-0013, 0022-0037, 0048-0049, 0057-0061. They are
not gitignored. *Recoverable from history, or declare the current 0064 snapshot the new baseline?*

**DATA-5 — Free-text columns with closed value sets.** `credit_control_follow_up_state.status` and
`credit_control_inactive_students.source`; `sales_dashboard_projection_sources.status`
(`schema.ts:725`, plain `text`) while `sales_dashboard_sources.status` uses a pgEnum (`:152-158`);
`leave_request_sync_runs.trigger_type` and `leave_request_activity_logs.action_type`/`status`;
`line_threads.status`, `line_wise_action_logs.status`, `line_oa_resolver_runs.status`,
`line_oa_resolver_rows.status`; `line_group_settings.audience` (read defensively as "family" else
"staff", `src/lib/line/schedule-bot-group.ts:171-181`); `room_capacity_forecast_drivers.scenario` and
`room_capacity_demand_mix.mode` (unrecognized `mode` is coerced to `"onsite"` at read time,
`src/lib/room-capacity/data.ts:330` — a quiet fallback rather than the project's fail-closed
posture). *Promote to pgEnum, or record the looseness as deliberate?*

**DATA-6 — A type union that no longer matches the data.**
`credit_control_follow_up_log.actionType` is typed `"set" | "clear" | "bulk-set" | "bulk-clear" |
"auto-clear"` (`db.ts:41`), but the churn path writes `auto-remove` and `auto-reactivate` through a
raw Drizzle insert that bypasses it (`sync.ts:593-601`, `:611-619`); the UI narrows it further to
four values (`student-detail.tsx:24`). *Widen the union.*

**DATA-7 — Missing constraints and indexes.** `credit_control_snapshots.active` has no partial
unique index (unlike `payroll_rate_card_versions.active`); single-activeness rests entirely on a
procedural table-wide UPDATE (`sync.ts:700-702`). `ai_scheduler_feedback` declares an FK on
`conversation_id` with no index on it, while its three sibling FK columns are indexed.
`rcfd_scenario_month_idx` is a plain index, not unique, so duplicate driver rows per
run/scenario/month are possible.

**DATA-8 — `payroll_sync_runs` single-flight is global, not per month.** The partial unique index is
on `status` alone (`schema.ts:1773-1775`), so syncing one payroll month returns HTTP 409 for every
other month. *Intended?*

**DATA-9 — Unvalidated soft references.** `payroll_adjustments.tutor_canonical_key` is only trimmed
(`src/lib/payroll/data.ts:641`), so a typo produces an orphan adjustment that still counts toward
`summary.manualAdjustmentHours/Amount`. `line_contact_student_links.sourceRunId` /
`validationAssignedRunId` are plain `uuid` with no `.references()` although `sourceRunId` holds a
`line_oa_resolver_runs.id` (`src/lib/line/oa-resolver.ts:921-922`, `:941-942`). `classroom_rooms` has
no FK to `classroom_assignment_rows` — rooms are matched by free-text name, so renaming a room
orphans historical rows. `leave_requests.lastSyncRunId` references `leave_request_sync_runs.id` with
no declared `onDelete`. `google_oauth_tokens` ↔ `admin_users` and `tutor_aliases` ↔
`tutor_identity_groups` are string-keyed only.

**DATA-10 — `classroom_rooms` is a projection, not an editable catalog.**
`ensureDefaultClassroomRooms()` overwrites drifted `hasTv`/`capacity`/`category`/`active`/`sortOrder`
on every read path (`src/lib/classrooms/data.ts:456-478`), so any DB-side edit to a default room is
silently reverted. *Was an admin-editable catalog intended?*

**DATA-11 — Credit Control's sheet shim.** `loadCreditControlSources`
(`src/lib/credit-control/db.ts:88`) rebuilds Postgres rows into synthetic Google-Sheets-shaped
tables, including an always-empty `RemainingCredits` sheet (`:191`) and an always-blank
`Should_Credit` column (`:122-134`) — so the "fallback" pending-deduction branch always runs and its
flag always fires. *Is the shim intentional, and where should a real `Should_Credit` come from?*

**DATA-12 — `student_schedule_links`** (`schema.ts:4627-4648`) is the FK target of
`line_group_schedule_sends.linkId` but appears in no `erd-*.md`. *Which domain page owns it?*

**DATA-13 — `cron_alert_state`** (`schema.ts:505`) is load-bearing for watchdog alert dedup but is
documented in no ERD. *Which page owns it?*

**DATA-14 — `room_utilization_sessions` ownership.** AGENTS.md groups it under Core while
attributing ownership to Room Capacity, which has its own ERD. *Pick a home so it does not fall
through the cracks.*

**DATA-15 — `tutor_contacts` is filed under Tutor Profiles but no tutor-profiles code path touches
it** (it is used by classrooms, post-class feedback, learning plans, progress tests, and
leave-request matching). *Re-assign ownership in the reference docs.* Related:
`tutorContacts.primaryEmail` is documented as a post-class delivery override with existing consumers
still on `onsiteEmail`/`onlineEmail`, and the classroom seed insert
(`src/lib/classrooms/schedule-email.ts:180-190`) never populates it — so seeded tutors always resolve
via the `wise_fallback` branch, and a two-record disagreement yields source `conflict` and no email.
*Is eventual migration to `primaryEmail` intended, or permanent coexistence, and is there an admin UI
to populate it for conflict cases?*

**DATA-16 — Nullable-but-cascading audit rows.** `leave_request_activity_logs.leaveRequestId` is
nullable yet declared `ON DELETE CASCADE` (`schema.ts:2204`); every current writer supplies a parent
id. *Are orphan audit rows an intended future case?*

**DATA-17 — Null-source import runs.** Both `*_import_runs.sourceId` columns are nullable and the
single-running partial indexes explicitly exclude `source_id IS NULL` (`schema.ts:666-668`,
`:758-760`). *Are null-source runs ever written, or is the nullability vestigial?*

---

## 5. Time, timezone & date semantics

**TZ-1 — The runtime timezone is not pinned anywhere and cannot be determined from the repo.**
Verified absent from `vercel.json` (which contains only `crons`), `next.config.ts` (only
`cacheComponents`), `src/lib/env.ts`, and `.env.example`; `vitest.config.ts:4` pins tests only. At
least five code paths silently depend on it: `weekdayForIsoDate` (DEF-4),
`src/lib/search/engine.ts:68` (one-time weekday), `engine.ts:269` and `:279-283` (recurring-leave
minute math), `engine.ts:300-304` (one-time leave window), and `getTodayDate()`/`parseDate` in Credit
Control projections (`helpers.ts:40-97`), which compute a "today" boundary while timestamps render in
Asia/Bangkok.
*Someone with Vercel access must confirm the process timezone; then decide whether these should be
explicitly Bangkok-anchored.*

**TZ-2 — UTC calendar-day comparison in one-time search.** `isBlockedOneTime` and
`getBlockingSessions` match one-time sessions by `toISOString().slice(0,10)` on both sides
(`src/lib/search/engine.ts:179-187`, `:217-219`) while `startTime` was already shifted into Bangkok
by `toLocalTime` (`src/lib/normalization/sessions.ts:66-67`). For the 15:00–20:00 ICT window this
coincides, but sessions before 07:00 ICT fall on the previous UTC date.
*Deliberate accepted narrowing, or an off-by-one?*

**TZ-3 — Multiple weekday derivations coexist.** `engine.ts:68` uses runtime-local
`new Date(date).getDay()`; `range-search.ts:142` uses the Bangkok-anchored `weekdayForIsoDate`; and
`compare/route.ts:177` plus `discover/route.ts:71` both use `new Date(dateString).getDay()` (UTC
midnight parsed, weekday read in the server zone). *Normalize on one helper.*

**TZ-4 — Diff-hook clock mixing.** `past-sessions-diff-hook.ts:114`, `:119` compares
`prior.startTime` (Bangkok-wall-clock-as-local-epoch) against a raw `new Date()`. On a UTC host a
session becomes eligible for capture ~7h after it actually started. Nothing is lost (a later cron
tick captures it). *Is the deferral intended, or should it be `toLocalTime(new Date())`?*

**TZ-5 — Payout sheets are UTC** while everything else is Bangkok — recorded in project memory but
in no doc. *Where should that invariant live?*

**TZ-6 — Two Bangkok timezone constants coexist.** `TIMEZONE`
(`src/lib/normalization/timezone.ts:3`) and `BANGKOK_TIME_ZONE` (`src/lib/bangkok-time.ts:1`), both
`"Asia/Bangkok"`. Newer modules import the latter; the normalization/search lineage uses the former.
*Consolidate.*

**TZ-7 — Cron schedules are UTC; the Bangkok wall-clock intent is implicit.** Thailand has no DST, so
`45 23` UTC = 06:45 Bangkok and `0,10,20,30 0` UTC = 07:00–07:30 Bangkok hold year-round. *Confirm
ops expects those exact wall-clock times.*

---

## 6. Operations: crons, deployment, runbooks

**OPS-1 — `vercel.json` (15) and the cron registry (21) will always disagree, by design.**
(re-verified) Six registry jobs carry `schedule: null` + `manualOnly: true` (`room_utilization`,
`line_backlog_recovery`, and four post-class-feedback jobs) and are fired from `/data-health`.
*Confirm `src/lib/data-health/cron-registry.ts` is the intended single source of truth for ops
runbooks rather than `vercel.json`* — this also resolves the older "`sync-room-utilization` schedule
got dropped" question: it is deliberate.

**OPS-2 — `/api/internal/sync-room-utilization` could not be scheduled as written.** It exports
`POST` only (`route.ts:26`) while Vercel Cron invokes via `GET`; the registry is the only
`routeMethod: "POST"` entry (`cron-registry.ts:343-357`). *If a cadence is wanted it needs a `GET`
export plus a stagger slot; otherwise confirm on-demand refresh from the Room Capacity dashboard
(`room-capacity-dashboard.tsx:375`) and `scripts/sync-room-utilization.ts` is the contract.* The
Vercel-invokes-via-GET claim is asserted in `docs/reference/crons.md:331` but is not verifiable from
this repo.

**OPS-3 — Four parked post-class jobs.** Admin digest, day-after reminder, deadline reminder, and
payout accrual are registered but unscheduled. Payout accrual is the only path that closes a
financial window, and the watchdog alerts on its staleness without anything running it.
*Ship or retire.*

**OPS-4 — `student_promotions_july_1` will re-fire in June 2027.** Its schedule is `5 17 30 6 *`, it
is `dangerous: true`, and it applies verified Wise grade/course writes. It is also listed as a
`criticalRoute` in `docs/reference/production-route-surface.json`, so removing it requires a manifest
update. Separately (re-verified) it is the **only** cron not wrapped in `withCronInvocationAudit`, so
it writes no `cron_invocations` evidence; `pickJobRuns` returns no evidence for it
(`dashboard.ts:274-289`), its status resolves to `unknown`, and `isAlertableStatus` treats `unknown`
as alertable (`cron-watchdog.ts:52`).
*Does the watchdog email admins about it on an open episode? Intended, or should it be excluded
outside its date window?*

**OPS-5 — The cron watchdog is itself unmonitored.** `sweepCronJobs` excludes `WATCHDOG_JOB_KEY`
(`src/lib/internal/cron-watchdog.ts:160`) and nothing else checks it, so a silently dead watchdog is
indistinguishable from a healthy system. *An external heartbeat is the obvious gap.*

**OPS-6 — `post_class_payout_window` is alert-only.** The watchdog synthesizes it at sweep time
(`cron-watchdog.ts:84-116`) so it can email alerts but never appears on `/data-health`. *By design?*

**OPS-7 — Manual-only jobs are never alerted on when they fail, not just when they are stale.** The
registry sets `lateAfterMinutes: 0` + `manualOnly: true` and the watchdog filters manual-only jobs
(`cron-watchdog.ts:160`).

**OPS-8 — Run-evidence fallback is wider than its own comment claims.**
`src/lib/data-health/dashboard.ts:317-319` says only `room_utilization` reaches the fallback; five or
six registry keys do, two of them scheduled (`post_class_feedback_backfill`,
`admissions_notifications`) — so a stale `room_utilization_sessions` row can serve as their inferred
proof. *Explicit no-evidence branches, or is the fallback intended?*

**OPS-9 — Domains invisible to Data Health.** `payroll_sync_runs` is not among the 14 run sources
`fetchAllRuns` reads (`dashboard.ts:752-806`) and has no registry entry, so payroll can never be
reported late or alerted on; its latest run surfaces only inside the payroll payload
(`src/lib/payroll/data.ts:538-543`). Progress-test run tables feed cron health but have no freshness
card and no `recentRuns` entries. *Intentional (manual-only features) or gaps? And is a unified
cross-pipeline health view wanted?*

**OPS-10 — Blocked promotions are invisible.** When the promotion gate blocks (≥50% unresolved
identity, `orchestrator.ts:472-476`) the run still records `status = "success"`, so `staleAgeMs` stays
near zero, neither the 2-hour banner nor the home freshness tile fires, and the index keeps serving
the stale snapshot. *Measure staleness from the last run with a non-null `promotedSnapshotId`
instead?*

**OPS-11 — Six internal routes duplicate the REL-07 cron-secret check.** (re-verified) `sync-wise`,
`sync-sales-dashboard`, `sync-credit-control`, `sync-room-utilization`, `sync-competitor-intelligence`,
and `student-promotions/july-1` each declare a local `hasValidCronSecret` instead of importing
`src/lib/internal/cron-auth.ts`. Behaviour is identical today; `sync-wise` has a stated reason
(session-auth fallback). This is security-critical code duplicated six ways with no test binding the
copies together.

**OPS-12 — Trigger-source mislabelling.** `POST /api/internal/sync-leave-requests` hard-codes
`triggerType: "cron"` (`route.ts:17`) so operator reruns are persisted as cron-triggered. An
admin-authenticated `POST /api/internal/sync-sales-dashboard` records `triggerSource: "admin"` on the
`cron_invocations` row but still passes `triggerType: "cron"` to both import calls (`route.ts:54`,
`:59`).

**OPS-13 — Error detail is discarded for two cron jobs.** `sync-post-class-feedback` and
`post-class-feedback-backfill` return generic 500 strings, unlike `sync-leave-requests` and
`sync-competitor-intelligence` which surface the message — making `cron_invocations.errorSummary`
less useful for exactly those two.

**OPS-14 — Stale-running cutoff vs the function ceiling.** `STALE_RUNNING_SYNC_MS` is 20 minutes
(`src/lib/sync/run-wise-sync.ts:10`) while `maxDuration = 800s` (~13.3 min)
(`sync-wise/route.ts:7`). A sync cannot legitimately outlive the ceiling, so the cutoff is a pure
safety net — but a wedged `running` row blocks ~1.5 cron cycles before cleanup.

**OPS-15 — Registry cadence label vs cron expression.** `competitor_intelligence` is labelled "Weekly
Monday 01:25 Bangkok" with `expectedBangkokWeekday: 1` (`cron-registry.ts:98`) while `vercel.json:13`
schedules `25 18 * * 0`. They agree after conversion, but the 0-vs-1 mismatch is easy to misread.
*Add a comment.*

**OPS-16 — Morning-automation timing budget.** `vercel.json` runs morning automation at 06:45 Bangkok
and the admin digest 07:00–07:30, with the final-retry cutoff at exactly 07:30
(`src/lib/classrooms/admin-schedule-email.ts:19`). *Is ~45 minutes the intended margin when a Wise
sync must be triggered and waited on?* Related: `/api/internal/sync-post-class-feedback` runs at
`13,43` — two minutes ahead of leave requests at `15,45`. *Is a 2-minute gap the intended stagger for
two Google/Wise-adjacent I/O jobs?*

**OPS-17 — No automated production migration.** There is no CI workflow or deploy hook invoking
`db:migrate`, and `deploy:prod` does not. *Confirm it is always a manual operator step.*

**OPS-18 — The Vercel-linked worktree is not recorded in code.** This worktree has no `.vercel/`
directory, so `npm run deploy:prod` here would prompt to link, or non-interactively create a stray
project. The hazard is documented in CLAUDE.md but the canonical linked worktree path lives in no
checked-in script or config.

**OPS-19 — `docs/reference/production-route-surface.json` pins a specific `productionDeployment` id
and output count.** The guard script only reads it via `previousManifest` fallbacks and never asserts
on it. *Is that block meant to be refreshed each release, or is it a one-time record?* It was also
not verified whether the manifest is in sync with the 178 route files at HEAD — if it has drifted,
`verify:release` would be failing.

**OPS-20 — Apps Script relay de-duplication is unverifiable from this repo.** The idempotency key is
constructed (`schedule-email.ts:637-650`) and transmitted (`:613-622`), but no relay source, contract
test, or documented response semantics exist here. If the relay ignores the key, a retry of identical
content double-sends.

**OPS-21 — Email failover lineage is not persisted.** `classroom_schedule_email_runs` has no column
linking a backup run to the primary it replaced (`schema.ts:2018-2032`), and recipients do not record
which sender delivered them (`:2034-2051`) — `fromEmailRunId` lives only in the HTTP response
(`schedule-email.ts:1015-1023`). Any audit of a quota-exhaustion event must infer it from two runs
sharing an `assignmentRunId`. *Add `sourceEmailRunId` and a per-recipient `senderKey`?*

**OPS-22 — The forecast model has no operational cadence.** `room_capacity_model_runs` rows arrive
only via the local CLI importer `scripts/import-room-capacity-model.ts` reading an on-disk projection
JSON plus sibling sales workbooks. There is no HTTP import route and no scheduled refresh, so the
forecast surface can serve an arbitrarily old `created_at DESC` run with no staleness signal.
*Who owns re-importing, and how often?*

**OPS-23 — No runtime path re-imports a payroll rate card.** `payroll_rate_card_versions` and
`payroll_rate_rules` are seeded only by `drizzle/0037_payroll_rate_cards.sql`. *Is a new card meant to
arrive via another migration, or is an admin import path still to be built?*

**OPS-24 — Cold-index build cost was never measured.** `SearchIndex` is per serverless instance
(`globalThis`-anchored), so a cold instance pays a full `buildIndex()` — one snapshot of parallel
SELECTs plus aggregation — on its first request. Instance recycle frequency and cold-build latency
versus the documented "< 400ms warm" target are unverified.

**OPS-25 — A brand-new environment errors on every index-backed route.** `buildIndex()` throws "No
active snapshot found" (`src/lib/search/index.ts:150-152`) and `ensureIndex` only swallows the
no-active case when a cached index already exists (`:384-386`). *Do deployment runbooks guarantee a
promoted snapshot before traffic?*

**OPS-26 — No first-class re-promote or rollback path.** Rollback is implicit (re-run the sync from
the last good snapshot), and `pruneOldSnapshots` hard-deletes everything beyond the most recent 30.
*Should a supported manual-rollback path exist, and what is the approved DB-level procedure?*

---

## 7. Auth, access control & security surface

**SEC-1 — `middleware.ts` carve-outs are accumulating inside a security-critical function.**
`isPathAllowed()` (`src/middleware.ts:29-60`) now has four surfaces that bypass the coarse
`allowedPages` prefix match because they re-derive access from Postgres (`/api/home/summary`,
post-class-feedback, a learning-plans page-allowed-but-API-denied split) plus one explicit deny.
Correct today, but growing. *Should the JWT `allowedPages` claim be replaced by a uniform per-request
capability lookup?*

**SEC-2 — The page→API namespace mapping is wrong for at least two features.** `isPathAllowed`
derives the API namespace as `/api${page}` (`src/middleware.ts:53-60`). So an allowed page of
`/line-review` grants `/api/line-review` (which does not exist) and 403s every `/api/line/**` call; an
allowed page of `/scheduler` grants `/api/scheduler` but not `/api/ai-scheduler/*`. Similarly
`/api/proposals*` is unreachable for any admin with a non-null `allowed_pages`, even one granted
`/search`, and a user restricted to `/class-assignments` is 403'd on `/api/classrooms/rooms` which that
UI needs. *Is any admin actually restricted this way today, and should the mapping be explicit rather
than derived?*

**SEC-3 — Nine middleware bypass patterns, three of them notable.** `src/middleware.ts:4-20`
allowlists nine patterns (the pass brief said three). `GET /api/classrooms/floor-plan-map` is fully
unauthenticated with no in-handler check at all and renders SVG from a user-supplied `rooms` param
(it is used as the schedule-email `mapImageUrl`, which plausibly must be fetchable by an email
client); the two OA-resolver token endpoints send `Access-Control-Allow-Origin: *` with the bearer
token as the only protection. `POST /api/search/assistant` is allowlisted as public but the handler
returns 401 without a session (`route.ts:136-139`).
*Do these warrant a security review, and is `/api/search/assistant` meant to be public?*

**SEC-4 — All of `/api/internal/*` is exempted from the session gate** (`middleware.ts:18`), so
`CRON_SECRET` is the only protection. Six internal routes additionally accept a plain Auth.js session
on their POST variant (`sync-wise`, `sync-credit-control`, `sync-sales-dashboard`,
`sync-progress-tests`, `sync-competitor-intelligence`, `sync-room-utilization`) with no capability
check beyond "is signed in" — for jobs that promote snapshots. *Confirm the intended blast radius.*

**SEC-5 — JWT claims are frozen until re-login.** `role` and `allowedPages` resolve only when `user`
is present (`src/lib/auth.ts:58-67`), so promoting a teacher or revoking an `admin_users` row takes
effect only after sign-out; only Layer-4 feature guards read live state. *Shorter session max-age, or
a claim-refresh path?*

**SEC-6 — `admin_users` has no `active` flag**, unlike `admissions_counselors` and `tutor_contacts`.
Deactivation means deleting the row, which also silently removes the person from cron-watchdog alerts,
admin schedule emails, and LINE reviewer pools. *Add a soft-disable column?*

**SEC-7 — The "9 allowlisted admins" figure is unverifiable from the repo.** Full admins come only
from `SEED_ADMIN_EMAILS` (`src/lib/db/seed.ts:31`), which is in neither `src/lib/env.ts` nor
`.env.example`, and no migration seeds `admin_users`. `seed.ts:46-48` additionally provisions
page-restricted users (e.g. one scoped to `/progress-tests`) who are not in the AGENTS.md list.
*Cite a live `SELECT count(*) FROM admin_users`, or stop citing a number* — and *add
`SEED_ADMIN_EMAILS` to `.env.example`*, since a fresh deploy without it seeds an empty allowlist.

**SEC-8 — OAuth scope divergence.** Node requests `spreadsheets` + `drive.file`
(`src/lib/auth.ts:39`); edge requests `spreadsheets.readonly` (`src/lib/auth-edge.ts:11`). Only the
Node instance runs the grant, so the edge scope is inert. *Deliberate, or drift from the
read-to-write escalation?*

**SEC-9 — Login denial copy predates the role model.** "Access denied. Your email is not on the admin
allowlist." (`src/app/login/page.tsx:27`) is now wrong for counselor/teacher/student/parent.

**SEC-10 — Weak-by-comparison guards.** `/api/student-promotions/*` gates only on
`requireStudentPromotionSession` (email presence, `src/lib/student-promotions/api.ts:9-15`) plus the
middleware filter — nine Wise-mutating endpoints behind an email-only guard.
`GET /api/data-health` gates on `auth()` alone (`route.ts:15-18`) with no admin-capability check.
Every payroll route gates on `auth()` alone with no role check, and
`DELETE /api/payroll/adjustments/[adjustmentId]` is unscoped by month and records no deleting actor.
LINE validation-lead gating is uneven: the summary endpoint silently returns empty to non-leads
(`link-validation.ts:384-387`) while list and assign apply no lead gate at all.
*Confirm the audit gap is accepted.*

**SEC-11 — `POST /api/credit-control/admin-ownership` accepts the pseudo-key `"all"`.** It validates
`adminKey` against `getAdminViewOptions()` (`route.ts:18`, `config.ts:110-116`), which includes the
"all" filter option; the assignment persists and renders back as the literal name "all"
(`db.ts:300-309`). *Validate against `ADMIN_OWNER_REGISTRY` + `unassigned` instead.* Related:
`ADMIN_OWNER_REGISTRY` (6 names, `config.ts:28-35`) is a second admin roster separate from
`admin_users`. *Should ownership derive from one source of truth?* Also, `admin-ownership` and
`DELETE /api/credit-control/inactive` do not verify the `studentKey` exists in the current payload,
unlike their siblings which 404 unknown students.

**SEC-12 — `POST .../oa-resolver/runs/[runId]/commit` swallows malformed JSON and treats it as `{}`**
(`route.ts:23-28`), turning a body typo into a full-run commit instead of a 400.

**SEC-13 — Two overlapping link mutators with different guards.**
`PATCH /api/line/contacts/[contactId]/student-links` (`student-links.ts:693-722`) has no `isPhantom`
filter and no IDENT-06 recompute; `PATCH /api/line/contacts/link-validation/[linkId]`
(`link-validation.ts:715-796`) has both. *Is the contact-scoped path meant to bypass those
invariants?*

**SEC-14 — Nothing in the codebase sets `is_phantom = true`.** (re-verified — grep returns no
writer). The quarantine population was applied out of band, so it is not reproducible from a clean
database, and the flag reads as machinery that does not exist.
*Make it a migration or a documented runbook step.*

**SEC-15 — Personal data hardcoded in checked-in source.** `RAW_TUTOR_CONTACTS`
(`src/lib/classrooms/tutor-contacts.ts:24`) plus `PREFERRED_BY_TUTOR` / `TV_REQUIRED_TUTORS`
(`rooms.ts:100`, `:89`) hardcode ~140 personal emails/phones and named-individual rule branches. Three
env fallbacks hardcode individual gmail addresses: `SCHEDULE_EMAIL_REPLY_TO`
(`schedule-email.ts:607`), `ADMISSIONS_EMAIL_REPLY_TO` (`notifications.ts:49`), and
`LINE_VALIDATION_LEAD_EMAILS` (`link-validation.ts:122-125`); `LEAVE_REQUESTS_SPREADSHEET_ID`
hardcodes a literal Sheet id (`config.ts:1`). *Move to DB config / required env vars?*

**SEC-17 — Being a tutor silently revokes a parent's or student's admissions access.**
(re-verified) `resolveUserAccess` (`src/lib/auth-access.ts:56-85`) resolves exactly one role in a fixed
order: `admin` → `counselor` → `teacher` → `student`/`parent`. The teacher branch returns
`allowedPages: [PROGRESS_TESTS_ROUTE]` and returns early (`:75-78`), so an email that is both an active
tutor contact **and** an admissions student or parent member gets `/progress-tests` and loses
`/admissions` entirely — a realistic case for a staff member whose own child is in the programme.
(Counselors are unaffected: that branch runs first.)
*Is single-role-wins deliberate, or should `allowedPages` accumulate across the roles a person actually
holds?*

**SEC-16 — The sales-dashboard scope guard hardcodes a collaborator handle**
(`aoengnatchasmith-spec`) in three places (`.claude/hooks/sales-dashboard-guard.mjs:6`,
`scripts/check-sales-dashboard-scope.mjs:3`, `.claude/README.md:3`). *Is that collaborator still
active, and should the guard be configurable or retired?* Also: *is the sales-dashboard-scope GitHub
Actions job configured as a required status check on `main`?* Branch protection is not repo state, so
the docs can only say the gate runs, not that it blocks.

---

## 8. Environment & configuration

**ENV-1 — See DEF-2.** The env schema is dead code.

**ENV-2 — The documented "9 required env vars" is wrong in three directions.** The literal schema
(`src/lib/env.ts:3-23`, re-verified) is 7 hard-required + 2 defaulted (`WISE_NAMESPACE`,
`WISE_INSTITUTE_ID`) + 6 optional = 15. README.md:125-128, AGENTS.md, and CLAUDE.md all say "9
required (+3 optional LINE)". The three `LEAVE_REQUESTS_*` vars listed in the AGENTS.md table are
*not* in the schema at all — they are read directly in `src/lib/leave-requests/config.ts:1-5`.
*Reword, and decide whether the two `.default()` WISE vars count as required in deployment
checklists.*

**ENV-3 — The schema covers 15 of roughly 56–58 live env keys.** Absent: all `OPENAI_*`,
`POST_CLASS_PAYOUT_*`, `SCHEDULE_EMAIL_*` (including both Apps Script secrets), `LEAVE_REQUESTS_*`,
all three `WISE_SESSION_*_VERIFIED` write kill-switches, `APIFY_*`, `DATAFORSEO_*`, `COMPETITOR_*`,
`RESEND_API_KEY`, `ADMISSIONS_EMAIL_*`, `SEED_ADMIN_EMAILS`, `ENABLE_AI_SCHEDULER`,
`NEXT_PUBLIC_APP_URL`. Roughly 20 of these are in neither `env.ts` nor `.env.example`, and
`.env.example` documents some vars the schema does not.
*Is per-call-site `process.env` the intended pattern, or should the schema and `.env.example` become
the complete operator-facing inventory? Pick one to canonicalize.*

**ENV-4 — Three different failure modes for the same missing Wise credentials.** `createWiseClient()`
(`src/lib/wise/client.ts:161-162`) uses non-null assertions and fails at request time;
`createWiseClientFromEnv()` (`src/lib/classrooms/data.ts:1155-1156`) and `createPromotionWiseClient()`
(`src/lib/student-promotions/data.ts:302-304`) throw immediately;
`wise-activity/reconciliation.ts:770`, `:797` returns a typed error string. *Converge.* Relatedly, the
`WISE_INSTITUTE_ID` default literal is re-applied at ~12 call sites but omitted at
`src/lib/room-capacity/utilization.ts:433`, making the var effectively required for that one path.

**ENV-5 — `STUDENT_SCHEDULE_LINK_TTL_DAYS` validation is bypassed.** Declared
`z.coerce.number().int().positive()` (`src/lib/env.ts:21`) but all three consumers use
`Number(x) || DEFAULT_LINK_TTL_DAYS`, so `0` and non-numeric values silently become 30.

**ENV-6 — `APP_BASE_URL` is two unrelated things.** An env var (read by the schedule bot and the
student-schedule link route) and an exported constant of the same name in
`src/lib/leave-requests/config.ts:17` that sources from `NEXT_PUBLIC_APP_URL`. *Rename one.*

**ENV-7 — `WISE_SESSION_OPERATIONS_VERIFIED` is captured at module load** in
`src/lib/line/operational.ts:21`, so toggling it there requires a redeploy — unlike
`wiseSessionOperationsVerified()` (`src/lib/wise/operations.ts:10-12`) which re-reads per call.
*Intentional?* And *what is the intended operational matrix for combining it with
`ENABLE_LINE_SCHEDULER`?*

**ENV-8 — `ENABLE_LINE_SCHEDULER` is opt-out, not opt-in.** It disables only when set to the exact
string `"false"` (`src/lib/line/client.ts:19-20`) and gates only the webhook (DEF-6).

**ENV-9 — `SALES_DASHBOARD_CONNECTED_EMAIL` now has exactly one consumer** — the leave-requests
fallback at `src/lib/leave-requests/config.ts:13`. The Sales Dashboard itself drives Sheets access off
the signed-in session email. *The name is misleading; is it still meant as a sales-dashboard setting?*

**ENV-10 — Undeclared but load-bearing dependencies.** `server-only` is imported by 17 modules but is
absent from `package.json`, `package-lock.json`, and `node_modules` root — it resolves only because
Next aliases it to `next/dist/compiled/server-only` (`scripts/stubs/server-only.ts` documents this
deliberately). `tsx` is invoked by 14 npm scripts but is not a declared dependency. `package.json` has
no `engines` field and there is no `.nvmrc`, so the Node version is unpinned for local dev and the
Vercel build. `xlsx` ^0.18.5 now has exactly one consumer (`src/lib/tutor-profile-import.ts`) and is a
removal candidate.

---

## 9. Ambiguous behaviour & product rules

**AMB-1 — Fail-closed rule vs the non-blocking status allowlist.** AGENTS.md's non-negotiable rule
says only cancelled sessions must not block, but `NON_BLOCKING_STATUSES`
(`src/lib/normalization/sessions.ts:34-40`) also treats `COMPLETED`, `MISSED`, and `NO_SHOW` as
non-blocking (presumably past-state sessions appearing in a FUTURE feed).
*Reconcile the stated rule and the allowlist in one place.* Relatedly, room utilization uses the
**inverse** convention — it excludes unknown Wise status (fail-open) — which is defensible for a
reporting surface but is the opposite of the availability pipeline. *Confirm the divergence.*

**AMB-2 — Silent session drops contradict the fail-closed posture.** Sessions whose teacher cannot be
resolved (`sessions.ts:64`) or whose teacher has no identity group (`orchestrator.ts:280`) are
discarded with no `data_issue` emitted. *Should they be counted?*

**AMB-3 — Modality filtering excludes rather than routes to Needs Review.** `supportedModes` drives an
outright exclusion at `src/lib/search/engine.ts:93-97`. Worse, the group-level check
(`supportedModes.includes(slot.mode)`) and the window-level check (`engine.ts:104`:
`w.modality !== "both" && w.modality !== slot.mode`) are different predicates on different fields — so
a group with *unresolved* modality (empty `supportedModes`) is never skipped at group level but can
still be silently eliminated at window level, turning a would-be Needs Review row into an omission.
*Is that intended under the fail-closed rule?*

**AMB-4 — Data-issue attachment in `buildIndex` is heuristic.** Issues are matched by
`entityId === canonicalKey || entityId === group.id || entityName === displayName`
(`src/lib/search/index.ts:232-247`), so two identity groups sharing a display name each inherit the
other's issues and both land in Needs Review. *Acceptable fail-closed behaviour, or tighten?*

**AMB-5 — Shared free slots ignore leaves.** `findSharedFreeSlots`
(`src/lib/search/compare.ts:361-405`) ignores dated leaves while `/api/compare/discover` explicitly
rejects leave-overlapping slots (`route.ts:113-121`) — so a tutor on approved leave can appear inside
an "All free" band. The week view's green free-gap tint has the same blindness plus it ignores the
window's `modality` (`computeFreeGaps`, `week-overview.tsx:67-88`, called at `:453`).

**AMB-6 — Modality contradictions are visually indistinguishable from "no signal"** in the compare
panel (both render `HelpCircle`), even though contradictions are recorded as `data_issues` and counted
on `/data-health`. *Should the panel distinguish them?*

**AMB-7 — `resolveSessionModality`'s fail-closed fallthrough catches more than documented.**
`compare.ts:170-171` also catches a *paired* group whose session references a `wiseTeacherId` absent
from `group.wiseRecords` (the paired branch at `:116` requires `teacherRecord`).

**AMB-8 — `detectConflicts` dedup key is casing-sensitive while the grouping key is not.** It groups
by `studentName.toLowerCase()` (`compare.ts:329`) but builds the dedup key from the raw name (`:343`),
so with mixed casing across tutors the key varies with iteration order.

**AMB-9 — Historical compare data is narrower than "captured history" implies.**
`past_session_blocks` rows are created only for sessions present in a *prior snapshot's*
`future_session_blocks` that then disappeared (`src/lib/sync/past-sessions-diff-hook.ts:116-121`).
Sessions created and started between two syncs are never captured. Also, `isHistoricalRange` triggers
on the week's Monday being before today (`compare route.ts:186`), so mid-week views always pay the
`past_session_blocks` read even when only future days are viewed. *Should it be per-weekday like the
D-05 fallback?*

**AMB-10 — Index freshness fallback can suppress the stale warning.** `src/lib/search/index.ts:166`
falls back to `activeSnapshot.createdAt ?? new Date()` when no successful sync run has promoted the
active snapshot, which can make a snapshot appear freshly synced.

**AMB-11 — Promotion-gate denominator counts collisions.** `unresolvedRatio` divides *all* identity
issues (REL-03 collisions included) by group count, so a snapshot with many collisions but zero truly
unresolved teachers could be blocked from promoting. *Intended conservatism?* Related:
`snapshot_stats.unresolvedGroups` stores `identityIssues.length` (an issue count), and `resolvedGroups`
(`orchestrator.ts:462`) matches issues by `canonicalKey` while unresolved-teacher issues use
`entityId = teacher._id` (`identity.ts:186`), so solo fallback groups count as resolved. *Fix, or does
Data Health already interpret them as issue counts?*

**AMB-12 — Sequential per-teacher sync loop.** Stage 7 awaits each teacher in turn while the client
limiter allows 15 concurrent requests, so wall-clock scales linearly with teacher count against the
800s ceiling. *Intentional Wise rate-limit caution, or an optimization opportunity?* Relatedly,
`fetchTeacherFullAvailability` reads `workingHours` from only the first of 26 windows
(`fetchers.ts:82`) — *confirm against the Wise contract that it cannot vary by window.*

**AMB-13 — Payroll approval is not a lock.** A subsequent sync of the same month deletes and rebuilds
`payroll_teacher_tiers` from current Wise tags (`sync.ts:386`, `:390`) and resets the review to draft,
clearing approver fields (`:394-412`) — silently un-approving an approved month. *Is an explicit
closed/locked state wanted, or is "nobody re-syncs an old month" the control?*

**AMB-14 — Payroll prices every month with the currently active rate card.** `data.ts:552-557` selects
by `active = true`; `payroll_rate_card_versions.effectiveMonth` exists but is never read as a selector
anywhere in `src/`. Activating a replacement silently re-prices every past month's expected-rate
checks. *Was month-scoped selection intended and dropped?*

**AMB-15 — Payroll approval strictness mismatch.** The UI disables Approve when any issue exists
(`payroll-dashboard.tsx:390`) while the server blocks only `expected_rate_mismatch` /
`missing_expected_rate_rule` / `unmapped_rate_course` (`review/route.ts:27-40`).

**AMB-16 — Manual payroll adjustments never reach a total.** They appear only in
`summary.manualAdjustmentHours/Amount` and are excluded from `totalPayoutAmount`/`paidHours`
(`data.ts:483-487`). *Is a downstream consumer meant to apply them, or is it done by hand?*

**AMB-17 — Credit Control asymmetry.** `POST /api/credit-control/actions` treats any unrecognized
status as a clear (`actions/route.ts:23`) while the bulk route 400s on the same input
(`bulk/route.ts:19-23`). Separately, `actions/history` hardcodes a 7-day window at the call site
(`route.ts:15`) although `readCreditActionHistory` accepts `sinceDays` and no query param widens it.

**AMB-18 — Sales Dashboard churn is computed two ways.** Overview (`analytics.ts`) reads the frozen
import-time `churn_status` while the Students tab and detail panel recompute live
(`cohorts.ts computeLiveStatus`). *Should Overview migrate, or is "as of last import" intentional
there?*

**AMB-19 — Sales Dashboard hardcoded targets and presets.** `MONTHLY_NORMAL_SALES_TARGET = 4_000_000`
(`gm-insights.ts:15`) applies whenever no projection is imported. *Is the number current, and should
Overview hide pace (as the Reps tab does) rather than score against a constant?* Period presets are
hardcoded calendar spans (`sales-dashboard-shell.tsx:127-138`) and `period-toolbar.tsx` calls computed
presets a follow-up "pending owner sign-off". *Still wanted, and who signs off?*

**AMB-20 — `shouldAutoFinalizePreviousMonth` also fires on `refreshing`** (`lifecycle.ts:35-42`) — so a
run genuinely mid-flight on day 8 could be flipped to `finalized` by a concurrent cron pass.
*Intended?* Separately, `importAllSalesSources` (`data.ts:579-593`) imports every source with
`allowFinalized: true`, bypassing the lifecycle gating the cron path uses. *Presumably intentional for
one-shot historical loads — confirm.*

**AMB-21 — Inconsistent cache revalidation on import failure.** The sales-import failure branch
rethrows without `revalidateSalesDashboardCache()` (`data.ts:553-564`) while the projection-import
failure branch calls it (`:723`), leaving the failed-source banner stale for up to the 60s `cacheLife`
window.

**AMB-22 — `getCreditControlPayload()` writes inside a `"use cache"` function.**
`clearRecoveredActionStates` deletes follow-up state and appends auto-clear log rows
(`service.ts:109-136`). Documented as-is; *worth a design review.*

**AMB-23 — `getSalesDashboardPayload` is cached per admin email** (`data.ts:919-924`) although only a
small token block is email-dependent. *Deliberate, or accidental cache fan-out?* Its `token` object
also carries `writeConnected` (`google-oauth.ts:279`) which the declared type omits
(`types.ts:87-92`). And `getGoogleSheetsAccessToken` (`google-oauth.ts:199`) /
`getGoogleSheetsWriteAccessToken` (`:226`) return a cached token without refreshing when `expiresAt` is
null/0, while `getGoogleDriveAccessToken` (`:258`) refreshes. *Which is the intended behaviour?*

**AMB-24 — `getPayrollPayload` runs the full month aggregation uncached on every home-dashboard load**
for payroll-permitted users (`src/lib/home/summary.ts:181-182`). *Acceptable, or should the tile read a
cheaper count?*

**AMB-25 — Classroom override recompute is over-broad.** `updateClassroomAssignmentOverride`
(`data.ts:1071`, `:1092`, `:1108`) recomputes without live-Wise external blocks and resets
`publishStatus` on every row plus the run's published counters. *Intended policy, or should it be
scoped to affected rows?*

**AMB-26 — Publish eligibility diverges between client and server.** The client `isPublishEligible`
(`class-assignments-workspace.tsx:199`) matches only `sessionType === "OFFLINE"` while the server
accepts offline/onsite/in-person (`session-mode.ts:2`), and the client also omits the server's
`wiseSessionId` check (`data.ts:1229`) and the `status === "remote"` short-circuit. *Does Wise emit the
other variants, and should the client reuse the shared helper?*

**AMB-27 — `POST .../publish` ignores its request body** and always publishes the whole run;
`createClassroomPublishJob` supports `targetRowIds` but only the morning automation uses it. *Should
row-scoped manual publish be exposed?*

**AMB-28 — `POST .../schedule-email/send` returns 200 whenever `summary.attempted > 0`**, including
when every send failed. And `GET .../schedule-email/preview` never passes `senderKey`, so it always
reports blockers for the PRIMARY Apps Script config even when the operator intends to send via backup
— the preview's `hardBlockers` can disagree with the actual send.

**AMB-29 — Room-capacity forecast mixes two occupancy pictures.** Weekday saturation and the
demand-mix fallback use raw seed sessions while the weekend readiness gate and breakpoint use
engine-projected ones (`data.ts:405-425`), with no comment or decision ID either way. The weekend
`preferred_slot_only` policy counts a simulated lead fully lost when its exact preferred weekend slot
is taken even if other weekend rooms are open (`forecast.ts:521-578`, `:816-818`) — deliberately
pessimistic. *Confirm both are the intended business rules.*

**AMB-30 — Utilization denominators and inflation.** Availability is `activeRooms × 14h` for every day
in range with no holiday/closure calendar (`utilization.ts:247`, `:368-371`), structurally depressing
utilization; overlapping bookings are double-counted by design (`:215-225`), so headline utilization
can exceed 100% purely from Wise double-bookings, explained only in a small caption.
`findUnmatchedCurrentAllocations` (`analysis.ts:66-84`) applies no online/remote exclusion, so every
online session whose Wise `location` is a URL is reported as `unknown_room` and counted in
`kpis.unmatchedCurrentAllocations`. `buildOvercapIntervals` has no open-window clipping while
`buildHeatmapCells` iterates only 07:00–21:00 (`analysis.ts:181-182`), so a session outside those hours
can produce a reported over-capacity interval that never appears in the heatmap — and
`kpis.peakLoadRatio` (`data.ts:276`) derives from heatmap cells only. `seededDemandMixFromSchedule`
(`forecast.ts:833-843`) admits sessions classified `online` merely because `currentWiseLocation` is
non-empty, then stamps them `mode: "onsite"`.

**AMB-31 — Tutor-profile import guardrails.** The importer hardcodes provenance strings
(`"BeGifted Tutors-3.xlsx"`, `"Availability.xlsx"`) into `internalNotes` and
`languages[].verificationSource` regardless of the uploaded filename (`tutor-profile-import.ts:469`,
`:485-489`, `:510`). `invalidRows` reports out-of-range youngest-comfortable-age only inside the
matched-row branch (`:849-851`). The workspace posts every matched row in one call while
`import-commit` caps rows at 200 (`route.ts:16`), so a >200-match import 400s rather than paginating.
The preview's "review" counter shows only `summary.unmatchedRows` (`workspace:399`) and the amber list
is `.slice(0, 8)` (`:430`) over all four buckets, so a large messy import hides most of its problem
rows. *Also: is `verifiedBy`/`lastReviewedAt` — stored as-is with no validation, no auto-stamping, and
no per-edit history table (`src/lib/tutor-business-profiles.ts:359-364`) — the intended accountability
level for "do-not-use" guidance?*

**AMB-32 — The positional legacy branch of `parseAvailabilityWorkbook`**
(`tutor-profile-import.ts:346-356`) hardcodes column indices 0–3 and 18–21, and no fixture, sample
workbook, or doc establishes the sheet shape it assumes. Any column insertion silently shifts the
mapping. *Was the seed import a one-time event (branch removable) or is it expected to recur (needs a
header-based fallback)?*

**AMB-33 — Leave-request sheet semantics.** `initialWorkflowStatus` reads the sheet's Status only on
insert; later manual sheet edits update `sourceSheetStatus` but never the workflow status.
`sourceRowNumber` is both the upsert identity and the writeback cell address, so a sort or row deletion
silently re-points existing rows, and there is no path to remove a row whose source disappears. Two
idempotency key formats coexist: the email sender gets `leave-requests:{syncRunId}:{recipient}`
(`sync.ts:329`) while the persisted row stores `leave-request:new:{requestId}:{recipient}` (`:355`).
`notificationCount` is incremented per row even when `.onConflictDoNothing` skipped the insert
(`:358-359`). And `shouldWriteSheet` is true for any `workflowStatus` (`data.ts:517`) with the
workspace's Save always sending one (`leave-requests-workspace.tsx:187-192`), so an
unresolvable/read-only account is recorded as `sheetWriteStatus = "failed"` rather than skipped — which
then feeds the "Action needed" filter and the nav badge. *Also:
`recomputeAffectedSessionsForRequest` returns 0 when there is no active Wise snapshot **after**
deleting the child rows and without resetting `leave_requests.affectedClassCount`
(`data.ts:412-417`), leaving the counter inconsistent with an empty child table.*

**AMB-34 — Where does "AI Scheduler" end and "LINE AI Review" begin?** Both share
`ai_scheduler_conversations/_messages/_runs/_feedback`; LINE writes parent-role messages and runs its
own turns via `executeSchedulerTurn` (`src/lib/line/review-service.ts:302-348`), and
`SchedulerWorkspace` renders the LINE queue inline. Both `/line-review` and `/scheduler` list and
action the same pending review queue with no visible locking.
*Which is canonical for staff, and is the overlap intentional?*

**AMB-35 — AI Scheduler UI caps and divergences that are not documented.** The solver returns up to 8
suggestions (`MAX_SCHEDULER_SUGGESTIONS`, `scheduler-conversation.ts:26`) but the workspace renders
only the first 4 per assistant message (`scheduler-workspace.tsx:2134`). `/api/search/assistant`
truncates each option to 3 tutors (`route.ts:56`) while the conversational path keeps 4
(`scheduler-conversation.ts:1792`). `GET /api/ai-scheduler/conversations/[conversationId]` returns
`source: "manual"` and zeroed LINE rollups even for LINE-originated conversations
(`scheduler-data.ts:373`), unlike the list endpoint. No AI-scheduler route exports `maxDuration`
despite ~11s eval p95 latency.

**AMB-36 — The DM `send` path is the *looser* matcher.** It resolves the student with a ranked
directory search plus a single-result check (`schedule-bot.ts:362-376`), while the DM link-back path
and the whole group path use `exactCodeMatches` (`schedule-bot.ts:304`;
`schedule-bot-group.ts:395`). The docs present exact-code narrowing as a group-only property, which
leaves the impression that the parent-facing DM send is stricter.

**AMB-37 — Wise event-feed ordering is assumed but unverified.** Both the `lookback_reached` and
`known_events` early exits assume newest-first ordering; a change would silently truncate ingest while
still recording `status: "success"`. No fixture, contract test, or captured payload exists in the repo.
Related: the failure path writes sync-run metadata *without* `stoppedReason` (`sync.ts:288`); only the
success path includes it (`:260`).

**AMB-38 — Two different reconciliation matchers can legitimately disagree.** Home's card uses
`persistedEventMatchesSale` over persisted `wise_activity_events` (`reconciliation.ts:586-616`, `:997`);
the reconciliation page's `rowsWithCandidates` uses `scoreReceiptCandidate` over live Wise receipts
(`:372`, `:623-627`), and the review-flag logic differs (`:1000` vs `:561-565`). *Should the docs call
this out?* Also, the `financeOnly` SQL predicate matches `%invoice%/%payment%/%payout%`
(`data.ts:108-116`) while the summary card's `isWiseFinanceEvent()` also matches `transaction`
(`format.ts:57-66`), so `cards.financeEvents` can count rows `financeOnly=true` would not return.

**AMB-39 — `BACKFILLABLE_EVENT_NAMES` has exactly one entry** (`SessionFeedbackSubmittedEvent`).
Post-Class Feedback's own code notes the deletion mirror "only reaches back to 2026-05-27"
(`src/lib/post-class-feedback/repository.ts:73`). *Should Wise Activity own an explicit, documented
retention/backfill floor, and is the allowlist meant to grow?*

**AMB-40 — `reconcileProposalState` runs on every list/create/patch**, including the AI-scheduler hot
path. *Acceptable per-request cost, or move to the sync pipeline / a cron?* Related: `PENDING_HOLD_MS`
(48h) is hardcoded; terminal holds (released/expired/auto_resolved) are never surfaced in any UI and
never purged; orphan-bundle cleanup on failed item insert is best-effort (`.catch(() => undefined)`,
`data.ts:361-364`) and `createProposalBundle` is non-transactional (presumably because neon-http has no
transactions, but no comment says so); proposal writes never call `revalidateTag`; `proposalItemSchema`
(`route.ts:16-26`) allows day-less items and unrelated start/end minutes that the data layer and a
CHECK constraint then reject; and the second 409 path (`route.ts:112-117`) returns no `conflict` field,
so `ProposalHoldModal` degrades to a generic message (`proposal-hold-modal.tsx:116`).
*Is one-way publishing of confirmed holds to Wise a planned follow-up or intentionally out of scope?*

**AMB-41 — `GET /api/wise-activity/reconciliation` returns 500** when the selected Sales Dashboard
source has no successful import (`reconciliation.ts:843-845`, caught at `route.ts:47-50`), even though
that is a caller-selectable condition that reads like a 4xx. Similarly, the backfill body requires
`endDate` but uses it only to validate ordering (`route.ts:32-35`) — `lookbackDays` derives from
`startDate` alone (`reconciliation.ts:1013-1019`). *Is `endDate` meant to bound the crawl?* The same
route also makes live, uncached Wise calls on an interactive admin read path.

**AMB-42 — `GET /api/room-capacity/month` does not validate its dates** (nothing calls
`assertUtilizationDate`) and has no 400 branch, while the sibling `/utilization` route does.
Separately, all three room-capacity read endpoints write to `classroom_rooms` as a side effect via
`listClassroomRooms` → `ensureDefaultClassroomRooms` (`src/lib/classrooms/data.ts:431-491`), so none is
genuinely read-only (and `docs/reference/api/room-capacity.md` marks all three as "none (read-only)").

**AMB-43 — Two readiness reason codes are emitted but untested.** `missing_seed_sessions` and
`zero_weekend_preference_distribution` (`forecast.ts:355`, `:360`).

**AMB-44 — "Completeness" data issues have no drill-down.** Failed per-teacher availability fetches and
failed past-session captures are counted in `snapshot_stats.totalDataIssues` and appear in the
`issuesByType` badges but have no table on `/data-health` — the only two categories an operator cannot
inspect. *Deliberate?*

**AMB-45 — Free-text search cost.** The Wise Activity `q` filter runs a leading-wildcard ILIKE over six
columns, three of them unindexed (`actor_name`, `classroom_name`, `classroom_subject`). No benchmark,
query plan, or trigram index exists in the repo.

**AMB-46 — `listLeaveRequests({summaryOnly:true})` still SELECTs up to 200 full rows and discards
them** (`data.ts:230`, `:250`), so badge/KPI counts truncate at 200 requests. *Should it be a
`count(*)` aggregate?*

**AMB-47 — `getWiseActivitySummary` loads every matching row into memory with no cap**
(`src/lib/wise-activity/data.ts:167-171`) and aggregates in JS, with no server-side maximum range.
*Is there an intended maximum span?*

**AMB-48 — `maxEventPages` clamp vs default.** The payroll route clamps caller input to [1, 2000] while
`runPayrollSync` defaults to 1000 (`sync.ts:23`, `:253`). *Has any real month needed more than the
default?*

**AMB-49 — Payroll invoice identity has no fallback.** *Should it fall back to the tier snapshot /
identity tables by `wiseTeacherUserId` when no session matches (`data.ts:337`)?* See DEF-16.

**AMB-50 — The `/compare` legacy redirect forwards only `?tutors=`**
(`src/app/(app)/compare/page.tsx:11-16`), not `?week=`. *Should it forward the week, and how long must
the legacy route survive before deletion?*

**AMB-51 — Two distinct "tier" concepts share a name.** Payroll BG-band (structured, rate-bearing) vs
the tutor-profile-import free-text field. The payroll one was treated as the canonical handbook term.
*Confirm.* Likewise "identity group" has a tutor meaning (`src/lib/normalization/identity.ts`) and a
separate LINE contact/parent-relationship meaning; the glossary documents only the former.

---

## 10. Retention, scale & cost

**SCALE-1 — Credit Control snapshots are never pruned.** A schema comment records the production cost:
67.8M session rows / 39GB across 3,367 retained snapshots (`src/lib/db/schema.ts:1252-1258`). That
comment is undated and was written to justify omitting an index, not to measure retention — *a current
Postgres measurement is needed before those numbers drive any capacity decision.* *Is unbounded
retention deliberate, and what is the growth plan?*

**SCALE-2 — Sales Dashboard rows are never pruned.** No `delete` exists in
`src/lib/sales-dashboard/`, and the cron refreshes live months 48×/day, each pass appending a full copy
of that month's rows. Whether anything outside that directory prunes them (manual job, Neon-side
policy) cannot be determined from the repo.

**SCALE-3 — Payroll sync runs are never pruned.** Each sync deletes and reinserts the month's
tier/invoice/observation rows, but old `payroll_sync_runs` rows remain with zero children and no
`ON DELETE` behaviour on the FKs.

**SCALE-4 — Classroom assignment runs are append-only per date** (`data.ts:852`) with no retention
policy, while a nightly 7-day-horizon cron regenerates them. *Is cleanup intended — possibly what the
unused delete helpers in DEAD-11 were for?*

**SCALE-5 — Leave-request sync runs have no pruning job**, and `leave_requests.lastSyncRunId`
references them with no `onDelete` (DATA-9). *Unbounded by design, as with `past_session_blocks`?*

**SCALE-6 — `getTutorProfileVersion()` runs `count(*)` + `max(updated_at)` on every `ensureIndex`
call** (`src/lib/search/index.ts:128-137`, `:365-375`), so "zero DB queries on the hot path" is really
two cheap queries. Negligible today; *confirm the table stays small or find a cheaper invalidation
signal.*

**SCALE-7 — `POST /api/line/contacts/refresh-profiles` has no `maxDuration` override** yet performs one
sequential LINE profile call per contact (`src/lib/line/contact-aliases.ts:525-540`) — likely to hit the
platform default at current contact volume. *Was an override intended, as on `followers-reanchor`
(300s)?* Related: `POST /api/line/contacts/followers-reanchor` double-fetches the ~1,962-follower
roster, which its own comment flags as a known follow-up pointing at the dedicated cron as the clean
vehicle (`route.ts:7-12`). *Is the combined admin route still the intended production entry point?*

---

## 11. Testing & verification gaps

**TEST-1 — `src/lib/sales-dashboard/data.ts` has zero real coverage.** All four route suites
`vi.mock` the module wholesale, so import orchestration, lifecycle transitions, row scoping, and
archival guards are untested. *Is a testcontainers integration suite wanted, given the fail-closed
guarantees this module carries?*

**TEST-2 — `src/lib/proposals/data.ts` has no DB-backed tests** — the exclusion-constraint conflict
path, orphan-bundle rollback, expiry sweep, and auto-resolve join are covered only at the pure-helper
level. (The constraints also require the `btree_gist` extension,
`drizzle/0006_admin_proposal_holds.sql:48-57`.)

**TEST-3 — `src/lib/db` has zero tests** — no coverage of the `getDb()` Neon singleton (including its
`globalThis` anchoring), `schema.ts`, or `seed.ts`.

**TEST-4 — No route-handler tests for the six Wise Activity endpoints** (only
`sync`/`reconciliation`/`format` lib tests). Auth branches, inline validators, and status mappings are
documented from reading the handlers alone.

**TEST-5 — The integration `truncateAll` list is hand-maintained and covers 39 of 188 tables**
(`src/tests/integration/db-helper.ts:52-96`). Adequate today because only sync and post-class-feedback
have integration suites, but any new suite will silently leak state unless the author remembers to
extend it. *Auto-derive it from the Drizzle schema?*

**TEST-6 — An open commitment recorded in code, not in a plan.**
`src/lib/line/__tests__/name-matcher.eval.test.ts` states in its own header that production-labeled
calibration against live `extracted_state` data is a follow-up "before the matcher is relied upon at
scale". The fixture corpus is still synthetic.

**TEST-7 — `cron-registry.test.ts` compares only path and schedule**, which is why DEF-1 went uncaught.
*Extend it to `maxDurationSeconds`, `routeMethod`, and the manual-only flag.*

**TEST-8 — Untested hooks and merge semantics.** `useCompare` has no dedicated unit test (cache keying,
AbortController races, snapshot-change retry, `src/hooks/use-compare.ts:116-206`, `:283`);
`upsertTutorBusinessProfile`'s keep-vs-clear merge (`=== undefined` vs explicit `null`) and list de-dup
have no direct test.

**TEST-9 — Per-file test counts in the Classroom Assignments doc are static declaration counts** (143
declarations across 16 files; 147 executed after one `it.each` expands), not execution-confirmed
totals — the suite was not run during the pass.

---

## 12. Reference-doc drift (mechanical fixes)

All of these are stale line anchors or counts in `docs/reference/**` that the pass identified but did
not edit, because those files were outside the editing agent's scope. They are safe, mechanical
corrections.

| File | Drift |
|---|---|
| `docs/reference/database/index.md` | Zero hits for `competitor_entities`, `student_schedule_links`, `progress_test_cycle_state`, `ipeds_institutions`; stale ranges for credit-control (cites 447-610, actual 1150-1342), sales-dashboard (cites 270-446, actual 618-791), `googleOAuthTokens` (cites 256-266, actual 587-597), all 9 classroom tables, and the 6 AI/proposal tables (cites 1392-1522, actual 2300-2430). Omits `credit_control_zero_balance_tracking`. |
| `docs/reference/database/erd-core.md` | Cites `schema.ts:190-223` / `:215` / `:239-241` for Wise-activity tables; actual `:518-551` / `:543` / `:567-569`. `wiseActivitySyncRuns` cited at `:225-243`, actual `:553-571`. |
| `docs/reference/database/erd-credit-control.md` | Documents 10 tables, omits `credit_control_zero_balance_tracking`. |
| `docs/reference/database/erd-payroll.md` | Cites `schema.ts:855-1015` for the 8 payroll tables; actual `1760-1919`. |
| `docs/reference/database/erd-line.md` | Documents 8 of 12 LINE tables (missing `line_backlog_recovery_sync_runs`, `line_schedule_bot_pending`, `line_group_settings`, `line_group_schedule_sends`), omits the `isPhantom`/`sourceKind`/`sourceRunId` columns, and its anchors are ~900 lines stale (cites `lineContacts` at 1526-1543, actual 2434-2451). |
| `docs/reference/database/erd-tutor-profiles.md` | Cites `schema.ts:1057-1073` / `1074-1109`; actual `1962` and `1982`. Also files `tutor_contacts` under Tutor Profiles (DATA-15). |
| `docs/reference/database/erd-ai-and-proposals.md` | Cites `schema.ts:1392-1403` / `1404-1435` for the proposal tables; actual `2300` and `2312`. Carries none of the CHECK/EXCLUDE DDL (DATA-3, GOV-8). |
| `docs/reference/database/erd-room-capacity.md` | Cites `schema.ts:1785-1858`; `roomCapacityModelRuns` is at `2726`. |
| `docs/reference/database/erd-leave-requests.md` | "🟡 IN PROGRESS — uncommitted" banner is wrong (GOV-3); cites `schema.ts:1185-1346`, actual `2093-2234`. |
| `docs/reference/database/erd-university-admissions.md` | Header cites enums at `schema.ts:233-334` and tables at `2983-3396`; actual `337-452` and `3957-4617`. |
| `docs/reference/database/enums.md` | Cites the 5 classroom enums at `schema.ts:48/54/61/68/75` with column refs at `746/760/810/816/1019`; actual declarations `50-83`, bindings `1651/1665/1715/1721/1924`. |
| `docs/reference/api/index.md` | `:11` cites `src/middleware.ts:4-15` for the allowlist (actual `4-20`) and `:25-29` for the login redirect (actual `71-75`), and omits the per-page 403 at `middleware.ts:79-82`. `:27` says `GET /api/ai-scheduler/conversations` lists "the signed-in admin's" conversations — it lists **all** by default (`conversations/route.ts:34-35`). `:31` says DELETE deletes a conversation — it archives. `:33` describes the feedback route as thumbs-up/down — it is a three-variant union. Header counts need re-verification (GOV-13). |
| `docs/reference/api/line.md` | Header claims 28 handlers; there are 25 `route.ts` files exporting 29 endpoints. Omits `POST /api/line/contacts/followers-reanchor`, the phantom link-validation scope, and `groupCommands` on the webhook 200 body (`src/lib/line/webhook.ts:64`). |
| `docs/reference/api/misc.md` | `:87` says the compare endpoints add "no extra DB queries beyond stale-ID resolution", omitting the per-request `ensureIndex` freshness query (`index.ts:366-375`) and the `past_session_blocks` read. Cites the import-preview response as `tutor-profile-import.ts:102-117` and omits `vocabulary` (interface runs to `:123`, field at `:119-122`, serialized at `:882-885`). |
| `docs/reference/api/internal-crons.md` | States `maxDuration = 300` for `/api/internal/sync-credit-control` (actual 800, `route.ts:14`). `:212` cites `sync.ts:290-305` for the leave-requests single-flight guard (actual `:55-58` and `:372-387`); `:210` cites `route.ts:6` for `maxDuration` (actual `:7`). |
| `docs/reference/api/wise-activity.md` | Line cites no longer match `sync.ts`/`reconciliation.ts` (e.g. cites `sync.ts:139-275` for `syncWiseActivityEvents`, now `:152-293`). |
| `docs/reference/api/payroll.md` | `:5` cites `schema.ts:855-1015`; actual `1760-1919`. |
| `docs/reference/api/room-capacity.md` | Marks all three GET routes as "none (read-only)" side effects; all three seed/deactivate `classroom_rooms` (AMB-42). |
| `docs/reference/crons.md` | Needs a recount against the 15 `vercel.json` entries; `:322` calls the room-utilization sync "effectively disabled" (tension with any "stable" badge, GOV-2); `:331` asserts Vercel invokes via GET (unverifiable in-repo, OPS-2). |
| `src/lib/admissions/notifications.ts:1012` | Stale JSDoc: describes a "Sunday 18:00 Asia/Bangkok slot"; no such cron exists — the weekly pass rides the single daily 08:12 Bangkok invocation on Bangkok Sundays (`admissions-notifications/route.ts:59`). |
| `src/lib/normalization/modality.ts:65-66` | Stale comment: says "If only offline members and no session evidence → assume onsite"; the code immediately below returns `unresolved` with an issue. |
| `src/lib/line/name-matcher.ts:70-71` | Self-documents as a verbatim copy of `levenshtein` in `data.ts` and cites `data.ts:1090-1107`; the real function is `data.ts:1133-1150`. *Consolidate the duplicate.* |
| `src/lib/data-health/dashboard.ts:317-319` | Closing comment claims only `room_utilization` reaches the run-evidence fallback (OPS-8). |

---

## 13. Conventions & naming

**CONV-1 — `.parse()` vs `.safeParse()` is now two dialects.** The stated rule is "**always**
`.safeParse()`, never `.parse()`", but 20 route files — post-class-feedback (11),
competitor-intelligence (5), sales-dashboard (4) — use `Schema.parse()` inside a typed catch. The pass
documented this as a second legitimate dialect because the mappers convert `ZodError` to 400.
*Confirm this is the intended convention going forward rather than accumulated drift* — and note that
the sales-dashboard routes lack a dedicated error mapper (DEF-17) and competitor-intelligence has no
`ZodError` branch at all (DEF-8), so in those two families the dialect is not actually safe.

**CONV-2 — `isUniqueViolation` exists eight times in two incompatible dialects.** (re-verified) The
23505 predicate behind every single-flight guard is redefined in eight modules, and the two groups do
not agree on what a unique violation looks like:

| Dialect | Checks | Sites |
|---|---|---|
| `code` only | `err.code === "23505"` | `credit-control/run-sync-request.ts:41`, `progress-tests/run-sync-request.ts:39`, `sales-dashboard/import-guard.ts:58`, `sync/run-wise-sync.ts:42` |
| `code` **or** `cause.code` (+ index-name regex) | `code`, `cause?.code`, `message` | `wise-activity/sync.ts:58`, `post-class-feedback/repository.ts:361`, `admissions/notifications.ts:231`, `admissions/cohorts.ts:19` |

Drizzle wraps driver errors, so the four `code`-only copies will **miss a wrapped violation** and let
it escape as a generic 500 instead of the intended 409/no-op. The newer dialect exists precisely
because someone hit that. *Promote the `cause`-aware version to a shared `src/lib/db` helper and delete
the seven others.*

**CONV-3 — Duplicated missing-forecast payload.** `missingForecastBody`
(`src/app/api/room-capacity/forecast/route.ts:16-41`) and `missingForecastResponse`
(`src/lib/room-capacity/data.ts:358-383`) are two independent copies with no shared type-checked
source.

**CONV-4 — Directory naming inconsistency.** `src/lib/learning-plans` (plural) vs
`src/components/learning-plan` (singular). Not covered by any stated convention.

**CONV-5 — Missing lint suppression.** `src/lib/search/index.ts:94` has a `declare global` with `var`
declarations but no `// eslint-disable-next-line no-var` comment, whereas `src/lib/db/index.ts:17`
does. *Either the rule no longer fires there or the suppression was dropped.*

**CONV-6 — Query params escaping Zod.** In the AI Scheduler group, `sort` is the only query input
validated by Zod; `includeArchived`, `scope`, `ownerEmail`, and `q` are read as raw strings. None of the
four room-capacity routes uses Zod at all.

**CONV-7 — Error-contract deviations.** Several handlers parse `request.json()` outside a dedicated
try/catch, so an unparseable body yields 500 rather than the conventional 400 (Credit Control notably).
Most AI-scheduler handlers have no try/catch around the data-layer call, so a DB failure returns an
untyped framework 500 instead of the documented `500 {"error": message}`. `GET /api/sales-dashboard`
also returns its payload unwrapped while most routes wrap in `{source}`/`{sources}`/`{runs}`.

**CONV-9 — One of the six domain error mappers has a different signature and loses the route in its
logs.** (re-verified) Five take `(route, error, fallbackMessage)` —
`admissionsErrorResponse` (`src/lib/admissions/access.ts:256`), `progressTestsErrorResponse`
(`src/lib/progress-tests/api.ts:74`), `studentPromotionErrorResponse`
(`src/lib/student-promotions/api.ts:29`), `creditControlErrorResponse` (`src/lib/credit-control/api.ts:17`),
`postClassFeedbackErrorResponse` (`src/lib/post-class-feedback/api.ts:12`). One takes
`(error, fallbackMessage)`: `competitorIntelligenceErrorResponse`
(`src/lib/competitor-intelligence/access.ts:32`). Its 500-path `console.error` therefore cannot say
which route failed, breaking the "route path is the first token in the log line" convention that makes
Vercel logs greppable. All six also re-implement the same `HANGING_PROMISE_REJECTION` re-throw and the
same Unauthorized/Forbidden sentinel matching; only `postClassFeedbackErrorResponse` refuses to
serialize an unknown error object (logging `error.name` only, to avoid leaking private feedback text).
*Normalize the signature, consolidate the six into one helper, and decide whether the post-class
stricter behaviour should be the shared default.* See also DEF-8 — the same competitor-intelligence
mapper has no `ZodError` branch.

**CONV-8 — Spine-vs-filesystem naming.** The authoritative lib-module list names `ai` and `scheduler`
as separate directories (on disk `src/lib/ai/` holds the AI scheduler service while `src/lib/scheduler/`
holds only `admin-colors.ts`) and `auth` as a directory alongside the loose `auth.ts` / `auth-edge.ts` /
`auth-access.ts` files (DEAD-26). *Reconcile the names.*

---

## 14. Requires access outside this repository

These cannot be answered by reading code at all. They need someone with production, Vercel, Google,
Wise, or GitHub access.

1. **The production process timezone** (TZ-1) — nothing in the repo pins it; five code paths depend on
   it and one confirmed defect (DEF-4) turns on it.
2. **Whether Wise's `/institutes/{id}/events` feed is guaranteed newest-first** (AMB-37) — two
   early-exit paths assume it and would truncate ingest silently if it changed.
3. **Whether the Apps Script email relay honours the idempotency key** (OPS-20).
4. **Whether "Form Responses 1" is append-only in practice** (AMB-33) — the upsert key and the
   writeback cell address both assume it. Also whether a Google **Form** is actually upstream of that
   sheet at all: `config.ts:1-5` proves only a spreadsheet id and a tab name.
5. **The live `admin_users` count and composition** (SEC-7).
6. **Whether `sales-dashboard-scope` is a required status check on `main`** (SEC-16), and whether
   collaborator `aoengnatchasmith-spec` is still active.
7. **Whether `docs/reference/production-route-surface.json` is in sync with HEAD** (OPS-19) — if it has
   drifted, `verify:release` is already failing.
8. **Whether the admissions migrations (0050-0052) are applied to production**, since the feature doc
   describes University Admissions as pre-deploy. Same question for `drizzle/0037_payroll_rate_cards.sql`,
   which is the only thing that makes payroll expected-rate checks live.
9. **Current Postgres size/row measurements for Credit Control retention** (SCALE-1) — the 39GB figure
   comes from an undated code comment.
10. **Cold-start index build latency on Vercel** (OPS-24) and instance recycle frequency.
11. **Whether the cron watchdog is currently alive** (OPS-5) — by construction, a dead watchdog looks
    identical to a healthy system from inside the app.
12. **Whether `extensions/line-oa-resolver/`** (manifest, popup, content, background scripts, README —
    referenced by `oa-resolver-dialog.tsx:315-317`) is in scope for the docs set. It has no feature-doc
    coverage today.
13. **Whether the `MONTHLY_NORMAL_SALES_TARGET = ฿4,000,000` fallback is the current business target**
    (AMB-19).
14. **Which worktree is linked to the Vercel project** (OPS-18) — recorded only in CLAUDE.md prose.
15. **Whether the authored Mermaid diagrams render.** They were written but never validated by a
    Mermaid engine in this environment. *Add a render check in CI or preview before publishing.*

---

## 15. Published claims that verification could not settle

A second pass re-read each feature doc against code and flagged every sentence it could not confirm
from the tree. Those sentences are **still in the docs** — the pass narrowed or attributed them rather
than deleting them — so this section records what a reader is being asked to take on trust. Grouped by
why they are unverifiable.

**External system behaviour.** Nothing in this repo can confirm these; they need vendor docs or a
captured production trace.
- Wise's `FUTURE`-status session call omits sessions once they have started (relied on by Tutor Compare's
  weekday fallback and the past-session diff hook).
- Wise's unfiltered `/institutes/{id}/sessions` call *does* return past/`ENDED` sessions — the whole
  room-utilization history floor of 2026-03-01 assumes it.
- The `/institutes/{id}/events` feed is newest-first (AMB-37) and rejects ranges of ~100+ days with
  "Invalid start or end date!" (the 85-day progress-tests window is built around that rejection,
  attributed only to `src/lib/progress-tests/sync.ts:67-70`).
- The Apps Script mail relay honours the idempotency key (OPS-20).
- LINE emits no webhook event for a message the Official Account itself sends, and the bot mention
  exists only in the LINE mobile app.
- Vercel Cron invokes via `GET` (OPS-2), and Vercel's ~14 KB request-URI budget bounds the
  learning-plan report URL.

**Production state.** True/false today, but only answerable against the live system.
- Whether post-class enforcement is `live` or `shadow` (it lives in a `post_class_settings` row, not in
  source), whether payout writes have ever been enabled, and whether the tutor workbook fleet was cut
  over.
- Whether the July 1, 2026 student-promotion run actually happened (§14.8 and the "pending first
  production run" badge in `docs/README.md` disagree with the calendar).
- Whether the DM schedule-bot path still reaches only ~7 students after the OA-resolver quarantine.
- Whether phantom `line_contact_student_links` rows exist at all, given nothing in code sets
  `is_phantom = true` (SEC-14).
- Which IPEDS data years are actually loaded — a missing historical year silently shortens every trend
  rather than erroring.
- Whether the admissions and payroll rate-card migrations are applied (§14.8).

**Editorial and audience statements.** Reasonable, unfalsifiable from code: who each feature's users
are ("BeGifted admin staff", "sales-ops and GM", "a small set of granted tutors"), why a feature exists
(the SummitEd spreadsheet origin story, the "rollover is high-blast-radius" framing), and the PRD
decisions cited by ID in University Admissions (CM-xx requirement IDs and §n design sections were
checked only against the JSDoc headers that claim them, never against
`docs/Casemanagementsystem_prd.md`).

**Maturity labels.** Every `Status:` badge in `docs/features/*` — see GOV-1/GOV-2. No badge map was
supplied to any agent and no marker exists in code, so each badge is either inherited from the previous
revision of its own page or absent.

**Measurements this pass did not take.** Cold-index build latency (OPS-24); whether the `<Suspense>`
fallback on `/search` ever paints under Next 16 `cacheComponents`; the observable lag of the
sales-dashboard failed-import banner; real AI-scheduler turn latency (the only published number is an
offline eval on `gpt-5.5` while the code default is `gpt-5.4-mini`); print fidelity of the learning-plan
report (header repetition, row splitting); and whether the authored Mermaid diagrams render (§14.15).

---

## Completeness review (automated)

A mechanical completeness pass over the generated `docs/` tree (75 files, 71 of them `.md`). This
section records **gaps only** — it changes no other page and resolves nothing. Each item cites what
was actually inspected. Items already self-declared elsewhere in the docs are repeated here so they
are tracked in one list rather than only as prose asides.

### CR-1 — Five API reference pages do not exist; 40 broken relative links

`docs/reference/api/index.md` links five per-group detail pages that are absent from
`docs/reference/api/`: `competitor-intelligence.md`, `post-class-feedback.md`, `progress-tests.md`,
`student-schedule.md`, and `us-universities.md`. They are referenced from **40 distinct link sites**
(`index.md:38,47,48,54,57`, `:151-159`, `:241-253`, `:254-259`, `:291-292`, `:298-302`). A
resolve-every-relative-link sweep across all 71 markdown files found **these 40 and no others** — the
rest of the tree's internal links, including the URL-encoded `%5BrunId%5D` source links in
`classrooms-and-assignments.md`, all resolve. Consequence: **35 endpoints** (competitor-intelligence 9,
post-class-feedback 13, progress-tests 6, student-schedule 2, us-universities 5) appear in the master
table but have no request/response signature page anywhere. Acknowledged at `index.md:61` and
`docs/README.md:177-183`; the acknowledgement does not repair the links.

### CR-2 — Four navigable workspaces have no `features/*` page

`src/lib/navigation/tools.ts` registers 21 tools; `docs/features/` holds 18 pages. Missing:

| Workspace | Code weight | Endpoints | Scheduled |
|---|---|---|---|
| `/competitor-intelligence` | 3,747 LOC in `src/lib/competitor-intelligence/` (12 modules) | 8 route files | weekly cron `25 18 * * 0` (`vercel.json`) |
| `/progress-tests` | 4,563 LOC in `src/lib/progress-tests/` (17 modules) | 6 route files | 2 crons (`25,55 * * * *`, `35 0 * * *`) |
| `/us-universities` | 1,653 LOC in `src/lib/us-universities/`, 20 components | 5 route files | none |
| `/student-schedule` | 482 LOC in `src/lib/student-schedule/`, plus the public `/schedule/[token]` page | 2 route files | none |

Their tables *are* in `docs/reference/database/erd-core.md` (§2, §5, §6, §11) and their endpoints *are*
in the API master table, so this is a **meaning** gap, not a mechanical one: nothing states what these
features are for, what their business rules are, or what fails closed. Self-declared at
`docs/README.md:144-148`.

### CR-3 — The Home Hub landing page is undocumented and missing from the declared gap list

`src/app/(app)/page.tsx` is a real dashboard — it resolves a session, redirects a single-page
restricted user to `allowedPages[0]` (`page.tsx:12`), and renders `HomeHub` from
`getHomeSummaryPayload` (`src/lib/home/summary.ts`, 286 lines). `GET /api/home/summary` is documented
mechanically (`docs/reference/api/index.md:171`, `misc.md:172`), but no feature page owns the badge
computation or the redirect rule. The `README.md:144-148` coverage note names four missing workspaces;
Home is a fifth.

### CR-4 — Nine docs were not regenerated by this pass and carry no or mismatched footers

Comparing `git status` against the file list, these nine non-legacy pages are **unmodified** relative
to `HEAD` and none ends with `_Verified against HEAD + uncommitted WIP on 2026-05-31._`:

| Doc | Footer it carries instead |
|---|---|
| `docs/features/learning-plans.md` | `_Verified against production main on 2026-07-23._` |
| `docs/features/post-class-feedback.md` | `_Updated for the dedicated-tab payout design … on 2026-07-29._` |
| `docs/features/student-promotions.md` | *(none — file ends on a checklist item)* |
| `docs/features/university-admissions.md` | `_Verified against the feat/admissions worktree … on 2026-07-10._` |
| `docs/reference/api/student-promotions.md` | *(none)* |
| `docs/reference/api/university-admissions.md` | `_Verified against the route handlers … on 2026-07-10._` |
| `docs/reference/database/erd-student-promotions.md` | *(none — ends on an enum value list)* |
| `docs/reference/database/erd-university-admissions.md` | *(none — ends on an enum value list)* |
| `docs/reference/wise-api.md` | `_Verified against the release tree on 2026-07-21._` |

`wise-api.md` is the most consequential: `docs/README.md:67` names it the canonical home for the
external Wise contract, and it was not re-verified in this pass. The four `*-promotions` /
`*-admissions` pages are the only reference pages whose stated verification basis is a worktree rather
than `HEAD`. (The excluded legacy artifacts — `ai-scheduler-*`, `superpowers/**`,
`Casemanagementsystem_prd.md`, `casemanagementsystem_design.md`, the release checkpoint — are
correctly out of scope and are not counted here.)

### CR-5 — No local-development or first-run page anywhere in the tree

`grep` across all 71 markdown files returns **zero** occurrences of `npm run dev`, `localhost`, or
`.env.local`, although `package.json` defines `dev: next dev`. Nothing documents how to boot the app
locally, how to populate a local `.env`, whether the UI is usable against an empty `snapshots` table
(the whole read path assumes a promoted snapshot), or how to obtain a safe local database.
`docs/operations/runbook.md:130-188` covers test, `db:*`, and maintenance scripts only. This is the
single largest foundation gap for a new contributor, and the reading order in `docs/README.md:26-49`
has no step for it.

### CR-6 — No frontend/UI architecture page

`src/components/` holds **226 `.tsx` files across 25 feature directories**, plus 5 hooks in
`src/hooks/` and the OKLCH token system in `src/app/globals.css`. The UI layer is covered only in
passing: one row and one numbered step in `docs/handbook/architecture.md:37,304`, and three bullets in
`docs/handbook/conventions.md:31,239,247`. Nothing owns the Server-Component → client-shell →
`<Suspense>`/skeleton pattern as a *pattern*, the `src/components/{feature}/` vs `src/components/ui/`
split, or the design tokens. The `(print)` route group
(`src/app/(print)/learning-plans/report/page.tsx`, `src/app/(print)/student-schedule/report/page.tsx`)
appears exactly once in the whole tree, at `OPEN-QUESTIONS.md:275`, and has no page describing what a
print route is for.

### CR-7 — No database backup, restore, or disaster-recovery procedure

`docs/operations/runbook.md` §7 documents *snapshot* rollback and pruning — the app's own versioning
model — but a search for backup/restore/disaster/Neon-branch terminology across `docs/operations/`,
`docs/handbook/`, and `docs/reference/` returns no procedural page for the Postgres instance itself.
There is no answer to "the database is gone / corrupted / a migration went wrong in production, now
what". This sits awkwardly against the indefinite-retention decision recorded for University
Admissions and the Credit Control retention question at §10.

### CR-8 — Maturity vocabulary is self-declared and internally inconsistent

No authoritative maturity map was supplied to this pass and no status marker exists in code, which
`docs/README.md:76-98` states plainly. The consequence is a legend that its own table then violates:
the legend defines four levels (stable / experimental / legacy / in-progress), but Credit Control is
badged **`live`** (`README.md:131`) and Data Health **`deployed`** (`README.md:140`) — neither word is
in the legend — while Room Capacity and Leave Requests decline a badge entirely. Because nothing in
code carries the status, no test or guard can detect badge drift. Needs a human to fix the vocabulary
or to supply a real map.

### CR-9 — No testing-strategy page; the test topology is only partly covered

`docs/operations/runbook.md:135-148` documents the five npm test scripts, the vitest unit/integration
project split, the Docker/`testcontainers` prerequisite, and the pinned `TZ`. What no page owns: where
tests live (`__tests__/` siblings, never colocated), why the split exists, what the integration suites
actually cover, and what is deliberately *not* tested. Per-feature test notes are scattered instead —
e.g. `docs/features/sales-dashboard.md:221` records that `sales-dashboard/data.ts` is exercised by no
test at all, a finding that belongs in a coverage narrative rather than buried in one feature page.

### CR-10 — `extensions/line-oa-resolver/` has no documentation

Seven files (`manifest.json`, `background.js`, `content.js`, `popup.{html,js}`, `candidate-utils.js`,
and its own `README.md`), referenced from `oa-resolver-dialog.tsx:315-317`, with no handbook, feature,
or reference coverage. Already raised as item 12 in the closing list above; repeated here because it
is a shipped code surface, not merely an open question.

### Verified as *not* gaps

Checks that were run and came back clean, recorded so they are not re-litigated:

- **Endpoint count.** `index.md:5` claims 178 `route.ts` files and 241 method+path endpoints.
  Confirmed: `find src/app/api -name route.ts` → 178; 239 single-name `export … (GET|POST|PATCH|PUT|DELETE)`
  plus the destructured `export const { GET, POST }` in the Auth.js catch-all → 241.
- **Table and enum counts.** `docs/reference/database/index.md:3` claims 188 tables in a 4,719-line
  `schema.ts`; both confirmed by count. `enums.md` documents 61 enums against 61 `pgEnum(` declarations.
- **API group directory.** All 28 directories under `src/app/api/` appear in the `index.md` group table.
- **Cron coverage.** All 15 `vercel.json` entries are present in `docs/reference/crons.md`.
- **Learning Plans has no API group** — correct that no `reference/api/learning-plans.md` exists;
  `find src/app/api -path "*learning*" -name route.ts` returns nothing.
- **No empty or placeholder pages.** The thinnest generated files are
  `docs/reference/api/student-promotions.md` (1,114 words) and
  `docs/features/learning-plans.md` (1,222 words); both are substantive, and the former covers all
  8 `/api/student-promotions/*` route files plus both July-1 internal methods. No file is a stub.

---

## Completeness review (automated)

**Second pass.** This section is an independent completeness sweep of the `docs/` tree run after the
CR-1…CR-10 list above; it supersedes that list where marked and retires two of its items as stale. It
records **gaps only** and rewrites nothing else. Every claim below was produced by resolving links,
diffing doc contents against code inventories, or scanning file tails — not from the earlier review.
Scope: 78 files under `docs/`, 74 of them `.md`; the excluded legacy artifacts (`ai-scheduler-*`,
`superpowers/**`, `Casemanagementsystem_prd.md`, `casemanagementsystem_design.md`) are not counted.

### G1 — 40 broken links in `reference/api/index.md` — but the content they point at *does* exist

The Group directory and the per-group cross-references in `docs/reference/api/index.md` link five
detail pages that are absent from `docs/reference/api/`: `competitor-intelligence.md`,
`post-class-feedback.md`, `progress-tests.md`, `student-schedule.md`, `us-universities.md`. A
resolve-every-relative-link sweep across all 74 markdown files found **42 broken links**: these 40,
plus the 2 in G2. Nothing else in the tree fails to resolve.

**This corrects CR-1 above and the "Gap" note at `docs/README.md:214-219`.** Those 35 endpoints are
*not* undocumented. `docs/reference/api/misc.md:3` states it covers **127 endpoints across seventeen
path families**, and all five groups have full signature sections there — Student schedule
(`misc.md:319`), Progress tests (`:338`), Post-class feedback (`:369`), Competitor intelligence
(`:462`), US universities (`:583`). The gap is **mis-routing**, not missing content: a reader who
follows the Group column lands on a 404 instead of the section that already answers the question. Fix
is either repointing those rows at `misc.md#<anchor>` or splitting `misc.md` into the five named
files. Until then the docs contradict themselves about whether the coverage exists.

### G2 — Two malformed source links in `features/progress-tests.md`

Two links escape their own parentheses — the target is written as `../../src/app/%28app%29/…`, so the
markdown target truncates at `../../src/app/\(app\` and resolves nowhere. Both are on the same page;
the identical `src/app/(app)/…` paths are linked correctly elsewhere in the tree.

### G3 — Two API groups have two canonical homes with different verification dates

`student-promotions` (9 endpoints) and `university-admissions` (61 endpoints) are documented **in
full twice**: in `misc.md` (§Student promotions `misc.md:517`, §University admissions `misc.md:620`)
*and* on their own pages `reference/api/student-promotions.md` (202 lines) and
`reference/api/university-admissions.md` (499 lines). This violates the one-canonical-home rule the
handbook sets at `docs/README.md:73`. It is worse than ordinary duplication because the two copies
were verified against different trees — `misc.md` carries the current footer, while the dedicated
pages carry no footer and a `2026-07-10` footer respectively (see G4). Nothing detects divergence
between them. A human has to pick which copy is authoritative and delete or stub the other.

### G4 — Five in-scope reference pages do not carry the current verification footer

Confirmed by scanning the last line of every `.md` file:

| Doc | Footer it carries |
|---|---|
| `docs/reference/wise-api.md` | `_Verified against the release tree on 2026-07-21._` |
| `docs/reference/api/university-admissions.md` | `_Verified against the route handlers … on 2026-07-10._` |
| `docs/reference/api/student-promotions.md` | *(none — ends on a prose paragraph)* |
| `docs/reference/database/erd-student-promotions.md` | *(none — ends on an enum value list)* |
| `docs/reference/database/erd-university-admissions.md` | *(none — ends on an enum value list)* |

`wise-api.md` is the consequential one: `docs/README.md:88` names it the canonical home for the
entire external Wise contract, and it was not re-verified in this pass.
`operations/release-checkpoints/2026-06-04-reconcile-live-production.md` also has no footer, but that
is by design (`docs/README.md:262` declares it historical and not regenerated) and is not counted
here. This item narrows CR-4, which listed nine pages: the four `features/*` pages it named have
since been regenerated and now carry the current footer.

### G5 — The Home Hub at `/` still has no `features/*` page

Unchanged from CR-3, re-verified: `src/app/(app)/page.tsx` resolves a session, redirects a restricted
user to `allowedPages[0]`, and renders `HomeHub` from `src/lib/home/summary.ts`. Only the mechanical
endpoint is documented (`GET /api/home/summary`, `misc.md:186`). No page owns the badge computation,
the redirect rule, or what the hub is for. It is the one navigable surface with no feature page —
`docs/README.md:179-185` acknowledges this.

### G6 — No testing-strategy page

Unchanged from CR-9. The repo holds **369** `*.test.ts(x)` files and two Vitest projects with a
`testcontainers`-backed integration lane; `docs/operations/runbook.md` documents *how to run* them,
but no page owns where tests live, why the unit/integration split exists, what the integration suites
cover, or what is deliberately untested. There is no `docs/handbook/testing.md` — the handbook has
exactly six pages, none about tests.

### G7 — No local-development / first-run page

Largely unchanged from CR-5. `npm run dev` appears **nowhere** in `docs/` outside this file, although
`package.json` defines it. `.env.local` is now mentioned twice, but only as an aside about scripts
that hand-parse it (`reference/env.md:246`, `:315`). Nothing states how to boot the app locally, how
to seed or point at a database, or whether the UI works at all against an empty `snapshots` table —
which matters here more than in most repos, because the entire tutor read path assumes a promoted
snapshot. The reading order at `docs/README.md:36-64` has no step for it.

### G8 — No frontend/UI architecture page (narrowed from CR-6)

CR-6's specific examples are now stale: the `(print)` route group is well covered
(`features/learning-plans.md:20,76`, `features/student-schedule.md:124-126`) and `src/hooks/` is
covered in `features/tutor-compare.md:61-95`. What remains missing is a page owning the
`src/components/` layer *as a layer*: the Server-Component → client-shell → `<Suspense>`/skeleton
pattern, the `src/components/{feature}/` vs `src/components/ui/` split, and the OKLCH token system in
`src/app/globals.css`. Those appear only as scattered bullets in `handbook/architecture.md` and
`handbook/conventions.md`.

### G9 — No database backup, restore, or disaster-recovery procedure

Unchanged from CR-7. `operations/runbook.md` covers *snapshot* rollback — the app's own versioning
model — but no page in `operations/`, `handbook/`, or `reference/` answers "the Postgres instance is
corrupted or a production migration went wrong". No Neon-branch, PITR, or `pg_dump` procedure exists
anywhere in the tree.

### G10 — Eight npm scripts and four `scripts/` files are documented nowhere

Diffing `package.json` scripts against the whole `docs/` tree: **8 of 30 npm scripts appear in no
document at all** — `payout:inventory`, `payout:setup-master-tabs`, `payout:repoint-workbooks`,
`payout:restore-workbooks`, `payout:derive-tutor-names`, `payout:roll-workbooks`,
`credit-control:seed-admin-ownership`, `tutor-profiles:seed`. **14 of 30 appear nowhere in
`operations/runbook.md`**, the page that claims the operator-procedure ground.

The six `payout:*` scripts are the sharp edge: they run outside the Next runtime against live Google
Sheets payout workbooks (`scripts/repoint-payout-workbook-formulas.ts`,
`scripts/restore-payout-workbook-formulas.ts`, `scripts/roll-payout-workbook-dates.ts`), i.e. they
mutate production finance artifacts with no documented preconditions, dry-run, or rollback. Four
files under `scripts/` are likewise never mentioned: `backlog-recovery-dry-run.ts`,
`evaluate-ai-scheduler-2026-05-21.ts`, `list-payout-workbooks.gs`, `seed-tutor-business-profiles.ts`.

### G11 — `reference/` has an external-contract page for Wise only

`reference/wise-api.md` is the sole reference-tier page for an outside system. The three other
external contracts have no peer page, and their mechanical detail sits in `features/*` instead —
inverting the canonical-home rule at `docs/README.md:73`:

| Contract | Client code | Where the mechanics currently live |
|---|---|---|
| Google Sheets + Drive REST | `src/lib/sales-dashboard/sheets.ts`, `src/lib/sales-dashboard/google-oauth.ts`, `src/lib/post-class-feedback/drive.ts` | `features/sales-dashboard.md:13-18,178-179` (which explicitly claims ownership of the layer) |
| OpenAI Responses API (7 call sites) | `src/lib/ai/*`, `src/lib/line/*`, `src/lib/post-class-feedback/ai.ts`, `src/lib/progress-tests/ai-summary.ts`, `src/lib/competitor-intelligence/ai.ts` | `features/ai-scheduler.md:69`, `reference/api/ai-scheduler.md:253`, `reference/env.md:134` |
| LINE Messaging API (push/reply) | `src/lib/line/client.ts`, `src/lib/line/schedule-bot.ts` | `features/line-integration.md:119,137,181` |

The content is good; the question is whether `reference/` should own it, or whether `wise-api.md`
should be reframed as the one external contract that earns a page.

### G12 — `internal-crons.md` disclaims 5 of 21 internal routes without linking their homes

`reference/api/index.md` routes the whole `internal` group (30 endpoints) to
`reference/api/internal-crons.md`, which covers 24 and states at `internal-crons.md:7` that
`sync-sales-dashboard`, `sync-wise-activity`, `sync-room-utilization`,
`class-assignments/morning`, and `class-assignments/admin-email` "are documented with their owning
features" — without naming or linking those pages. All five *are* in `reference/crons.md`, so this is
a navigation dead-end rather than missing content.

### G13 — `docs/README.md`'s description of `misc.md` is stale

`docs/README.md:212` says `misc.md` covers "search, tutors, filters, compare, home, data-health,
leave-requests, tutor-profiles, auth, admin" — 10 families. The page itself declares 17 families and
127 endpoints (`misc.md:3-27`), including the five groups the README's very next paragraph calls
undocumented. Same paragraph (`README.md:214-219`) asserts the five pages are "named here without
links so this page has no broken links": true of README, false of `index.md` (see G1).

### Retired as stale from the CR list above

- **CR-2** (four navigable workspaces with no `features/*` page) — resolved.
  `competitor-intelligence.md`, `progress-tests.md`, `student-schedule.md`, and `us-universities.md`
  all exist. All 21 nav tools in `src/lib/navigation/tools.ts` now have a feature page; only the Home
  Hub does not (G5). `docs/README.md:183-185` already flags CR-2 as stale.
- **CR-10** (`extensions/line-oa-resolver/` undocumented) — resolved.
  `features/line-integration.md:14` documents the MV3 extension, its per-run bearer-token auth, and
  both endpoints it calls, citing `manifest.json`, `popup.js`, and `content.js`.

### Re-verified as *not* gaps in this pass

- **Table coverage.** All 188 `pgTable(` names in `src/lib/db/schema.ts` appear in
  `reference/database/index.md` **and** in at least one `erd-*.md` page. Zero orphans either way.
- **Route coverage.** All 178 `src/app/api/**/route.ts` paths appear in `reference/api/index.md`.
- **Cron coverage.** All 15 `vercel.json` entries and all 21 `/api/internal/*` route files appear in
  `reference/crons.md`.
- **Feature-page wiring.** Every one of the 22 `features/*.md` pages links into `../reference/`, and
  every one is named in both `docs/README.md` and `handbook/overview.md`. No orphaned feature page.
- **No stubs.** The thinnest in-scope page is `handbook/overview.md` at 69 lines / 20 KB — long lines,
  not thin content. No file in the tree is empty or a placeholder.
- **Headline counts reproduce.** `docs/README.md:24-32` claims 188 tables, 178 route files, 25 `(app)`
  pages, 21 nav tools, 15 crons, 65 migrations (latest `drizzle/0064_line_group_settings.sql`), and
  369 test files. Each was recounted from the tree and matches.

---

_Verified against HEAD + uncommitted WIP on 2026-05-31._
