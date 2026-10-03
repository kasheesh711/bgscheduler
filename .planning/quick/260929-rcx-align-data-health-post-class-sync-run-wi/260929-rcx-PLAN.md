---
phase: quick-260929-rcx
plan: "01"
type: execute
wave: 1
depends_on: []
files_modified: [src/lib/data-health/run-job.ts, src/lib/data-health/__tests__/run-job.test.ts, docs/reference/crons.md, docs/reference/api/data-health.md]
autonomous: true
requirements: [RCX-CRON-PARITY, RCX-ERROR-MAPPING, RCX-REGRESSION-TEST, RCX-DOCS]
quick_id: 260929-rcx
branch: fix/data-health-post-class-run-parity
base: fix/data-health-run-dispatch bdfd79f (stacked on origin/main 7788eaf; merge that first)
worktree: /Users/kevinhsieh/Developer/Scheduling-post-class-run-parity
must_haves:
  truths:
    - "A Data Health Run of post_class_feedback calls runPostClassFeedbackSync({ triggerType: \"manual\", actorEmail }), then processPostClassAiReviews(), processDuePostClassNotificationRetries() and runPostClassDeductionHygiene() in one Promise.allSettled, and returns 200 { ok: true, result, ai, retries, hygiene }"
    - "When the ai, retries or hygiene pass rejects, that key becomes { failed: true } and the run still returns 200 with the other values"
    - "PostClassFeedbackSyncAlreadyRunningError → 409 { error: <its message> }; any other sync error → 500 { error: \"Post-class feedback sync failed\" } without the thrown text; neither runs a post-sync pass"
    - "No doc says the Data Health post_class_feedback run skips the AI-review or hygiene passes, or returns { ok, result, retries }"
  artifacts:
    - { path: "src/lib/data-health/run-job.ts", provides: "post_class_feedback branch identical to the cron route in composition and error mapping", contains: "runPostClassDeductionHygiene()," }
    - { path: "src/lib/data-health/__tests__/run-job.test.ts", provides: "5 new parity cases (50 -> 55)", contains: "vi.mock(\"@/lib/post-class-feedback/auto-approval\"" }
  key_links:
    - { from: "run-job.ts post_class_feedback branch", to: "src/app/api/internal/sync-post-class-feedback/route.ts", via: "the same three allSettled passes in the same order, the same keys, the same catch", pattern: "Promise\\.allSettled\\(\\[\\s*processPostClassAiReviews\\(\\)" }
---

<objective>
Make Data Health's manual Run of `post_class_feedback` behave exactly like its cron route. Today the manual run skips the AI-review and deduction-hygiene passes (hygiene was added only to the cron, in a0f3225). It also returns a 500 that leaks the driver's error text. Output: one fix commit (tests plus implementation) and one docs commit.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
**Worktree only.**
- Prefix every Bash call with `cd /Users/kevinhsieh/Developer/Scheduling-post-class-run-parity && export PATH="/opt/homebrew/opt/node@22/bin:$PATH" &&`. Use absolute worktree paths.
- NEVER touch `/Users/kevinhsieh/Developer/Scheduling` or `/Users/kevinhsieh/Developer/Scheduling-run-dispatch`.
- Pre-flight: `git status --short --branch` shows `## fix/data-health-post-class-run-parity`, with only `.planning/quick/260929-rcx-*` untracked.
- Stage explicit paths only. Do not stage this plan, push, or open a PR.
- Out of bounds: `src/app/api/internal/**` (CODEOWNERS), `src/app/api/post-class-feedback/sync/route.ts`, new logging, and doc drift this change did not cause.

@/Users/kevinhsieh/Developer/Scheduling-post-class-run-parity/src/app/api/internal/sync-post-class-feedback/route.ts (the body to mirror is at lines 21-43)
@/Users/kevinhsieh/Developer/Scheduling-post-class-run-parity/src/lib/data-health/run-job.ts (the branch is at lines 171-186)
@/Users/kevinhsieh/Developer/Scheduling-post-class-run-parity/src/lib/data-health/__tests__/run-job.test.ts
<interfaces>
- `processPostClassAiReviews(options = {}, db = getDb())` → `{ processed, failed, skipped }` (ai.ts:119)
- `runPostClassDeductionHygiene(db = getDb())` → `{ reopened, reopenFailed, waived, waiveFailed }` (auto-approval.ts:286)
- `processDuePostClassNotificationRetries(options = {})` → `{ considered, sent, failed, cancelled, deferred }`
- `PostClassFeedbackSyncAlreadyRunningError` is already imported in run-job.ts (line 35); the test mocks it as a stub class (lines 39-41).
</interfaces>
</context>

