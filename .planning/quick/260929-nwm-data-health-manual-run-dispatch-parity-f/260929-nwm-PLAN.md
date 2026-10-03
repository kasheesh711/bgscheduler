---
phase: quick-260929-nwm
plan: "01"
type: execute
wave: 1
depends_on: []
files_modified:
  - src/lib/data-health/cron-registry.ts
  - src/lib/data-health/dashboard.ts
  - src/lib/data-health/__tests__/cron-registry.test.ts
  - src/lib/data-health/run-job.ts
  - src/lib/data-health/__tests__/run-job.test.ts
  - docs/features/data-health.md
  - docs/reference/api/data-health.md
  - docs/reference/crons.md
  - docs/reference/api/internal-crons.md
  - docs/OPEN-QUESTIONS.md
  - docs/features/line-credit-bot.md
  - docs/features/progress-tests-legacy.md
  - docs/features/student-promotions.md
  - docs/reference/api/student-promotions.md
  - docs/operations/runbook.md
autonomous: true
requirements:
  - DEF3-EXCLUDE-PROMOTIONS
  - DEF3-FAIL-CLOSED-GUARD
  - DEF3-DISPATCH-PARITY
  - DEF3-REGRESSION-TEST
  - DEF3-DOCS
quick_id: 260929-nwm
branch: fix/data-health-run-dispatch
base: origin/main 29aa114
worktree: /Users/kevinhsieh/Developer/Scheduling-run-dispatch

must_haves:
  truths:
    - "Every Run button Data Health renders dispatches its job. For every registry key without `manualRunDisabledReason`, `runDataHealthJob(key, owner)` returns a status below 400, never returns the body `{ error: \"Unknown job\" }`, reaches that job's library entry point, and is audited as `triggerSource: \"admin\"` with the actor's email"
    - "Each of the nine new branches (tutor_sit_ins, tutor_sit_ins_digest, unearned_revenue, progress_tests, progress_tests_digest, post_class_feedback_backfill, admissions_notifications, line_credit_digest, line_backlog_recovery) has the same composition and status mapping as its /api/internal cron route, and passes `triggerType: \"manual\"` and the actor email where the library accepts them"
    - "`student_promotions_july_1` gets no Run button: `canRunManually` is false and the job is absent from `manualActions`. A direct POST, after the dangerous-job confirmation, gets 409 whose `error` is the job's `manualRunDisabledReason`, and writes no `cron_invocations` row"
    - "Adding a registry key without a dispatch branch fails `npm run typecheck` (via the `satisfies Record<ManualRunKey, unknown>` table) and also fails the unit suite (via runtime set equality)"
    - "Existing Data Health, classroom pause/access, admissions-notifications route and post-class backfill route suites pass without edits"
    - "No doc still claims that a Data Health button returns 404, or that line_backlog_recovery, the progress-test keys or the LINE credit digest cannot be run from Data Health. DEF-3 is recorded FIXED in OPEN-QUESTIONS §0"
  artifacts:
    - path: "src/lib/data-health/cron-registry.ts"
      provides: "optional `manualRunDisabledReason` field (set only on student_promotions_july_1) plus the shared `isManuallyRunnable` predicate"
      exports: ["isManuallyRunnable"]
      contains: "manualRunDisabledReason"
    - path: "src/lib/data-health/dashboard.ts"
      provides: "canRunManually and manualActions both derived from isManuallyRunnable"
      contains: "canRunManually: isManuallyRunnable(job)"
    - path: "src/lib/data-health/run-job.ts"
      provides: "409 refusal before the audit wrapper, plus the nine new dispatch branches"
      contains: "if (job.manualRunDisabledReason)"
    - path: "src/lib/data-health/__tests__/run-job.test.ts"
      provides: "dispatch-parity regression test, checked at compile time and at runtime"
      contains: "satisfies Record<ManualRunKey, unknown>"
    - path: "src/lib/data-health/__tests__/cron-registry.test.ts"
      provides: "pinned exclusion list and isManuallyRunnable truth table"
      contains: "isManuallyRunnable"
    - path: "docs/OPEN-QUESTIONS.md"
      provides: "DEF-3 FIXED entry in §0"
      contains: "DEF-3 (Data Health"
  key_links:
    - from: "src/lib/data-health/dashboard.ts"
      to: "src/lib/data-health/cron-registry.ts isManuallyRunnable"
      via: "manualActions filter over the effectiveCronJob view, plus per-row canRunManually"
      pattern: "filter\\(isManuallyRunnable\\)"
    - from: "src/lib/data-health/run-job.ts runDataHealthJob"
      to: "CronJobDefinition.manualRunDisabledReason"
      via: "409 refusal placed after the registry lookup, before the owner gate and before withCronInvocationAudit"
      pattern: "if \\(job\\.manualRunDisabledReason\\)"
    - from: "src/lib/data-health/__tests__/run-job.test.ts"
      to: "src/lib/data-health/cron-registry.ts CRON_JOBS"
      via: "ManualRunKey type derived from the as-const registry, plus a runtime set-equality check"
      pattern: "Exclude<\\(typeof CRON_JOBS\\)\\[number\\], \\{ manualRunDisabledReason: string \\}>"
    - from: "src/components/data-health/data-health-dashboard.tsx runJob"
      to: "payload.manualActions"
      via: "the client only runs keys present in manualActions (unchanged), which is why filtering the dashboard hides the button"
      pattern: "data\\.manualActions\\.find"
---

<objective>
Close DEF-3 so that every Run button Data Health offers really dispatches its job. The plan does four things:

- Adds the nine missing `runDataHealthJob` branches, each mirroring its cron route.
- Excludes the annual Wise-writing `student_promotions_july_1` through a new registry field: it gets no button, and a direct call gets a fail-closed 409 before the audit wrapper.
- Pins dispatch parity with a regression test that fails both at compile time and at runtime.
- Corrects the docs that describe the old 404 behaviour.

Purpose: at 29aa114, 10 of the 32 registry keys have no branch. They fall through to `404 {error:"Unknown job"}` inside `withCronInvocationAudit`, so every click fails and also writes a `failed` `triggerSource:"admin"` row to `cron_invocations`. Two of these buttons, `post_class_feedback_backfill` and `line_backlog_recovery`, are the only manual recovery levers their features have.

Output: two lib files and the dashboard changed, one test extended, one new test, and targeted spot-edits in 10 docs. Three commits on `fix/data-health-run-dispatch`.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
## Worktree rules (non-negotiable)

- **Repo root.** `/Users/kevinhsieh/Developer/Scheduling-run-dispatch` is a git worktree on branch `fix/data-health-run-dispatch`, based on origin/main 29aa114.
  - The shell cwd resets on every call, so start every Bash call with `cd /Users/kevinhsieh/Developer/Scheduling-run-dispatch && export PATH="/opt/homebrew/opt/node@22/bin:$PATH" && ...` (Node 22).
  - Use absolute paths for every Read and Edit.
  - NEVER read, edit, or run git in `/Users/kevinhsieh/Developer/Scheduling`. It is a different checkout that holds someone else's uncommitted work.
- **Pre-flight.** `git -C /Users/kevinhsieh/Developer/Scheduling-run-dispatch status --short --branch` must show `## fix/data-health-run-dispatch` and nothing modified outside `.planning/quick/260929-nwm-*`. `node_modules` is already installed.
- **Out of bounds.**
  - `src/app/api/internal/**`: CODEOWNERS-protected, and its route tests mock the libraries wholesale.
  - `src/app/api/data-health/jobs/[jobKey]/run/route.ts`: no route-level duplicate of the refusal (Decision B).
  - `vercel.json`, migrations, `src/lib/db/**`, env vars, package files, `CLAUDE.md`, `AGENTS.md`.
  - Do NOT create `src/lib/data-health/__tests__/dashboard.test.ts`. The unpushed branch `fix/missing-table-sqlstate` adds that exact file, so creating it here would cause an add/add conflict.
- **CODEOWNERS.** `src/lib/data-health/cron-registry.ts` is protected (`@kasheesh711`). Editing it is fine; Kevin reviews the eventual PR.
- **Commits.**
  - One atomic commit per task. Stage explicit paths only; never `git add -A`. This plan file stays uncommitted.
  - Every commit message ends with the trailer line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - Do not push, open a PR, or deploy.
  - Each task's commit must leave `npm run typecheck`, `npm run lint`, and the affected Vitest files green. TDD RED states are checked locally and never committed.

## Conventions (CLAUDE.md / AGENTS.md)

- **Files and style.** Tests live only in a sibling `__tests__/` directory. Named exports only. Double quotes. Semicolons in `src/lib/**`. 2-space indent.
- **Imports.** Order is external → `@/` aliases → relative → `import type`.
- **JSDoc.** Exported functions get JSDoc, with numbered steps for multi-step logic.
- **Hygiene.** `console.error` only. No `TODO`/`FIXME`. No `.only`/`.skip`.
- **Fail-closed.** An excluded or unknown job is refused, never guessed.
- **server-only.** Unit tests that import a `server-only` graph start with `vi.mock("server-only", () => ({}));`.
- **Test typing matters.** `tsconfig.json` includes test files, and `npm run typecheck` is `tsc --noEmit`.
- **Lint.** ESLint is `next/core-web-vitals` + `next/typescript`: no `any`, no unused imports. A leading unused `_input` parameter is allowed (after-used).

## Locked decisions (from the orchestrator, re-verified against the code at 29aa114)

- **Decision A (DEF3-EXCLUDE-PROMOTIONS).** Exclude `student_promotions_july_1` using a registry field and a shared predicate, both consumed by the dashboard. The job:
  - is annual and `dangerous`, and writes to Wise via `applyVerifiedStudentPromotionRun`;
  - has a route that returns 409 on any day but 2026-07-01 Bangkok and is not audit-wrapped;
  - belongs to the Student Promotions page, which owns an audited dry-run → verified-apply workflow.
- **Decision B (DEF3-FAIL-CLOSED-GUARD).** `runDataHealthJob` refuses with `409 { error: reason }` right after its registry lookup. This happens before the owner gate and before `withCronInvocationAudit`, so a refusal writes no audit row. The terminal `Unknown job` 404 fallback stays as a defensive default.
- **Decision C (DEF3-DISPATCH-PARITY).** Add nine branches, in registry order, just before the terminal fallback.
  - Each duplicates its cron route's composition inline (the existing idiom), with `triggerType: "manual"` and `actorEmail` where the library accepts them.
  - `withCronInvocationAudit` already turns a thrown handler error into `500 {error: message}`. So a branch whose route only does `try { … } catch (e) { 500 e.message }` omits its own try/catch.
- **Decision D (DEF3-REGRESSION-TEST).** A new `run-job.test.ts` containing:
  - a `satisfies`-checked dispatch table and a runtime set-equality check;
  - an `it.each` dispatch over every runnable key;
  - the refusal test and focused tests that each new branch mirrors its cron route.

  Also extend `cron-registry.test.ts`. TDD order: red, then green.
