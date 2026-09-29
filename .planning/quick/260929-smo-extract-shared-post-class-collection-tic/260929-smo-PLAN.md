---
phase: quick-260929-smo
plan: "01"
type: execute
wave: 1
depends_on: [quick-260929-nwm, quick-260929-rcx]
files_modified:
  - src/lib/post-class-feedback/collection-tick.ts
  - src/lib/post-class-feedback/__tests__/collection-tick.test.ts
  - src/app/api/internal/sync-post-class-feedback/route.ts
  - src/app/api/internal/sync-post-class-feedback/__tests__/route.test.ts
  - src/lib/data-health/run-job.ts
  - src/lib/data-health/__tests__/run-job.test.ts
  - src/app/api/post-class-feedback/sync/route.ts
  - src/app/api/post-class-feedback/sync/__tests__/route.test.ts
  - src/lib/post-class-feedback/auto-approval.ts
  - src/lib/post-class-feedback/ai.ts
  - src/lib/post-class-feedback/__tests__/ai.test.ts
  - docs/reference/api/post-class-feedback.md
  - docs/reference/api/internal-crons.md
  - docs/features/post-class-feedback.md
  - docs/reference/crons.md
  - docs/reference/api/data-health.md
  - docs/reference/api/index.md
  - docs/OPEN-QUESTIONS.md
autonomous: true
requirements: [SMO-ONE-TICK, SMO-CALL-SITES, SMO-DELEGATION-TESTS, SMO-OBSERVABILITY, SMO-DOCS, SMO-AI-TIMEOUT]
quick_id: 260929-smo
branch: fix/post-class-collection-tick
base: fix/data-health-post-class-run-parity 871cebc (stacked on fix/data-health-run-dispatch 10d68b7, on origin/main 7788eaf; merge those two first)
worktree: /Users/kevinhsieh/Developer/Scheduling-collection-tick
must_haves:
  truths:
    - "One function, runPostClassCollectionTick(options), runs runPostClassFeedbackSync(options) and only after it resolves runs processPostClassAiReviews(), processDuePostClassNotificationRetries() and runPostClassDeductionHygiene() in one Promise.allSettled, returning { ok: true, result, ai, retries, hygiene } with { failed: true } per rejected pass"
    - "runPostClassCollectionTickRequest(options) wraps it with the cron's mapping: 200 body; PostClassFeedbackSyncAlreadyRunningError -> 409 { error: <its message> }; anything else -> 500 { error: \"Post-class feedback sync failed\" } without the thrown text"
    - "The cron route, Data Health's post_class_feedback branch and the page's collect mode each call the shared tick; none keeps its own copy of the sync or the passes"
    - "The page's collect mode now runs deduction hygiene; its error mapper (postClassFeedbackErrorResponse) and its reassess mode are unchanged"
    - "A rejected pass logs console.error(\"[post-class-collection-tick]\", { pass, errorName }); a non-typed sync failure on the cron/Data Health path logs { pass: \"sync\", errorName }; no log carries a message, body, SQL or parameters"
    - "The existing Data Health parity cases in run-job.test.ts pass unchanged, now through the real shared tick"
  artifacts:
    - { path: "src/lib/post-class-feedback/collection-tick.ts", provides: "runPostClassCollectionTick + runPostClassCollectionTickRequest", contains: "Promise.allSettled" }
    - { path: "src/lib/post-class-feedback/__tests__/collection-tick.test.ts", provides: "sequencing, per-pass isolation + logging, error mapping" }
    - { path: "src/app/api/post-class-feedback/sync/__tests__/route.test.ts", provides: "page route delegation + unchanged mapper + reassess never ticks" }
    - { path: "src/app/api/internal/sync-post-class-feedback/__tests__/route.test.ts", provides: "cron delegation inside the audit wrapper" }
  key_links:
    - { from: "src/app/api/internal/sync-post-class-feedback/route.ts", to: "collection-tick.ts", via: "runPostClassCollectionTickRequest({ triggerType: \"cron\" })" }
    - { from: "src/lib/data-health/run-job.ts", to: "collection-tick.ts", via: "runPostClassCollectionTickRequest({ triggerType: \"manual\", actorEmail })" }
    - { from: "src/app/api/post-class-feedback/sync/route.ts", to: "collection-tick.ts", via: "runPostClassCollectionTick({ triggerType: \"manual\", actorEmail, detailCap, startDate, endDate })" }