<tasks>
<task type="auto" tdd="true">
  <name>Task 1: Pin cron parity for the post_class_feedback run (RED), then mirror the cron route (GREEN)</name>
  <files>src/lib/data-health/__tests__/run-job.test.ts, src/lib/data-health/run-job.ts</files>
  <behavior>
    - (1) The sync is called with `{ triggerType: "manual", actorEmail: OWNER }`. Then AI, retries and hygiene are each called once with no arguments, each after the sync (`mock.invocationCallOrder[0]` greater than the sync's). The response is 200 with `PC_BODY`.
    - (2) `it.each` over ai, retries and hygiene: when that pass rejects, the response is 200 with `{ ...PC_BODY, [key]: { failed: true } }`. The retries row goes beyond the locked list, because a rejected retries pass used to give a 500.
    - (3) The sync rejects three times in order: the stub `PostClassFeedbackSyncAlreadyRunningError("Post-class feedback sync is already running.")` → 409 with that message; `new Error("sensitive driver detail")` → 500 `{ error: "Post-class feedback sync failed" }`; `new Error("advisory lock already running")` → the same 500 (pins `instanceof`). No 500 body's `JSON.stringify` contains its thrown text, and none of the three passes is called.
  </behavior>
  <action>
**Tests.** Follow the style of the backfill tests.
1. After the notifications `vi.mock` (line 23), add `vi.mock("@/lib/post-class-feedback/ai", () => ({ processPostClassAiReviews: vi.fn() }));` and `vi.mock("@/lib/post-class-feedback/auto-approval", () => ({ runPostClassDeductionHygiene: vi.fn() }));`. Import both functions in path order, just before the `backfill-job` import.
2. After `BANGKOK_SUNDAY`, add constants with distinct values so a swapped key fails: `PC_SYNC = { runId: "pc-run-1" }`; `PC_AI = { processed: 1, failed: 0, skipped: 2 }`; `PC_RETRIES = { considered: 3, sent: 3, failed: 0, cancelled: 0, deferred: 0 }`; `PC_HYGIENE = { reopened: 0, reopenFailed: 0, waived: 1, waiveFailed: 0 }`; `PC_BODY = { ok: true, result: PC_SYNC, ai: PC_AI, retries: PC_RETRIES, hygiene: PC_HYGIENE }`.
3. In `applyDefaults()`, replace the two `{} as never` defaults (lines 156-157) with four defaults: `PC_SYNC as never`, `PC_RETRIES`, `PC_AI` and `PC_HYGIENE`.
4. Add cases (1)-(3) after `maps backfill failures like its cron route without echoing driver detail`. In (2), make each row's second element a lambda `() => vi.mocked(<pass>).mockRejectedValueOnce(new Error("<key> down"))`, with the rows `as const`.

**RED.** Run `npx vitest run --project unit src/lib/data-health/__tests__/run-job.test.ts`. Expect exactly the 5 new cases to fail and the 50 existing ones to pass. In (3), the 409 run already passes and the 500 runs fail. Record the RED list for the SUMMARY. Do not commit.

**Implement (locked decision).**
1. After the `runCronWatchdog` import (line 18), add `import { processPostClassAiReviews } from "@/lib/post-class-feedback/ai";` and `import { runPostClassDeductionHygiene } from "@/lib/post-class-feedback/auto-approval";`.
2. Replace the body of `if (jobKey === "post_class_feedback")` with the cron route's lines 21-43, copied verbatim, including the three-line hygiene comment. The only change is the sync call, which stays `runPostClassFeedbackSync({ triggerType: "manual", actorEmail })`.
3. The catch becomes: `instanceof PostClassFeedbackSyncAlreadyRunningError` → `409 { error: error.message }`; anything else → `500 { error: "Post-class feedback sync failed" }`. The `message.includes("already running")` check goes.
4. Leave the JSDoc, the `DISPATCH_TARGETS` entry and every other branch untouched.

**GREEN.** Expect 55 passing, then run the verify command. Commit the two files with subject `fix(260929-rcx): run the cron's post-sync passes from Data Health's post-class sync` and a one- or two-line body naming the a0f3225 drift and the generic 500. End with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  </action>
  <verify><automated>npm run typecheck && npm run lint && npx vitest run --project unit src/lib/data-health src/app/api/data-health src/lib/classrooms/__tests__/operations-pause.test.ts src/lib/classrooms/__tests__/operations-access.test.ts src/app/api/internal/sync-post-class-feedback src/app/api/post-class-feedback</automated></verify>
  <done>RED was observed on exactly the 5 new cases. All 55 run-job cases pass, and typecheck, lint and the verify suites are green. One commit touches only these two files.</done>
</task>

<task type="auto">
  <name>Task 2: Correct the two docs that describe the old manual run</name>
  <files>docs/reference/crons.md, docs/reference/api/data-health.md</files>
  <action>
1. **crons.md line 670.** Replace the opening `Three behavioural differences from the cron path when run this way: \`post_class_feedback\` runs the sync and notification retries but **not** the AI review or deduction hygiene passes ([\`run-job.ts\`](../../src/lib/data-health/run-job.ts)), \`wise_activity\` runs` with `Two behavioural differences from the cron path when run this way: \`wise_activity\` runs`. Keep the rest of the line byte-identical. No post-class difference remains: a manual run without dates keeps the cron's window and the 50-detail cap (sync.ts:594-598).
2. **api/data-health.md line 135.** Keep the first four cells. Replace the fifth cell with: `` `{ok:true, result, ai, retries, hygiene}` — the sync plus the cron's AI-review, notification-retry and deduction-hygiene passes, each `{failed:true}` if it rejects; `409` when a post-class sync is already running; generic `500` ([`run-job.ts`](../../../src/lib/data-health/run-job.ts)) ``. This uses a file-level link and drops the stale `:104-119` citation.
3. **Re-grep.** `grep -rn "Three behavioural differences\|sync and notification retries\|result, retries}" docs` should return no hits. The planner's pre-grep found nothing else this change makes false: `api/post-class-feedback.md:314` describes the page's own sync route, the 409 row at `data-health.md:167` still holds, and `features/data-health.md:187` is not exhaustive. `features/post-class-feedback.md:79` and `api/post-class-feedback.md:429` used to deny a backfill branch; the orchestrator already corrected both on the base branch (bdfd79f), so there is nothing to do there.
4. **Commit** both files with subject `docs(260929-rcx): Data Health's post-class sync now mirrors its cron's passes`, then a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  </action>
  <verify><automated>grep -c "Two behavioural differences" docs/reference/crons.md && grep -c "result, ai, retries, hygiene" docs/reference/api/data-health.md && ! grep -rn "Three behavioural differences\|sync and notification retries" docs && git diff --check HEAD~1</automated></verify>
  <done>Both passages match the code and nothing else in docs/ contradicts it. The docs commit touches only these two files.</done>
</task>
</tasks>

<threat_model>
| ID | Category | Component | Disposition | Mitigation / rationale |
|----|----------|-----------|-------------|------------------------|
| T-rcx-01 | Information disclosure | 500 body (also the `cron_invocations` digest) | mitigate | The body is now the generic `"Post-class feedback sync failed"`, and case (3) asserts the thrown text is absent. |
| T-rcx-02 | Tampering | Hygiene writes triggered by a click | accept | Hygiene only reopens and waives (it releases claims and never approves). It is the same code the cron runs every 30 minutes, and the payout pause deliberately leaves it running. The `access_manager` gate on the run route is unchanged. |
| T-rcx-03 | Denial of service / cost | AI-review calls to OpenAI | accept | Each batch is at most 10 and idempotent per `requestHash`, so a click only brings the next batch forward. Both routes have `maxDuration` 800. |
| T-rcx-04 | Repudiation | Hygiene rows record the system actor | accept | Same as the cron. The `cron_invocations` row records `triggerSource: "admin"` and the actor's email. |
</threat_model>

<verification>
- The Task 1 verify command passes, and `git diff --check bdfd79f..HEAD` is clean.
- `git log --oneline bdfd79f..HEAD` shows exactly the fix and docs commits; `git status --short` shows only `.planning/quick/260929-rcx-*` untracked.
</verification>

<success_criteria>
- A manual Run and the cron run the same passes, return the same body and map errors the same way. The manual Run keeps its manual trigger type and actor.
- Typecheck, lint and the listed suites pass (run-job 55/55, with the 50 existing cases unchanged).
- There are two atomic commits and nothing is pushed.
</success_criteria>

<source_audit>
| Source | Item | Task | Status |
|--------|------|------|--------|
| GOAL | The Data Health `post_class_feedback` Run matches its cron route | 1 | COVERED |
| CONTEXT | Mirror exactly: the three passes, `{failed:true}`, the keys, the `instanceof` 409 and generic 500, the manual trigger and actor, the hygiene comment; no route edits and no logging | 1 | COVERED |
| CONTEXT | Tests (1)-(3), the mocks, `applyDefaults()` and `DISPATCH_TARGETS` kept; docs "Two…", the api row and the grep | 1, 2 | COVERED, plus a retries row in (2) and an `instanceof` pin in (3) |
| REQ | RCX-CRON-PARITY / RCX-ERROR-MAPPING / RCX-REGRESSION-TEST / RCX-DOCS | 1 / 1 / 1 / 2 | COVERED |
| Excluded | Logging for rejected passes; the page's sync route lacking hygiene | — | OUT OF SCOPE (reported) |
</source_audit>

<output>
Write `/Users/kevinhsieh/Developer/Scheduling-post-class-run-parity/.planning/quick/260929-rcx-align-data-health-post-class-sync-run-wi/260929-rcx-SUMMARY.md` with the commits, the RED list and the notes below.

- **Known gaps (parity-only, not fixed):** a rejected pass shows up only as `{ failed: true }` (the audit outcome stays `success` and neither path logs it); `POST /api/post-class-feedback/sync` (collect) runs AI and retries but not hygiene (filed separately by the orchestrator).
- **Owner notes:** merge bdfd79f first; origin/main is now 19e6c26 (#95, autowriter-only, no overlap); no migrations or env changes; the Data Health toast now shows "Post-class feedback sync failed" instead of the driver text; a click can call OpenAI for up to 10 reviews when `OPENAI_API_KEY` is set.
</output>