- **Decision E (DEF3-DOCS).** Edit only the statements this change makes false. No reflowing, no renumbering, no unrelated drift fixes. Prefer file-level links, and put the docs in their own commit.

## Considered non-parity (recorded decisions; do NOT "fix")

1. **No progress-tests scope check.** The Data Health path has no progress-tests `scopeForEmail` check, although the internal route's session path has one. Data Health is the ops console; its only extra gates are the Kevin owner gate and the post-class `access_manager` gate. The run route's `job.key.startsWith("post_class_feedback")` check already covers `post_class_feedback_backfill`.
2. **`progress_tests` trigger type.** It runs with `triggerType: "manual"`, while the internal session path uses `"admin"`. The column is free text and `"manual"` is the library default. Before the tutor-workspace launch, a non-cron trigger skips the cron's daily-window claim (`claimDailyRefresh`) but still waits for today's shared snapshot.
3. **Backfill window.** `post_class_feedback_backfill` always takes the automatic oldest-unreconciled window with one 50-detail batch, exactly like the cron. Explicit `startDate`/`endDate`/`detailCap`/`maxBatches` remain a `CRON_SECRET`-only re-drain. Data Health does pass `actorEmail`; the cron passes none.
4. **Admissions cadence.** `admissions_notifications` has no `runType` override. It runs the cron's default cadence: the daily scan, plus the weekly digest on Bangkok Sundays.
5. **Env-paused jobs.** These are sit-ins while `TUTOR_SIT_INS_ENABLED` is not `"true"`, and the LINE credit digest while Credit Control is retired. `isManuallyRunnable` hides them. A direct POST still dispatches and the library self-skips, which matches existing `feedback_autowriter` behaviour.
6. **Manual run = one extra cron tick.** Every new branch's library self-gates and/or is single-flight or idempotent:
   - `runSitInWorker` returns `{ok:true, skipped:true, reason:"disabled"}` when disabled and holds a worker lease.
   - `queueDailyDigests` is a no-op when disabled or before 08:00 Bangkok, and queues jobs keyed per day.
   - `sendLineCreditDigest` self-skips when Credit Control is retired or the LINE scheduler is off, and once any run row exists for the date.
   - `sendProgressTestAdminDigest` waits for today's progress refresh and keeps a per-date terminal row.
   - Admissions daily and weekly runs are single-flight, with dedupe-keyed exactly-once sends.
   - `runLineBacklogRecovery` only inserts `status:"suggested"` links, with `onConflictDoNothing`.
   - The backfill, progress and unearned-revenue syncs are single-flight.

<interfaces>
<!-- Extracted from the worktree at 29aa114. Use directly; no exploration needed. -->

src/lib/data-health/run-job.ts (270 lines) — current structure:
```ts
// lines 1-30: imports (unsorted mix of @/ aliases), ending with
import { syncWiseActivityEvents, WiseActivitySyncAlreadyRunningError } from "@/lib/wise-activity/sync"; // line 28
import { withCronInvocationAudit } from "./cron-audit";                                                 // line 29
import { getCronJobDefinition, type CronJobKey } from "./cron-registry";                                 // line 30
const DEFAULT_INSTITUTE_ID = "696e1f4d90102225641cc413";                                                 // line 32
export async function runDataHealthJob(jobKey: CronJobKey, actorEmail: string | null) {                  // line 34, no JSDoc
  const job = getCronJobDefinition(jobKey);                    // CronJobDefinition | null
  if (!job) { return NextResponse.json({ error: "Unknown job" }, { status: 404 }); }   // lines 36-38
  if ((isWiseClassroomJob(jobKey) || jobKey === "feedback_autowriter") && !isClassroomOperationsOwner(actorEmail)) { 403 } // 40-42
  return withCronInvocationAudit({ jobKey, triggerSource: "admin", actorEmail, requestMethod: "POST" }, async () => {   // 44-51
    if (isWiseClassroomJob(jobKey) && jobKey !== "wise_snapshot" && !wiseClassroomAutomationEnabled()) return NextResponse.json(pausedWiseClassroomResult());
    // ...22 distinct `jobKey === "..."` keys (dynamic imports: "@/lib/feedback-autowriter/dispatch" runAutowriterJob,
    //    "@/lib/progress-tests/workspace/jobs" processJobs) ...
    return NextResponse.json({ error: "Unknown job" }, { status: 404 });   // line 267 — terminal fallback, keep
  });
}
```
Callers of run-job:
- `src/app/api/data-health/jobs/[jobKey]/run/route.ts` checks, in order: 401 → registry 404 → owner 403 → post_class* `access_manager` 403 → dangerous `confirmed !== true` 409 → `runDataHealthJob(job.key, email)`.
- `src/app/api/post-class-feedback/reminders/route.ts:50` calls `runDataHealthJob("post_class_feedback_nightly", …)`; this change does not affect it.

Tests of both routes mock run-job wholesale. `src/lib/classrooms/__tests__/operations-pause.test.ts` imports the REAL run-job and must keep passing; it mocks `server-only`, `cron-audit` (which then runs the handler), `@/lib/db` (which throws) and `createWiseClient`. The run-job graph already includes the `server-only` modules `onsite-foot-traffic/sync.ts` and `post-class-feedback/payout-accrual.ts`, so the two new `server-only` imports (`backfill-window.ts`, `unearned-revenue/sync.ts`) add no new constraint.

src/lib/data-health/cron-audit.ts:
```ts
export async function withCronInvocationAudit(input: { jobKey: CronJobKey; triggerSource: CronTriggerSource; actorEmail?: string | null; requestMethod?: string }, handler: () => Promise<Response>): Promise<Response>;
// inserts a `running` cron_invocations row, runs handler, stamps outcome; a thrown handler error → Response.json({ error: message }, { status: 500 })
// outcome: body.skipped === true or error containing "already running" → skipped; ok === false → failed; 202 → skipped; >= 400 → failed
```

src/lib/data-health/cron-registry.ts:
- `interface CronJobDefinition` spans lines 39-61; `paused?: boolean;` is line 50.
- `CRON_JOBS = [...] as const satisfies readonly CronJobDefinition[]` has 32 entries. The `student_promotions_july_1` entry is lines 403-418, with its `confirmationLabel: "Applies verified Wise student grade and course promotion writes.",` on line 415.
- `export function getCronJobDefinition(key: string): CronJobDefinition | null;` is at line 500.
- `export function effectiveCronJob(job: CronJobDefinition): CronJobDefinition;` is the last function, lines 513-524. It sets env-driven `paused: true` for the Wise/classroom jobs, `feedback_autowriter`, `tutor_sit_ins*` and `line_credit_digest`.

src/lib/data-health/dashboard.ts:
- line 6: `import { effectiveCronJob, CRON_JOBS, statusRank, type CronJobDefinition } from "./cron-registry";`
- line 498, inside `buildCronJobs` (where `job = effectiveCronJob(definition)`): `canRunManually: !job.paused,`
- line 1052: `manualActions: CRON_JOBS.map(effectiveCronJob).filter(job => !job.paused).map((job) => ({`

src/lib/classrooms/operations-policy.ts:
```ts
export const CLASSROOM_OPERATIONS_OWNER = "kevhsh7@gmail.com";
export function wiseClassroomAutomationEnabled(raw = process.env.WISE_CLASSROOM_AUTOMATION_ENABLED): boolean; // raw === "true"
export const WISE_CLASSROOM_JOBS = ["wise_snapshot", "classroom_morning", "classroom_publish_recovery", "classroom_admin_email", "classroom_weekend_check"] as const;
```

New-branch library signatures (all verified):
```ts
// @/lib/tutor-sit-ins/worker (no server-only)
export async function runSitInWorker(db: Database = getDb(), now = new Date()); // { ok: true, skipped: true, reason: "disabled" | "running" } | { ok: boolean, ... }
export async function queueDailyDigests(db: Database = getDb(), now = new Date()): Promise<void>;
export async function processJobs(db: Database = getDb(), options: { limit?: number; observationId?: string; sender?: ScheduleEmailSender; deadlineAt?: number } = {}); // { sent: number; failed: number }
// @/lib/tutor-sit-ins/http — keep REAL in tests (imports only ./model → date-fns-tz, zod)
export function sitInJson(value: unknown, status = 200): NextResponse; // adds Cache-Control: private, no-store
export function sitInError(error: unknown): NextResponse;              // rethrows HANGING_PROMISE_REJECTION; hides DB constraint names
// @/lib/unearned-revenue/sync (import "server-only")
export async function runUnearnedRevenueSync(options: { db?: Database; triggerType: "cron" | "manual"; actorEmail?: string | null }): Promise<UnearnedRevenueSyncResult>; // { ok: boolean; skipped: boolean; ... }
// @/lib/progress-tests/run-sync-request
export async function runProgressTestSyncRequest(options: { triggerType?: string; actorEmail?: string | null } = {}); // returns a NextResponse; 202 when already running
// @/lib/progress-tests/admin-digest
export async function sendProgressTestAdminDigest(db?, now?, options?): Promise<ProgressTestAdminDigestResult>; // status: "sent" | "partial" | "failed" | "skipped"
// @/lib/post-class-feedback/backfill-window (import "server-only")
export async function findOldestUnreconciledBackfillWindow(db: Database = getDb(), options = {}): Promise<{ startDate: string; endDate: string } | null>;
// @/lib/post-class-feedback/backfill-job
export async function runPostClassBackfillJob(options: { startDate: string; endDate: string; actorEmail?: string | null; now?: Date; detailCap?: number; maxBatches?: number; ... }): Promise<PostClassBackfillJobResult>;
// @/lib/post-class-feedback/repository
export class PostClassFeedbackSyncAlreadyRunningError extends Error { constructor(message = "Post-class feedback sync is already running.") }
// @/lib/admissions/notifications
export interface AdmissionsNotificationRunResult { skipped: boolean; runId: string | null; runType: "daily" | "weekly"; sentCount: number; skippedCount: number; errorSummary: string | null }
export async function runDailyNotifications(now: Date = new Date(), db: Database = getDb()): Promise<AdmissionsNotificationRunResult>;
export async function runWeeklyDigest(now: Date = new Date(), db: Database = getDb()): Promise<AdmissionsNotificationRunResult>;
// @/lib/bangkok-time — keep REAL
export function formatBangkokDateTime(value: string | number | Date, options?: Intl.DateTimeFormatOptions, locale = "en-GB"): string;
// @/lib/line/credit-digest
export async function sendLineCreditDigest(db?, now?, overrides?): Promise<LineCreditDigestResult>; // status: "sent" | "partial" | "failed" | "skipped"
// @/lib/line/backlog-recovery
export async function runLineBacklogRecovery({ db, dryRun = false }: { db: Database; dryRun?: boolean }): Promise<LineBacklogRecoveryResult>;
```