---

<objective>
The post-class "collection tick" (sync, then AI review + notification retries + deduction hygiene under
`Promise.allSettled`, `{ failed: true }` per rejected pass, typed 409, generic 500) is hand-copied in the
cron route, in Data Health's `run-job.ts`, and in the page's `POST /api/post-class-feedback/sync` collect
mode. The page copy has already drifted: it skips `runPostClassDeductionHygiene`. Extract one shared
function, call it from all three sites, test it once, and log the failures that today leave no trace.
</objective>

<context>
**Worktree only.** Every command runs as
`cd /Users/kevinhsieh/Developer/Scheduling-collection-tick && export PATH="/opt/homebrew/opt/node@22/bin:$PATH" && …`.
Never touch `/Users/kevinhsieh/Developer/Scheduling` (someone else's uncommitted work) or the two base
worktrees. Stage explicit paths only. No push, no PR (a PR must be a draft until reviewed — money path).

Base: `fix/data-health-post-class-run-parity` (quick 260929-rcx), which already made run-job.ts mirror the
cron. Neither base branch has reached origin/main; this branch is stacked on both and must merge after them.
origin/main has moved 9 commits (autowriter only, #95-#97); none touches a file in this plan.

`src/app/api/internal/` is CODEOWNERS-protected — Kevin reviews the cron route and its new test.

Pattern to follow: `src/lib/{credit-control,progress-tests}/run-sync-request.ts` — a domain lib function that
returns the `NextResponse` both the cron route (inside `withCronInvocationAudit`) and `runDataHealthJob`
return verbatim.

<interfaces>
- `runPostClassFeedbackSync(options: SyncPostClassFeedbackOptions)` → `SyncPostClassFeedbackResult` (sync.ts:1089). Throws before any run row for an unset `WISE_INSTITUTE_ID` (:1093) or a `beginSync` error; after the row exists it records `failSync` and rethrows `new Error(errorSummary)`.
- `PostClassSyncTrigger = "cron" | "manual"` and `PostClassFeedbackSyncAlreadyRunningError` (repository.ts:224, :377; thrown at :903 lease deferral, :909 unique violation).
- `processPostClassAiReviews(options = {}, db)` → `{ processed, failed, skipped }`; model errors are caught per review, so only DB-level errors reject the pass.
- `processDuePostClassNotificationRetries(options = {})` → `{ considered, sent, failed, cancelled, deferred }`.
- `runPostClassDeductionHygiene(db)` → `{ reopened, reopenFailed, waived, waiveFailed }` (auto-approval.ts:286).
- `postClassFeedbackErrorResponse(route, error, fallback)` (api.ts:12) — does not list the already-running error, so on the page it stays a 500 (documented; unchanged by decision).
- `withCronInvocationAudit` `determineOutcome` (cron-audit.ts:108): `outcome: "partial"` → `failed`.
</interfaces>
</context>

<decisions>
- **Two layers.** `runPostClassCollectionTick` returns the body and lets a sync error propagate;
  `runPostClassCollectionTickRequest` adds the cron's HTTP mapping. The page calls the first, inside its own
  try, so its error mapper stays; the cron and Data Health return the second verbatim.
- **Options type** = `{ triggerType: PostClassSyncTrigger }` (required) plus `actorEmail`, `detailCap`,
  `startDate`, `endDate` picked from `SyncPostClassFeedbackOptions`. Reminder-checkpoint fields are excluded:
  a checkpoint sync is not a tick. The options object is passed to the sync unchanged.
- **Logging** ("whoever swallows an error logs it"): the core tick logs each rejected pass; the Request layer
  logs the non-typed sync failure it turns into the generic 500 (this covers failures before the run row
  exists). The typed 409 is not logged (its message is in the body and the audit). The page's sync failures are
  already logged by its mapper as `{ errorName }`, so the core does not log them (no double log). Format:
  `console.error("[post-class-collection-tick]", { pass, errorName })`, `errorName = error instanceof Error ?
  error.name : "UnknownError"` (the api.ts idiom). Never the message.
- **Response contract unchanged**: no `failedPasses`, no `outcome: "partial"` — left as a question for the user.
- **Reassess does not need hygiene.** Hygiene waives `pending_review` deductions on `eligible = false` sessions
  and reopens approved, unwritten deductions whose current evidence no longer supports a charge. Reassess never
  writes eligibility (it only reads eligible, ready, undeleted sessions), and when it clears a violation it
  waives that session's pending or approved unwritten deduction itself (`waiveClearedDeduction`, reassess.ts:311;
  `applyPostClassReviewAction` allows waive from approved, actions.ts:494). The residual — a waive that throws —
  is counted in `failed`, and the next cron tick (≤30 min) or the accrual sweep before any payout preview
  reopens it before money moves. Reassess stays unchanged.
- **Data Health test uses a pass-through spy**: `vi.mock(collection-tick, importOriginal → { ...actual,
  runPostClassCollectionTickRequest: vi.fn(actual.runPostClassCollectionTickRequest) })`. Vitest 4's
  `mockReset` restores a `vi.fn(impl)` to `impl`, so the existing parity cases keep running the real tick over
  the mocked sync and passes, unchanged, while a new case asserts the delegation.
- **Cron route test** is added (the cron had none); it is small and pins the protected route's wiring.
</decisions>

<tasks>
<task type="auto" tdd="true">
  <name>Task 1: One shared collection tick (RED test first, then the module)</name>
  <files>src/lib/post-class-feedback/__tests__/collection-tick.test.ts, src/lib/post-class-feedback/collection-tick.ts</files>
  <action>
    Write the test first (RED: module missing). Mock server-only, sync, ai, notifications, auto-approval and
    repository (stub `PostClassFeedbackSyncAlreadyRunningError`); spy on console.error. Cases:
    (1) options object reaches the sync unchanged; no pass starts while the sync is pending; each pass called
    once with no args after it resolves; body equals distinct fixtures; nothing logged.
    (2) it.each ai/retries/hygiene rejecting with a distinct Error subclass → that key `{ failed: true }`, others
    intact, one log `{ pass, errorName }`, message absent from every log argument.
    (3) all three rejecting → three logs, `ok: true`, `result` intact; a non-Error rejection → `UnknownError`.
    (4) sync rejects → the tick rejects with the same error, no pass runs, nothing logged.
    (5) Request: 200 + body for `{ triggerType: "cron" }` (passed through); a rejected pass is still a 200.
    (6) Request: typed error → 409 with its message (default and lease message), no log, no pass.
    (7) Request: `WISE_INSTITUTE_ID is not configured`, a driver error, and an untyped "advisory lock already
    running" → 500 `{ error: "Post-class feedback sync failed" }`, one `{ pass: "sync", errorName }` log, message
    in neither body nor log.
    Then write collection-tick.ts (`import "server-only"`, em-dash section header, JSDoc with numbered steps).
  </action>
  <verify>npx vitest run --project unit src/lib/post-class-feedback/__tests__/collection-tick.test.ts fails before the module exists and passes after; npm run typecheck exits 0</verify>
  <done>Helper + test committed together as one commit; RED evidence recorded in SUMMARY</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Call the tick from all three sites (delegation tests RED first)</name>
  <files>src/lib/data-health/__tests__/run-job.test.ts, src/lib/data-health/run-job.ts, src/app/api/post-class-feedback/sync/__tests__/route.test.ts, src/app/api/post-class-feedback/sync/route.ts, src/app/api/internal/sync-post-class-feedback/__tests__/route.test.ts, src/app/api/internal/sync-post-class-feedback/route.ts, src/lib/post-class-feedback/auto-approval.ts</files>
  <action>
    Tests first. run-job.test.ts: pass-through spy mock (see decisions), `DISPATCH_TARGETS.post_class_feedback`
    → the Request spy, one new case (returns the tick's response verbatim for `{ triggerType: "manual",
    actorEmail: OWNER }`, and `runPostClassFeedbackSync` is not called by run-job itself), silence console.error;
    every existing parity case untouched. New page route test (mock access with a stub `PostClassAccessError`,
    collection-tick, reassess; keep the real api.ts mapper): empty body → tick with `{ triggerType: "manual",
    actorEmail, detailCap/startDate/endDate undefined }` and its body verbatim; Backfill-dialog body passes range +
    cap through; half-open range → 400, no tick; tick rejection → the page mapper's 500 "Could not sync
    post-class feedback." without the thrown text; access error → its status, nothing runs; reassess → never
    ticks, response unchanged. New cron route test: delegates `{ triggerType: "cron" }` inside
    `withCronInvocationAudit({ jobKey: "post_class_feedback", triggerSource: "cron", requestMethod: "GET" })` and
    returns its response verbatim; a rejected secret returns before the audit and the tick.
    Then: cron route → one-line delegation; run-job branch → `return runPostClassCollectionTickRequest({
    triggerType: "manual", actorEmail })` and drop the now-unused imports; page collect → `return
    NextResponse.json(await runPostClassCollectionTick({...}))` inside the existing try; auto-approval.ts JSDoc
    "(sync-post-class-feedback route)" → "(collection-tick.ts)" on the same line.
  </action>
  <verify>RED: new cases fail on the old call sites. GREEN: npx vitest run --project unit src/lib/data-health src/lib/post-class-feedback src/app/api/post-class-feedback src/app/api/internal/sync-post-class-feedback src/app/api/internal/post-class-feedback-backfill; npm run typecheck; npm run lint</verify>
  <done>No call site keeps its own sync/pass code; all parity cases green unchanged; one commit</done>
</task>

<task type="auto">
  <name>Task 3: Docs for the shared tick</name>
  <files>docs/reference/api/post-class-feedback.md, docs/reference/api/internal-crons.md, docs/features/post-class-feedback.md, docs/reference/crons.md, docs/reference/api/data-health.md, docs/reference/api/index.md, docs/OPEN-QUESTIONS.md</files>
  <action>
    Collect mode's response gains `hygiene`; all three routes are described as running the one tick
    (collection-tick.ts), with the logging; fix every citation this change made stale (sync/route.ts line ranges,
    cron route.ts:22-42, run-job.ts). Keep the page's 409-as-500 note (unchanged). OPS-13 cites the new file and
    notes the class-only log. No drift fixes this change did not cause.
  </action>
  <verify>grep for stale "route.ts:22-30|route.ts:39-4|sync/route.ts:85-94|{ok: true, result, ai, retries}" hits nothing; every new citation resolves to the named code; git diff --check clean</verify>
  <done>One docs commit</done>
</task>

<task type="auto" tdd="true">
  <name>Task 4 (optional, separate commit): time out the post-class quality-model call</name>
  <files>src/lib/post-class-feedback/ai.ts, src/lib/post-class-feedback/__tests__/ai.test.ts</files>
  <action>
    `callQualityModel` fetch gets `signal: AbortSignal.timeout(30_000)` (named constant). A timeout rejects inside
    the per-review try, so the run row is marked failed with "AI quality review failed" like any model error.
    Test (RED first): fake chainable db, one short-field (suspect) candidate, stubbed fetch rejecting with a
    TimeoutError, spy on AbortSignal.timeout → called with 30_000 and its signal is the one fetch received;
    result `{ processed: 0, failed: 1, skipped: 0 }`; failed-status update payload recorded.
  </action>
  <verify>npx vitest run --project unit src/lib/post-class-feedback/__tests__/ai.test.ts; typecheck; lint</verify>
  <done>Separate commit; docs mention the 30s bound (worst case 10 reviews x 30s = 300s)</done>
</task>
</tasks>

<verification>
- npm run typecheck, npm run lint, the affected Vitest files, full `npm test`
- `npm run test:integration` (Docker available) — the post-class suites cover auto-approval.ts
- No `.only`/`.skip`/TODO/placeholder in changed files; `git diff --check`
- Independent code review (separate agent) before reporting done
</verification>

<open_question_for_user>
Rejected passes stay `200` + `{ failed: true }` (now logged). Should the body also carry `failedPasses`, or
`outcome: "partial"` (which the audit maps to `failed`, turning Data Health red)? Note: an OpenAI outage does
not reject the AI pass (model errors are caught per review); only pass-level DB/infra errors do.
</open_question_for_user>