Cron routes to mirror (response composition):
- **`tutor-sit-ins/route.ts`**: `try { r = await runSitInWorker(); return sitInJson(r, r.ok ? 200 : 500) } catch (e) { return sitInError(e) }`
- **`tutor-sit-ins/digest/route.ts`**: `try { await queueDailyDigests(); r = await processJobs(getDb(), { limit: 50, deadlineAt: Date.now() + 270_000 }); return sitInJson(r, r.failed ? 500 : 200) } catch (e) { return sitInError(e) }`
- **`sync-unearned-revenue/route.ts`**: `r = await runUnearnedRevenueSync({ triggerType: "cron" }); return NextResponse.json(r, { status: r.ok ? r.skipped ? 202 : 200 : 502 })`, with no try/catch.
- **`sync-progress-tests/route.ts`**: `runProgressTestSyncRequest({ triggerType: "cron" })`. The session path passes `{ triggerType: "admin", actorEmail }` after a `scopeForEmail` check.
- **`progress-tests/admin-digest/route.ts`**: `r = await sendProgressTestAdminDigest(); json(r, r.status === "failed" ? 500 : 200)`; catch → 500 message.
- **`post-class-feedback-backfill/route.ts`**:
  - window = explicit query ?? `await findOldestUnreconciledBackfillWindow()`.
  - null window → `{ ok: true, skipped: "nothing-unreconciled" }`.
  - otherwise `runPostClassBackfillJob({ startDate, endDate, detailCap: q ?? 50, maxBatches: q ?? 1 })` → `{ ok: true, window, result }`.
  - catch: `PostClassFeedbackSyncAlreadyRunningError` → 409 `{ error: e.message }`; anything else → 500 `{ error: "Post-class feedback backfill failed" }`.
- **`admissions-notifications/route.ts`** (default runType):
  - `now = new Date()`, then the daily run.
  - also the weekly run when `formatBangkokDateTime(now, { weekday: "short" }, "en-US") === "Sun"`.
  - `skipped = results.every(r => r.skipped)`; `json({ ok: true, skipped, results }, { status: skipped ? 202 : 200 })`.
  - catch → 500 message.
- **`line-credit-digest/route.ts`**: `r = await sendLineCreditDigest(); json(r, r.status === "failed" ? 500 : 200)`; catch → 500 message.
- **`line-backlog-recovery/route.ts`**: `r = await runLineBacklogRecovery({ db: getDb(), dryRun: false }); json({ ok: true, result: r })`; catch → 500 message.
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Registry `manualRunDisabledReason` field, `isManuallyRunnable` predicate, dashboard wiring (Decision A)</name>
  <files>
/Users/kevinhsieh/Developer/Scheduling-run-dispatch/src/lib/data-health/__tests__/cron-registry.test.ts,
/Users/kevinhsieh/Developer/Scheduling-run-dispatch/src/lib/data-health/cron-registry.ts,
/Users/kevinhsieh/Developer/Scheduling-run-dispatch/src/lib/data-health/dashboard.ts
  </files>
  <behavior>
    - Exactly one registry job carries `manualRunDisabledReason`: `["student_promotions_july_1"]`.
    - `isManuallyRunnable(getCronJobDefinition("cron_watchdog")!)` is true.
    - It is false for that same job spread with `paused: true`, false when spread with `manualRunDisabledReason: "Owner-only workflow."`, and false for `getCronJobDefinition("student_promotions_july_1")!`.
    - In the dashboard, each row's `canRunManually` equals `isManuallyRunnable(effectiveCronJob(definition))`.
    - `manualActions` contains only the effective jobs that `isManuallyRunnable` accepts, so paused jobs and student promotions never render a button.
  </behavior>
  <action>
Write the tests first (RED), then implement (GREEN).

A. RED: `src/lib/data-health/__tests__/cron-registry.test.ts`. Match the file's existing style.
 1. Change line 4 to `import { CRON_JOBS, SCHEDULED_CRON_JOBS, getCronJobDefinition, isManuallyRunnable, type CronJobDefinition } from "../cron-registry";`.
 2. Append the two cases below at the end of the existing `describe("data-health cron registry", ...)`.

Typing trap: `CRON_JOBS` is an `as const` tuple. `CRON_JOBS.filter((job) => job.manualRunDisabledReason)` fails with TS2339 because the property exists on only one union member. Always read it through the widened `readonly CronJobDefinition[]` view shown below.
```ts
  it("excludes only the annual student promotions job from Data Health one-click runs", () => {
    const registry: readonly CronJobDefinition[] = CRON_JOBS;
    const excluded = registry.filter((job) => job.manualRunDisabledReason).map((job) => job.key);

    expect(excluded).toEqual(["student_promotions_july_1"]);
  });

  it("offers a manual run only for live, dispatchable jobs", () => {
    const job = getCronJobDefinition("cron_watchdog")!;

    expect(isManuallyRunnable(job)).toBe(true);
    expect(isManuallyRunnable({ ...job, paused: true })).toBe(false);
    expect(isManuallyRunnable({ ...job, manualRunDisabledReason: "Owner-only workflow." })).toBe(false);
    expect(isManuallyRunnable(getCronJobDefinition("student_promotions_july_1")!)).toBe(false);
  });
```
Run `npx vitest run --project unit src/lib/data-health/__tests__/cron-registry.test.ts` and confirm both new cases fail. This RED state is not committed.

B. GREEN: `src/lib/data-health/cron-registry.ts`, per Decision A. Change exactly three spots:
 1. In `interface CronJobDefinition`, directly after `paused?: boolean;` (line 50), add:
```ts
  /** Data Health never offers or dispatches a one-click run; returned to callers as the refusal reason. Env-driven pauses stay in effectiveCronJob. */
  manualRunDisabledReason?: string;
```
 2. In the `student_promotions_july_1` entry, directly after its `confirmationLabel: "Applies verified Wise student grade and course promotion writes.",` line (415), add:
`    manualRunDisabledReason: "Student promotions write to Wise once a year; review and apply them from the Student Promotions page.",`
 3. At the end of the file, after `effectiveCronJob`, append:
```ts

/** Data Health shows a Run button only for jobs that are live and dispatchable. */
export function isManuallyRunnable(job: CronJobDefinition): boolean {
  return !job.paused && !job.manualRunDisabledReason;
}
```
Touch nothing else in this file. The `vercel.json` mirror test and the `maxDuration` parity test must stay green.

C. GREEN: `src/lib/data-health/dashboard.ts`. Make exactly three one-line edits and nothing else. The sibling branch `fix/missing-table-sqlstate` edits lines ~882-930, so keep every hunk away from that region.
 1. Line 6: `import { effectiveCronJob, CRON_JOBS, isManuallyRunnable, statusRank, type CronJobDefinition } from "./cron-registry";`
 2. Line 498: `canRunManually: !job.paused,` → `canRunManually: isManuallyRunnable(job),`. `job` is already the `effectiveCronJob` view.
 3. Line 1052: `.filter(job => !job.paused)` → `.filter(isManuallyRunnable)`. Leave the rest of that line and the `.map(...)` body unchanged.

No UI change is needed: the client's `runJob` only runs keys present in `manualActions`.
  </action>
  <verify>
    <automated>cd /Users/kevinhsieh/Developer/Scheduling-run-dispatch && export PATH="/opt/homebrew/opt/node@22/bin:$PATH" && npm run typecheck && npm run lint && npx vitest run --project unit src/lib/data-health src/app/api/data-health src/components/data-health src/lib/classrooms/__tests__/operations-pause.test.ts && grep -n "canRunManually: isManuallyRunnable(job)" src/lib/data-health/dashboard.ts && grep -n "filter(isManuallyRunnable)" src/lib/data-health/dashboard.ts && test ! -e src/lib/data-health/__tests__/dashboard.test.ts</automated>
  </verify>
  <done>
- The registry has the optional field, set only on student promotions, and exports `isManuallyRunnable`.
- The dashboard derives both `canRunManually` and `manualActions` from that predicate.
- `cron-registry.test.ts` grows from 5 to 7 cases, all passing, and every listed suite is green along with typecheck and lint.
- Committed with explicit paths as `feat(260929-nwm): exclude student promotions from Data Health one-click runs`.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Dispatch-parity regression test (RED), then the fail-closed refusal and nine branches (GREEN) (Decisions B, C, D)</name>
  <files>
/Users/kevinhsieh/Developer/Scheduling-run-dispatch/src/lib/data-health/__tests__/run-job.test.ts (new),
/Users/kevinhsieh/Developer/Scheduling-run-dispatch/src/lib/data-health/run-job.ts
  </files>
  <behavior>
    - `Object.keys(DISPATCH_TARGETS).sort()` equals the sorted keys of registry jobs without `manualRunDisabledReason` (31 keys).
    - For each of those keys, `runDataHealthJob(key, CLASSROOM_OPERATIONS_OWNER)`:
      - returns status below 400;
      - does not return the body `{ error: "Unknown job" }`;
      - calls that key's entry-point mock;
      - calls `withCronInvocationAudit` with `expect.objectContaining({ jobKey: key, triggerSource: "admin", actorEmail: OWNER })`.
    - For each job with `manualRunDisabledReason`, the result is 409 with body `{ error: reason }`, where reason is that job's `manualRunDisabledReason`. Neither `withCronInvocationAudit` nor `getDb` is called.
    - **tutor_sit_ins:** `runSitInWorker` is called with no arguments; `{ ok: false }` → 500.
    - **tutor_sit_ins_digest:**
      - `queueDailyDigests` runs before `processSitInJobs`.
      - `processSitInJobs` is called with `(SENTINEL_DB, { limit: 50, deadlineAt: expect.any(Number) })`.
      - `{ sent: 0, failed: 1 }` → 500.
    - **unearned_revenue:** called with `{ triggerType: "manual", actorEmail: OWNER }`. `{ok:true, skipped:false}` → 200, `{ok:true, skipped:true}` → 202, `{ok:false, skipped:false}` → 502.
    - **progress_tests:** called with `{ triggerType: "manual", actorEmail: OWNER }`; the mock's Response is returned as-is.
    - **progress_tests_digest and line_credit_digest:** `{ status: "failed" }` → 500; `{ status: "skipped" }` → 200.
    - **post_class_feedback_backfill:**
      - `runPostClassBackfillJob` is called with `{ startDate, endDate, actorEmail: OWNER, detailCap: 50, maxBatches: 1 }`, and the body is `{ ok: true, window, result }`.
      - A null window → 200 `{ ok: true, skipped: "nothing-unreconciled" }`, and the job is not called.
      - `PostClassFeedbackSyncAlreadyRunningError` → 409 with the error's message.
      - Any other error → 500 `{ error: "Post-class feedback backfill failed" }`, and the serialized body does not contain the thrown message.
    - **admissions_notifications:**
      - Bangkok Thursday (2026-07-09T01:12Z) → daily only, 200 with `{ ok: true, skipped: false, results: [daily] }`.
      - Bangkok Sunday (2026-07-12T01:12Z) → daily and weekly, both called with the same Date, equal to the system time.
      - Every pass skipped → 202 with `skipped: true`.
    - **line_backlog_recovery:** called with `{ db: SENTINEL_DB, dryRun: false }`; the body is `{ ok: true, result }`.
  </behavior>
  <action>
Test (RED) first, then implementation (GREEN). Do not edit `operations-pause.test.ts` or `operations-access.test.ts`.

A. RED: create `src/lib/data-health/__tests__/run-job.test.ts` (per Decision D).

1. Mocks come first; vitest hoists them. Every library that run-job imports for dispatch is mocked wholesale.
   - Classes used with `instanceof` are defined inside their factory.
   - Keep these modules REAL: `next/server`, `@/lib/classrooms/operations-policy`, `@/lib/data-health/cron-registry`, `@/lib/tutor-sit-ins/http`, `@/lib/bangkok-time`.
   - If a factory omits an export, run-job's import throws.
   - Import into the test only what the test uses, otherwise lint fails. For example, do not import `WiseActivitySyncAlreadyRunningError`.
```ts
vi.mock("server-only", () => ({}));
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

vi.mock("@/lib/data-health/cron-audit", () => ({ withCronInvocationAudit: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/wise/client", () => ({ createWiseClient: vi.fn() }));
// Existing 22 branches (two are dynamic imports inside run-job).
vi.mock("@/lib/feedback-autowriter/dispatch", () => ({ runAutowriterJob: vi.fn() }));
vi.mock("@/lib/post-class-feedback/nightly-reminders", () => ({ nightlyWorkerOutcome: vi.fn(), runNightlyReminders: vi.fn() }));
vi.mock("@/lib/progress-tests/workspace/jobs", () => ({ processJobs: vi.fn() }));
vi.mock("@/lib/room-booking/refresh", () => ({ runRoomRefresh: vi.fn() }));
vi.mock("@/lib/classrooms/weekend-check", () => ({ runWeekendClassroomCheck: vi.fn() }));
vi.mock("@/lib/sync/run-wise-sync", () => ({ runWiseSyncRequest: vi.fn() }));
vi.mock("@/lib/wise-activity/sync", () => ({
  syncWiseActivityEvents: vi.fn(),
  WiseActivitySyncAlreadyRunningError: class WiseActivitySyncAlreadyRunningError extends Error {},
}));
vi.mock("@/lib/sales-dashboard/data", () => ({ importActiveSalesDashboardProjectionSource: vi.fn(), importRefreshableSalesSources: vi.fn() }));
vi.mock("@/lib/competitor-intelligence/sync", () => ({ runCompetitorIntelligenceSync: vi.fn() }));
vi.mock("@/lib/credit-control/run-sync-request", () => ({ runCreditControlSyncRequest: vi.fn() }));
vi.mock("@/lib/post-class-feedback/sync", () => ({ runPostClassFeedbackSync: vi.fn() }));
vi.mock("@/lib/post-class-feedback/notifications", () => ({ processDuePostClassNotificationRetries: vi.fn(), sendPostClassAdminDigest: vi.fn() }));
vi.mock("@/lib/post-class-feedback/reminder-job", () => ({ runPostClassReminderJob: vi.fn() }));
vi.mock("@/lib/post-class-feedback/payout-accrual", () => ({ payoutJobResponse: vi.fn(), runPayoutAccrualPass: vi.fn(), runPayoutFinalizePass: vi.fn() }));
vi.mock("@/lib/leave-requests/sync", () => ({ syncLeaveRequests: vi.fn() }));
vi.mock("@/lib/classrooms/publish-worker", () => ({ runClassroomPublishRecovery: vi.fn() }));
vi.mock("@/lib/classrooms/daily-automation", () => ({ prepareNextDayClassrooms: vi.fn(), deliverNextDayClassroomSchedules: vi.fn() }));
vi.mock("@/lib/internal/cron-watchdog", () => ({ runCronWatchdog: vi.fn() }));
vi.mock("@/lib/room-capacity/utilization", () => ({ syncRoomUtilizationSessions: vi.fn() }));
vi.mock("@/lib/onsite-foot-traffic/sync", () => ({ runOnsiteFootTrafficSync: vi.fn() }));
// The nine new branches.
vi.mock("@/lib/tutor-sit-ins/worker", () => ({ processJobs: vi.fn(), queueDailyDigests: vi.fn(), runSitInWorker: vi.fn() }));
vi.mock("@/lib/unearned-revenue/sync", () => ({ runUnearnedRevenueSync: vi.fn() }));
vi.mock("@/lib/progress-tests/run-sync-request", () => ({ runProgressTestSyncRequest: vi.fn() }));
vi.mock("@/lib/progress-tests/admin-digest", () => ({ sendProgressTestAdminDigest: vi.fn() }));
vi.mock("@/lib/post-class-feedback/backfill-window", () => ({ findOldestUnreconciledBackfillWindow: vi.fn() }));
vi.mock("@/lib/post-class-feedback/backfill-job", () => ({ runPostClassBackfillJob: vi.fn() }));
vi.mock("@/lib/post-class-feedback/repository", () => ({
  PostClassFeedbackSyncAlreadyRunningError: class PostClassFeedbackSyncAlreadyRunningError extends Error {},
}));
vi.mock("@/lib/admissions/notifications", () => ({ runDailyNotifications: vi.fn(), runWeeklyDigest: vi.fn() }));
vi.mock("@/lib/line/credit-digest", () => ({ sendLineCreditDigest: vi.fn() }));
vi.mock("@/lib/line/backlog-recovery", () => ({ runLineBacklogRecovery: vi.fn() }));
```
Then import each mocked entry point from its module. Two need aliases: `processJobs as processWorkspaceJobs` from the progress-tests workspace, and `processJobs as processSitInJobs` from the sit-in worker. Also import:
   - `withCronInvocationAudit` from `@/lib/data-health/cron-audit`
   - `CRON_JOBS`, `getCronJobDefinition` and `type CronJobDefinition` from `@/lib/data-health/cron-registry`
   - `runDataHealthJob` from `@/lib/data-health/run-job`
   - `CLASSROOM_OPERATIONS_OWNER` from `@/lib/classrooms/operations-policy`
   - `getDb` from `@/lib/db`
   - `createWiseClient` from `@/lib/wise/client`
   - `PostClassFeedbackSyncAlreadyRunningError` from `@/lib/post-class-feedback/repository`
   - `type AdmissionsNotificationRunResult` from `@/lib/admissions/notifications`

2. Dispatch table (the core deliverable). A registry key without a branch becomes both a compile error under `npm run typecheck` and a runtime failure:
```ts
type ManualRunKey = Exclude<(typeof CRON_JOBS)[number], { manualRunDisabledReason: string }>["key"];

/** One primary entry point per key Data Health can run; `satisfies` turns a missing branch into a type error. */
const DISPATCH_TARGETS = {
  feedback_autowriter: runAutowriterJob,
  post_class_feedback_nightly: runNightlyReminders,
  tutor_sit_ins: runSitInWorker,
  tutor_sit_ins_digest: processSitInJobs,
  progress_tests_processing: processWorkspaceJobs,
  classroom_publish_recovery: runClassroomPublishRecovery,
  room_booking: runRoomRefresh,
  classroom_weekend_check: runWeekendClassroomCheck,
  wise_snapshot: runWiseSyncRequest,
  wise_activity: syncWiseActivityEvents,
  sales_dashboard: importRefreshableSalesSources,
  unearned_revenue: runUnearnedRevenueSync,
  onsite_foot_traffic: runOnsiteFootTrafficSync,
  competitor_intelligence: runCompetitorIntelligenceSync,
  credit_control: runCreditControlSyncRequest,
  progress_tests: runProgressTestSyncRequest,
  progress_tests_digest: sendProgressTestAdminDigest,
  post_class_feedback: runPostClassFeedbackSync,
  post_class_feedback_backfill: runPostClassBackfillJob,
  post_class_feedback_digest: sendPostClassAdminDigest,
  post_class_feedback_day_after: runPostClassReminderJob,
  post_class_feedback_deadline: runPostClassReminderJob,
  post_class_feedback_payout_accrual: runPayoutAccrualPass,
  leave_requests: syncLeaveRequests,
  classroom_morning: prepareNextDayClassrooms,
  classroom_admin_email: deliverNextDayClassroomSchedules,
  admissions_notifications: runDailyNotifications,
  line_credit_digest: sendLineCreditDigest,
  cron_watchdog: runCronWatchdog,
  room_utilization: syncRoomUtilizationSessions,
  line_backlog_recovery: runLineBacklogRecovery,
} satisfies Record<ManualRunKey, unknown>;

const REGISTRY: readonly CronJobDefinition[] = CRON_JOBS; // widened view — see the TS2339 note in Task 1
const MANUAL_KEYS = REGISTRY.filter((job) => !job.manualRunDisabledReason).map((job) => job.key).sort();
const EXCLUDED_KEYS = REGISTRY.filter((job) => job.manualRunDisabledReason).map((job) => job.key);
const OWNER = CLASSROOM_OPERATIONS_OWNER;
const SENTINEL_DB = { sentinel: "db" };
const BANGKOK_THURSDAY = new Date("2026-07-09T01:12:00.000Z");
const BANGKOK_SUNDAY = new Date("2026-07-12T01:12:00.000Z");
```

3. Defaults. Write an `applyDefaults()` that gives every mock an implementation so that each branch returns a status below 400. Use `as never` wherever a partial shape does not match the declared type.
   - `withCronInvocationAudit.mockImplementation(async (_input, handler) => handler())`
   - `getDb.mockReturnValue(SENTINEL_DB as never)` and `createWiseClient.mockReturnValue({} as never)`
   - `runWiseSyncRequest`, `runCreditControlSyncRequest` and `runProgressTestSyncRequest`: use `mockImplementation(async () => NextResponse.json({ ok: true }) as never)`, NOT `mockResolvedValue`. A Response body can be read only once, so every call needs a fresh Response.
   - `runAutowriterJob` → `{ ok: true }`
   - `runNightlyReminders` → `{}`, with `nightlyWorkerOutcome.mockReturnValue({ ok: true } as never)`
   - `processWorkspaceJobs` → `{}`
   - `runRoomRefresh`, `runWeekendClassroomCheck`, `runClassroomPublishRecovery`, `prepareNextDayClassrooms`, `deliverNextDayClassroomSchedules` → `{ ok: true }`
   - `syncWiseActivityEvents` → `{}`
   - `importRefreshableSalesSources` → `[]`; `importActiveSalesDashboardProjectionSource` → `null`
   - `runCompetitorIntelligenceSync` → `{ status: "success" }`
   - `runPostClassFeedbackSync`, `processDuePostClassNotificationRetries`, `sendPostClassAdminDigest` → `{}`
   - `runPostClassReminderJob` → `{ ready: true }`
   - `runPayoutAccrualPass`, `runPayoutFinalizePass` → `{}`, with `payoutJobResponse.mockReturnValue({ ok: true } as never)`
   - `syncLeaveRequests`, `runCronWatchdog`, `syncRoomUtilizationSessions` → `{}`
   - `runOnsiteFootTrafficSync` → `{ skipped: false }`
   - `runSitInWorker` → `{ ok: true }`; `queueDailyDigests` → `undefined`; `processSitInJobs` → `{ sent: 0, failed: 0 }`
   - `runUnearnedRevenueSync` → `{ ok: true, skipped: false }`
   - `sendProgressTestAdminDigest` → `{ status: "sent" }`
   - `findOldestUnreconciledBackfillWindow` → `{ startDate: "2026-09-01", endDate: "2026-09-04" }`; `runPostClassBackfillJob` → `{ batches: 1 }`
   - `runDailyNotifications` → `admissionsResult("daily")`; `runWeeklyDigest` → `admissionsResult("weekly")`
   - `sendLineCreditDigest` → `{ status: "sent" }`
   - `runLineBacklogRecovery` → `{ inserted: 0 }`

   Helper: `admissionsResult(runType: "daily" | "weekly", skipped = false): AdmissionsNotificationRunResult` returns `{ skipped, runId: skipped ? null : "run-" + runType, runType, sentCount: 0, skippedCount: 0, errorSummary: null }`.

   Hooks:
   - `beforeEach(() => { vi.resetAllMocks(); applyDefaults(); vi.stubEnv("WISE_CLASSROOM_AUTOMATION_ENABLED", "true"); })`. Use `resetAllMocks` rather than `clearAllMocks`: it also drops unconsumed `*Once` queues, which `clearAllMocks` would leak into the next test. The env stub lets the five Wise/classroom jobs reach their own branch instead of the pause short-circuit.
   - `afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); })`.
   - For the admissions cases: `vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(BANGKOK_SUNDAY)`, and the same with Thursday.

4. Cases, all in one `describe("runDataHealthJob", ...)`:
   - (a) `it("covers exactly the registry keys Data Health can run")`: `expect(Object.keys(DISPATCH_TARGETS).sort()).toEqual(MANUAL_KEYS)`.
   - (b) `it.each(MANUAL_KEYS)("dispatches %s", ...)`: assert everything in the second behavior bullet. Look up the target with `(DISPATCH_TARGETS as Record<string, unknown>)[key]`, and assert `toBeDefined()` before `toHaveBeenCalled()`.
   - (c) `it.each(EXCLUDED_KEYS)("refuses %s before the audit wrapper", ...)`: status 409; body equals `{ error: getCronJobDefinition(key)!.manualRunDisabledReason }`; `withCronInvocationAudit` not called; `getDb` not called.
   - (d) One `it` for each remaining behavior bullet, tutor_sit_ins through line_backlog_recovery. Use `mockResolvedValueOnce` / `mockRejectedValueOnce` for the non-default outcomes.
     - Sit-in digest ordering: `expect(vi.mocked(queueDailyDigests).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(processSitInJobs).mock.invocationCallOrder[0])`.
     - Admissions on Sunday: assert that `runDailyNotifications` and `runWeeklyDigest` were both called with `BANGKOK_SUNDAY` (Date equality), and that `results` has 2 entries.
     - Backfill "other error": reject with `new Error("sensitive driver detail")`, and assert that `JSON.stringify(body)` does not contain that text.

5. Run `npx vitest run --project unit src/lib/data-health/__tests__/run-job.test.ts` and confirm RED:
   - Must fail: "dispatches" for the 9 new keys (each returns 404 Unknown job).
   - Must fail: "refuses student_promotions_july_1 before the audit wrapper" (it currently enters the audit and gets a 404).
   - Must fail: every new-branch mirror case.
   - Must pass: case (a), and "dispatches" for the 22 existing keys. If any of those fail, fix the test's defaults, not run-job.
   - Do not commit RED.

B. GREEN: `src/lib/data-health/run-job.ts`.
 1. Imports (per Decision C). Insert them after line 28 (`@/lib/wise-activity/sync`) and before `import { withCronInvocationAudit } from "./cron-audit";`, so aliases stay before relatives. The `processSitInJobs` alias avoids confusion with the progress-tests `processJobs` dynamic import used by the `progress_tests_processing` branch.
```ts
import { runDailyNotifications, runWeeklyDigest } from "@/lib/admissions/notifications";
import { formatBangkokDateTime } from "@/lib/bangkok-time";
import { runLineBacklogRecovery } from "@/lib/line/backlog-recovery";
import { sendLineCreditDigest } from "@/lib/line/credit-digest";
import { runPostClassBackfillJob } from "@/lib/post-class-feedback/backfill-job";
import { findOldestUnreconciledBackfillWindow } from "@/lib/post-class-feedback/backfill-window";
import { PostClassFeedbackSyncAlreadyRunningError } from "@/lib/post-class-feedback/repository";
import { sendProgressTestAdminDigest } from "@/lib/progress-tests/admin-digest";
import { runProgressTestSyncRequest } from "@/lib/progress-tests/run-sync-request";
import { sitInError, sitInJson } from "@/lib/tutor-sit-ins/http";
import { processJobs as processSitInJobs, queueDailyDigests, runSitInWorker } from "@/lib/tutor-sit-ins/worker";
import { runUnearnedRevenueSync } from "@/lib/unearned-revenue/sync";
```
 2. Add a JSDoc (per convention) directly above `export async function runDataHealthJob`:
```ts
/**
 * Runs one registry job in-process for the Data Health job runner.
 *
 * 1. Unknown key → 404; a job carrying `manualRunDisabledReason` → 409 with that reason.
 *    Both return before the audit wrapper, so neither writes a `cron_invocations` row.
 * 2. Wise/classroom jobs and the feedback autowriter are owner-only (403).
 * 3. Otherwise the job's branch runs inside `withCronInvocationAudit` as `triggerSource: "admin"`,
 *    mirroring its `/api/internal/*` cron route.
 */
```
 3. Refusal (per Decision B). Place it directly after the `if (!job) { … 404 }` block and before the owner-gate `if`:
```ts
  if (job.manualRunDisabledReason) {
    return NextResponse.json({ error: job.manualRunDisabledReason }, { status: 409 });
  }
```
 4. The nine branches (per Decision C). Insert them verbatim, in this registry order, inside the audit handler immediately before the terminal `return NextResponse.json({ error: "Unknown job" }, { status: 404 });`. Leave that fallback unchanged as the defensive default, and separate the branches with blank lines like the existing ones:
```ts
      if (jobKey === "tutor_sit_ins") {
        try {
          const result = await runSitInWorker();
          return sitInJson(result, result.ok ? 200 : 500);
        } catch (error) {
          return sitInError(error);
        }
      }

      if (jobKey === "tutor_sit_ins_digest") {
        try {
          await queueDailyDigests();
          const result = await processSitInJobs(getDb(), {
            limit: 50,
            deadlineAt: Date.now() + 270_000,
          });
          return sitInJson(result, result.failed ? 500 : 200);
        } catch (error) {
          return sitInError(error);
        }
      }

      if (jobKey === "unearned_revenue") {
        const result = await runUnearnedRevenueSync({ triggerType: "manual", actorEmail });
        return NextResponse.json(result, { status: result.ok ? result.skipped ? 202 : 200 : 502 });
      }

      if (jobKey === "progress_tests") {
        return runProgressTestSyncRequest({ triggerType: "manual", actorEmail });
      }

      if (jobKey === "progress_tests_digest") {
        const result = await sendProgressTestAdminDigest();
        return NextResponse.json(result, { status: result.status === "failed" ? 500 : 200 });
      }

      if (jobKey === "post_class_feedback_backfill") {
        try {
          const window = await findOldestUnreconciledBackfillWindow();
          if (!window) {
            return NextResponse.json({ ok: true, skipped: "nothing-unreconciled" });
          }
          // Same single 50-detail batch as the cron; explicit dates and caps stay a CRON_SECRET-only re-drain.
          const result = await runPostClassBackfillJob({
            startDate: window.startDate,
            endDate: window.endDate,
            actorEmail,
            detailCap: 50,
            maxBatches: 1,
          });
          return NextResponse.json({ ok: true, window, result });
        } catch (error) {
          if (error instanceof PostClassFeedbackSyncAlreadyRunningError) {
            return NextResponse.json({ error: error.message }, { status: 409 });
          }
          return NextResponse.json({ error: "Post-class feedback backfill failed" }, { status: 500 });
        }
      }

      if (jobKey === "admissions_notifications") {
        const now = new Date();
        const results = [await runDailyNotifications(now)];
        // Same cadence as the cron: the weekly digest joins the daily scan on Bangkok Sundays.
        if (formatBangkokDateTime(now, { weekday: "short" }, "en-US") === "Sun") {
          results.push(await runWeeklyDigest(now));
        }
        const skipped = results.every((result) => result.skipped);
        return NextResponse.json({ ok: true, skipped, results }, { status: skipped ? 202 : 200 });
      }

      if (jobKey === "line_credit_digest") {
        const result = await sendLineCreditDigest();
        return NextResponse.json(result, { status: result.status === "failed" ? 500 : 200 });
      }

      if (jobKey === "line_backlog_recovery") {
        const result = await runLineBacklogRecovery({ db: getDb(), dryRun: false });
        return NextResponse.json({ ok: true, result });
      }
```
 5. Change nothing else in run-job.ts: do not reorder existing imports or branches, and add no route-level refusal.
 6. Re-run the new test (GREEN), then run the full verify command.
  </action>
  <verify>
    <automated>cd /Users/kevinhsieh/Developer/Scheduling-run-dispatch && export PATH="/opt/homebrew/opt/node@22/bin:$PATH" && npm run typecheck && npm run lint && npx vitest run --project unit src/lib/data-health src/app/api/data-health src/lib/classrooms/__tests__/operations-pause.test.ts src/lib/classrooms/__tests__/operations-access.test.ts src/app/api/internal/admissions-notifications src/app/api/internal/post-class-feedback-backfill src/components/data-health && test "$(grep -oE 'jobKey === "[a-z0-9_]+"' src/lib/data-health/run-job.ts | sort -u | wc -l | tr -d ' ')" = "31" && grep -n "if (job.manualRunDisabledReason)" src/lib/data-health/run-job.ts && ! grep -nE "\.(only|skip)\(|TODO|FIXME" src/lib/data-health/__tests__/run-job.test.ts src/lib/data-health/run-job.ts</automated>
  </verify>
  <done>
- RED was observed exactly as described: 9 new-key dispatch cases, the refusal case and the mirror cases failed, while the 22 existing keys and case (a) passed.
- GREEN: run-job.ts has 31 distinct dispatched keys, the refusal sits before the owner gate and the audit wrapper, and the terminal 404 is kept.
- run-job.test.ts passes, typecheck and lint are clean, and every suite in the verify command is green without edits to existing tests.
- Committed with explicit paths as `fix(260929-nwm): dispatch every runnable Data Health job (DEF-3)`.
  </done>
</task>

<task type="auto">
  <name>Task 3: Correct the docs this change falsifies; record DEF-3 fixed (Decision E)</name>
  <files>
/Users/kevinhsieh/Developer/Scheduling-run-dispatch/docs/features/data-health.md,
/Users/kevinhsieh/Developer/Scheduling-run-dispatch/docs/reference/api/data-health.md,
/Users/kevinhsieh/Developer/Scheduling-run-dispatch/docs/reference/crons.md,
/Users/kevinhsieh/Developer/Scheduling-run-dispatch/docs/reference/api/internal-crons.md,
/Users/kevinhsieh/Developer/Scheduling-run-dispatch/docs/OPEN-QUESTIONS.md,
/Users/kevinhsieh/Developer/Scheduling-run-dispatch/docs/features/line-credit-bot.md,
/Users/kevinhsieh/Developer/Scheduling-run-dispatch/docs/features/progress-tests-legacy.md,
/Users/kevinhsieh/Developer/Scheduling-run-dispatch/docs/features/student-promotions.md,
/Users/kevinhsieh/Developer/Scheduling-run-dispatch/docs/reference/api/student-promotions.md,
/Users/kevinhsieh/Developer/Scheduling-run-dispatch/docs/operations/runbook.md
  </files>
  <action>
Targeted edits only, per Decision E.
- Locate each anchor with Grep (or Read with offset/limit around the stated line), then replace exactly that text.
- Do not reflow neighbouring lines, renumber lists, update unrelated counts or line citations, or touch any other passage.
- Keep each file's existing wrap width and indentation.
- Do not introduce angle-bracket placeholders.

Sibling-branch safety: `fix/single-flight-guard-deviations` edits:
- `docs/OPEN-QUESTIONS.md`: it inserts after line 64, at the end of §0, and changes lines 787 and 791-794.
- `docs/reference/crons.md`: it inserts after line 567.
- `docs/reference/api/internal-crons.md`: line 357.
- `docs/operations/runbook.md`: line 592.

Keep every hunk away from those lines, exactly as placed below.

**1. docs/features/data-health.md**
 a. Line ~79, QuickActions row. Replace `One button per entry in \`manualActions\` — all 24 registry keys;` with `One button per entry in \`manualActions\` — every registry job \`isManuallyRunnable\` accepts (not paused by feature mode and no \`manualRunDisabledReason\`, so never \`student_promotions_july_1\`);`
 b. Line ~184. Replace the whole paragraph, which starts `**Eight manual buttons are wired to nothing.**` and ends `can be reconciled manually from this page.`, with:
    `**Every manual button dispatches.** \`manualActions\` and each row's \`canRunManually\` come from \`isManuallyRunnable\` over the \`effectiveCronJob\` view (\`src/lib/data-health/cron-registry.ts\`), and \`runDataHealthJob\` has a branch for every key that predicate can accept (\`src/lib/data-health/run-job.ts\`). The branches for \`tutor_sit_ins\`, \`tutor_sit_ins_digest\`, \`unearned_revenue\`, \`progress_tests\`, \`progress_tests_digest\`, \`post_class_feedback_backfill\`, \`admissions_notifications\`, \`line_credit_digest\` and \`line_backlog_recovery\` mirror their cron routes' composition and status mapping, passing \`triggerType: "manual"\` and the actor where the library accepts them. \`student_promotions_july_1\` is excluded on purpose — it writes to Wise once a year and the Student Promotions page owns the audited dry-run → verified-apply workflow — so its registry entry carries \`manualRunDisabledReason\`: no button is rendered, and a direct call is refused with \`409\` (the reason as \`error\`) before the audit wrapper, leaving no \`cron_invocations\` row. The runner's terminal \`404 { "error": "Unknown job" }\` survives only as a defensive default, and \`src/lib/data-health/__tests__/run-job.test.ts\` fails typecheck and the unit suite if a registry key ever lacks a branch. \`post_class_feedback_backfill\` still sits behind the \`access_manager\` capability gate (403, no audit row) and runs the same single 50-detail batch as its cron; explicit backfill dates and caps remain a \`CRON_SECRET\`-only re-drain. Onsite Foot Traffic is implemented and can be reconciled manually from this page.`
 c. Line ~186, in the `**Parked jobs are \`manual-only\`, never \`late\`.**` paragraph. Replace `only the former has a runner branch.` with `both have a runner branch.`
 d. Line ~206, the tests-table row for `cron-registry.test.ts`. Replace its tail `mirrors the route's exported \`maxDuration\`. |` with `mirrors the route's exported \`maxDuration\`; exactly one job (\`student_promotions_july_1\`) carries \`manualRunDisabledReason\`, and \`isManuallyRunnable\` rejects paused and excluded jobs. |`
 e. Insert a new row directly after the `src/app/api/data-health/jobs/[jobKey]/run/__tests__/route.test.ts` row (~213):
    `| \`src/lib/data-health/__tests__/run-job.test.ts\` | Dispatch parity: a \`satisfies\`-checked table maps every registry key without \`manualRunDisabledReason\` to its entry point and equals the registry-derived set at runtime; every such key dispatches below 400, never \`Unknown job\`, audited as \`admin\`; an excluded key gets 409 with its reason and no audit call; the nine newer branches mirror their cron routes (admissions Sunday digest, backfill window / 409 / generic 500, unearned 202 / 502, sit-in digest ordering, manual trigger + actor). |`
 f. Line ~223. Replace the whole open-question bullet, which starts `- **Eight manual buttons are rendered for jobs the runner cannot run.**` and ends `except a direct \`CRON_SECRET\` call.`, with:
    `- **Resolved — every rendered manual button dispatches.** The runner gained the missing branches and the payload offers only \`isManuallyRunnable\` jobs; \`student_promotions_july_1\` is excluded by design (no button, 409 before audit), and \`line_backlog_recovery\` now has its Data Health button as an in-app trigger. See the business rule above.`

**2. docs/reference/api/data-health.md**
 a. Line ~60, `manualActions` row. Replace `for all 24 registry jobs` with `for every registry job \`isManuallyRunnable\` accepts — not paused by feature mode and without a \`manualRunDisabledReason\` (so never \`student_promotions_july_1\`)`
 b. Gate ladder, step 5 (~116). After its closing `).`, append: ` The dispatcher first refuses a job whose registry entry carries \`manualRunDisabledReason\` (today only \`student_promotions_july_1\`) with **409** and that reason as \`error\`, *before* its audit wrapper, so the refusal writes no \`cron_invocations\` row ([\`run-job.ts\`](../../../src/lib/data-health/run-job.ts)).`
 c. Line ~120. Replace the paragraph that starts `**The registry, and which keys the runner actually implements.**` and ends `a feature-specific manual route is required.` with:
    `**The registry, and which keys the runner implements.** Every registry key without a \`manualRunDisabledReason\` has a runner branch, so no reachable key falls through to the dispatcher's terminal \`404 {"error":"Unknown job"}\`, which remains only as a defensive default ([\`run-job.ts\`](../../../src/lib/data-health/run-job.ts)). \`student_promotions_july_1\` is excluded on purpose (409 before audit; see gate 5). [\`run-job.test.ts\`](../../../src/lib/data-health/__tests__/run-job.test.ts) pins the pairing at compile time and at runtime. Keys added to the registry after this table was written (for example \`tutor_sit_ins\` and \`tutor_sit_ins_digest\`) are dispatched too.`
 d. Per-key table. In each row below, replace the trailing `**no → 404** | — |` cells:
    - `unearned_revenue` → `yes | the sync result; \`202\` when skipped by its single-flight guard, \`502\` when \`ok: false\` — the cron route's mapping |`
    - `progress_tests` → `yes | the \`runProgressTestSyncRequest({ triggerType: "manual", actorEmail })\` response verbatim; \`202\` when a run is already in flight ([\`run-sync-request.ts\`](../../../src/lib/progress-tests/run-sync-request.ts)) |`
    - `progress_tests_digest` → `yes | the digest result verbatim; \`500\` when \`status: "failed"\` |`
    - `post_class_feedback_backfill` → `yes | \`{ok:true, window, result}\` for the oldest unreconciled window (one 50-detail batch, as the cron); \`{ok:true, skipped:"nothing-unreconciled"}\` when none; \`409\` when a post-class sync is already running; generic \`500\` |`
    - `student_promotions_july_1` → `**excluded → 409 before audit** | \`error\` is the registry's \`manualRunDisabledReason\`; no \`cron_invocations\` row |`
    - `admissions_notifications` → `yes | \`{ok:true, skipped, results}\` — the daily scan, plus the weekly digest on Bangkok Sundays; \`202\` when every pass was skipped |`
    - `line_credit_digest` → `yes | the digest result verbatim; \`500\` when \`status: "failed"\` |`
    - `line_backlog_recovery` → `yes | \`{ok:true, result}\` from \`runLineBacklogRecovery({ db, dryRun: false })\` |`
 e. Line ~149. Replace `Three of the eight unimplemented keys are \`dangerous\`, so a caller must still send \`confirmed: true\` to receive the 404 — gate 4 runs before dispatch.` with `\`student_promotions_july_1\` is \`dangerous\`, so a caller must still send \`confirmed: true\` to receive its 409 refusal — gate 4 runs before dispatch.`
 f. Side effects. After the sentence ending `appear in the next dashboard load's \`recentInvocations\`.`, append ` A job refused for \`manualRunDisabledReason\` is never dispatched and writes no row.`
 g. Status-code table:
    - 202 row: replace `Single-flight skip on \`wise_snapshot\` / \`credit_control\`` with `Single-flight skip on \`wise_snapshot\` / \`credit_control\` / \`progress_tests\` / \`unearned_revenue\`, or \`admissions_notifications\` when every pass was skipped`.
    - 404 row becomes `| 404 | \`jobKey\` not in the registry (no audit row). The dispatcher's terminal \`Unknown job\` fallback is a defensive default that no registry key reaches. |`
    - 409 row becomes `| 409 | \`dangerous\` job without \`confirmed: true\`; a job carrying \`manualRunDisabledReason\` (\`student_promotions_july_1\`), refused before the audit wrapper with the reason as \`error\`; also the \`already running\` collisions on \`wise_activity\`, \`competitor_intelligence\` and \`post_class_feedback_backfill\`. |`
    - Insert after the 500 row: `| 502 | \`unearned_revenue\` sync returned \`ok: false\` (the cron route's mapping). |`
 h. Tests table:
    - `cron-registry.test.ts` row: change `| 5 |` to `| 7 |`, and append `, plus exactly one \`manualRunDisabledReason\` job and the \`isManuallyRunnable\` truth table` to the end of its Covers cell.
    - Insert after the run-route test row: `| [\`src/lib/data-health/__tests__/run-job.test.ts\`](../../../src/lib/data-health/__tests__/run-job.test.ts) | N | dispatch parity with the registry (compile-time \`satisfies\` + runtime set equality), every runnable key reaches its entry point, the 409 refusal before audit, and the nine newer branches mirroring their cron routes |`. Replace N with the passed-test count that `npx vitest run --project unit src/lib/data-health/__tests__/run-job.test.ts` prints.

**3. docs/reference/crons.md**
 a. Line ~589, `line-backlog-recovery` row. Replace `one-off identity recovery sweep; not dispatchable from Data Health |` with `one-off identity recovery sweep; runnable from the Data Health job list |`
 b. Line ~610. Two replacements:
    - `Reachability: cron secret only via curl, or the CLI` → `Reachability: cron secret via curl, the Data Health job list, or the CLI`
    - `It is **not** dispatchable from Data Health ([\`run-job.ts\`](../../src/lib/data-health/run-job.ts) has no branch for it).` → `Data Health dispatches it in-process with the same \`runLineBacklogRecovery({ db, dryRun: false })\` call ([\`run-job.ts\`](../../src/lib/data-health/run-job.ts)).`
 c. Line ~620. Replace `Unlike the two manual routes above, all three **are** dispatchable from Data Health, behind the` with `Like the two manual routes above, all three are dispatchable from Data Health — these behind the`
 d. Line ~660, gate step 5 (`5. Dispatch through \`runDataHealthJob(jobKey, actorEmail)\` …`). Append ` A job whose registry entry carries \`manualRunDisabledReason\` (\`student_promotions_july_1\`) is refused there with \`409\` and its reason, before the audit wrapper.`
 e. Lines ~662-666. Replace the `**Coverage gap.**` paragraph AND the table after it (header `| Runnable from Data Health (16) | Not implemented → \`404\` (8) |`, its separator and its single body row) with:
```
**Coverage.** `runDataHealthJob` has a branch for every registry key except `student_promotions_july_1`, which carries `manualRunDisabledReason` and is refused with `409` before the audit wrapper; the dashboard offers a button only for jobs `isManuallyRunnable` accepts ([`run-job.ts`](../../src/lib/data-health/run-job.ts), [`cron-registry.ts`](../../src/lib/data-health/cron-registry.ts)). [`run-job.test.ts`](../../src/lib/data-health/__tests__/run-job.test.ts) pins the pairing.

| Runnable from Data Health | Refused → `409` before audit |
|---|---|
| every other registry key | `student_promotions_july_1` — annual Wise-writing job; apply promotions from the Student Promotions page |
```
 f. Line ~668, the `Two behavioural differences from the cron path when run this way:` sentence:
    - `Two behavioural` → `Three behavioural`
    - `), and \`wise_activity\` runs in` → `), \`wise_activity\` runs in`
    - Replace the final `([\`run-job.ts:47-63\`](../../src/lib/data-health/run-job.ts)).` with `([\`run-job.ts:47-63\`](../../src/lib/data-health/run-job.ts)), and \`progress_tests\` runs with \`triggerType: "manual"\`, so before the tutor-workspace launch it skips the cron's daily-window claim — as the route's admin-session path does — while still waiting for today's shared snapshot ([\`run-sync-request.ts\`](../../src/lib/progress-tests/run-sync-request.ts)).`
 g. Line ~678, open question 3. Replace the whole item `3. **Data Health cannot run 8 registered jobs.** …` with `3. **Resolved — Data Health runs every job it offers.** Seven of the eight keys listed here (all but \`student_promotions_july_1\`), plus \`tutor_sit_ins\` and \`tutor_sit_ins_digest\`, now have \`runDataHealthJob\` branches; \`student_promotions_july_1\` is deliberately refused (\`manualRunDisabledReason\`, \`409\` before audit) and is no longer rendered as a button.`
 h. Line ~686, open question 7. Replace `7. **\`line-backlog-recovery\` is curl-only.** It is registered manual-only but not dispatchable from Data Health, and its only in-repo caller is a dry-run CLI script.` with `7. **\`line-backlog-recovery\` is manual-only.** It is registered manual-only and runs live from the Data Health job list or with the cron secret; its only in-repo dry-run caller is a CLI script.` Keep the rest of that item unchanged.

**4. docs/reference/api/internal-crons.md**
 a. Line ~59. Replace everything from `It handles 16 job keys, including a manual Onsite Foot Traffic reconciliation.` through `…or a feature-specific manual route is required.` with `It dispatches every registry key, including a manual Onsite Foot Traffic reconciliation, except \`student_promotions_july_1\`: that entry carries \`manualRunDisabledReason\`, so Data Health shows no button for it and \`runDataHealthJob\` refuses a direct call with \`409\` (the reason as \`error\`) before its audit wrapper. Student promotions are applied from the Student Promotions page.`
 b. Line ~445. Replace `**Manual only — no \`vercel.json\` entry, and no Data Health branch either**, so a direct \`CRON_SECRET\` call is the sole way to run it.` with `**Manual only — no \`vercel.json\` entry.** Run it with a direct \`CRON_SECRET\` call or from the Data Health job list, which calls the same \`runLineBacklogRecovery({ db, dryRun: false })\` in-process ([\`run-job.ts\`](../../../src/lib/data-health/run-job.ts)).`

**5. docs/OPEN-QUESTIONS.md**
 a. §0. Insert the bullet below directly after the DEF-1 bullet (the one whose last line is `  drop it.**`, line ~50) and before `- **DEF-24`. Do NOT put it at the end of §0: the sibling branch appends there, which would cause an add/add conflict.
```
- **DEF-3 (Data Health "Run now" buttons that 404) — FIXED.** Ten registry keys had no
  `runDataHealthJob` branch. Nine now have one that mirrors its cron route, passing
  `triggerType: "manual"` and the actor where the library accepts them
  (`src/lib/data-health/run-job.ts`). The tenth, `student_promotions_july_1`, is excluded on purpose
  through the registry's `manualRunDisabledReason` and `isManuallyRunnable`
  (`src/lib/data-health/cron-registry.ts`): no button, and a direct call gets a `409` carrying the
  reason before the audit wrapper, so no failed `cron_invocations` row. `run-job.test.ts` fails
  typecheck and the unit suite if a registry key ever lacks a branch.
```
 b. Line ~83, DEF-3 title. Append ` **FIXED — see §0.**` to the end of that single line only.
 c. Line ~230, DEF-31. Replace `Combined with having no Data Health branch (DEF-3), there is no way to preview this job's matches` and the next line `before it inserts.` with `The Data Health branch added for DEF-3 also runs live (\`dryRun: false\`), so there is still no HTTP way` and `to preview this job's matches before it inserts.`
 d. Line ~799, OPS-4. On that one line only, replace `and \`run-job.ts\` cannot dispatch it (DEF-3).` with `and Data Health deliberately refuses to run it (\`manualRunDisabledReason\`; DEF-3 fixed, see §0).` Do not touch lines 784-798.
 e. Lines ~1380-1381, TEST-12. Replace the substring `but nothing tests the \`manualActions\` / \`run-job.ts\` pairing (DEF-3) or the six duplicated` + newline + `cron-secret copies (OPS-11).` with `and \`run-job.test.ts\` now pins the \`manualActions\` / \`run-job.ts\` pairing (DEF-3, fixed), but` + newline + `nothing tests the six duplicated cron-secret copies (OPS-11).` Keep the rest of line 1381 (`\`migration.test.ts\` pins …`) unchanged.

**6. docs/features/line-credit-bot.md**
 a. Lines ~124-127. Replace the paragraph that starts `**Manual re-run.** \`line_credit_digest\` has no branch in \`runDataHealthJob\`` and ends `records this alongside six other keys).` with:
    `**Manual re-run.** While Credit Control is active, the Data Health job list dispatches \`line_credit_digest\` in-process (\`sendLineCreditDigest()\`, \`500\` only when the run \`failed\`, the cron route's mapping); while it is retired the job is paused and shows no button. A direct \`CRON_SECRET\` request still works. Either way a second run on a date that already has a digest run row is skipped ("already recorded for this date") — see [\`internal-crons.md\` § The Data Health manual-run path](../reference/api/internal-crons.md#the-data-health-manual-run-path).`
 b. Lines ~507-509, open question 1. Replace the substring `), and \`line_credit_digest\`` + newline + `   has no branch in \`runDataHealthJob\`, so recovery means a hand-rolled \`CRON_SECRET\` request — and` + newline + `   the row that blocks it must be deleted first.` with `), and neither a` + newline + `   Data Health re-run nor a \`CRON_SECRET\` request gets past it, so recovery means deleting the row that` + newline + `   blocks it first.` Keep the following question sentence unchanged.

**7. docs/features/progress-tests-legacy.md**
Lines ~678-682. Replace item 14, from `14. **Neither cron key can be run from Data Health.**` through `Wire them up, or leave cron-only?`, with this text (4-space continuation indent):
```
14. **Resolved — both cron keys now run from Data Health.** `progress_tests` and `progress_tests_digest`
    have [`run-job.ts`](../../src/lib/data-health/run-job.ts) branches that mirror their cron routes
    (`runProgressTestSyncRequest({ triggerType: "manual", actorEmail })` and
    `sendProgressTestAdminDigest()`); the digest route itself is still `GET`-only behind the cron secret.
```

**8. docs/features/student-promotions.md**
Line ~214, item 10. Replace `and \`run-job.ts\` cannot dispatch it. Deliberate, or an omission worth fixing before the next rollover?` with `and Data Health deliberately refuses to run it (\`manualRunDisabledReason\` → \`409\` before the audit wrapper; the Student Promotions page owns the audited apply). Is the missing invocation proof deliberate, or an omission worth fixing before the next rollover?`

**9. docs/reference/api/student-promotions.md**
Line ~394. Replace the whole bullet, which starts `- There is **no in-app manual trigger** for it either.` and ends `The button is rendered; the job is unreachable through it.`, with:
`- There is **no one-click trigger** for it either, by design. Its registry entry carries \`manualRunDisabledReason\`, so Data Health renders no Run button, and a direct \`POST /api/data-health/jobs/student_promotions_july_1/run\` — once past the route's \`dangerous\` confirmation gate — is refused by \`runDataHealthJob\` with \`409\` (the reason as \`error\`) before its audit wrapper ([\`run-job.ts\`](../../../src/lib/data-health/run-job.ts), [\`cron-registry.ts\`](../../../src/lib/data-health/cron-registry.ts)). The admin \`…/apply\` workflow on the Student Promotions page is the in-app path.`

**10. docs/operations/runbook.md**
 a. Lines ~459-463. Replace everything from `**Gap worth knowing:**` through `Those must be fired with curl (§4.5).` with this text (2-space indent):
```
  **Worth knowing:** `runDataHealthJob` dispatches every job the dashboard offers. The one registry
  key it refuses is `student_promotions_july_1` (`manualRunDisabledReason` → `409` before the audit
  wrapper, no button); apply promotions from the Student Promotions page.
```
 b. Lines ~903-908. Replace the bullet from `- **Data Health cannot run 8 of its own 24 registered jobs.**` through `recovery levers for their features.` with:
```
- **Resolved — Data Health runs every job it offers.** `runDataHealthJob` now dispatches the
  previously missing keys, including `post_class_feedback_backfill` and `line_backlog_recovery`, the
  only manual recovery levers for their features; `student_promotions_july_1` is excluded on purpose
  (`manualRunDisabledReason`, `409` before audit) ([`run-job.ts`](../../src/lib/data-health/run-job.ts)).
```
  </action>
  <verify>
    <automated>cd /Users/kevinhsieh/Developer/Scheduling-run-dispatch && ! grep -rnE "wired to nothing|cannot run 8|Eight registry keys have no branch|no → 404|not dispatchable from Data Health|no Data Health branch either|has no branch in .runDataHealthJob|Coverage gap|Gap worth knowing|Neither cron key can be run|cannot dispatch it|Combined with having no Data Health branch|curl-only|only the former has a runner branch|Three of the eight unimplemented|all 24 registry (keys|jobs)|It handles 16 job keys|Two behavioural differences|Unlike the two manual routes|no in-app manual trigger" docs && test "$(grep -c 'DEF-3 (Data Health' docs/OPEN-QUESTIONS.md)" = "1" && grep -q "run-job.test.ts" docs/features/data-health.md && grep -q "run-job.test.ts" docs/reference/api/data-health.md && ! git diff -U0 -- docs/OPEN-QUESTIONS.md | grep -E '^@@ -(5[5-9]|6[0-9]|7[0-9]|78[4-9]|79[0-8])(,| )' && git diff --check && git diff --stat -- docs</automated>
  </verify>
  <done>
- No doc under `docs/` still claims a Data Health button 404s or that one of the nine keys cannot run from Data Health.
- DEF-3 is recorded FIXED in OPEN-QUESTIONS §0, placed after the DEF-1 bullet, with no hunk inside the sibling branch's line ranges.
- Both test tables list `run-job.test.ts`, and `git diff --check` is clean.
- Only the 10 listed docs changed.
- Committed with explicit paths, as a separate commit that can be dropped independently, as `docs(260929-nwm): record Data Health dispatch parity; DEF-3 fixed`.
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Admin browser → `POST /api/data-health/jobs/{jobKey}/run` | Session-authenticated operator input: the `jobKey` path segment and a `confirmed` body flag |
| Data Health runner → job libraries | In-process calls that email tutors, admins and case members; push LINE messages; write Sheets-derived snapshots; and call Wise |
| Job result → `cron_invocations` audit + HTTP response | Error text returned to an admin and stored in an append-only table |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-nwm-01 | Elevation of privilege | `student_promotions_july_1` reachable through a Data Health one-click that bypasses the audited dry-run → verified-apply workflow | mitigate | `manualRunDisabledReason` plus `isManuallyRunnable` hide the button. `runDataHealthJob` returns 409 before the owner gate and before the audit. The dangerous-job confirmation still comes first. Pinned by run-job.test.ts case (c) and by cron-registry.test.ts |
| T-nwm-02 | Tampering (duplicate outbound sends) | Manual runs of admissions notifications, the LINE and progress digests, and sit-in digests | mitigate | Branches call the same idempotent libraries as the crons: dedupe keys, per-date run rows, per-day keyed jobs and single-flight guards. The dangerous flag (sit-ins, admissions, LINE digest) keeps the confirmation gate |
| T-nwm-03 | Denial of service (Wise / Google quota) | Manual backfill, progress and unearned-revenue syncs | mitigate | Backfill is capped at the cron's single 50-detail batch; explicit caps stay `CRON_SECRET`-only. Every sync is single-flight (409 or 202). The runner route's `maxDuration` of 800 is unchanged |
| T-nwm-04 | Repudiation | All manual runs | mitigate | Every dispatch is audited with `triggerSource: "admin"` and `actorEmail`, asserted in case (b). The unearned-revenue, progress and backfill domain rows also record the actor. A refusal writes nothing by design because no job ran |
| T-nwm-05 | Information disclosure | Branch error bodies | mitigate | The backfill branch returns the route's generic 500, and a test asserts the thrown message is not echoed. Sit-in errors go through `sitInError`, which hides DB constraint names. The remaining branches return `error.message` to an authenticated admin exactly as their cron routes already do (accepted) |
| T-nwm-06 | Elevation of privilege | `progress_tests` without the internal route's `scopeForEmail` check | accept | Data Health is the ops console, gated by the session and by middleware `allowedPages` for `/data-health`. The run is the same read-from-Wise sync the cron performs every 30 minutes and returns only counts (considered non-parity #1) |
| T-nwm-07 | Spoofing / capability bypass | `post_class_feedback_backfill` | mitigate (existing) | The run route's `startsWith("post_class_feedback")` `access_manager` gate (403 before audit) already covers the new key and is unchanged |
</threat_model>

<verification>
Run all of these from `/Users/kevinhsieh/Developer/Scheduling-run-dispatch` with `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`:
1. `npm run typecheck`
2. `npm run lint`
3. `npx vitest run --project unit src/lib/data-health src/app/api/data-health src/lib/classrooms/__tests__/operations-pause.test.ts src/lib/classrooms/__tests__/operations-access.test.ts src/app/api/internal/admissions-notifications src/app/api/internal/post-class-feedback-backfill src/components/data-health`
4. Recommended once at the end: `npm test` (the full unit project), to confirm nothing else imports the real run-job without mocking `server-only`.
5. Registry parity recomputed by machine: `comm -23 <(grep -oE 'key: "[a-z0-9_]+"' src/lib/data-health/cron-registry.ts | grep -oE '"[a-z0-9_]+"' | tr -d '"' | sort) <(grep -oE 'jobKey === "[a-z0-9_]+"' src/lib/data-health/run-job.ts | grep -oE '"[a-z0-9_]+"' | tr -d '"' | sort -u)` prints exactly `student_promotions_july_1`.
6. `git diff --check`; `git diff -U0 origin/main -- src/lib/data-health/dashboard.ts | grep '^@@'` shows hunks only near lines 6, 498 and 1052.
7. `git -C /Users/kevinhsieh/Developer/Scheduling-run-dispatch log --oneline origin/main..HEAD` shows the three task commits (feat, fix, docs) on `fix/data-health-run-dispatch`. `git status --short` shows only the uncommitted `.planning/quick/260929-nwm-*` files.
</verification>

<success_criteria>
- Every button Data Health renders dispatches its job. No registry key a caller can reach falls through to `Unknown job`, and nothing a caller can reach writes a spurious failed `cron_invocations` row.
- The nine new branches behave exactly like their cron routes (composition, status mapping and idempotency), attributed to the clicking admin.
- `student_promotions_july_1` is hidden, and it is refused with 409 before the audit.
- A future registry key without a branch fails typecheck and the unit suite.
- Docs no longer contradict the code, and DEF-3 is recorded fixed without conflicting with the sibling branches.
- Typecheck, lint, the listed Vitest suites and `git diff --check` all pass. There are three atomic commits and nothing is pushed.
</success_criteria>

<source_audit>
| Source | ID | Item | Task | Status |
|--------|----|------|------|--------|
| GOAL | — | Data Health manual Run dispatch parity for every cron-registry job | 1–2 | COVERED |
| CONTEXT | Decision A | `manualRunDisabledReason` field + JSDoc, exact reason text on student promotions, `isManuallyRunnable`, dashboard `canRunManually` + `manualActions` | 1 | COVERED |
| CONTEXT | Decision B | 409 refusal after the registry lookup, before the owner gate and audit; no route duplicate; terminal 404 kept | 2 | COVERED |
| CONTEXT | Decision C | Nine branches verbatim in registry order, the new imports incl. the `processSitInJobs` alias, considered non-parity recorded | 2 | COVERED |
| CONTEXT | Decision D | run-job.test.ts (mock inventory, `satisfies` table, runtime set equality, `it.each` dispatch, refusal, mirror cases with fake timers) + cron-registry.test.ts pins; TDD red → green | 1–2 | COVERED (registry reads go through a widened `readonly CronJobDefinition[]` view; the literal `CRON_JOBS.filter(j => j.manualRunDisabledReason)` is TS2339) |
| CONTEXT | Decision E | Targeted docs edits in features/data-health.md, api/data-health.md, crons.md, internal-crons.md, OPEN-QUESTIONS.md; own commit | 3 | COVERED (the §0 bullet goes after DEF-1, not at the end of §0; 5 more docs with now-false claims were added under the same rule) |
| REQ | DEF3-EXCLUDE-PROMOTIONS | Promotions excluded from one-click runs | 1 | COVERED |
| REQ | DEF3-FAIL-CLOSED-GUARD | Refusal before audit | 2 | COVERED |
| REQ | DEF3-DISPATCH-PARITY | 31 of 32 keys dispatch | 2 | COVERED |
| REQ | DEF3-REGRESSION-TEST | Compile-time + runtime parity test | 1–2 | COVERED |
| REQ | DEF3-DOCS | Docs corrected, DEF-3 recorded fixed | 3 | COVERED |
| RESEARCH | — | No research phase for this quick task | — | N/A |
| Excluded | — | Refactoring `/api/internal/*` routes; a route-level refusal; `dashboard.test.ts`; audit-wrapping or re-scheduling the student-promotions route (OPS-4); per-feature page scopes in Data Health; docs drift not caused by this change | — | OUT OF SCOPE (locked decisions / sibling-branch conflicts) |
</source_audit>

<output>
After completion, create `/Users/kevinhsieh/Developer/Scheduling-run-dispatch/.planning/quick/260929-nwm-data-health-manual-run-dispatch-parity-f/260929-nwm-SUMMARY.md`. Include:
- The three commits (hash + subject) and the files each one changed.
- Test counts: `cron-registry.test.ts` 5 → 7, and the number of `run-job.test.ts` cases.
- The observed RED list (which cases failed before implementation), as TDD evidence.
- The considered non-parity list, copied from this plan.
- Owner notes for the eventual PR and deploy:
  1. `src/lib/data-health/cron-registry.ts` is CODEOWNERS-protected, so the PR needs Kevin's review.
  2. After deploy, the Student Promotions "Run" button disappears from Data Health, and nine buttons that used to 404 now run for real:
     - LINE Backlog Recovery runs live (`dryRun: false`) and inserts only `suggested` links.
     - Admissions Notifications also sends the weekly digest when clicked on a Bangkok Sunday.
     - The sit-in, admissions and LINE-digest buttons keep their dangerous-job confirmation.
  3. There are no migrations and no env changes.
  4. Merge notes:
     - `dashboard.ts` hunks (lines 6/498/1052) do not overlap `fix/missing-table-sqlstate` (~882-930, plus its new `dashboard.test.ts`).
     - The OPEN-QUESTIONS §0 bullet sits after DEF-1, so it does not collide with the bullet `fix/single-flight-guard-deviations` appends at the end of §0.
     - The OPS-4 edit touches only line ~799, 4 unchanged lines below that branch's edit at 791-794.
</output>
